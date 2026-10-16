// Headless Google Chrome driven over the DevTools protocol, with a throwaway profile.
// Set CHROME to its executable if it is not in the default macOS location.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(check, what, timeout = 10_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await delay(100);
  }
}

export async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'capybara-site-chrome-'));
  const chrome = spawn(
    CHROME,
    ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank'],
    { stdio: 'ignore' },
  );
  const exited = new Promise((resolve) => chrome.once('exit', resolve));
  const close = async () => {
    chrome.kill();
    // Chrome keeps writing to its profile while it shuts down.
    await exited;
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  try {
    const port = await until(() => {
      try {
        return Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      } catch {
        return 0;
      }
    }, 'Chrome to start', 20_000);
    return {
      async newPage() {
        const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
        return connect(target.webSocketDebuggerUrl);
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.on('message', (data) => {
    const message = JSON.parse(String(data));
    if (message.method) for (const listener of listeners.get(message.method) ?? []) listener(message.params);
    const call = message.id && pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.error) call.reject(new Error(`${call.method}: ${message.error.message}`));
    else call.resolve(message.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject, method });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };

  return {
    send,
    evaluate,
    /** Listens to a DevTools protocol event, e.g. `Fetch.requestPaused`. */
    on(method, listener) {
      listeners.set(method, [...(listeners.get(method) ?? []), listener]);
    },
    /** Window size, pixel density, color scheme, and a fixed clock zone and locale so captures repeat exactly. */
    async emulate({ width, height, scale = 1, dark = false }) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
      await send('Emulation.setEmulatedMedia', {
        features: [
          { name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' },
          { name: 'prefers-reduced-motion', value: 'reduce' },
        ],
      });
      await send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
      await send('Emulation.setLocaleOverride', { locale: 'en-US' });
    },
    async goto(url) {
      await send('Page.navigate', { url });
      await until(() => evaluate(`location.href !== 'about:blank' && document.readyState === 'complete'`), `${url} to load`);
      await evaluate('document.fonts.ready.then(() => true)');
    },
    /** Waits for a selector, optionally containing some text, and clicks it. */
    async click(selector, text) {
      const expression = `(() => {
        const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
          .find((candidate) => ${text === undefined ? 'true' : `candidate.textContent.includes(${JSON.stringify(text)})`});
        element?.click();
        return Boolean(element);
      })()`;
      await until(() => evaluate(expression), `${selector}${text ? ` "${text}"` : ''}`);
    },
    async waitFor(selector) {
      await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), selector);
    },
    async capture({ format = 'webp', quality = 90, fullPage = false } = {}) {
      const { data } = await send('Page.captureScreenshot', { format, quality: format === 'png' ? undefined : quality, captureBeyondViewport: fullPage });
      return Buffer.from(data, 'base64');
    },
    close: () => socket.close(),
  };
}
