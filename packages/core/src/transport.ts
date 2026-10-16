/** The subset of the WebSocket API used here; browsers, React Native and tests all provide it. */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string) => SocketLike;

export interface ConnectionHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(): void;
}

export interface ReconnectOptions {
  minDelay?: number;
  maxDelay?: number;
}

const OPEN = 1;

/** Marks the SDK's own socket so WebSocket capture skips it; the hook checks the same literal. */
export const INTERNAL_SOCKET = '__CAPYBARA_INTERNAL__';

export const defaultSocketFactory: SocketFactory = (url) => {
  const WebSocketCtor = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket;
  if (!WebSocketCtor) throw new Error('WebSocket is not available in this environment');
  return new WebSocketCtor(url);
};

/** Binds to the WebSocket constructor present now, before plugins patch it. */
export function nativeSocketFactory(): SocketFactory {
  const WebSocketCtor = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket;
  return WebSocketCtor ? (url) => new WebSocketCtor(url) : defaultSocketFactory;
}

/** A WebSocket that reconnects with exponential backoff until stopped. */
export class Connection {
  private socket: SocketLike | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private stopped = true;
  private readonly minDelay: number;
  // Each failed attempt prints an error in browser consoles, so keep retries sparse.
  private readonly maxDelay: number;

  constructor(
    private readonly url: string,
    private readonly factory: SocketFactory,
    private readonly handlers: ConnectionHandlers,
    options: ReconnectOptions = {},
  ) {
    this.minDelay = options.minDelay ?? 1_000;
    this.maxDelay = options.maxDelay ?? 10_000;
  }

  get isOpen(): boolean {
    return this.socket !== null && this.socket.readyState === OPEN;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  send(data: string): boolean {
    if (!this.socket || this.socket.readyState !== OPEN) return false;
    try {
      this.socket.send(data);
      return true;
    } catch {
      return false;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      detach(socket);
      try {
        socket.close();
      } catch {
        // already closed
      }
    }
  }

  private open(): void {
    let socket: SocketLike;
    try {
      socket = this.factory(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    try {
      (socket as unknown as Record<string, unknown>)[INTERNAL_SOCKET] = true;
    } catch {
      // a frozen socket object; React Native's prototype capture would then record it
    }
    this.socket = socket;
    const lost = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      detach(socket);
      this.handlers.onClose();
      this.scheduleRetry();
    };
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempts = 0;
      this.handlers.onOpen();
    };
    socket.onmessage = (event) => {
      if (this.socket === socket && typeof event.data === 'string') this.handlers.onMessage(event.data);
    };
    socket.onclose = lost;
    // Some runtimes report a failed connect with `error` only, without a following `close`.
    socket.onerror = () => {
      if (socket.readyState !== OPEN) lost();
    };
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = Math.min(this.maxDelay, this.minDelay * 2 ** this.attempts);
    this.attempts++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) this.open();
    }, delay);
  }
}

function detach(socket: SocketLike): void {
  socket.onopen = null;
  socket.onmessage = null;
  socket.onerror = null;
  socket.onclose = null;
}
