import { BrowserWindow, desktopCapturer, dialog, screen, systemPreferences, type Display } from 'electron';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import type { ScreenShare } from '@fbrx/core';
import { macLines, windowsLines, xdotoolRuns } from './remote-input';

/**
 * This computer's screen, mouse and keyboard for remote view and control. Pictures come from Electron's screen
 * capture; the mouse and keyboard go through what each system has without installing anything: Windows' SendInput
 * (a PowerShell helper that stays open while a session lasts), macOS's Quartz events (JavaScript for Automation, once
 * FBRX is allowed under Accessibility), and xdotool on Linux with X11. Wayland lets no app do either without asking
 * each time, so there it is not offered.
 */

const IS_WAYLAND = process.platform === 'linux' && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY);

const displays = (): Display[] => screen.getAllDisplays();

async function capture(o: { display: number; maxWidth: number; quality: number }) {
  if (IS_WAYLAND) return null;
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') === 'denied') return null;
  const all = displays();
  const d = all[o.display] ?? all[0];
  if (!d) return null;
  const pixels = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
  const scale = Math.min(1, o.maxWidth / pixels.width);
  const size = { width: Math.max(1, Math.round(pixels.width * scale)), height: Math.max(1, Math.round(pixels.height * scale)) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const unnamed = sources.every((s) => !s.display_id);
  const source = sources.find((s) => s.display_id === String(d.id)) ?? (unnamed ? sources[all.indexOf(d)] : undefined) ?? sources[0];
  if (!source || source.thumbnail.isEmpty()) return null;
  const { width, height } = source.thumbnail.getSize();
  return { jpeg: source.thumbnail.toJPEG(o.quality), width, height, displays: all.length };
}

// ------------------------------------------------------------------------------------------------- the helpers

const WIN_HELPER = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class FbrxInput {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  public static void Mouse(int x, int y, uint flags, int data) { var i = new INPUT(); i.type = 0; i.u.mi.dx = x; i.u.mi.dy = y; i.u.mi.dwFlags = flags; i.u.mi.mouseData = unchecked((uint)data); SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT))); }
  public static void Key(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT))); }
}
"@
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $p = $line.Split(' ')
  if ($p[0] -eq 'm') { [FbrxInput]::Mouse([int]$p[1], [int]$p[2], [uint32]$p[3], [int]$p[4]) }
  elseif ($p[0] -eq 'k') { [FbrxInput]::Key([uint16]$p[1], [uint16]$p[2], [uint32]$p[3]) }
}`;

const MAC_HELPER = `
ObjC.import('Cocoa'); ObjC.import('CoreGraphics');
var se = Application('System Events');
function post(e) { $.CGEventPost($.kCGHIDEventTap, e); }
function one(c) {
  if (c.t === 'mouse') post($.CGEventCreateMouseEvent(null, c.type, { x: c.x, y: c.y }, c.button));
  else if (c.t === 'scroll') { if ($.CGEventCreateScrollWheelEvent2) post($.CGEventCreateScrollWheelEvent2(null, 1, 1, c.dy, 0, 0)); }
  else if (c.t === 'key') { var d = $.CGEventCreateKeyboardEvent(null, c.code, true); $.CGEventSetFlags(d, c.flags); post(d); var u = $.CGEventCreateKeyboardEvent(null, c.code, false); $.CGEventSetFlags(u, c.flags); post(u); }
  else if (c.t === 'text') se.keystroke(c.text);
}
var input = $.NSFileHandle.fileHandleWithStandardInput, buf = '';
while (true) {
  var data = input.availableData;
  if (data.length == 0) break;
  buf += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
  var i;
  while ((i = buf.indexOf('\\n')) >= 0) { var line = buf.slice(0, i); buf = buf.slice(i + 1); try { one(JSON.parse(line)); } catch (e) {} }
}`;

// ------------------------------------------------------------------------------------------------- the share

const run = (cmd: string, args: string[]) => new Promise<{ code: number; err: string }>((ok) => execFile(cmd, args, { timeout: 10_000 }, (e, _o, err) => ok({ code: e ? 1 : 0, err: String(err || e?.message || '') })));

let helper: ChildProcess | null = null;
const held = new Set<string>();
let banner: BrowserWindow | null = null;

function helperProcess(): ChildProcess {
  if (helper && helper.exitCode === null && !helper.killed) return helper;
  helper =
    process.platform === 'win32'
      ? // The helper travels as -EncodedCommand, so standard input carries only the events it reads line by line.
        spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WIN_HELPER, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] })
      : spawn('osascript', ['-l', 'JavaScript', '-e', MAC_HELPER], { stdio: ['pipe', 'ignore', 'ignore'] });
  helper.stdin?.on('error', () => undefined);
  return helper;
}

function stopHelper() {
  held.clear();
  if (helper && helper.exitCode === null) {
    helper.stdin?.end();
    helper.kill();
  }
  helper = null;
}

function bannerHtml(who: string, mode: 'view' | 'control', recorded: boolean) {
  const text = `${mode === 'control' ? 'Your screen, mouse and keyboard are being used by' : 'Your screen is being seen by'} ${who.replace(/[<>&"]/g, '')}${recorded ? ' (recorded)' : ''}`;
  return `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;font:13px system-ui,sans-serif;background:#b3261e;color:#fff;display:flex;align-items:center;gap:12px;height:100vh;padding:0 12px;box-sizing:border-box;-webkit-app-region:drag;user-select:none}
    span{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    a{-webkit-app-region:no-drag;color:#b3261e;background:#fff;border-radius:6px;padding:4px 12px;font-weight:600;text-decoration:none}
  </style><span>● ${text}</span><a href="https://stop.fbrx.invalid/">Stop</a>`;
}

export function createScreenShare(): ScreenShare {
  return {
    capture,
    async canControl() {
      if (IS_WAYLAND) return { ok: false, why: 'This Linux desktop (Wayland) does not let apps use the mouse and keyboard: sign in to an Xorg session for control' };
      if (process.platform === 'darwin') {
        return systemPreferences.isTrustedAccessibilityClient(false) ? { ok: true, why: null } : { ok: false, why: 'Allow FBRX under System Settings → Privacy & Security → Accessibility for control' };
      }
      if (process.platform === 'linux') {
        const r = await run('xdotool', ['version']);
        return r.code === 0 ? { ok: true, why: null } : { ok: false, why: 'Install xdotool on this computer for control (sudo apt install xdotool)' };
      }
      return process.platform === 'win32' ? { ok: true, why: null } : { ok: false, why: 'Not on this system' };
    },
    async input(events, display) {
      const all = displays();
      const d = (all[display] ?? all[0]).bounds;
      if (process.platform === 'win32') {
        const desk = all.map((x) => x.bounds).reduce((a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x), height: Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y) }));
        helperProcess().stdin?.write(windowsLines(events, d, desk).map((l) => `${l}\n`).join(''));
      } else if (process.platform === 'darwin') {
        if (!systemPreferences.isTrustedAccessibilityClient(true)) throw new Error('Allow FBRX under System Settings → Privacy & Security → Accessibility for control');
        helperProcess().stdin?.write(macLines(events, d, held).map((l) => `${l}\n`).join(''));
      } else {
        const scale = (all[display] ?? all[0]).scaleFactor;
        for (const args of xdotoolRuns(events, { ...d, scale })) {
          const r = await run('xdotool', args);
          if (r.code !== 0) throw new Error(`xdotool: ${r.err.trim().slice(0, 200) || 'failed'}`);
        }
      }
    },
    async ask(q) {
      const lines = [
        q.asked === 'control' ? `${q.who} wants to see your screen and use your mouse and keyboard.` : `${q.who} wants to see your screen.`,
        ...(q.ticket ? [`Ticket: ${q.ticket}`] : []),
        ...(q.reason ? [`Why: ${q.reason}`] : []),
        ...(q.recorded ? ['', 'Your organization keeps a recording of what is seen on your screen during this session.'] : []),
        '',
        'A red bar stays at the top of your screen while it lasts, with Stop.',
      ];
      const buttons = q.asked === 'control' ? ['Allow control', 'View only', 'No'] : ['Allow', 'No'];
      try {
        const r = await dialog.showMessageBox({ type: 'question', title: 'Screen sharing', message: 'Share your screen?', detail: lines.join('\n'), buttons, defaultId: buttons.length - 1, cancelId: buttons.length - 1, noLink: true, signal: AbortSignal.timeout(q.timeoutMs) });
        if (r.response === buttons.length - 1) return 'deny';
        return q.asked === 'control' && r.response === 0 ? 'control' : 'view';
      } catch {
        return 'deny';
      }
    },
    banner(on, stop) {
      // The bar is let go of before it closes, so closing it here is not taken for the person's Stop.
      const old = banner;
      banner = null;
      old?.destroy();
      if (!on) {
        stopHelper();
        return;
      }
      const d = screen.getPrimaryDisplay().workArea;
      const width = Math.min(560, d.width - 40);
      banner = new BrowserWindow({ x: d.x + Math.round((d.width - width) / 2), y: d.y + 8, width, height: 40, frame: false, resizable: false, movable: true, minimizable: false, maximizable: false, alwaysOnTop: true, skipTaskbar: true, focusable: true, show: false, webPreferences: { sandbox: true, javascript: false } });
      banner.setAlwaysOnTop(true, 'screen-saver');
      banner.setVisibleOnAllWorkspaces(true);
      banner.webContents.on('will-navigate', (e, url) => {
        e.preventDefault();
        if (url.startsWith('https://stop.fbrx.invalid')) stop();
      });
      banner.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      void banner.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(bannerHtml(on.who, on.mode, on.recorded))}`);
      banner.once('ready-to-show', () => banner?.showInactive());
      // Closing the bar any way stops the session.
      const mine = banner;
      banner.on('closed', () => {
        if (banner === mine) {
          banner = null;
          stop();
        }
      });
    },
  };
}
