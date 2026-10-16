import { CLI_PACKAGE, METRO_SDK, SDK_PACKAGES, isNewerVersion, type ServerInfo, type SessionInfo } from '@capybara-devtools/protocol';

export interface UpdateNotice {
  /** Dismissing hides the notice until a newer version comes out. */
  key: string;
  text: string;
  /** What to run to update, offered with a copy button. */
  command: string;
}

/**
 * The selected app's SDK comes first, then the CLI. The desktop app updates itself, so it never
 * gets the CLI notice. Without an npm lookup an SDK is still compared with the server, since
 * every Capybara package is released at the same version.
 */
export function updateNotice(
  server: ServerInfo | undefined,
  session: SessionInfo | undefined,
  inDesktop: boolean,
  dismissed: ReadonlySet<string>,
): UpdateNotice | undefined {
  if (!server) return undefined;
  const notices: UpdateNotice[] = [];

  const sdk = session?.sdk;
  if (sdk && sdk.name !== METRO_SDK && (SDK_PACKAGES as readonly string[]).includes(sdk.name)) {
    const newest = server.latest?.[sdk.name] ?? server.version;
    if (isNewerVersion(newest, sdk.version)) {
      notices.push({
        key: `${sdk.name}@${newest}`,
        text: `${session.appName} uses ${sdk.name} ${sdk.version}. Version ${newest} is out:`,
        command: `npm install ${sdk.name}@${newest}`,
      });
    }
  }

  const cli = server.latest?.[CLI_PACKAGE];
  if (!inDesktop && cli && isNewerVersion(cli, server.version)) {
    notices.push({
      key: `${CLI_PACKAGE}@${cli}`,
      text: `Capybara ${cli} is out (this is ${server.version}). Restart it with:`,
      command: `npx ${CLI_PACKAGE}@latest`,
    });
  }

  return notices.find((notice) => !dismissed.has(notice.key));
}
