import { BrowserWindow, clipboard, ClipboardItem, desktopCapturer, ipcMain, nativeImage, screen, shell, systemPreferences, type DesktopCapturerSource, type Display, type IpcMainInvokeEvent, type NativeImage, type WebContents } from 'electron';
import type { Kernel } from '@fbrx/core';
import { SNAPSHOT_MAX_BYTES, SNAPSHOT_MODES, type NotificationEvent, type SnapshotMode } from '@fbrx/shared';

/**
 * FBRX Snapshot, the taking part. Every screen is captured at once, so menus and tooltips stay as they were; then a
 * window over each screen shows that still picture, to drag out an area, pick a window or click a whole screen. The
 * picture is cut from the capture at full resolution, saved in the snapshot folder, copied, and opened to mark up.
 */

export interface SnapshotDeps {
  kernel: () => Kernel | null;
  /** Loads FBRX's renderer in a window, at a route. */
  load: (w: BrowserWindow, hash: string) => void;
  preload: string;
  /** FBRX's own windows: those showing are hidden while a snapshot is taken from inside FBRX, and shown again after. */
  ownWindows: () => BrowserWindow[];
  /** Opens a snapshot to mark up. */
  open: (id: string) => void;
  notify: (n: NotificationEvent) => void;
  /** Whether the IPC call comes from FBRX's own pages. */
  trusted: (e: IpcMainInvokeEvent) => boolean;
}

/** One screen as it was when the snapshot started. */
interface Capture {
  display: Display;
  image: NativeImage;
}

/** What the person picked on a screen: an area of it (in its own coordinates), all of it, or a window. */
type Pick = { kind: 'region'; x: number; y: number; width: number; height: number } | { kind: 'screen' } | { kind: 'window'; id: string; png?: Uint8Array };

interface Taking {
  mode: SnapshotMode;
  /** The screen the pointer was on: it shows the window list. */
  home: number;
  overlays: Map<number, { win: BrowserWindow; capture: Capture }>;
  windows: DesktopCapturerSource[] | null;
  finish: (r: { capture: Capture; pick: Pick } | null) => void;
}

let taking: Taking | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A snapshot nobody finishes is put away (the overlays cover every screen). */
const PICK_TIMEOUT_MS = 5 * 60_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A snapshot overlay's page (it may capture a window it was asked to). */
export function isSnapshotOverlay(wc: WebContents): boolean {
  return !!taking?.overlays.has(wc.id);
}

/** Every screen at full resolution (one capture per screen size: a capture is scaled to the size asked for). */
async function captureScreens(): Promise<Capture[]> {
  const displays = screen.getAllDisplays();
  const pixels = (d: Display) => ({ width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) });
  const bySize = new Map<string, Display[]>();
  for (const d of displays) {
    const p = pixels(d);
    bySize.set(`${p.width}x${p.height}`, [...(bySize.get(`${p.width}x${p.height}`) ?? []), d]);
  }
  const captures: Capture[] = [];
  for (const group of bySize.values()) {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: pixels(group[0]) });
    // Some Linux desktops do not say which screen a source is; then they come in the order of the screens.
    const unnamed = sources.every((s) => !s.display_id);
    for (const d of group) {
      const source = sources.find((s) => s.display_id === String(d.id)) ?? (unnamed ? sources[displays.indexOf(d)] : undefined);
      if (source && !source.thumbnail.isEmpty()) captures.push({ display: d, image: source.thumbnail });
    }
  }
  return captures;
}

/** The windows to pick from (not FBRX Snapshot's own), with small pictures of them. */
async function windowList(t: Taking): Promise<DesktopCapturerSource[]> {
  if (t.windows) return t.windows;
  const own = new Set([...t.overlays.values()].map((o) => o.win.getMediaSourceId()));
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 480, height: 300 }, fetchWindowIcons: true });
  t.windows = sources.filter((s) => !own.has(s.id) && s.name.trim() && !s.thumbnail.isEmpty());
  return t.windows;
}

/** A window as a picture: what the overlay captured at its real size, or else a large picture of it. */
async function windowPicture(id: string, png: Uint8Array | undefined, capture: Capture): Promise<NativeImage | null> {
  if (png && png.length <= SNAPSHOT_MAX_BYTES && Buffer.from(png.subarray(0, 8)).equals(PNG_SIGNATURE)) {
    const image = nativeImage.createFromBuffer(Buffer.from(png));
    if (!image.isEmpty()) return image;
  }
  const size = capture.image.getSize();
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: size });
  const source = sources.find((s) => s.id === id);
  return source && !source.thumbnail.isEmpty() ? source.thumbnail : null;
}

/** The picture the person picked, cut from its screen at full resolution. */
async function picture(capture: Capture, pick: Pick): Promise<NativeImage | null> {
  if (pick.kind === 'screen') return capture.image;
  if (pick.kind === 'window') return windowPicture(pick.id, pick.png, capture);
  const { width, height } = capture.image.getSize();
  const scale = width / capture.display.bounds.width;
  const x = Math.max(0, Math.round(pick.x * scale));
  const y = Math.max(0, Math.round(pick.y * scale));
  const rect = { x, y, width: Math.min(width - x, Math.round(pick.width * scale)), height: Math.min(height - y, Math.round(pick.height * scale)) };
  return rect.width > 0 && rect.height > 0 ? capture.image.crop(rect) : null;
}

/** A window over one screen showing its still picture (the renderer's snapshot overlay). */
function overlay(deps: SnapshotDeps, t: Taking, capture: Capture): BrowserWindow {
  const { bounds } = capture.display;
  const w = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    backgroundColor: '#000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    enableLargerThanScreen: true,
    title: 'FBRX Snapshot',
    webPreferences: { preload: deps.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
  });
  w.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  w.setBounds(bounds);
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.once('ready-to-show', () => {
    w.show();
    if (capture.display.id === t.home) w.focus();
  });
  // Closed some other way (Alt+F4), or its page could not show: no snapshot, and never a screen left covered.
  const leave = () => taking === t && t.finish(null);
  w.on('closed', leave);
  w.webContents.on('did-fail-load', leave);
  w.webContents.on('render-process-gone', leave);
  deps.load(w, '/snap-overlay');
  return w;
}

/** Whether FBRX may see the screen (macOS asks the person once); says how to allow it when not. */
function screenAccess(deps: SnapshotDeps): boolean {
  if (process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('screen') !== 'denied') return true;
  deps.notify({ title: 'FBRX Snapshot', body: 'Allow FBRX to record the screen: System Settings → Privacy & Security → Screen Recording, then open FBRX again.', level: 'warning', source: 'snapshot' });
  void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  return false;
}

/**
 * Takes a snapshot: waits `delay` seconds, captures the screens, lets the person pick (a whole screen is taken at once
 * when there is only one), then saves it, copies it and opens it (Settings decide the last two).
 */
export async function takeSnapshot(deps: SnapshotDeps, o: { mode: SnapshotMode; delay: number; fromApp: boolean }): Promise<void> {
  const kernel = deps.kernel();
  if (!kernel) return;
  if (taking) {
    taking.overlays.forEach(({ win }) => win.focus());
    return;
  }
  if (!screenAccess(deps)) return;
  // Taken from inside FBRX: its windows step aside first.
  const hidden = o.fromApp ? deps.ownWindows().filter((w) => w.isVisible() && !w.isMinimized()) : [];
  hidden.forEach((w) => w.hide());
  const restore = () => hidden.forEach((w) => !w.isDestroyed() && w.showInactive());
  try {
    if (hidden.length || o.delay) await sleep(Math.max(250, o.delay * 1000));
    const captures = await captureScreens();
    if (!captures.length) throw new Error('The screen could not be captured');
    const cursor = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const picked =
      o.mode === 'screen' && captures.length === 1
        ? { capture: captures[0], pick: { kind: 'screen' } as Pick }
        : await new Promise<{ capture: Capture; pick: Pick } | null>((finish) => {
            const t: Taking = { mode: o.mode, home: cursor.id, overlays: new Map(), windows: null, finish: () => undefined };
            t.finish = (r) => {
              if (taking !== t) return;
              taking = null;
              t.overlays.forEach(({ win }) => !win.isDestroyed() && win.destroy());
              finish(r);
            };
            taking = t;
            setTimeout(() => t.finish(null), PICK_TIMEOUT_MS).unref();
            for (const capture of captures) {
              const win = overlay(deps, t, capture);
              t.overlays.set(win.webContents.id, { win, capture });
            }
          });
    restore();
    if (!picked) return;
    const image = await picture(picked.capture, picked.pick);
    if (!image || image.isEmpty()) throw new Error('That window could not be captured');
    const settings = kernel.settings.get().snapshot;
    const png = image.toPNG();
    const shot = await kernel.snapshots.save(png);
    if (settings.copy) await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]);
    if (settings.after === 'editor') deps.open(shot.id);
    else deps.notify({ title: 'Snapshot taken', body: settings.copy ? 'It is on the clipboard, ready to paste. Open it to mark it up.' : 'Open it to mark it up.', level: 'success', source: 'snapshot', open: `snapshots/${encodeURIComponent(shot.id)}` });
  } catch (err) {
    restore();
    kernel.log.warn('Snapshot failed', { error: (err as Error).message });
    deps.notify({ title: 'FBRX Snapshot', body: (err as Error).message, level: 'warning', source: 'snapshot' });
  }
}

/** The overlay's side of a snapshot: its still picture, the mode, the window list, and what was picked. */
export function registerSnapshotIpc(deps: SnapshotDeps): void {
  const mine = (e: IpcMainInvokeEvent) => (deps.trusted(e) && taking?.overlays.get(e.sender.id)) || null;
  ipcMain.handle('fbrx:snap', async (e, action: unknown, arg?: unknown) => {
    if (action === 'start') {
      const p = (arg ?? {}) as { mode?: unknown; delay?: unknown };
      if (!deps.trusted(e)) return false;
      const mode = SNAPSHOT_MODES.includes(p.mode as SnapshotMode) ? (p.mode as SnapshotMode) : 'region';
      void takeSnapshot(deps, { mode, delay: Math.min(10, Math.max(0, Number(p.delay) || 0)), fromApp: true });
      return true;
    }
    const t = taking;
    const own = mine(e);
    if (!t || !own) return null;
    switch (action) {
      case 'frame':
        return {
          image: `data:image/jpeg;base64,${own.capture.image.toJPEG(92).toString('base64')}`,
          mode: t.mode,
          home: own.capture.display.id === t.home,
          screens: t.overlays.size,
        };
      case 'mode':
        if (!SNAPSHOT_MODES.includes(arg as SnapshotMode)) return null;
        t.mode = arg as SnapshotMode;
        t.overlays.forEach(({ win }) => win.webContents.send('fbrx:snap-mode', t.mode));
        return t.mode;
      case 'windows':
        return (await windowList(t)).map((s) => ({ id: s.id, name: s.name, picture: s.thumbnail.toDataURL(), icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null }));
      case 'pick': {
        const pick = arg as Pick;
        if (pick?.kind === 'window' && !(await windowList(t)).some((s) => s.id === pick.id)) return null;
        if (pick?.kind === 'region' && ![pick.x, pick.y, pick.width, pick.height].every(Number.isFinite)) return null;
        if (pick?.kind !== 'region' && pick?.kind !== 'screen' && pick?.kind !== 'window') return null;
        t.finish({ capture: own.capture, pick });
        return true;
      }
      case 'cancel':
        t.finish(null);
        return true;
    }
    return null;
  });
}
