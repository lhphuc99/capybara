#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CLI_PACKAGE, DEFAULT_PORT, isNewerVersion } from '@capybara-devtools/protocol';
import { reverseAndroidPorts } from './adb.js';
import { DEFAULT_METRO_PORTS, startMetroBridge, type MetroBridge } from './metro.js';
import { createServer, lanAddresses } from './server.js';
import { fetchLatestVersions } from './updates.js';

const HELP = `Usage: capybara [options]
       capybara mcp [options]   Serve this data to AI assistants (see capybara mcp --help)

Options:
  -p, --port <port>         Port for the UI and app connections (default ${DEFAULT_PORT}, or $CAPYBARA_PORT)
      --host <address>      Address to bind (default: all interfaces)
      --no-open             Don't open the UI in a browser
      --allow-origin <url>  Extra origin allowed to open the UI socket, repeatable
      --metro-port <port>   Metro dev server to read React Native apps from, repeatable (default ${DEFAULT_METRO_PORTS.join(', ')})
      --no-metro            Only show apps that have the SDK
      --no-update-check     Don't look up newer versions on npm (or set $CAPYBARA_NO_UPDATE_CHECK)
  -h, --help                Show this help
  -v, --version             Show the version
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

const port = Number(values.port ?? process.env.CAPYBARA_PORT ?? DEFAULT_PORT);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  console.error(`Invalid port: ${values.port ?? process.env.CAPYBARA_PORT}`);
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

const uiDir = fileURLToPath(new URL('./ui/', import.meta.url));
const server = createServer({
  port,
  host: values.host,
  uiDir: existsSync(uiDir) ? uiDir : undefined,
  allowedOrigins: values['allow-origin'] ?? [],
  version,
  latestVersions: values['update-check'] && !process.env.CAPYBARA_NO_UPDATE_CHECK ? checkLatest : undefined,
});

let metroBridge: MetroBridge | undefined;

try {
  const { port: actual } = await server.start();
  printBanner(actual);
  reverseAndroidPorts(actual);
  if (metroPorts.length > 0) metroBridge = startMetroBridge({ port: actual, metroPorts, version });
  if (values.open) openBrowser(`http://localhost:${actual}`);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Is Capybara already running? Choose another port with --port.`);
  } else {
    console.error(error);
  }
  process.exit(1);
}

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
      metro: { type: 'boolean', default: true },
      'metro-port': { type: 'string', multiple: true },
      'update-check': { type: 'boolean', default: true },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  }).values;
}

function printBanner(actualPort: number) {
  const lines = ['', `  Capybara ${version}`, '', `  UI        http://localhost:${actualPort}`];
  for (const address of lanAddresses()) lines.push(`  Network   http://${address}:${actualPort}`);
  if (metroPorts.length > 0) {
    const ports = metroPorts.map((p) => `localhost:${p}`).join(', ');
    lines.push(`  Metro     ${ports} (React Native apps show up without the SDK)`);
  }
  lines.push('', `  Apps connect to ws://<this machine>:${actualPort}/client (React Native finds it through Metro).`, '');
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
