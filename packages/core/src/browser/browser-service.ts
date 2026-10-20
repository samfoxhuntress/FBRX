import { addressBarToUrl, newId, policyAllows, type Bookmark, type BrowserCheck, type BrowserPolicy, type BrowserState, type HistoryEntry, type Settings } from '@fbrx/shared';
import { CoreError } from '../errors';
import type { MetaStore } from '../storage/meta';
import type { EventBus } from '../events';

const BOOKMARKS_KEY = 'browser.bookmarks';
const HISTORY_KEY = 'browser.history';
/** A person's own blocked sites (the organization's come from managed settings). */
const LOCAL_BLOCKED_KEY = 'browser.blockedLocal';
/** How many visits to keep (older ones fall off). */
const HISTORY_CAP = 2000;

/**
 * The part of FBRX Browser that lives in the core: bookmarks, history and the browsing policy, kept on this computer.
 * The live tabs and the web views are the browser window's own; this is what survives a restart and what an
 * organization (FBRX Command) governs. The window asks `browser.check` before it opens an address.
 */
export class BrowserService {
  constructor(
    private readonly meta: MetaStore,
    private readonly events: EventBus,
    private readonly settings: () => Settings,
    /** Whether FBRX Shield is the antivirus and will check downloads. */
    private readonly shieldOn: () => boolean,
  ) {}

  private bookmarks(): Bookmark[] {
    return this.meta.get<Bookmark[]>(BOOKMARKS_KEY) ?? [];
  }

  private historyAll(): HistoryEntry[] {
    return this.meta.get<HistoryEntry[]>(HISTORY_KEY) ?? [];
  }

  /** The effective policy: the organization's managed lists, plus the person's own blocks. */
  policy(): BrowserPolicy {
    const b = this.settings().browser;
    const mine = this.meta.get<string[]>(LOCAL_BLOCKED_KEY) ?? [];
    return {
      allowed: b.allowed,
      blocked: [...new Set([...b.blocked, ...mine])],
      // Managed when the organization set any list (those paths are locked); the person can still add their own blocks.
      managed: b.allowed.length > 0 || b.blocked.length > 0 || b.safeBrowsing,
      safeBrowsing: b.safeBrowsing,
    };
  }

  state(): BrowserState {
    const b = this.settings().browser;
    return { homepage: b.homepage, searchEngine: b.searchEngine, bookmarks: this.bookmarks(), policy: this.policy(), shieldOn: this.shieldOn() };
  }

  /** Turns what was typed into an address, and says whether the policy allows it. */
  check(input: string): BrowserCheck {
    const url = addressBarToUrl(input, this.settings().browser.searchEngine);
    if (!url) return { ok: false, url: '' };
    const verdict = policyAllows(url, this.policy());
    return { ok: verdict.ok, reason: verdict.reason, url };
  }

  bookmark(url: string, title: string): Bookmark[] {
    const list = this.bookmarks();
    if (list.some((b) => b.url === url)) return list;
    const next = [{ id: newId('bm'), url, title: title.slice(0, 300) || url, createdAt: new Date().toISOString() }, ...list].slice(0, 1000);
    this.meta.set(BOOKMARKS_KEY, next);
    this.emit();
    return next;
  }

  removeBookmark(id: string): Bookmark[] {
    const next = this.bookmarks().filter((b) => b.id !== id);
    this.meta.set(BOOKMARKS_KEY, next);
    this.emit();
    return next;
  }

  history(opts: { limit?: number; query?: string } = {}): HistoryEntry[] {
    const q = opts.query?.trim().toLowerCase();
    let list = this.historyAll();
    if (q) list = list.filter((h) => h.title.toLowerCase().includes(q) || h.url.toLowerCase().includes(q));
    return list.slice(0, Math.min(opts.limit ?? 500, HISTORY_CAP));
  }

  /** Records a visit (the window calls this as pages load; private tabs never do). */
  visited(url: string, title: string): { ok: true } {
    // Never keep FBRX's own pages or blank tabs.
    if (!/^https?:/i.test(url)) return { ok: true };
    const list = this.historyAll();
    const now = new Date().toISOString();
    // Collapse a reload or a quick revisit of the same page into the latest entry.
    const head = list[0];
    if (head && head.url === url) {
      list[0] = { ...head, title: title || head.title, visitedAt: now };
    } else {
      list.unshift({ id: newId('h'), url, title: title.slice(0, 300) || url, visitedAt: now });
    }
    this.meta.set(HISTORY_KEY, list.slice(0, HISTORY_CAP));
    return { ok: true };
  }

  clearHistory(since?: string): { cleared: number } {
    const list = this.historyAll();
    if (!since) {
      this.meta.set(HISTORY_KEY, []);
      this.emit();
      return { cleared: list.length };
    }
    const cut = Date.parse(since);
    const kept = list.filter((h) => Date.parse(h.visitedAt) < cut);
    this.meta.set(HISTORY_KEY, kept);
    this.emit();
    return { cleared: list.length - kept.length };
  }

  /** The person's own block list (not an organization's). */
  addBlocked(host: string): BrowserState {
    const h = host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
    if (!h) throw new CoreError('INVALID_ARGUMENT', 'Enter a web address to block');
    const mine = this.meta.get<string[]>(LOCAL_BLOCKED_KEY) ?? [];
    if (!mine.includes(h)) this.meta.set(LOCAL_BLOCKED_KEY, [...mine, h]);
    this.emit();
    return this.state();
  }

  removeBlocked(host: string): BrowserState {
    const mine = this.meta.get<string[]>(LOCAL_BLOCKED_KEY) ?? [];
    this.meta.set(LOCAL_BLOCKED_KEY, mine.filter((x) => x !== host));
    this.emit();
    return this.state();
  }

  private emit() {
    this.events.emit('browser.changed', this.state());
  }
}
