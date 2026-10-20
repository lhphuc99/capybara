import {
  currentStores,
  formatOp,
  formatPath,
  isSpecial,
  libraryTitle,
  METRO_SDK,
  plainValue,
  preview,
  STATE_LIBRARIES,
  stateChangeLabel,
  valueText,
  type SerializedValue,
  type SessionInfo,
  type SessionMeta,
  type StateCommands,
  type StateDiffOp,
  type StateLibrary,
  type StatePath,
  type StateStoreInfo,
} from '@capybara-devtools/protocol';
import type { ChangeEntry, StateHistory, StoreEntry } from './mcp-history.js';
import { HIDDEN, isUnset, SECRET_NAME, type Redactor } from './mcp-redact.js';
import { clock, count, indent, searchMatcher, sessionHeader, truncate } from './mcp-text.js';

/** The history's stores with the ones the app has now laid over them. */
export function mergeStores(history: StateHistory, current: StateStoreInfo[]): StoreEntry[] {
  const merged = new Map(history.stores);
  for (const info of current) {
    const known = merged.get(info.id);
    merged.set(info.id, known ? { ...known, info } : { info, changes: 0 });
  }
  return [...merged.values()];
}

/**
 * The stores the UI lists, grouped by library in its order. Contexts that belong to a library (`vendor`) are left out
 * as the UI hides them; `findStore` still finds them.
 */
export function listStores(stores: StoreEntry[]): { shown: StoreEntry[]; replaced: number; vendored: number } {
  const current = currentStores(stores);
  const kept = current.filter(({ info }) => !info.vendor);
  const rank = (library: string) => {
    const index = STATE_LIBRARIES.indexOf(library as StateLibrary);
    return index < 0 ? STATE_LIBRARIES.length : index;
  };
  const shown = [...kept].sort((a, b) => rank(a.info.library) - rank(b.info.library));
  return { shown, replaced: stores.length - current.length, vendored: current.length - kept.length };
}

/**
 * The store with this id, else with this label: live ones before disposed ones, and of several in one
 * library (hot reloading), the newest. `others` counts the rest it was picked from. Undefined when nothing matches.
 */
export function findStore(stores: StoreEntry[], name: string): { store: StoreEntry; others: number } | undefined {
  const byId = stores.find((store) => store.info.id === name);
  if (byId) return { store: byId, others: 0 };
  let named = stores.filter((store) => store.info.label === name);
  if (named.length === 0) named = stores.filter((store) => store.info.label.toLowerCase() === name.toLowerCase());
  if (named.length === 0) return undefined;
  const live = named.filter((store) => !store.info.disposed);
  const pool = live.length > 0 ? live : named;
  if (new Set(pool.map((store) => store.info.library)).size > 1) {
    const list = pool.map((store) => `${store.info.id} (${libraryTitle(store.info.library)})`).join(', ');
    throw new Error(`"${name}" names ${pool.length} stores: ${list}. Pass the id instead.`);
  }
  // Ids count up per library ("redux:2"), so the highest is the newest; anything else keeps the later one.
  const order = (store: StoreEntry) => Number(/:(\d+)$/.exec(store.info.id)?.[1] ?? Number.NaN);
  const store = pool.reduce((newest, next) => (order(next) < order(newest) ? newest : next));
  return { store, others: pool.length - 1 };
}

export function unknownStore(stores: StoreEntry[], name: string, session: SessionMeta): Error {
  const { shown } = listStores(stores);
  if (shown.length === 0) return new Error(`There is no store "${name}": ${noStoresText(session)}`);
  return new Error(`There is no store "${name}" in ${sessionHeader(session)}. Its stores:\n${shown.map((store) => storeLine(store)).join('\n')}`);
}

/** Whether the session's SDK runs the state plugin, so the app can be asked about its stores. */
export function reportsState(info: SessionInfo): boolean {
  return info.plugins?.includes('state') === true;
}

const LIBRARY_NAMES = 'Redux, Zustand, XState, MobX, TanStack Query, SWR or React Context';

/** Why a session shows no stores, in the UI's words. */
export function noStoresText(session: SessionMeta): string {
  const { info } = session;
  const name = sessionHeader(session);
  if (!reportsState(info)) {
    if (info.sdk.name === METRO_SDK) {
      return (
        `${name} is read through Metro without the SDK, which shows logs, network and storage but not ${LIBRARY_NAMES} state. ` +
        'Add the SDK to the app to see its stores.'
      );
    }
    if (!info.plugins) {
      return `${name} uses ${info.sdk.name} ${info.sdk.version}, which does not report ${LIBRARY_NAMES} state. Update it to the latest version.`;
    }
    return (
      `${name} runs ${info.sdk.name} ${info.sdk.version} without its state plugin. ` +
      'Remove `state: false` from the options passed to init(), or update the SDK if this version came before state.'
    );
  }
  if (!session.connected) return `${name} is not connected, and its history has no state stores.`;
  return (
    `${name} has no state stores yet. ${LIBRARY_NAMES} stores show up once the app registers them; ` +
    'keep init() in the first file the app imports, before its store modules load.'
  );
}

/** TanStack Query and SWR stores hold cache entries; the others have a state and a timeline of changes. */
export function isCache(info: StateStoreInfo): boolean {
  return info.library === 'tanstack-query' || info.library === 'swr' || info.ops !== undefined;
}

/** `cart (Redux, redux:1)`. */
export function storeTitle(info: StateStoreInfo): string {
  const notes = [libraryTitle(info.library), info.label === info.id ? undefined : info.id, info.disposed ? 'disposed' : undefined];
  return `${info.label} (${notes.filter(Boolean).join(', ')})`;
}

/** One store in a list; `listing` is a cache's entries, read from the app. */
export function storeLine(store: StoreEntry, listing?: StateCommands['entries']['result']): string {
  const { info, last } = store;
  const parts = [`- ${info.id}: ${info.label} (${libraryTitle(info.library)}${info.disposed ? ', disposed' : ''})`];
  if (isCache(info)) {
    if (listing) parts.push(...cacheCounts(info, listing));
  } else if (last) {
    const label = stateChangeLabel(last).text;
    const recorded = count(store.changes, info.actions ? 'action' : 'change');
    parts.push(`${recorded} recorded, the last #${last.seq} ${label} at ${clock(last.ts)} (rev ${last.rev})`);
  } else {
    parts.push('no changes recorded');
  }
  if (info.note) parts.push(info.note);
  return parts.join(' · ');
}

/** The stores `listStores` picked, `listings` holding the entries read for each cache. */
export function storeListText(
  session: SessionMeta,
  list: { shown: StoreEntry[]; replaced: number; vendored: number },
  listings: Array<StateCommands['entries']['result'] | undefined>,
  failure: string | undefined,
): string {
  if (list.shown.length === 0) return noStoresText(session);
  const name = sessionHeader(session);
  const head = !session.connected
    ? `${name} is not connected, so the current state of its stores cannot be read. The stores it registered:`
    : failure
      ? `${name} did not list its stores (${failure}). The stores in its history:`
      : `${name} state stores:`;
  const lines = [head, ...list.shown.map((store, index) => storeLine(store, listings[index]))];
  if (list.replaced > 0) lines.push(`${count(list.replaced, 'older store')} replaced by a newer one of the same name not listed.`);
  if (list.vendored > 0) lines.push(`${count(list.vendored, 'library context')} (e.g. React Redux, TanStack Query) not listed; pass its label as store to read one.`);
  if (!session.connected) {
    lines.push('get_state_actions reads the changes recorded before it disconnected.');
  } else {
    const caches = list.shown.some((store) => isCache(store.info)) ? ', and get_queries the TanStack Query and SWR entries' : '';
    lines.push(`Pass store (an id or label) to read its current state; get_state_actions lists what changed${caches}.`);
  }
  return lines.join('\n');
}

/** What a read shows: the change the app had recorded last when it read, named from the history while it is there. */
export function readAsOf(history: StateHistory, info: StateStoreInfo, read: StateCommands['get']['result'], path: StatePath): string {
  let text = path.length > 0 ? `Value at ${formatPath(path)}` : 'Current state';
  if (read.rev > 0) {
    let change: ChangeEntry | undefined;
    for (let i = history.changes.length - 1; i >= 0 && !change; i--) {
      const candidate = history.changes[i]!;
      if (candidate.store === info.id && candidate.rev === read.rev) change = candidate;
    }
    text += ` as of rev ${read.rev}${change ? ` (#${change.seq} ${stateChangeLabel(change).text} at ${clock(change.ts)})` : ''}`;
  }
  return `${text}${read.pending ? ', with newer changes on the way' : ''}:`;
}

function cacheCounts(info: StateStoreInfo, listing: StateCommands['entries']['result']): string[] {
  const { entries, total } = listing;
  const mutations = entries.filter((entry) => entry.kind === 'mutation').length;
  const listed =
    info.library === 'tanstack-query'
      ? `${count(entries.length - mutations, 'query', 'queries')}, ${count(mutations, 'mutation')}`
      : count(entries.length, 'key');
  const parts = [total > entries.length ? `${listed} (${total} in the app)` : listed];
  const errors = entries.filter((entry) => entry.status === 'error').length;
  const fetching = entries.filter((entry) => entry.fetching).length;
  if (errors > 0) parts.push(`${errors} in error`);
  if (fetching > 0) parts.push(`${fetching} fetching`);
  return parts;
}

/** A path through a key named like a credential leads to the credential, or to something holding it. */
function secretPath(path: StatePath): boolean {
  return path.some((key) => typeof key === 'string' && SECRET_NAME.test(key));
}

/** The app's errors for a read, said in terms of the store and path asked for. */
export function stateReadError(error: unknown, info: StateStoreInfo, path: StatePath, what: 'state' | 'entries' | 'data'): Error {
  const text = error instanceof Error ? error.message : String(error);
  if (text.startsWith('Unknown store ')) return new Error(`The app no longer has ${storeTitle(info)}, so its ${what} cannot be read.`);
  if (text.startsWith('Nothing at ')) {
    const whole = what === 'data' ? 'all of its data' : 'the whole state';
    return new Error(`${storeTitle(info)} has nothing at ${formatPath(path)}${what === 'data' ? ' in this entry' : ''}. Leave out path to read ${whole}.`);
  }
  return error instanceof Error ? error : new Error(text);
}

/** A value read from the app, credentials hidden, cut at `maxChars`, with how to read the parts left out. */
export function readValueText(read: { value: SerializedValue; truncated: boolean }, path: StatePath, redact: Redactor, maxChars: number): string {
  if (redact.enabled && secretPath(path) && !isUnset(read.value)) return HIDDEN;
  const value = redact.value(read.value);
  const text = valueText(value);
  const lines = [truncate(text, maxChars)];
  const cut: StatePath[] = [];
  findCut(value, path, cut);
  if (cut.length > 0) {
    const examples = cut.map((part) => JSON.stringify(formatPath(part))).join(' or ');
    lines.push(`This value is large, so the app cut some branches, shown as "[Object]" or "[Array(n)]". Read one with path, e.g. ${examples}.`);
  } else if (read.truncated) {
    lines.push('This value is large, so the app cut some of it. Read a part with path for the rest.');
  }
  if (text.length > maxChars) lines.push(`${partsHint(value, path)}, or pass a larger maxChars.`);
  return lines.join('\n');
}

function partsHint(value: SerializedValue, path: StatePath): string {
  const children = childrenOf(value);
  if (children.length === 0) return 'Read a part with path';
  // The app may have sent only the first items, so the range ends at the real length.
  const length = Array.isArray(value)
    ? value.length
    : isSpecial(value) && value.$t === 'array'
      ? value.length
      : isSpecial(value) && value.$t === 'set'
        ? value.size
        : 0;
  if (length > 0) return `Read items one at a time with path, from ${formatPath([...path, 0])} to ${formatPath([...path, length - 1])}`;
  const listed = children.slice(0, 12).map(([key, child]) => `${formatPath([...path, key])} (${preview(child, false, true)})`);
  if (children.length > listed.length) listed.push(`and ${children.length - listed.length} more`);
  return `Read a part with path: ${listed.join(', ')}`;
}

/** Paths of the branches the app cut short, so they can be read on their own. */
function findCut(value: SerializedValue, path: StatePath, found: StatePath[]): void {
  if (found.length >= 3) return;
  if (isSpecial(value) && value.$t === 'limit') {
    if (path.length > 0) found.push(path);
    return;
  }
  for (const [key, child] of childrenOf(value)) findCut(child, [...path, key], found);
}

/** Keys and values one level down, keyed the way the app's `readPath` follows them. */
function childrenOf(value: SerializedValue): Array<[string | number, SerializedValue]> {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.map((item, index) => [index, item]);
  if (!isSpecial(value)) return Object.entries(value as Record<string, SerializedValue>);
  switch (value.$t) {
    case 'object':
      return Object.entries(value.props);
    case 'error':
      return Object.entries(value.props ?? {});
    case 'array':
      return value.items.map((item, index) => [index, item]);
    case 'set':
      return value.values.map((item, index) => [index, item]);
    case 'map':
      return value.entries.flatMap(([key, item]): Array<[string | number, SerializedValue]> =>
        typeof key === 'string' || typeof key === 'number' ? [[key, item]] : [],
      );
    default:
      return [];
  }
}

export interface ChangeQuery {
  search?: string;
  after?: number;
  before?: number;
}

export function filterChanges(changes: ChangeEntry[], query: ChangeQuery): ChangeEntry[] {
  const matcher = searchMatcher(query.search);
  return changes.filter((entry) => {
    if (query.after !== undefined && entry.seq <= query.after) return false;
    if (query.before !== undefined && entry.seq >= query.before) return false;
    // What the UI's timeline filter matches: the action, then each changed path.
    return !matcher || matcher.test([stateChangeLabel(entry).text, ...entry.ops.map((op) => formatPath(op.path))].join('\n'));
  });
}

/** Ops shown under each change in a list; `seq` reads them all. */
const LISTED_OPS = 3;

/** A change in a list: markers for what was skipped or missed before it, its line, then its first ops. */
export function changeLines(entry: ChangeEntry, info: StateStoreInfo, redact: Redactor, tagged: boolean): string[] {
  const lines: string[] = [];
  if (entry.missed > 0) lines.push(`(${count(entry.missed, 'change')} missed)`);
  if (entry.skipped > 0) lines.push(`(${count(entry.skipped, info.actions ? 'action' : 'change')} skipped · folded into the next one)`);
  let head = `#${entry.seq} ${clock(entry.ts)} ${tagged ? `${info.label} · ` : ''}${changeName(entry, info)}`;
  if (entry.action) {
    const fields = actionFields(entry.action, redact);
    if (Object.keys(fields).length > 0) head += ` ${truncate(JSON.stringify(plainValue(fields)), 300)}`;
  }
  lines.push(head);
  const shown = entry.ops.slice(0, LISTED_OPS);
  lines.push(...shown.map((op) => `    ${opLine(op, redact)}`));
  if (entry.opCount > shown.length) lines.push(`    … ${entry.opCount - shown.length} more; pass seq: ${entry.seq} to read them`);
  return lines;
}

/** One change in full: its action as dispatched and every op the app sent. */
export function changeDetail(entry: ChangeEntry, info: StateStoreInfo, redact: Redactor): string {
  const noun = info.actions ? 'action' : 'change';
  const lines = [`#${entry.seq} ${clock(entry.ts)} ${changeName(entry, info)} · rev ${entry.rev}`];
  if (entry.missed > 0) lines.push(`${count(entry.missed, 'change')} before this one never arrived, e.g. while the server restarted.`);
  if (entry.skipped > 0) {
    const were = entry.skipped === 1 ? 'was' : 'were';
    lines.push(`${count(entry.skipped, noun)} before this one ${were} folded into it: too many at once, or the app was offline.`);
  }
  if (entry.action) {
    lines.push('Action:', indent(valueText({ type: entry.action.type, ...actionFields(entry.action, redact) }), '    '));
  } else if (info.actions && entry.cause !== 'init') {
    lines.push('No action: the app set the state directly.');
  }
  if (entry.ops.length === 0) {
    lines.push(entry.cause === 'init' ? 'The state the store started with; get_state shows what it holds now.' : 'Nothing changed.');
    return lines.join('\n');
  }
  lines.push(`${count(entry.opCount, 'change')} (+ added, ~ changed, − removed):`, ...entry.ops.map((op) => `    ${opLine(op, redact)}`));
  const cut = entry.opCount - entry.ops.length;
  if (cut > 0) lines.push(`${cut} more ${cut === 1 ? 'change was' : 'changes were'} left out; get_state shows the whole state as it is now.`);
  lines.push('Values are short previews; get_state reads the current value at a path.');
  return lines.join('\n');
}

function changeName(entry: ChangeEntry, info: StateStoreInfo): string {
  const label = stateChangeLabel(entry).text;
  // Only where changes come from dispatches does one from elsewhere stand out.
  if (!info.actions || entry.cause !== 'external') return label;
  return `${label} [${/^@@redux\/REPLACE/.test(label) ? 'hot reload' : 'changed outside a dispatch'}]`;
}

// `payload` holds the rest of the action, so its fields spread back to the top as dispatched: `{type, payload, meta}`.
function actionFields(action: NonNullable<ChangeEntry['action']>, redact: Redactor): Record<string, SerializedValue> {
  const rest = action.payload;
  const spread: Record<string, SerializedValue> =
    rest === undefined
      ? {}
      : typeof rest === 'object' && rest !== null && !Array.isArray(rest) && !isSpecial(rest)
        ? (rest as Record<string, SerializedValue>)
        : { payload: rest };
  // Redux Toolkit action creators called without an argument send `payload: undefined`, which says nothing.
  const fields = Object.fromEntries(
    Object.entries(spread).filter(([, value]) => !(isSpecial(value) && value.$t === 'undefined')),
  );
  if (!redact.enabled) return fields;
  // Hiding by key name misses a credential that is the whole payload, as in `setToken("eyJ…")`, so the type decides.
  if (SECRET_NAME.test(String(action.type))) {
    return Object.fromEntries(Object.entries(fields).map(([key, item]) => [key, isUnset(item) ? item : HIDDEN]));
  }
  return redact.value(fields) as Record<string, SerializedValue>;
}

const OP_SYMBOLS: Record<StateDiffOp['op'], string> = { add: '+', set: '~', del: '−' };

/** One op the way the UI's diff shows it: `~ cart.total 12.5 → 27`, `+ items[2] = {…}`, `− user.token "abc"`. */
function opLine(op: StateDiffOp, redact: Redactor): string {
  const secret = redact.enabled && secretPath(op.path);
  const shown = (item: SerializedValue | undefined) =>
    item === undefined ? undefined : secret && !isUnset(item) ? HIDDEN : redact.value(item);
  const text = formatOp({ ...op, prev: shown(op.prev), value: shown(op.value) });
  const symbol = OP_SYMBOLS[op.op] ?? '~';
  if (op.op === 'add') return `${symbol} ${text.path} = ${text.value ?? 'undefined'}`;
  if (op.op === 'del') return `${symbol} ${text.path} ${text.prev ?? 'undefined'}`;
  return `${symbol} ${text.path} ${text.prev ?? 'undefined'} → ${text.value ?? 'undefined'}`;
}
