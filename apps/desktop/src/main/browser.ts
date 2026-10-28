import { app, BrowserWindow, screen, session, shell, type IpcMainInvokeEvent, type Session } from 'electron';
import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Kernel } from '@fbrx/core';
import { PRODUCT_NAME, WEB_BROWSER_PARTITION, WEB_BROWSER_PRIVATE_PARTITION, YOUTUBE_RESTRICT_HOSTS, hostMatches, policyAllows, safeSearchUrl } from '@fbrx/shared';
import { openExternalSafe } from './platform';

/**
 * FBRX Browser: a real web browser inside FBRX OS, in its own window. Pages load in locked-down <webview>s with their
 * own storage (WEB_BROWSER_PARTITION), apart from FBRX's own pages. The main process hardens that session: it enforces
 * the browsing policy on every page and frame (not only what is typed), applies safe browsing, checks every download
 * with FBRX Shield, keeps web permissions off by default, and sends pages that try to open a new window back to the
 * browser as a new tab. The tabs, the address bar and Fabrix live in the renderer (pages/browser).
 */

let browserWin: BrowserWindow | null = null;

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
  // A page in the browser that opens a new window gets a new tab instead; anything not on the web goes to the system
  // browser. Server consoles (their own session, server-browser.ts) keep their own handling.
  app.on('web-contents-created', (_e, wc) => {
    if (wc.getType() !== 'webview' || !sessions.includes(wc.session)) return;
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) deps.onPopup(url);
      else openExternalSafe(url);
      return { action: 'deny' };
    });
  });
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
