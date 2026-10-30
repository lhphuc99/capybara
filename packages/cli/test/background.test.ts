import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKGROUND_LOG, startInBackground, type Handover } from '../src/background.js';
import type { RecordedSession } from '../src/server.js';

/** Stands in for the CLI: prints where its output goes and its pid, then does what its argument says. */
const FAKE_CLI = `
console.log('log ' + process.env.${BACKGROUND_LOG});
console.log('pid ' + process.pid);
const outcome = process.argv[2];
if (outcome === 'start') {
  process.send('started', () => {});
  setInterval(() => {}, 60_000);
} else if (outcome === 'fail') {
  console.error('Port 7357 is in use by a program other than Capybara');
  process.exit(1);
} else {
  process.exit(0);
}
`;

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

/** Takes over sessions as the CLI does, with the real background.ts, which Node runs by stripping its types. */
const RECEIVING_CLI = `
import { existsSync } from 'node:fs';
import { receiveSessions, reportStarted } from ${JSON.stringify(new URL('../src/background.ts', import.meta.url).href)};
const sessions = await receiveSessions();
console.log('released ' + existsSync(process.argv[2]));
console.log('log ' + process.env.${BACKGROUND_LOG});
console.log('pid ' + process.pid);
console.log('sessions ' + JSON.stringify(sessions ?? null));
reportStarted();
setInterval(() => {}, 60_000);
`;

const stripsTypes = Boolean((process.features as { typescript?: unknown }).typescript);

function fakeCli(source = FAKE_CLI, name = 'bin.cjs') {
  const dir = mkdtempSync(join(tmpdir(), 'capybara-cli-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, name);
  writeFileSync(script, source);
  return script;
}

/** Starts `script` with `args` in the background, where it is to keep running, and stops it after the test. */
async function background(script: string, args: string[], handover?: Handover) {
  const started = await startInBackground(script, args, handover);
  const pid = Number(printed(started.output, 'pid'));
  const log = printed(started.output, 'log')!;
  cleanup.push(() => {
    process.kill(pid);
    rmSync(dirname(log), { recursive: true, force: true });
  });
  return { ...started, pid, log };
}

/** The value the fake CLI printed after `label`. */
const printed = (output: string, label: string) => output.match(new RegExp(`^${label} (.+)$`, 'm'))?.[1];

describe('startInBackground', () => {
  it('returns once the server runs, which goes on in a process group of its own, printing to the log', async () => {
    const { output, code, pid, log } = await background(fakeCli(), ['start']);
    expect(code).toBeUndefined();
    expect(readFileSync(log, 'utf8')).toBe(output);
    expect(() => process.kill(pid, 0)).not.toThrow();
    // Ctrl+C in a terminal signals its process group, which is no longer the one of the command.
    if (process.platform !== 'win32') expect(() => process.kill(-pid, 0)).not.toThrow();
  });

  it.runIf(stripsTypes)('hands sessions over in parts to the process it starts, before that starts its server', async () => {
    const session = (id: string) => ({ id, appName: 'Shop', platform: 'ios' as const, sdk: { name: 'test', version: '0' }, startedAt: 1 });
    const events = Array.from({ length: 450 }, (_, i) => ({ seq: i + 1, ts: i + 1, kind: 'log', payload: { level: 'log', args: [`#${i + 1}`] } }));
    const sessions = [
      { info: session('a'), events, lastSeq: 450, lastSeen: 2 },
      { info: session('b'), events: [], lastSeq: 0, lastSeen: 3, address: '192.168.1.5' },
    ] as RecordedSession[];
    const script = fakeCli(RECEIVING_CLI, 'bin.mjs');
    // Stands in for the port, which the old server lets go of, slowly, once the sessions are across.
    const port = join(dirname(script), 'released');
    const release = async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      writeFileSync(port, '');
    };

    const handedOver = await background(script, [port], { sessions, release });
    expect(handedOver.code).toBeUndefined();
    expect(JSON.parse(printed(handedOver.output, 'sessions')!)).toEqual(sessions);
    expect(printed(handedOver.output, 'released')).toBe('true');

    // Started without sessions, as with --background, it starts at once.
    rmSync(port);
    const plain = await background(script, [port]);
    expect(printed(plain.output, 'sessions')).toBe('null');
  });

  it('passes on what it printed and how it exited when it stopped while starting, and removes the log', async () => {
    const failed = await startInBackground(fakeCli(), ['fail']);
    expect(failed.code).toBe(1);
    expect(failed.output).toContain('Port 7357 is in use by a program other than Capybara');
    expect(existsSync(dirname(printed(failed.output, 'log')!))).toBe(false);

    // As when Capybara already runs on the port.
    const running = await startInBackground(fakeCli(), ['exit']);
    expect(running.code).toBe(0);
    expect(existsSync(dirname(printed(running.output, 'log')!))).toBe(false);
  });
});
