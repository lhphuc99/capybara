import { CLI_PACKAGE, SDK_PACKAGES, type LatestVersions } from '@capybara-devtools/protocol';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
const TIMEOUT_MS = 5_000;

/**
 * Looks up the newest CLI and SDK versions on the npm registry (the one npm is configured with,
 * when run through npm). Resolves to undefined when none could be read, e.g. offline: a failed
 * check must never get in the way.
 */
export async function fetchLatestVersions(
  registry = process.env.npm_config_registry || DEFAULT_REGISTRY,
  fetchImpl: typeof fetch = fetch,
): Promise<LatestVersions | undefined> {
  const base = registry.endsWith('/') ? registry : `${registry}/`;
  const found = await Promise.all(
    [CLI_PACKAGE, ...SDK_PACKAGES].map(async (name): Promise<[string, string] | undefined> => {
      try {
        const response = await fetchImpl(`${base}${name.replace('/', '%2f')}/latest`, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) return undefined;
        const { version } = (await response.json()) as { version?: unknown };
        return typeof version === 'string' ? [name, version] : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  const latest = Object.fromEntries(found.filter((entry) => entry !== undefined));
  return Object.keys(latest).length > 0 ? latest : undefined;
}
