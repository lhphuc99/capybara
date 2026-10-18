import { execFile } from 'node:child_process';

/**
 * Lets Android devices on USB reach the server through localhost. Polls so devices plugged in
 * later are covered too; stops quietly if adb isn't installed.
 */
export function reverseAndroidPorts(port: number, adb = 'adb'): void {
  const rule = `tcp:${port}`;
  const busy = new Set<string>();
  const check = () => {
    execFile(adb, ['devices'], (error, stdout) => {
      if (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') clearInterval(timer);
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
        execFile(adb, ['-s', serial, 'reverse', '--list'], (listError, list) => {
          const present = !listError && list.split('\n').some((line) => {
            const [, device, host] = line.trim().split(/\s+/);
            return device === rule && host === rule;
          });
          if (present) busy.delete(serial);
          else execFile(adb, ['-s', serial, 'reverse', rule, rule], () => busy.delete(serial));
        });
      }
    });
  };
  const timer = setInterval(check, 10_000);
  timer.unref();
  check();
}
