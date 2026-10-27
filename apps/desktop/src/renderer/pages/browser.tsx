import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AUTOFILL_CHANNEL, BROWSER_SEARCH_ENGINES, SUPPORT_ENTER_PHRASE, SUPPORT_EXIT_PHRASE, SUPPORT_PASS_PREFIX, WEB_BROWSER_PARTITION, WEB_BROWSER_PRIVATE_PARTITION, type AutofillReport, type Bookmark, type BrowserState, type HistoryEntry } from '@fbrx/shared';
import { Button, FbrxMark, Icons, useToast } from '@fbrx/ui';
import { bridge, call, onEvent } from '../client';
import { useQuickAi, QuickAiPanel } from '../quick-ai';
import { FillMenuView, SaveBar, SignInsPanel, useBrowserVault } from './browser-vault';

/**
 * FBRX Browser: a web browser inside FBRX OS, in its own window. Pages load in locked-down <webview>s with their own
 * storage (apart from FBRX's own pages); the toolbar, tabs and the Fabrix side panel live here, and the main process
 * checks downloads with FBRX Shield and governs which sites may open (pages/browser is reached only from the browser
 * window). Fabrix reads the page through the local AI to summarize or explain it; the Vault fills in saved sign-ins
 * and offers to save new ones (browser-vault); notes and the mesh keep or share a page.
 */

export type WebviewElement = HTMLElement & {
  src: string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  getURL(): string;
  getTitle(): string;
  loadURL(url: string): Promise<void>;
  executeJavaScript(code: string): Promise<unknown>;
  findInPage(text: string): void;
  stopFindInPage(action: 'clearSelection'): void;
  setZoomFactor(factor: number): void;
  insertText(text: string): Promise<void>;
  /** A message for the page's sign-in helper (preload/autofill.ts). */
  send(channel: string, ...args: unknown[]): void;
};

export interface Tab {
  id: string;
  /** Where the tab was pointed (the webview's src); '' is the start page. */
  url: string;
  /** Where the page is now, after links and redirects (what the address bar, bookmarks and Fabrix use). */
  current: string;
  title: string;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
  /** A private tab keeps nothing once it closes. */
  priv: boolean;
  /** The policy refused this address. */
  blocked: null | { reason: string; url: string };
}

const BLOCK_WORDS: Record<string, string> = {
  blocked: 'This site is on the block list.',
  'not-allowed': 'This site is not on the list your organization allows.',
};
/** Chromium's net::ERR_BLOCKED_BY_CLIENT: the browser's session refused the page (the policy, main/browser.ts). */
const BLOCKED_BY_POLICY = -20;

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

const WEBVIEW_POPUPS = { allowpopups: 'true' } as object;
/** The address the window was opened at (from FBRX's main window, a link, Spotlight…), for its first tab. */
const OPENED_AT = new URLSearchParams(location.search).get('open');
let seq = 0;
const makeTab = (over: Partial<Tab> = {}): Tab => ({ id: `t${Date.now().toString(36)}-${seq++}`, url: '', current: over.url ?? '', title: 'New tab', loading: false, canBack: false, canForward: false, priv: false, blocked: null, ...over });

export function BrowserApp({ agentName }: { agentName: string }) {
  const toast = useToast();
  const [tabs, setTabs] = useState<Tab[]>(() => [makeTab(OPENED_AT && /^https?:\/\//i.test(OPENED_AT) ? { url: OPENED_AT, loading: true } : {})]);
  const [activeId, setActiveId] = useState(tabs[0].id);
  const [address, setAddress] = useState('');
  const [state, setState] = useState<BrowserState | null>(null);
  const [panel, setPanel] = useState<null | 'fabrix' | 'bookmarks' | 'history' | 'passwords'>(null);
  const [menu, setMenu] = useState(false);
  const [find, setFind] = useState<string | null>(null);
  const [supportAsk, setSupportAsk] = useState(false);
  const [zoom, setZoom] = useState(1);
  const views = useRef<Map<string, WebviewElement>>(new Map());
  const vault = useBrowserVault(views, zoom, toast);
  const { report: vaultReport, navigated: vaultNavigated } = vault;
  const addressRef = useRef<HTMLInputElement>(null);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const activeRef = useRef(active);
  activeRef.current = active;

  const refreshState = useCallback(() => void call('browser.state').then(setState).catch(() => undefined), []);
  useEffect(() => {
    refreshState();
    return onEvent('browser.changed', setState);
  }, [refreshState]);

  const patchTab = useCallback((id: string, p: Partial<Tab>) => setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t))), []);

  // Turn what was typed into a URL (honoring the policy), and point the active tab at it.
  const go = useCallback(
    async (raw: string, tabId = activeRef.current.id) => {
      const input = raw.trim();
      if (!input) return;
      // Support mode (troubleshooting), typed here as in the endpoint: the phrase asks for a pass; the resume phrase
      // or a pass acts at once.
      const low = input.toLowerCase();
      if (low === SUPPORT_ENTER_PHRASE) return void (setSupportAsk(true), setAddress(''));
      if (low === SUPPORT_EXIT_PHRASE) return void (setAddress(''), call('support.end').then(() => toast.info('Support mode ended')).catch(() => undefined));
      if (input.startsWith(`${SUPPORT_PASS_PREFIX}.`)) {
        setAddress('');
        void call('support.activate', { pass: input })
          .then(() => toast.success('Support mode on', 'This computer is running with full access until the pass runs out.'))
          .catch((e: Error) => toast.error('That support pass was not accepted', e.message));
        return;
      }
      const check = await call('browser.check', { input }).catch(() => null);
      if (!check || !check.url) return;
      if (!check.ok) {
        patchTab(tabId, { blocked: { reason: BLOCK_WORDS[check.reason ?? 'blocked'] ?? 'This site is blocked.', url: check.url }, url: '', current: '', title: 'Blocked', loading: false });
        return;
      }
      // A tab already showing a page loads the address in place (its src may already be this very address).
      const live = views.current.get(tabId);
      if (live) {
        patchTab(tabId, { current: check.url, blocked: null, loading: true });
        void live.loadURL(check.url).catch(() => undefined);
        return;
      }
      patchTab(tabId, { url: check.url, current: check.url, blocked: null, loading: true });
    },
    [patchTab],
  );

  // When the window is told to open a URL (a popup became a tab, or Spotlight sent one), open it in a new tab.
  useEffect(() => {
    const off = bridge.onBrowserOpen?.((url) => {
      const t = makeTab({ url, loading: true });
      setTabs((ts) => [...ts, t]);
      setActiveId(t.id);
    });
    return off;
  }, []);

  // Wire a webview's events to its tab once React has mounted it.
  const bindView = useCallback(
    (tab: Tab, el: WebviewElement | null) => {
      if (!el) {
        views.current.delete(tab.id);
        return;
      }
      if (views.current.get(tab.id) === el) return;
      views.current.set(tab.id, el);
      const sync = () => {
        try {
          const url = el.getURL();
          patchTab(tab.id, { canBack: el.canGoBack(), canForward: el.canGoForward(), ...(/^https?:/.test(url) ? { current: url } : {}) });
          if (/^https?:/.test(url)) {
            if (tab.id === activeRef.current.id) setAddress(url);
            // Record the visit (never for a private tab).
            if (!tab.priv) void call('browser.visited', { url, title: el.getTitle() || url }).catch(() => undefined);
          }
        } catch {
          /* not attached */
        }
      };
      const on: Array<[string, (e: Event) => void]> = [
        ['did-start-loading', () => patchTab(tab.id, { loading: true })],
        ['did-stop-loading', () => (patchTab(tab.id, { loading: false }), sync())],
        [
          'did-navigate',
          () => {
            vaultNavigated(tab.id);
            sync();
          },
        ],
        // The page's sign-in helper: a sign-in box has the focus, a form was sent, a form is there.
        [
          'ipc-message',
          (e) => {
            const m = e as Event & { channel: string; args: unknown[] };
            if (m.channel === AUTOFILL_CHANNEL) void vaultReport(tab, m.args[0] as AutofillReport);
          },
        ],
        ['did-navigate-in-page', sync],
        ['page-title-updated', (e) => patchTab(tab.id, { title: (e as Event & { title: string }).title })],
        [
          // A page (or a link on one) the policy refuses in the session: show why, as for a typed address.
          'did-fail-load',
          (e) => {
            const f = e as Event & { errorCode: number; validatedURL: string; isMainFrame: boolean };
            if (!f.isMainFrame || f.errorCode !== BLOCKED_BY_POLICY) return;
            void call('browser.check', { input: f.validatedURL }).then((c) => {
              if (c.ok) return;
              patchTab(tab.id, { blocked: { reason: BLOCK_WORDS[c.reason ?? 'blocked'] ?? 'This site is blocked.', url: c.url }, url: '', current: '', title: 'Blocked', loading: false });
            });
          },
        ],
      ];
      for (const [n, h] of on) el.addEventListener(n, h);
    },
    [patchTab, vaultReport, vaultNavigated],
  );

  // Keep the address bar showing the active tab's URL when switching tabs.
  useEffect(() => {
    setAddress(/^https?:/.test(active.current) ? active.current : '');
  }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const newTab = (priv = state?.privateByDefault ?? false) => {
    const t = makeTab({ priv });
    setTabs((ts) => [...ts, t]);
    setActiveId(t.id);
    setTimeout(() => addressRef.current?.focus(), 0);
  };
  const closeTab = (id: string) => {
    if (vault.offer?.tabId === id) vault.dismissOffer();
    setTabs((ts) => {
      const left = ts.filter((t) => t.id !== id);
      if (!left.length) {
        const fresh = makeTab();
        setActiveId(fresh.id);
        return [fresh];
      }
      if (id === activeId) setActiveId(left[Math.max(0, ts.findIndex((t) => t.id === id) - 1)].id);
      return left;
    });
    views.current.delete(id);
  };

  const view = () => views.current.get(active.id) ?? null;
  const reload = () => (active.loading ? view()?.stop() : view()?.reload());
  const home = () => {
    const hp = state?.homepage;
    if (hp) void go(hp);
    else {
      patchTab(active.id, { url: '', current: '', title: 'New tab', blocked: null });
      setAddress('');
    }
  };
  const bookmarked = !!state?.bookmarks.some((b) => b.url === active.current);
  const toggleBookmark = async () => {
    if (!/^https?:/.test(active.current)) return;
    const mark = state?.bookmarks.find((b) => b.url === active.current);
    if (mark) await call('browser.removeBookmark', { id: mark.id });
    else await call('browser.bookmark', { url: active.current, title: active.title });
  };

  // Fabrix reads the live page text (never for a private tab) and answers about it through the local AI.
  const pageText = useCallback(async (): Promise<string> => {
    const el = view();
    if (!el || active.priv || state?.aiAssist === false) return '';
    try {
      const text = (await el.executeJavaScript('document.title + "\\n\\n" + (document.body?.innerText || "")')) as string;
      return String(text).slice(0, 40_000);
    } catch {
      return '';
    }
  }, [active.priv, state?.aiAssist]); // eslint-disable-line react-hooks/exhaustive-deps

  const setZoomTo = (z: number) => {
    const next = Math.min(2, Math.max(0.5, Math.round(z * 10) / 10));
    setZoom(next);
    views.current.forEach((v) => v.setZoomFactor(next));
  };

  // Ctrl/Cmd shortcuts: new tab, close, address bar, find, reload, zoom.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) {
        if (e.key === 'Escape' && find !== null) setFind(null);
        return;
      }
      const k = e.key.toLowerCase();
      if (k === 't') (e.preventDefault(), newTab());
      else if (k === 'w') (e.preventDefault(), closeTab(activeRef.current.id));
      else if (k === 'l') (e.preventDefault(), addressRef.current?.select());
      else if (k === 'f') (e.preventDefault(), setFind(''));
      else if (k === 'r') (e.preventDefault(), reload());
      else if (k === '=' || k === '+') (e.preventDefault(), setZoomTo(zoom + 0.1));
      else if (k === '-') (e.preventDefault(), setZoomTo(zoom - 0.1));
      else if (k === '0') (e.preventDefault(), setZoomTo(1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom, find]); // eslint-disable-line react-hooks/exhaustive-deps

  const partitionFor = (t: Tab) => (t.priv ? WEB_BROWSER_PRIVATE_PARTITION : WEB_BROWSER_PARTITION);
  const secure = active.current.startsWith('https://');

  return (
    <div className="br-app" data-private={active.priv || undefined}>
      <TabStrip tabs={tabs} activeId={activeId} onSelect={setActiveId} onClose={closeTab} onNew={() => newTab()} />
      <div className="br-bar">
        <button className="br-nav" disabled={!active.canBack} onClick={() => view()?.goBack()} title="Back" aria-label="Back">
          <Icons.chevronLeft size={18} />
        </button>
        <button className="br-nav" disabled={!active.canForward} onClick={() => view()?.goForward()} title="Forward" aria-label="Forward">
          <Icons.chevronRight size={18} />
        </button>
        <button className="br-nav" onClick={reload} title={active.loading ? 'Stop' : 'Reload'} aria-label={active.loading ? 'Stop' : 'Reload'}>
          {active.loading ? <Icons.x size={17} /> : <Icons.refresh size={16} />}
        </button>
        <button className="br-nav" onClick={home} title="Home" aria-label="Home">
          <Icons.dashboard size={16} />
        </button>
        <form
          className="br-address"
          onSubmit={(e) => {
            e.preventDefault();
            void go(address);
            addressRef.current?.blur();
          }}
        >
          <span className={`br-lock ${secure ? 'ok' : active.current ? 'warn' : ''}`} title={secure ? 'This connection is secure' : active.current ? 'Not a secure (https) connection' : undefined}>
            {secure ? <Icons.lock size={13} /> : active.current ? <Icons.unlock size={13} /> : <Icons.search size={13} />}
          </span>
          <input
            ref={addressRef}
            value={address}
            spellCheck={false}
            onChange={(e) => setAddress(e.target.value)}
            onFocus={(e) => e.target.select()}
            placeholder={`Search ${BROWSER_SEARCH_ENGINES[state?.searchEngine ?? 'duckduckgo'].name} or enter an address`}
            aria-label="Address and search"
          />
          {vault.hasForm(active.id) && (
            <button type="button" className="br-star" onClick={() => void vault.openMenu(active.id)} title="Fill in a sign-in from your Vault" aria-label="Fill in a sign-in">
              <Icons.key size={14} />
            </button>
          )}
          {/^https?:/.test(active.current) && (
            <button type="button" className={`br-star ${bookmarked ? 'on' : ''}`} onClick={toggleBookmark} title={bookmarked ? 'Remove bookmark' : 'Bookmark this page'} aria-label="Bookmark">
              <Icons.tag size={15} />
            </button>
          )}
        </form>
        <button className={`br-nav ${panel === 'fabrix' ? 'on' : ''}`} onClick={() => setPanel(panel === 'fabrix' ? null : 'fabrix')} title={`Ask ${agentName} about this page`} aria-label="Ask Fabrix">
          <Icons.sparkles size={17} />
        </button>
        <button className={`br-nav ${menu ? 'on' : ''}`} onClick={() => setMenu(!menu)} title="Menu" aria-label="Menu">
          <Icons.menu size={17} />
        </button>
        {menu && (
          <BrowserMenu
            active={active}
            state={state}
            onClose={() => setMenu(false)}
            onOpen={(p) => (setPanel(p), setMenu(false))}
            onNewPrivate={() => (newTab(true), setMenu(false))}
            onFind={() => (setFind(''), setMenu(false))}
            zoom={zoom}
            onZoom={setZoomTo}
            toast={toast}
            agentName={agentName}
          />
        )}
      </div>
      {supportAsk && (
        <SupportAskBar
          onClose={() => setSupportAsk(false)}
          onSubmit={(pass) => {
            setSupportAsk(false);
            void call('support.activate', { pass })
              .then(() => toast.success('Support mode on', 'This computer is running with full access until the pass runs out.'))
              .catch((e: Error) => toast.error('That support pass was not accepted', e.message));
          }}
        />
      )}
      {vault.offer?.tabId === active.id && <SaveBar key={vault.offer.password} offer={vault.offer} onDone={vault.dismissOffer} toast={toast} />}
      {find !== null && (
        <FindBar
          value={find}
          onChange={(v) => {
            setFind(v);
            if (v) view()?.findInPage(v);
            else view()?.stopFindInPage('clearSelection');
          }}
          onClose={() => {
            setFind(null);
            view()?.stopFindInPage('clearSelection');
          }}
        />
      )}
      <div className="br-body">
        <div className="br-stage">
          {tabs.map((t) => (
            <div key={t.id} className="br-view" hidden={t.id !== activeId}>
              {t.blocked ? (
                <BlockedPage block={t.blocked} />
              ) : t.url ? (
                // eslint-disable-next-line react/no-unknown-property
                <webview ref={(el) => bindView(t, el as WebviewElement | null)} className="br-webview" src={t.url} partition={partitionFor(t)} {...WEBVIEW_POPUPS} />
              ) : (
                <StartPage state={state} onGo={(u) => void go(u)} onOpenPanel={setPanel} priv={t.priv} agentName={agentName} />
              )}
            </div>
          ))}
          {vault.menu?.tabId === active.id && <FillMenuView menu={vault.menu} onFill={(id) => void vault.fill(active.id, id)} onSuggest={() => vault.suggest(active.id)} onClose={vault.closeMenu} />}
        </div>
        {panel && (
          <SidePanel
            which={panel}
            onClose={() => setPanel(null)}
            state={state}
            active={active}
            pageText={pageText}
            onGo={(u) => {
              void go(u);
              setPanel(null);
            }}
            agentName={agentName}
            toast={toast}
            onFill={(id) => void vault.fill(active.id, id)}
          />
        )}
      </div>
    </div>
  );
}

function TabStrip({ tabs, activeId, onSelect, onClose, onNew }: { tabs: Tab[]; activeId: string; onSelect: (id: string) => void; onClose: (id: string) => void; onNew: () => void }) {
  return (
    <div className="br-tabs">
      {tabs.map((t) => (
        <div key={t.id} className={`br-tab ${t.id === activeId ? 'active' : ''} ${t.priv ? 'priv' : ''}`} onClick={() => onSelect(t.id)} title={t.title}>
          {t.priv ? <Icons.eyeOff size={13} /> : t.loading ? <span className="br-spin" /> : <Favicon url={t.url} />}
          <span className="br-tab-title">{t.title || 'New tab'}</span>
          <button
            className="br-tab-close"
            onClick={(e) => {
              e.stopPropagation();
              onClose(t.id);
            }}
            aria-label="Close tab"
          >
            <Icons.x size={12} />
          </button>
        </div>
      ))}
      <button className="br-tab-new" onClick={onNew} title="New tab (Ctrl+T)" aria-label="New tab">
        <Icons.plus size={15} />
      </button>
    </div>
  );
}

function Favicon({ url }: { url: string }) {
  const h = host(url);
  const [bad, setBad] = useState(false);
  // A new site gets a fresh try at its icon.
  useEffect(() => setBad(false), [h]);
  if (!h) return <FbrxMark size={13} />;
  if (bad) return <span className="br-fav-letter">{h[0]?.toUpperCase() ?? '•'}</span>;
  // The favicon rides along with the page's own session; it is only a hint, so a miss just shows a letter.
  return <img className="br-fav" src={`https://${h}/favicon.ico`} alt="" onError={() => setBad(true)} />;
}

function FindBar({ value, onChange, onClose }: { value: string; onChange: (v: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="br-find">
      <Icons.search size={14} />
      <input ref={ref} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onChange(value)} placeholder="Find on page" aria-label="Find on page" />
      <button onClick={onClose} aria-label="Close find">
        <Icons.x size={14} />
      </button>
    </div>
  );
}

function SupportAskBar({ onSubmit, onClose }: { onSubmit: (pass: string) => void; onClose: () => void }) {
  const [pass, setPass] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <form
      className="br-support"
      onSubmit={(e) => {
        e.preventDefault();
        if (pass.trim()) onSubmit(pass.trim());
      }}
    >
      <Icons.wrench size={14} />
      <input ref={ref} value={pass} onChange={(e) => setPass(e.target.value)} placeholder={`Paste the support pass (${SUPPORT_PASS_PREFIX}.…)`} aria-label="Support pass" />
      <Button size="sm" variant="primary" type="submit" disabled={!pass.trim()}>
        Start
      </Button>
      <button type="button" onClick={onClose} aria-label="Cancel">
        <Icons.x size={14} />
      </button>
    </form>
  );
}

function BlockedPage({ block }: { block: { reason: string; url: string } }) {
  return (
    <div className="br-blocked">
      <div className="br-blocked-card">
        <Icons.shield size={40} />
        <h2>This page is blocked</h2>
        <p>{block.reason}</p>
        <p className="br-muted mono">{host(block.url)}</p>
      </div>
    </div>
  );
}

function StartPage({ state, onGo, onOpenPanel, priv, agentName }: { state: BrowserState | null; onGo: (u: string) => void; onOpenPanel: (p: 'bookmarks' | 'history') => void; priv: boolean; agentName: string }) {
  const [q, setQ] = useState('');
  const marks = (state?.bookmarks ?? []).slice(0, 12);
  return (
    <div className="br-start">
      <div className="br-start-inner">
        <div className="br-start-brand">
          <FbrxMark size={40} />
          <h1>FBRX Browser</h1>
        </div>
        {priv && (
          <p className="br-start-private">
            <Icons.eyeOff size={14} /> Private tab — nothing here is kept once it closes.
          </p>
        )}
        <form
          className="br-start-search"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) onGo(q);
          }}
        >
          <Icons.search size={18} />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search the web, or type an address — ${agentName} is a click away`} aria-label="Search the web" />
        </form>
        {marks.length > 0 && (
          <div className="br-start-marks">
            {marks.map((b) => (
              <button key={b.id} className="br-tile" onClick={() => onGo(b.url)} title={b.url}>
                <Favicon url={b.url} />
                <span>{b.title}</span>
              </button>
            ))}
          </div>
        )}
        <div className="br-start-links">
          <button onClick={() => onOpenPanel('bookmarks')}>
            <Icons.tag size={14} /> Bookmarks
          </button>
          <button onClick={() => onOpenPanel('history')}>
            <Icons.history size={14} /> History
          </button>
        </div>
        {state?.policy.managed && (
          <p className="br-start-managed">
            <Icons.lock size={12} /> Your organization sets which sites open here.
          </p>
        )}
      </div>
    </div>
  );
}

type Toaster = ReturnType<typeof useToast>;

function BrowserMenu({ active, state, onClose, onOpen, onNewPrivate, onFind, zoom, onZoom, toast, agentName }: { active: Tab; state: BrowserState | null; onClose: () => void; onOpen: (p: 'bookmarks' | 'history' | 'passwords') => void; onNewPrivate: () => void; onFind: () => void; zoom: number; onZoom: (z: number) => void; toast: Toaster; agentName: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);
  const onPage = /^https?:/.test(active.current);
  const saveNote = async () => {
    await call('notes.save', { title: active.title || host(active.current), content: `${active.title}\n${active.current}` });
    toast.success('Saved to Notes', active.title || active.current);
    onClose();
  };
  const copyLink = async () => {
    await (bridge.copyText?.(active.current) ?? navigator.clipboard.writeText(active.current));
    toast.info('Link copied');
    onClose();
  };
  return (
    <div className="br-menu" ref={ref} role="menu">
      <button role="menuitem" onClick={onNewPrivate}>
        <Icons.eyeOff size={15} /> New private tab
      </button>
      <div className="br-menu-zoom">
        <span>Zoom</span>
        <button onClick={() => onZoom(zoom - 0.1)} aria-label="Zoom out">
          <Icons.x size={12} />
        </button>
        <b>{Math.round(zoom * 100)}%</b>
        <button onClick={() => onZoom(zoom + 0.1)} aria-label="Zoom in">
          <Icons.plus size={12} />
        </button>
      </div>
      <button role="menuitem" onClick={onFind}>
        <Icons.search size={15} /> Find on page
      </button>
      <div className="br-menu-sep" />
      <button role="menuitem" onClick={() => onOpen('bookmarks')}>
        <Icons.tag size={15} /> Bookmarks
      </button>
      <button role="menuitem" onClick={() => onOpen('history')}>
        <Icons.history size={15} /> History
      </button>
      <button role="menuitem" onClick={() => onOpen('passwords')}>
        <Icons.key size={15} /> Saved sign-ins
      </button>
      <div className="br-menu-sep" />
      <button role="menuitem" disabled={!onPage} onClick={saveNote}>
        <Icons.note size={15} /> Save to Notes
      </button>
      <button role="menuitem" disabled={!onPage} onClick={copyLink}>
        <Icons.copy size={15} /> Copy link
      </button>
      <button role="menuitem" disabled={!onPage} onClick={() => (bridge.openExternal?.(active.current), onClose())}>
        <Icons.external size={15} /> Open in system browser
      </button>
      <div className="br-menu-sep" />
      <div className="br-menu-foot">
        {state?.shieldOn ? (
          <span className="br-ok">
            <Icons.shield size={12} /> FBRX Shield checks downloads
          </span>
        ) : (
          <span className="br-muted">Turn on FBRX Shield to check downloads</span>
        )}
      </div>
    </div>
  );
}

function SidePanel({ which, onClose, state, active, pageText, onGo, agentName, toast, onFill }: { which: 'fabrix' | 'bookmarks' | 'history' | 'passwords'; onClose: () => void; state: BrowserState | null; active: Tab; pageText: () => Promise<string>; onGo: (u: string) => void; agentName: string; toast: Toaster; onFill: (id: string) => void }) {
  return (
    <aside className="br-panel">
      <div className="br-panel-head">
        <strong>{which === 'fabrix' ? agentName : which === 'bookmarks' ? 'Bookmarks' : which === 'history' ? 'History' : 'Saved sign-ins'}</strong>
        <button onClick={onClose} aria-label="Close panel">
          <Icons.x size={15} />
        </button>
      </div>
      <div className="br-panel-body">
        {which === 'fabrix' && <FabrixPanel active={active} pageText={pageText} agentName={agentName} reads={state?.aiAssist !== false} />}
        {which === 'bookmarks' && <BookmarksPanel bookmarks={state?.bookmarks ?? []} onGo={onGo} />}
        {which === 'history' && <HistoryPanel onGo={onGo} />}
        {which === 'passwords' && <SignInsPanel active={active} onFill={onFill} toast={toast} />}
      </div>
    </aside>
  );
}

function FabrixPanel({ active, pageText, agentName, reads }: { active: Tab; pageText: () => Promise<string>; agentName: string; reads: boolean }) {
  const ai = useQuickAi();
  // With reading pages turned off (Settings → Browser), the page buttons go and only plain questions remain.
  const onPage = reads && /^https?:/.test(active.current);
  // Fabrix answers from the live page text (read here on the computer), or just the question when there is no page.
  const ask = async (label: string, instruction: string) => {
    const text = await pageText();
    if (!text) return void ai.ask(label, `${instruction}${active.priv ? "\n\n(This is a private tab, so the page's text was not read.)" : ''}`);
    void ai.ask(label, `${instruction}\n\nThe page is "${active.title}" (${active.current}). Here is its text:\n\n${text}`, text);
  };
  return (
    <QuickAiPanel
      ai={ai}
      className="br-fabrix"
      onAsk={(text) => void ask(text, text)}
      placeholder={`Ask ${agentName} about this page…`}
      empty={
        <p className="br-muted">
          {!reads
            ? `${agentName} does not read pages (Settings → Browser). You can still ask a question.`
            : onPage
              ? `Ask ${agentName} about this page. It reads the page here on your computer — nothing is sent away.`
              : `Open a page and ${agentName} can read and explain it, or just ask a question.`}
        </p>
      }
      actions={
        <>
          <Button size="sm" variant="ghost" disabled={!onPage || ai.busy} onClick={() => ask('Summarize this page', 'Summarize this web page in a few clear sentences.')}>
            Summarize
          </Button>
          <Button size="sm" variant="ghost" disabled={!onPage || ai.busy} onClick={() => ask('Key points', 'List the key points of this web page as a short bulleted list.')}>
            Key points
          </Button>
          <Button size="sm" variant="ghost" disabled={!onPage || ai.busy} onClick={() => ask('Explain simply', 'Explain what this web page is about in plain language, as if to someone new to the topic.')}>
            Explain simply
          </Button>
        </>
      }
    />
  );
}

function BookmarksPanel({ bookmarks, onGo }: { bookmarks: Bookmark[]; onGo: (u: string) => void }) {
  const [q, setQ] = useState('');
  const list = bookmarks.filter((b) => !q || b.title.toLowerCase().includes(q.toLowerCase()) || b.url.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="br-list">
      <input className="br-list-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search bookmarks" aria-label="Search bookmarks" />
      {list.length === 0 && <p className="br-muted br-empty">No bookmarks yet. Tap the tag in the address bar to keep a page.</p>}
      {list.map((b) => (
        <div key={b.id} className="br-row">
          <button className="br-row-main" onClick={() => onGo(b.url)}>
            <Favicon url={b.url} />
            <span className="br-row-text">
              <b>{b.title}</b>
              <small>{host(b.url)}</small>
            </span>
          </button>
          <button className="br-row-x" onClick={() => void call('browser.removeBookmark', { id: b.id })} aria-label="Remove">
            <Icons.trash size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

function HistoryPanel({ onGo }: { onGo: (u: string) => void }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<HistoryEntry[]>([]);
  const load = useCallback(() => void call('browser.history', { query: q || undefined, limit: 300 }).then(setItems).catch(() => undefined), [q]);
  useEffect(() => {
    load();
    return onEvent('browser.changed', load);
  }, [load]);
  return (
    <div className="br-list">
      <input className="br-list-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search history" aria-label="Search history" />
      <div className="br-list-top">
        <button className="br-clear" onClick={() => void call('browser.clearHistory', {}).then(() => setItems([]))}>
          Clear history
        </button>
      </div>
      {items.length === 0 && <p className="br-muted br-empty">Nothing here yet.</p>}
      {items.map((h) => (
        <button key={h.id} className="br-row br-row-main" onClick={() => onGo(h.url)}>
          <Favicon url={h.url} />
          <span className="br-row-text">
            <b>{h.title}</b>
            <small>
              {host(h.url)} · {new Date(h.visitedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </small>
          </span>
        </button>
      ))}
    </div>
  );
}
