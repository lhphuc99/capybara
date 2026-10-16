import { isIP } from 'node:net';

/** Hostname from a Host header, without the port or IPv6 brackets. */
export function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']');
    return end > 0 ? hostHeader.slice(1, end) : hostHeader;
  }
  const colon = hostHeader.lastIndexOf(':');
  return colon >= 0 ? hostHeader.slice(0, colon) : hostHeader;
}

/**
 * Only localhost names and raw IPs are accepted. A site that re-points its own domain at this
 * machine (DNS rebinding) would otherwise pass the same-origin check below.
 */
export function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const name = hostnameOf(hostHeader).toLowerCase();
  return name === 'localhost' || name.endsWith('.localhost') || isIP(name) !== 0;
}

/**
 * The viewer socket streams everything the apps log, tokens included, so only the UI served by
 * this server (or an origin passed with --allow-origin) may open it. Any page in the developer's
 * browser could otherwise connect to localhost and read it.
 */
export function isAllowedViewerOrigin(
  origin: string | undefined,
  hostHeader: string | undefined,
  extraOrigins: readonly string[],
): boolean {
  if (!origin || !hostHeader) return false;
  if (extraOrigins.includes(origin)) return true;
  try {
    return new URL(origin).host === hostHeader.toLowerCase();
  } catch {
    return false;
  }
}
