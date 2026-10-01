import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface NetworkPolicyLike {
  allowedDomains: string[];
  blockedDomains: string[];
  allowPrivateNetworks: boolean;
}

function domainMatches(host: string, pattern: string): boolean {
  const p = pattern.toLowerCase().trim();
  if (p === '*') return true;
  if (p.startsWith('*.')) return host === p.slice(2) || host.endsWith(p.slice(1));
  return host === p;
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  return false;
}

export interface UrlCheck {
  ok: boolean;
  reason?: string;
  host?: string;
}

/** Validates an outbound URL against network policy, including DNS resolution to catch private targets. */
export async function checkUrl(raw: string, policy: NetworkPolicyLike, resolveDns = true): Promise<UrlCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `Invalid URL: ${raw}` };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: `Only http(s) URLs are allowed (got ${url.protocol})` };
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (policy.blockedDomains.some((d) => domainMatches(host, d))) {
    return { ok: false, reason: `Host ${host} is blocked by policy`, host };
  }
  if (!policy.allowedDomains.some((d) => domainMatches(host, d))) {
    return { ok: false, reason: `Host ${host} is not on the allowed list`, host };
  }
  if (!policy.allowPrivateNetworks) {
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || isPrivateAddress(host)) {
      return { ok: false, reason: `Private network address ${host} is blocked by policy`, host };
    }
    if (resolveDns && !isIP(host)) {
      try {
        const addrs = await lookup(host, { all: true });
        const priv = addrs.find((a) => isPrivateAddress(a.address));
        if (priv) return { ok: false, reason: `${host} resolves to private address ${priv.address}`, host };
      } catch {
        /* unresolvable hosts fail later at fetch time */
      }
    }
  }
  return { ok: true, host };
}
