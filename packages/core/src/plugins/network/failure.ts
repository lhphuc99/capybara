import type { NetworkErrorPayload } from '@capybara-devtools/protocol';
import { now } from '../../utils.js';

export type Explanation = Pick<NetworkErrorPayload, 'cause' | 'credentials'> & { message?: string };

export interface FailureExplainer {
  /** Runs `report` once the cause can be told, which in a browser may be a moment after the failure. */
  explain(url: string, credentials: boolean, report: (explanation: Explanation) => void): void;
  stop(): void;
}

/**
 * Browsers never tell a page why a request failed. What a page can know: whether it is offline,
 * whether the URL is mixed content, and CSP blocks, which arrive as `securitypolicyviolation`
 * events. Anything else cross-origin is reported as such for the Capybara server to diagnose.
 */
export function failureExplainer(): FailureExplainer {
  const g = globalThis as {
    location?: { href?: string; origin?: string; protocol?: string };
    navigator?: { onLine?: boolean; product?: string; userAgent?: string };
    document?: Pick<Document, 'addEventListener' | 'removeEventListener'>;
  };
  const page = g.location;
  if (!page?.href || !page.origin || page.origin === 'null' || g.navigator?.product === 'ReactNative') {
    return { explain: (_url, _credentials, report) => report({}), stop() {} };
  }
  const blocked: Array<{ origin: string; directive: string; at: number }> = [];
  const onViolation = (event: Event) => {
    const violation = event as SecurityPolicyViolationEvent;
    const directive = violation.effectiveDirective || violation.violatedDirective || '';
    if (!/^(connect-src|default-src)/.test(directive)) return;
    try {
      blocked.push({ origin: new URL(violation.blockedURI, page.href).origin, directive, at: now() });
      if (blocked.length > 20) blocked.shift();
    } catch {
      // `inline` or `eval` violations carry no URL
    }
  };
  g.document?.addEventListener('securitypolicyviolation', onViolation);
  // Chromium lets https pages call local-network devices over http and gates them with its Local
  // Network Access permission instead; other browsers block them as mixed content.
  const chromium = /Chrom(e|ium)\//.test(g.navigator?.userAgent ?? '');
  const classify = (url: string, credentials: boolean): Explanation => {
    let target: URL;
    try {
      target = new URL(url, page.href);
    } catch {
      return {};
    }
    if (g.navigator?.onLine === false) return { cause: 'offline', message: 'The browser is offline' };
    const csp = blocked.find((entry) => entry.origin === target.origin && now() - entry.at < 10_000);
    if (csp) return { cause: 'csp', message: `Blocked by the page's Content-Security-Policy (${csp.directive})` };
    const exempt = isTrustworthyHost(target.hostname) || (chromium && isLocalNetworkHost(target.hostname));
    if (page.protocol === 'https:' && target.protocol === 'http:' && !exempt) {
      return { cause: 'mixed-content', message: `Blocked as mixed content: an https page cannot call ${target.origin}` };
    }
    if (target.origin !== page.origin) return { cause: 'cross-origin', credentials: credentials || undefined };
    return {};
  };
  return {
    // The violation event can arrive after the request has already failed.
    explain: (url, credentials, report) => void setTimeout(() => report(classify(url, credentials)), 30),
    stop: () => g.document?.removeEventListener('securitypolicyviolation', onViolation),
  };
}

/** Browsers let https pages call these over plain http. */
function isTrustworthyHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** Private IP literals and .local names; a hostname that resolves to a private IP does not count. */
function isLocalNetworkHost(hostname: string): boolean {
  if (hostname.endsWith('.local')) return true;
  const ipv4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(hostname);
  if (!ipv4) return /^\[(f[cd]|fe[89ab])/i.test(hostname);
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}
