import { randomUUID } from 'node:crypto';
import { hookWebSockets, type WebSocketEventKind, type WebSocketHookOptions } from '@capybara-devtools/core';
import type { CdpCall } from './metro-debugger.js';

/** React Native's inspector forwards calls of this runtime function as Runtime.bindingCalled. */
export const WEBSOCKET_BINDING = '__capybaraWebSocket';

const KINDS = new Set<string>(['ws.connect', 'ws.open', 'ws.message', 'ws.error', 'ws.close']);

/** Installs WebSocket capture in the app and keeps its lease alive while connected. */
export function watchMetroWebSockets(call: CdpCall, contextId: number, options: WebSocketHookOptions) {
  const owner = randomUUID();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const invoke = (action: 'watch' | 'stop') => call('Runtime.evaluate', {
    expression: `(${trackWebSockets.toString()})(${JSON.stringify(action)}, ${JSON.stringify(owner)}, ` +
      `${JSON.stringify(WEBSOCKET_BINDING)}, ${hookWebSockets.toString()}, ${JSON.stringify(options)})`,
    contextId,
    returnByValue: true,
  }).catch(() => {});
  const tick = async () => {
    await invoke('watch');
    if (!stopped) {
      timer = setTimeout(() => void tick(), 2_000);
      timer.unref();
    }
  };
  // The binding must exist before the hook reports anything through it.
  void call('Runtime.addBinding', { name: WEBSOCKET_BINDING, executionContextId: contextId }).catch(() => {}).then(tick);
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      return invoke('stop').then(() => call('Runtime.removeBinding', { name: WEBSOCKET_BINDING }).catch(() => {}));
    },
  };
}

/** Returns the event a binding call carries, or undefined for anything else. */
export function parseWebSocketReport(payload: unknown): { kind: WebSocketEventKind; payload: Record<string, unknown>; ts?: number } | undefined {
  if (typeof payload !== 'string') return undefined;
  try {
    const report = JSON.parse(payload) as { kind?: unknown; payload?: unknown; ts?: unknown };
    if (!report || typeof report.kind !== 'string' || !KINDS.has(report.kind)) return undefined;
    if (!report.payload || typeof report.payload !== 'object' || typeof (report.payload as { id?: unknown }).id !== 'string') return undefined;
    return {
      kind: report.kind as WebSocketEventKind,
      payload: report.payload as Record<string, unknown>,
      ts: typeof report.ts === 'number' ? report.ts : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Self-contained, evaluated in the app. One hook serves every connected Capybara; each refreshes a
 * lease, and the hook is removed when the last lease ends, so a vanished debugger cannot leave it.
 */
export function trackWebSockets(
  action: 'watch' | 'stop',
  owner: string,
  binding: string,
  hook: typeof hookWebSockets,
  options: WebSocketHookOptions,
) {
  type Tracker = { version: 1; owners: Map<string, number>; dispose(): void };
  const root = globalThis as unknown as Record<string, unknown> & { __CAPYBARA_WS_TRACKER_V1__?: Tracker };
  let tracker = root.__CAPYBARA_WS_TRACKER_V1__;
  if (tracker && tracker.version !== 1) return;
  if (action === 'stop') {
    if (tracker) {
      tracker.owners.delete(owner);
      if (!tracker.owners.size) tracker.dispose();
    }
    return;
  }
  if (!tracker) {
    if (typeof setInterval !== 'function' || typeof clearInterval !== 'function') return;
    const owners = new Map<string, number>();
    let expiry: ReturnType<typeof setInterval> | undefined;
    let disposed = false;
    const unhook = hook((kind, payload) => {
      const report = root[binding];
      if (typeof report === 'function') report(JSON.stringify({ kind, payload, ts: Date.now() }));
    }, options);
    const created: Tracker = {
      version: 1,
      owners,
      dispose() {
        if (disposed) return;
        disposed = true;
        clearInterval(expiry);
        owners.clear();
        unhook();
        if (root.__CAPYBARA_WS_TRACKER_V1__ === created) delete root.__CAPYBARA_WS_TRACKER_V1__;
      },
    };
    expiry = setInterval(() => {
      const now = Date.now();
      for (const [id, deadline] of owners) if (deadline <= now) owners.delete(id);
      if (!owners.size) created.dispose();
    }, 5_000);
    tracker = created;
    root.__CAPYBARA_WS_TRACKER_V1__ = created;
  }
  tracker.owners.set(owner, Date.now() + 15_000);
}
