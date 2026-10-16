import { parseArgs } from 'node:util';
import { DEFAULT_PORT } from '@capybara-devtools/protocol';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ViewerConnection } from './mcp-connection.js';
import {
  adapterLine,
  diagnosisText,
  filterLogs,
  filterMessages,
  filterRequests,
  logText,
  messageLine,
  newest,
  pickSession,
  readEvents,
  redactor,
  requestDetail,
  requestLine,
  sessionHeader,
  sessionLine,
  storageEntryLines,
  storageEntryText,
  type RequestEntry,
} from './mcp-data.js';

const INSTRUCTIONS = `Capybara records what a React Native or web app in development is doing: console logs, network requests (fetch, XHR, WebSocket) and storage (localStorage, sessionStorage, cookies, AsyncStorage, MMKV). These tools read the Capybara server running on this computer.

Tools use the newest connected app unless you pass a session id from list_sessions. Ids from get_network work with get_request, get_websocket and diagnose_request. Lists show the newest entries; pass "after" with the last seq you saw to get only newer ones, or "before" to page back. Values that look like credentials (Authorization, cookies, tokens, passwords) are hidden.`;

const HELP = `Usage: capybara mcp [options]

Serves the data of a running Capybara (the app or \`npx capybara-devtools\`) to AI assistants over MCP, on stdin and stdout.

Options:
  -p, --port <port>   Port of the Capybara server (default ${DEFAULT_PORT}, or $CAPYBARA_PORT)
      --host <host>   Its address (default 127.0.0.1)
      --show-secrets  Don't hide values that look like credentials
  -h, --help          Show this help

Claude Code:  claude mcp add capybara -- npx capybara-devtools mcp
`;

export interface McpOptions {
  version: string;
  /** Hand credentials to the assistant as they are; off by default. */
  showSecrets?: boolean;
}

const session = z.string().optional().describe('Session id from list_sessions. Defaults to the newest connected app.');
const limit = (fallback: number, max: number) =>
  z.number().int().min(1).max(max).optional().describe(`How many of the newest matches to return (default ${fallback}, at most ${max}).`);
const after = z.number().int().optional().describe('Only entries after this seq, e.g. the last seq you saw.');
const before = z.number().int().optional().describe('Only entries before this seq, to page back through older ones.');
const search = z.string().optional().describe('Text to find, case-insensitive, or /pattern/flags for a regular expression.');

export function createMcpServer(connection: ViewerConnection, options: McpOptions): McpServer {
  const server = new McpServer({ name: 'capybara', version: options.version }, { instructions: INSTRUCTIONS });
  const redact = redactor(!options.showSecrets);
  const reads = { readOnlyHint: true, openWorldHint: false } as const;

  const run = (produce: () => Promise<string>) =>
    produce().then(
      (text) => ({ content: [{ type: 'text' as const, text }] }),
      (error: unknown) => ({ content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true }),
    );
  const open = async (id: string | undefined) => {
    const { sessions } = await connection.listSessions();
    const meta = pickSession(sessions, id);
    return { meta, ...readEvents(await connection.history(meta.info.id)) };
  };
  const findRequest = (requests: RequestEntry[], id: string) => {
    const entry = requests.find((request) => request.id === id);
    if (!entry) throw new Error(`There is no request ${id} in this session. get_network lists the ids.`);
    return entry;
  };

  server.registerTool(
    'list_sessions',
    {
      title: 'List apps',
      description: 'Lists the apps connected to Capybara, newest first, with their session ids.',
      annotations: reads,
    },
    () =>
      run(async () => {
        const { server: info, sessions } = await connection.listSessions();
        const sorted = [...sessions].sort((a, b) => Number(b.connected) - Number(a.connected) || b.info.startedAt - a.info.startedAt);
        const header = `Capybara ${info.version} on port ${info.port}.`;
        if (sorted.length === 0) return `${header} No app has connected yet.`;
        // Reloads leave many closed sessions behind; only the recent ones with data are worth reading.
        const shown = [...sorted.filter((meta) => meta.connected), ...sorted.filter((meta) => !meta.connected && meta.eventCount > 0).slice(0, 5)];
        const hidden = sorted.length - shown.length;
        const lines = [header, 'Sessions, newest first:', ...shown.map(sessionLine)];
        if (hidden > 0) lines.push(`${hidden} older or empty disconnected sessions not listed.`);
        return lines.join('\n');
      }),
  );

  server.registerTool(
    'get_logs',
    {
      title: 'Read logs',
      description:
        'Reads console logs, uncaught errors and unhandled promise rejections, newest last. Pass seq to read one entry in full, with its objects and stack.',
      inputSchema: {
        session,
        level: z.array(z.enum(['error', 'warn', 'info', 'log', 'debug'])).optional().describe('Only these levels.'),
        search,
        source: z
          .enum(['console', 'uncaught', 'unhandledrejection', 'api'])
          .optional()
          .describe('uncaught: thrown errors nothing caught. unhandledrejection: rejected promises nothing handled.'),
        seq: z.number().int().optional().describe('Read this entry in full.'),
        after,
        before,
        limit: limit(50, 500),
      },
      annotations: reads,
    },
    (args) =>
      run(async () => {
        const { meta, logs } = await open(args.session);
        if (args.seq !== undefined) {
          const entry = logs.find((log) => log.seq === args.seq);
          if (!entry) throw new Error(`There is no log entry #${args.seq} in this session.`);
          return `${sessionHeader(meta)}\n${logText(entry, redact, true)}`;
        }
        const matched = filterLogs(logs, args, redact);
        const { shown, omitted } = newest(matched, args.limit ?? 50);
        const lines = [`${sessionHeader(meta)}: ${matched.length} of ${logs.length} log entries match.`];
        if (omitted > 0) lines.push(`Showing the newest ${shown.length}; pass before: ${shown[0]!.seq} for older ones.`);
        lines.push(...shown.map((entry) => logText(entry, redact, false)));
        if (shown.length > 0) lines.push(`Pass seq for one entry in full, or after: ${shown.at(-1)!.seq} for newer ones.`);
        return lines.join('\n');
      }),
  );

  server.registerTool(
    'get_network',
    {
      title: 'List network requests',
      description:
        'Lists HTTP requests (fetch, XHR) and WebSocket connections, one line each: id, time, method, status, duration, type, URL, and why it failed.',
      inputSchema: {
        session,
        search: z.string().optional().describe('Text or /pattern/ matched against the method and URL.'),
        method: z.string().optional().describe('Only this method, e.g. POST.'),
        status: z
          .string()
          .optional()
          .describe('A status (404), a class (4xx, 5xx), "failed" for requests that got no response, or "pending".'),
        errors: z.boolean().optional().describe('Only failed requests and responses with status 400 or above.'),
        type: z.enum(['fetch', 'xhr', 'websocket', 'image', 'other']).optional().describe('Only this kind of request.'),
        minDuration: z.number().optional().describe('Only requests that took at least this many milliseconds.'),
        after,
        before,
        limit: limit(50, 500),
      },
      annotations: reads,
    },
    (args) =>
      run(async () => {
        const { meta, requests } = await open(args.session);
        const matched = filterRequests(requests, args, redact);
        const { shown, omitted } = newest(matched, args.limit ?? 50);
        const lines = [`${sessionHeader(meta)}: ${matched.length} of ${requests.length} requests match.`];
        if (omitted > 0) lines.push(`Showing the newest ${shown.length}; pass before: ${shown[0]!.seq} for older ones.`);
        if (shown.length > 0) lines.push('id  time  method  status  duration  type  url', ...shown.map((entry) => requestLine(entry, redact)));
        return lines.join('\n');
      }),
  );

  server.registerTool(
    'get_request',
    {
      title: 'Read a request',
      description: 'Reads one request in full: URL, status, timing, headers, bodies, and why it failed.',
      inputSchema: {
        session,
        id: z.string().describe('Request id from get_network.'),
        body: z
          .enum(['none', 'preview', 'full'])
          .optional()
          .describe('How much of each body to include: none, preview (first 4,000 characters, the default) or full.'),
      },
      annotations: reads,
    },
    (args) =>
      run(async () => {
        const { meta, requests } = await open(args.session);
        return `${sessionHeader(meta)}\n${requestDetail(findRequest(requests, args.id), redact, args.body ?? 'preview')}`;
      }),
  );

  server.registerTool(
    'diagnose_request',
    {
      title: 'Find out why a request failed',
      description:
        "For a request a web page could not complete (CORS, DNS, refused connection, TLS, a blocked port), Capybara repeats its preflight and, for GET and HEAD, the request itself from this computer, without the app's cookies or Authorization header, and applies the browser's rules. Other methods are not sent again; their server is asked with OPTIONS.",
      inputSchema: { session, id: z.string().describe('Id of a failed request from get_network.') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      run(async () => {
        const { meta, requests } = await open(args.session);
        const entry = findRequest(requests, args.id);
        if (entry.socket) throw new Error('WebSocket connections cannot be diagnosed; get_websocket shows their error and close code.');
        return `${sessionHeader(meta)}\n${diagnosisText(entry, await connection.diagnose(meta.info.id, entry.id), redact)}`;
      }),
  );

  server.registerTool(
    'get_websocket',
    {
      title: 'Read WebSocket messages',
      description: 'Reads the messages of one WebSocket connection, sent and received, newest last.',
      inputSchema: {
        session,
        id: z.string().describe('WebSocket id from get_network (type websocket).'),
        direction: z.enum(['sent', 'received']).optional().describe('Only messages in this direction.'),
        search,
        after,
        limit: limit(50, 1000),
      },
      annotations: reads,
    },
    (args) =>
      run(async () => {
        const { meta, requests } = await open(args.session);
        const entry = findRequest(requests, args.id);
        if (!entry.socket) throw new Error(`${args.id} is an HTTP request; get_request reads it.`);
        const matched = filterMessages(entry.socket.messages, args, redact);
        const { shown, omitted } = newest(matched, args.limit ?? 50);
        const lines = [
          sessionHeader(meta),
          requestLine(entry, redact),
          `${matched.length} of ${entry.socket.messages.length} messages match.${omitted > 0 ? ` Showing the newest ${shown.length}.` : ''}`,
          ...shown.map((message) => messageLine(message, redact)),
        ];
        return lines.join('\n');
      }),
  );

  server.registerTool(
    'get_storage',
    {
      title: 'Read storage',
      description:
        'Reads the app\'s storage: without adapter, lists the stores (localStorage, sessionStorage, cookies, AsyncStorage, MMKV); with adapter, its keys and values; with key, one value in full. The app must be connected.',
      inputSchema: {
        session,
        adapter: z.string().optional().describe('Store id from the list, e.g. localStorage.'),
        key: z.string().optional().describe('Read this key\'s full value.'),
        search: z.string().optional().describe('Text or /pattern/ matched against keys and values.'),
        limit: limit(100, 1000),
      },
      annotations: reads,
    },
    (args) =>
      run(async () => {
        const { sessions } = await connection.listSessions();
        const meta = pickSession(sessions, args.session);
        const id = meta.info.id;
        if (!meta.connected) throw new Error(`${sessionHeader(meta)} is not connected, so its storage cannot be read.`);
        if (!args.adapter) {
          const adapters = await connection.storage(id, 'list', undefined);
          const totals = await Promise.all(
            adapters.map((adapter) => connection.storage(id, 'entries', { adapter: adapter.id }).then((listing) => listing.total, () => undefined)),
          );
          if (adapters.length === 0) return `${sessionHeader(meta)} has no storage Capybara can read.`;
          return [`${sessionHeader(meta)} storage:`, ...adapters.map((adapter, index) => adapterLine(adapter, totals[index]))].join('\n');
        }
        if (args.key !== undefined) {
          const entry = await connection.storage(id, 'get', { adapter: args.adapter, key: args.key });
          if (!entry) throw new Error(`${args.adapter} has no key ${args.key}.`);
          return `${sessionHeader(meta)} · ${args.adapter}\n${storageEntryText(entry, redact)}`;
        }
        const listing = await connection.storage(id, 'entries', { adapter: args.adapter });
        const { lines, matched } = storageEntryLines(listing, redact, args.search);
        const max = args.limit ?? 100;
        const header = `${sessionHeader(meta)} · ${args.adapter}: ${matched} of ${listing.total} keys match${listing.entries.length < listing.total ? ` (the app sent ${listing.entries.length})` : ''}.`;
        return [header, ...lines.slice(0, max), ...(lines.length > max ? [`${lines.length - max} more; narrow it with search.`] : [])].join('\n');
      }),
  );

  return server;
}

/** `capybara mcp`: an MCP server on stdin and stdout, for the assistant that started it. */
export async function runMcp(argv: string[], version: string): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string' },
      'show-secrets': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const port = Number(values.port ?? process.env.CAPYBARA_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`Invalid port: ${values.port ?? process.env.CAPYBARA_PORT}`);
  const host = values.host ?? '127.0.0.1';
  const connection = new ViewerConnection(port, host);
  const server = createMcpServer(connection, { version, showSecrets: values['show-secrets'] });
  // stdout carries the protocol, so anything for people goes to stderr.
  console.error(`Capybara MCP server, reading http://${host}:${port}`);
  await server.connect(new StdioServerTransport());
  await new Promise<void>((resolve) => {
    process.stdin.once('end', resolve);
    process.stdin.once('close', resolve);
  });
  connection.close();
  await server.close();
}
