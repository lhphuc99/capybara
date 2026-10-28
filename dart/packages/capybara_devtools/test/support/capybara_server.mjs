// Capybara's real server for the contract test: prints {"port"} once, then each message a viewer gets as a JSON line,
// and sends each JSON line read from stdin as a viewer.
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const serverJs = fileURLToPath(new URL('../../../../../packages/cli/dist/server.js', import.meta.url));
const { createServer } = await import(serverJs);

const server = createServer({ port: 0, host: '127.0.0.1' });
const { port } = await server.start();
const viewer = new WebSocket(`ws://127.0.0.1:${port}/viewer`, { headers: { origin: `http://127.0.0.1:${port}` } });
viewer.on('message', (data) => process.stdout.write(`${data.toString()}\n`));
viewer.on('open', () => process.stdout.write(`${JSON.stringify({ port })}\n`));

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim()) viewer.send(line);
});
process.stdin.on('end', async () => {
  viewer.close();
  await server.close();
  process.exit(0);
});
