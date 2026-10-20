import { PROTOCOL_VERSION, type EventKind, type EventPayloads, type ServerToClient, type SessionInfo } from '@capybara-devtools/protocol';
import { WebSocket } from 'ws';
import { debug } from './debug.js';
import { CALL_TIMEOUT_MS } from './metro-debugger.js';

export const MAX_HELD_EVENTS = 2_000;

export interface Session {
  emit<K extends EventKind>(kind: K, payload: EventPayloads[K], ts?: number): void;
  close(): void;
}

/** A lost relay ends the watcher; discovery reconnects it and starts a fresh session. */
export function openSession(
  url: string,
  info: SessionInfo,
  onDisconnect: () => void,
  onCommand: (command: Extract<ServerToClient, { t: 'command' }>) => Promise<unknown>,
): Session {
  const socket = new WebSocket(url, { handshakeTimeout: CALL_TIMEOUT_MS });
  let seq = 0;
  let ready = false;
  let queued: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const flush = () => {
    timer = undefined;
    if (!ready || queued.length === 0 || socket.readyState !== WebSocket.OPEN) return;
    socket.send(`{"t":"events","events":[${queued.join(',')}]}`);
    queued = [];
  };

  socket.on('open', () => socket.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION, session: info })));
  socket.on('message', (data) => {
    let message: ServerToClient;
    try {
      message = JSON.parse(data.toString()) as ServerToClient;
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.t === 'welcome') {
      ready = true;
      flush();
    } else if (message.t === 'command' && socket.readyState === WebSocket.OPEN) {
      const sendResult = (result: object) => {
        if (!closed && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ t: 'result', id: message.id, ...result }));
        }
      };
      void onCommand(message).then(
        (result) => sendResult({ ok: true, result }),
        (error: unknown) => sendResult({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
    } else if (message.t === 'reject') {
      socket.close();
    }
  });
  socket.on('error', (error) => debug(`Lost the connection to Capybara for ${info.appName}`, error));
  socket.on('close', () => {
    if (!closed) onDisconnect();
  });

  return {
    emit(kind, payload, ts = Date.now()) {
      if (closed) return;
      if (queued.length >= MAX_HELD_EVENTS) queued.shift();
      queued.push(JSON.stringify({ seq: ++seq, ts, kind, payload }));
      if (ready && !timer) timer = setTimeout(flush, 20);
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      flush();
      queued = [];
      socket.close();
    },
  };
}
