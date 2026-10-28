import type { BodyPreview, EventKind, EventPayloads } from '@capybara-devtools/protocol';
import { isTextual, textBody } from './cdp.js';

// Requests of a Flutter app, read from dart:io's HTTP profile: the data Flutter DevTools' Network view shows.
// It covers HttpClient, so package:http, dio and Image.network, and the native clients that report to
// package:http_profile (cupertino_http, cronet_http).

interface ProfileHeaders {
  [name: string]: string[] | string | undefined;
}

/** One request of `ext.dart.io.getHttpProfile`. Times are in microseconds since the epoch. */
export interface HttpProfileRequestRef {
  id: string;
  method: string;
  uri: string;
  startTime: number;
  /** The request has been sent. */
  endTime?: number;
  request?: { headers?: ProfileHeaders; contentLength?: number; error?: string };
  response?: {
    startTime?: number;
    endTime?: number;
    statusCode?: number;
    reasonPhrase?: string;
    headers?: ProfileHeaders;
    contentLength?: number;
    error?: string;
  };
}

/** `ext.dart.io.getHttpProfileRequest`: the same with the bodies, as bytes. */
export interface HttpProfileRequest extends HttpProfileRequestRef {
  requestBody?: number[];
  responseBody?: number[];
}

export interface HttpProfile {
  timestamp: number;
  requests: HttpProfileRequestRef[];
}

type Call = <T>(method: string, params?: object) => Promise<T>;
type Emit = <K extends EventKind>(kind: K, payload: EventPayloads[K], ts?: number) => void;

/** Bodies larger than this, or not text, are described by their size only: the profile keeps them as JSON arrays. */
const MAX_BODY_FETCH = 4 * 1024 * 1024;
const MAX_TRACKED = 2_000;

interface Tracked {
  request: boolean;
  headers: boolean;
  done: boolean;
}

export function joinHeaders(headers: ProfileHeaders | undefined): Record<string, string> {
  const joined: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value !== undefined) joined[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return joined;
}

function contentType(headers: Record<string, string>): string | undefined {
  return headers['content-type'] ?? Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
}

export function profileBody(bytes: number[] | undefined, type: string | undefined): BodyPreview | undefined {
  if (!bytes || bytes.length === 0) return undefined;
  const buffer = Buffer.from(bytes);
  if (isTextual(type)) {
    try {
      return { ...textBody(new TextDecoder('utf-8', { fatal: true }).decode(buffer), type), size: buffer.length };
    } catch {
      // Not UTF-8 after all.
    }
  }
  return { kind: 'binary', size: buffer.length, contentType: type, summary: type ?? 'Binary' };
}

function sizeOnly(size: number | undefined, type: string | undefined): BodyPreview | undefined {
  return size && size > 0 ? { kind: 'binary', size, contentType: type, summary: type ?? 'Binary' } : undefined;
}

/**
 * Turns successive reads of an isolate's HTTP profile into network events: the request once it is sent, the
 * response once its headers are in (`streaming` until its body is), and the error if it failed.
 */
export function createHttpProfileReader(
  call: Call,
  isolateId: string,
  emit: Emit,
  options: { ignore?: (url: string) => boolean } = {},
): { poll(): Promise<void> } {
  const tracked = new Map<string, Tracked>();
  let since: number | undefined;

  const full = (ref: HttpProfileRequestRef) =>
    call<HttpProfileRequest>('ext.dart.io.getHttpProfileRequest', { isolateId, id: ref.id }).catch(() => undefined);

  const update = async (ref: HttpProfileRequestRef) => {
    if (options.ignore?.(ref.uri)) return;
    const id = `dart-${ref.id}`;
    let state = tracked.get(id);
    if (!state) {
      state = { request: false, headers: false, done: false };
      tracked.set(id, state);
      if (tracked.size > MAX_TRACKED) tracked.delete(tracked.keys().next().value!);
    }
    if (state.done) return;
    const response = ref.response;
    const sent = ref.endTime !== undefined || ref.request?.error !== undefined || response !== undefined;
    const finished = response?.endTime !== undefined || response?.error !== undefined;
    const requestHeaders = joinHeaders(ref.request?.headers);
    const responseHeaders = joinHeaders(response?.headers);
    const responseType = contentType(responseHeaders);
    // One read of the bodies serves both when the request has finished by the time it is first seen.
    const needsRequestBody = !state.request && sent && (ref.request?.contentLength ?? 0) > 0;
    const needsResponseBody =
      finished &&
      !response?.error &&
      isTextual(responseType) &&
      (response?.contentLength === undefined || response.contentLength <= MAX_BODY_FETCH);
    const bodies = needsRequestBody || needsResponseBody ? await full(ref) : undefined;

    if (!state.request && sent) {
      state.request = true;
      emit(
        'network.request',
        {
          id,
          initiator: 'other',
          method: ref.method.toUpperCase(),
          url: ref.uri,
          headers: requestHeaders,
          ...(bodies?.requestBody?.length && { body: profileBody(bodies.requestBody, contentType(requestHeaders)) }),
        },
        ref.startTime / 1_000,
      );
    }
    const error = ref.request?.error ?? response?.error;
    if (error !== undefined) {
      state.done = true;
      emit(
        'network.error',
        { id, message: error, duration: Math.max(0, ((response?.endTime ?? ref.endTime ?? ref.startTime) - ref.startTime) / 1_000) },
        (response?.endTime ?? ref.endTime ?? ref.startTime) / 1_000,
      );
      return;
    }
    if (!response?.statusCode || (state.headers && !finished)) return;
    const body = finished
      ? needsResponseBody
        ? profileBody(bodies?.responseBody, responseType)
        : sizeOnly(response.contentLength, responseType)
      : undefined;
    emit(
      'network.response',
      {
        id,
        status: response.statusCode,
        ...(response.reasonPhrase && { statusText: response.reasonPhrase }),
        headers: responseHeaders,
        ...(body && { body }),
        duration: Math.max(0, ((response.startTime ?? ref.startTime) - ref.startTime) / 1_000),
        ...(!finished && { streaming: true as const }),
      },
      (response.startTime ?? ref.startTime) / 1_000,
    );
    state.headers = true;
    state.done = finished;
  };

  return {
    async poll() {
      const profile = await call<HttpProfile>('ext.dart.io.getHttpProfile', {
        isolateId,
        ...(since !== undefined && { updatedSince: String(since) }),
      });
      since = profile.timestamp;
      const requests = [...profile.requests].sort((a, b) => a.startTime - b.startTime);
      for (const ref of requests) await update(ref);
    },
  };
}
