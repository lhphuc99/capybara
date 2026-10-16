import { execFile } from 'node:child_process';

/**
 * Lets Android devices on USB reach the server through localhost. Polls so devices plugged in
 * later are covered too; stops quietly if adb isn't installed.
 */
export function reverseAndroidPorts(port: number, adb = 'adb'): void {
  const done = new Set<string>();
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
        if (done.has(serial)) continue;
        done.add(serial);
        execFile(adb, ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`], (reverseError) => {
          if (reverseError) done.delete(serial);
        });
      }
    });
  };
  const timer = setInterval(check, 10_000);
  timer.unref();
  check();
}
