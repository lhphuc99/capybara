import {
  formatBytes,
  type StorageAdapterInfo,
  type StorageEntries,
  type StorageEntry,
} from '@capybara-devtools/protocol';
import { HIDDEN, isUnset, SECRET_NAME, type Redactor } from './mcp-redact.js';
import { parseJson, searchMatcher, truncate } from './mcp-text.js';

export function adapterLine(adapter: StorageAdapterInfo, keys: number | undefined): string {
  const notes = [keys === undefined ? undefined : `${keys} ${keys === 1 ? 'key' : 'keys'}`, adapter.readOnly ? 'read-only' : undefined, adapter.note].filter(Boolean);
  return `- ${adapter.id}: ${adapter.label}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}`;
}

export function storageValueText(key: string, value: string | null, redact: Redactor, pretty: boolean): string {
  if (value === null) return 'null';
  if (redact.enabled && SECRET_NAME.test(key) && !isUnset(value)) return HIDDEN;
  const parsed = parseJson(value);
  if (!parsed.ok) return redact.text(value);
  return JSON.stringify(redact.json(parsed.value), null, pretty ? 2 : undefined);
}

export function storageEntryLines(listing: StorageEntries, redact: Redactor, search: string | undefined): { lines: string[]; matched: number } {
  const matcher = searchMatcher(search);
  const lines: string[] = [];
  let matched = 0;
  for (const entry of listing.entries) {
    const text = storageValueText(entry.key, entry.value, redact, false);
    if (matcher && !matcher.test(`${entry.key}\n${text}`)) continue;
    matched++;
    lines.push(`- ${entry.key} (${formatBytes(entry.size)}): ${truncate(text, 300)}`);
  }
  return { lines, matched };
}

export function storageEntryText(entry: StorageEntry, redact: Redactor): string {
  const note = entry.truncated ? '\n(only the beginning of this value was read)' : '';
  return `${entry.key} (${formatBytes(entry.size)}):\n${storageValueText(entry.key, entry.value, redact, true)}${note}`;
}
