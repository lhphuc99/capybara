import type {
  EventPayloads,
  SerializedValue,
  StateChangePayload,
  StateCommands,
  StateDiffOp,
  StateEntryOp,
  StateEntrySummary,
  StatePath,
  StateStoreInfo,
} from '@capybara-devtools/protocol';
import type { SerializeOptions } from '../../serialize.js';
import type { StateSink, StoreDriver } from './index.js';

// Every function in this file is self-contained: the Metro bridge runs them from their source inside
// apps without the SDK, so they use nothing from module scope and get their helpers as parameters.

export type StateEventKind = 'state.store' | 'state.change' | 'state.entries';
/** `ts` is when the change happened; records go out in batches, later. */
export type StateEmit = <K extends StateEventKind>(kind: K, payload: EventPayloads[K], ts?: number) => void;
export type SerializeFn = (value: unknown, options?: SerializeOptions) => SerializedValue;

export interface StateEngineOptions {
  /** Whether events reach a server now. While false, changes are only counted, then sent as one catch-up record. */
  connected(): boolean;
  /** Records past this many per second for one store are folded into the next one. Default 30. */
  maxActionsPerSecond?: number;
  /** Action types kept off the timeline; a string matches the whole type. Their changes show in the next record. */
  actionsDenylist?: Array<string | { source: string; flags: string }>;
  /** Runs before a state is diffed or read; only what it returns leaves the app. */
  sanitizeState?(state: unknown, store: StateStoreInfo): unknown;
  sanitizeAction?(action: unknown, store: StateStoreInfo): unknown;
  /** Runs before the data of an entry is read; only what it returns leaves the app. */
  sanitizeEntry?(data: unknown, entry: { store: StateStoreInfo; key: string }): unknown;
  /** Leave out keys that hold functions, such as Zustand actions. Default true. */
  hideFunctions?: boolean;
}

export interface DiffLimits {
  /** Ops kept; the rest are only counted. */
  maxOps: number;
  maxDepth: number;
  /** Objects and arrays compared per call. */
  maxNodes: number;
  /** Profile for each op's `value` and `prev`. */
  preview: SerializeOptions;
  /** Count keys that hold functions as absent. */
  hideFunctions?: boolean;
}

export interface StateEngine extends StateSink {
  /** Announces the store, takes its state as the base for the first diff, and starts its driver. */
  track(id: string, driver: StoreDriver): void;
  /** Stops the store's driver and announces it disposed. */
  untrack(id: string, note?: string): void;
  stores(): StateStoreInfo[];
  read(id: string, path?: StatePath): StateCommands['get']['result'];
  entries(id: string): StateCommands['entries']['result'];
  entry(id: string, key: string, path?: StatePath): StateCommands['entry']['result'];
  act(id: string, key: string, op: StateEntryOp): Promise<StateCommands['act']['result']>;
  /** Stops every driver and the timer. */
  dispose(): void;
}

export type DiffStateFn = typeof diffState;
export type ReadPathFn = typeof readPath;

/**
 * Diffs two states by reference: an unchanged reference skips its whole branch, so the cost follows what
 * changed. Only plain objects and arrays are walked, arrays by index; anything else is a leaf.
 */
export function diffState(
  prev: unknown,
  next: unknown,
  limits: DiffLimits,
  serialize: SerializeFn,
): { ops: StateDiffOp[]; opCount: number } {
  const ABSENT = {};
  let ops: StateDiffOp[] = [];
  let opCount = 0;
  let nodes = 0;

  const same = (a: unknown, b: unknown) => a === b || (a !== a && b !== b);
  // Prototype checks rather than instanceof, so objects from another realm still count as plain.
  const plain = (v: unknown): boolean => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === null || Object.getPrototypeOf(proto) === null;
  };
  const has = (obj: object, key: string) => Object.prototype.propertyIsEnumerable.call(obj, key);
  const read = (obj: object, key: string): unknown => {
    try {
      const value = (obj as Record<string, unknown>)[key];
      return limits.hideFunctions && typeof value === 'function' ? ABSENT : value;
    } catch {
      return ABSENT;
    }
  };

  const push = (op: StateDiffOp['op'], path: StatePath, key: string | number | null, before: unknown, after: unknown) => {
    opCount++;
    if (ops.length >= limits.maxOps) return;
    const out: StateDiffOp = { op, path: key === null ? path : [...path, key] };
    if (op !== 'del') out.value = serialize(after, limits.preview);
    if (op !== 'add') out.prev = serialize(before, limits.preview);
    ops.push(out);
  };

  const walk = (a: unknown, b: unknown, path: StatePath, depth: number): void => {
    const arrays = Array.isArray(a) && Array.isArray(b);
    if ((!arrays && !(plain(a) && plain(b))) || depth >= limits.maxDepth || nodes >= limits.maxNodes) {
      push('set', path, null, a, b);
      return;
    }
    nodes++;
    if (arrays) {
      const before = a as unknown[];
      const after = b as unknown[];
      const shared = Math.min(before.length, after.length);
      for (let i = 0; i < shared; i++) {
        if (!same(before[i], after[i])) walk(before[i], after[i], [...path, i], depth + 1);
      }
      for (let i = shared; i < after.length; i++) push('add', path, i, undefined, after[i]);
      for (let i = shared; i < before.length; i++) push('del', path, i, before[i], undefined);
      return;
    }
    const before = a as object;
    const after = b as object;
    for (const key of Object.keys(after)) {
      const y = read(after, key);
      if (y === ABSENT) continue;
      const x = has(before, key) ? read(before, key) : ABSENT;
      if (x === ABSENT) push('add', path, key, undefined, y);
      else if (!same(x, y)) walk(x, y, [...path, key], depth + 1);
    }
    for (const key of Object.keys(before)) {
      if (has(after, key) && read(after, key) !== ABSENT) continue;
      const x = read(before, key);
      if (x !== ABSENT) push('del', path, key, x, undefined);
    }
  };

  if (!same(prev, next)) {
    try {
      walk(prev, next, [], 0);
    } catch {
      // A proxy or exotic object threw midway; report the whole state as replaced instead.
      ops = [];
      opCount = 0;
      push('set', [], null, prev, next);
    }
  }
  return { ops, opCount };
}

/**
 * Follows `path` from `root`: keys into objects and arrays, keys into Maps, positions into Sets.
 * `found` is false when some step does not exist, as opposed to a value that is `undefined`.
 */
export function readPath(root: unknown, path: StatePath): { found: boolean; value: unknown } {
  let current = root;
  for (const key of path) {
    if (current === null || (typeof current !== 'object' && typeof current !== 'function')) {
      return { found: false, value: undefined };
    }
    try {
      if (current instanceof Map) {
        let mapKey: unknown = key;
        let hit = current.has(key);
        // Paths come through JSON, so a numeric Map key may arrive as a string and the other way round.
        for (const k of hit ? [] : current.keys()) {
          if (String(k) === String(key)) {
            mapKey = k;
            hit = true;
            break;
          }
        }
        if (!hit) return { found: false, value: undefined };
        current = current.get(mapKey);
      } else if (current instanceof Set || Array.isArray(current)) {
        const index = Number(key);
        const size = Array.isArray(current) ? current.length : current.size;
        if (!Number.isInteger(index) || index < 0 || index >= size) return { found: false, value: undefined };
        current = Array.isArray(current) ? current[index] : [...current][index];
      } else {
        if (!Object.prototype.hasOwnProperty.call(current, key)) return { found: false, value: undefined };
        current = (current as Record<string | number, unknown>)[key];
      }
    } catch {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: current };
}

/**
 * Turns what drivers report into `state.*` events and answers reads. Listeners only queue a reference or
 * mark a key; diffing, serializing and emitting wait for a timer, and happen only while connected.
 */
export function createStateEngine(
  emit: StateEmit,
  options: StateEngineOptions,
  serialize: SerializeFn,
  diffState: DiffStateFn,
  readPath: ReadPathFn,
): StateEngine {
  const RECORD_DELAY = 100;
  const ENTRY_DELAY = 200;
  const LOW_ENTRY_DELAY = 1_000;
  /** Plugins hear nothing when the connection comes back, so waiting changes look for it this often. */
  const OFFLINE_POLL = 1_000;
  /** References kept per store between flushes; past it the newest replaces the last one. */
  const QUEUE_LIMIT = 200;
  /** Summaries one store remembers or lists: room for TanStack Query's 1000 queries and 200 mutations. */
  const ENTRY_LIMIT = 1_200;
  /** Summaries per `state.entries` event; after a reset the `entries` command lists the rest. */
  const ENTRIES_PER_EVENT = 200;
  /** MAX_BODY_SIZE, the cap of network bodies, written out since the Metro bridge runs this function on its own. */
  const MAX_READ = 128 * 1024;
  const PREVIEW: SerializeOptions = { maxDepth: 3, maxKeys: 20, maxItems: 20, maxString: 200, maxNodes: 200 };
  // Tried in order until a read fits in MAX_READ.
  const READS: SerializeOptions[] = [
    { maxDepth: 8, maxKeys: 500, maxItems: 500, maxString: 10_000, maxNodes: 20_000 },
    { maxDepth: 5, maxKeys: 200, maxItems: 200, maxString: 2_000, maxNodes: 5_000 },
    { maxDepth: 3, maxKeys: 100, maxItems: 100, maxString: 500, maxNodes: 1_000 },
    { maxDepth: 1, maxKeys: 50, maxItems: 50, maxString: 200, maxNodes: 100 },
  ];
  const hideFunctions = options.hideFunctions !== false;
  const LIMITS: DiffLimits = { maxOps: 100, maxDepth: 12, maxNodes: 5_000, preview: PREVIEW, hideFunctions };
  const perSecond = Math.max(1, Math.floor(options.maxActionsPerSecond ?? 30));
  const denylist = (options.actionsDenylist ?? []).map((pattern) =>
    typeof pattern === 'string' ? pattern : new RegExp(pattern.source, pattern.flags),
  );

  interface Change {
    state: unknown;
    action: unknown;
    cause: StateChangePayload['cause'];
    /** Changes folded into this one. */
    skipped: number;
    ts: number;
  }
  interface Tracked {
    info: StateStoreInfo;
    driver: { deref(): StoreDriver | undefined };
    rev: number;
    /** State of the last record, or from when tracking began. Diffs start from `base`, its sanitized form. */
    raw: unknown;
    base: unknown;
    based: boolean;
    queue: Change[];
    /** Skipped counts of denylisted changes, passed on to the next record. */
    carry: number;
    windowStart: number;
    windowCount: number;
    dirty: Set<string>;
    removed: Set<string>;
    /** JSON of the last summary sent per key, so an unchanged entry is not sent again. */
    sent: Map<string, string>;
    reset: boolean;
    entriesDue: number;
  }

  const stores = new Map<string, Tracked>();
  // Keyed by driver, so a stop function, which may hold on to the store, never outlives it.
  const stops = new WeakMap<StoreDriver, () => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerAt = Infinity;
  let offline = false;
  let disposed = false;

  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  // Weak, so the engine never keeps a store alive; whoever registered the driver decides that.
  const hold = (driver: StoreDriver): Tracked['driver'] =>
    typeof WeakRef === 'function' ? new WeakRef(driver) : { deref: () => driver };

  const dropFunctions = (value: SerializedValue): SerializedValue => {
    const visit = (v: SerializedValue): void => {
      if (v === null || typeof v !== 'object') return;
      if (Array.isArray(v)) {
        for (const item of v) visit(item);
        return;
      }
      const node = v as Record<string, any>;
      switch (node.$t) {
        case undefined:
          strip(node);
          break;
        case 'object':
        case 'error':
          if (node.props) strip(node.props);
          break;
        case 'array':
          for (const item of node.items) visit(item);
          break;
        case 'map':
          for (const pair of node.entries) visit(pair[1]);
          break;
        case 'set':
          for (const item of node.values) visit(item);
          break;
      }
    };
    const strip = (props: Record<string, SerializedValue>) => {
      for (const key of Object.keys(props)) {
        const child = props[key] as { $t?: unknown } | null;
        if (child !== null && typeof child === 'object' && child.$t === 'function') delete props[key];
        else visit(props[key]!);
      }
    };
    visit(value);
    return value;
  };
  const shown: SerializeFn = (value, profile) => {
    const out = serialize(value, profile);
    return hideFunctions ? dropFunctions(out) : out;
  };

  const clean = (t: Tracked, state: unknown): unknown => {
    if (!options.sanitizeState) return state;
    try {
      return options.sanitizeState(state, t.info);
    } catch (error) {
      // Never fall back to the state the sanitizer was meant to filter.
      return `[sanitizeState threw: ${message(error)}]`;
    }
  };
  const cleanEntry = (t: Tracked, key: string, data: unknown): unknown => {
    if (!options.sanitizeEntry) return data;
    try {
      return options.sanitizeEntry(data, { store: t.info, key });
    } catch (error) {
      return `[sanitizeEntry threw: ${message(error)}]`;
    }
  };
  const actionType = (action: unknown): string => {
    if (typeof action === 'string') return action;
    try {
      const type = (action as { type?: unknown } | null)?.type;
      return typeof type === 'string' ? type : type === undefined ? 'anonymous' : String(type);
    } catch {
      return 'anonymous';
    }
  };
  const hidden = (action: unknown): boolean => {
    if (denylist.length === 0 || action === undefined) return false;
    const type = actionType(action);
    return denylist.some((pattern) => {
      if (typeof pattern === 'string') return pattern === type;
      pattern.lastIndex = 0;
      return pattern.test(type);
    });
  };
  /** The type, and a preview of the rest of the action (payload, meta, error). */
  const describeAction = (t: Tracked, action: unknown): NonNullable<StateChangePayload['action']> => {
    let sanitized = action;
    if (options.sanitizeAction) {
      try {
        sanitized = options.sanitizeAction(action, t.info);
      } catch {
        return { type: actionType(action) };
      }
    }
    const type = actionType(sanitized);
    if (sanitized === null || typeof sanitized !== 'object') return { type };
    const rest: Record<string, unknown> = {};
    let any = false;
    try {
      for (const key of Object.keys(sanitized)) {
        if (key === 'type') continue;
        rest[key] = (sanitized as Record<string, unknown>)[key];
        any = true;
      }
    } catch {
      return { type };
    }
    return any ? { type, payload: shown(rest, PREVIEW) } : { type };
  };

  const wake = (delay: number) => {
    if (disposed) return;
    const wait = Math.max(0, delay);
    const at = Date.now() + wait;
    if (timer !== null) {
      if (timerAt <= at) return;
      clearTimeout(timer);
    }
    timerAt = at;
    timer = setTimeout(flush, wait);
  };

  const record: StateSink['record'] = (id, state, action, cause) => {
    try {
      const t = stores.get(id);
      if (!t) return;
      const change: Change = { state, action, cause: cause ?? (action === undefined ? 'set' : 'action'), skipped: 0, ts: Date.now() };
      const queue = t.queue;
      if (queue.length < QUEUE_LIMIT) {
        queue.push(change);
      } else {
        change.skipped = queue[queue.length - 1]!.skipped + 1;
        queue[queue.length - 1] = change;
      }
      wake(offline ? OFFLINE_POLL : RECORD_DELAY);
    } catch {
      // never throw into the app's store
    }
  };
  // Bounded: past the cap, start over with a reset rather than remember more keys.
  const resync = (t: Tracked) => {
    t.dirty.clear();
    t.removed.clear();
    t.sent.clear();
    t.reset = true;
  };
  const entriesSoon = (t: Tracked, delay: number) => {
    const at = Date.now() + delay;
    if (at < t.entriesDue) t.entriesDue = at;
    wake(offline ? OFFLINE_POLL : t.entriesDue - Date.now());
  };
  const dirty: StateSink['dirty'] = (id, key, low) => {
    try {
      const t = stores.get(id);
      if (!t) return;
      t.removed.delete(key);
      t.dirty.add(key);
      if (t.dirty.size > ENTRY_LIMIT) resync(t);
      entriesSoon(t, low ? LOW_ENTRY_DELAY : ENTRY_DELAY);
    } catch {
      // never throw into the app's cache
    }
  };
  const removed: StateSink['removed'] = (id, key) => {
    try {
      const t = stores.get(id);
      if (!t) return;
      t.dirty.delete(key);
      t.removed.add(key);
      if (t.removed.size > ENTRY_LIMIT) resync(t);
      entriesSoon(t, ENTRY_DELAY);
    } catch {
      // never throw into the app's cache
    }
  };

  /** Drops denylisted changes; what they changed goes out with the next record, diffed from the last one sent. */
  const visible = (t: Tracked): Change[] => {
    if (denylist.length === 0) return t.queue;
    const out: Change[] = [];
    for (const change of t.queue) {
      if (hidden(change.action)) {
        t.carry += change.skipped;
        continue;
      }
      change.skipped += t.carry;
      t.carry = 0;
      out.push(change);
    }
    return out;
  };
  const fold = (changes: Change[]): Change[] => {
    if (changes.length <= 1) return changes;
    const last = changes[changes.length - 1]!;
    for (let i = 0; i < changes.length - 1; i++) last.skipped += changes[i]!.skipped + 1;
    return [last];
  };
  const send = (t: Tracked, change: Change) => {
    const next = clean(t, change.state);
    const { ops, opCount }: { ops: StateDiffOp[]; opCount: number } = t.based
      ? diffState(t.base, next, LIMITS, shown)
      : { ops: [{ op: 'set', path: [], value: shown(next, PREVIEW) }], opCount: 1 };
    t.raw = change.state;
    t.base = next;
    t.based = true;
    if (ops.length === 0 && change.action === undefined && change.skipped === 0 && change.cause !== 'init') return;
    const payload: StateChangePayload = { store: t.info.id, rev: ++t.rev, cause: change.cause, ops };
    if (change.action !== undefined) payload.action = describeAction(t, change.action);
    if (opCount > ops.length) payload.opCount = opCount;
    if (change.skipped > 0) payload.skipped = change.skipped;
    t.windowCount++;
    emit('state.change', payload, change.ts);
  };
  const flushChanges = (t: Tracked, live: boolean, now: number) => {
    if (t.queue.length === 0) return;
    const queue = visible(t);
    // Offline, nothing is diffed: changes only pile up as a count on the newest one.
    if (!live) {
      t.queue = fold(queue);
      return;
    }
    if (now - t.windowStart >= 1_000) {
      t.windowStart = now;
      t.windowCount = 0;
    }
    const room = perSecond - t.windowCount;
    if (room <= 0) {
      t.queue = fold(queue);
      return;
    }
    t.queue = [];
    // The last record of the window carries everything past the limit, so the newest state still goes out.
    const batch = queue.length > room ? [...queue.slice(0, room - 1), ...fold(queue.slice(room - 1))] : queue;
    for (const change of batch) send(t, change);
  };

  const summarize = (driver: StoreDriver, key: string): StateEntrySummary | undefined => {
    try {
      const summary = driver.summarize?.(key);
      return summary && typeof summary === 'object' ? summary : undefined;
    } catch {
      return undefined;
    }
  };
  const flushEntries = (t: Tracked, live: boolean, now: number) => {
    if (!live || now < t.entriesDue) return;
    t.entriesDue = Infinity;
    const driver = t.driver.deref();
    const store = t.info.id;
    if (!driver || typeof driver.keys !== 'function') {
      t.dirty.clear();
      t.removed.clear();
      t.reset = false;
      return;
    }
    if (t.reset) {
      const upserts: StateEntrySummary[] = [];
      const sent = new Map<string, string>();
      for (const key of driver.keys()) {
        if (upserts.length >= ENTRIES_PER_EVENT) break;
        const summary = summarize(driver, key);
        if (!summary) continue;
        upserts.push(summary);
        sent.set(key, JSON.stringify(summary));
      }
      t.reset = false;
      t.dirty.clear();
      t.removed.clear();
      t.sent = sent;
      emit('state.entries', { store, upserts, removed: [], reset: true });
      return;
    }
    const upserts: StateEntrySummary[] = [];
    const gone = [...t.removed];
    for (const key of gone) t.sent.delete(key);
    for (const key of t.dirty) {
      const summary = summarize(driver, key);
      if (!summary) {
        if (t.sent.delete(key)) gone.push(key);
        continue;
      }
      const json = JSON.stringify(summary);
      if (t.sent.get(key) === json) continue;
      // Re-inserted, so the key sent longest ago is the one forgotten when the map is full.
      t.sent.delete(key);
      t.sent.set(key, json);
      if (t.sent.size > ENTRY_LIMIT) t.sent.delete(t.sent.keys().next().value!);
      upserts.push(summary);
    }
    t.dirty.clear();
    t.removed.clear();
    for (let i = 0; i < upserts.length || (i === 0 && gone.length > 0); i += ENTRIES_PER_EVENT) {
      emit('state.entries', { store, upserts: upserts.slice(i, i + ENTRIES_PER_EVENT), removed: i === 0 ? gone : [] });
    }
  };

  const flush = () => {
    timer = null;
    timerAt = Infinity;
    if (disposed) return;
    let live = false;
    try {
      live = options.connected() === true;
    } catch {
      // counts as offline
    }
    offline = !live;
    const now = Date.now();
    let next = Infinity;
    for (const t of [...stores.values()]) {
      try {
        flushChanges(t, live, now);
      } catch {
        t.queue = [];
      }
      try {
        flushEntries(t, live, now);
      } catch {
        t.dirty.clear();
        t.removed.clear();
      }
      if (t.queue.length > 0) next = Math.min(next, live ? t.windowStart + 1_000 : now + OFFLINE_POLL);
      if (t.dirty.size > 0 || t.removed.size > 0 || t.reset) next = Math.min(next, live ? t.entriesDue : now + OFFLINE_POLL);
    }
    if (next < Infinity) wake(next - now);
  };

  const need = (id: unknown): { t: Tracked; driver: StoreDriver } => {
    const t = typeof id === 'string' ? stores.get(id) : undefined;
    if (!t) throw new Error(`Unknown store "${String(id)}"`);
    const driver = t.driver.deref();
    if (!driver) {
      untrack(t.info.id);
      throw new Error(`${t.info.label} is no longer in the app`);
    }
    return { t, driver };
  };
  const at = (root: unknown, path: unknown): unknown => {
    const keys = Array.isArray(path) ? (path as StatePath) : [];
    const found = readPath(root, keys);
    if (!found.found) throw new Error(`Nothing at ${JSON.stringify(keys)}`);
    return found.value;
  };
  const fit = (value: unknown): { value: SerializedValue; truncated: boolean } => {
    for (let i = 0; i < READS.length; i++) {
      const out = shown(value, READS[i]);
      if (JSON.stringify(out).length <= MAX_READ) return { value: out, truncated: i > 0 };
    }
    return { value: { $t: 'limit', name: Array.isArray(value) ? `Array(${value.length})` : 'Object' }, truncated: true };
  };

  const read: StateEngine['read'] = (id, path) => {
    const { t, driver } = need(id);
    if (typeof driver.getState !== 'function') {
      throw new Error(`${t.info.label} has entries instead of a state; list them with "entries"`);
    }
    const raw = driver.getState();
    const state = options.sanitizeState ? options.sanitizeState(raw, t.info) : raw;
    return { rev: t.rev, pending: raw !== t.raw, ...fit(at(state, path)) };
  };
  const entries: StateEngine['entries'] = (id) => {
    const { t, driver } = need(id);
    if (typeof driver.keys !== 'function') throw new Error(`${t.info.label} has no entries`);
    const list: StateEntrySummary[] = [];
    let total = 0;
    for (const key of driver.keys()) {
      total++;
      if (list.length >= ENTRY_LIMIT) continue;
      const summary = summarize(driver, key);
      if (summary) list.push(summary);
    }
    return { entries: list, total };
  };
  const entry: StateEngine['entry'] = (id, key, path) => {
    const { t, driver } = need(id);
    if (typeof driver.keys !== 'function') throw new Error(`${t.info.label} has no entries`);
    const summary = summarize(driver, String(key));
    if (!summary) return null;
    const data = cleanEntry(t, String(key), typeof driver.data === 'function' ? driver.data(String(key)) : undefined);
    const { value, truncated } = fit(at(data, path));
    return { summary, data: value, truncated };
  };
  const act: StateEngine['act'] = (id, key, op) => {
    try {
      const { t, driver } = need(id);
      if (typeof driver.act !== 'function' || !(t.info.ops ?? []).includes(op)) {
        throw new Error(`${t.info.label} does not support "${String(op)}"`);
      }
      return Promise.resolve(driver.act(String(key), op));
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const stopDriver = (t: Tracked) => {
    const driver = t.driver.deref();
    const stop = driver && stops.get(driver);
    if (!driver || !stop) return;
    stops.delete(driver);
    try {
      stop();
    } catch {
      // the store may be half torn down already
    }
  };
  const untrack: StateEngine['untrack'] = (id, note) => {
    const t = stores.get(id);
    if (!t) return;
    stores.delete(id);
    stopDriver(t);
    const info: StateStoreInfo = { ...t.info, disposed: true };
    if (note) info.note = note;
    emit('state.store', { store: info });
  };
  const sink: StateSink = { record, dirty, removed };
  const track: StateEngine['track'] = (id, driver) => {
    if (disposed || stores.has(id)) return;
    let t: Tracked;
    try {
      t = {
        info: { ...driver.info, id },
        driver: hold(driver),
        rev: 0,
        raw: undefined,
        base: undefined,
        based: false,
        queue: [],
        carry: 0,
        windowStart: 0,
        windowCount: 0,
        dirty: new Set(),
        removed: new Set(),
        sent: new Map(),
        reset: false,
        entriesDue: Infinity,
      };
    } catch {
      return;
    }
    stores.set(id, t);
    emit('state.store', { store: t.info });
    try {
      if (typeof driver.getState === 'function') {
        try {
          t.raw = driver.getState();
          t.base = clean(t, t.raw);
          t.based = true;
        } catch {
          // the first record becomes the base instead
        }
      }
      if (typeof driver.keys === 'function') {
        t.reset = true;
        entriesSoon(t, ENTRY_DELAY);
      }
      const stop = driver.start(sink, id);
      if (typeof stop === 'function') stops.set(driver, stop);
    } catch (error) {
      untrack(id, `Could not watch this store: ${message(error)}`);
    }
  };
  const list: StateEngine['stores'] = () => {
    const out: StateStoreInfo[] = [];
    for (const t of [...stores.values()]) {
      if (t.driver.deref()) out.push(t.info);
      else untrack(t.info.id);
    }
    return out;
  };
  const dispose: StateEngine['dispose'] = () => {
    if (disposed) return;
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    for (const t of stores.values()) stopDriver(t);
    stores.clear();
  };

  return { ...sink, track, untrack, stores: list, read, entries, entry, act, dispose };
}
