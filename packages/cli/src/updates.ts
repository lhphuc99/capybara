import { CLI_PACKAGE, PUB_PACKAGES, SDK_PACKAGES, type LatestVersions } from '@capybara-devtools/protocol';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
const DEFAULT_PUB = 'https://pub.dev';
const TIMEOUT_MS = 5_000;

/**
 * Looks up the newest CLI and SDK versions on the npm registry (the one npm is configured with,
 * when run through npm), and the Flutter package's on pub.dev (or `PUB_HOSTED_URL`, as pub does).
 * Resolves to undefined when none could be read, e.g. offline: a failed check must never get in the way.
 */
export async function fetchLatestVersions(
  registry = process.env.npm_config_registry || DEFAULT_REGISTRY,
  fetchImpl: typeof fetch = fetch,
  pubHost = process.env.PUB_HOSTED_URL || DEFAULT_PUB,
): Promise<LatestVersions | undefined> {
  const base = registry.endsWith('/') ? registry : `${registry}/`;
  const pub = pubHost.replace(/\/+$/, '');
  const lookup = async (name: string, url: string, version: (body: unknown) => unknown) => {
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) return undefined;
      const found = version(await response.json());
      return typeof found === 'string' ? ([name, found] as const) : undefined;
    } catch {
      return undefined;
    }
  };
  const found = await Promise.all([
    ...[CLI_PACKAGE, ...SDK_PACKAGES].map((name) =>
      lookup(name, `${base}${name.replace('/', '%2f')}/latest`, (body) => (body as { version?: unknown } | null)?.version),
    ),
    // A package not published yet answers 404, which reads as nothing to report.
    ...PUB_PACKAGES.map((name) =>
      lookup(name, `${pub}/api/packages/${name}`, (body) => (body as { latest?: { version?: unknown } } | null)?.latest?.version),
    ),
  ]);
  const latest = Object.fromEntries(found.filter((entry) => entry !== undefined));
  return Object.keys(latest).length > 0 ? latest : undefined;
}
