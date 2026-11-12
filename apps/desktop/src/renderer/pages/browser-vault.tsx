import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { AUTOFILL_CHANNEL, displayHost, generatePassword, loginMatch, siteOf, type AutofillFill, type AutofillReport, type LoginSummary, type Settings } from '@fbrx/shared';
import { Button, Icons, Spinner, useToast } from '@fbrx/ui';
import { bridge, call, copySecret, onEvent, writeClipboard } from '../client';
import { saveToVault } from '../vault-save';
import type { Tab, WebviewElement } from './browser';

/**
 * The Vault in FBRX Browser. The sign-in helper in each page (preload/autofill.ts) says when a sign-in form's box has
 * the focus; the Vault's sign-ins for that site show beside it, and the one picked goes from the core straight to the
 * page's helper, for that page's own site only. When a site's sign-in form is sent with something the Vault does not
 * have, the browser offers to save it (or to update the password it has). Nothing here keeps a password.
 */

/** The Vault's sign-ins offered beside a sign-in box (`at`, in the stage's pixels) or under the toolbar's key. */
export interface FillMenu {
  tabId: string;
  /** null: the Vault is locked. */
  logins: LoginSummary[] | null;
  /** The form chooses a new password (a sign-up or a change). */
  isNew: boolean;
  at: { left: number; top: number } | null;
}

/** A sign-in typed into a site that the Vault does not have yet, or has with another password. */
export interface SaveOffer {
  tabId: string;
  url: string;
  username: string;
  password: string;
  update: { id: string; title: string } | null;
}

type Toaster = ReturnType<typeof useToast>;

/** Just under a box of the page, in the stage's pixels (the page may be zoomed). */
const below = (rect: { x: number; y: number; height: number }, zoom: number) => ({ left: rect.x * zoom, top: (rect.y + rect.height) * zoom + 4 });

function pageUrl(views: MutableRefObject<Map<string, WebviewElement>>, tabId: string): string | null {
  try {
    const url = views.current.get(tabId)?.getURL() ?? '';
    return /^https?:/.test(url) ? url : null;
  } catch {
    return null;
  }
}

/** The browser window's side of the Vault extension: what the pages report, and filling them in. */
export function useBrowserVault(views: MutableRefObject<Map<string, WebviewElement>>, zoom: number, toast: Toaster) {
  const [menu, setMenu] = useState<FillMenu | null>(null);
  const [offer, setOffer] = useState<SaveOffer | null>(null);
  const [forms, setForms] = useState<Record<string, boolean>>({});
  const settings = useRef<Settings['passwords'] | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  // Enter, the form and its button can all report one sign-in: it is offered once.
  const offered = useRef(new Set<string>());

  useEffect(() => {
    const load = () => void call('settings.get').then((s) => (settings.current = s.settings.passwords)).catch(() => undefined);
    load();
    return onEvent('settings.changed', load);
  }, []);

  const report = useCallback(
    async (tab: Tab, r: AutofillReport) => {
      if (r.type === 'forms') return setForms((f) => ({ ...f, [tab.id]: r.present }));
      if (r.type === 'away' || r.type === 'filled') return setMenu((m) => (m?.tabId === tab.id ? null : m));
      if (r.type === 'moved') return setMenu((m) => (m?.tabId === tab.id && m.at ? { ...m, at: below(r.rect, zoomRef.current) } : m));
      const url = pageUrl(views, tab.id);
      if (!url) return;
      if (r.type === 'focus') {
        // A locked Vault offers nothing here (the toolbar's key says why); a new password can still be made.
        const logins = await call('passwords.query', { url }).catch(() => null);
        if (!logins?.length && !r.isNew) return setMenu(null);
        setMenu({ tabId: tab.id, logins: logins ?? [], isNew: r.isNew, at: below(r.rect, zoomRef.current) });
        return;
      }
      const site = siteOf(url);
      const s = settings.current;
      if (tab.priv || !site || !s?.offerToSave || s.neverSave.includes(site)) return;
      const key = `${tab.id}\n${r.username}\n${r.password}`;
      if (offered.current.has(key)) return;
      offered.current.add(key);
      setTimeout(() => offered.current.delete(key), 15_000);
      const v = await call('passwords.verify', { url, username: r.username, password: r.password }).catch(() => null);
      if (!v || v.found === 'same') return;
      setOffer({ tabId: tab.id, url, username: r.username, password: r.password, update: v.found === 'changed' && v.id ? { id: v.id, title: v.title ?? displayHost(url) } : null });
    },
    [views],
  );

  /** Gives the page's helper a sign-in to type in: for the page's own origin only. */
  const send = (tabId: string, url: string, fill: Omit<AutofillFill, 'origin'>) => views.current.get(tabId)?.send(AUTOFILL_CHANNEL, { origin: new URL(url).origin, ...fill } satisfies AutofillFill);

  const fill = async (tabId: string, id: string) => {
    const url = pageUrl(views, tabId);
    setMenu(null);
    if (!url) return;
    try {
      send(tabId, url, await call('passwords.fill', { id, url }));
    } catch (e) {
      toast.error('That sign-in could not be filled in', (e as Error).message);
    }
  };

  /** A new strong password into a sign-up or change-password form; saving it is offered when the form is sent. */
  const suggest = (tabId: string) => {
    const url = pageUrl(views, tabId);
    setMenu(null);
    if (url) send(tabId, url, { username: '', password: generatePassword() });
  };

  const openMenu = async (tabId: string) => {
    const url = pageUrl(views, tabId);
    if (!url) return;
    setMenu({ tabId, logins: await call('passwords.query', { url }).catch(() => null), isNew: false, at: null });
  };

  /** A tab went somewhere else: its form and menu went with the old page (a save offer stays for the new one). */
  const navigated = useCallback((tabId: string) => {
    setForms((f) => ({ ...f, [tabId]: false }));
    setMenu((m) => (m?.tabId === tabId ? null : m));
  }, []);

  return { menu, offer, closeMenu: () => setMenu(null), dismissOffer: () => setOffer(null), hasForm: (tabId: string) => !!forms[tabId], report, navigated, fill, suggest, openMenu };
}

/** The Vault's sign-ins for the page, beside the box the person is in (or under the toolbar's key). */
export function FillMenuView({ menu, onFill, onSuggest, onClose }: { menu: FillMenu; onFill: (id: string) => void; onSuggest: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    window.addEventListener('keydown', key);
    window.addEventListener('mousedown', down);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('mousedown', down);
    };
  }, [onClose]);
  const style = menu.at ? { left: Math.max(8, menu.at.left), top: menu.at.top } : undefined;
  return (
    <div ref={ref} className={`br-fill${menu.at ? '' : ' from-key'}`} style={style} role="menu" aria-label="Sign-ins from your Vault">
      <div className="br-fill-head">
        <Icons.key size={12} /> FBRX Vault
      </div>
      {menu.logins === null ? (
        <p className="br-fill-note">The Vault is locked. Unlock it in FBRX to fill in your sign-ins.</p>
      ) : (
        menu.logins.map((l) => (
          <button key={l.id} role="menuitem" className="br-fill-item" onClick={() => onFill(l.id)}>
            <span className="br-fill-mark">{(l.username || l.title).charAt(0).toUpperCase()}</span>
            <span className="br-fill-text">
              <b>{l.username || l.title}</b>
              <small>
                {l.title}
                {l.urls[0] ? ` · ${displayHost(l.urls[0])}` : ''}
              </small>
            </span>
          </button>
        ))
      )}
      {menu.isNew && (
        <button role="menuitem" className="br-fill-item" onClick={onSuggest}>
          <span className="br-fill-mark accent">
            <Icons.dice size={14} />
          </span>
          <span className="br-fill-text">
            <b>Use a strong password</b>
            <small>FBRX makes one for this site</small>
          </span>
        </button>
      )}
      {menu.logins?.length === 0 && !menu.isNew && <p className="br-fill-note">No sign-ins for this site yet. Sign in and FBRX offers to save it.</p>}
      <button className="br-fill-foot" onClick={() => bridge.openMain?.('vault')}>
        Open Vault
      </button>
    </div>
  );
}

/** "Save your sign-in?", under the toolbar after a site's sign-in form was sent. */
export function SaveBar({ offer, onDone, toast }: { offer: SaveOffer; onDone: () => void; toast: Toaster }) {
  const [busy, setBusy] = useState(false);
  const host = displayHost(offer.url);
  const act = async (what: 'save' | 'never') => {
    setBusy(true);
    try {
      if (what === 'never') {
        const s = await call('settings.get');
        const site = siteOf(offer.url)!;
        await call('settings.update', { patch: { passwords: { neverSave: [...new Set([...s.settings.passwords.neverSave, site])] } } });
        toast.info(`FBRX won't offer to save sign-ins for ${site}`, 'Change that under Vault → Security.');
      } else {
        await call('passwords.save', offer.update ? { id: offer.update.id, password: offer.password } : { urls: [new URL(offer.url).origin], username: offer.username, password: offer.password });
        toast.success(offer.update ? 'Password updated in your Vault' : 'Saved to your Vault', offer.update ? 'The old one is kept in its history.' : `FBRX fills it in on ${host} from now on.`);
      }
      onDone();
    } catch (e) {
      toast.error('Not saved', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="br-save" role="alert">
      <Icons.key size={14} />
      <span className="br-save-text">
        {offer.update ? (
          <>
            Update the password of <b>{offer.update.title}</b>
            {offer.username && <> ({offer.username})</>} in your Vault?
          </>
        ) : (
          <>
            Save your sign-in for <b>{host}</b>
            {offer.username && <> as {offer.username}</>} in your Vault?
          </>
        )}
      </span>
      <Button size="sm" variant="primary" loading={busy} onClick={() => void act('save')}>
        {offer.update ? 'Update' : 'Save'}
      </Button>
      {!offer.update && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act('never')}>
          Never for this site
        </Button>
      )}
      <Button size="sm" variant="ghost" disabled={busy} onClick={onDone}>
        Not now
      </Button>
    </div>
  );
}

/** The side panel's sign-ins: this site's first, then the rest; fill, copy, or add one. */
export function SignInsPanel({ active, onFill, toast }: { active: Tab; onFill: (id: string) => void; toast: Toaster }) {
  const [list, setList] = useState<LoginSummary[] | null>(null);
  const [locked, setLocked] = useState(false);
  const [q, setQ] = useState('');
  useEffect(() => {
    const load = () =>
      void call('passwords.list')
        .then((l) => {
          setList(l);
          setLocked(false);
        })
        .catch(() => setLocked(true));
    load();
    return onEvent('vault.changed', load);
  }, []);
  const onPage = /^https?:/.test(active.current) ? active.current : null;
  const copyPassword = async (id: string) => {
    try {
      await copySecret((await call('passwords.reveal', { id })).password);
      toast.success('Password copied', 'It leaves the clipboard again shortly.');
    } catch (e) {
      toast.error('Not copied', (e as Error).message);
    }
  };
  if (locked) return <p className="br-muted br-empty">The Vault is locked. Unlock it in FBRX to use your sign-ins.</p>;
  if (!list) return <Spinner />;
  const term = q.trim().toLowerCase();
  const fits = (l: LoginSummary) => !!onPage && loginMatch(l.urls, onPage) > 0;
  const shown = list.filter((l) => !term || l.title.toLowerCase().includes(term) || l.username.toLowerCase().includes(term) || l.urls.some((u) => u.includes(term))).sort((a, b) => Number(fits(b)) - Number(fits(a)));
  return (
    <div className="br-list">
      <input className="br-list-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your sign-ins" aria-label="Search sign-ins" />
      <div className="br-list-top">
        <button className="br-add" onClick={() => saveToVault({ url: onPage ? new URL(onPage).origin : '' })}>
          Add a sign-in
        </button>
      </div>
      {shown.length === 0 && <p className="br-muted br-empty">{list.length ? 'Nothing matches.' : 'No sign-ins yet. Sign in to a site and FBRX offers to save it, or add one here.'}</p>}
      {shown.map((l) => (
        <div key={l.id} className="br-row br-signin">
          <span className="br-row-text">
            <b>{l.title}</b>
            <small>
              {l.username || 'No username'}
              {l.urls[0] ? ` · ${displayHost(l.urls[0])}` : ''}
            </small>
          </span>
          {fits(l) && (
            <button className="br-row-copy" onClick={() => onFill(l.id)}>
              Fill in
            </button>
          )}
          {l.username && (
            <button className="br-row-x" title="Copy username" aria-label="Copy username" onClick={() => void writeClipboard(l.username).then(() => toast.info('Username copied'))}>
              <Icons.user size={13} />
            </button>
          )}
          <button className="br-row-x" title="Copy password" aria-label="Copy password" onClick={() => void copyPassword(l.id)}>
            <Icons.copy size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
