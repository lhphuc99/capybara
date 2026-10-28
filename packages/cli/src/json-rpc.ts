import { WebSocket, type RawData } from 'ws';

/** An error the other side answered with, such as "method not found" (-32601). */
export class JsonRpcError extends Error {
  constructor(message: string, readonly code: number | undefined) {
    super(message);
  }
}

interface Reply {
  result?: unknown;
  error?: { message?: string; code?: number };
}

/**
 * JSON-RPC 2.0 over a WebSocket, as the Dart VM service and its Development Service speak it. Unlike the CDP
 * client, each call states the version and takes its own timeout: reading an object can outlast a CDP call.
 */
export class JsonRpcClient {
  private socket: WebSocket | undefined;
  private nextId = 0;
  private readonly calls = new Map<string, (reply: Reply) => void>();

  constructor(
    private readonly onNotify: (method: string, params: unknown) => void,
    private readonly timeoutMs = 10_000,
  ) {}

  attach(socket: WebSocket): void {
    this.socket = socket;
    socket.on('message', (data) => this.receive(data));
    socket.on('close', () => this.failAll('The Dart VM service closed the connection'));
  }

  call<T>(method: string, params: object = {}, timeoutMs = this.timeoutMs): Promise<T> {
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected'));
        return;
      }
      const id = String(++this.nextId);
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.calls.set(id, (reply) => {
        clearTimeout(timer);
        if (reply.error) reject(new JsonRpcError(reply.error.message ?? 'Error', reply.error.code));
        else resolve(reply.result as T);
      });
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  close(): void {
    this.socket?.close();
    this.failAll('Closed');
  }

  private failAll(message: string): void {
    for (const reply of this.calls.values()) reply({ error: { message } });
    this.calls.clear();
  }

  private receive(data: RawData): void {
    let message: Reply & { id?: unknown; method?: unknown; params?: unknown };
    try {
      message = JSON.parse(data.toString()) as typeof message;
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.id !== undefined && message.id !== null) {
      const id = String(message.id);
      this.calls.get(id)?.(message);
      this.calls.delete(id);
    } else if (typeof message.method === 'string') {
      this.onNotify(message.method, message.params ?? {});
    }
  }
}

/** Opens a socket to a VM service or DDS, or resolves undefined when it can't. */
export function openJsonRpcSocket(url: string, signal: AbortSignal, timeoutMs = 5_000): Promise<WebSocket | undefined> {
  return new Promise((resolve) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: timeoutMs });
    } catch {
      resolve(undefined);
      return;
    }
    const fail = () => {
      signal.removeEventListener('abort', fail);
      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.terminate();
      resolve(undefined);
    };
    signal.addEventListener('abort', fail, { once: true });
    socket.once('error', fail);
    socket.once('close', fail);
    socket.once('open', () => {
      signal.removeEventListener('abort', fail);
      socket.off('error', fail);
      socket.off('close', fail);
      // Keep an error listener while the caller takes ownership.
      socket.on('error', () => {});
      resolve(socket);
    });
  });
}
