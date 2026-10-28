import { execFile } from 'node:child_process';

/** A `dart development-service` process: what `flutter run` (or an IDE) starts beside each app it debugs. */
export interface DdsProcess {
  pid: number;
  /** The app's own VM service, with its auth code. */
  vmUri: string;
  device?: string;
  packageName?: string;
}

const VM_URI_ARG = /--vm-service-uri[= ](\S+)/;
// flutter_tools names the app this way: `--app-name=Kind: Flutter - Device: iPhone Duo - Package: shop`.
const APP_NAME_ARG = /--app-name=Kind: \S+ - Device: (.+?) - Package: (\S+)/;

export function parseDdsProcess(line: string): DdsProcess | undefined {
  const match = /^\s*(\d+)\s+(.*)$/.exec(line);
  if (!match || !/(?:^|[\s/\\])development-service(?:\s|$)/.test(match[2]!)) return undefined;
  const vmUri = VM_URI_ARG.exec(match[2]!)?.[1];
  if (!vmUri) return undefined;
  const app = APP_NAME_ARG.exec(match[2]!);
  return { pid: Number(match[1]), vmUri, ...(app && { device: app[1], packageName: app[2] }) };
}

/** Command lines of the running processes, `<pid> <args>` each. */
export function listProcesses(): Promise<string[]> {
  return new Promise((resolve) => {
    const done = (error: Error | null, stdout: string) => resolve(error ? [] : stdout.split(/\r?\n/));
    if (process.platform === 'win32') {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"CommandLine like '%development-service%'\" | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }",
        ],
        { timeout: 10_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        done,
      );
    } else {
      execFile('ps', ['-axww', '-o', 'pid=,args='], { timeout: 5_000, maxBuffer: 16 * 1024 * 1024 }, done);
    }
  });
}

export async function scanDdsProcesses(list: () => Promise<string[]> = listProcesses): Promise<DdsProcess[]> {
  return (await list()).flatMap((line) => parseDdsProcess(line) ?? []);
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** VM service addresses grant running code in the app, so Capybara only follows ones on this computer. */
export function isLoopbackVmUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    return ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/** Hides the auth code, the part of the address that lets anyone holding it run code in the app. */
export function redactVmUri(text: string): string {
  return text
    .replace(/\/[A-Za-z0-9_\-+]{4,}=\//g, '/…/')
    .replace(/(uri=[^&\s]*?%2F)[A-Za-z0-9_\-+%]{4,}?%3D%2F/gi, '$1…%2F');
}

function httpUri(uri: string): string {
  const url = new URL(uri);
  if (url.protocol === 'ws:') url.protocol = 'http:';
  if (url.protocol === 'wss:') url.protocol = 'https:';
  url.pathname = url.pathname.replace(/\/ws\/?$/, '/');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

/**
 * The WebSocket address of the Dart Development Service in front of an app, from the address of the app's VM
 * service or of the service itself: both answer a plain GET with a redirect to DevTools that names it. Undefined
 * when the app has no Development Service, or the address is wrong.
 */
export async function resolveDds(uri: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  if (!isLoopbackVmUri(uri)) return undefined;
  let response: Response;
  try {
    response = await fetchImpl(httpUri(uri), { redirect: 'manual', signal: AbortSignal.timeout(2_000) });
  } catch {
    return undefined;
  }
  const location = response.headers.get('location');
  if (response.status < 300 || response.status >= 400 || !location) return undefined;
  try {
    const target = new URL(location, httpUri(uri));
    const ws = target.searchParams.get('uri');
    return ws && isLoopbackVmUri(ws) && /^wss?:/.test(ws) ? ws : undefined;
  } catch {
    return undefined;
  }
}
