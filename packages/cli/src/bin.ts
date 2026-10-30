#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isatty } from 'node:tty';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CLI_PACKAGE, DEFAULT_PORT, isNewerVersion, type ServerInfo } from '@capybara-devtools/protocol';
import { reverseAndroidPorts } from './adb.js';
import { BACKGROUND_LOG, receiveSessions, reportStarted, startInBackground, type Handover } from './background.js';
import { isLoopbackVmUri, redactVmUri } from './flutter-discovery.js';
import { startFlutterBridge, type FlutterBridge } from './flutter.js';
import { DEFAULT_METRO_PORTS, startMetroBridge, type MetroBridge } from './metro.js';
import { readPort, remoteUiFrom, updateCheckFrom } from './config.js';
import { reachableAddresses } from './server.js';
import { PortInUseError, startOrReuse, type Started } from './start.js';
import { fetchLatestVersions } from './updates.js';

const HELP = `Usage: capybara [options]
       capybara mcp [options]          Serve this data to AI assistants (see capybara mcp --help)
       capybara setup-guide [folder]   Print how to add Capybara to an app, for AI assistants
       capybara stop [options]         Stop the Capybara running on this computer (see capybara stop --help)

Options:
  -p, --port <port>         Port for the UI and app connections (default ${DEFAULT_PORT}, or $CAPYBARA_PORT)
      --host <address>      Address to bind (default: all interfaces)
      --remote-ui           Let other devices open the UI, which shows everything apps send, tokens included (or set $CAPYBARA_REMOTE_UI=1)
      --no-open             Don't open the UI in a browser
      --background          Run in the background and give the terminal back; stop it with capybara stop
      --allow-origin <url>  Extra origin allowed to open the UI socket, repeatable
      --metro-port <port>   Metro dev server to read React Native apps from, repeatable (default ${DEFAULT_METRO_PORTS.join(', ')})
      --no-metro            Only show apps that have the SDK
      --flutter-vm-service <uri>  Also read the Flutter app at this Dart VM service address, repeatable
      --no-flutter          Don't read Flutter apps started with flutter run
      --no-update-check     Don't look up newer versions on npm (or set $CAPYBARA_NO_UPDATE_CHECK)
  -h, --help                Show this help
  -v, --version             Show the version

In a terminal, press b to move a running Capybara to the background, with what it has recorded.

Set $CAPYBARA_DEBUG=1 to print what goes wrong when reading apps through Metro or the Dart VM service, e.g. why
one does not show up.
`;

const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string })
  .version;

if (process.argv[2] === 'mcp') {
  const { runMcp } = await import('./mcp.js');
  try {
    await runMcp(process.argv.slice(3), version);
    process.exit(0);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}

if (process.argv[2] === 'setup-guide') {
  const { runSetupGuide } = await import('./setup-guide.js');
  try {
    await runSetupGuide(process.argv.slice(3), version);
    process.exit(0);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}

if (process.argv[2] === 'stop') {
  const { runStop } = await import('./stop.js');
  try {
    await runStop(process.argv.slice(3));
    process.exit(0);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}

let values: ReturnType<typeof parseCli>;
try {
  values = parseCli();
} catch (error) {
  console.error(`${(error as Error).message}\n\n${HELP}`);
  process.exit(1);
}

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (values.version) {
  console.log(version);
  process.exit(0);
}

const portValue = values.port ?? process.env.CAPYBARA_PORT;
const port = readPort(portValue, true);
if (port === undefined) {
  console.error(`Invalid port: ${portValue}`);
  process.exit(1);
}

const metroPorts: number[] = [];
for (const value of values.metro ? (values['metro-port'] ?? DEFAULT_METRO_PORTS.map(String)) : []) {
  const metroPort = Number(value);
  if (!Number.isInteger(metroPort) || metroPort <= 0 || metroPort > 65_535) {
    console.error(`Invalid Metro port: ${value}`);
    process.exit(1);
  }
  metroPorts.push(metroPort);
}

const flutterUris = values['flutter-vm-service'] ?? [];
for (const uri of flutterUris) {
  if (!isLoopbackVmUri(uri)) {
    console.error(`Invalid Dart VM service address: ${redactVmUri(uri)} (only http or ws addresses on this computer)`);
    process.exit(1);
  }
}

/** Set in the process `--background` starts, which has no terminal. */
const backgroundLog = values.background ? process.env[BACKGROUND_LOG] : undefined;
if (values.background && backgroundLog === undefined) await runInBackground(process.argv.slice(2));

let announced: string | undefined;
const checkLatest = async () => {
  const latest = await fetchLatestVersions();
  const newest = latest?.[CLI_PACKAGE];
  if (newest && newest !== announced && isNewerVersion(newest, version)) {
    announced = newest;
    console.log(`  Capybara ${newest} is available (this is ${version}). Run npx ${CLI_PACKAGE}@latest to use it.\n`);
  }
  return latest;
};

const remoteUi = remoteUiFrom(process.env, values['remote-ui']);
const uiDir = fileURLToPath(new URL('./ui/', import.meta.url));
// What the CLI in a terminal recorded, when it moves here on b.
const recorded = await receiveSessions();
let started: Started;
try {
  started = await startOrReuse({
    port,
    host: values.host,
    uiDir: existsSync(uiDir) ? uiDir : undefined,
    allowedOrigins: values['allow-origin'] ?? [],
    remoteUi,
    onHint: (hint) => console.log(`  ${hint}\n`),
    version,
    latestVersions: updateCheckFrom(process.env, values['update-check']) ? checkLatest : undefined,
    onStop: () => {
      console.log('  Stopped by capybara stop.\n');
      shutdown();
    },
    sessions: recorded,
    log: backgroundLog,
  });
} catch (error) {
  console.error(error instanceof PortInUseError ? `${error.message}. Choose another port with --port.` : error);
  process.exit(1);
}

if (!started.server) {
  // The desktop app or another `capybara` has the port; apps already reach it there.
  const url = `http://localhost:${started.port}`;
  console.log(`\n${alreadyRunning(url, started.port, started.running)}\n`);
  if (values.open) openBrowser(url);
  process.exit(0);
}

const { server, address } = started;
const keys = backgroundLog === undefined && isatty(0) && inForeground();
printBanner(started.port, address);
reverseAndroidPorts(started.port);
let metroBridge: MetroBridge | undefined;
if (metroPorts.length > 0) {
  metroBridge = startMetroBridge({ port: started.port, metroPorts, version, onHint: (hint) => server.hint(hint) });
}
let flutterBridge: FlutterBridge | undefined;
if (values.flutter || flutterUris.length > 0) {
  flutterBridge = startFlutterBridge({
    port: started.port,
    version,
    vmServiceUris: flutterUris,
    scan: values.flutter,
    onHint: (hint) => server.hint(hint),
    addresses: () => reachableAddresses(started.address),
  });
  server.setFlutterAttach(flutterBridge.attach);
}
if (values.open) openBrowser(`http://${hostOf(address)}:${started.port}`);

const shutdown = () => {
  metroBridge?.stop();
  flutterBridge?.stop();
  void server.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
if (backgroundLog !== undefined) reportStarted();

if (keys) {
  process.stdin.setRawMode(true);
  process.stdin.on('data', (data: Buffer) => {
    const typed = data.toString();
    // Raw mode turns Ctrl+C into a key rather than SIGINT.
    if (typed.includes('\u0003')) shutdown();
    // Only on its own: the down arrow sends ESC [ B.
    else if (typed === 'b' || typed === 'B') void moveToBackground();
    // People press Enter to leave a gap in the output, which raw mode no longer prints.
    else if (/^\r+$/.test(typed)) process.stdout.write('\n'.repeat(typed.length));
  });
}

let moving = false;
/** A process cannot give the terminal back and go on, so a new one in the background takes over what this recorded. */
async function moveToBackground() {
  if (moving) return;
  moving = true;
  process.stdin.setRawMode(false);
  process.stdin.pause();
  console.log('  Moving to the background…');
  metroBridge?.stop();
  flutterBridge?.stop();
  // Appended, so they win over the command's own. No second browser tab, as the UI reconnects on its own; the
  // same port, as apps know only that one, also when --port 0 picked it.
  const args = [...process.argv.slice(2), '--background', '--no-open', '--port', String(started.port)];
  // Apps with the SDK go on sending here meanwhile, and send it again to the new server, from where it took over.
  await runInBackground(args, { sessions: server.recorded(), release: () => server.close() });
}

/** Starts the server in a process of its own, then exits as that process did, with what it printed. */
async function runInBackground(args: string[], handover?: Handover): Promise<never> {
  try {
    const { output, code } = await startInBackground(fileURLToPath(import.meta.url), args, handover);
    (code ? process.stderr : process.stdout).write(output);
    process.exit(code ?? 0);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}

/** Whether this process has the terminal: one started with & that sets raw mode or reads it is stopped by the shell. */
function inForeground(): boolean {
  if (process.platform === 'win32') return true;
  try {
    const [terminal, own] = execFileSync('ps', ['-o', 'tpgid=,pgid=', '-p', String(process.pid)], { encoding: 'utf8' })
      .trim()
      .split(/\s+/);
    return terminal === own;
  } catch {
    return false;
  }
}

function parseCli() {
  return parseArgs({
    allowNegative: true,
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string' },
      open: { type: 'boolean', default: true },
      background: { type: 'boolean', default: false },
      'allow-origin': { type: 'string', multiple: true },
      'remote-ui': { type: 'boolean', default: false },
      metro: { type: 'boolean', default: true },
      'metro-port': { type: 'string', multiple: true },
      flutter: { type: 'boolean', default: true },
      'flutter-vm-service': { type: 'string', multiple: true },
      'update-check': { type: 'boolean', default: true },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  }).values;
}

function listensEverywhere(address: string): boolean {
  return address === '::' || address === '0.0.0.0';
}

/** How this machine reaches the server: through localhost, unless --host bound one address only. */
function hostOf(address: string): string {
  if (listensEverywhere(address)) return 'localhost';
  return address.includes(':') ? `[${address}]` : address;
}

/** `capybara stop` for the server on `port`, with the address it listens on when that is not every interface. */
function stopCommand(port: number, address?: string): string {
  let command = `npx ${CLI_PACKAGE} stop`;
  if (port !== DEFAULT_PORT) command += ` --port ${port}`;
  if (address && !listensEverywhere(address)) command += ` --host ${address}`;
  return command;
}

/** Says which Capybara has the port, e.g. one in the background that was forgotten, maybe of another version. */
function alreadyRunning(url: string, port: number, running: ServerInfo): string {
  const other = running.version !== version ? running.version : undefined;
  // `stop` is false for the desktop app, and missing from servers before 0.7.0, which may be either.
  const stop = running.stop === false ? 'quit the desktop app' : `${stopCommand(port)}${running.stop ? '' : ', or quit the desktop app'}`;
  const lines = [
    `Capybara${other ? ` ${other}` : ''} is already running${running.log ? ' in the background' : ''} at ${url}${other ? `, and this is ${version}` : ''}.`,
    `Stop it first (${stop}) to start ${other ? version : 'one'} with these options.`,
  ];
  if (running.log) lines.push(`Its log: ${running.log}`);
  return lines.map((line) => `  ${line}`).join('\n');
}

function printBanner(actualPort: number, address: string) {
  const title = `  Capybara ${version}${backgroundLog === undefined ? '' : ', in the background'}`;
  const lines = ['', title, '', `  UI        http://${hostOf(address)}:${actualPort}`];
  const reachable = reachableAddresses(address);
  if (remoteUi) {
    for (const lan of reachable) lines.push(`  Network   http://${lan}:${actualPort}`);
    if (reachable.length > 0) lines.push('            Anyone on this network can open it and see everything apps send, tokens included.');
  } else if (reachable.length > 0) {
    // As Vite says "use --host to expose": the flag is easy to miss in --help.
    lines.push('  Network   use --remote-ui to open the UI on other devices');
  }
  if (metroPorts.length > 0) {
    const ports = metroPorts.map((p) => `localhost:${p}`).join(', ');
    lines.push(`  Metro     ${ports} (React Native apps show up without the SDK)`);
  }
  if (values.flutter) lines.push('  Flutter   apps started with flutter run show up without a package');
  if (backgroundLog === undefined) {
    // An assistant that started this in the background reads the banner from a log, with no terminal to press Ctrl+C in.
    lines.push(`  Stop      Ctrl+C, or ${stopCommand(actualPort, address)} from another terminal`);
    if (keys) lines.push('  Keys      b  keep it running in the background and give the terminal back');
  } else {
    lines.push(`  Log       ${backgroundLog}`, `  Stop      ${stopCommand(actualPort, address)}`);
  }
  const machine = listensEverywhere(address) ? '<this machine>' : hostOf(address);
  lines.push('', `  Apps connect to ws://${machine}:${actualPort}/client (React Native finds it through Metro).`, '');
  console.log(lines.join('\n'));
}

function openBrowser(url: string) {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  const child = spawn(command as string, args as string[], { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}
