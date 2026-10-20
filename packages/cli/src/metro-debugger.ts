import { WebSocket, type RawData } from 'ws';
import type { RemoteObject } from './cdp.js';

export type CdpCall = <T>(method: string, params?: object) => Promise<T>;

export interface CdpEvent {
  method: string;
  params: unknown;
}

interface CdpReply {
  result?: unknown;
  error?: { message: string; code?: number };
}

export interface EvaluateResult {
  result?: { value?: unknown };
}

export class CdpError extends Error {
  constructor(message: string, readonly code: number | undefined) {
    super(message);
  }
}

export const CALL_TIMEOUT_MS = 3_000;
/** JSON-RPC "method not found". */
export const METHOD_NOT_FOUND = -32601;
/** Expo's dev server accepts a debugger socket and drops it right away when the Origin isn't its own address. */
const ORIGIN_CHECK_MS = 300;

/** Calls methods over a debugger socket and passes its events on; calls fail until a socket is attached. */
export class CdpClient {
  private socket: WebSocket | undefined;
  private nextId = 0;
  private readonly calls = new Map<number, (reply: CdpReply) => void>();

  constructor(private readonly onEvent: (event: CdpEvent) => void) {}

  attach(socket: WebSocket): void {
    this.socket = socket;
    socket.on('message', (data) => this.receive(data));
  }

  readonly call: CdpCall = <T>(method: string, params: object = {}): Promise<T> =>
    new Promise((resolve, reject) => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected'));
        return;
      }
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error(`${method} timed out`));
      }, CALL_TIMEOUT_MS);
      this.calls.set(id, (reply) => {
        clearTimeout(timer);
        if (reply.error) reject(new CdpError(reply.error.message, reply.error.code));
        else resolve(reply.result as T);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });

  /** Object handles stay alive in the app until released. */
  readonly release = (objects: RemoteObject[]): void => {
    for (const object of objects) {
      if (object.objectId) this.call('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
    }
  };

  close(): void {
    this.socket?.close();
    for (const reply of this.calls.values()) reply({ error: { message: 'Closed' } });
    this.calls.clear();
  }

  private receive(data: RawData): void {
    let message: CdpReply & { id?: number; method?: string; params?: unknown };
    try {
      message = JSON.parse(data.toString()) as typeof message;
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (typeof message.id === 'number') {
      this.calls.get(message.id)?.(message);
      this.calls.delete(message.id);
    } else if (typeof message.method === 'string') {
      this.onEvent({ method: message.method, params: message.params ?? {} });
    }
  }
}

/** Expo checks the Origin against its own address (127.0.0.1); plain Metro accepts any localhost origin. */
export async function connect(url: string, metroPort: number, signal: AbortSignal): Promise<WebSocket | undefined> {
  for (const host of ['127.0.0.1', 'localhost']) {
    if (signal.aborted) return undefined;
    const socket = await openSocket(url, `http://${host}:${metroPort}`, signal);
    if (socket) return socket;
  }
  return undefined;
}

function openSocket(url: string, origin: string, signal: AbortSignal): Promise<WebSocket | undefined> {
  return new Promise((resolve) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, { origin, perMessageDeflate: false, handshakeTimeout: CALL_TIMEOUT_MS });
    } catch {
      resolve(undefined);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = () => {
      signal.removeEventListener('abort', fail);
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.terminate();
      resolve(undefined);
    };
    signal.addEventListener('abort', fail, { once: true });
    socket.once('error', fail);
    socket.once('close', fail);
    socket.once('open', () => {
      timer = setTimeout(() => {
        socket.off('error', fail);
        socket.off('close', fail);
        signal.removeEventListener('abort', fail);
        // Keep an error listener while the awaiting caller takes ownership.
        socket.on('error', () => {});
        resolve(socket);
      }, ORIGIN_CHECK_MS);
    });
  });
}
