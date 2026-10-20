import { formatPath, type StateCommands, type StateEntrySummary, type StatePath } from '@capybara-devtools/protocol';
import { HIDDEN, isUnset, SECRET_NAME, type Redactor } from './mcp-redact.js';
import { readValueText } from './mcp-state.js';
import { clock, count, searchMatcher, truncate } from './mcp-text.js';

export type EntryStatus = 'error' | 'pending' | 'success' | 'fetching' | 'stale';

export interface EntryQuery {
  status?: EntryStatus;
  search?: string;
}

/** Matching entries, queries before mutations as the UI lists them. */
export function filterEntries(entries: StateEntrySummary[], query: EntryQuery): StateEntrySummary[] {
  const matcher = searchMatcher(query.search);
  const matched = entries.filter((entry) => {
    if (query.status && !hasStatus(entry, query.status)) return false;
    return !matcher || matcher.test(`${entry.label}\n${entry.key}`);
  });
  return [...matched.filter((entry) => entry.kind !== 'mutation'), ...matched.filter((entry) => entry.kind === 'mutation')];
}

function hasStatus(entry: StateEntrySummary, status: EntryStatus): boolean {
  switch (status) {
    case 'fetching':
      return entry.fetching;
    case 'stale':
      // TanStack marks every failed fetch invalidated, so freshness only means something for data that loaded.
      return entry.kind !== 'mutation' && entry.status === 'success' && Boolean(entry.stale || entry.invalidated);
    default:
      return entry.status === status;
  }
}

const KIND_LABELS: Record<StateEntrySummary['kind'], string> = {
  query: 'query',
  infinite: 'infinite query',
  mutation: 'mutation',
  swr: 'SWR key',
  'swr-infinite': 'SWR infinite key',
  'swr-subscription': 'SWR subscription',
};

/** `["todos"]: query, success, stale · 2 observers · updated 10:02:11.384 · data Array(20)`. */
export function entryLine(entry: StateEntrySummary, redact: Redactor): string {
  const query = entry.kind !== 'mutation';
  const loaded = query && entry.status === 'success';
  const words = [
    KIND_LABELS[entry.kind] ?? entry.kind,
    entry.status,
    entry.fetching ? 'fetching' : entry.paused ? 'paused' : undefined,
    loaded && entry.invalidated ? 'invalidated' : loaded && entry.stale ? 'stale' : undefined,
    query && entry.active === false ? 'inactive' : undefined,
    entry.disabled ? 'disabled' : undefined,
  ];
  const facts = [
    entry.observers === undefined ? undefined : count(entry.observers, 'observer'),
    entry.updatedAt ? `updated ${clock(entry.updatedAt)}` : undefined,
    entry.preview ? `data ${entry.preview}` : undefined,
    entry.error ? `error: ${truncate(redact.tokens(entry.error), 300)}` : undefined,
  ];
  // SWR keys can hold the token passed to the fetcher, as in `useSWR(['/api/user', token])`.
  const key = redact.tokens(entry.key);
  const label = redact.tokens(entry.label);
  const name = label && label !== key ? `${key} (${label})` : key;
  return [`${name}: ${words.filter(Boolean).join(', ')}`, ...facts.filter(Boolean)].join(' · ');
}

/** One entry with its data, credentials hidden; an entry keyed like a credential hides all of it, as storage does. */
export function entryDetail(result: NonNullable<StateCommands['entry']['result']>, path: StatePath, redact: Redactor, maxChars: number): string {
  const { summary } = result;
  const secret = redact.enabled && (SECRET_NAME.test(summary.key) || SECRET_NAME.test(summary.label));
  const lines = [entryLine(summary, redact)];
  if (summary.error && summary.error.length > 300) lines.push(`Error: ${summary.error}`);
  lines.push(path.length > 0 ? `Data at ${formatPath(path)}:` : 'Data:');
  lines.push(
    secret && !isUnset(result.data) ? HIDDEN : readValueText({ value: result.data, truncated: result.truncated }, path, redact, maxChars),
  );
  return lines.join('\n');
}
