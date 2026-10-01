import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import tls from 'node:tls';
import type { LinkReport } from '@fbrx/shared';
import { CoreError } from '../errors';

type Finding = { severity: 'info' | 'warning' | 'critical' | 'ok'; text: string; pts: number };

const BRANDS = ['paypal', 'microsoft', 'office365', 'outlook', 'onedrive', 'sharepoint', 'apple', 'icloud', 'google', 'gmail', 'amazon', 'netflix', 'chase', 'wellsfargo', 'bankofamerica', 'citibank', 'capitalone', 'americanexpress', 'docusign', 'dropbox', 'adobe', 'fedex', 'ups', 'usps', 'dhl', 'irs', 'coinbase', 'binance', 'metamask', 'ledger', 'steam', 'discord', 'instagram', 'facebook', 'whatsapp', 'linkedin', 'roblox', 'venmo', 'zelle'];
const OFFICIAL: Record<string, string[]> = {
  paypal: ['paypal.com'],
  microsoft: ['microsoft.com', 'live.com', 'microsoftonline.com', 'office.com', 'office365.com', 'outlook.com', 'sharepoint.com', 'onedrive.com', 'msn.com', 'bing.com', 'windows.com', 'azure.com'],
  office365: ['office365.com', 'office.com', 'microsoft.com'],
  outlook: ['outlook.com', 'live.com', 'office.com'],
  onedrive: ['onedrive.com', 'live.com'],
  sharepoint: ['sharepoint.com'],
  apple: ['apple.com', 'icloud.com'],
  icloud: ['icloud.com', 'apple.com'],
  google: ['google.com', 'gmail.com', 'youtube.com', 'googleusercontent.com', 'gstatic.com'],
  gmail: ['gmail.com', 'google.com'],
  amazon: ['amazon.com', 'amazon.co.uk', 'amazon.de', 'amazonaws.com'],
  facebook: ['facebook.com', 'fb.com', 'meta.com'],
  instagram: ['instagram.com'],
  whatsapp: ['whatsapp.com', 'whatsapp.net'],
  linkedin: ['linkedin.com'],
  steam: ['steampowered.com', 'steamcommunity.com'],
  discord: ['discord.com', 'discord.gg', 'discordapp.com'],
  bankofamerica: ['bankofamerica.com'],
  wellsfargo: ['wellsfargo.com'],
  americanexpress: ['americanexpress.com'],
  usps: ['usps.com'],
  irs: ['irs.gov'],
};
const SHORTENERS = ['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'rebrand.ly', 'cutt.ly', 'shorturl.at', 'tiny.cc', 'rb.gy', 'bl.ink', 's.id', 'lnkd.in', 'qrco.de', 't.ly', 'v.gd'];
const RISKY_TLDS = ['zip', 'mov', 'xyz', 'top', 'click', 'link', 'country', 'gq', 'tk', 'ml', 'cf', 'ga', 'work', 'rest', 'fit', 'loan', 'download', 'review', 'support', 'live', 'cam', 'icu', 'buzz', 'monster', 'quest', 'sbs', 'cfd', 'lol', 'shop', 'online', 'site', 'website', 'ru', 'su'];
const MULTI_SUFFIX = ['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'co.nz', 'co.jp', 'com.br', 'com.mx', 'co.in', 'co.za', 'com.cn', 'com.tr', 'co.kr', 'com.sg'];
const ABUSED_HOSTS = ['web.app', 'firebaseapp.com', 'pages.dev', 'workers.dev', 'netlify.app', 'vercel.app', 'glitch.me', 'herokuapp.com', 'ngrok.io', 'ngrok-free.app', 'trycloudflare.com', 'blogspot.com', 'weebly.com', 'wixsite.com', '000webhostapp.com', 'github.io', 'r2.dev', 'ipfs.io', 'square.site', 'webflow.io', 'forms.gle', 'sites.google.com'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

export function registrable(host: string): string {
  if (isIP(host)) return host;
  const parts = host.toLowerCase().split('.');
  const last2 = parts.slice(-2).join('.');
  if (MULTI_SUFFIX.includes(last2) && parts.length >= 3) return parts.slice(-3).join('.');
  return last2;
}

function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const deconfuse = (s: string) => s.replace(/0/g, 'o').replace(/1/g, 'l').replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/3/g, 'e').replace(/5/g, 's').replace(/[_-]/g, '');

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) return /^(::1|fe80:|fc|fd|::ffff:(10|127|192\.168|169\.254)\.)/i.test(ip);
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/** Offline analysis of the link text: look-alike domains, risky TLDs, raw IPs, @-tricks, file downloads. */
export function staticAnalysis(raw: string): { url: string; host: string; registrable: string; findings: Finding[] } {
  const findings: Finding[] = [];
  const add = (severity: Finding['severity'], text: string, pts: number) => findings.push({ severity, text, pts });
  let input = String(raw ?? '')
    .trim()
    .replace(/^hxxp/i, 'http')
    .replace(/\[\.\]/g, '.')
    .replace(/\[:\]/g, ':');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(input)) input = `http://${input}`;
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new CoreError('INVALID_ARGUMENT', 'That does not look like a valid link');
  }
  if (!/^https?:$/.test(u.protocol)) add('critical', `Uses the "${u.protocol}" scheme, not a normal web link`, 40);
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const reg = registrable(host);
  const label = reg.split('.')[0];
  const tld = host.split('.').pop() ?? '';
  if (isIP(host)) add('critical', 'Points to a raw IP address instead of a domain name', 25);
  if (host.split('.').some((p) => p.startsWith('xn--'))) add('critical', 'Internationalized (punycode) domain, often used for look-alike letters', 30);
  if (u.username || u.password) add('critical', 'Contains "@" before the domain: the real destination is what comes after it', 30);
  if (u.protocol === 'http:') add('warning', 'Not encrypted (http instead of https)', 10);
  if (SHORTENERS.includes(host)) add('warning', `Link shortener (${host}) hides the real destination`, 10);
  if (RISKY_TLDS.includes(tld)) add('warning', `".${tld}" is a top-level domain frequently abused by phishing`, 12);
  const abused = ABUSED_HOSTS.find((h) => host === h || host.endsWith(`.${h}`));
  if (abused) add('warning', `Hosted on a free, shared platform (${abused}) where anyone can publish`, 12);
  if (host.split('.').length - reg.split('.').length >= 3) add('warning', `Many sub-domains (${host}), a trick to bury the real domain`, 10);
  if (u.href.length > 160) add('info', `Very long link (${u.href.length} characters)`, 4);
  if (/(login|signin|sign-in|verify|account|update|secure|unlock|suspend|confirm|password|wallet|billing|invoice|payment|reset)/i.test(host + u.pathname)) {
    add('info', 'Uses account, login or payment wording common in phishing lures', 6);
  }
  if (/\.(exe|scr|msi|bat|cmd|js|vbs|hta|iso|img|lnk|ps1|jar|apk|zip|rar|7z)$/i.test(u.pathname)) add('critical', `Links directly to a downloadable file (.${u.pathname.split('.').pop()})`, 25);
  if (/(redirect|url|next|target|dest|goto|continue)=https?/i.test(u.search)) add('warning', 'Contains an embedded redirect to another site', 10);
  const words = host.replace(/\.[^.]+$/, '').split(/[.-]/);
  for (const b of BRANDS) {
    const official = (OFFICIAL[b] ?? [`${b}.com`]).some((d) => reg === d || host.endsWith(`.${d}`));
    if (official) {
      add('ok', `Domain belongs to ${b}`, -15);
      break;
    }
    const dl = deconfuse(label);
    if (label !== b && (dl === b || (b.length >= 5 && lev(label, b) <= (b.length > 7 ? 2 : 1)))) {
      add('critical', `Look-alike of "${b}" (${reg})`, 35);
      break;
    }
    if (words.some((w) => w === b || deconfuse(w) === b) && label !== b) {
      add('critical', `Mentions "${b}" but the real domain is ${reg}`, 30);
      break;
    }
  }
  return { url: u.href, host, registrable: reg, findings };
}

async function traceRedirects(url: string, max = 10): Promise<{ chain: Array<{ url: string; status: number | null }>; finalUrl: string; body: string; findings: Finding[] }> {
  const chain: Array<{ url: string; status: number | null }> = [];
  const findings: Finding[] = [];
  let cur = url;
  let body = '';
  for (let i = 0; i < max; i++) {
    let host: string;
    try {
      host = new URL(cur).hostname.replace(/^\[|\]$/g, '');
    } catch {
      break;
    }
    // Never let a link steer FBRX into the local network (routers, printers, admin pages).
    const addrs = isIP(host) ? [host] : await lookup(host, { all: true }).then((a) => a.map((x) => x.address), () => [] as string[]);
    if (addrs.some(isPrivateAddress)) {
      chain.push({ url: cur, status: null });
      findings.push({ severity: 'critical', text: `Leads into a private network address (${host}); FBRX stopped following it`, pts: 30 });
      break;
    }
    let r: Response;
    try {
      r = await fetch(cur, { redirect: 'manual', signal: AbortSignal.timeout(12_000), headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });
    } catch (e) {
      chain.push({ url: cur, status: null });
      findings.push({ severity: 'warning', text: `Could not load ${host}: ${(e as any).cause?.code ?? (e as Error).message}`, pts: 8 });
      break;
    }
    chain.push({ url: cur, status: r.status });
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) {
      cur = new URL(loc, cur).href;
      await r.body?.cancel().catch(() => undefined);
      continue;
    }
    if (/text\/html|text\/plain|javascript/i.test(r.headers.get('content-type') ?? '') && r.body) {
      const reader = r.body.getReader();
      const parts: Buffer[] = [];
      let total = 0;
      while (total < 600_000) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(Buffer.from(value));
        total += value.length;
      }
      await reader.cancel().catch(() => undefined);
      body = Buffer.concat(parts).toString('utf8');
    } else await r.body?.cancel().catch(() => undefined);
    const meta = body.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?\d+;\s*url=([^"'>\s]+)/i);
    if (meta && i < max - 1) {
      cur = new URL(meta[1], cur).href;
      body = '';
      continue;
    }
    break;
  }
  return { chain, finalUrl: chain[chain.length - 1]?.url ?? url, body, findings };
}

function pageSignals(body: string, finalUrl: string): Finding[] {
  const out: Finding[] = [];
  if (!body) return out;
  const title = body.match(/<title[^>]*>([^<]{0,200})/i)?.[1]?.trim() ?? '';
  let host = '';
  try {
    host = new URL(finalUrl).hostname;
  } catch {
    /* ignore */
  }
  if (/<input[^>]+type=["']?password/i.test(body)) out.push({ severity: 'warning', text: 'Page asks for a password', pts: 12 });
  const ext = [...body.matchAll(/<form[^>]+action=["']([^"']+)/gi)]
    .map((m) => {
      try {
        return new URL(m[1], finalUrl).hostname;
      } catch {
        return '';
      }
    })
    .filter((h) => h && h !== host);
  if (ext.length) out.push({ severity: 'critical', text: `Form sends data to another site (${[...new Set(ext)].join(', ')})`, pts: 20 });
  if (/eval\s*\(\s*(atob|unescape|decodeURIComponent)|document\.write\s*\(\s*unescape/i.test(body)) out.push({ severity: 'warning', text: 'Obfuscated JavaScript (eval/atob/unescape)', pts: 12 });
  if (/(microsoft|office ?365|outlook|paypal|apple id|wells fargo|chase|docusign|netflix)/i.test(title) && !/(microsoft|office|outlook|live|paypal|apple|wellsfargo|chase|docusign|netflix)\./i.test(host)) {
    out.push({ severity: 'critical', text: `Page title "${title.slice(0, 60)}" impersonates a brand on ${host}`, pts: 25 });
  }
  if (/(urgent|suspended|unusual activity|verify your account|within 24 hours|your account will be|gift card|you have won)/i.test(body.slice(0, 200_000))) {
    out.push({ severity: 'info', text: 'Contains urgency or pressure wording', pts: 5 });
  }
  return out;
}

function tlsCheck(host: string): Promise<{ authorized: boolean; error: string | null; ageDays: number | null }> {
  return new Promise((resolve) => {
    const sock = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: 8000 }, () => {
      const c = sock.getPeerCertificate();
      resolve({
        authorized: sock.authorized,
        error: sock.authorizationError ? String(sock.authorizationError) : null,
        ageDays: c.valid_from ? Math.round((Date.now() - Date.parse(c.valid_from)) / 86400_000) : null,
      });
      sock.end();
    });
    sock.on('error', (e: NodeJS.ErrnoException) => resolve({ authorized: false, error: e.code ?? e.message, ageDays: null }));
    sock.on('timeout', () => {
      sock.destroy();
      resolve({ authorized: false, error: 'timeout', ageDays: null });
    });
  });
}

async function domainAgeDays(reg: string): Promise<number | null> {
  try {
    const r = await fetch(`https://rdap.org/domain/${encodeURIComponent(reg)}`, { signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/rdap+json' } });
    if (!r.ok) return null;
    const j: any = await r.json();
    const created = j.events?.find((e: any) => e.eventAction === 'registration')?.eventDate;
    return created ? Math.round((Date.now() - Date.parse(created)) / 86400_000) : null;
  } catch {
    return null;
  }
}

/**
 * Inspects a suspicious link without opening it in a browser: static analysis, a server-side redirect trace
 * (no JavaScript runs), page signals, certificate and domain age, and VirusTotal when a key is saved.
 */
export async function checkLink(raw: string, o: { virustotalKey?: string } = {}): Promise<LinkReport> {
  const st = staticAnalysis(raw);
  const findings = [...st.findings];
  const trace = await traceRedirects(st.url);
  findings.push(...trace.findings);
  let finalHost = st.host;
  try {
    finalHost = new URL(trace.finalUrl).hostname;
  } catch {
    /* ignore */
  }
  if (trace.chain.length > 1) {
    const hops = trace.chain.length - 1;
    findings.push({ severity: hops > 3 ? 'warning' : 'info', text: `Redirects ${hops} time${hops > 1 ? 's' : ''} before landing on ${finalHost}`, pts: hops > 3 ? 10 : 3 });
    if (registrable(finalHost) !== st.registrable) {
      for (const f of staticAnalysis(trace.finalUrl).findings) if (f.severity !== 'info' && f.severity !== 'ok') findings.push({ ...f, text: `Final page: ${f.text}` });
    }
  }
  findings.push(...pageSignals(trace.body, trace.finalUrl));
  const [age, cert] = await Promise.all([
    isIP(st.registrable) ? Promise.resolve(null) : domainAgeDays(st.registrable),
    /^https:/.test(trace.finalUrl) && !isIP(finalHost) ? tlsCheck(finalHost) : Promise.resolve(null),
  ]);
  if (age != null) {
    if (age < 30) findings.push({ severity: 'critical', text: `Domain registered only ${age} days ago`, pts: 30 });
    else if (age < 180) findings.push({ severity: 'warning', text: `Domain is young (${age} days old)`, pts: 12 });
    else if (age > 3 * 365) findings.push({ severity: 'ok', text: `Domain has existed for ${(age / 365).toFixed(1)} years`, pts: -8 });
  }
  if (cert) {
    if (!cert.authorized && cert.error) findings.push({ severity: 'critical', text: `Invalid HTTPS certificate (${cert.error})`, pts: 25 });
    else if (cert.ageDays != null && cert.ageDays < 7) findings.push({ severity: 'info', text: `HTTPS certificate issued ${cert.ageDays} day(s) ago`, pts: 5 });
  }
  if (o.virustotalKey) {
    try {
      const id = Buffer.from(st.url).toString('base64url');
      const r = await fetch(`https://www.virustotal.com/api/v3/urls/${id}`, { headers: { 'x-apikey': o.virustotalKey }, signal: AbortSignal.timeout(15_000) });
      if (r.ok) {
        const s = ((await r.json()) as any).data.attributes.last_analysis_stats;
        const bad = (s.malicious ?? 0) + (s.suspicious ?? 0);
        if (bad >= 3) findings.push({ severity: 'critical', text: `VirusTotal: ${bad} security vendors flag this link`, pts: 50 });
        else if (bad) findings.push({ severity: 'warning', text: `VirusTotal: ${bad} vendor(s) flag this link`, pts: 15 });
        else findings.push({ severity: 'ok', text: 'VirusTotal: no vendors flag this link', pts: -10 });
      } else if (r.status === 404) findings.push({ severity: 'info', text: 'VirusTotal has not seen this link before', pts: 2 });
    } catch {
      /* reputation is best-effort */
    }
  }
  const score = Math.max(0, Math.min(100, findings.reduce((a, f) => a + f.pts, 0)));
  const order = { critical: 0, warning: 1, info: 2, ok: 3 };
  return {
    input: raw,
    url: st.url,
    finalUrl: trace.finalUrl,
    domain: st.registrable,
    verdict: score >= 45 ? 'dangerous' : score >= 18 ? 'caution' : 'safe',
    score,
    findings: findings.sort((a, b) => order[a.severity] - order[b.severity]).map((f) => ({ severity: f.severity === 'ok' ? 'info' : f.severity, text: f.text })),
    redirects: trace.chain,
  };
}
