import { app, session, type BrowserWindow } from 'electron';
import type { Kernel } from '@fbrx/core';
import { SERVER_BROWSER_PARTITION } from '@fbrx/shared';
import { openExternalSafe } from './platform';

/**
 * The built-in browser for server consoles (Lab → FBRX Server → Your servers): a <webview> in the main window with its
 * own cookies and storage, no access to FBRX, and a certificate check of its own. A certificate no authority vouches
 * for (FBRX Server makes its own) is accepted only when it is the one the person trusted for that exact address.
 */
const SERVER_PARTITION = SERVER_BROWSER_PARTITION;

/** Server consoles may copy to the clipboard and show a virtual machine's screen full screen; nothing else. */
const SERVER_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);

export function setupServerBrowser(kernel: () => Kernel | null): void {
  const ses = session.fromPartition(SERVER_PARTITION);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(SERVER_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => SERVER_PERMISSIONS.has(permission));
  app.on('certificate-error', (event, wc, url, _error, certificate, callback) => {
    // Anything else keeps Chromium's answer: refused.
    if (wc.session !== ses) return;
    if (kernel()?.servers.trustsCertificate(url, certificate.fingerprint)) {
      event.preventDefault();
      callback(true);
    } else callback(false);
  });
  app.on('web-contents-created', (_e, wc) => {
    if (wc.getType() !== 'webview') return;
    const web = (url: string) => /^https?:\/\//i.test(url);
    const origin = (url: string) => {
      try {
        return new URL(url).origin;
      } catch {
        return null;
      }
    };
    // A console that opens a window on its own server opens it right here; anything else goes to the system browser.
    wc.setWindowOpenHandler(({ url }) => {
      if (web(url) && origin(url) === origin(wc.getURL())) void wc.loadURL(url);
      else openExternalSafe(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e, url) => {
      if (!web(url)) e.preventDefault();
    });
  });
}

/** Only server-console webviews, locked down whatever the page asked for. */
export function guardWebviews(win: BrowserWindow): void {
  win.webContents.on('will-attach-webview', (e, prefs, params) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.nodeIntegrationInSubFrames = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.webSecurity = true;
    prefs.allowRunningInsecureContent = false;
    if (params.partition !== SERVER_PARTITION || !/^https?:\/\//i.test(params.src ?? '')) e.preventDefault();
  });
}
