import type { BodyPreview, EventPayloads } from '@capybara/protocol';

export type WebSocketEventKind = 'ws.connect' | 'ws.open' | 'ws.message' | 'ws.error' | 'ws.close';

export interface WebSocketHookOptions {
  /** Sockets whose URL contains one of these strings or matches one of these patterns are left alone. */
  ignoreUrls: Array<string | { source: string; flags: string }>;
  /** Subprotocols that mark a dev tool's socket, such as Vite's HMR channel. */
  ignoreProtocols: string[];
  /** Message previews are cut after this many characters. */
  maxMessage: number;
}

/**
 * Records WebSocket connections and their messages. Self-contained: the Metro bridge also runs it
 * inside apps through `toString()`, so it must not reference anything outside its own body.
 *
 * Browsers dispatch socket events natively, so only sockets created through the patched global
 * constructor are seen. React Native dispatches them from JS, so there the prototype is patched as
 * well, which also catches sockets created earlier or through a constructor a library saved at
 * import time (engine.io, under socket.io, does that).
 */
export function hookWebSockets(
  emit: <K extends WebSocketEventKind>(kind: K, payload: EventPayloads[K]) => void,
  options: WebSocketHookOptions,
): () => void {
  const scope = globalThis as Record<string, any>;
  const Native = scope.WebSocket;
  if (typeof Native !== 'function' || !Native.prototype) return () => {};
  const proto = Native.prototype;
  const reactNative = scope.navigator?.product === 'ReactNative';
  const clock = typeof scope.performance?.now === 'function' ? () => scope.performance.now() as number : () => Date.now();
  const prefix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let count = 0;
  const patterns = options.ignoreUrls.map((pattern) =>
    typeof pattern === 'string' ? pattern : new RegExp(pattern.source, pattern.flags),
  );
  const isIgnored = (url: string, protocols: string[]) =>
    protocols.some((protocol) => options.ignoreProtocols.includes(protocol)) ||
    patterns.some((pattern) => {
      if (typeof pattern === 'string') return url.includes(pattern);
      pattern.lastIndex = 0;
      return pattern.test(url);
    });

  // TextEncoder is missing on some React Native engines.
  const utf8 = (text: string) => {
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    }
    return bytes;
  };
  const preview = (data: unknown): BodyPreview => {
    if (typeof data === 'string') {
      const truncated = data.length > options.maxMessage;
      return { kind: 'text', text: truncated ? data.slice(0, options.maxMessage) : data, size: utf8(data), truncated };
    }
    const value = data as { byteLength?: unknown; size?: unknown; constructor?: { name?: string } } | null;
    if (value && typeof value === 'object') {
      if (typeof value.byteLength === 'number') {
        return { kind: 'binary', size: value.byteLength, summary: value.constructor?.name || 'ArrayBuffer' };
      }
      if (typeof value.size === 'number') return { kind: 'binary', size: value.size, summary: 'Blob' };
    }
    return { kind: 'unknown', summary: Object.prototype.toString.call(data) };
  };

  type Info = { id: string; start: number };
  const ignored: Info = { id: '', start: 0 };
  const sockets = new WeakMap<object, Info>();
  const elapsed = (info: Info) => Math.round(clock() - info.start);
  /** `url` is known only when the socket is created through the patched constructor. */
  const track = (socket: any, trigger: string, url?: unknown, protocols?: unknown): Info | undefined => {
    const known = sockets.get(socket);
    if (known) return known === ignored ? undefined : known;
    const list = protocols === undefined || protocols === null ? [] : (Array.isArray(protocols) ? protocols : [protocols]).map(String);
    const address = String(socket.url || url || '');
    // The SDK's own connection (INTERNAL_SOCKET in transport.ts); recording it would feed itself.
    if (socket.__CAPYBARA_INTERNAL__ || isIgnored(address, list)) {
      sockets.set(socket, ignored);
      return undefined;
    }
    const info: Info = { id: `ws-${prefix}-${++count}`, start: clock() };
    sockets.set(socket, info);
    const existing = url === undefined;
    emit('ws.connect', { id: info.id, url: address, protocols: list.length ? list : undefined, existing: existing || undefined });
    // An already open socket would otherwise look like it never connected.
    if (existing && trigger !== 'open' && socket.readyState === 1) {
      emit('ws.open', { id: info.id, protocol: socket.protocol || undefined, extensions: socket.extensions || undefined, duration: 0 });
    }
    return info;
  };
  const onEvent = (socket: any, event: any) => {
    const type = event?.type;
    if (type !== 'open' && type !== 'message' && type !== 'error' && type !== 'close') return;
    const info = track(socket, type);
    if (!info) return;
    if (type === 'open') {
      emit('ws.open', { id: info.id, protocol: socket.protocol || undefined, extensions: socket.extensions || undefined, duration: elapsed(info) });
    } else if (type === 'message') {
      emit('ws.message', { id: info.id, direction: 'received', data: preview(event.data) });
    } else if (type === 'error') {
      emit('ws.error', { id: info.id, message: (typeof event.message === 'string' && event.message) || 'WebSocket error' });
    } else {
      emit('ws.close', {
        id: info.id,
        code: typeof event.code === 'number' ? event.code : undefined,
        reason: event.reason || undefined,
        wasClean: typeof event.wasClean === 'boolean' ? event.wasClean : undefined,
        duration: elapsed(info),
      });
    }
  };
  const onSend = (socket: unknown, data: unknown) => {
    const info = track(socket, 'send');
    if (info) emit('ws.message', { id: info.id, direction: 'sent', data: preview(data) });
  };

  const restores: Array<() => void> = [];
  if (reactNative) {
    const wrap = (name: string, make: (original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown) => {
      const own = Object.getOwnPropertyDescriptor(proto, name);
      const original = own ? own.value : proto[name];
      if (typeof original !== 'function') return;
      const wrapper = make(original);
      Object.defineProperty(proto, name, { value: wrapper, configurable: true, writable: true, enumerable: own?.enumerable ?? false });
      restores.push(() => {
        if (Object.getOwnPropertyDescriptor(proto, name)?.value !== wrapper) return;
        if (own) Object.defineProperty(proto, name, own);
        else delete proto[name];
      });
    };
    wrap('dispatchEvent', (original) => function (this: unknown, event: unknown) {
      try {
        onEvent(this, event);
      } catch {
        // recording must never break the app's socket
      }
      return original.apply(this, arguments as unknown as unknown[]);
    });
    wrap('send', (original) => function (this: unknown, data: unknown) {
      const result = original.apply(this, arguments as unknown as unknown[]);
      try {
        onSend(this, data);
      } catch {
        // recording must never break the app's socket
      }
      return result;
    });
  }

  const Patched = function WebSocket(this: unknown, url: unknown, protocols?: unknown) {
    // Without `new` the native constructor throws its own error.
    if (!new.target) return Native.apply(this, arguments);
    const socket = Reflect.construct(Native, arguments, new.target);
    try {
      // On React Native the patched prototype reports events and sends.
      if (track(socket, 'create', url, protocols) && !reactNative) {
        for (const type of ['open', 'message', 'error', 'close']) {
          socket.addEventListener(type, (event: unknown) => {
            try {
              onEvent(socket, event);
            } catch {
              // recording must never break the app's socket
            }
          });
        }
        const send = socket.send;
        socket.send = function (this: unknown, data: unknown) {
          const result = send.apply(this, arguments);
          try {
            onSend(socket, data);
          } catch {
            // recording must never break the app's socket
          }
          return result;
        };
      }
    } catch {
      // recording must never break the app's socket
    }
    return socket;
  } as unknown as { prototype: unknown };
  Patched.prototype = proto;
  // Keeps WebSocket.OPEN and other statics, and `instanceof` checks.
  Object.setPrototypeOf(Patched, Native);
  scope.WebSocket = Patched;

  return () => {
    for (const restore of restores.reverse()) {
      try {
        restore();
      } catch {
        // keep restoring the rest
      }
    }
    if (scope.WebSocket === Patched) scope.WebSocket = Native;
  };
}
