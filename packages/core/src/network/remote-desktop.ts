import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RemoteProtocol, RemoteViewer } from '@fbrx/shared';
import { CoreError } from '../errors';
import { exec, IS_WIN } from '../windows/ps';

/**
 * Remote desktop (RDP) and screen sharing (VNC) to another computer: FBRX opens the viewer this computer has, with the
 * address (and for RDP the user name) filled in, and the viewer asks for the password itself. FBRX keeps no desktop
 * password and draws no remote screen of its own. SSH and Telnet to devices are the device consoles
 * (device-console.ts).
 */

export const REMOTE_PORTS: Record<RemoteProtocol, number> = { rdp: 3389, vnc: 5900 };
const IS_MAC = process.platform === 'darwin';

const HOST = /^[A-Za-z0-9.:_-]{1,253}$/;
const USER = /^[^\s:@"\\/]{1,64}$/;

/** The first command of these that this computer has, or null. */
async function which(...names: string[]): Promise<string | null> {
  for (const n of names) {
    const r = await exec(IS_WIN ? 'where' : 'which', [n], { timeoutMs: 4000 }).catch(() => null);
    const path = r?.code === 0 ? r.out.split(/\r?\n/)[0]?.trim() : '';
    if (path) return path;
  }
  return null;
}

/** A VNC viewer installed on Windows in its usual place. */
function windowsVncViewer(): string | null {
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean) as string[];
  const tails = ['TigerVNC\\vncviewer.exe', 'RealVNC\\VNC Viewer\\vncviewer.exe', 'TightVNC\\tvnviewer.exe', 'uvnc bvba\\UltraVNC\\vncviewer.exe'];
  for (const p of pf) for (const t of tails) if (existsSync(join(p, t))) return join(p, t);
  return null;
}

/** A macOS app installed by name. */
const macApp = (...names: string[]) => names.map((n) => `/Applications/${n}.app`).find((p) => existsSync(p)) ?? null;

/** How this computer opens each kind of remote connection, or why it cannot. */
export async function remoteViewers(): Promise<RemoteViewer[]> {
  if (IS_WIN) {
    const mstsc = existsSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'mstsc.exe'));
    const vnc = windowsVncViewer() ?? (await which('vncviewer', 'tvnviewer'));
    return [
      { protocol: 'rdp', available: mstsc, viewer: mstsc ? 'Remote Desktop Connection' : null, hint: mstsc ? '' : 'Remote Desktop Connection is missing from this Windows.' },
      { protocol: 'vnc', available: !!vnc, viewer: vnc ? 'the VNC viewer installed' : null, hint: vnc ? '' : 'Install a VNC viewer, then try again.' },
    ];
  }
  if (IS_MAC) {
    const rdp = macApp('Windows App', 'Microsoft Remote Desktop');
    return [
      { protocol: 'rdp', available: !!rdp, viewer: rdp ? 'the remote desktop app installed' : null, hint: rdp ? '' : 'Install a remote desktop (RDP) app from the App Store, then try again.' },
      { protocol: 'vnc', available: true, viewer: 'Screen Sharing', hint: '' },
    ];
  }
  const rdp = await which('xfreerdp3', 'xfreerdp', 'wlfreerdp', 'remmina');
  const vnc = await which('vncviewer', 'xtigervncviewer', 'remmina', 'gvncviewer', 'xdg-open');
  return [
    { protocol: 'rdp', available: !!rdp, viewer: rdp ? rdp.split('/').pop()! : null, hint: rdp ? '' : 'Install FreeRDP or Remmina from your system’s software center, then try again.' },
    { protocol: 'vnc', available: !!vnc, viewer: vnc ? vnc.split('/').pop()! : null, hint: vnc ? '' : 'Install a VNC viewer (or Remmina) from your system’s software center, then try again.' },
  ];
}

/** Starts a viewer on its own, not tied to FBRX. */
function launch(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => undefined);
  child.unref();
}

/** An .rdp file with the address and user name, which the RDP app opens and asks for the password. */
function rdpFile(dir: string, host: string, port: number, username: string | null): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${host.replace(/[^A-Za-z0-9.-]/g, '_')}-${port}.rdp`);
  const lines = [`full address:s:${host}:${port}`, ...(username ? [`username:s:${username}`] : []), 'prompt for credentials:i:1', 'authentication level:i:2', 'screen mode id:i:1'];
  writeFileSync(file, `${lines.join('\r\n')}\r\n`);
  return file;
}

/** Opens a remote desktop or screen sharing session in this computer's viewer. */
export async function openRemote(p: { protocol: RemoteProtocol; host: string; port?: number; username?: string | null }, tmpDir: string): Promise<{ viewer: string }> {
  const host = p.host.trim();
  if (!HOST.test(host)) throw new CoreError('INVALID_ARGUMENT', 'Enter an IP address or host name');
  const port = p.port ?? REMOTE_PORTS[p.protocol];
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CoreError('INVALID_ARGUMENT', 'Port must be 1-65535');
  const username = p.username?.trim() || null;
  if (username && !USER.test(username)) throw new CoreError('INVALID_ARGUMENT', 'Invalid user name');
  const v = (await remoteViewers()).find((x) => x.protocol === p.protocol)!;
  if (!v.available) throw new CoreError('UNAVAILABLE', v.hint);
  const where = host.includes(':') ? `[${host}]` : host;
  if (p.protocol === 'rdp') {
    if (IS_WIN) launch('mstsc.exe', [rdpFile(tmpDir, host, port, username)]);
    else if (IS_MAC) launch('open', [rdpFile(tmpDir, host, port, username)]);
    else {
      const bin = (await which('xfreerdp3', 'xfreerdp', 'wlfreerdp', 'remmina'))!;
      if (bin.endsWith('remmina')) launch(bin, ['-c', `rdp://${username ? `${encodeURIComponent(username)}@` : ''}${where}:${port}`]);
      else launch(bin, [`/v:${where}:${port}`, ...(username ? [`/u:${username}`] : []), '/dynamic-resolution', '/cert:tofu']);
    }
    return { viewer: v.viewer! };
  }
  if (IS_MAC) launch('open', [`vnc://${username ? `${encodeURIComponent(username)}@` : ''}${where}:${port}`]);
  else {
    const bin = (IS_WIN ? windowsVncViewer() : null) ?? (await which('vncviewer', 'xtigervncviewer', 'tvnviewer', 'remmina', 'gvncviewer', 'xdg-open'))!;
    if (/remmina$/.test(bin)) launch(bin, ['-c', `vnc://${where}:${port}`]);
    else if (/xdg-open$/.test(bin)) launch(bin, [`vnc://${where}:${port}`]);
    else if (/gvncviewer$/.test(bin)) launch(bin, [`${where}:${port - 5900}`]);
    else launch(bin, [`${where}::${port}`]);
  }
  return { viewer: v.viewer! };
}
