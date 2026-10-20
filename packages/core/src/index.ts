export { CLIENT_GLOBAL, createClient, getActiveClient } from './client.js';
export type { ClientOptions, CapybaraClient, Plugin, PluginContext } from './client.js';
export { initClient } from './init.js';
export type { CommonInitOptions, PlatformSetup } from './init.js';
export { serialize } from './serialize.js';
export type { SerializeOptions } from './serialize.js';
export type { SocketFactory, SocketLike } from './transport.js';
export { consolePlugin, type ConsolePluginOptions } from './plugins/console.js';
export { networkPlugin } from './plugins/network.js';
export type { NetworkPluginOptions } from './plugins/network.js';
export { hookWebSockets } from './plugins/websocket.js';
export type { WebSocketEventKind, WebSocketHookOptions } from './plugins/websocket.js';
export { storagePlugin } from './plugins/storage.js';
export type { StorageAdapter } from './plugins/storage.js';
export { statePlugin } from './plugins/state/index.js';
export type { StatePluginOptions, StateSink, StoreDriver } from './plugins/state/index.js';
export { walkProviders } from './plugins/state/fibers.js';
export type {
  Fiber as ReactFiber,
  FiberRoot as ReactFiberRoot,
  ProviderHit,
  WalkCursor,
  WalkProvidersOptions,
  WalkProvidersResult,
} from './plugins/state/fibers.js';
export { capybaraReduxEnhancer, connectReduxStore } from './plugins/state/redux.js';
export type { ReduxStoreEnhancer, ReduxStoreLike, ReduxStoreOptions } from './plugins/state/redux.js';
export { watchZustand } from './plugins/state/zustand.js';
export type { WatchZustandOptions, ZustandStoreLike } from './plugins/state/zustand.js';
export { watchXState } from './plugins/state/xstate.js';
export type { WatchXStateOptions, XStateActorLike } from './plugins/state/xstate.js';
export { watchMobX } from './plugins/state/mobx.js';
export type { MobxLike, WatchMobXOptions } from './plugins/state/mobx.js';
export { createQueryClientDriver, summarizeMutation, summarizeQuery, watchQueryClient } from './plugins/state/tanstack.js';
export type { QueryClientLike, WatchQueryClientOptions } from './plugins/state/tanstack.js';
export { summarizeSWREntry, swrMiddleware, swrProvider, watchSWR } from './plugins/state/swr.js';
export type { SWRCacheLike, SWRHandle, WatchSWROptions } from './plugins/state/swr.js';
