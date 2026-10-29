import { parseArgs } from 'node:util';
import { DEFAULT_PORT, VIEWER_PATH, type ServerInfo, type ServerToViewer, type ViewerToServer } from '@capybara-devtools/protocol';
import { WebSocket, type RawData } from 'ws';
import { readPort } from './config.js';

const HELP = `Usage: capybara stop [options]

Stops the Capybara server running on this computer, as Ctrl+C in its terminal would, e.g. one an AI assistant started
in the background. The desktop app is quit from its menu instead.

Options:
  -p, --port <port>     Port of the Capybara server (default ${DEFAULT_PORT}, or $CAPYBARA_PORT)
      --host <address>  Its address, when it was started with --host (default localhost)
  -h, --help            Show this help
`;

/** For the server to greet and then to stop once asked. */
const TIMEOUT_MS = 5_000;

export async function runStop(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const port = readPort(values.port ?? process.env.CAPYBARA_PORT, false);
  if (port === undefined) throw new Error(`Invalid port: ${values.port ?? process.env.CAPYBARA_PORT}`);
  console.log(await stopServer(port, values.host));
}

/**
 * Asks the Capybara server at `host` to stop and waits until it has. Resolves to what to tell the user, also when
 * nothing runs there; rejects with why the server still runs.
 */
export function stopServer(port: number, host = 'localhost', timeout = TIMEOUT_MS): Promise<string> {
  const address = `${host.includes(':') ? `[${host}]` : host}:${port}`;
  const otherProgram = () => new Error(`${address} is in use by a program other than Capybara.`);
  return new Promise((resolve, reject) => {
    // The server only lets its own origin in, the way a browser tab on it would.
    const ws = new WebSocket(`ws://${address}${VIEWER_PATH}`, { origin: `http://${address}` });
    let server: ServerInfo | undefined;
    let asked = false;
    const finish = (outcome: string | Error) => {
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on('error', () => {});
      ws.terminate();
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    // Closing is the answer that counts: the server lets go of its viewers as it stops.
    const stopped = () => `Stopped Capybara ${server!.version} on ${address}.`;
    const timer = setTimeout(
      () => finish(asked ? new Error(`Capybara on ${address} was asked to stop but still runs.`) : otherProgram()),
      timeout,
    );

    ws.on('error', (error: NodeJS.ErrnoException) => {
      if (asked) finish(stopped());
      else if (error.code === 'ECONNREFUSED') finish(`Capybara is not running on ${address}.`);
      else finish(new Error(`Could not reach ${address}: ${error.message}`));
    });
    ws.on('unexpected-response', (request, response) => {
      request.destroy();
      finish(
        response.statusCode === 403
          ? new Error(`Capybara on ${address} refused the connection. Run capybara stop on the computer it runs on.`)
          : otherProgram(),
      );
    });
    ws.on('message', (data) => {
      const message = parse(data);
      if (!server) {
        if (message?.t !== 'init') return finish(otherProgram());
        server = message.server;
        if (server.stop === undefined) return finish(new Error(tooOld(server.version, address, port)));
        asked = true;
        ws.send(JSON.stringify({ t: 'stop', id: 'stop' } satisfies ViewerToServer));
      } else if (message?.t === 'result' && message.id === 'stop' && !message.ok) {
        finish(new Error(`${message.error}.`));
      }
    });
    ws.on('close', () => finish(asked ? stopped() : otherProgram()));
  });
}

function tooOld(version: string, address: string, port: number): string {
  // Older servers take no stop message, so only their process can be ended.
  const kill = process.platform === 'win32' ? '' : ` Without that terminal: kill $(lsof -tiTCP:${port} -sTCP:LISTEN)`;
  return `Capybara ${version} on ${address} is too old for capybara stop. Press Ctrl+C in the terminal it runs in, or quit the desktop app.${kill}`;
}

function parse(data: RawData): ServerToViewer | undefined {
  try {
    return JSON.parse(data.toString()) as ServerToViewer;
  } catch {
    return undefined;
  }
}
