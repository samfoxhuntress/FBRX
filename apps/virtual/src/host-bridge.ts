import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

/**
 * A bridge on one of the server's network ports, so virtual machines sit straight on that network (one more device
 * for the router). FBRX Server's network is ifupdown (/etc/network/interfaces): the port's own settings move to the
 * bridge br0, and the port becomes one of its ports. It takes over when the server restarts.
 */

export const BRIDGE = 'br0';

/** A line that starts a new stanza in interfaces(5); anything else after an iface line is one of its options. */
const STANZA = /^\s*(auto|allow-[\w-]+|iface|mapping|source|source-directory|no-auto-down|no-scripts)\b/;

export interface PortSetting {
  /** How the port gets its address now: dhcp, static, manual (none), or not in the file at all. */
  mode: 'dhcp' | 'static' | 'manual' | 'none' | 'other';
}

/** How a port is set up in the interfaces file (its IPv4 stanza). */
export function portSetting(text: string, port: string): PortSetting {
  const m = new RegExp(`^\\s*iface\\s+${escape(port)}\\s+inet\\s+(\\S+)`, 'm').exec(text);
  if (!m) return { mode: 'none' };
  const mode = m[1] as PortSetting['mode'];
  return { mode: ['dhcp', 'static', 'manual'].includes(mode) ? mode : 'other' };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The interfaces file with `port` in bridge br0: its address settings (DHCP or a static address, IPv4 and IPv6) move
 * to br0, and the port is left with none of its own. A port the file does not mention (a second card for machines
 * only) gets a bridge with no address for the server. Throws, in words, when it cannot be done safely.
 */
export function bridgeInterfaces(text: string, port: string, elsewhere = ''): string {
  if (!/^[A-Za-z0-9._-]{1,15}$/.test(port)) throw new Error('That is not a network port');
  if (new RegExp(`^\\s*iface\\s+${BRIDGE}\\b`, 'm').test(text) || new RegExp(`^\\s*iface\\s+${BRIDGE}\\b`, 'm').test(elsewhere)) throw new Error(`${BRIDGE} is already set up on this server`);
  if (new RegExp(`^\\s*iface\\s+${escape(port)}\\b`, 'm').test(elsewhere)) throw new Error(`${port} is set up in a file under /etc/network/interfaces.d: add the bridge there by hand`);
  if (new RegExp(`^\\s*bridge[-_]ports\\b.*\\b${escape(port)}\\b`, 'm').test(text)) throw new Error(`${port} is already in a bridge`);
  const setting = portSetting(text, port);
  if (setting.mode === 'other') throw new Error(`${port} is set up in a way FBRX Server does not change by itself: add the bridge by hand`);

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  const moved: Array<{ family: string; method: string; options: string[] }> = [];
  let hadAuto = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const auto = new RegExp(`^(\\s*)(auto|allow-hotplug)\\s+(.*)$`).exec(line);
    if (auto && auto[3]!.split(/\s+/).includes(port)) {
      // The port comes up at boot (a hotplug port would leave the bridge waiting for it).
      const rest = auto[3]!.split(/\s+/).filter((x) => x && x !== port);
      if (rest.length) out.push(`${auto[1]}${auto[2]} ${rest.join(' ')}`);
      if (!hadAuto) out.push(`${auto[1]}auto ${port}`);
      hadAuto = true;
      continue;
    }
    const iface = new RegExp(`^\\s*iface\\s+${escape(port)}\\s+(inet6?)\\s+(\\S+)\\s*$`).exec(line);
    if (iface) {
      const options: string[] = [];
      // Its options: the lines up to the next stanza, a blank line or a comment (which stay where they are).
      while (i + 1 < lines.length && !STANZA.test(lines[i + 1]!) && lines[i + 1]!.trim() && !lines[i + 1]!.trim().startsWith('#')) options.push(lines[++i]!.trim());
      moved.push({ family: iface[1]!, method: iface[2]!, options });
      if (iface[1] === 'inet') out.push(`iface ${port} inet manual`);
      continue;
    }
    out.push(line);
  }
  while (out.length && !out[out.length - 1]!.trim()) out.pop();
  if (!hadAuto) out.push('', `auto ${port}`);
  if (!moved.some((m) => m.family === 'inet')) out.push(`iface ${port} inet manual`);
  const v4 = moved.find((m) => m.family === 'inet') ?? { family: 'inet', method: 'manual', options: [] };
  out.push(
    '',
    '# FBRX Server: virtual machines reach your network through this bridge.',
    `auto ${BRIDGE}`,
    `iface ${BRIDGE} inet ${v4.method}`,
    ...v4.options.map((o) => `    ${o}`),
    `    bridge_ports ${port}`,
    '    bridge_stp off',
    '    bridge_fd 0',
  );
  for (const m of moved.filter((x) => x.family === 'inet6')) out.push('', `iface ${BRIDGE} inet6 ${m.method}`, ...m.options.map((o) => `    ${o}`));
  return `${out.join('\n')}\n`;
}

export interface HostPort {
  name: string;
  mac: string | null;
  /** IPv4 addresses it has now. */
  addresses: string[];
  up: boolean;
  /** The bridge it is in, if any. */
  bridge: string | null;
}

/** The server's network cards (ports with a device behind them: not loopback, bridges, or machines' cards). */
export function hostPorts(sysRoot = '/', nics = networkInterfaces()): HostPort[] {
  const dir = join(sysRoot, 'sys/class/net');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const read = (p: string) => {
    try {
      return readFileSync(p, 'utf8').trim();
    } catch {
      return null;
    }
  };
  return names
    .filter((n) => existsSync(join(dir, n, 'device')) && !existsSync(join(dir, n, 'bridge')) && !/^(vnet|tap|veth|virbr)/.test(n))
    .map((n) => {
      let bridge: string | null = null;
      try {
        bridge = existsSync(join(dir, n, 'master')) ? realpathSync(join(dir, n, 'master')).split('/').pop()! : null;
      } catch {
        bridge = null;
      }
      return {
        name: n,
        mac: read(join(dir, n, 'address')),
        addresses: (nics[n] ?? []).filter((a) => a.family === 'IPv4').map((a) => a.address),
        up: read(join(dir, n, 'operstate')) === 'up',
        bridge,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The hypervisor this server itself runs on, when it is a virtual machine (its bridges then need allowing there). */
export function outerHypervisor(sysRoot = '/'): 'vmware' | 'hyper-v' | 'virtualbox' | 'kvm' | 'other' | null {
  const read = (f: string) => {
    try {
      return readFileSync(join(sysRoot, 'sys/class/dmi/id', f), 'utf8').trim();
    } catch {
      return '';
    }
  };
  const v = `${read('sys_vendor')} ${read('product_name')}`;
  if (/vmware/i.test(v)) return 'vmware';
  if (/microsoft corporation.*virtual machine/i.test(v)) return 'hyper-v';
  if (/innotek|virtualbox/i.test(v)) return 'virtualbox';
  if (/qemu|kvm|proxmox/i.test(v)) return 'kvm';
  if (/xen|parallels|bochs/i.test(v)) return 'other';
  return null;
}
