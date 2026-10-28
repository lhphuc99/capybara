import {
  MAX_BODY_SIZE,
  MAX_STRING_LENGTH,
  type BodyPreview,
  type LogLevel,
  type NetworkInitiator,
  type Platform,
  type SerializedValue,
} from '@capybara-devtools/protocol';

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
      return text.length > MAX_STRING_LENGTH ? { $t: 'string', v: text.slice(0, MAX_STRING_LENGTH), length: text.length } : text;
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

/** The `initiator` of `Network.requestWillBeSent`; React Native puts the JS stack of the request in it. */
export interface RequestInitiator {
  stack?: { callFrames?: Array<{ functionName?: string }> };
}

export function initiatorOf(type: string | undefined, initiator?: RequestInitiator): NetworkInitiator {
  switch (type) {
    case 'XHR':
      return 'xhr';
    case 'Fetch':
      return 'fetch';
    case 'Image':
      return 'image';
  }
  // React Native sends no type. What it reports goes through its networking module, which XHR uses,
  // and so does its fetch (whatwg-fetch): only the JS stack of the request tells the two apart.
  // Expo's network inspector sends "Other" and no stack for fetch and XHR alike.
  const frames = initiator?.stack?.callFrames;
  if (!Array.isArray(frames) || frames.length === 0) return 'other';
  return frames.some((frame) => frame?.functionName === 'fetch') ? 'fetch' : 'xhr';
}

export function platformOf(name: string | undefined): Platform {
  return name === 'ios' || name === 'android' || name === 'macos' || name === 'windows' || name === 'linux'
    ? name
    : 'unknown';
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
  const truncated = text.length > MAX_BODY_SIZE;
  return {
    kind: 'text',
    text: truncated ? text.slice(0, MAX_BODY_SIZE) : text,
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
