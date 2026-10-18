import {
  formatPath,
  isSpecial,
  libraryTitle,
  plainValue,
  STATE_LIBRARIES,
  stateChangeLabel,
  type EventOf,
  type SerializedValue,
  type StateChangePayload,
  type StateDiffOp,
  type StateEntrySummary,
  type StateLibrary,
  type StatePath,
  type StateStoreInfo,
} from '@capybara-devtools/protocol';

export { formatOp, formatPath, libraryTitle, stateChangeLabel as recordLabel, type OpText } from '@capybara-devtools/protocol';

export type StateEvent = EventOf<'state.store'> | EventOf<'state.change'> | EventOf<'state.entries'>;

/** One `state.change`: what an action (or a direct set) changed in a store. */
export interface StateRecord {
  seq: number;
  ts: number;
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
  stores: Record<string, StoreView>;
  /** Store ids by library, in the order they registered. */
  byLibrary: Record<string, string[]>;
}

export const MAX_RECORDS = 1_000;
/** The SDK sends at most 1000 queries plus 200 mutations per client. */
export const MAX_ENTRIES = 1_200;

export function emptyStateSlice(): StateSlice {
  return { stores: {}, byLibrary: {} };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Applies one `state.*` event and returns the new slice; `slice` itself is left as it was. Calls that share
 * `owned` copy each store and list once, then change their copies in place, so a batch stays linear.
 */
export function applyStateEvent(slice: StateSlice, event: StateEvent, owned: WeakSet<object> = new WeakSet()): StateSlice {
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
      const ops = Array.isArray(p.ops) ? p.ops : [];
      const missed = view.rev > 0 && p.rev > view.rev + 1 ? p.rev - view.rev - 1 : 0;
      const skipped = typeof p.skipped === 'number' && p.skipped > 0 ? p.skipped : 0;
      const records = editableRecords(view, owned);
      records.push({
        seq: event.seq,
        ts: event.ts,
        rev: p.rev,
        cause: p.cause,
        action: p.action,
        ops,
        opCount: Math.max(typeof p.opCount === 'number' ? p.opCount : 0, ops.length),
        skipped,
        missed,
      });
      if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
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
      for (const key of entries.keys()) {
        if (entries.size <= MAX_ENTRIES) break;
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

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

const LIBRARY_ORDER: readonly string[] = STATE_LIBRARIES;

export interface StoreGroup {
  /** Unique per group: React Context has a second group for the contexts of libraries. */
  key: string;
  library: string;
  title: string;
  stores: StoreView[];
}

export interface GroupOptions {
  /** List the React Contexts of libraries, such as react-redux's or React Navigation's. Default false. */
  libraryContexts?: boolean;
}

const nameOf = (info: StateStoreInfo) => `${info.library}\n${info.label}`;

/** The number in an id such as "zustand:3", which counts up as the app registers stores. */
function idNumber(id: string): number {
  const n = Number(id.slice(id.lastIndexOf(':') + 1));
  return Number.isFinite(n) ? n : -1;
}

/**
 * Stores by library, in a fixed library order, with the React Contexts of libraries in a group of their own when
 * asked for. A disposed store is left out once a live one has its name, and of live stores sharing a name only the
 * newest is listed: hot reload makes a store again under its name while the browser keeps the old module, and the
 * old instances would crowd the list. Not so for contexts, whose SDK keeps one store per name.
 */
export function groupStores(slice: StateSlice, options: GroupOptions = {}): StoreGroup[] {
  const live = new Set<string>();
  const newest = new Map<string, number>();
  for (const { info } of Object.values(slice.stores)) {
    if (info.disposed) continue;
    const name = nameOf(info);
    live.add(name);
    newest.set(name, Math.max(newest.get(name) ?? -Infinity, idNumber(info.id)));
  }
  const listed = ({ info }: StoreView) => {
    if (info.disposed) return !live.has(nameOf(info));
    return info.library === 'context' || idNumber(info.id) === newest.get(nameOf(info));
  };
  const libraries = [...LIBRARY_ORDER, ...Object.keys(slice.byLibrary).filter((library) => !LIBRARY_ORDER.includes(library))];
  const groups: StoreGroup[] = [];
  for (const library of libraries) {
    const stores = (slice.byLibrary[library] ?? []).map((id) => slice.stores[id]!).filter(listed);
    if (library !== 'context') {
      if (stores.length > 0) groups.push({ key: library, library, title: libraryTitle(library), stores });
      continue;
    }
    const own = stores.filter((view) => view.info.vendor === undefined);
    const vendors = stores.filter((view) => view.info.vendor !== undefined);
    if (own.length > 0) groups.push({ key: library, library, title: libraryTitle(library), stores: own });
    if (options.libraryContexts && vendors.length > 0) {
      groups.push({ key: `${library}:libraries`, library, title: 'Library contexts', stores: vendors });
    }
  }
  return groups;
}

/** The React Contexts of libraries that "Show library contexts" would list. */
export function libraryContextCount(slice: StateSlice): number {
  return groupStores(slice, { libraryContexts: true })
    .filter((group) => group.key === 'context:libraries')
    .reduce((sum, group) => sum + group.stores.length, 0);
}

/** The store picked last, remembered by name too, since ids only hold within one session. */
export interface StoreChoice {
  sessionId: string;
  id: string;
  library: string;
  label: string;
}

/**
 * The chosen store: by id in the same session while it is listed, else by library and label (a reloaded app, or a
 * hot reload that made the store again), the newest live one first; else the first store.
 */
export function pickStore(groups: StoreGroup[], choice: StoreChoice | null, sessionId: string): StoreView | undefined {
  const all = groups.flatMap((group) => group.stores);
  if (choice) {
    if (choice.sessionId === sessionId) {
      const same = all.find((view) => view.info.id === choice.id);
      if (same) return same;
    }
    const named = all.filter((view) => view.info.library === choice.library && view.info.label === choice.label);
    const pick = newestOf(named.filter((view) => !view.info.disposed)) ?? newestOf(named);
    if (pick) return pick;
  }
  return all[0];
}

function newestOf(views: StoreView[]): StoreView | undefined {
  let best: StoreView | undefined;
  for (const view of views) if (!best || idNumber(view.info.id) > idNumber(best.info.id)) best = view;
  return best;
}

/** TanStack Query and SWR stores list cache entries; the others show a timeline of changes. */
export function isEntryStore(view: StoreView): boolean {
  if (view.info.actions || view.records.length > 0) return false;
  return view.info.ops !== undefined || view.entries.size > 0;
}

export function storeCount(view: StoreView): number {
  return isEntryStore(view) ? view.entries.size : view.records.length;
}

/** For the tab badge: stores in the list, and entries in error across them. */
export function stateBadge(slice: StateSlice): { stores: number; errors: number } {
  let stores = 0;
  let errors = 0;
  for (const group of groupStores(slice)) {
    for (const view of group.stores) {
      stores++;
      errors += view.errors;
    }
  }
  return { stores, errors };
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

/** Compares paths whatever the type of their keys: the SDK and the tree may give an index as 1 or "1". */
export function pathKey(path: StatePath): string {
  return JSON.stringify(path.map(String));
}

/** Keys of every branch above the given path keys, so a tree can open down to them. */
export function ancestorKeys(keys: Iterable<string>): Set<string> {
  const ancestors = new Set<string>();
  for (const key of keys) {
    const path = JSON.parse(key) as string[];
    for (let length = 0; length < path.length; length++) ancestors.add(pathKey(path.slice(0, length)));
  }
  return ancestors;
}

/** A record's changes as JSON, for the clipboard. */
export function diffText(record: StateRecord): string {
  const ops = record.ops.map((op) => ({
    op: op.op,
    path: formatPath(op.path),
    ...(op.prev !== undefined && { prev: plainValue(op.prev) }),
    ...(op.value !== undefined && { value: plainValue(op.value) }),
  }));
  return JSON.stringify(ops, null, 2);
}

/** Paths a record changed that still exist, so the state tree can mark them; a removal marks its parent. */
export function changedPaths(record: StateRecord): Set<string> {
  const keys = new Set<string>();
  for (const op of record.ops) keys.add(pathKey(op.op === 'del' ? op.path.slice(0, -1) : op.path));
  return keys;
}

export interface OpGroup {
  key: string;
  path: StatePath;
  ops: StateDiffOp[];
  counts: Record<StateDiffOp['op'], number>;
}

/** Above this many ops a record's diff is shown folded by branch. */
export const GROUP_OPS_OVER = 20;
const MAX_GROUPS = 10;

/**
 * Folds a long diff by parent branch, or `null` when it is short enough to read flat. When the ops sit under
 * too many parents (e.g. one field of each item in a list), it folds a level higher, up to the root.
 */
export function groupOps(ops: StateDiffOp[]): OpGroup[] | null {
  if (ops.length <= GROUP_OPS_OVER) return null;
  const longest = Math.max(...ops.map((op) => op.path.length));
  for (let depth = longest - 1; ; depth--) {
    const groups = new Map<string, OpGroup>();
    for (const op of ops) {
      const path = op.path.slice(0, Math.max(0, Math.min(depth, op.path.length - 1)));
      const key = pathKey(path);
      let group = groups.get(key);
      if (!group) groups.set(key, (group = { key, path, ops: [], counts: { add: 0, set: 0, del: 0 } }));
      group.ops.push(op);
      group.counts[op.op]++;
    }
    if (groups.size <= MAX_GROUPS || depth <= 0) return [...groups.values()];
  }
}

// Records never change once made, so the filter text is built once per record.
const recordTexts = new WeakMap<StateRecord, string>();

/** What the timeline filter matches: the action, then each changed path. */
export function recordText(record: StateRecord): string {
  let text = recordTexts.get(record);
  if (text === undefined) {
    text = [stateChangeLabel(record).text, ...record.ops.map((op) => formatPath(op.path))].join('\n');
    recordTexts.set(record, text);
  }
  return text;
}

/** `root` with the value at `path` swapped for `value`, e.g. a node the SDK cut to fit for the value read there. */
export function graftValue(root: SerializedValue, path: StatePath, value: SerializedValue): SerializedValue {
  if (path.length === 0) return value;
  if (root === null || typeof root !== 'object') return root;
  const [head, ...rest] = path as [string | number, ...StatePath];
  const at = <T extends SerializedValue>(list: T[], index: number, wrap: (copy: T[]) => SerializedValue) => {
    if (!Number.isInteger(index) || index < 0 || index >= list.length) return root;
    const copy = list.slice();
    copy[index] = graftValue(list[index]!, rest, value) as T;
    return wrap(copy);
  };
  if (Array.isArray(root)) return at(root, Number(head), (copy) => copy);
  if (isSpecial(root)) {
    switch (root.$t) {
      case 'array':
        return at(root.items, Number(head), (items) => ({ ...root, items }));
      case 'set':
        return at(root.values, Number(head), (values) => ({ ...root, values }));
      case 'object': {
        const key = String(head);
        if (!(key in root.props)) return root;
        return { ...root, props: { ...root.props, [key]: graftValue(root.props[key]!, rest, value) } };
      }
      case 'map': {
        const index = root.entries.findIndex(([key]) => key === head);
        if (index < 0) return root;
        const entries = root.entries.slice();
        entries[index] = [entries[index]![0], graftValue(entries[index]![1], rest, value)];
        return { ...root, entries };
      }
      default:
        return root;
    }
  }
  const record = root as Record<string, SerializedValue>;
  const key = String(head);
  if (!(key in record)) return root;
  return { ...record, [key]: graftValue(record[key]!, rest, value) };
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

export type Tone = 'ok' | 'info' | 'warn' | 'error' | 'muted';

export interface Pill {
  text: string;
  tone: Tone;
}

const STATUS_TONES: Partial<Record<string, Tone>> = { success: 'ok', pending: 'info' };

/** Status chips for an entry: what it is doing now, then for data it has, whether it is still fresh. */
export function entryPills(entry: StateEntrySummary): Pill[] {
  const mutation = entry.kind === 'mutation';
  const pills: Pill[] = [];
  if (entry.fetching) pills.push({ text: 'fetching', tone: 'info' });
  else if (entry.paused) pills.push({ text: 'paused', tone: 'warn' });
  else if (entry.status === 'error') pills.push({ text: errorLabel(entry.error), tone: 'error' });
  else if (entry.disabled) pills.push({ text: 'disabled', tone: 'muted' });
  else if (entry.active === false && !mutation) pills.push({ text: 'inactive', tone: 'muted' });
  else pills.push({ text: entry.status, tone: STATUS_TONES[entry.status] ?? 'muted' });
  const freshness = entry.fetching ? undefined : entryFreshness(entry);
  if (freshness) pills.push({ text: freshness, tone: freshness === 'fresh' ? 'muted' : 'warn' });
  return pills;
}

/** Most query errors come from HTTP calls, so their status code says the most in little room. */
function errorLabel(error: string | undefined): string {
  const status = /\b([45]\d\d)\b/.exec(error ?? '')?.[1];
  return status ? `error ${status}` : 'error';
}

/**
 * Whether the data is fresh, stale or invalidated; only for data fetched successfully. TanStack Query marks a query
 * invalidated on every failed fetch too, which says nothing about its freshness.
 */
export function entryFreshness(entry: StateEntrySummary): 'fresh' | 'stale' | 'invalidated' | undefined {
  if (entry.kind === 'mutation' || entry.status !== 'success') return undefined;
  if (entry.invalidated) return 'invalidated';
  if (entry.stale) return 'stale';
  return entry.stale === false ? 'fresh' : undefined;
}

export type EntryFilter = 'all' | 'fetching' | 'stale' | 'error' | 'inactive';

const ENTRY_FILTERS: readonly EntryFilter[] = ['all', 'fetching', 'stale', 'error', 'inactive'];

/** The filters worth offering: SWR keeps no staleness, and only TanStack Query knows whether a query is in use. */
export function entryFilters(entries: StateEntrySummary[]): EntryFilter[] {
  return ENTRY_FILTERS.filter((filter) => {
    if (filter === 'stale') return entries.some((entry) => entry.stale !== undefined || entryMatches(entry, 'stale'));
    if (filter === 'inactive') return entries.some((entry) => entry.active !== undefined);
    return true;
  });
}

export function entryMatches(entry: StateEntrySummary, filter: EntryFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'fetching':
      return entry.fetching;
    case 'stale':
      return entryFreshness(entry) === 'stale' || entryFreshness(entry) === 'invalidated';
    case 'error':
      return entry.status === 'error';
    case 'inactive':
      return entry.kind !== 'mutation' && entry.active === false;
  }
}
