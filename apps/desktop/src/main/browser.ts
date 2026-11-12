import { app, BrowserWindow, clipboard, Menu, screen, session, shell, type ContextMenuParams, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type Session, type WebContents } from 'electron';
import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import { certificateFingerprint, type Kernel } from '@fbrx/core';
import { PRODUCT_NAME, WEB_BROWSER_PARTITION, WEB_BROWSER_PRIVATE_PARTITION, YOUTUBE_RESTRICT_HOSTS, hostMatches, isLocalHost, policyAllows, safeSearchUrl, type BrowserCertificateProblem } from '@fbrx/shared';
import { openExternalSafe } from './platform';

/**
 * FBRX Browser: a real web browser inside FBRX OS, in its own window. Pages load in locked-down <webview>s with their
 * own storage (WEB_BROWSER_PARTITION), apart from FBRX's own pages. The main process hardens that session: it enforces
 * the browsing policy on every page and frame (not only what is typed), applies safe browsing, checks every download
 * with FBRX Shield, keeps web permissions off by default, and sends pages that try to open a new window back to the
 * browser as a new tab. The tabs, the address bar and Fabrix live in the renderer (pages/browser).
 */

let browserWin: BrowserWindow | null = null;

/**
 * Certificates the person chose to go on with, as "host fingerprint": for this run of FBRX only, as browsers do, and
 * only for an address on this computer or the home network (a public site with a bad certificate stays refused).
 */
const trustedCertificates = new Set<string>();

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

/** Whether a certificate may be trusted for a host here: a local address, and safe browsing off. */
function mayTrust(deps: BrowserDeps, host: string): boolean {
  return !!host && isLocalHost(host.replace(/:\d+$/, '')) && !deps.kernel()?.browser.policy().safeBrowsing;
}

/** Goes on with a certificate the person compared (FBRX Browser's "It matches: go on"). */
export function trustBrowserCertificate(deps: BrowserDeps, host: string, fingerprint: string): boolean {
  if (!mayTrust(deps, host)) return false;
  trustedCertificates.add(`${host} ${fingerprint}`);
  return true;
}

/** The web permissions FBRX Browser allows at all (others — camera, microphone, location… — are refused). */
const WEB_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);

export interface BrowserDeps {
  kernel: () => Kernel | null;
  rendererUrl: string | null;
  appPath: string;
  actor: string;
  /** Tells the renderer to open a URL a page asked to pop up as a new tab in the browser window. */
  onPopup: (url: string) => void;
  /** A finished download Shield found nothing in, or did not check. A finding raises Shield's own alert instead. */
  onDownload: (d: { name: string; path: string; checked: boolean }) => void;
}

/** The browser's own sessions (ordinary and private), so its rules never touch FBRX's pages or server consoles. */
function webSessions(): Session[] {
  return [session.fromPartition(WEB_BROWSER_PARTITION), session.fromPartition(WEB_BROWSER_PRIVATE_PARTITION)];
}

/** Hardens the web sessions once, at start. Call before any browser window opens. */
export function setupWebSessions(deps: BrowserDeps): void {
  const sessions = webSessions();
  for (const ses of sessions) {
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(WEB_PERMISSIONS.has(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => WEB_PERMISSIONS.has(permission));
    // The browsing policy, for every page and frame: blocked sites are refused (the tab shows why), and with safe
    // browsing on, searches go to their strict-SafeSearch version.
    ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, cb) => {
      const k = deps.kernel();
      if (!k || (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame')) return cb({});
      const policy = k.browser.policy();
      if (!policyAllows(details.url, policy).ok) return cb({ cancel: true });
      const strict = policy.safeBrowsing ? safeSearchUrl(details.url) : null;
      cb(strict ? { redirectURL: strict } : {});
    });
    ses.webRequest.onBeforeSendHeaders((details, cb) => {
      const headers = details.requestHeaders;
      const k = deps.kernel();
      // Ask sites not to track, when the person chose that.
      if (k?.settings.get().browser.doNotTrack) {
        headers['DNT'] = '1';
        headers['Sec-GPC'] = '1';
      }
      // Safe browsing: YouTube's Restricted Mode, by the header YouTube itself reads for it.
      if (k?.browser.policy().safeBrowsing) {
        try {
          const h = new URL(details.url).hostname;
          if (YOUTUBE_RESTRICT_HOSTS.some((p) => hostMatches(h, p))) headers['YouTube-Restrict'] = 'Strict';
        } catch {
          /* not a URL we can read */
        }
      }
      cb({ requestHeaders: headers });
    });
    ses.on('will-download', (_e, item) => {
      item.once('done', (_ev, state) => {
        const path = item.getSavePath();
        if (state !== 'completed' || !path) return;
        const name = basename(path);
        const k = deps.kernel();
        if (!k || !k.browser.state().shieldOn) return void deps.onDownload({ name, path, checked: false });
        // FBRX Shield checks it as a download: malware goes to quarantine and Shield raises its own alert.
        void k.shield
          .checkDownload(path)
          .then((found) => {
            if (!found) deps.onDownload({ name, path, checked: true });
          })
          .catch(() => deps.onDownload({ name, path, checked: false }));
      });
    });
  }
  // A certificate no authority vouches for: refused, unless the person already went on with it for that address. The
  // tab says why and shows its fingerprint (pages/browser). Server consoles (server-browser.ts) answer for their own.
  app.on('certificate-error', (event, wc, url, error, certificate, callback) => {
    if (!sessions.includes(wc.session)) return;
    const host = hostOf(url);
    const fingerprint = certificateFingerprint(certificate.fingerprint);
    if (trustedCertificates.has(`${host} ${fingerprint}`)) {
      event.preventDefault();
      return callback(true);
    }
    callback(false);
    const problem: BrowserCertificateProblem = { webContentsId: wc.id, url, host, error, fingerprint, issuer: certificate.issuerName, validTo: new Date(certificate.validExpiry * 1000).toISOString(), canTrust: mayTrust(deps, host) };
    browserWin?.webContents.send('fbrx:browser-certificate', problem);
  });
  // A page in the browser that opens a new window gets a new tab instead; anything not on the web goes to the system
  // browser. Server consoles (their own session, server-browser.ts) keep their own handling.
  app.on('web-contents-created', (_e, wc) => {
    if (wc.getType() !== 'webview' || !sessions.includes(wc.session)) return;
    // Ctrl+click or a middle click opens the link in a tab behind this one; a private tab's links stay private.
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (!/^https?:\/\//i.test(url)) openExternalSafe(url);
      else if (browserWin && !browserWin.isDestroyed()) openTab(url, { background: disposition === 'background-tab', priv: wc.session === sessions[1] });
      else deps.onPopup(url);
      return { action: 'deny' };
    });
    wc.on('context-menu', (_ev, params) => {
      const menu = Menu.buildFromTemplate(pageMenu(wc, params, wc.session === sessions[1]));
      if (menu.items.length) menu.popup({ window: browserWin && !browserWin.isDestroyed() ? browserWin : undefined });
    });
  });
}

/** Asks the browser window for a new tab: in front, behind the current one, private, or a web search for some text. */
function openTab(url: string, o: { background?: boolean; priv?: boolean; search?: boolean } = {}): void {
  if (browserWin && !browserWin.isDestroyed()) browserWin.webContents.send('fbrx:browser-open', url, o);
}

/**
 * A web page's right-click menu, as in other browsers: for a link, an image, selected text or a box being typed in,
 * then back, forward, reload and print. Links open in a new tab behind this one (a private tab's links stay private).
 */
export function pageMenu(wc: WebContents, p: ContextMenuParams, priv: boolean): MenuItemConstructorOptions[] {
  const web = (u: string) => /^https?:\/\//i.test(u);
  const groups: MenuItemConstructorOptions[][] = [];
  if (p.linkURL && web(p.linkURL)) {
    groups.push([
      { label: 'Open link in new tab', click: () => openTab(p.linkURL, { background: true, priv }) },
      ...(priv ? [] : [{ label: 'Open link in new private tab', click: () => openTab(p.linkURL, { background: true, priv: true }) }]),
      { label: 'Open link in your default browser', click: () => void shell.openExternal(p.linkURL) },
      { label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) },
      ...(p.linkText ? [{ label: 'Copy link text', click: () => clipboard.writeText(p.linkText) }] : []),
    ]);
  }
  if (p.mediaType === 'image' && p.srcURL) {
    groups.push([
      ...(web(p.srcURL) ? [{ label: 'Open image in new tab', click: () => openTab(p.srcURL, { background: true, priv }) }] : []),
      { label: 'Save image as…', click: () => wc.downloadURL(p.srcURL) },
      { label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) },
      ...(web(p.srcURL) ? [{ label: 'Copy image address', click: () => clipboard.writeText(p.srcURL) }] : []),
    ]);
  }
  if (p.isEditable) {
    const spelling: MenuItemConstructorOptions[] = p.misspelledWord
      ? [
          ...p.dictionarySuggestions.slice(0, 4).map((s) => ({ label: s, click: () => wc.replaceMisspelling(s) })),
          { label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) },
          { type: 'separator' as const },
        ]
      : [];
    groups.push([
      ...spelling,
      { label: 'Undo', role: 'undo', enabled: p.editFlags.canUndo },
      { label: 'Redo', role: 'redo', enabled: p.editFlags.canRedo },
      { type: 'separator' },
      { label: 'Cut', role: 'cut', enabled: p.editFlags.canCut },
      { label: 'Copy', role: 'copy', enabled: p.editFlags.canCopy },
      { label: 'Paste', role: 'paste', enabled: p.editFlags.canPaste },
      { label: 'Select all', role: 'selectAll' },
    ]);
  } else if (p.selectionText.trim()) {
    const text = p.selectionText.trim().replace(/\s+/g, ' ');
    const shown = text.length > 30 ? `${text.slice(0, 29)}…` : text;
    groups.push([
      { label: 'Copy', role: 'copy' },
      { label: `Search the web for “${shown}”`, click: () => openTab(text.slice(0, 500), { search: true, priv }) },
    ]);
  }
  if (!p.linkURL && p.mediaType === 'none' && !p.isEditable && !p.selectionText.trim()) {
    groups.push([
      { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Select all', role: 'selectAll' },
      { label: 'Print…', click: () => wc.print() },
    ]);
  }
  return groups.filter((g) => g.length).flatMap((g, i) => (i ? [{ type: 'separator' as const }, ...g] : g));
}

/** Opens FBRX Browser in its own window, or brings it forward (optionally to a URL). */
export function openBrowserWindow(deps: BrowserDeps, url?: string): void {
  if (browserWin && !browserWin.isDestroyed()) {
    if (browserWin.isMinimized()) browserWin.restore();
    browserWin.show();
    browserWin.focus();
    if (url) browserWin.webContents.send('fbrx:browser-open', url);
    return;
  }
  const area = screen.getPrimaryDisplay().workArea;
  browserWin = new BrowserWindow({
    width: Math.min(1280, area.width - 60),
    height: Math.min(860, area.height - 60),
    minWidth: 680,
    minHeight: 480,
    title: 'FBRX Browser',
    show: false,
    backgroundColor: '#0d0d0d',
    icon: browserIcon(deps.appPath),
    webPreferences: {
      preload: join(deps.appPath, 'dist', 'preload', 'index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: true,
    },
  });
  const w = browserWin;
  guardWebBrowser(w, deps.appPath);
  w.once('ready-to-show', () => w.show());
  w.on('closed', () => (browserWin = null));
  // The window chrome itself (FBRX's page) never leaves FBRX; web pages live only in the webviews.
  w.webContents.setWindowOpenHandler(({ url: u }) => {
    openExternalSafe(u);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, u) => {
    if (deps.rendererUrl ? !u.startsWith(deps.rendererUrl) : !u.startsWith('file://')) {
      e.preventDefault();
      openExternalSafe(u);
    }
  });
  // The first address rides along in the window's own address: a message sent while the page starts would be missed.
  const query: Record<string, string> = { browser: '1', ...(url && /^https?:\/\//i.test(url) ? { open: url } : {}) };
  if (deps.rendererUrl) void w.loadURL(`${deps.rendererUrl}?${new URLSearchParams(query)}#/browser`);
  else void w.loadFile(join(deps.appPath, 'dist', 'renderer', 'index.html'), { hash: '/browser', query });
}

export function browserWindowOpen(): boolean {
  return !!browserWin && !browserWin.isDestroyed();
}

/** The browser window's web contents, so core events (browser/account/license changed) reach it too. */
export function browserWebContents(): Electron.WebContents | null {
  return browserWin && !browserWin.isDestroyed() ? browserWin.webContents : null;
}

/**
 * Only the browser window's own web webviews are allowed; locked down whatever the page asked for. Each web page gets
 * FBRX's sign-in helper (the Vault's extension) and nothing else: it runs sandboxed, in a world of its own the page
 * cannot reach, and talks only to the browser window.
 */
export function guardWebBrowser(win: BrowserWindow, appPath: string): void {
  const helper = join(appPath, 'dist', 'preload', 'autofill.cjs');
  win.webContents.on('will-attach-webview', (_e, prefs, params) => {
    delete prefs.preload;
    if ((params.partition === WEB_BROWSER_PARTITION || params.partition === WEB_BROWSER_PRIVATE_PARTITION) && existsSync(helper)) prefs.preload = helper;
    prefs.nodeIntegration = false;
    prefs.nodeIntegrationInSubFrames = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.webSecurity = true;
    prefs.allowRunningInsecureContent = false;
  });
}

function browserIcon(appPath: string): string | undefined {
  const p = join(appPath, 'dist', 'assets', 'icon.png');
  return existsSync(p) ? p : undefined;
}

/** Download the finished file's folder in the system file manager (from the browser's download toast). */
export function revealDownload(_e: IpcMainInvokeEvent, path: string): void {
  if (typeof path === 'string') shell.showItemInFolder(path);
}

export const BROWSER_PRODUCT = `${PRODUCT_NAME} Browser`;
