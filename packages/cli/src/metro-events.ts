import { serialize } from '@capybara-devtools/core';
import type { BodyPreview, SerializedValue } from '@capybara-devtools/protocol';
import {
  headerValue,
  initiatorOf,
  isDevServerRequest,
  isTextual,
  isUnhandledRejection,
  logLevel,
  primitiveValue,
  responseBody,
  textBody,
  type RemoteObject,
  type RequestInitiator,
} from './cdp.js';
import { debug } from './debug.js';
import type { CdpCall, CdpEvent, EvaluateResult } from './metro-debugger.js';
import type { Session } from './metro-relay.js';
import { parseWebSocketReport, WEBSOCKET_BINDING } from './metro-websocket.js';

const MAX_BODY_FETCH = 4 * 1024 * 1024;

const SERIALIZER_GLOBAL = '__CAPYBARA_SERIALIZE__';
const INSTALL_SERIALIZER = `globalThis.${SERIALIZER_GLOBAL} = ${serialize.toString()}`;
/** Returns null until the serializer is installed in this JS context, e.g. right after a reload. */
const SERIALIZE_ARGS = `function () {
  var serialize = globalThis.${SERIALIZER_GLOBAL};
  if (typeof serialize !== 'function') return null;
  var out = [];
  for (var i = 0; i < arguments.length; i++) out.push(serialize(arguments[i]));
  return JSON.stringify(out);
}`;

export interface ConsoleCall {
  type: string;
  args: RemoteObject[];
  executionContextId: number;
  timestamp?: number;
}

interface ExceptionThrown {
  timestamp?: number;
  exceptionDetails: { text?: string; exception?: RemoteObject; executionContextId?: number };
}

interface RequestSent {
  requestId: string;
  type?: string;
  initiator?: RequestInitiator;
  timestamp: number;
  wallTime?: number;
  request: { url: string; method: string; headers?: Record<string, string>; postData?: string };
}

interface ResponseReceived {
  requestId: string;
  timestamp: number;
  response: { status: number; statusText?: string; headers?: Record<string, string>; mimeType?: string };
}

interface LoadingFinished {
  requestId: string;
  timestamp: number;
  encodedDataLength?: number;
}

interface LoadingFailed {
  requestId: string;
  timestamp: number;
  errorText?: string;
  canceled?: boolean;
}

export interface Request {
  start: number;
  ignored: boolean;
  response?: ResponseReceived['response'];
  responseAt?: number;
}

/** What reading the events of one run of the app needs from its watcher. */
export interface EventContext {
  session: Session;
  call: CdpCall;
  /** Object handles stay alive in the app until released. */
  release(objects: RemoteObject[]): void;
  contextId: number;
  requests: Map<string, Request>;
  metroPort: number;
  /** Names the app in debug lines. */
  label(): string;
}

/** For an event that is not read: the objects it holds in the app can go. */
export function releaseEvent(event: CdpEvent, release: (objects: RemoteObject[]) => void): void {
  if (event.method === 'Runtime.consoleAPICalled') release((event.params as ConsoleCall).args);
  if (event.method === 'Runtime.exceptionThrown') {
    const exception = (event.params as ExceptionThrown).exceptionDetails.exception;
    if (exception) release([exception]);
  }
}

/** Reads one CDP event of the app and reports what it says to Capybara. */
export async function relayEvent(event: CdpEvent, context: EventContext): Promise<void> {
  const { session } = context;
  switch (event.method) {
    case 'Runtime.consoleAPICalled': {
      const { type, args, executionContextId, timestamp } = event.params as ConsoleCall;
      const level = logLevel(type);
      if (!level) {
        context.release(args);
        return;
      }
      const values = await serializeArgs(args, executionContextId ?? context.contextId, context);
      const source = level === 'error' && isUnhandledRejection(values) ? 'unhandledrejection' : 'console';
      session.emit('log', { level, source, args: values }, epochMs(timestamp));
      return;
    }
    case 'Runtime.bindingCalled': {
      const { name, payload } = event.params as { name?: string; payload?: unknown };
      if (name !== WEBSOCKET_BINDING) return;
      const report = parseWebSocketReport(payload);
      if (report) session.emit(report.kind, report.payload as never, report.ts);
      return;
    }
    case 'Runtime.exceptionThrown': {
      const { exceptionDetails: details, timestamp } = event.params as ExceptionThrown;
      const args = details.exception
        ? await serializeArgs([details.exception], details.executionContextId ?? context.contextId, context)
        : [details.text ?? 'Uncaught exception'];
      session.emit('log', { level: 'error', source: 'uncaught', args }, epochMs(timestamp));
      return;
    }
    case 'Network.requestWillBeSent': {
      const { requestId, request, type, initiator, timestamp, wallTime } = event.params as RequestSent;
      // Redirects reuse the id; the first request stands for the chain.
      if (context.requests.has(requestId)) return;
      const ignored = isDevServerRequest(request.url, context.metroPort);
      context.requests.set(requestId, { start: timestamp, ignored });
      if (ignored) return;
      const headers = request.headers ?? {};
      session.emit(
        'network.request',
        {
          id: requestId,
          initiator: initiatorOf(type, initiator),
          method: request.method,
          url: request.url,
          headers,
          body: request.postData ? textBody(request.postData, headerValue(headers, 'content-type')) : undefined,
        },
        wallTime ? Math.round(wallTime * 1000) : undefined,
      );
      return;
    }
    case 'Network.responseReceived': {
      const { requestId, response, timestamp } = event.params as ResponseReceived;
      const request = context.requests.get(requestId);
      if (!request || request.ignored) return;
      request.response = response;
      request.responseAt = timestamp;
      return;
    }
    case 'Network.loadingFinished': {
      const { requestId, timestamp, encodedDataLength } = event.params as LoadingFinished;
      const request = context.requests.get(requestId);
      context.requests.delete(requestId);
      if (!request || request.ignored) return;
      const response = request.response;
      if (!response) {
        session.emit('network.error', {
          id: requestId,
          message: 'The app reported no response',
          duration: elapsed(request.start, timestamp),
        });
        return;
      }
      const headers = response.headers ?? {};
      const contentType = headerValue(headers, 'content-type') || response.mimeType || undefined;
      session.emit('network.response', {
        id: requestId,
        status: response.status,
        statusText: response.statusText || undefined,
        headers,
        body: await readBody(requestId, contentType, encodedDataLength, context),
        duration: elapsed(request.start, request.responseAt ?? timestamp),
      });
      return;
    }
    case 'Network.loadingFailed': {
      const { requestId, timestamp, errorText, canceled } = event.params as LoadingFailed;
      const request = context.requests.get(requestId);
      context.requests.delete(requestId);
      if (!request || request.ignored) return;
      session.emit('network.error', {
        id: requestId,
        message: errorText || 'Request failed',
        duration: elapsed(request.start, timestamp),
        aborted: canceled || undefined,
      });
      return;
    }
  }
}

async function serializeInApp(objects: RemoteObject[], contextId: number, call: CdpCall): Promise<SerializedValue[]> {
  const params = {
    executionContextId: contextId,
    functionDeclaration: SERIALIZE_ARGS,
    arguments: objects.map((object) => ({ objectId: object.objectId })),
    returnByValue: true,
  };
  let reply = await call<EvaluateResult>('Runtime.callFunctionOn', params);
  if (reply.result?.value === null) {
    await call('Runtime.evaluate', { expression: INSTALL_SERIALIZER, contextId });
    reply = await call<EvaluateResult>('Runtime.callFunctionOn', params);
  }
  const json = reply.result?.value;
  if (typeof json !== 'string') throw new Error('The app could not serialize the values');
  return JSON.parse(json) as SerializedValue[];
}

async function serializeArgs(args: RemoteObject[], contextId: number, context: EventContext): Promise<SerializedValue[]> {
  const objects = args.filter((arg) => arg.objectId);
  const inApp =
    objects.length > 0
      ? await serializeInApp(objects, contextId, context.call).catch((error: unknown) => {
          debug(`Could not read logged values in ${context.label()}, so they show as descriptions`, error);
          return undefined;
        })
      : undefined;
  context.release(objects);
  let next = 0;
  // Without the in-app values, objects keep the one-line description CDP gave.
  return args.map((arg) => (arg.objectId && inApp ? inApp[next++]! : primitiveValue(arg)));
}

async function readBody(
  requestId: string,
  contentType: string | undefined,
  size: number | undefined,
  context: EventContext,
): Promise<BodyPreview | undefined> {
  if (contentType && /^text\/event-stream/i.test(contentType)) {
    return { kind: 'stream', contentType, summary: 'Event stream' };
  }
  if (!isTextual(contentType)) return { kind: 'binary', contentType, size, summary: contentType ?? 'Binary' };
  if (size !== undefined && size > MAX_BODY_FETCH) {
    return { kind: 'unknown', contentType, size, summary: 'Too large to capture' };
  }
  const result = await context.call<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId }).catch(
    (error: unknown) => {
      debug(`No body for request ${requestId} of ${context.label()}`, error);
      return undefined;
    },
  );
  return result ? responseBody(result, contentType) : undefined;
}

/** CDP console and exception timestamps are milliseconds since the epoch. */
function epochMs(timestamp: number | undefined): number {
  return typeof timestamp === 'number' && timestamp > 1e12 ? Math.round(timestamp) : Date.now();
}

/** Network timestamps are in seconds. */
function elapsed(start: number, end: number): number {
  return Math.max(0, Math.round((end - start) * 1000));
}
