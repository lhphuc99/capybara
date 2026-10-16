#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_PORT } from '@devsight/protocol';
import { reverseAndroidPorts } from './adb.js';
import { DEFAULT_METRO_PORTS, startMetroBridge, type MetroBridge } from './metro.js';
import { createServer, lanAddresses } from './server.js';

const HELP = `Usage: devsight [options]

Options:
  -p, --port <port>         Port for the UI and app connections (default ${DEFAULT_PORT}, or $DEVSIGHT_PORT)
      --host <address>      Address to bind (default: all interfaces)
      --no-open             Don't open the UI in a browser
      --allow-origin <url>  Extra origin allowed to open the UI socket, repeatable
      --metro-port <port>   Metro dev server to read React Native apps from, repeatable (default ${DEFAULT_METRO_PORTS.join(', ')})
      --no-metro            Only show apps that have the SDK
  -h, --help                Show this help
  -v, --version             Show the version
`;

const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string })
  .version;

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

const port = Number(values.port ?? process.env.DEVSIGHT_PORT ?? DEFAULT_PORT);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  console.error(`Invalid port: ${values.port ?? process.env.DEVSIGHT_PORT}`);
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

const uiDir = fileURLToPath(new URL('./ui/', import.meta.url));
const server = createServer({
  port,
  host: values.host,
  uiDir: existsSync(uiDir) ? uiDir : undefined,
  allowedOrigins: values['allow-origin'] ?? [],
  version,
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
    console.error(`Port ${port} is already in use. Is Devsight already running? Choose another port with --port.`);
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
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  }).values;
}

function printBanner(actualPort: number) {
  const lines = ['', `  Devsight ${version}`, '', `  UI        http://localhost:${actualPort}`];
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
