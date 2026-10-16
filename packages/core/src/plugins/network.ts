import type { BodyPreview, NetworkErrorPayload } from '@devsight/protocol';
import type { Plugin, PluginContext } from '../client.js';
import { errorMessage, now, randomId, utf8Length } from '../utils.js';
import { hookWebSockets } from './websocket.js';

/** Vite's dev server channel. */
const DEV_TOOL_PROTOCOLS = ['vite-hmr', 'vite-ping'];

export interface NetworkPluginOptions {
  /** Patch `fetch`. Turn off where fetch is built on XHR (whatwg-fetch), or each request is recorded twice. */
  fetch?: boolean;
  xhr?: boolean;
  /** Record WebSocket connections and their messages. Default true. */
  websocket?: boolean;
  /** Requests and WebSockets whose URL contains one of these strings or matches one of these patterns are not recorded. */
  ignoreUrls?: Array<string | RegExp>;
  /** Request and response bodies are cut after this many characters. Default 128 KiB. */
  maxBodySize?: number;
  /** WebSocket messages are cut after this many characters. Default 16 KiB. */
  maxMessageSize?: number;
  /** Header names (case-insensitive) whose values are replaced with "[redacted]". */
  redactHeaders?: string[];
}

interface Settings {
  maxBody: number;
  isIgnored(url: string): boolean;
  redact(headers: Record<string, string>): Record<string, string>;
  failures: FailureExplainer;
}

type Explanation = Pick<NetworkErrorPayload, 'cause' | 'credentials'> & { message?: string };

interface FailureExplainer {
  /** Runs `report` once the cause can be told, which in a browser may be a moment after the failure. */
  explain(url: string, credentials: boolean, report: (explanation: Explanation) => void): void;
  stop(): void;
}

export function networkPlugin(options: NetworkPluginOptions = {}): Plugin {
  return {
    name: 'network',
    setup(ctx) {
      const settings = resolveSettings(options);
      const teardowns: Array<() => void> = [() => settings.failures.stop()];
      if (options.fetch !== false) teardowns.push(patchFetch(ctx, settings));
      if (options.xhr !== false) teardowns.push(patchXhr(ctx, settings));
      if (options.websocket !== false) {
        teardowns.push(
          hookWebSockets(ctx.emit, {
            ignoreUrls: (options.ignoreUrls ?? []).map((pattern) =>
              typeof pattern === 'string' ? pattern : { source: pattern.source, flags: pattern.flags },
            ),
            ignoreProtocols: DEV_TOOL_PROTOCOLS,
            maxMessage: options.maxMessageSize ?? 16 * 1024,
          }),
        );
      }
      return () => {
        for (const teardown of teardowns) teardown();
      };
    },
  };
}

function resolveSettings(options: NetworkPluginOptions): Settings {
  const patterns = options.ignoreUrls ?? [];
  const redacted = new Set((options.redactHeaders ?? []).map((name) => name.toLowerCase()));
  return {
    maxBody: options.maxBodySize ?? 128 * 1024,
    isIgnored: (url) =>
      patterns.some((pattern) => {
        if (typeof pattern === 'string') return url.includes(pattern);
        pattern.lastIndex = 0;
        return pattern.test(url);
      }),
    redact: (headers) => {
      if (redacted.size === 0) return headers;
      const out: Record<string, string> = {};
      for (const [name, value] of Object.entries(headers)) {
        out[name] = redacted.has(name.toLowerCase()) ? '[redacted]' : value;
      }
      return out;
    },
    failures: failureExplainer(),
  };
}

/**
 * Browsers never tell a page why a request failed. What a page can know: whether it is offline,
 * whether the URL is mixed content, and CSP blocks, which arrive as `securitypolicyviolation`
 * events. Anything else cross-origin is reported as such for the Devsight server to diagnose.
 */
function failureExplainer(): FailureExplainer {
  const g = globalThis as {
    location?: { href?: string; origin?: string; protocol?: string };
    navigator?: { onLine?: boolean; product?: string; userAgent?: string };
    document?: Pick<Document, 'addEventListener' | 'removeEventListener'>;
  };
  const page = g.location;
  if (!page?.href || !page.origin || page.origin === 'null' || g.navigator?.product === 'ReactNative') {
    return { explain: (_url, _credentials, report) => report({}), stop() {} };
  }
  const blocked: Array<{ origin: string; directive: string; at: number }> = [];
  const onViolation = (event: Event) => {
    const violation = event as SecurityPolicyViolationEvent;
    const directive = violation.effectiveDirective || violation.violatedDirective || '';
    if (!/^(connect-src|default-src)/.test(directive)) return;
    try {
      blocked.push({ origin: new URL(violation.blockedURI, page.href).origin, directive, at: now() });
      if (blocked.length > 20) blocked.shift();
    } catch {
      // `inline` or `eval` violations carry no URL
    }
  };
  g.document?.addEventListener('securitypolicyviolation', onViolation);
  // Chromium lets https pages call local-network devices over http and gates them with its Local
  // Network Access permission instead; other browsers block them as mixed content.
  const chromium = /Chrom(e|ium)\//.test(g.navigator?.userAgent ?? '');
  const classify = (url: string, credentials: boolean): Explanation => {
    let target: URL;
    try {
      target = new URL(url, page.href);
    } catch {
      return {};
    }
    if (g.navigator?.onLine === false) return { cause: 'offline', message: 'The browser is offline' };
    const csp = blocked.find((entry) => entry.origin === target.origin && now() - entry.at < 10_000);
    if (csp) return { cause: 'csp', message: `Blocked by the page's Content-Security-Policy (${csp.directive})` };
    const exempt = isTrustworthyHost(target.hostname) || (chromium && isLocalNetworkHost(target.hostname));
    if (page.protocol === 'https:' && target.protocol === 'http:' && !exempt) {
      return { cause: 'mixed-content', message: `Blocked as mixed content: an https page cannot call ${target.origin}` };
    }
    if (target.origin !== page.origin) return { cause: 'cross-origin', credentials: credentials || undefined };
    return {};
  };
  return {
    // The violation event can arrive after the request has already failed.
    explain: (url, credentials, report) => void setTimeout(() => report(classify(url, credentials)), 30),
    stop: () => g.document?.removeEventListener('securitypolicyviolation', onViolation),
  };
}

/** Browsers let https pages call these over plain http. */
function isTrustworthyHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** Private IP literals and .local names; a hostname that resolves to a private IP does not count. */
function isLocalNetworkHost(hostname: string): boolean {
  if (hostname.endsWith('.local')) return true;
  const ipv4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(hostname);
  if (!ipv4) return /^\[(f[cd]|fe[89ab])/i.test(hostname);
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

function patchFetch(ctx: PluginContext, settings: Settings): () => void {
  const g = globalThis as { fetch?: typeof fetch };
  const original = g.fetch;
  if (typeof original !== 'function') return () => {};

  const patched = function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let request: ReturnType<typeof describeFetch>;
    try {
      request = describeFetch(input, init, settings.maxBody);
    } catch {
      return original.call(globalThis, input, init);
    }
    if (settings.isIgnored(request.url)) return original.call(globalThis, input, init);

    const id = randomId();
    const start = now();
    ctx.emit('network.request', {
      id,
      initiator: 'fetch',
      method: request.method,
      url: request.url,
      headers: settings.redact(request.headers),
      body: request.body,
    });

    let promise: Promise<Response>;
    try {
      promise = original.call(globalThis, input, init);
    } catch (error) {
      ctx.emit('network.error', { id, message: errorMessage(error), duration: now() - start });
      throw error;
    }

    // Registered before the caller gets the promise, so the response is cloned before app code can read it.
    promise.then(
      (response) => {
        try {
          const duration = now() - start;
          const headers = settings.redact(headersToRecord(response.headers));
          const done = (body?: BodyPreview) =>
            ctx.emit('network.response', {
              id,
              status: response.status,
              statusText: response.statusText || undefined,
              headers,
              body,
              duration,
            });
          readFetchBody(response, settings.maxBody).then(done, () => done());
        } catch {
          // never surface SDK failures to the app
        }
      },
      (error: unknown) => {
        const duration = now() - start;
        const aborted = (error as { name?: string } | null)?.name === 'AbortError';
        const fail = (explanation: Explanation) =>
          ctx.emit('network.error', { id, duration, aborted, ...explanation, message: explanation.message ?? errorMessage(error) });
        if (aborted) fail({});
        else settings.failures.explain(request.url, request.credentials, fail);
      },
    );
    return promise;
  };

  g.fetch = patched as typeof fetch;
  return () => {
    if (g.fetch === patched) g.fetch = original;
  };
}

function describeFetch(input: RequestInfo | URL, init: RequestInit | undefined, maxBody: number) {
  const RequestCtor = (globalThis as { Request?: typeof Request }).Request;
  const request = RequestCtor && input instanceof RequestCtor ? input : undefined;
  const url = request ? request.url : String((input as { href?: string }).href ?? input);
  const method = String(init?.method ?? request?.method ?? 'GET').toUpperCase();
  const headers = { ...(request ? headersToRecord(request.headers) : {}), ...headersToRecord(init?.headers) };
  let body: BodyPreview | undefined;
  if (init?.body !== undefined && init.body !== null) {
    body = previewRequestBody(init.body, maxBody, findHeader(headers, 'content-type'));
  } else if (request?.body) {
    body = { kind: 'stream', summary: 'Request body (not captured)' };
  }
  const credentials = (init?.credentials ?? request?.credentials) === 'include';
  return { url: absoluteUrl(url), method, headers, body, credentials };
}

async function readFetchBody(response: Response, maxBody: number): Promise<BodyPreview | undefined> {
  const contentType = response.headers.get('content-type') ?? undefined;
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  const size = Number.isFinite(declared) ? declared : undefined;
  if (!response.body) return undefined;
  if (contentType && /^text\/event-stream/i.test(contentType)) {
    return { kind: 'stream', contentType, summary: 'Event stream' };
  }
  if (!isTextual(contentType)) return { kind: 'binary', contentType, size, summary: contentType ?? 'Binary' };
  if (typeof TextDecoder === 'undefined') return textPreview(await response.clone().text(), maxBody, contentType);

  // Read only up to the limit, then cancel our branch; the app's branch of the tee is unaffected.
  const reader = response.clone().body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (text.length > maxBody) {
        truncated = true;
        break;
      }
    }
    if (!truncated) text += decoder.decode();
  } finally {
    if (truncated) reader.cancel().catch(() => {});
  }
  return {
    kind: 'text',
    text: truncated ? text.slice(0, maxBody) : text,
    size: truncated ? size : bytes,
    truncated,
    contentType,
  };
}

// ---------------------------------------------------------------------------
// XMLHttpRequest
// ---------------------------------------------------------------------------

interface XhrInfo {
  method: string;
  url: string;
  headers: Record<string, string>;
}

function patchXhr(ctx: PluginContext, settings: Settings): () => void {
  const XHR = (globalThis as { XMLHttpRequest?: { prototype: XMLHttpRequest } }).XMLHttpRequest;
  if (!XHR?.prototype) return () => {};
  const proto = XHR.prototype;
  const originalOpen = proto.open;
  const originalSend = proto.send;
  const originalSetRequestHeader = proto.setRequestHeader;
  const requests = new WeakMap<XMLHttpRequest, XhrInfo>();
  // React Native hands the native reason for a failure (e.g. "Unable to resolve host …") to this
  // internal method. It reaches responseText only for text responses, and whatwg-fetch asks for blobs.
  const nativeErrors = new WeakMap<XMLHttpRequest, string>();
  const internals = proto as unknown as Record<string, unknown>;
  const originalComplete = internals.__didCompleteResponse;
  if (typeof originalComplete === 'function') {
    internals.__didCompleteResponse = function (this: XMLHttpRequest, _requestId: unknown, error: unknown) {
      if (typeof error === 'string' && error) nativeErrors.set(this, error);
      return (originalComplete as (...args: unknown[]) => unknown).apply(this, arguments as unknown as unknown[]);
    };
  }

  const track = (xhr: XMLHttpRequest, info: XhrInfo, body: unknown) => {
    const id = randomId();
    const start = now();
    ctx.emit('network.request', {
      id,
      initiator: 'xhr',
      method: info.method,
      url: absoluteUrl(info.url),
      headers: settings.redact(info.headers),
      body: previewRequestBody(body, settings.maxBody, findHeader(info.headers, 'content-type')),
    });

    let failure: 'error' | 'timeout' | 'abort' | undefined;
    xhr.addEventListener('error', () => (failure = 'error'));
    xhr.addEventListener('timeout', () => (failure = 'timeout'));
    xhr.addEventListener('abort', () => (failure = 'abort'));
    xhr.addEventListener('loadend', () => {
      const duration = now() - start;
      try {
        if (failure || xhr.status === 0) {
          const base = { id, duration, aborted: failure === 'abort', timeout: failure === 'timeout' };
          if (failure === 'timeout' || failure === 'abort') {
            ctx.emit('network.error', { ...base, message: failure === 'timeout' ? 'Request timed out' : 'Request aborted' });
            return;
          }
          const native = nativeErrors.get(xhr);
          if (native) {
            ctx.emit('network.error', { ...base, message: native });
            return;
          }
          settings.failures.explain(absoluteUrl(info.url), xhr.withCredentials === true, (explanation) =>
            ctx.emit('network.error', { ...base, ...explanation, message: explanation.message ?? 'Network request failed' }),
          );
          return;
        }
        const headers = parseRawHeaders(xhr.getAllResponseHeaders());
        const done = (responseBody?: BodyPreview) =>
          ctx.emit('network.response', {
            id,
            status: xhr.status,
            statusText: xhr.statusText || undefined,
            headers: settings.redact(headers),
            body: responseBody,
            duration,
          });
        const result = readXhrBody(xhr, findHeader(headers, 'content-type'), settings.maxBody);
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          (result as Promise<BodyPreview | undefined>).then(done, () => done());
        } else {
          done(result as BodyPreview | undefined);
        }
      } catch {
        // never surface SDK failures to the app
      }
    });
  };

  proto.open = function open(this: XMLHttpRequest, method: string, url: string | URL) {
    requests.set(this, { method: String(method).toUpperCase(), url: String(url), headers: {} });
    nativeErrors.delete(this);
    // `arguments` keeps the caller's exact arity; some engines treat an explicit `undefined` async flag as false.
    return (originalOpen as (...args: unknown[]) => void).apply(this, arguments as unknown as unknown[]);
  } as XMLHttpRequest['open'];

  proto.setRequestHeader = function setRequestHeader(this: XMLHttpRequest, name: string, value: string) {
    const info = requests.get(this);
    if (info) info.headers[name] = name in info.headers ? `${info.headers[name]}, ${value}` : String(value);
    return originalSetRequestHeader.call(this, name, value);
  };

  proto.send = function send(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const info = requests.get(this);
    if (info && !settings.isIgnored(info.url)) {
      try {
        track(this, info, body);
      } catch {
        // never surface SDK failures to the app
      }
    }
    return originalSend.call(this, body);
  };

  return () => {
    proto.open = originalOpen;
    proto.send = originalSend;
    proto.setRequestHeader = originalSetRequestHeader;
    if (typeof originalComplete === 'function') internals.__didCompleteResponse = originalComplete;
  };
}

function readXhrBody(
  xhr: XMLHttpRequest,
  contentType: string | undefined,
  maxBody: number,
): BodyPreview | undefined | Promise<BodyPreview | undefined> {
  const type = xhr.responseType;
  if (type === '' || type === 'text') {
    const text = xhr.responseText;
    return text ? textPreview(text, maxBody, contentType) : undefined;
  }
  const response: unknown = xhr.response;
  if (response === null || response === undefined) return undefined;
  if (type === 'json') {
    try {
      return textPreview(JSON.stringify(response), maxBody, contentType);
    } catch {
      return { kind: 'unknown', contentType, summary: 'JSON' };
    }
  }
  if (type === 'blob') {
    // React Native's fetch polyfill always asks XHR for a blob.
    const blob = response as Blob;
    if (!isTextual(contentType)) return { kind: 'binary', size: blob.size, contentType, summary: contentType ?? 'Blob' };
    const truncated = blob.size > maxBody;
    return readBlobText(truncated ? blob.slice(0, maxBody) : blob).then(
      (text): BodyPreview => ({ kind: 'text', text, size: blob.size, truncated, contentType }),
    );
  }
  if (type === 'arraybuffer') {
    const buffer = response as ArrayBuffer;
    if (isTextual(contentType) && typeof TextDecoder !== 'undefined') {
      const truncated = buffer.byteLength > maxBody;
      const text = new TextDecoder().decode(truncated ? buffer.slice(0, maxBody) : buffer);
      return { kind: 'text', text, size: buffer.byteLength, truncated, contentType };
    }
    return { kind: 'binary', size: buffer.byteLength, contentType, summary: contentType ?? 'ArrayBuffer' };
  }
  return { kind: 'unknown', contentType, summary: `responseType "${type}"` };
}

function readBlobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob'));
    reader.readAsText(blob);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEXTUAL =
  /^(text\/|application\/([\w.+-]*\+)?(json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|x-ndjson)\b)/i;

function isTextual(contentType: string | undefined): boolean {
  return !contentType || TEXTUAL.test(contentType.trim());
}

function textPreview(text: string, maxBody: number, contentType?: string, kind: 'text' | 'form' = 'text'): BodyPreview {
  const truncated = text.length > maxBody;
  return { kind, text: truncated ? text.slice(0, maxBody) : text, size: utf8Length(text), truncated, contentType };
}

function previewRequestBody(body: unknown, maxBody: number, contentType?: string): BodyPreview | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return textPreview(body, maxBody, contentType);
  const g = globalThis as Record<string, any>;
  if (g.URLSearchParams && body instanceof g.URLSearchParams) {
    return textPreview(String(body), maxBody, contentType ?? 'application/x-www-form-urlencoded');
  }
  if (g.FormData && body instanceof g.FormData) return formPreview(body, maxBody);
  if (g.Blob && body instanceof g.Blob) {
    const blob = body as Blob;
    return { kind: 'binary', size: blob.size, contentType: blob.type || contentType, summary: blob.type ? `Blob (${blob.type})` : 'Blob' };
  }
  if (body instanceof ArrayBuffer) return { kind: 'binary', size: body.byteLength, contentType, summary: 'ArrayBuffer' };
  if (ArrayBuffer.isView(body)) {
    return { kind: 'binary', size: body.byteLength, contentType, summary: body.constructor?.name ?? 'TypedArray' };
  }
  if (g.ReadableStream && body instanceof g.ReadableStream) return { kind: 'stream', contentType, summary: 'ReadableStream' };
  return { kind: 'unknown', contentType, summary: Object.prototype.toString.call(body) };
}

interface ReactNativeFormPart {
  fieldName: string;
  string?: string;
  uri?: string;
  name?: string;
  type?: string;
}

function formPreview(form: unknown, maxBody: number): BodyPreview {
  const lines: string[] = [];
  const browserForm = form as { entries?: () => Iterable<[string, unknown]> };
  const nativeForm = form as { getParts?: () => ReactNativeFormPart[] };
  if (typeof browserForm.entries === 'function') {
    for (const [name, value] of browserForm.entries()) lines.push(`${name}=${describeFormValue(value)}`);
  } else if (typeof nativeForm.getParts === 'function') {
    // React Native's FormData has no entries().
    for (const part of nativeForm.getParts()) {
      const value =
        part.string !== undefined ? part.string : `[file ${part.name ?? part.uri ?? ''}${part.type ? `, ${part.type}` : ''}]`;
      lines.push(`${part.fieldName}=${value}`);
    }
  }
  return textPreview(lines.join('\n'), maxBody, 'multipart/form-data', 'form');
}

function describeFormValue(value: unknown): string {
  if (typeof value === 'string') return value;
  const file = value as { name?: string; size?: number; type?: string };
  return `[file ${file.name ?? 'blob'}${file.type ? `, ${file.type}` : ''}${file.size !== undefined ? `, ${file.size} B` : ''}]`;
}

function headersToRecord(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const add = (name: string, value: string) => {
    out[name] = name in out ? `${out[name]}, ${value}` : value;
  };
  if (Array.isArray(headers)) {
    for (const pair of headers) if (Array.isArray(pair) && pair.length >= 2) add(String(pair[0]), String(pair[1]));
  } else if (typeof (headers as Headers).forEach === 'function') {
    (headers as Headers).forEach((value, name) => add(name, value));
  } else if (typeof headers === 'object') {
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
      if (value !== undefined) add(name, String(value));
    }
  }
  return out;
}

function parseRawHeaders(raw: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const line of raw.split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    const name = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    out[name] = name in out ? `${out[name]}, ${value}` : value;
  }
  return out;
}

function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) if (key.toLowerCase() === target) return headers[key];
  return undefined;
}

function absoluteUrl(url: string): string {
  const base = (globalThis as { location?: { href?: string } }).location?.href;
  if (!base || /^[a-z][a-z\d+.-]*:/i.test(url)) return url;
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}
