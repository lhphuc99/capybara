import { isSpecial, type SerializedValue } from '@capybara-devtools/protocol';
import { parseJson } from './mcp-text.js';

export const HIDDEN = '[hidden]';

/** Header, JSON key and storage key names whose values are credentials. */
export const SECRET_NAME = /authorization|cookie|token|secret|password|passwd|api[-_]?key|credential|jwt|bearer|private[-_]?key/i;

/** Query parameters that commonly carry credentials, e.g. `?token=` on a WebSocket URL. */
const SECRET_PARAM = /token|secret|password|passwd|signature|api[-_]?key|auth|credential/i;

/** Credentials known by their shape alone: JWTs, `Bearer …`, and Stripe, GitHub, Slack and AWS keys. */
const SECRET_VALUE =
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}|\bBearer\s+[\w.~+/-]{8,}=*|\b[sr]k_(?:live|test)_\w{8,}|\bgh[pousr]_\w{20,}|\bxox[abprs]-[\w-]{10,}|\bAKIA[0-9A-Z]{16}\b/g;

export interface Redactor {
  readonly enabled: boolean;
  headers(headers: Record<string, string> | undefined): Record<string, string>;
  url(url: string): string;
  /** A captured log value, before it is formatted. */
  value(value: SerializedValue): SerializedValue;
  /** Plain JSON, e.g. a parsed body or storage value. */
  json(value: unknown): unknown;
  /** Text that may be JSON or a form; anything else is left as it is. */
  text(text: string): string;
  /** Free text such as a query key or an error message, where no key name tells a credential apart. */
  tokens(text: string): string;
}

/**
 * What a credential's key holds when there is no credential, as while signed out. Shown as it is, so
 * `token: null` reads differently from a hidden token.
 */
export function isUnset(value: unknown): boolean {
  const item = value as SerializedValue;
  return item === null || item === undefined || item === false || item === '' || (isSpecial(item) && item.$t === 'undefined');
}

export function redactor(enabled: boolean): Redactor {
  const params = (text: string) =>
    text.replace(/([?&]|^)([^=&#?\s]+)=([^&#\s]*)/g, (match, separator: string, name: string, item: string) =>
      SECRET_PARAM.test(decode(name)) && !isUnset(item) ? `${separator}${name}=${HIDDEN}` : match,
    );
  const json = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(json);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, SECRET_NAME.test(key) && !isUnset(item) ? HIDDEN : json(item)]),
    );
  };
  const record = (props: Record<string, SerializedValue>) =>
    Object.fromEntries(
      Object.entries(props).map(([key, item]) => [key, SECRET_NAME.test(key) && !isUnset(item) ? HIDDEN : value(item)]),
    );
  const value = (item: SerializedValue): SerializedValue => {
    if (item === null || typeof item !== 'object') return item;
    if (Array.isArray(item)) return item.map(value);
    if (!isSpecial(item)) return record(item as Record<string, SerializedValue>);
    switch (item.$t) {
      case 'object':
        return { ...item, props: record(item.props) };
      case 'array':
        return { ...item, items: item.items.map(value) };
      case 'set':
        return { ...item, values: item.values.map(value) };
      case 'map':
        return {
          ...item,
          entries: item.entries.map(([key, entry]): [SerializedValue, SerializedValue] => [
            key,
            typeof key === 'string' && SECRET_NAME.test(key) && !isUnset(entry) ? HIDDEN : value(entry),
          ]),
        };
      case 'error':
        return item.props ? { ...item, props: record(item.props) } : item;
      default:
        return item;
    }
  };
  if (!enabled) {
    const same = <T>(item: T) => item;
    return { enabled, headers: (headers) => headers ?? {}, url: same, value: same, json: same, text: same, tokens: same };
  }
  return {
    enabled,
    headers: (headers) =>
      Object.fromEntries(
        Object.entries(headers ?? {}).map(([name, item]) => [name, SECRET_NAME.test(name) && !isUnset(item) ? HIDDEN : item]),
      ),
    url: (url) => {
      const withoutPassword = url.replace(/([a-z]+:\/\/[^:/@\s]+):[^@/\s]+@/i, `$1:${HIDDEN}@`);
      const query = withoutPassword.indexOf('?');
      return query < 0 ? withoutPassword : withoutPassword.slice(0, query) + params(withoutPassword.slice(query));
    },
    value,
    json,
    text: (text) => {
      const parsed = parseJson(text);
      if (parsed.ok) return JSON.stringify(json(parsed.value));
      return /^[^=&\s]+=[^&\s]*(&[^=&\s]+=[^&\s]*)*$/.test(text.trim()) ? params(text.trim()) : text;
    },
    tokens: (text) => text.replace(SECRET_VALUE, HIDDEN),
  };
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
