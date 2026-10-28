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
 * host), otherwise a search on the chosen engine. Shared so the window and tests agree.
 */
export function addressBarToUrl(input: string, engine: BrowserSearchEngine): string {
  const text = input.trim();
  if (!text) return '';
  if (/^(https?|file|about|fbrx):/i.test(text)) return text;
  // A bare host or host/path with a dot and no spaces: treat as a web address.
  if (!/\s/.test(text) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(text)) return `https://${text}`;
  if (text === 'localhost' || /^localhost[:/]/.test(text)) return `http://${text}`;
  return BROWSER_SEARCH_ENGINES[engine].url.replace('%s', encodeURIComponent(text));
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
