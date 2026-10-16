/** Host of a URL (IPv6 keeps its brackets), or undefined for host-less URLs such as file:// bundles. */
export function hostFromUrl(url: string): string | undefined {
  return /^[a-z][a-z\d+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]+)/i.exec(url)?.[1];
}

export function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}
