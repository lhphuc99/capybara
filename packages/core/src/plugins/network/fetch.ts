import type { BodyPreview } from '@capybara-devtools/protocol';
import type { PluginContext } from '../../client.js';
import { errorMessage, now, randomId } from '../../utils.js';
import { absoluteUrl, findHeader, headersToRecord, isTextual, previewRequestBody, textPreview } from './body.js';
import type { Explanation } from './failure.js';
import type { Settings } from './settings.js';

export type FetchFunction = ((...args: unknown[]) => unknown) & { polyfill?: unknown };

/** A body still arriving after this long, e.g. a streamed AI answer or a long poll, is reported as it comes. */
const STREAM_AFTER_MS = 500;
const STREAM_EVERY_MS = 1_000;

/**
 * whatwg-fetch marks itself `polyfill`. Bare React Native ships it as fetch, so every fetch is also an
 * XHR there, and patching both would record each request twice. Expo swaps in a native fetch.
 */
export function isXhrFetch(): boolean {
  return (globalThis as { fetch?: FetchFunction }).fetch?.polyfill === true;
}

export function patchFetch(ctx: PluginContext, settings: Settings): () => void {
  const g = globalThis as { fetch?: typeof fetch };
  const original = g.fetch;
  if (typeof original !== 'function') return () => {};
  let active = true;

  const patched = function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (!active) return original.call(globalThis, input, init);
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
          const respond = (body: BodyPreview | undefined, streaming = false) =>
            ctx.emit('network.response', {
              id,
              status: response.status,
              statusText: response.statusText || undefined,
              headers,
              body,
              duration,
              ...(streaming && { streaming: true as const }),
            });
          readFetchBody(response, settings.maxBody, (partial) => respond(partial, true)).then(
            (body) => respond(body),
            () => respond(undefined),
          );
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
    // A wrapper installed after ours stays; ours, still under it, then only passes calls on.
    active = false;
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

/** `onProgress` gets what came so far of a body that takes a while, then again every second while more comes. */
async function readFetchBody(
  response: Response,
  maxBody: number,
  onProgress: (partial: BodyPreview | undefined) => void,
): Promise<BodyPreview | undefined> {
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
  let reported = 0;
  const report = () => {
    reported = now();
    onProgress(text === '' ? undefined : { kind: 'text', text, size: bytes, contentType });
  };
  const timer = setTimeout(report, STREAM_AFTER_MS);
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
      if (reported > 0 && now() - reported >= STREAM_EVERY_MS) report();
    }
    if (!truncated) text += decoder.decode();
  } finally {
    clearTimeout(timer);
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
