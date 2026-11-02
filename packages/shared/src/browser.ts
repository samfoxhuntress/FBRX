/**
 * FBRX Browser: a web browser inside FBRX OS, in its own window, that works with the rest of FBRX — the local AI
 * (Fabrix reads and explains the page), the password vault (fill a saved sign-in), notes and snippets (keep a page or
 * a selection), the mesh (send a link to another of your computers), FBRX Shield (checks what you download) and FBRX
 * Command (an organization's allowed and blocked sites). Pages open in a locked-down view with its own storage,
 * separate from FBRX's own windows.
 */

/** The search engine the address bar uses when what you typed is not a web address. */
export const BROWSER_SEARCH_ENGINES = {
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/sp/search?query=%s' },
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  brave: { name: 'Brave', url: 'https://search.brave.com/search?q=%s' },
} as const;
export type BrowserSearchEngine = keyof typeof BROWSER_SEARCH_ENGINES;

export interface Bookmark {
  id: string;
  title: string;
  url: string;
  createdAt: string;
}

/** One visit, newest first (browser.history). Grouped by day in the UI. */
export interface HistoryEntry {
  id: string;
  title: string;
  url: string;
  visitedAt: string;
}

/**
 * What an organization (FBRX Command) decides about browsing, pushed as managed settings, plus the person's own
 * blocks. The lists are enforced for every page and frame the browser loads (main/browser.ts), not only what is typed.
 */
export interface BrowserPolicy {
  /** When set, only addresses matching one of these host patterns may be opened (an allow-list). */
  allowed: string[];
  /** Addresses matching one of these host patterns are blocked. */
  blocked: string[];
  /** Whether the policy is set by the organization (so the person cannot change it). */
  managed: boolean;
  /**
   * Safe browsing: strict SafeSearch on Google, Bing, DuckDuckGo and Brave, and YouTube's Restricted Mode. On by
   * default on a student's or child's computer; elsewhere when the organization turns it on.
   */
  safeBrowsing: boolean;
}

/** browser.state: everything the browser page needs that lives in the core (not the live tabs, which are the window's). */
export interface BrowserState {
  homepage: string;
  searchEngine: BrowserSearchEngine;
  bookmarks: Bookmark[];
  policy: BrowserPolicy;
  /** FBRX Shield is on and will check downloads. */
  shieldOn: boolean;
  /** New tabs open private (nothing kept once they close). */
  privateByDefault: boolean;
  /** Fabrix may read the page to answer about it. */
  aiAssist: boolean;
  /** The sites the person blocked themselves (the organization's are in policy.blocked too, and cannot be removed). */
  blockedByMe: string[];
}

/**
 * A page on this computer or the home network whose certificate no authority vouches for (a router, a NAS, FBRX
 * Server): FBRX Browser shows it, and goes on only once the person has compared its fingerprint.
 */
export interface BrowserCertificateProblem {
  /** The tab's page (its webview's web contents). */
  webContentsId: number;
  url: string;
  host: string;
  /** Chromium's reason, such as net::ERR_CERT_AUTHORITY_INVALID. */
  error: string;
  /** "AB:CD:…", as FBRX Server and most devices show their own. */
  fingerprint: string;
  issuer: string;
  validTo: string;
  /** Whether it may be trusted here: only for an address on this computer or the home network, without safe browsing. */
  canTrust: boolean;
}

/** Why an address was refused (browser.check), so the page can say so. */
export type BrowserBlockReason = 'blocked' | 'not-allowed';

export interface BrowserCheck {
  ok: boolean;
  reason?: BrowserBlockReason;
  /** The address FBRX would open for what was typed (a web address as-is, or a search). */
  url: string;
}

/**
 * Turns what was typed in the address bar into an address to open: a URL as-is (adding https:// when it is a bare
 * host), otherwise a search on the chosen engine. A bare host is a name with a dot (example.com, 192.168.10.1), a name
 * or IPv6 address with a port (fbrx-server:9443, [fd00::1]:8080), or localhost (http://, as local tools serve it).
 * Shared so the window and tests agree.
 */
export function addressBarToUrl(input: string, engine: BrowserSearchEngine): string {
  const text = input.trim();
  if (!text) return '';
  if (/^(https?|file|about|fbrx):/i.test(text)) return text;
  if (text === 'localhost' || /^localhost[:/]/.test(text)) return `http://${text}`;
  if (!/\s/.test(text) && (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(text) || /^[\w-]+:\d{1,5}(\/.*)?$/.test(text) || /^\[[\da-f:.]+\](:\d+)?(\/.*)?$/i.test(text))) return `https://${text}`;
  return BROWSER_SEARCH_ENGINES[engine].url.replace('%s', encodeURIComponent(text));
}

/**
 * Whether a host is on this computer or the local network: loopback, private and link-local addresses, and names no
 * public authority hands out (a single word, .local, .lan, .home.arpa, .internal). Such a host often speaks plain
 * http:// or has a certificate of its own, so FBRX Browser offers both, and never does either for a public site.
 */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || (!h.includes('.') && !h.includes(':'))) return true;
  if (/\.(local|lan|home\.arpa|internal|localdomain)$/.test(h)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  return h === '::1' || /^f[cd][\da-f]{2}:/.test(h) || /^fe80:/.test(h);
}

/** Whether a host matches a policy pattern (`example.com` matches it and its subdomains; `*` matches all). */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  const p = pattern.trim().toLowerCase().replace(/^www\./, '').replace(/^\*\./, '');
  if (!p) return false;
  if (p === '*') return true;
  return h === p || h.endsWith(`.${p}`);
}

/** Decides whether an address may be opened under a policy (used by the core and mirrored for quick UI checks). */
export function policyAllows(url: string, policy: BrowserPolicy): { ok: boolean; reason?: BrowserBlockReason } {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { ok: true };
  }
  if (policy.blocked.some((p) => hostMatches(host, p))) return { ok: false, reason: 'blocked' };
  if (policy.allowed.length && !policy.allowed.some((p) => hostMatches(host, p))) return { ok: false, reason: 'not-allowed' };
  return { ok: true };
}

/**
 * Safe browsing: the strict-SafeSearch version of a search engine's results address, or null when the address is not
 * a search there or is already strict. The browser's session redirects to it while safe browsing is on.
 */
export function safeSearchUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const want: [string, string] | null =
    /^google\.[a-z.]+$/.test(host) && u.pathname === '/search'
      ? ['safe', 'active']
      : host === 'bing.com' && u.pathname === '/search'
        ? ['adlt', 'strict']
        : (host === 'duckduckgo.com' || host === 'html.duckduckgo.com') && u.searchParams.has('q')
          ? ['kp', '1']
          : host === 'search.brave.com' && u.pathname.startsWith('/search')
            ? ['safesearch', 'strict']
            : null;
  if (!want || u.searchParams.get(want[0]) === want[1]) return null;
  u.searchParams.set(want[0], want[1]);
  return u.toString();
}

/** YouTube's own switch for Restricted Mode, sent as a request header to its hosts while safe browsing is on. */
export const YOUTUBE_RESTRICT_HOSTS = ['youtube.com', 'm.youtube.com', 'youtubei.googleapis.com', 'youtube.googleapis.com', 'youtube-nocookie.com'];

/** The channel between FBRX Browser's window and the sign-in helper in each page (its Vault extension). */
export const AUTOFILL_CHANNEL = 'fbrx:autofill';

/** What the sign-in helper in a page tells the browser window. */
export type AutofillReport =
  /** A sign-in form's box has the focus, here (in the page's own pixels). */
  | { type: 'focus'; field: 'username' | 'password'; isNew: boolean; rect: { x: number; y: number; width: number; height: number } }
  /** The box moved (the page scrolled or resized); the suggestions follow it. */
  | { type: 'moved'; rect: { x: number; y: number; width: number; height: number } }
  /** The person moved on (another box, a click elsewhere, Esc), or the box went out of sight. */
  | { type: 'away' }
  /** A sign-in form was sent with this in it. */
  | { type: 'submit'; username: string; password: string; isNew: boolean }
  | { type: 'filled' }
  /** Whether the page has a sign-in form now. */
  | { type: 'forms'; present: boolean };

/** A sign-in the window gives the page's helper to type in, for this origin only. */
export interface AutofillFill {
  origin: string;
  username: string;
  password: string;
}
