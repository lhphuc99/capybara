import type { LogEntry } from '@capybara-devtools/protocol';
import { describe, expect, it } from 'vitest';
import { logText } from '../src/mcp-logs.js';
import { redactor } from '../src/mcp-redact.js';

const redact = redactor(true);
const entry = (seq: number, extra: Partial<LogEntry>): LogEntry => ({ seq, ts: 1_700_000_000_000, level: 'log', source: 'console', args: [], ...extra });

describe('logText', () => {
  it('indents entries logged in console.group() under the group, as browsers show them', () => {
    expect(logText(entry(1, { args: ['Loading'], method: 'group' }), redact, false)).toMatch(/^#1 \S+ LOG {3}▸ Loading$/);
    expect(logText(entry(2, { args: ['inside'], depth: 1 }), redact, false)).toMatch(/^#2 \S+ LOG {5}inside$/);
    expect(logText(entry(3, { args: [[{ a: 1 }]], depth: 1, method: 'table' }), redact, true)).toMatch(/^#3 \S+ LOG {5}\[\{…\}\]\n {4}\[\n/);
  });
});
