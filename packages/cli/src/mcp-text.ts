import { makeMatcher, type SessionMeta } from '@capybara-devtools/protocol';

export function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false };
  }
}

/** The session a tool reads: the one asked for, else the newest app still connected. */
export function pickSession(sessions: SessionMeta[], id: string | undefined): SessionMeta {
  if (id) {
    const found = sessions.find((session) => session.info.id === id);
    if (found) return found;
    throw new Error(`There is no session ${id}.${sessions.length > 0 ? ` Sessions:\n${sessions.map(sessionLine).join('\n')}` : ''}`);
  }
  const [newest] = [...sessions].sort((a, b) => Number(b.connected) - Number(a.connected) || b.info.startedAt - a.info.startedAt);
  if (!newest) {
    throw new Error(
      'No app has connected to Capybara yet. Start a web app that calls init() from @capybara-devtools/web, or a React Native app through Metro.',
    );
  }
  return newest;
}

export function sessionLine(session: SessionMeta): string {
  const { info } = session;
  const where = info.url ? hostOf(info.url) : [info.device?.model, info.device?.osVersion].filter(Boolean).join(' ');
  const parts = [
    `${info.appName} (${info.platform}${where ? `, ${where}` : ''})`,
    info.runtime,
    session.connected ? 'connected' : 'disconnected',
    `${session.eventCount} events`,
    `started ${clock(info.startedAt)}`,
  ];
  return `- ${info.id}: ${parts.filter(Boolean).join(' · ')}`;
}

export function sessionHeader(session: SessionMeta): string {
  return `${session.info.appName} (session ${session.info.id}${session.connected ? '' : ', disconnected'})`;
}

/** The newest `limit` items, and a note on the older ones left out. */
export function newest<T extends { seq: number }>(items: T[], limit: number): { shown: T[]; omitted: number } {
  const shown = items.slice(-limit);
  return { shown, omitted: items.length - shown.length };
}

export function searchMatcher(search: string | undefined) {
  if (!search) return null;
  const matcher = makeMatcher(search);
  if (matcher?.invalid) throw new Error(`Invalid regular expression: ${search}`);
  return matcher;
}

export function clock(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export function duration(ms: number | undefined): string {
  if (ms === undefined) return '-';
  return ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(2)} s`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (${(text.length - max).toLocaleString('en-US')} more characters)` : text;
}

export function indent(text: string, prefix: string): string {
  return text.replace(/^/gm, prefix);
}
