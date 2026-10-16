import {
  DEFAULT_PORT,
  VIEWER_PATH,
  type CommandResult,
  type ServerToViewer,
  type StorageCommands,
  type ViewerToServer,
} from '@devsight/protocol';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

interface Handlers {
  onMessage(message: Exclude<ServerToViewer, CommandResult>): void;
  onStatus(status: ConnectionStatus): void;
}

interface PendingCommand {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: number;
}

let socket: WebSocket | null = null;
let commandCounter = 0;
const pending = new Map<string, PendingCommand>();

function viewerUrl(): string {
  const configured = import.meta.env.VITE_DEVSIGHT_SERVER;
  if (configured) return `${configured}${VIEWER_PATH}`;
  // Under `vite dev` the page comes from Vite, not from the Devsight server.
  if (import.meta.env.DEV) return `ws://${location.hostname}:${DEFAULT_PORT}${VIEWER_PATH}`;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${VIEWER_PATH}`;
}

export function connect(handlers: Handlers): void {
  let attempts = 0;
  const open = () => {
    handlers.onStatus('connecting');
    const ws = new WebSocket(viewerUrl());
    socket = ws;
    ws.onopen = () => {
      attempts = 0;
      handlers.onStatus('open');
    };
    ws.onmessage = (event) => {
      let message: ServerToViewer;
      try {
        message = JSON.parse(String(event.data)) as ServerToViewer;
      } catch {
        return;
      }
      if (message.t === 'result') settle(message);
      else handlers.onMessage(message);
    };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      for (const [id, command] of pending) {
        clearTimeout(command.timer);
        command.reject(new Error('Lost the connection to the Devsight server'));
        pending.delete(id);
      }
      handlers.onStatus('closed');
      setTimeout(open, Math.min(5_000, 500 * 2 ** attempts++));
    };
  };
  open();
}

export function send(message: ViewerToServer): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

export function command<T>(sessionId: string, plugin: string, method: string, params?: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (socket?.readyState !== WebSocket.OPEN) {
      reject(new Error('Not connected to the Devsight server'));
      return;
    }
    const id = `v${++commandCounter}`;
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error('The server did not answer in time'));
    }, 15_000);
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    send({ t: 'command', id, sessionId, plugin, method, params });
  });
}

export function storageCommand<M extends keyof StorageCommands>(
  sessionId: string,
  method: M,
  params: StorageCommands[M]['params'],
): Promise<StorageCommands[M]['result']> {
  return command(sessionId, 'storage', method, params);
}

function settle(result: CommandResult): void {
  const entry = pending.get(result.id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(result.id);
  if (result.ok) entry.resolve(result.result);
  else entry.reject(new Error(result.error));
}
