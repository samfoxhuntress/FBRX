/** Names: the part a person registers, how random a label looks, and threat lists. */

/** Second-level suffixes under which people register names (example.co.uk), the common ones. */
const SECOND_LEVEL = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'ne.jp', 'co.kr', 'com.br', 'com.cn', 'com.mx', 'co.za', 'co.in', 'com.tr', 'com.sg', 'com.hk']);

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, '');
}

/** The registered part: www.mail.example.co.uk → example.co.uk. */
export function baseDomain(name: string): string {
  const parts = normalizeName(name).split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const last2 = parts.slice(-2).join('.');
  return SECOND_LEVEL.has(last2) ? parts.slice(-3).join('.') : last2;
}

/** a.b.example.com → [a.b.example.com, b.example.com, example.com, com]. */
export function parentDomains(name: string): string[] {
  const parts = normalizeName(name).split('.').filter(Boolean);
  return parts.map((_x, i) => parts.slice(i).join('.'));
}

/** Whether the name is the domain or under it. */
export function under(name: string, domains: Set<string> | string[]): boolean {
  const set = domains instanceof Set ? domains : new Set(domains.map(normalizeName));
  return parentDomains(name).some((d) => set.has(d));
}

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Names made up by software rather than people (domain generation, as some malware does to find its servers):
 * long, high entropy, few vowels, digits mixed in. Content networks and reverse lookups use random-looking names
 * too, so they are left out.
 */
const RANDOM_OK = new Set(['arpa', 'amazonaws.com', 'cloudfront.net', 'akamaiedge.net', 'akamaihd.net', 'akadns.net', 'edgekey.net', 'fastly.net', 'googlevideo.com', 'gvt1.com', 'cdn77.org', 'azureedge.net', 'trafficmanager.net', 'windows.net', 'local', 'lan', 'invalid', 'internal', 'home.arpa']);

export function looksRandom(name: string): boolean {
  const n = normalizeName(name);
  const base = baseDomain(n);
  if (parentDomains(n).some((d) => RANDOM_OK.has(d))) return false;
  const label = base.split('.')[0];
  if (label.length < 10) return false;
  const letters = label.replace(/[^a-z]/g, '');
  const vowels = letters.replace(/[^aeiouy]/g, '').length;
  const digits = label.replace(/[^0-9]/g, '').length;
  const vowelRatio = letters.length ? vowels / letters.length : 0;
  const longestConsonants = Math.max(0, ...(letters.match(/[^aeiouy]+/g) ?? []).map((r) => r.length));
  const e = entropy(label);
  return e >= 3.4 && (vowelRatio < 0.28 || digits / label.length > 0.25 || longestConsonants >= 5);
}

/**
 * A threat list: a hosts file (0.0.0.0 bad.example) or one domain per line, # comments. Returns the domains;
 * lines that are not domains are skipped.
 */
export function parseFeed(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const name = normalizeName(parts.length >= 2 && /^[\d.:]+$/.test(parts[0]) ? parts[1] : parts[0]);
    if (name === 'localhost' || name.endsWith('.localdomain') || !/^(?=.{1,253}$)([a-z0-9_]([a-z0-9-_]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(name)) continue;
    out.push(name);
  }
  return out;
}
