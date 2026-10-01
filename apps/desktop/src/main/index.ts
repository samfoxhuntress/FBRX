import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { userInfo } from 'node:os';
import { Kernel, toCoreError } from '@fbrx/core';
import { PRODUCT_NAME } from '@fbrx/shared';
import { createElectronPlatform, openExternalSafe } from './platform';
import { ElectronUpdateController } from './updater';

const dataDir = process.env.FBRX_HOME ?? app.getPath('userData');
const rendererUrl = process.env.FBRX_RENDERER_URL ?? null;
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60_000;
const actor = `user:${(() => {
  try {
    return userInfo().username;
  } catch {
    return 'desktop';
  }
})()}`;

let kernel: Kernel | null = null;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}
app.setAppUserModelId('com.fbrx.os');

function asset(name: string) {
  const candidates = [join(app.getAppPath(), 'dist', 'assets', name), join(process.resourcesPath ?? '', name)];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

/** Locations an IT department can drop fbrx-provision.json for zero-touch enrollment. */
function provisioningLocations(): string[] {
  const out = [join(dirname(process.execPath), 'fbrx-provision.json'), join(process.resourcesPath ?? '', 'provisioning', 'fbrx-provision.json')];
  if (process.platform === 'darwin') out.push('/Library/Application Support/FBRX OS/fbrx-provision.json');
  if (process.platform === 'win32' && process.env.ProgramData) out.push(join(process.env.ProgramData, 'FBRX OS', 'fbrx-provision.json'));
  const arg = process.argv.find((a) => a.startsWith('--provision='));
  if (arg) out.unshift(arg.slice('--provision='.length));
  return out;
}

function showWindow(route?: string) {
  if (!win) createWindow();
  if (win!.isMinimized()) win!.restore();
  win!.show();
  win!.focus();
  if (route) win!.webContents.send('fbrx:navigate', route);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 620,
    title: PRODUCT_NAME,
    show: false,
    backgroundColor: '#0d0d0d',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    icon: asset('icon.png'),
    webPreferences: {
      preload: join(app.getAppPath(), 'dist', 'preload', 'index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
    },
  });
  // Launched at sign-in with --hidden: start in the tray.
  win.once('ready-to-show', () => !process.argv.includes('--hidden') && win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (rendererUrl ? !url.startsWith(rendererUrl) : !url.startsWith('file://')) {
      e.preventDefault();
      openExternalSafe(url);
    }
  });
  win.on('close', (e) => {
    if (!quitting && kernel?.settings.get().general.minimizeToTray && tray) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on('closed', () => (win = null));
  if (rendererUrl) void win.loadURL(rendererUrl);
  else void win.loadFile(join(app.getAppPath(), 'dist', 'renderer', 'index.html'));
}

function trayMenu() {
  if (!tray || !kernel) return;
  const pending = kernel.approvals.size;
  const fleet = kernel.fleet.status();
  const vault = kernel.vault.status();
  const template: MenuItemConstructorOptions[] = [
    { label: `${PRODUCT_NAME} ${app.getVersion()}`, enabled: false },
    { label: `Vault: ${vault.state}`, enabled: false },
    { label: `Fleet: ${fleet.state}${fleet.tenantName ? ` · ${fleet.tenantName}` : ''}`, enabled: false },
    { type: 'separator' },
    { label: 'Open FBRX OS', click: () => showWindow() },
    { label: 'New agent chat', click: () => showWindow('agent') },
    { label: pending ? `Review ${pending} pending approval${pending > 1 ? 's' : ''}` : 'No pending approvals', enabled: pending > 0, click: () => showWindow('approvals') },
    { type: 'separator' },
    { label: 'Quit', click: () => ((quitting = true), app.quit()) },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(pending ? `${PRODUCT_NAME} — ${pending} approval(s) waiting` : PRODUCT_NAME);
}

function createTray() {
  const img = nativeImage.createFromPath(asset(process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
  if (img.isEmpty()) return;
  if (process.platform === 'darwin') img.setTemplateImage(true);
  tray = new Tray(img);
  tray.on('click', () => showWindow());
  trayMenu();
}

function appMenu() {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Open data folder', click: () => void shell.openPath(dataDir) }, { label: 'Open logs', click: () => void shell.openPath(join(dataDir, 'logs')) }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function trusted(e: IpcMainInvokeEvent) {
  const url = e.senderFrame?.url ?? '';
  return rendererUrl ? url.startsWith(rendererUrl) : url.startsWith('file://');
}

function registerIpc() {
  ipcMain.handle('fbrx:call', async (e, method: string, params: unknown) => {
    if (!trusted(e)) return { ok: false, error: { code: 'FORBIDDEN', message: 'Untrusted sender' } };
    if (!kernel) return { ok: false, error: { code: 'UNAVAILABLE', message: 'Starting…' } };
    try {
      return { ok: true, result: await kernel.call(String(method), params, { origin: 'user', actor }) };
    } catch (err) {
      const ce = toCoreError(err);
      return { ok: false, error: { code: ce.code, message: ce.message } };
    }
  });
  ipcMain.handle('fbrx:dialog', async (e, opts: { kind: 'file' | 'folder' | 'save'; title?: string; filters?: Array<{ name: string; extensions: string[] }>; defaultPath?: string }) => {
    if (!trusted(e) || !win) return null;
    if (opts.kind === 'save') {
      const r = await dialog.showSaveDialog(win, { title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters });
      return r.canceled ? null : r.filePath ?? null;
    }
    const r = await dialog.showOpenDialog(win, { title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters, properties: [opts.kind === 'folder' ? 'openDirectory' : 'openFile'] });
    return r.canceled ? null : r.filePaths[0] ?? null;
  });
  ipcMain.handle('fbrx:reveal', (e, p: string) => trusted(e) && typeof p === 'string' && shell.showItemInFolder(p));
  ipcMain.handle('fbrx:openExternal', (e, url: string) => trusted(e) && openExternalSafe(String(url)));
  ipcMain.handle('fbrx:app', (e) => (trusted(e) ? { version: app.getVersion(), platform: process.platform, arch: process.arch, dataDir, packaged: app.isPackaged } : null));
}

async function boot() {
  const updates = new ElectronUpdateController(() => {
    const u = kernel?.settings.get().updates;
    return { autoDownload: u?.autoDownload ?? true, autoInstall: u?.autoInstall ?? false, channel: u?.channel ?? 'stable' };
  });
  const platform = createElectronPlatform({
    dataDir,
    updates,
    onNotify: () => undefined,
    requestRestart: (reason) => {
      quitting = true;
      void kernel?.stop().finally(() => {
        app.relaunch({ args: process.argv.slice(1).concat([`--restarted=${reason}`]) });
        app.exit(0);
      });
    },
  });
  kernel = await Kernel.create({ dataDir, platform, provisioningFiles: provisioningLocations() });
  kernel.events.onAny((name, payload) => {
    win?.webContents.send('fbrx:event', name, payload);
    if (name === 'approval.requested' || name === 'approval.resolved' || name === 'fleet.changed' || name === 'vault.changed') trayMenu();
  });
  kernel.events.on('approval.requested', (r) => {
    if (!win?.isFocused()) {
      platform.notify({ title: 'Approval needed', body: `${r.toolTitle}: ${r.reason}`.slice(0, 200), level: 'warning', source: 'governance' });
    }
  });
  await kernel.start();
  const general = kernel.settings.get().general;
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: general.launchAtLogin, args: ['--hidden'] });
  kernel.settings.onChange((s) => app.isPackaged && app.setLoginItemSettings({ openAtLogin: s.settings.general.launchAtLogin, args: ['--hidden'] }));
  // Check shortly after launch and then every few hours, so machines that live in the tray still pick up releases.
  const checkUpdates = () => {
    if (kernel?.fleet.enrolled) void updates.check();
  };
  setTimeout(checkUpdates, 15_000);
  setInterval(checkUpdates, UPDATE_CHECK_INTERVAL_MS).unref();
}

app.whenReady().then(async () => {
  registerIpc();
  appMenu();
  try {
    await boot();
  } catch (err) {
    dialog.showErrorBox(`${PRODUCT_NAME} could not start`, `${(err as Error).message}\n\nData folder: ${dataDir}`);
    app.exit(1);
    return;
  }
  createWindow();
  createTray();
  app.on('activate', () => showWindow());
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !tray) app.quit();
});

let stopping = false;
app.on('will-quit', (e) => {
  if (!kernel || stopping) return;
  e.preventDefault();
  stopping = true;
  void kernel.stop().finally(() => app.exit(0));
});
