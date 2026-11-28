import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { XrdpStatus } from '@fbrx/shared';
import { CoreError } from '../errors';

/**
 * Remote desktop for Linux computers and servers (2.5.0): the system's own xrdp, so any remote desktop (RDP) app can
 * sign in with the computer's accounts, including on a server with nobody at it (FBRX's remote screen needs a person
 * there, and a desktop). Setting it up installs xrdp (and a light desktop where the computer has none), starts it, and
 * where a firewall is on, opens its port only to the local networks this computer is on. Through the system's
 * administrator prompt, or straight away when FBRX runs as root (servers); never anything else.
 */

const run = promisify(execFile);
const PORT = 3389;
const XSESSIONS = '/usr/share/xsessions';

export interface XrdpDeps {
  platform?: NodeJS.Platform;
  root?: boolean;
  exists?: (path: string) => boolean;
  read?: (path: string) => string | null;
  sessions?: () => string[];
  which?: (cmd: string) => Promise<boolean>;
  systemctl?: (args: string[]) => Promise<string>;
  interfaces?: () => ReturnType<typeof networkInterfaces>;
}

const defaults = {
  exists: (p: string) => existsSync(p),
  read: (p: string) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
  sessions: () => {
    try {
      return readdirSync(XSESSIONS)
        .filter((f) => f.endsWith('.desktop'))
        .map((f) => (/^Name=(.+)$/m.exec(readFileSync(join(XSESSIONS, f), 'utf8'))?.[1] ?? f.replace(/\.desktop$/, '')).trim().slice(0, 60));
    } catch {
      return [];
    }
  },
  which: async (cmd: string) => {
    try {
      await run('sh', ['-c', `command -v ${cmd}`], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  },
  systemctl: async (args: string[]) => {
    try {
      return (await run('systemctl', args, { timeout: 10_000 })).stdout.trim();
    } catch (e) {
      return String((e as { stdout?: string }).stdout ?? '').trim();
    }
  },
};

/** The local networks this computer is on (private IPv4 only), as a.b.c.d/nn: what the firewall rule lets in. */
export function localNetworks(ifs: ReturnType<typeof networkInterfaces> = networkInterfaces()): { addresses: string[]; networks: string[] } {
  const addresses: string[] = [];
  const networks = new Set<string>();
  for (const list of Object.values(ifs)) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) continue;
      addresses.push(a.address);
      const bits = Math.max(8, Number((a.cidr ?? '').split('/')[1]) || 24);
      const ip = a.address.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
      const net = (ip & (bits === 32 ? 0xffffffff : ~(0xffffffff >>> bits))) >>> 0;
      networks.add(`${[24, 16, 8, 0].map((s) => (net >>> s) & 255).join('.')}/${bits}`);
    }
  }
  return { addresses, networks: [...networks] };
}

/** The port in /etc/xrdp/xrdp.ini ("port=3389", "port=tcp://:3389"), or 3389. */
export function xrdpPort(ini: string | null): number {
  const m = /^\s*port\s*=\s*(?:[a-z]+:\/\/[^:\s]*:)?(\d{1,5})\s*$/im.exec(ini ?? '');
  const p = m ? Number(m[1]) : PORT;
  return p > 0 && p < 65536 ? p : PORT;
}

export async function xrdpStatus(d: XrdpDeps = {}): Promise<XrdpStatus> {
  const platform = d.platform ?? process.platform;
  const none = (why: string): XrdpStatus => ({ supported: false, why, installed: false, running: false, enabled: false, port: PORT, desktops: [], addresses: [], manager: null, canSetUp: false, root: false });
  if (platform !== 'linux') return none(platform === 'win32' ? 'Windows has its own Remote Desktop (Settings → System → Remote Desktop).' : 'A Mac has Screen Sharing (System Settings → General → Sharing).');
  const exists = d.exists ?? defaults.exists;
  const which = d.which ?? defaults.which;
  const systemctl = d.systemctl ?? defaults.systemctl;
  const root = d.root ?? process.getuid?.() === 0;
  const manager = (await which('apt-get')) ? 'apt' : (await which('dnf')) ? 'dnf' : (await which('zypper')) ? 'zypper' : null;
  const installed = exists('/usr/sbin/xrdp') || exists('/usr/bin/xrdp');
  const [active, enabled] = installed ? await Promise.all([systemctl(['is-active', 'xrdp']), systemctl(['is-enabled', 'xrdp'])]) : ['', ''];
  const canSetUp = !!manager && (root || (await which('pkexec')));
  return {
    supported: true,
    why: manager ? (canSetUp ? null : 'Setting it up needs the system’s administrator prompt (pkexec, from polkit), which is not installed.') : 'FBRX sets it up with apt, dnf or zypper; this Linux has none of them.',
    installed,
    running: active === 'active',
    enabled: enabled === 'enabled',
    port: xrdpPort((d.read ?? defaults.read)('/etc/xrdp/xrdp.ini')),
    desktops: (d.sessions ?? defaults.sessions)(),
    addresses: localNetworks((d.interfaces ?? networkInterfaces)()).addresses,
    manager,
    canSetUp,
    root,
  };
}

const NET = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;
/** The local networks remote desktop was opened to, one per line. */
const OPENED = '/etc/xrdp/fbrx-networks';

/**
 * The script that sets it up (or, with on: false, turns it off), for /bin/sh: each step says FBRX-STEP first, so a
 * failure says where. Packages, the service, the TLS key's group on Debian and Ubuntu, and a firewall rule per local
 * network where ufw or firewalld is on. Nothing in it comes from outside FBRX but the networks, which are checked.
 */
export function xrdpScript(o: { on: boolean; manager: 'apt' | 'dnf' | 'zypper'; desktop: boolean; networks: string[]; port?: number }): string {
  const nets = o.networks.filter((n) => NET.test(n));
  const port = o.port ?? PORT;
  // The networks opened are kept (root's own file), so Turn off closes those too after the computer has moved on.
  const ufw = (verb: string) => `  for n in ${nets.join(' ')} $(cat ${OPENED} 2>/dev/null); do
    case "$n" in *[!0-9./]*|'') continue ;; esac
    ufw ${verb} from "$n" to any port ${port} proto tcp${verb === 'allow' ? " comment 'FBRX remote desktop'" : ''} || true
  done`;
  const fwd = (verb: string) => `  for n in ${nets.join(' ')} $(cat ${OPENED} 2>/dev/null); do
    case "$n" in *[!0-9./]*|'') continue ;; esac
    firewall-cmd --permanent --${verb}-rich-rule="rule family=\\"ipv4\\" source address=\\"$n\\" port port=\\"${port}\\" protocol=\\"tcp\\" accept" || true
  done`;
  const firewall = (on: boolean) => `echo FBRX-STEP firewall
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
${ufw(on ? 'allow' : 'delete allow')}
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
${fwd(on ? 'add' : 'remove')}
  firewall-cmd --reload || true
fi
${on ? `mkdir -p /etc/xrdp && { cat ${OPENED} 2>/dev/null; printf '%s\\n' ${nets.join(' ')}; } | sort -u > ${OPENED}.new && mv ${OPENED}.new ${OPENED}` : `rm -f ${OPENED}`}`;
  if (!o.on) return ['set -e', 'echo FBRX-STEP service', 'systemctl disable --now xrdp || true', firewall(false), 'echo FBRX-STEP done', ''].join('\n');
  const install =
    o.manager === 'apt'
      ? ['export DEBIAN_FRONTEND=noninteractive', 'apt-get update -q', 'apt-get install -y -q xrdp xorgxrdp', ...(o.desktop ? ['apt-get install -y -q xfce4 xfce4-terminal dbus-x11'] : []), 'adduser xrdp ssl-cert >/dev/null 2>&1 || true']
      : o.manager === 'dnf'
        ? ['dnf install -y xrdp xorgxrdp', ...(o.desktop ? ['dnf install -y @xfce-desktop-environment'] : [])]
        : ['zypper -n install xrdp xorgxrdp', ...(o.desktop ? ['zypper -n install -t pattern xfce'] : [])];
  return ['set -e', 'echo FBRX-STEP install', ...install, 'echo FBRX-STEP service', 'systemctl enable --now xrdp', firewall(true), 'echo FBRX-STEP done', ''].join('\n');
}

/** Runs a script as root: through pkexec (the person types their password) or straight away when FBRX is root. */
function asRoot(script: string, root: boolean): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = root ? spawn('/bin/sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }) : spawn('pkexec', ['/bin/sh', '-s'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => p.kill('SIGTERM'), 20 * 60_000);
    p.stdout.on('data', (b: Buffer) => (out = (out + b.toString()).slice(-20_000)));
    p.stderr.on('data', (b: Buffer) => (err = (err + b.toString()).slice(-20_000)));
    p.on('error', (e) => (clearTimeout(timer), resolve({ code: 127, out, err: String(e.message) })));
    p.on('close', (code) => (clearTimeout(timer), resolve({ code: code ?? 1, out, err })));
    p.stdin.end(script);
  });
}

/** Sets remote desktop up, or turns it off; returns the status after. */
export async function setXrdp(on: boolean, o: { root?: boolean; exec?: typeof asRoot; deps?: XrdpDeps } = {}): Promise<XrdpStatus> {
  const before = await xrdpStatus(o.deps);
  if (!before.supported) throw new CoreError('UNAVAILABLE', before.why ?? 'Not on this computer');
  if (!before.manager || !before.canSetUp) throw new CoreError('UNAVAILABLE', before.why ?? 'This computer cannot set it up');
  if (!on && !before.installed) return before;
  const root = o.root ?? before.root;
  const { networks } = localNetworks((o.deps?.interfaces ?? networkInterfaces)());
  const script = xrdpScript({ on, manager: before.manager, desktop: on && before.desktops.length === 0, networks, port: before.port });
  const r = await (o.exec ?? asRoot)(script, root);
  if (!root && (r.code === 126 || r.code === 127) && !/FBRX-STEP/.test(r.out)) throw new CoreError('CANCELLED', 'The administrator prompt was closed, so nothing changed');
  if (r.code !== 0) {
    const step = [...r.out.matchAll(/FBRX-STEP (\w+)/g)].pop()?.[1] ?? 'start';
    const last = r.err.trim().split('\n').slice(-3).join(' ').slice(0, 300);
    throw new CoreError('INTERNAL', `It stopped at the ${step} step${last ? `: ${last}` : ''}`);
  }
  return xrdpStatus(o.deps);
}
