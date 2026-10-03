import { ChildProcess, spawnSync } from 'node:child_process';
import * as siUtil from 'systeminformation/lib/util.js';

/**
 * Keeps console windows from flashing up on Windows.
 *
 * Node starts a child that has `windowsHide` and no inherited stdio without any console (CREATE_NO_WINDOW). That is
 * fine for the child itself, but when the child is a shell (cmd.exe, PowerShell) that starts another console program
 * (netstat, ipconfig, reg, findstr, git, ...), Windows gives that grandchild a brand-new console window, which flashes
 * up and disappears. Agent tools do this all the time, and so does the system-information library.
 *
 * Inheriting one stdio slot makes Node skip CREATE_NO_WINDOW: the child then gets a console of its own, created hidden
 * (SW_HIDE), and everything it starts shares that hidden console. The extra slot is fd 2 handed to the child as its
 * fd 3, which shells never look at; when the desktop app has no stderr, Node leaves the slot empty.
 */

type Stdio = unknown;

/** The stdio to use instead for a hidden child, or null to leave it as it is. */
export function hiddenConsoleStdio(stdio: Stdio): Stdio[] | null {
  if (stdio === 'inherit') return null;
  const list: Stdio[] = Array.isArray(stdio) ? [...stdio] : [stdio ?? 'pipe', stdio ?? 'pipe', stdio ?? 'pipe'];
  // Something is inherited already (so there is a console to share), or this is a Node child with an IPC channel.
  if (list.some((s) => s === 'inherit' || s === 'ipc' || typeof s === 'number' || (typeof s === 'object' && s !== null))) return null;
  while (list.length < 3) list.push(undefined);
  return [...list, 2];
}

let installed = false;

/** Installs the guard (Windows only; once). Returns whether it is active. */
export function installConsoleGuard(): boolean {
  if (process.platform !== 'win32') return false;
  if (installed) return true;
  // Make sure this Node/libuv accepts the extra slot before relying on it.
  const probe = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'exit 0'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 2], timeout: 10_000 });
  if (probe.error || probe.status !== 0) return false;
  installed = true;

  const proto = ChildProcess.prototype as unknown as { spawn: (options: Record<string, unknown>) => unknown };
  const original = proto.spawn;
  proto.spawn = function spawn(this: unknown, options: Record<string, unknown>) {
    const stdio = options?.windowsHide ? hiddenConsoleStdio(options.stdio) : null;
    return original.call(this, stdio ? { ...options, stdio } : options);
  };

  // execSync and spawnSync don't go through ChildProcess. The system-information library runs all of its synchronous
  // Windows commands with one shared options object, so it gets the same slot.
  if (siUtil.execOptsWin) siUtil.execOptsWin.stdio = ['pipe', 'pipe', 'pipe', 2];
  return true;
}
