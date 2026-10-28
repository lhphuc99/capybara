// Release versions: the server looks up the newest ones on npm, the UI says what is out of date.

/** The npm package of the CLI. */
export const CLI_PACKAGE = 'capybara-devtools';
/** The SDK packages. Each sends its package name as `sdk.name`. */
export const SDK_PACKAGES = ['@capybara-devtools/web', '@capybara-devtools/react-native'] as const;
/**
 * The Flutter package on pub.dev, which sends its name as `sdk.name`. It has versions of its own, so unlike the
 * npm packages it is never compared with the server's version.
 */
export const PUB_PACKAGES = ['capybara_devtools'] as const;

export function isPubPackage(name: string): boolean {
  return (PUB_PACKAGES as readonly string[]).includes(name);
}

/**
 * Newest published version by package name, e.g. `{ 'capybara-devtools': '0.2.0' }`: npm names, and pub.dev
 * names for the Flutter package (with underscores, so the two never collide).
 */
export type LatestVersions = Record<string, string>;

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Semver order: negative when `a` is older than `b`. Undefined when either is not a version. */
export function compareVersions(a: string, b: string): number | undefined {
  const x = SEMVER.exec(a.trim());
  const y = SEMVER.exec(b.trim());
  if (!x || !y) return undefined;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(x[i]) - Number(y[i]);
    if (diff !== 0) return Math.sign(diff);
  }
  return comparePrerelease(x[4], y[4]);
}

/** True only when both are versions and `candidate` is the newer one. */
export function isNewerVersion(candidate: string | undefined, current: string | undefined): boolean {
  if (candidate === undefined || current === undefined) return false;
  return (compareVersions(candidate, current) ?? 0) > 0;
}

function comparePrerelease(a: string | undefined, b: string | undefined): number {
  // 1.0.0-beta comes before 1.0.0.
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1;
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const p = left[i];
    const q = right[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pNumeric = /^\d+$/.test(p);
    const qNumeric = /^\d+$/.test(q);
    if (pNumeric && qNumeric) return Math.sign(Number(p) - Number(q));
    if (pNumeric !== qNumeric) return pNumeric ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}
