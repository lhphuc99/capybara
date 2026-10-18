import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reverseAndroidPorts } from '../src/adb.js';

/** Stands in for adb: devices and their reverse rules are read from state.json, and each call is logged. */
const FAKE_ADB = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const stateFile = path.join(__dirname, 'state.json');
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls.log'), args.join(' ') + '\\n');
if (args[0] === 'devices') {
  console.log('List of devices attached\\n' + state.devices.map((device) => device.join('\\t') + '\\n').join(''));
} else if (args[2] === 'reverse' && args[3] === '--list') {
  for (const rule of state.rules[args[1]] ?? []) console.log('host-18 ' + rule);
} else if (args[2] === 'reverse') {
  (state.rules[args[1]] ??= []).push(args[3] + ' ' + args[4]);
  fs.writeFileSync(stateFile, JSON.stringify(state));
}
`;

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Each check runs another poll of adb, as the 10-second timer would. */
const polling = (assertion: () => void) =>
  vi.waitFor(() => {
    vi.advanceTimersByTime(10_000);
    assertion();
  }, { timeout: 4_000, interval: 50 });

describe('adb reverse', () => {
  it('reverses the port on each connected device, and again after the device reconnects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'capybara-adb-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const adb = join(dir, 'adb.cjs');
    writeFileSync(adb, FAKE_ADB, { mode: 0o755 });
    const setDevices = (devices: string[][]) => writeFileSync(join(dir, 'state.json'), JSON.stringify({ devices, rules: {} }));
    const calls = () => readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n');
    const reversed = () => calls().filter((call) => call.endsWith(' reverse tcp:7357 tcp:7357'));

    setDevices([['emulator-5554', 'device'], ['R5CT1234', 'unauthorized']]);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    reverseAndroidPorts(7357, adb);
    await vi.waitFor(() => expect(reversed()).toEqual(['-s emulator-5554 reverse tcp:7357 tcp:7357']));

    // Later polls leave the rule in place alone.
    await polling(() => expect(calls().filter((call) => call === 'devices').length).toBeGreaterThanOrEqual(3));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(reversed()).toHaveLength(1);

    // `adb reconnect`: the device is back before the next poll, without its rules.
    setDevices([['emulator-5554', 'device']]);
    await polling(() => expect(reversed()).toHaveLength(2));
  });
});
