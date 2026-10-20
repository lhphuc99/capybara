#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CLI_PACKAGE, DEFAULT_PORT, isNewerVersion } from '@capybara-devtools/protocol';
import { reverseAndroidPorts } from './adb.js';
import { DEFAULT_METRO_PORTS, startMetroBridge, type MetroBridge } from './metro.js';
import { readPort, remoteUiFrom, updateCheckFrom } from './config.js';
import { reachableAddresses } from './server.js';
import { PortInUseError, startOrReuse, type Started } from './start.js';
import { fetchLatestVersions } from './updates.js';

const HELP = `Usage: capybara [options]
       capybara mcp [options]          Serve this data to AI assistants (see capybara mcp --help)
       capybara setup-guide [folder]   Print how to add Capybara to an app, for AI assistants

Options:
  -p, --port <port>         Port for the UI and app connections (default ${DEFAULT_PORT}, or $CAPYBARA_PORT)
      --host <address>      Address to bind (default: all interfaces)
      --remote-ui           Let other devices open the UI, which shows everything apps send, tokens included (or set $CAPYBARA_REMOTE_UI=1)
      --no-open             Don't open the UI in a browser
      --allow-origin <url>  Extra origin allowed to open the UI socket, repeatable
      --metro-port <port>   Metro dev server to read React Native apps from, repeatable (default ${DEFAULT_METRO_PORTS.join(', ')})
      --no-metro            Only show apps that have the SDK
      --no-update-check     Don't look up newer versions on npm (or set $CAPYBARA_NO_UPDATE_CHECK)
  -h, --help                Show this help
  -v, --version             Show the version

Set $CAPYBARA_DEBUG=1 to print what goes wrong when reading apps through Metro, e.g. why one does not show up.
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
  });
} catch (error) {
  console.error(error instanceof PortInUseError ? `${error.message}. Choose another port with --port.` : error);
  process.exit(1);
}

if (!started.server) {
  // The desktop app or another `capybara` has the port; apps already reach it there.
  const url = `http://localhost:${started.port}`;
  console.log(`\n  Capybara is already running at ${url}. Quit it first to start one with these options.\n`);
  if (values.open) openBrowser(url);
  process.exit(0);
}

const { server, address } = started;
printBanner(started.port, address);
reverseAndroidPorts(started.port);
let metroBridge: MetroBridge | undefined;
if (metroPorts.length > 0) {
  metroBridge = startMetroBridge({ port: started.port, metroPorts, version, onHint: (hint) => server.hint(hint) });
}
if (values.open) openBrowser(`http://${hostOf(address)}:${started.port}`);

const shutdown = () => {
  metroBridge?.stop();
  void server.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function parseCli() {
  return parseArgs({
    allowNegative: true,
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string' },
      open: { type: 'boolean', default: true },
      'allow-origin': { type: 'string', multiple: true },
      'remote-ui': { type: 'boolean', default: false },
      metro: { type: 'boolean', default: true },
      'metro-port': { type: 'string', multiple: true },
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

function printBanner(actualPort: number, address: string) {
  const lines = ['', `  Capybara ${version}`, '', `  UI        http://${hostOf(address)}:${actualPort}`];
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
