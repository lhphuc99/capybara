import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * The first adb command starts the adb server, which outlives Capybara and keeps every file
 * descriptor it inherited. On Linux, Electron holds its resource files (app.asar, the .pak files)
 * open across exec, so the server kept them and an AppImage could not unmount and exit. bash closes
 * everything but stdio before adb starts.
 */
// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
const CLOSE_INHERITED = 'for fd in /proc/$$/fd/*; do fd=${fd##*/}; [ "$fd" -gt 2 ] && eval "exec $fd>&-"; done; exec "$@"';

let bash: boolean | undefined;

/** The program and arguments that run adb with `args`. */
export function adbCommand(adb: string, args: string[]): [string, string[]] {
  bash ??= process.platform === 'linux' && existsSync('/bin/bash');
  return bash ? ['/bin/bash', ['-c', CLOSE_INHERITED, 'adb', adb, ...args]] : [adb, args];
}

function run(adb: string, args: string[], callback: (error: Error | null, stdout: string) => void): void {
  const [file, argv] = adbCommand(adb, args);
  execFile(file, argv, callback);
}

/** bash exits with 127 where running adb directly fails with ENOENT. */
function isMissing(error: Error): boolean {
  const { code } = error as { code?: unknown };
  return code === 'ENOENT' || (bash === true && code === 127);
}

/**
 * Lets Android devices on USB reach the server through localhost. Polls so devices plugged in
 * later are covered too; stops quietly if adb isn't installed.
 */
export function reverseAndroidPorts(port: number, adb = 'adb'): void {
  const rule = `tcp:${port}`;
  const busy = new Set<string>();
  const check = () => {
    run(adb, ['devices'], (error, stdout) => {
      if (error) {
        if (isMissing(error)) clearInterval(timer);
        return;
      }
      const serials = stdout
        .split('\n')
        .slice(1)
        .map((line) => line.trim().split(/\s+/))
        .filter(([serial, state]) => serial && state === 'device')
        .map(([serial]) => serial!);
      for (const serial of serials) {
        if (busy.has(serial)) continue;
        busy.add(serial);
        // Reconnecting (`adb reconnect`, an emulator restart) drops the device's rules, often between two
        // polls, so look for the rule itself rather than remember the devices already done.
        run(adb, ['-s', serial, 'reverse', '--list'], (listError, list) => {
          const present = !listError && list.split('\n').some((line) => {
            const [, device, host] = line.trim().split(/\s+/);
            return device === rule && host === rule;
          });
          if (present) busy.delete(serial);
          else run(adb, ['-s', serial, 'reverse', rule, rule], () => busy.delete(serial));
        });
      }
    });
  };
  const timer = setInterval(check, 10_000);
  timer.unref();
  check();
}
