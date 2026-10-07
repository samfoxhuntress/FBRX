import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inCidr, intToIPv4, ipv4ToInt } from '@fbrx/shared';
import type { GateConfig } from '../model';
import type { GateRendered } from '../render/index';
import { NFT_TABLE, WG_IFACE } from '../render/nftables';
import type { GatePaths } from '../render/paths';
import { IFB } from '../render/qos';
import type { GateLive, GateInterfaceLive, GateLease } from '../types';
import { wgKeyPair, wgPublicKey } from './keys';

export interface RunResult {
  code: number;
  out: string;
  err: string;
}
export type Runner = (cmd: string, args: string[]) => Promise<RunResult>;

export interface GateApplier {
  readonly kind: 'linux' | 'simulated';
  /** Refuses settings the system would not take (before anything changes). */
  check(r: GateRendered): Promise<void>;
  /** Makes them so. Returns notes worth showing (a fallback taken, say). */
  apply(r: GateRendered, previous: GateRendered | null, c: GateConfig): Promise<string[]>;
  /** Takes away everything the gate set up. */
  clear(previous: GateRendered | null): Promise<void>;
  live(c: GateConfig | null): Promise<GateLive>;
  /** The VPN's key pair: made once, the private half kept in a file only root reads. */
  vpnKey(): Promise<{ publicKey: string }>;
  /** This computer's network ports, to choose from. */
  systemInterfaces(): Promise<SystemInterface[]>;
}

export interface SystemInterface {
  name: string;
  mac: string | null;
  up: boolean;
  /** Link speed in Mbit/s, when known. */
  speed: number | null;
  kind: 'ethernet' | 'vlan' | 'bridge' | 'virtual';
}

export const runCommand: Runner = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: unknown }) | null;
      const code = !e ? 0 : typeof e.code === 'number' ? e.code : e.code === 'ENOENT' ? -1 : 1;
      resolve({ code, out: String(stdout ?? ''), err: String(stderr || (code === -1 ? `${cmd} is not installed` : e?.message ?? '')) });
    });
  });

const emptyLive = (): GateLive => ({ at: new Date().toISOString(), interfaces: [], wan: { address: null, gateway: null }, leases: [], counters: {}, qos: { kind: null, detail: null }, dns: { running: false }, conntrack: null, vpn: [], problems: [] });

/** Reads dnsmasq's lease file: "expiry mac address name client-id". */
export function parseLeases(text: string, c: GateConfig | null): GateLease[] {
  return text
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 4 && /^[0-9a-f:]{17}$/i.test(p[1]))
    .map(([exp, mac, address, name]) => ({
      expires: exp === '0' ? null : new Date(Number(exp) * 1000).toISOString(),
      mac: mac.toLowerCase(),
      address,
      name: name === '*' ? null : name,
      network: c?.networks.find((n) => inCidr(address, n.address))?.name ?? null,
    }));
}

// -------------------------------------------------------------------------------------------- simulated

/** For development and the console's demo: remembers what it was given and makes up plausible live numbers. */
export class SimulatedApplier implements GateApplier {
  readonly kind = 'simulated' as const;
  last: GateRendered | null = null;
  applied = 0;
  failNext: string | null = null;
  private key = wgKeyPair();

  async check(r: GateRendered): Promise<void> {
    if (!r.nftables.includes(`table inet ${NFT_TABLE} {`)) throw new Error('nftables: no gate table');
  }

  async apply(r: GateRendered): Promise<string[]> {
    if (this.failNext) {
      const m = this.failNext;
      this.failNext = null;
      throw new Error(m);
    }
    this.last = r;
    this.applied++;
    return ['Simulated: nothing on this computer was changed.'];
  }

  async clear(): Promise<void> {
    this.last = null;
  }

  async vpnKey() {
    return { publicKey: this.key.publicKey };
  }

  async systemInterfaces(): Promise<SystemInterface[]> {
    return ['eno1', 'eno2', 'eno3', 'eno4'].map((name, i) => ({ name, mac: `02:fb:00:00:01:0${i + 1}`, up: i < 2, speed: i < 2 ? 1000 : null, kind: 'ethernet' as const }));
  }

  async live(c: GateConfig | null): Promise<GateLive> {
    const live = emptyLive();
    if (!c) return live;
    const t = Date.now() / 1000;
    // A day's worth of traffic that keeps growing at a few hundred kB/s, with some wobble.
    const wave = (k: number) => Math.round((t % 86400) * (1.5e5 + 6e4 * k) + Math.sin(t / 20 + k) * 2e6 + 5e7);
    live.interfaces = c.interfaces.map((i, k) => ({ name: i.name, up: true, mtu: i.mtu, mac: `02:fb:00:00:00:${(k + 1).toString(16).padStart(2, '0')}`, addresses: c.networks.filter((n) => n.interface === i.name).map((n) => n.address).concat(i.name === c.wan.interface ? [c.wan.address ?? '203.0.113.20/24'] : []), rxBytes: wave(k), txBytes: wave(k + 3), rxPackets: Math.round(wave(k) / 900), txPackets: Math.round(wave(k + 3) / 900) }));
    live.wan = { address: c.wan.address?.split('/')[0] ?? '203.0.113.20', gateway: c.wan.gateway ?? '203.0.113.1' };
    // Reserved devices, and a few that came and asked (in each network handing out addresses).
    const visitors = ['laptop', 'phone', 'printer', 'tv'];
    live.leases = c.networks.flatMap((n) => [
      ...n.dhcp.reservations.map((r) => ({ expires: null, mac: r.mac.toLowerCase(), address: r.address, name: r.name ?? null, network: n.name })),
      ...(n.dhcp.enabled
        ? visitors.slice(0, 2 + (n.name.length % 3)).map((v, k) => ({ expires: new Date((Math.floor(t / 3600) + 1 + k) * 3600_000).toISOString(), mac: `02:fb:${n.name.length.toString(16).padStart(2, '0')}:00:10:${(k + 1).toString(16).padStart(2, '0')}`, address: intToIPv4(ipv4ToInt(n.dhcp.start) + k), name: `${v}-${n.name}`, network: n.name }))
        : []),
    ]);
    for (const r of c.firewall.rules) live.counters[`rule:${r.id}`] = { packets: Math.round(t % 997), bytes: Math.round((t % 997) * 600) };
    live.counters['default:input'] = { packets: Math.round(t % 4093), bytes: Math.round((t % 4093) * 80) };
    live.counters['default:forward'] = { packets: Math.round(t % 211), bytes: Math.round((t % 211) * 120) };
    if (c.qos.preferMesh.enabled) {
      live.counters['mesh:to-port'] = { packets: Math.round(wave(5) / 1400), bytes: wave(5) };
      live.counters['mesh:from-port'] = { packets: Math.round(wave(6) / 1400), bytes: wave(6) };
    }
    live.qos = c.qos.enabled ? { kind: 'cake', detail: `cake diffserv4 ${c.qos.upload} Mbit/s up` } : { kind: null, detail: null };
    live.dns.running = true;
    live.conntrack = 180 + Math.round(t % 300);
    live.problems = ['Simulated gate: nothing on this computer is changed.'];
    return live;
  }
}

// ------------------------------------------------------------------------------------------------ Linux

export interface LinuxApplierOptions {
  paths: GatePaths;
  /** "networkd" (FBRX Server: kept across restarts) or "iproute" (applied directly; tests and systems without it). */
  mode: 'networkd' | 'iproute';
  /** Prefix for /etc paths (tests write into a temporary folder). */
  root?: string;
  /** Runs commands (tests run them inside a network namespace). */
  run?: Runner;
  /** Restarts dnsmasq once its file is written (default: systemctl restart dnsmasq). */
  restartDns?: (confFile: string) => Promise<void>;
  /** Where dnsmasq reads the file (default <root>/etc/dnsmasq.d/fbrx-gate.conf). */
  dnsmasqConf?: string;
}

/**
 * Applies a rendered configuration to this Linux system: kernel settings, ports and VLANs, the nftables table,
 * dnsmasq and traffic shaping. Each step that can be checked first is (nft -c, dnsmasq --test).
 */
export class LinuxApplier implements GateApplier {
  readonly kind = 'linux' as const;
  private readonly run: Runner;
  private readonly root: string;
  private readonly networkdDir: string;
  private readonly dnsmasqConf: string;

  constructor(private readonly o: LinuxApplierOptions) {
    this.run = o.run ?? runCommand;
    this.root = o.root ?? '/';
    this.networkdDir = join(this.root, 'etc/systemd/network');
    this.dnsmasqConf = o.dnsmasqConf ?? join(this.root, 'etc/dnsmasq.d/fbrx-gate.conf');
  }

  private async must(cmd: string, args: string[], what: string): Promise<RunResult> {
    const r = await this.run(cmd, args);
    if (r.code !== 0) throw new Error(`${what}: ${(r.err || r.out).trim().split('\n').slice(-3).join(' ').slice(0, 400) || `${cmd} failed`}`);
    return r;
  }

  private write(file: string, content: string, mode = 0o644) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, { mode });
    chmodSync(file, mode);
  }

  private dirs() {
    const p = this.o.paths;
    for (const d of [p.varDir, p.logDir, p.etcDir]) mkdirSync(d, { recursive: true });
    chmodSync(p.etcDir, 0o750);
    const block = join(p.varDir, 'blocklist.conf');
    if (!existsSync(block)) writeFileSync(block, '# Filled from the blocklists FBRX Gate fetches.\n');
  }

  async check(r: GateRendered): Promise<void> {
    this.dirs();
    const tmp = mkdtempSync(join(tmpdir(), 'fbrx-gate-check-'));
    try {
      const nft = join(tmp, 'gate.nft');
      writeFileSync(nft, r.nftables);
      await this.must('nft', ['-c', '-f', nft], 'The firewall rules were refused');
      const dns = join(tmp, 'dnsmasq.conf');
      writeFileSync(dns, r.dnsmasq);
      await this.must('dnsmasq', ['--test', `--conf-file=${dns}`], 'The DHCP and DNS settings were refused');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async systemInterfaces(): Promise<SystemInterface[]> {
    const r = await this.run('ip', ['-j', '-d', 'link', 'show']);
    if (r.code !== 0) return [];
    type Link = { ifname: string; link_type?: string; address?: string; flags?: string[]; operstate?: string; linkinfo?: { info_kind?: string } };
    let links: Link[] = [];
    try {
      links = JSON.parse(r.out) as Link[];
    } catch {
      return [];
    }
    return links
      .filter((l) => l.link_type === 'ether' && l.ifname !== WG_IFACE)
      .map((l) => {
        const k = l.linkinfo?.info_kind;
        let speed: number | null = null;
        try {
          const v = Number(readFileSync(`/sys/class/net/${l.ifname}/speed`, 'utf8').trim());
          speed = v > 0 ? v : null;
        } catch {
          /* virtual or down */
        }
        return { name: l.ifname, mac: l.address ?? null, up: l.operstate === 'UP', speed, kind: !k ? 'ethernet' : k === 'vlan' ? 'vlan' : k === 'bridge' ? 'bridge' : 'virtual' } as SystemInterface;
      });
  }

  async vpnKey(): Promise<{ publicKey: string }> {
    const file = join(this.o.paths.etcDir, 'wg-fbrx.key');
    mkdirSync(this.o.paths.etcDir, { recursive: true });
    if (!existsSync(file)) this.write(file, `${wgKeyPair().privateKey}\n`, 0o640);
    return { publicKey: wgPublicKey(readFileSync(file, 'utf8')) };
  }

  async apply(r: GateRendered, previous: GateRendered | null, c: GateConfig): Promise<string[]> {
    const notes: string[] = [];
    this.dirs();

    // Kernel settings.
    this.write(join(this.root, 'etc/sysctl.d/90-fbrx-gate.conf'), `# Made by FBRX Gate.\n${r.sysctl.map(([k, v]) => `${k} = ${v}`).join('\n')}\n`);
    for (const [k, v] of r.sysctl) await this.must('sysctl', ['-w', `${k}=${v}`], `Kernel setting ${k}`);

    // The VPN's key exists before anything refers to it.
    if (c.vpn.enabled) await this.vpnKey();

    // Ports, VLANs and addresses.
    if (this.o.mode === 'networkd') {
      mkdirSync(this.networkdDir, { recursive: true });
      const keep = new Set(r.networkd.map((f) => f.name));
      for (const f of readdirSync(this.networkdDir)) if (f.startsWith('10-fbrx-') && !keep.has(f)) rmSync(join(this.networkdDir, f));
      for (const f of r.networkd) this.write(join(this.networkdDir, f.name), f.content, f.mode);
      // systemd-networkd reads the VPN key file as its own user.
      if (c.vpn.enabled) await this.run('chgrp', ['systemd-network', join(this.o.paths.etcDir, 'wg-fbrx.key')]);
      await this.must('networkctl', ['reload'], 'systemd-networkd');
      const names = [...new Set(r.networkd.map((f) => f.name.replace(/^10-fbrx-/, '').replace(/\.(network|netdev)$/, '')))];
      for (const n of names) await this.run('networkctl', ['reconfigure', n]);
    } else {
      const vlans = (rr: GateRendered | null) => new Set((rr?.ip ?? []).filter((a) => a[0] === 'link' && a[1] === 'add').map((a) => a[4]));
      const now = vlans(r);
      for (const v of vlans(previous)) if (!now.has(v)) await this.run('ip', ['link', 'del', 'dev', v]);
      for (const cmd of r.ip) {
        const res = await this.run('ip', cmd);
        if (res.code !== 0 && !/File exists/.test(res.err)) throw new Error(`ip ${cmd.join(' ')}: ${res.err.trim()}`);
      }
      if (c.vpn.enabled) notes.push(...(await this.wireguardIproute(c)));
    }

    // The firewall, loaded from a file the boot service loads again at the next start.
    const nft = join(this.o.paths.etcDir, 'gate.nft');
    this.write(nft, r.nftables, 0o640);
    await this.must('nft', ['-f', nft], 'The firewall rules');

    // DHCP and DNS.
    this.write(this.dnsmasqConf, r.dnsmasq);
    if (this.o.restartDns) await this.o.restartDns(this.dnsmasqConf);
    else await this.must('systemctl', ['restart', 'dnsmasq'], 'dnsmasq');

    // Traffic shaping.
    notes.push(...(await this.qos(r, previous)));
    this.write(join(this.o.paths.etcDir, 'qos.json'), JSON.stringify(r.qos, null, 2));
    return notes;
  }

  private async wireguardIproute(c: GateConfig): Promise<string[]> {
    const add = await this.run('ip', ['link', 'add', 'dev', WG_IFACE, 'type', 'wireguard']);
    if (add.code !== 0 && !/File exists/.test(add.err)) return [`VPN: this kernel has no WireGuard (${add.err.trim()})`];
    const key = join(this.o.paths.etcDir, 'wg-fbrx.key');
    const args = ['set', WG_IFACE, 'private-key', key, 'listen-port', String(c.vpn.port)];
    for (const p of c.vpn.peers) args.push('peer', p.publicKey, 'allowed-ips', `${p.address}/32`, ...(p.keepalive ? ['persistent-keepalive', String(p.keepalive)] : []));
    const wg = await this.run('wg', args);
    if (wg.code !== 0) return [`VPN: ${wg.err.trim() || 'wg failed'} (install wireguard-tools)`];
    await this.run('ip', ['addr', 'replace', c.vpn.address, 'dev', WG_IFACE]);
    await this.run('ip', ['link', 'set', 'dev', WG_IFACE, 'up']);
    return [];
  }

  private async qos(r: GateRendered, previous: GateRendered | null): Promise<string[]> {
    const notes: string[] = [];
    const prevWan = previous?.qos?.wan;
    for (const dev of new Set([prevWan, r.qos?.wan].filter(Boolean) as string[])) {
      await this.run('tc', ['qdisc', 'del', 'dev', dev, 'root']);
      await this.run('tc', ['qdisc', 'del', 'dev', dev, 'ingress']);
    }
    await this.run('ip', ['link', 'del', 'dev', IFB]);
    const q = r.qos;
    if (!q) return notes;
    const [root, ...ingress] = q.cake;
    const cake = await this.run('tc', root);
    if (cake.code === 0) {
      if (ingress.length) {
        const ifb = await this.run('ip', ['link', 'add', 'name', IFB, 'type', 'ifb']);
        if (ifb.code === 0 || /File exists/.test(ifb.err)) {
          await this.run('ip', ['link', 'set', 'dev', IFB, 'up']);
          for (const cmd of ingress) {
            const res = await this.run('tc', cmd);
            if (res.code !== 0) {
              notes.push(`Downloads are not shaped: ${res.err.trim().slice(0, 200)}`);
              break;
            }
          }
        } else notes.push('Downloads are not shaped: this kernel has no ifb module.');
      }
      return notes;
    }
    // No cake here: the same priority lanes with HTB (uploads only).
    for (const cmd of q.htb.commands) await this.must('tc', cmd, 'Traffic shaping');
    let leafKind = '';
    for (const [i, cls] of q.htb.leaves.entries()) {
      for (const kind of ['fq_codel', 'sfq', 'pfifo']) {
        const res = await this.run('tc', ['qdisc', 'replace', 'dev', q.wan, 'parent', cls, 'handle', `${(i + 1) * 10}:`, kind]);
        if (res.code === 0) {
          leafKind = kind;
          break;
        }
      }
    }
    notes.push(`Traffic shaping uses HTB${leafKind ? ` with ${leafKind}` : ''}: this kernel has no cake.${q.cake.length > 1 ? ' Downloads are not shaped.' : ''}`);
    return notes;
  }

  async clear(previous: GateRendered | null): Promise<void> {
    if (this.o.mode === 'networkd' && existsSync(this.networkdDir)) {
      for (const f of readdirSync(this.networkdDir)) if (f.startsWith('10-fbrx-')) rmSync(join(this.networkdDir, f));
      await this.run('networkctl', ['reload']);
    }
    await this.run('nft', ['delete', 'table', 'inet', NFT_TABLE]);
    rmSync(join(this.o.paths.etcDir, 'gate.nft'), { force: true });
    rmSync(this.dnsmasqConf, { force: true });
    if (this.o.restartDns) await this.o.restartDns(this.dnsmasqConf);
    else await this.run('systemctl', ['restart', 'dnsmasq']);
    if (previous?.qos) {
      await this.run('tc', ['qdisc', 'del', 'dev', previous.qos.wan, 'root']);
      await this.run('tc', ['qdisc', 'del', 'dev', previous.qos.wan, 'ingress']);
    }
    await this.run('ip', ['link', 'del', 'dev', IFB]);
  }

  async live(c: GateConfig | null): Promise<GateLive> {
    const live = emptyLive();
    const json = async <T>(cmd: string, args: string[]): Promise<T | null> => {
      const r = await this.run(cmd, args);
      if (r.code !== 0) return null;
      try {
        return JSON.parse(r.out) as T;
      } catch {
        return null;
      }
    };
    type Link = { ifname: string; flags?: string[]; operstate?: string; mtu: number; address?: string; stats64?: { rx: { bytes: number; packets: number }; tx: { bytes: number; packets: number } } };
    type Addr = { ifname: string; addr_info?: Array<{ family: string; local: string; prefixlen: number; scope?: string }> };
    const links = (await json<Link[]>('ip', ['-j', '-s', 'link', 'show'])) ?? [];
    const addrs = (await json<Addr[]>('ip', ['-j', 'addr', 'show'])) ?? [];
    const wanted = new Set(c ? [...c.interfaces.map((i) => i.name), ...(c.vpn.enabled ? [WG_IFACE] : [])] : []);
    live.interfaces = links
      .filter((l) => wanted.has(l.ifname))
      .map((l): GateInterfaceLive => ({
        name: l.ifname,
        up: (l.flags ?? []).includes('UP') && l.operstate !== 'DOWN',
        mtu: l.mtu,
        mac: l.address ?? null,
        addresses: (addrs.find((a) => a.ifname === l.ifname)?.addr_info ?? []).filter((a) => a.family === 'inet').map((a) => `${a.local}/${a.prefixlen}`),
        rxBytes: l.stats64?.rx.bytes ?? 0,
        txBytes: l.stats64?.tx.bytes ?? 0,
        rxPackets: l.stats64?.rx.packets ?? 0,
        txPackets: l.stats64?.tx.packets ?? 0,
      }));
    if (c) {
      for (const n of c.interfaces) if (!live.interfaces.some((i) => i.name === n.name)) live.problems.push(`${n.name} does not exist on this computer`);
      live.wan.address = live.interfaces.find((i) => i.name === c.wan.interface)?.addresses[0]?.split('/')[0] ?? null;
      const routes = (await json<Array<{ gateway?: string; dev?: string }>>('ip', ['-j', 'route', 'show', 'default'])) ?? [];
      live.wan.gateway = routes.find((r) => r.dev === c.wan.interface)?.gateway ?? routes[0]?.gateway ?? null;
      if (!live.wan.address) live.problems.push('The internet port has no address yet');
    }
    try {
      live.leases = parseLeases(readFileSync(join(this.o.paths.varDir, 'dnsmasq.leases'), 'utf8'), c);
    } catch {
      /* no leases yet */
    }
    type Rule = { rule?: { comment?: string; expr?: Array<{ counter?: { packets: number; bytes: number } }> } };
    const table = await json<{ nftables: Rule[] }>('nft', ['-j', 'list', 'table', 'inet', NFT_TABLE]);
    for (const item of table?.nftables ?? []) {
      const rule = item.rule;
      const counter = rule?.expr?.find((e) => e.counter)?.counter;
      if (rule?.comment && counter) live.counters[rule.comment] = { packets: counter.packets, bytes: counter.bytes };
    }
    if (c && !table) live.problems.push('The firewall table is not loaded');
    if (c?.qos.enabled) {
      const q = await json<Array<{ kind: string; options?: { bandwidth?: number; diffserv?: string } }>>('tc', ['-j', 'qdisc', 'show', 'dev', c.wan.interface]);
      const rootQ = q?.find((x) => x.kind === 'cake' || x.kind === 'htb');
      live.qos = rootQ ? { kind: rootQ.kind as 'cake' | 'htb', detail: rootQ.kind === 'cake' ? `cake ${rootQ.options?.diffserv ?? 'diffserv4'}` : 'HTB with priority classes' } : { kind: null, detail: null };
      if (!rootQ) live.problems.push('Traffic shaping is on but not in place');
    }
    live.dns.running = (await this.run('pgrep', ['-x', 'dnsmasq'])).code === 0;
    try {
      live.conntrack = Number(readFileSync('/proc/sys/net/netfilter/nf_conntrack_count', 'utf8').trim());
    } catch {
      live.conntrack = null;
    }
    if (c?.vpn.enabled) {
      const dump = await this.run('wg', ['show', WG_IFACE, 'dump']);
      if (dump.code === 0) {
        live.vpn = dump.out
          .trim()
          .split('\n')
          .slice(1)
          .map((l) => l.split('\t'))
          .map((p) => ({ publicKey: p[0], endpoint: p[2] === '(none)' ? null : p[2], latestHandshake: Number(p[4]) ? new Date(Number(p[4]) * 1000).toISOString() : null, rxBytes: Number(p[5]) || 0, txBytes: Number(p[6]) || 0 }));
      }
    }
    return live;
  }
}
