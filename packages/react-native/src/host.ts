/** Host of a URL (IPv6 keeps its brackets), or undefined for host-less URLs such as file:// bundles. */
export function hostFromUrl(url: string): string | undefined {
  return /^[a-z][a-z\d+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]+)/i.exec(url)?.[1];
}

/** Explicit port of a URL, or undefined when it has none. */
export function portFromUrl(url: string): string | undefined {
  return /^[a-z][a-z\d+.-]*:\/\/(?:[^@/?#]*@)?(?:\[[^\]]+\]|[^:/?#]+):(\d+)/i.exec(url)?.[1];
}

/**
 * Sockets of dev tools: Metro's own (HMR, inspector) on the bundle's port, React DevTools (8097) and
 * Reactotron (9090). React Native opens some of them with an http:// URL, so both schemes match.
 */
export function devToolSockets(metroPort: string | undefined): RegExp[] {
  const patterns = [/^(?:wss?|https?):\/\/[^/]+:(?:8097|9090)(?:\/|$)/];
  if (metroPort) {
    patterns.push(new RegExp(`^(?:wss?|https?)://[^/]+:${metroPort}/(?:hot|message|events|inspector|debugger-proxy)(?:[/?]|$)`));
  }
  return patterns;
}
