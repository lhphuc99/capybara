import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { diagnoseRequest, type DiagnoseInput } from '../src/diagnose.js';

const PAGE = 'http://localhost:6868';
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

/** A local API that records what Capybara sent it. */
async function api(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const seen: { method: string; path: string; headers: http.IncomingHttpHeaders }[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method!, path: req.url!, headers: req.headers });
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const diagnose = (input: Partial<DiagnoseInput> & { url: string }) =>
  diagnoseRequest({ method: 'GET', headers: {}, origin: PAGE, credentials: false, ...input });

const failures = (checks: { outcome: string; label: string }[]) => checks.filter((check) => check.outcome === 'fail').map((check) => check.label);

describe('diagnoseRequest: the response', () => {
  it('finds a missing Access-Control-Allow-Origin header, sending the request again without secrets', async () => {
    const server = await api((_req, res) => res.writeHead(401).end());
    const result = await diagnose({ url: `${server.origin}/me`, headers: { Accept: 'application/json' }, userAgent: 'Browser/1' });

    expect(result.verdict).toBe('cors');
    expect(result.summary).toBe(`The response (401 Unauthorized) has no Access-Control-Allow-Origin header, so the browser hid it from the app. The server has to allow ${PAGE}.`);
    expect(server.seen).toHaveLength(1);
    expect(server.seen[0]).toMatchObject({ method: 'GET', path: '/me', headers: { origin: PAGE, accept: 'application/json', 'user-agent': 'Browser/1' } });
  });

  it('names the wrong origin, duplicated headers, * with cookies and missing credentials', async () => {
    const server = await api((req, res) => {
      const allow = { slash: `${PAGE}/`, twice: [PAGE, PAGE], any: '*', cookies: PAGE }[req.url!.slice(1)]!;
      res.setHeader('Access-Control-Allow-Origin', allow);
      res.writeHead(200).end();
    });

    const slash = await diagnose({ url: `${server.origin}/slash` });
    expect(slash.summary).toBe(`The response allows ${PAGE}/, not ${PAGE}, so the browser hid it from the app. Remove the trailing slash.`);
    const twice = await diagnose({ url: `${server.origin}/twice` });
    expect(twice.summary).toContain(`several Access-Control-Allow-Origin values (${PAGE}, ${PAGE}), but browsers accept only one`);
    const any = await diagnose({ url: `${server.origin}/any`, credentials: true });
    expect(any.summary).toContain('browsers do not accept * when the app sends cookies');
    const cookies = await diagnose({ url: `${server.origin}/cookies`, credentials: true });
    expect(failures(cookies.checks)).toEqual(['Response: Access-Control-Allow-Credentials']);
    expect(cookies.summary).toContain('needs Access-Control-Allow-Credentials: true, but it has no such header');
    expect(cookies.sent).toEqual([`GET ${server.origin}/cookies (without cookies)`]);

    expect((await diagnose({ url: `${server.origin}/any` })).verdict).toBe('ok');
  });

  it('follows redirects and sends Origin: null after one between two other sites', async () => {
    const login = await api((_req, res) => res.writeHead(200, { 'Access-Control-Allow-Origin': PAGE }).end());
    const server = await api((_req, res) => res.writeHead(302, { Location: `${login.origin}/login`, 'Access-Control-Allow-Origin': PAGE }).end());

    const result = await diagnose({ url: `${server.origin}/me` });
    expect(login.seen[0]!.headers.origin).toBe('null');
    expect(result.verdict).toBe('cors');
    expect(result.summary).toBe(`The answer from ${login.origin}/login, where the request was redirected, allows ${PAGE}, not null, so the browser hid it from the app. Browsers send "Origin: null" once a cross-origin request is redirected to yet another origin.`);
    expect(result.checks.find((check) => check.label === 'Response')?.detail).toBe(`302 Found, redirects to ${login.origin}/login`);
  });

  it('only checks reachability for same-origin requests', async () => {
    const server = await api((_req, res) => res.writeHead(200).end());
    const result = await diagnose({ url: `${server.origin}/data`, origin: server.origin });
    expect(result.verdict).toBe('ok');
    expect(result.summary).toContain('same-origin requests are not subject to CORS');
    expect(server.seen[0]!.headers.origin).toBeUndefined();
  });
});

describe('diagnoseRequest: the preflight', () => {
  it('asks like the browser would, and never sends the credentials it withholds', async () => {
    const server = await api((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', PAGE);
      if (req.method === 'OPTIONS') res.setHeader('Access-Control-Allow-Headers', 'Authorization, X-Request-Id');
      res.writeHead(req.method === 'OPTIONS' ? 204 : 200).end();
    });
    const result = await diagnose({
      url: `${server.origin}/me`,
      headers: { Authorization: 'Bearer secret', 'X-Request-Id': '42', 'X-Api-Key': '[redacted]', 'Content-Type': 'text/plain' },
    });

    expect(server.seen.map((request) => request.method)).toEqual(['OPTIONS', 'GET']);
    expect(server.seen[0]!.headers).toMatchObject({ 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization,x-api-key,x-request-id' });
    expect(server.seen[1]!.headers).toMatchObject({ 'x-request-id': '42', 'content-type': 'text/plain' });
    expect(server.seen[1]!.headers.authorization).toBeUndefined();
    expect(server.seen[1]!.headers['x-api-key']).toBeUndefined();
    expect(result.sent[1]).toBe(`GET ${server.origin}/me (without authorization, x-api-key)`);
    expect(result.summary).toBe('The preflight answer does not allow the x-api-key header (Access-Control-Allow-Headers: Authorization, X-Request-Id), so the browser did not send the request.');
  });

  it('explains a failed status, a missing method and a * that does not cover Authorization', async () => {
    const server = await api((req, res) => {
      if (req.url === '/missing') return void res.writeHead(404).end();
      res.writeHead(204, {
        'Access-Control-Allow-Origin': PAGE,
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': '*',
      }).end();
    });

    const missing = await diagnose({ url: `${server.origin}/missing`, method: 'PUT', headers: { 'Content-Type': 'application/json' } });
    expect(missing.summary).toBe('The preflight (OPTIONS) got 404 Not Found, but browsers need a 2xx answer, so the browser did not send the request. The server has to answer OPTIONS /missing with the CORS headers.');
    const remove = await diagnose({ url: `${server.origin}/item`, method: 'DELETE' });
    expect(remove.summary).toBe('The preflight answer does not allow DELETE (Access-Control-Allow-Methods: GET, POST), so the browser did not send the request.');
    const bearer = await diagnose({ url: `${server.origin}/me`, headers: { Authorization: 'Bearer secret', 'X-Trace': '1' }, userAgent: 'Mozilla/5.0 Firefox/140.0' });
    expect(failures(bearer.checks)).toEqual(['Preflight: Access-Control-Allow-Headers']);
    expect(bearer.summary).toContain('does not allow the authorization header (Access-Control-Allow-Headers: *), so the browser did not send the request. A * does not cover Authorization');
    const chrome = await diagnose({ url: `${server.origin}/me`, headers: { Authorization: 'Bearer secret' }, userAgent: 'Mozilla/5.0 Chrome/155.0.0.0 Safari/537.36' });
    expect(chrome.verdict).toBe('ok');
    expect(chrome.checks.find((check) => check.label === 'Preflight: Authorization')?.outcome).toBe('info');

    // Methods other than GET and HEAD could change data, so only their preflight goes out.
    expect(server.seen.filter((request) => request.method !== 'OPTIONS').map((request) => request.method)).toEqual(['GET', 'GET']);
  });

  it('asks about a simple POST with OPTIONS instead of sending it again', async () => {
    const server = await api((_req, res) => res.writeHead(204).end());
    const result = await diagnose({ url: `${server.origin}/form`, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    expect(server.seen.map((request) => request.method)).toEqual(['OPTIONS']);
    expect(result.sent).toEqual([`OPTIONS ${server.origin}/form (the POST itself is not sent again)`]);
    expect(result.verdict).toBe('cors');
    expect(result.summary).toContain('so the browser most likely hid the answer to the POST');
  });
});

describe('diagnoseRequest: connection failures', () => {
  it('explains refused connections, unknown hosts and ports browsers block', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));

    const refused = await diagnose({ url: `http://127.0.0.1:${port}/api` });
    expect(refused).toMatchObject({ verdict: 'unreachable', summary: `Nothing is listening on 127.0.0.1:${port} (connection refused), so the request never got an answer.` });
    const dns = await diagnose({ url: 'http://capybara-check.invalid/api' });
    expect(dns).toMatchObject({ verdict: 'unreachable', summary: 'capybara-check.invalid could not be found (DNS), so the request never got an answer.' });
    const blocked = await diagnose({ url: 'http://127.0.0.1:6666/api' });
    expect(blocked).toMatchObject({ verdict: 'unreachable', sent: [] });
    expect(blocked.summary).toContain('Browsers refuse to connect to port 6666');
  }, 15_000);
});
