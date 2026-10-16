import http from 'node:http';
import https from 'node:https';
import type { DiagnosisCheck, NetworkDiagnosis } from '@devsight/protocol';

export interface DiagnoseInput {
  url: string;
  method: string;
  /** Headers the app set on the request. */
  headers: Record<string, string>;
  /** Origin of the page that made the request; "null" for file:// pages. */
  origin: string;
  /** The request sent cookies (fetch `credentials: 'include'`, XHR `withCredentials`). */
  credentials: boolean;
  /** The browser's, so servers that filter bots answer as they did to the app. */
  userAgent?: string;
}

const TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 5;
const SIMPLE_METHODS = new Set(['GET', 'HEAD', 'POST']);
const SIMPLE_CONTENT_TYPES = new Set(['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain']);
/** Set by the browser itself, so they never need CORS permission. */
const BROWSER_HEADERS = new Set([
  'accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method', 'connection',
  'content-length', 'cookie', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin', 'referer', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'user-agent', 'via',
]);
/** Never sent again from Devsight: they carry the user's credentials. */
const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization']);
/** What the SDK's `redactHeaders` option leaves behind. */
const REDACTED = '[redacted]';
/** Ports browsers refuse to connect to (the Fetch standard's "bad port" list). */
const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111,
  113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548,
  554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);
const UNTRUSTED_CERT = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);
const ELSEWHERE = 'an ad blocker or another extension, a proxy or VPN, or a certificate the browser does not trust';

interface Answer {
  status: number;
  /** Every value of a header, so duplicates (a proxy and the app both adding one) stay visible. */
  header(name: string): string[];
}

/**
 * Repeats a failed request's CORS steps from the dev machine, where nothing hides the answers,
 * and applies the browser's rules to them. Only GET and HEAD are sent again, without the app's
 * credentials; other methods could change data, so the server is asked through OPTIONS instead.
 */
export async function diagnoseRequest(input: DiagnoseInput): Promise<NetworkDiagnosis> {
  const checks: DiagnosisCheck[] = [];
  const sent: string[] = [];
  const check = (outcome: DiagnosisCheck['outcome'], label: string, detail: string) => checks.push({ label, outcome, detail });
  const result = (verdict: NetworkDiagnosis['verdict'], summary: string): NetworkDiagnosis => ({ verdict, summary, checks, sent });
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return result('unknown', 'The request URL could not be parsed.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return result('unknown', `Only http and https requests can be checked, not ${url.protocol}`);
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (BAD_PORTS.has(port)) {
    check('fail', 'Port', `Browsers refuse to connect to port ${port}.`);
    return result('unreachable', `Browsers refuse to connect to port ${port}, which is reserved for other protocols. Serve the API on another port.`);
  }

  const method = input.method.toUpperCase();
  const { origin } = input;
  const crossOrigin = url.origin !== origin;
  const appHeaders = Object.entries(input.headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .filter(([name]) => !BROWSER_HEADERS.has(name));
  const unsafeHeaders = [...new Set(appHeaders.filter(([name, value]) => !isSafelisted(name, value)).map(([name]) => name))].sort();
  const needsPreflight = crossOrigin && (!SIMPLE_METHODS.has(method) || unsafeHeaders.length > 0);
  const userAgent: Record<string, string> = input.userAgent ? { 'User-Agent': input.userAgent } : {};
  // Chromium still lets a * cover Authorization, with a deprecation warning; other browsers follow the standard.
  const chromium = /Chrom(e|ium)\//.test(input.userAgent ?? '');
  let certificate: string | undefined;

  const ask = async (method: string, target: URL, headers: Record<string, string>, note = ''): Promise<Answer | string> => {
    sent.push(`${method} ${target.href}${note}${certificate ? ' (certificate not verified)' : ''}`);
    try {
      return await exchange(method, target, { ...userAgent, ...headers }, certificate !== undefined);
    } catch (error) {
      if (certificate !== undefined || !UNTRUSTED_CERT.has(errorCode(error))) return describeNetworkError(error, target);
      // Browsers also trust local CAs (mkcert, a company proxy) from the system store, which Node
      // does not read. Keep checking CORS without verification and leave the verdict open.
      certificate = describeNetworkError(error, target);
      check('info', 'Certificate', `${certificate}. That is fine if the browser trusts it, for example a mkcert or company CA. Devsight checked the rest without verifying it.`);
      return ask(method, target, headers, note);
    }
  };
  const unreachable = (error: string) => {
    check('fail', 'Connection', `${error}.`);
    return result('unreachable', `${error}, so the request never got an answer.`);
  };

  /** The browser's CORS check on one answer. `blocked` says what the browser did when it fails. */
  const cors = (label: string, subject: string, blocked: string, answer: Answer, requestOrigin = origin) => {
    const name = `${label}: Access-Control-Allow-Origin`;
    const allowed = answer.header('access-control-allow-origin');
    const status = describeStatus(answer);
    if (allowed.length === 0) {
      check('fail', name, `${subject} (${status}) has no Access-Control-Allow-Origin header, so ${blocked}. The server has to allow ${requestOrigin}.`);
    } else if (allowed.length > 1 || allowed[0]!.includes(',')) {
      check('fail', name, `${subject} (${status}) has several Access-Control-Allow-Origin values (${allowed.join(', ')}), but browsers accept only one, so ${blocked}. Often both a proxy and the app add the header.`);
    } else if (allowed[0] === '*' && input.credentials) {
      check('fail', name, `${subject} allows any origin (*), but browsers do not accept * when the app sends cookies, so ${blocked}. The server has to answer with ${requestOrigin} instead.`);
    } else if (allowed[0] !== '*' && allowed[0] !== requestOrigin) {
      const hint = allowed[0]!.replace(/\/+$/, '') === requestOrigin ? ' Remove the trailing slash.'
        : requestOrigin !== origin ? ' Browsers send "Origin: null" once a cross-origin request is redirected to yet another origin.'
        : '';
      check('fail', name, `${subject} allows ${allowed[0]}, not ${requestOrigin}, so ${blocked}.${hint}`);
    } else {
      check('pass', name, allowed[0] === '*' ? 'Allows any origin.' : `Allows ${requestOrigin}.`);
    }
    if (!input.credentials) return;
    const credentials = answer.header('access-control-allow-credentials');
    if (credentials.length === 1 && credentials[0] === 'true') check('pass', `${label}: Access-Control-Allow-Credentials`, 'Allows cookies.');
    else check('fail', `${label}: Access-Control-Allow-Credentials`, `The app sends cookies, so ${lowerFirst(subject)} needs Access-Control-Allow-Credentials: true, but it has ${credentials.length === 0 ? 'no such header' : `"${credentials.join(', ')}"`}, so ${blocked}.`);
  };

  if (needsPreflight) {
    const headers: Record<string, string> = { Origin: origin, 'Access-Control-Request-Method': method };
    if (unsafeHeaders.length > 0) headers['Access-Control-Request-Headers'] = unsafeHeaders.join(',');
    const preflight = await ask('OPTIONS', url, headers, ' (preflight)');
    if (typeof preflight === 'string') return unreachable(preflight);
    const blocked = 'the browser did not send the request';
    const location = preflight.header('location')[0];
    if (preflight.status >= 200 && preflight.status < 300) check('pass', 'Preflight status', describeStatus(preflight));
    else if (location) check('fail', 'Preflight status', `The preflight (OPTIONS) was redirected to ${location}, but browsers do not follow redirects for preflights, so ${blocked}.`);
    else check('fail', 'Preflight status', `The preflight (OPTIONS) got ${describeStatus(preflight)}, but browsers need a 2xx answer, so ${blocked}. The server has to answer OPTIONS ${url.pathname} with the CORS headers.`);
    cors('Preflight', 'The preflight answer', blocked, preflight);
    if (!SIMPLE_METHODS.has(method)) {
      const raw = preflight.header('access-control-allow-methods').join(', ');
      const allowed = list(raw).map((name) => name.toUpperCase());
      if (allowed.includes(method) || (allowed.includes('*') && !input.credentials)) {
        check('pass', 'Preflight: Access-Control-Allow-Methods', `Allows ${method}.`);
      } else {
        const wildcard = allowed.includes('*') ? ' A * does not count when the app sends cookies.' : '';
        check('fail', 'Preflight: Access-Control-Allow-Methods', `The preflight answer does not allow ${method} (Access-Control-Allow-Methods: ${raw || 'missing'}), so ${blocked}.${wildcard}`);
      }
    }
    if (unsafeHeaders.length > 0) {
      const raw = preflight.header('access-control-allow-headers').join(', ');
      const allowed = list(raw).map((name) => name.toLowerCase());
      const wildcard = allowed.includes('*') && !input.credentials;
      const missing = unsafeHeaders.filter((name) => !allowed.includes(name) && !(wildcard && (name !== 'authorization' || chromium)));
      if (missing.length === 0) {
        check('pass', 'Preflight: Access-Control-Allow-Headers', `Allows ${unsafeHeaders.join(', ')}.`);
        if (wildcard && unsafeHeaders.includes('authorization') && !allowed.includes('authorization')) {
          check('info', 'Preflight: Authorization', 'Chrome still lets * cover Authorization, but Firefox and Safari do not. List Authorization by name.');
        }
      } else {
        const note = !allowed.includes('*') ? '' : wildcard ? ' A * does not cover Authorization, which has to be listed by name.' : ' A * does not count when the app sends cookies.';
        check('fail', 'Preflight: Access-Control-Allow-Headers', `The preflight answer does not allow the ${missing.join(', ')} header${missing.length > 1 ? 's' : ''} (Access-Control-Allow-Headers: ${raw || 'missing'}), so ${blocked}.${note}`);
      }
    }
  }

  if (method === 'GET' || method === 'HEAD') {
    const withheld = appHeaders.filter(([name, value]) => SECRET_HEADERS.has(name) || value === REDACTED);
    const headers = Object.fromEntries(appHeaders.filter((header) => !withheld.includes(header)));
    const without = [...new Set(withheld.map(([name]) => name)), ...(input.credentials ? ['cookies'] : [])];
    const note = without.length > 0 ? ` (without ${without.join(', ')})` : '';
    let target = url;
    let corsMode = crossOrigin;
    // After a redirect from one other site to another, browsers send "Origin: null".
    let tainted = false;
    for (let hop = 0; ; hop++) {
      corsMode ||= target.origin !== origin;
      const requestOrigin = tainted ? 'null' : origin;
      const answer = await ask(method, target, corsMode ? { ...headers, Origin: requestOrigin } : headers, note);
      if (typeof answer === 'string') return unreachable(answer);
      const location = answer.status >= 300 && answer.status < 400 ? answer.header('location')[0] : undefined;
      const next = location === undefined ? undefined : parseUrl(location, target);
      const label = hop === 0 ? 'Response' : `Redirect ${hop}`;
      check('info', label, `${hop === 0 ? '' : `${target.href}: `}${describeStatus(answer)}${location ? `, redirects to ${next?.href ?? location}` : ''}`);
      if (corsMode) {
        const subject = hop === 0 ? 'The response' : `The answer from ${target.href}, where the request was redirected,`;
        cors(label, subject, 'the browser hid it from the app', answer, requestOrigin);
      }
      if (location === undefined || checks.some((item) => item.outcome === 'fail')) break;
      if (next?.protocol !== 'http:' && next?.protocol !== 'https:') {
        check('fail', `Redirect ${hop + 1}`, `The server redirects to ${location}, which fetch cannot follow.`);
        break;
      }
      if (hop === MAX_REDIRECTS) {
        check('info', 'Redirects', `Devsight stopped after ${MAX_REDIRECTS} redirects.`);
        break;
      }
      if (next.origin !== target.origin && target.origin !== origin) tainted = true;
      target = next;
    }
  } else if (crossOrigin && !needsPreflight) {
    // A simple POST goes out without a preflight, and sending it again could change data.
    const answer = await ask('OPTIONS', url, { Origin: origin, 'Access-Control-Request-Method': method }, ` (the ${method} itself is not sent again)`);
    if (typeof answer === 'string') return unreachable(answer);
    cors('OPTIONS', `The server's answer to OPTIONS`, `the browser most likely hid the answer to the ${method} (Devsight did not send the ${method} again, since that could change data)`, answer);
  } else if (!crossOrigin) {
    const answer = await ask('HEAD', url, {}, ` (the ${method} itself is not sent again)`);
    if (typeof answer === 'string') return unreachable(answer);
    check('info', 'Response', describeStatus(answer));
  }

  const failed = checks.find((item) => item.outcome === 'fail');
  if (failed) return result('cors', failed.detail);
  if (certificate) {
    return result('ok', `CORS allows the request, but ${lowerFirst(certificate)}. If the browser does not trust it either, that is why the request failed: open ${url.origin} in the browser to see its warning.`);
  }
  if (!crossOrigin) {
    return result('ok', `The server answers, and same-origin requests are not subject to CORS. Something in the browser blocked the request: ${ELSEWHERE}.`);
  }
  if (method === 'GET' || method === 'HEAD') {
    return result('ok', `The server allows ${origin}, so CORS is not the problem, at least without the app's credentials. Other causes: a different answer when the app sends its Authorization header or cookies, ${ELSEWHERE}.`);
  }
  return result('ok', `The server allows ${origin} when asked with OPTIONS. Devsight did not send the ${method} again, since that could change data, so it cannot see that answer: if it lacks Access-Control-Allow-Origin (common for error responses), the browser hides it. Other causes: ${ELSEWHERE}.`);
}

function exchange(method: string, url: URL, headers: Record<string, string>, insecure: boolean): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(url, { method, headers, agent: false, rejectUnauthorized: !insecure }, (response) => {
      clearTimeout(timer);
      const values = new Map<string, string[]>();
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        const name = response.rawHeaders[i]!.toLowerCase();
        values.set(name, [...(values.get(name) ?? []), response.rawHeaders[i + 1]!.trim()]);
      }
      // Only the headers matter; a large body is not worth downloading.
      response.destroy();
      resolve({ status: response.statusCode ?? 0, header: (name) => values.get(name) ?? [] });
    });
    const timer = setTimeout(() => request.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), TIMEOUT_MS);
    request.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });
}

function errorCode(error: unknown): string {
  return String((error as { code?: unknown } | null)?.code ?? '');
}

function describeNetworkError(error: unknown, url: URL): string {
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  switch (errorCode(error)) {
    case 'TIMEOUT':
      return `${url.host} did not answer within ${TIMEOUT_MS / 1000} seconds`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `${url.hostname} could not be found (DNS)`;
    case 'ECONNREFUSED':
      return `Nothing is listening on ${url.hostname}:${port} (connection refused)`;
    case 'ECONNRESET':
      return `${url.host} closed the connection`;
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `${url.host} cannot be reached from this computer`;
    case 'CERT_HAS_EXPIRED':
      return `The certificate of ${url.hostname} has expired`;
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `The certificate of ${url.hostname} is for another host name`;
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return `The certificate of ${url.hostname} is self-signed`;
    case 'UNABLE_TO_GET_ISSUER_CERT':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return `The certificate of ${url.hostname} is signed by an authority Node does not know`;
    case 'EPROTO':
    case 'ERR_SSL_WRONG_VERSION_NUMBER':
      return `${url.host} does not speak ${url.protocol === 'https:' ? 'HTTPS' : 'HTTP'}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function describeStatus(answer: Answer): string {
  const text = http.STATUS_CODES[answer.status];
  return text ? `${answer.status} ${text}` : String(answer.status);
}

/** CORS-safelisted request headers, which never trigger a preflight. */
function isSafelisted(name: string, value: string): boolean {
  if (value.length > 128) return false;
  switch (name) {
    case 'accept':
    case 'accept-language':
    case 'content-language':
      return true;
    case 'content-type':
      return SIMPLE_CONTENT_TYPES.has(value.split(';')[0]!.trim().toLowerCase());
    case 'range':
      return /^bytes=\d+-\d*$/.test(value);
  }
  return false;
}

function parseUrl(value: string, base: URL): URL | undefined {
  try {
    return new URL(value, base);
  } catch {
    return undefined;
  }
}

function list(header: string): string[] {
  return header.split(',').map((item) => item.trim()).filter(Boolean);
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
