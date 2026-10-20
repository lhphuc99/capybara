import type { BodyPreview } from '@capybara-devtools/protocol';
import type { PluginContext } from '../../client.js';
import { now, randomId } from '../../utils.js';
import { absoluteUrl, findHeader, isTextual, parseRawHeaders, previewRequestBody, textPreview } from './body.js';
import type { FetchFunction } from './fetch.js';
import type { Settings } from './settings.js';

interface XhrInfo {
  method: string;
  url: string;
  headers: Record<string, string>;
}

const XHR_DONE = 4;

export function patchXhr(ctx: PluginContext, settings: Settings, fetchOverXhr: boolean): () => void {
  const XHR = (globalThis as { XMLHttpRequest?: { prototype: XMLHttpRequest } }).XMLHttpRequest;
  if (!XHR?.prototype) return () => {};
  const proto = XHR.prototype;
  const g = globalThis as { fetch?: FetchFunction };
  // whatwg-fetch opens and sends its XHR inside the fetch call, so XHRs sent meanwhile are the fetch.
  let fetching = 0;
  const originalFetch = fetchOverXhr ? g.fetch : undefined;
  const taggedFetch: FetchFunction | undefined = originalFetch
    ? Object.assign(
        function fetch(this: unknown) {
          fetching++;
          try {
            return originalFetch.apply(this, arguments as unknown as unknown[]);
          } finally {
            fetching--;
          }
        },
        { polyfill: originalFetch.polyfill },
      )
    : undefined;
  if (taggedFetch) g.fetch = taggedFetch;
  const originalOpen = proto.open;
  const originalSend = proto.send;
  const originalSetRequestHeader = proto.setRequestHeader;
  const requests = new WeakMap<XMLHttpRequest, XhrInfo>();
  // React Native hands the native reason for a failure (e.g. "Unable to resolve host …") to this
  // internal method. It reaches responseText only for text responses, and whatwg-fetch asks for blobs.
  const nativeErrors = new WeakMap<XMLHttpRequest, string>();
  // Ends the request an XHR is on; apps may open the same XHR again for the next one.
  const inFlight = new WeakMap<XMLHttpRequest, (cutOff?: boolean) => void>();
  let active = true;
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
      initiator: fetching > 0 ? 'fetch' : 'xhr',
      method: info.method,
      url: absoluteUrl(info.url),
      headers: settings.redact(info.headers),
      body: previewRequestBody(body, settings.maxBody, findHeader(info.headers, 'content-type')),
    });

    let failure: 'error' | 'timeout' | 'abort' | undefined;
    const listeners: Record<string, () => void> = {
      error: () => (failure = 'error'),
      timeout: () => (failure = 'timeout'),
      abort: () => (failure = 'abort'),
      loadend: () => {
        // Browsers still dispatch the last request's loadend after the app opened the XHR again from its onload.
        if (typeof xhr.readyState === 'number' && xhr.readyState !== XHR_DONE) return;
        end();
      },
    };
    for (const [type, listener] of Object.entries(listeners)) xhr.addEventListener(type, listener);
    const end = (cutOff = false) => {
      for (const [type, listener] of Object.entries(listeners)) xhr.removeEventListener(type, listener);
      if (inFlight.get(xhr) === end) inFlight.delete(xhr);
      if (cutOff) failure = 'abort';
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
    };
    inFlight.set(xhr, end);
  };

  proto.open = function open(this: XMLHttpRequest, method: string, url: string | URL) {
    // Opening resets the XHR: record a request that is done but whose loadend has not run (opened again from onload).
    if (this.readyState === XHR_DONE) inFlight.get(this)?.();
    requests.set(this, { method: String(method).toUpperCase(), url: String(url), headers: {} });
    nativeErrors.delete(this);
    // `arguments` keeps the caller's exact arity; some engines treat an explicit `undefined` async flag as false.
    const result = (originalOpen as (...args: unknown[]) => void).apply(this, arguments as unknown as unknown[]);
    // A request still on its way is cut off, and browsers fire no event for it.
    inFlight.get(this)?.(true);
    return result;
  } as XMLHttpRequest['open'];

  proto.setRequestHeader = function setRequestHeader(this: XMLHttpRequest, name: string, value: string) {
    const info = requests.get(this);
    if (info) info.headers[name] = name in info.headers ? `${info.headers[name]}, ${value}` : String(value);
    return originalSetRequestHeader.call(this, name, value);
  };

  proto.send = function send(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const info = requests.get(this);
    if (active && info && !settings.isIgnored(info.url)) {
      try {
        track(this, info, body);
      } catch {
        // never surface SDK failures to the app
      }
    }
    return originalSend.call(this, body);
  };

  const patched = {
    open: proto.open,
    send: proto.send,
    setRequestHeader: proto.setRequestHeader,
    complete: internals.__didCompleteResponse,
  };
  return () => {
    // Wrappers installed after ours (Sentry, Reactotron) stay; ours, still under them, then only pass calls on.
    active = false;
    if (proto.open === patched.open) proto.open = originalOpen;
    if (proto.send === patched.send) proto.send = originalSend;
    if (proto.setRequestHeader === patched.setRequestHeader) proto.setRequestHeader = originalSetRequestHeader;
    if (typeof originalComplete === 'function' && internals.__didCompleteResponse === patched.complete) {
      internals.__didCompleteResponse = originalComplete;
    }
    if (taggedFetch && g.fetch === taggedFetch) g.fetch = originalFetch;
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
