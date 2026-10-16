import type { BodyPreview, LogLevel, NetworkInitiator, Platform, SerializedValue } from '@capybara-devtools/protocol';

/** The parts of a Chrome DevTools Protocol `RemoteObject` the Metro bridge reads. */
export interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
}

/** Same limits as the SDK, so both kinds of session look alike in the UI. */
export const MAX_BODY = 128 * 1024;
const MAX_STRING = 10_000;

const LEVELS: Record<string, LogLevel> = {
  debug: 'debug',
  info: 'info',
  warning: 'warn',
  error: 'error',
  assert: 'error',
};

/** Undefined for console calls that print nothing, such as `console.groupEnd()`. */
export function logLevel(type: string): LogLevel | undefined {
  if (type === 'endGroup' || type === 'clear') return undefined;
  return LEVELS[type] ?? 'log';
}

/** Values CDP sends inline. Objects come with only a description; the bridge serializes them in the app. */
export function primitiveValue(object: RemoteObject): SerializedValue {
  switch (object.type) {
    case 'string': {
      const text = String(object.value ?? '');
      return text.length > MAX_STRING ? { $t: 'string', v: text.slice(0, MAX_STRING), length: text.length } : text;
    }
    case 'number': {
      const special = object.unserializableValue;
      if (special === 'NaN' || special === 'Infinity' || special === '-Infinity' || special === '-0') {
        return { $t: 'number', v: special };
      }
      return typeof object.value === 'number' ? object.value : Number(object.description);
    }
    case 'boolean':
      return object.value === true;
    case 'undefined':
      return { $t: 'undefined' };
    case 'bigint':
      return { $t: 'bigint', v: (object.unserializableValue ?? object.description ?? '').replace(/n$/, '') };
    case 'symbol':
      return { $t: 'symbol', v: object.description ?? 'Symbol()' };
    case 'function':
      return { $t: 'function', name: object.description?.match(/^function\s*([\w$]*)/)?.[1] || 'anonymous' };
  }
  if (object.subtype === 'null') return null;
  return object.description ?? object.className ?? 'Object';
}

/** React Native reports unhandled promise rejections through `console.error`. */
export function isUnhandledRejection(args: SerializedValue[]): boolean {
  const first = args[0] as { $t?: unknown; message?: unknown } | null | undefined;
  return (
    typeof first === 'object' &&
    first !== null &&
    first.$t === 'error' &&
    typeof first.message === 'string' &&
    first.message.startsWith('Uncaught (in promise')
  );
}

export function initiatorOf(type: string | undefined): NetworkInitiator {
  switch (type) {
    case 'XHR':
      return 'xhr';
    case 'Fetch':
      return 'fetch';
    case 'Image':
      return 'image';
    default:
      return 'other';
  }
}

export function platformOf(name: string | undefined): Platform {
  return name === 'ios' || name === 'android' || name === 'macos' || name === 'windows' ? name : 'unknown';
}

/** Requests React Native makes to Metro for development itself: symbolication for LogBox, bundles, assets. */
export function isDevServerRequest(url: string, metroPort: number): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.port !== String(metroPort)) return false;
  const path = parsed.pathname;
  return (
    path === '/symbolicate' ||
    path === '/open-stack-frame' ||
    path.startsWith('/assets/') ||
    path.endsWith('.bundle') ||
    path.endsWith('.map')
  );
}

export function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

const TEXTUAL =
  /^(text\/|application\/([\w.+-]*\+)?(json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|x-ndjson)\b)/i;

export function isTextual(contentType: string | undefined): boolean {
  return !contentType || TEXTUAL.test(contentType.trim());
}

export function textBody(text: string, contentType: string | undefined): BodyPreview {
  const truncated = text.length > MAX_BODY;
  return {
    kind: 'text',
    text: truncated ? text.slice(0, MAX_BODY) : text,
    size: Buffer.byteLength(text),
    truncated,
    contentType,
  };
}

/** Turns a `Network.getResponseBody` result into the preview the SDK would have sent. */
export function responseBody(
  result: { body: string; base64Encoded: boolean },
  contentType: string | undefined,
): BodyPreview | undefined {
  if (!result.base64Encoded) return result.body ? textBody(result.body, contentType) : undefined;
  const bytes = Buffer.from(result.body, 'base64');
  if (bytes.length === 0) return undefined;
  try {
    return { ...textBody(new TextDecoder('utf-8', { fatal: true }).decode(bytes), contentType), size: bytes.length };
  } catch {
    // Untyped responses are tried as text; these weren't.
    return { kind: 'binary', size: bytes.length, contentType, summary: contentType ?? 'Binary' };
  }
}
