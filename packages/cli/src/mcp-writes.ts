import { formatBytes, type SessionMeta, type StateEntryOp, type StateEntrySummary, type StorageAdapterInfo } from '@capybara-devtools/protocol';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ViewerConnection } from './mcp-connection.js';
import type { StateHistory, StoreEntry } from './mcp-history.js';
import { isCache, listStores, storeTitle } from './mcp-state.js';
import { count, pickSession, sessionHeader } from './mcp-text.js';

/** What the tools that change things share with the ones that read. */
export interface WriteToolContext {
  connection: ViewerConnection;
  run: (produce: () => Promise<string>) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;
  openState: (id: string | undefined) => Promise<{ meta: SessionMeta; history: StateHistory }>;
  currentStores: (meta: SessionMeta, history: StateHistory) => Promise<{ stores: StoreEntry[]; failure?: string }>;
  pickStore: (meta: SessionMeta, stores: StoreEntry[], name: string) => { store: StoreEntry; others: number };
  findEntry: (
    meta: SessionMeta,
    caches: StoreEntry[],
    key: string,
    path: [],
  ) => Promise<{ store: StoreEntry; result: { summary: StateEntrySummary } }>;
}

export const WRITE_INSTRUCTIONS = `Some tools change things: set_storage, remove_storage and clear_storage edit the app's storage, act_on_query refetches, invalidates or resets TanStack Query and SWR entries, and clear_session and remove_session clear what Capybara recorded. Use them only when the user asks, e.g. to try the app with a made-up user or a feature flag turned on.`;

const session = z.string().optional().describe('Session id from list_sessions. Defaults to the newest connected app, one on this computer first.');
const adapter = z.string().describe('Store id from get_storage, e.g. localStorage or async-storage.');
const changes = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

const OPS = ['refetch', 'invalidate', 'reset', 'cancel', 'remove', 'revalidate', 'clear'] as const satisfies readonly StateEntryOp[];
const DONE: Record<StateEntryOp, string> = {
  refetch: 'refetched',
  invalidate: 'invalidated',
  reset: 'reset',
  cancel: 'cancelled',
  remove: 'removed',
  revalidate: 'revalidated',
  clear: 'cleared',
};

export function registerWriteTools(server: McpServer, context: WriteToolContext): void {
  const { connection, run } = context;

  const connectedApp = async (id: string | undefined, consequence: string) => {
    const { sessions } = await connection.listSessions();
    const meta = pickSession(sessions, id);
    if (!meta.connected) throw new Error(`${sessionHeader(meta)} is not connected, so ${consequence}.`);
    return meta;
  };
  const findAdapter = async (meta: SessionMeta, id: string): Promise<StorageAdapterInfo> => {
    const adapters = await connection.storage(meta.info.id, 'list', undefined);
    const found = adapters.find((candidate) => candidate.id === id);
    if (found) return found;
    if (adapters.length === 0) throw new Error(`${sessionHeader(meta)} has no storage Capybara can read.`);
    throw new Error(`${sessionHeader(meta)} has no store ${id}. Its stores: ${adapters.map((candidate) => candidate.id).join(', ')}.`);
  };
  const writable = (store: StorageAdapterInfo) => {
    if (store.readOnly) throw new Error(`${store.label} is read-only.${store.note ? ` ${store.note}` : ''}`);
    return store;
  };

  server.registerTool(
    'set_storage',
    {
      title: 'Set a storage key',
      description:
        "Sets a key in the app's storage (localStorage, sessionStorage, cookies, AsyncStorage, MMKV) to a value, adding the key if it is missing. The value is stored as the text given; for JSON, pass the JSON text. The app must be connected.",
      inputSchema: { session, adapter, key: z.string().describe('The key to set.'), value: z.string().describe('The new value, as text.') },
      annotations: changes,
    },
    (args) =>
      run(async () => {
        const meta = await connectedApp(args.session, 'its storage cannot be changed');
        const store = writable(await findAdapter(meta, args.adapter));
        await connection.storage(meta.info.id, 'set', { adapter: store.id, key: args.key, value: args.value });
        return `${sessionHeader(meta)} · ${store.id}: set ${args.key} (${formatBytes(Buffer.byteLength(args.value))}).`;
      }),
  );

  server.registerTool(
    'remove_storage',
    {
      title: 'Remove a storage key',
      description: "Removes one key from the app's storage. The app must be connected.",
      inputSchema: { session, adapter, key: z.string().describe('The key to remove.') },
      annotations: changes,
    },
    (args) =>
      run(async () => {
        const meta = await connectedApp(args.session, 'its storage cannot be changed');
        const store = writable(await findAdapter(meta, args.adapter));
        const existing = await connection.storage(meta.info.id, 'get', { adapter: store.id, key: args.key });
        if (!existing) return `${sessionHeader(meta)} · ${store.id} has no key ${args.key}; nothing was removed.`;
        await connection.storage(meta.info.id, 'remove', { adapter: store.id, key: args.key });
        return `${sessionHeader(meta)} · ${store.id}: removed ${args.key}.`;
      }),
  );

  server.registerTool(
    'clear_storage',
    {
      title: 'Clear a store',
      description: "Removes every key of one of the app's stores, e.g. all of localStorage. The app must be connected.",
      inputSchema: { session, adapter },
      annotations: changes,
    },
    (args) =>
      run(async () => {
        const meta = await connectedApp(args.session, 'its storage cannot be changed');
        const store = writable(await findAdapter(meta, args.adapter));
        if (!store.canClear) throw new Error(`${store.label} cannot be cleared; remove_storage removes its keys one at a time.`);
        const keys = await connection.storage(meta.info.id, 'entries', { adapter: store.id }).then(
          (listing) => listing.total,
          () => undefined,
        );
        await connection.storage(meta.info.id, 'clear', { adapter: store.id });
        return `${sessionHeader(meta)} · ${store.id}: cleared${keys === undefined ? '' : ` ${count(keys, 'key')}`}.`;
      }),
  );

  server.registerTool(
    'act_on_query',
    {
      title: 'Refetch, invalidate or reset a query',
      description:
        'Runs an action on one TanStack Query or SWR entry, as the buttons of the State tab do. TanStack Query: refetch, invalidate, reset (back to its initial data), cancel (a fetch in flight) or remove (from the cache). SWR: revalidate, clear (drop the cached data) or reset (drop it and fetch again). The app must be connected.',
      inputSchema: {
        session,
        key: z.string().describe('A key from get_queries.'),
        op: z.enum(OPS).describe('What to do with the entry.'),
        store: z.string().optional().describe('The cache, an id or label from get_state; needed only when the key is in more than one.'),
      },
      annotations: { ...changes, idempotentHint: false, openWorldHint: true },
    },
    (args) =>
      run(async () => {
        const { meta, history } = await context.openState(args.session);
        if (!meta.connected) throw new Error(`${sessionHeader(meta)} is not connected, so its queries cannot be changed.`);
        const { stores } = await context.currentStores(meta, history);
        let caches: StoreEntry[];
        if (args.store) {
          const { store } = context.pickStore(meta, stores, args.store);
          if (!isCache(store.info)) throw new Error(`${storeTitle(store.info)} is not a TanStack Query or SWR cache.`);
          caches = [store];
        } else {
          caches = listStores(stores).shown.filter((store) => isCache(store.info) && !store.info.disposed);
        }
        if (caches.length === 0) throw new Error(`${sessionHeader(meta)} has no TanStack Query or SWR cache. get_state lists its stores.`);
        const { store, result } = await context.findEntry(meta, caches, args.key, []);
        const { summary } = result;
        // As in the State tab: a mutation only reports what happened.
        if (summary.kind === 'mutation') throw new Error(`${summary.label} is a mutation, which has nothing to ${args.op}.`);
        const ops = store.info.ops ?? [];
        if (!ops.includes(args.op)) {
          throw new Error(`${storeTitle(store.info)} cannot ${args.op} an entry${ops.length > 0 ? `; it can ${ops.join(', ')}` : ''}.`);
        }
        const outcome = await connection.state(meta.info.id, 'act', { store: store.info.id, key: summary.key, op: args.op });
        const where = `${sessionHeader(meta)} · ${storeTitle(store.info)}`;
        return outcome.done ? `${where}: ${DONE[args.op]} ${summary.label}.` : `${where}: ${outcome.note ?? `${args.op} did nothing`}.`;
      }),
  );

  server.registerTool(
    'clear_session',
    {
      title: "Clear a session's records",
      description:
        "Clears what Capybara recorded for an app, as the Clear button does: its logs, requests, WebSocket messages and state changes, or with scope state only the state changes. The app keeps running and what it does next is recorded as before.",
      inputSchema: {
        session,
        scope: z.enum(['all', 'state']).optional().describe('all (the default) or state.'),
      },
      annotations: changes,
    },
    (args) =>
      run(async () => {
        const { sessions } = await connection.listSessions();
        const meta = pickSession(sessions, args.session);
        await connection.clear(meta.info.id, args.scope === 'state' ? 'state' : undefined);
        return args.scope === 'state'
          ? `Cleared the state changes recorded for ${sessionHeader(meta)}.`
          : `Cleared the logs, requests, WebSocket messages and state changes recorded for ${sessionHeader(meta)}.`;
      }),
  );

  server.registerTool(
    'remove_session',
    {
      title: 'Remove a session',
      description: 'Removes a disconnected session and what Capybara recorded for it from the list of apps.',
      inputSchema: { session: z.string().describe('Id of a disconnected session from list_sessions.') },
      annotations: changes,
    },
    (args) =>
      run(async () => {
        const { sessions } = await connection.listSessions();
        const meta = pickSession(sessions, args.session);
        if (meta.connected) {
          throw new Error(`${sessionHeader(meta)} is connected, and only disconnected sessions can be removed. clear_session clears what it recorded.`);
        }
        await connection.remove(meta.info.id);
        return `Removed ${sessionHeader(meta)}.`;
      }),
  );
}
