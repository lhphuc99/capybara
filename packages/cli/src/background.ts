import { fork, type ChildProcess } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CapybaraEvent } from '@capybara-devtools/protocol';
import type { RecordedSession } from './server.js';

/** Where the process `startInBackground` starts writes its output; set only in that process. */
export const BACKGROUND_LOG = 'CAPYBARA_BACKGROUND_LOG';
/** Set in that process when it is to take over sessions (`receiveSessions`). */
const HANDOVER = 'CAPYBARA_HANDOVER';
/** Events per message, as all of a session can be more than fits in one string. */
const HANDOVER_EVENTS = 200;

type HandoverMessage =
  | { t: 'session'; session: Omit<RecordedSession, 'events'> }
  | { t: 'events'; events: CapybaraEvent[] }
  | { t: 'end' };

/** What the server in a terminal hands to the one that takes its place in the background. */
export interface Handover {
  sessions: RecordedSession[];
  /** Lets go of the port once the sessions are across, just before the new server takes it. */
  release(): Promise<void>;
}

export interface BackgroundStart {
  /** What the server printed while starting: its banner, or why it did not start. */
  output: string;
  /** Set when it stopped while starting, e.g. as Capybara already runs on the port: the code to exit with. */
  code?: number;
}

/**
 * Runs the CLI at `script` with `args` in a process of its own, which outlives this one and the terminal, with its
 * output in a log file of a new temporary folder. With `handover`, that process takes over its sessions
 * (`receiveSessions`). Resolves once it says the server runs (`reportStarted`), or has exited, which removes the
 * folder again. Ctrl+C before then stops it.
 */
export function startInBackground(script: string, args: string[], handover?: Handover): Promise<BackgroundStart> {
  const dir = mkdtempSync(join(tmpdir(), 'capybara-'));
  const log = join(dir, 'capybara.log');
  const fd = openSync(log, 'w');
  const child = fork(script, args, {
    // A session of its own, which Ctrl+C and closing the terminal do not reach.
    detached: true,
    // Not this process's stdout: a caller that reads it to the end, as an assistant's shell tool does, would wait
    // for as long as the server runs.
    stdio: ['ignore', fd, fd, 'ipc'],
    env: { ...process.env, [BACKGROUND_LOG]: log, ...(handover && { [HANDOVER]: '1' }) },
    windowsHide: true,
  });
  closeSync(fd);
  return new Promise((resolve, reject) => {
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      child.kill();
    };
    const finish = (outcome: BackgroundStart | Error) => {
      process.off('SIGINT', cancel);
      child.removeAllListeners();
      child.on('error', () => {});
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    // A second Ctrl+C ends this process at once, as the listener is gone.
    process.once('SIGINT', cancel);
    child.on('message', (message) => {
      if (message === 'handover' && handover) return void handOver(child, handover);
      if (cancelled) return;
      finish({ output: readFileSync(log, 'utf8') });
      child.disconnect();
      child.unref();
    });
    child.on('exit', (code) => {
      const output = readFileSync(log, 'utf8');
      rmSync(dir, { recursive: true, force: true });
      finish(cancelled ? { output: '', code: 130 } : { output, code: code ?? 1 });
    });
    child.on('error', (error) => {
      rmSync(dir, { recursive: true, force: true });
      finish(error);
    });
  });
}

async function handOver(child: ChildProcess, { sessions, release }: Handover) {
  // Once the child is gone each send fails, and its exit says why.
  const send = (message: HandoverMessage) => new Promise<void>((resolve) => child.send(message, () => resolve()));
  for (const { events, ...session } of sessions) {
    await send({ t: 'session', session });
    for (let i = 0; i < events.length; i += HANDOVER_EVENTS) await send({ t: 'events', events: events.slice(i, i + HANDOVER_EVENTS) });
  }
  // The port stays taken until now, however long the sessions took, as another Capybara (the desktop app) would
  // take it as soon as it is free. The child takes it on the end.
  await release();
  await send({ t: 'end' });
}

/**
 * In the process `startInBackground` started: the sessions it is to take over, before it starts its server, or
 * undefined when it was given none.
 */
export function receiveSessions(): Promise<RecordedSession[] | undefined> {
  if (!process.env[HANDOVER] || !process.send) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const sessions: RecordedSession[] = [];
    const done = () => {
      process.off('message', onMessage);
      process.off('disconnect', done);
      resolve(sessions);
    };
    const onMessage = (value: unknown) => {
      const message = value as HandoverMessage;
      if (message.t === 'session') sessions.push({ ...message.session, events: [] });
      else if (message.t === 'events') sessions.at(-1)?.events.push(...message.events);
      else done();
    };
    process.on('message', onMessage);
    // A parent that is gone hands over no more; what came so far is kept.
    process.on('disconnect', done);
    // Asked for only now, as messages that come before there is a listener are dropped.
    process.send?.('handover', () => {});
  });
}

/** In the process `startInBackground` started: lets the command that started it return, as the server now runs. */
export function reportStarted(): void {
  // Without a callback, failing to reach a parent that is gone would end this process.
  process.send?.('started', () => {});
}
