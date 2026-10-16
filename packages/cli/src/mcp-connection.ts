import {
  VIEWER_PATH,
  type CapybaraEvent,
  type CommandResult,
  type NetworkDiagnosis,
  type ServerInfo,
  type ServerToViewer,
  type SessionMeta,
  type StorageCommands,
  type ViewerToServer,
} from '@capybara-devtools/protocol';
import { WebSocket } from 'ws';

const TIMEOUT_MS = 10_000;
/** The server may wait 8 s for each request a diagnosis sends again. */
const DIAGNOSE_TIMEOUT_MS = 60_000;

/**
 * Reads a running Capybara server the way its UI does, through the viewer socket. It connects on
 * first use and again after the server restarts, so the MCP server can start before Capybara does.
 */
export class ViewerConnection {
  private socket: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private server: ServerInfo | undefined;
  private readonly sessions = new Map<string, SessionMeta>();
  private readonly results = new Map<string, (result: CommandResult) => void>();
  private readonly histories = new Map<string, Array<{ resolve: (events: CapybaraEvent[]) => void; reject: (error: Error) => void }>>();
  private counter = 0;

  constructor(
    readonly port: number,
    readonly host = '127.0.0.1',
  ) {}

  async listSessions(): Promise<{ server: ServerInfo; sessions: SessionMeta[] }> {
    await this.open();
    return { server: this.server!, sessions: [...this.sessions.values()] };
  }

  async history(sessionId: string): Promise<CapybaraEvent[]> {
    await this.open();
    return new Promise((resolve, reject) => {
      const waiting = this.histories.get(sessionId) ?? [];
      const timer = setTimeout(() => reject(new Error('Capybara did not send the session history in time')), TIMEOUT_MS);
      waiting.push({
        resolve: (events) => {
          clearTimeout(timer);
          resolve(events);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.histories.set(sessionId, waiting);
      if (waiting.length === 1) this.send({ t: 'history', sessionId });
    });
  }

  storage<M extends keyof StorageCommands>(sessionId: string, method: M, params: StorageCommands[M]['params']): Promise<StorageCommands[M]['result']> {
    return this.request((id) => ({ t: 'command', id, sessionId, plugin: 'storage', method, params }), TIMEOUT_MS);
  }

  diagnose(sessionId: string, requestId: string): Promise<NetworkDiagnosis> {
    return this.request((id) => ({ t: 'diagnose', id, sessionId, requestId }), DIAGNOSE_TIMEOUT_MS);
  }

  close(): void {
    this.socket?.close();
  }

  private async request<T>(message: (id: string) => ViewerToServer, timeout: number): Promise<T> {
    await this.open();
    const id = `mcp${++this.counter}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.results.delete(id);
        reject(new Error('Capybara did not answer in time'));
      }, timeout);
      this.results.set(id, (result) => {
        clearTimeout(timer);
        if (result.ok) resolve(result.result as T);
        else reject(new Error(result.error));
      });
      this.send(message(id));
    });
  }

  private open(): Promise<void> {
    if (this.opening) return this.opening;
    const address = `${this.host}:${this.port}`;
    // The server only lets its own origin read data, the way a browser tab on it would.
    const socket = new WebSocket(`ws://${address}${VIEWER_PATH}`, { origin: `http://${address}` });
    this.socket = socket;
    const opening = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(notRunning(address));
      }, TIMEOUT_MS);
      socket.on('message', (data) => {
        let message: ServerToViewer;
        try {
          message = JSON.parse(String(data)) as ServerToViewer;
        } catch {
          return;
        }
        if (message.t === 'init') {
          clearTimeout(timer);
          this.server = message.server;
          this.sessions.clear();
          for (const session of message.sessions) this.sessions.set(session.info.id, session);
          resolve();
        } else {
          this.receive(message);
        }
      });
      socket.on('error', () => {
        clearTimeout(timer);
        reject(notRunning(address));
      });
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.opening = null;
        const error = 'The connection to Capybara closed';
        for (const [id, settle] of this.results) settle({ t: 'result', id, ok: false, error });
        this.results.clear();
        for (const waiting of this.histories.values()) for (const { reject } of waiting) reject(new Error(error));
        this.histories.clear();
      });
    });
    this.opening = opening;
    opening.catch(() => {
      if (this.socket === socket) {
        this.socket = null;
        this.opening = null;
      }
    });
    return opening;
  }

  private receive(message: ServerToViewer): void {
    switch (message.t) {
      case 'server':
        this.server = message.server;
        break;
      case 'session':
        this.sessions.set(message.session.info.id, message.session);
        break;
      case 'session.removed':
        this.sessions.delete(message.sessionId);
        break;
      case 'history': {
        const waiting = this.histories.get(message.sessionId) ?? [];
        this.histories.delete(message.sessionId);
        for (const { resolve } of waiting) resolve(message.events);
        break;
      }
      case 'result': {
        const settle = this.results.get(message.id);
        this.results.delete(message.id);
        settle?.(message);
        break;
      }
    }
  }

  private send(message: ViewerToServer): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
}

function notRunning(address: string): Error {
  return new Error(
    `Capybara is not running on ${address}. Open the Capybara app or run \`npx capybara-devtools\`, then try again. ` +
      'If it uses another port, start the MCP server with --port.',
  );
}
