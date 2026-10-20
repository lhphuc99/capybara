import type { BodyPreview } from '@capybara-devtools/protocol';
import { utf8Length } from '../../utils.js';

const TEXTUAL =
  /^(text\/|application\/([\w.+-]*\+)?(json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|x-ndjson)\b)/i;

export function isTextual(contentType: string | undefined): boolean {
  return !contentType || TEXTUAL.test(contentType.trim());
}

export function textPreview(text: string, maxBody: number, contentType?: string, kind: 'text' | 'form' = 'text'): BodyPreview {
  const truncated = text.length > maxBody;
  return { kind, text: truncated ? text.slice(0, maxBody) : text, size: utf8Length(text), truncated, contentType };
}

export function previewRequestBody(body: unknown, maxBody: number, contentType?: string): BodyPreview | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return textPreview(body, maxBody, contentType);
  const g = globalThis as Record<string, any>;
  if (g.URLSearchParams && body instanceof g.URLSearchParams) {
    return textPreview(String(body), maxBody, contentType ?? 'application/x-www-form-urlencoded');
  }
  if (g.FormData && body instanceof g.FormData) return formPreview(body, maxBody);
  if (g.Blob && body instanceof g.Blob) {
    const blob = body as Blob;
    return { kind: 'binary', size: blob.size, contentType: blob.type || contentType, summary: blob.type ? `Blob (${blob.type})` : 'Blob' };
  }
  if (body instanceof ArrayBuffer) return { kind: 'binary', size: body.byteLength, contentType, summary: 'ArrayBuffer' };
  if (ArrayBuffer.isView(body)) {
    return { kind: 'binary', size: body.byteLength, contentType, summary: body.constructor?.name ?? 'TypedArray' };
  }
  if (g.ReadableStream && body instanceof g.ReadableStream) return { kind: 'stream', contentType, summary: 'ReadableStream' };
  return { kind: 'unknown', contentType, summary: Object.prototype.toString.call(body) };
}

interface ReactNativeFormPart {
  fieldName: string;
  string?: string;
  uri?: string;
  name?: string;
  type?: string;
}

function formPreview(form: unknown, maxBody: number): BodyPreview {
  const lines: string[] = [];
  const browserForm = form as { entries?: () => Iterable<[string, unknown]> };
  const nativeForm = form as { getParts?: () => ReactNativeFormPart[] };
  if (typeof browserForm.entries === 'function') {
    for (const [name, value] of browserForm.entries()) lines.push(`${name}=${describeFormValue(value)}`);
  } else if (typeof nativeForm.getParts === 'function') {
    // React Native's FormData has no entries().
    for (const part of nativeForm.getParts()) {
      const value =
        part.string !== undefined ? part.string : `[file ${part.name ?? part.uri ?? ''}${part.type ? `, ${part.type}` : ''}]`;
      lines.push(`${part.fieldName}=${value}`);
    }
  }
  return textPreview(lines.join('\n'), maxBody, 'multipart/form-data', 'form');
}

function describeFormValue(value: unknown): string {
  if (typeof value === 'string') return value;
  const file = value as { name?: string; size?: number; type?: string };
  return `[file ${file.name ?? 'blob'}${file.type ? `, ${file.type}` : ''}${file.size !== undefined ? `, ${file.size} B` : ''}]`;
}

export function headersToRecord(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const add = (name: string, value: string) => {
    out[name] = name in out ? `${out[name]}, ${value}` : value;
  };
  if (Array.isArray(headers)) {
    for (const pair of headers) if (Array.isArray(pair) && pair.length >= 2) add(String(pair[0]), String(pair[1]));
  } else if (typeof (headers as Headers).forEach === 'function') {
    (headers as Headers).forEach((value, name) => {
      add(name, value);
    });
  } else if (typeof headers === 'object') {
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
      if (value !== undefined) add(name, String(value));
    }
  }
  return out;
}

export function parseRawHeaders(raw: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const line of raw.split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    const name = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    out[name] = name in out ? `${out[name]}, ${value}` : value;
  }
  return out;
}

export function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) if (key.toLowerCase() === target) return headers[key];
  return undefined;
}

export function absoluteUrl(url: string): string {
  const base = (globalThis as { location?: { href?: string } }).location?.href;
  if (!base || /^[a-z][a-z\d+.-]*:/i.test(url)) return url;
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}
