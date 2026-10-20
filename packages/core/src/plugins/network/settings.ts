import { MAX_BODY_SIZE } from '@capybara-devtools/protocol';
import { failureExplainer, type FailureExplainer } from './failure.js';

export interface NetworkPluginOptions {
  /** Patch `fetch`. Where fetch runs on XHR (whatwg-fetch), its requests are recorded once, by the XHR patch, as fetch. */
  fetch?: boolean;
  xhr?: boolean;
  /** Record WebSocket connections and their messages. Default true. */
  websocket?: boolean;
  /** Requests and WebSockets whose URL contains one of these strings or matches one of these patterns are not recorded. */
  ignoreUrls?: Array<string | RegExp>;
  /** Request and response bodies are cut after this many characters. Default 128 KiB. */
  maxBodySize?: number;
  /** WebSocket messages are cut after this many characters. Default 16 KiB. */
  maxMessageSize?: number;
  /** Header names (case-insensitive) whose values are replaced with "[redacted]". */
  redactHeaders?: string[];
}

export interface Settings {
  maxBody: number;
  isIgnored(url: string): boolean;
  redact(headers: Record<string, string>): Record<string, string>;
  failures: FailureExplainer;
}

export function resolveSettings(options: NetworkPluginOptions): Settings {
  const patterns = options.ignoreUrls ?? [];
  const redacted = new Set((options.redactHeaders ?? []).map((name) => name.toLowerCase()));
  return {
    maxBody: options.maxBodySize ?? MAX_BODY_SIZE,
    isIgnored: (url) =>
      patterns.some((pattern) => {
        if (typeof pattern === 'string') return url.includes(pattern);
        pattern.lastIndex = 0;
        return pattern.test(url);
      }),
    redact: (headers) => {
      if (redacted.size === 0) return headers;
      const out: Record<string, string> = {};
      for (const [name, value] of Object.entries(headers)) {
        out[name] = redacted.has(name.toLowerCase()) ? '[redacted]' : value;
      }
      return out;
    },
    failures: failureExplainer(),
  };
}
