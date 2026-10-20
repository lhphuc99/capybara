import { DEFAULT_PORT } from '@capybara-devtools/protocol';

/**
 * A port from `--port` or `CAPYBARA_PORT`, read alike by the CLI, `capybara mcp` and the desktop app: unset or empty
 * means the default. Undefined when the value is not a port; 0, for any free port, only where `allowAny`.
 */
export function readPort(value: string | undefined, allowAny: boolean): number | undefined {
  if (value === undefined || value.trim() === '') return DEFAULT_PORT;
  const port = Number(value);
  return Number.isInteger(port) && port >= (allowAny ? 0 : 1) && port <= 65_535 ? port : undefined;
}

/** `--remote-ui`, or `CAPYBARA_REMOTE_UI=1` for the desktop app, which takes no flags. */
export function remoteUiFrom(env: NodeJS.ProcessEnv, flag = false): boolean {
  return flag || env.CAPYBARA_REMOTE_UI === '1';
}

/** Off with `--no-update-check` or `CAPYBARA_NO_UPDATE_CHECK`. */
export function updateCheckFrom(env: NodeJS.ProcessEnv, flag = true): boolean {
  return flag && !env.CAPYBARA_NO_UPDATE_CHECK;
}
