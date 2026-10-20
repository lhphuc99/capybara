import type { EventOf, StateChangePayload, StateDiffOp, StateEntrySummary, StateLibrary, StateStoreInfo } from './index.js';

// What a session's `state.*` events add up to, as the UI shows it and `capybara mcp` reports it.

export type StateEvent = EventOf<'state.store'> | EventOf<'state.change'> | EventOf<'state.entries'>;

/** One `state.change`: what an action (or a direct set) changed in a store. */
export interface StateRecord {
  seq: number;
  ts: number;
  store: string;
  rev: number;
  cause: StateChangePayload['cause'];
  action?: StateChangePayload['action'];
  ops: StateDiffOp[];
  /** Changes in the record, counting those cut from `ops`. */
  opCount: number;
  /** Changes folded into this one by the SDK's rate limit, or while the app was offline. */
  skipped: number;
  /** Records lost just before this one, seen as a jump in `rev`. */
  missed: number;
}

export interface StoreView {
  info: StateStoreInfo;
  /** Highest `rev` seen; 0 before any change. */
  rev: number;
  /** Oldest first. */
  records: StateRecord[];
  /** TanStack Query and SWR entries by key, in the order first seen, so rows keep their place as they update. */
  entries: Map<string, StateEntrySummary>;
  /** Entries whose status is `error`. */
  errors: number;
  /**
   * `seq` of the newest record that came after skipped or missed changes. A reader that saw an older value
   * reads the state again at once instead of waiting for the next quiet moment.
   */
  lastSkipped: number;
  /** Counts `reset` patches. A reset can carry only some entries, so the panel lists them all again. */
  resets: number;
}

export interface StateSlice {
  /** By id, in the order they first appear. */
  stores: Record<string, StoreView>;
  /** Store ids by library, in the order they registered. */
  byLibrary: Record<string, string[]>;
}

/** Records kept per store and entries per cache, oldest dropped first. */
export interface StateLimits {
  records?: number;
  entries?: number;
}

export const MAX_RECORDS = 1_000;
/** The SDK sends at most 1000 queries plus 200 mutations per client. */
export const MAX_ENTRIES = 1_200;

export function emptyStateSlice(): StateSlice {
  return { stores: {}, byLibrary: {} };
}

/**
 * Applies one `state.*` event and returns the new slice; `slice` itself is left as it was. Calls that share
 * `owned` copy each store and list once, then change their copies in place, so a batch stays linear.
 */
export function applyStateEvent(
  slice: StateSlice,
  event: StateEvent,
  owned: WeakSet<object> = new WeakSet(),
  limits: StateLimits = {},
): StateSlice {
  switch (event.kind) {
    case 'state.store': {
      const info = event.payload?.store;
      if (typeof info?.id !== 'string') return slice;
      const draft = editable(slice, owned);
      const current = draft.stores[info.id];
      if (!current) {
        addStore(draft, info, owned);
      } else {
        if (current.info.library !== info.library) moveStore(draft, info.id, current.info.library, info.library);
        editableStore(draft, info.id, owned).info = info;
      }
      return draft;
    }
    case 'state.change': {
      const p = event.payload;
      if (typeof p?.store !== 'string' || typeof p.rev !== 'number') return slice;
      const draft = editable(slice, owned);
      if (!draft.stores[p.store]) addStore(draft, standIn(p.store, Boolean(p.action)), owned);
      const view = editableStore(draft, p.store, owned);
      const ops = Array.isArray(p.ops) ? p.ops.filter((op) => Array.isArray(op?.path)) : [];
      const missed = view.rev > 0 && p.rev > view.rev + 1 ? p.rev - view.rev - 1 : 0;
      const skipped = typeof p.skipped === 'number' && p.skipped > 0 ? p.skipped : 0;
      const records = editableRecords(view, owned);
      records.push({
        seq: event.seq,
        ts: event.ts,
        store: p.store,
        rev: p.rev,
        cause: p.cause,
        action: p.action,
        ops,
        opCount: Math.max(typeof p.opCount === 'number' ? p.opCount : 0, ops.length),
        skipped,
        missed,
      });
      const max = limits.records ?? MAX_RECORDS;
      if (records.length > max) records.splice(0, records.length - max);
      // A lower rev means the app started counting again (a new engine), not that changes were lost.
      view.rev = p.rev;
      if (skipped > 0 || missed > 0) view.lastSkipped = event.seq;
      return draft;
    }
    case 'state.entries': {
      const p = event.payload;
      if (typeof p?.store !== 'string') return slice;
      const draft = editable(slice, owned);
      if (!draft.stores[p.store]) addStore(draft, standIn(p.store, false), owned);
      const view = editableStore(draft, p.store, owned);
      const entries = editableEntries(view, owned);
      let errors = view.errors;
      const drop = (key: string) => {
        if (entries.get(key)?.status === 'error') errors--;
        entries.delete(key);
      };
      if (p.reset) {
        entries.clear();
        errors = 0;
        view.resets++;
      }
      for (const key of p.removed ?? []) drop(key);
      for (const summary of p.upserts ?? []) {
        if (typeof summary?.key !== 'string') continue;
        if (entries.get(summary.key)?.status === 'error') errors--;
        if (summary.status === 'error') errors++;
        entries.set(summary.key, summary);
      }
      const max = limits.entries ?? MAX_ENTRIES;
      for (const key of entries.keys()) {
        if (entries.size <= max) break;
        drop(key);
      }
      view.errors = errors;
      return draft;
    }
  }
}

/** After `clear`: stores and their entries stay, since the app still has them; only the timelines empty. */
export function clearStateRecords(slice: StateSlice): StateSlice {
  const stores: Record<string, StoreView> = {};
  for (const [id, view] of Object.entries(slice.stores)) stores[id] = view.records.length > 0 ? { ...view, records: [] } : view;
  return { ...slice, stores };
}

/**
 * The stores to list: a disposed store is left out once a live one has its name, and of live stores sharing a name
 * only the newest. Hot reload makes a store again under its name while the browser keeps the old module, and the old
 * instances would crowd the list. Not so for contexts, whose SDK keeps one store per name.
 */
export function currentStores<T extends { info: StateStoreInfo }>(stores: readonly T[]): T[] {
  const live = new Set<string>();
  const newest = new Map<string, number>();
  for (const { info } of stores) {
    if (info.disposed) continue;
    const name = storeName(info);
    live.add(name);
    newest.set(name, Math.max(newest.get(name) ?? -Infinity, idNumber(info.id)));
  }
  return stores.filter(({ info }) => {
    if (info.disposed) return !live.has(storeName(info));
    return info.library === 'context' || idNumber(info.id) === newest.get(storeName(info));
  });
}

const storeName = (info: StateStoreInfo) => `${info.library}\n${info.label}`;

/** The number in an id such as "zustand:3", which counts up as the app registers stores. */
export function idNumber(id: string): number {
  const n = Number(id.slice(id.lastIndexOf(':') + 1));
  return Number.isFinite(n) ? n : -1;
}

function editable(slice: StateSlice, owned: WeakSet<object>): StateSlice {
  if (owned.has(slice)) return slice;
  const copy = { ...slice, stores: { ...slice.stores } };
  owned.add(copy);
  return copy;
}

function editableStore(draft: StateSlice, id: string, owned: WeakSet<object>): StoreView {
  const view = draft.stores[id]!;
  if (owned.has(view)) return view;
  const copy = { ...view };
  owned.add(copy);
  draft.stores[id] = copy;
  return copy;
}

function editableRecords(view: StoreView, owned: WeakSet<object>): StateRecord[] {
  if (!owned.has(view.records)) {
    view.records = view.records.slice();
    owned.add(view.records);
  }
  return view.records;
}

function editableEntries(view: StoreView, owned: WeakSet<object>): Map<string, StateEntrySummary> {
  if (!owned.has(view.entries)) {
    view.entries = new Map(view.entries);
    owned.add(view.entries);
  }
  return view.entries;
}

function addStore(draft: StateSlice, info: StateStoreInfo, owned: WeakSet<object>): void {
  const view: StoreView = { info, rev: 0, records: [], entries: new Map(), errors: 0, lastSkipped: 0, resets: 0 };
  owned.add(view).add(view.records).add(view.entries);
  draft.stores[info.id] = view;
  draft.byLibrary = { ...draft.byLibrary, [info.library]: [...(draft.byLibrary[info.library] ?? []), info.id] };
}

function moveStore(draft: StateSlice, id: string, from: string, to: string): void {
  draft.byLibrary = {
    ...draft.byLibrary,
    [from]: (draft.byLibrary[from] ?? []).filter((other) => other !== id),
    [to]: [...(draft.byLibrary[to] ?? []), id],
  };
}

/**
 * Changes can name a store whose registration the history no longer has, e.g. after the server restarted
 * while the app kept running. They are kept under a stand-in until the `stores` command says what it is.
 */
function standIn(id: string, actions: boolean): StateStoreInfo {
  return { id, library: id.split(':')[0] as StateLibrary, label: id, via: 'subscribe', actions };
}
