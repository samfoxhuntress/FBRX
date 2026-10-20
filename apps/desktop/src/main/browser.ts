import { app, BrowserWindow, screen, session, shell, type IpcMainInvokeEvent } from 'electron';
import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Kernel } from '@fbrx/core';
import { PRODUCT_NAME, WEB_BROWSER_PARTITION, WEB_BROWSER_PRIVATE_PARTITION } from '@fbrx/shared';
import { openExternalSafe } from './platform';

/**
 * FBRX Browser: a real web browser inside FBRX OS, in its own window. Pages load in locked-down <webview>s with their
 * own storage (WEB_BROWSER_PARTITION), apart from FBRX's own pages. The main process hardens that session — it checks
 * every download with FBRX Shield, keeps web permissions off by default, and sends pages that try to open a new window
 * back to the browser as a new tab — while the tabs, the address bar and Fabrix live in the renderer (pages/browser).
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
  /** A finished download and what FBRX Shield made of it, for a toast/alert. */
  onDownload: (d: { name: string; path: string; verdict: 'clean' | 'threat' | 'unchecked' }) => void;
}

/** Hardens the web sessions once, at start. Call before any browser window opens. */
export function setupWebSessions(deps: BrowserDeps): void {
  for (const partition of [WEB_BROWSER_PARTITION, WEB_BROWSER_PRIVATE_PARTITION]) {
    const ses = session.fromPartition(partition);
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(WEB_PERMISSIONS.has(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => WEB_PERMISSIONS.has(permission));
    // Ask sites not to track, when the person chose that.
    ses.webRequest.onBeforeSendHeaders((details, cb) => {
      const headers = details.requestHeaders;
      if (deps.kernel()?.settings.get().browser.doNotTrack) {
        headers['DNT'] = '1';
        headers['Sec-GPC'] = '1';
      }
      cb({ requestHeaders: headers });
    });
    ses.on('will-download', (_e, item) => {
      item.once('done', (_ev, state) => {
        const path = item.getSavePath();
        const name = basename(path || item.getFilename());
        if (state !== 'completed' || !path) return;
        const k = deps.kernel();
        if (!k) return void deps.onDownload({ name, path, verdict: 'unchecked' });
        // FBRX Shield checks the finished file; a threat is quarantined by the check itself.
        void k
          .call('shield.check', { path }, { origin: 'user', actor: deps.actor })
          .then((r) => {
            const verdict = (r as { verdict: { malicious?: boolean } | null }).verdict;
            deps.onDownload({ name, path, verdict: verdict?.malicious ? 'threat' : 'clean' });
          })
          .catch(() => deps.onDownload({ name, path, verdict: 'unchecked' }));
      });
    });
  }
  // A page that opens a new window becomes a new tab; everything else that is not web goes to the system browser.
  app.on('web-contents-created', (_e, wc) => {
    if (wc.getType() !== 'webview') return;
    const web = (url: string) => /^https?:\/\//i.test(url);
    if (!web(wc.getURL()) && wc.getURL() !== 'about:blank' && wc.getURL() !== '') return; // only our web webviews
    wc.setWindowOpenHandler(({ url }) => {
      if (web(url)) deps.onPopup(url);
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
  guardWebBrowser(w);
  w.once('ready-to-show', () => {
    w.show();
    if (url) w.webContents.send('fbrx:browser-open', url);
  });
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
  if (deps.rendererUrl) void w.loadURL(`${deps.rendererUrl}?browser=1#/browser`);
  else void w.loadFile(join(deps.appPath, 'dist', 'renderer', 'index.html'), { hash: '/browser', query: { browser: '1' } });
}

export function browserWindowOpen(): boolean {
  return !!browserWin && !browserWin.isDestroyed();
}

/** The browser window's web contents, so core events (browser/account/license changed) reach it too. */
export function browserWebContents(): Electron.WebContents | null {
  return browserWin && !browserWin.isDestroyed() ? browserWin.webContents : null;
}

/** Only the browser window's own web webviews are allowed; locked down whatever the page asked for. */
export function guardWebBrowser(win: BrowserWindow): void {
  win.webContents.on('will-attach-webview', (_e, prefs) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
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
