import { BrowserWindow, session, type WebContents } from 'electron';
import type { DocumentRenderer } from '@fbrx/core';

/** The session the hidden pages use: in memory only, and nothing but the page itself loads (no web requests). */
function offlineSession() {
  const ses = session.fromPartition('fbrx-documents');
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith('data:') }));
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  return ses;
}

let ses: Electron.Session | null = null;

/** Loads a page in a hidden window with no scripts and no network, and does something with it before closing it. */
async function withPage<T>(html: string, size: { width: number; height: number } | null, use: (wc: WebContents) => Promise<T>): Promise<T> {
  ses ??= offlineSession();
  const win = new BrowserWindow({
    show: false,
    width: size?.width ?? 816,
    height: size?.height ?? 1056,
    useContentSize: true,
    transparent: !!size,
    backgroundColor: size ? '#00000000' : '#ffffff',
    webPreferences: { session: ses, javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: !!size, spellcheck: false },
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html).toString('base64')}`);
    return await use(win.webContents);
  } finally {
    win.destroy();
  }
}

/**
 * What the agent makes, finished with the app's own browser engine: documents printed to PDF (every script and emoji,
 * page numbers at the foot), and SVG drawings as PNG pictures.
 */
export const documentRenderer: DocumentRenderer = {
  printPdf: (html) =>
    withPage(html, null, (wc) =>
      wc.printToPDF({
        pageSize: 'Letter',
        printBackground: true,
        preferCSSPageSize: true,
        generateDocumentOutline: true,
        displayHeaderFooter: true,
        headerTemplate: '<span></span>',
        footerTemplate: '<div style="width:100%;text-align:center;font:8px system-ui,sans-serif;color:#8a7f70"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      }),
    ),
  rasterizeSvg: (svg, width, height) =>
    withPage(
      `<!doctype html><html><body style="margin:0;background:transparent"><img width="${width}" height="${height}" style="display:block" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`,
      { width, height },
      async (wc) => (await wc.capturePage({ x: 0, y: 0, width, height })).toPNG(),
    ),
};
