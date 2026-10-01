import dgram from 'node:dgram';
import dns from 'node:dns';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import { spawn } from 'node:child_process';
import mdnsFactory from 'multicast-dns';
import si from 'systeminformation';
import {
  newId,
  PRINTER_ACTIONS,
  type BluetoothDevice,
  type DnsTest,
  type ElevatedResult,
  type LanDevice,
  type LanScan,
  type LanScanCompare,
  type NetAdapter,
  type NetContext,
  type NetEvent,
  type PingResult,
  type PrinterInfo,
  type SpeedTestResult,
  type TraceHop,
  type WifiInfo,
} from '@fbrx/shared';
import { CoreError } from '../errors';
import type { EventBus } from '../events';
import type { Db } from '../storage/db';
import { arr, elevated, exec, IS_WIN, ps, psJson, psq, requireWindows } from '../windows/ps';

const IPV4 = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/;
export const validIp = (ip: unknown): ip is string => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(String(ip ?? ''));
const ipNum = (ip: string) => ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
const ipStr = (v: number) => [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255].join('.');
export function isPrivate(ip: string): boolean {
  const n = ipNum(ip);
  return n >>> 24 === 10 || n >>> 20 === ((172 << 4) | 1) || n >>> 16 === ((192 << 8) | 168) || n >>> 16 === ((169 << 8) | 254);
}
const isCgnat = (ip: string) => {
  const n = ipNum(ip);
  return n >= ipNum('100.64.0.0') && n <= ipNum('100.127.255.255');
};
export const maskToPrefix = (m: string) => String(m || '').split('.').reduce((a, o) => a + (Number(o).toString(2).match(/1/g) ?? []).length, 0);
/** Host names and addresses only: letters, digits, dots, dashes, colons (IPv6). Blocks option injection. */
const HOST = /^(?!-)[A-Za-z0-9.:-]{1,253}$/;
const checkHost = (h: string) => {
  const s = h.trim();
  if (!HOST.test(s)) throw new CoreError('INVALID_ARGUMENT', 'Enter a host name or IP address');
  return s;
};

/** Expands a CIDR between /22 and /30 into host addresses. */
export function cidrHosts(cidr: string): { hosts: string[]; label: string } {
  const m = String(cidr).trim().match(/^(\d+\.\d+\.\d+\.\d+)(?:\/(\d+))?$/);
  if (!m || !validIp(m[1])) throw new CoreError('INVALID_ARGUMENT', 'Subnet must look like 192.168.1.0/24');
  const bits = m[2] ? Number(m[2]) : 24;
  if (bits < 22 || bits > 30) throw new CoreError('INVALID_ARGUMENT', 'Subnet size must be between /22 (1022 hosts) and /30');
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  const base = (ipNum(m[1]) & mask) >>> 0;
  const count = 2 ** (32 - bits);
  const hosts: string[] = [];
  for (let i = 1; i < count - 1; i++) hosts.push(ipStr(base + i));
  return { hosts, label: `${ipStr(base)}/${bits}` };
}

function probePort(host: string, port: number, timeout = 450): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const fin = (ok: boolean) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeout);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    s.connect(port, host);
  });
}

async function reverse(ip: string, ms = 1500): Promise<string | null> {
  try {
    const r = await Promise.race([dns.promises.reverse(ip), new Promise<string[]>((_, j) => setTimeout(() => j(new Error('t')), ms))]);
    return r[0] ?? null;
  } catch {
    return null;
  }
}

const FINGERPRINT_PORTS = [80, 443, 22, 445, 3389, 9100, 631, 515, 554, 8009, 62078, 5000, 8080, 1883, 548, 7000];
const MDNS_SERVICES = ['_ipp._tcp.local', '_ipps._tcp.local', '_printer._tcp.local', '_pdl-datastream._tcp.local', '_scanner._tcp.local', '_airplay._tcp.local', '_raop._tcp.local', '_googlecast._tcp.local', '_smb._tcp.local', '_device-info._tcp.local', '_companion-link._tcp.local', '_hap._tcp.local', '_spotify-connect._tcp.local', '_sonos._tcp.local', '_workstation._tcp.local', '_ssh._tcp.local', '_http._tcp.local', '_fbrx._tcp.local'];

/**
 * Network diagnostics: ping, traceroute with hop identification, LAN discovery (ping sweep + ARP + mDNS + SSDP +
 * port fingerprinting + MAC vendor), speed test, Wi-Fi, Bluetooth, printers, DNS and adapter configuration.
 */
export class NetDiag {
  private oui: Map<string, string> | null = null;
  private readonly ipInfoCache = new Map<string, { org: string | null; location: string | null; name: string | null } | null>();

  constructor(
    private readonly d: {
      db: Db;
      events: EventBus;
      ouiFile: string;
      /** False when policy forbids FBRX from reaching the internet. */
      internet: () => boolean;
    },
  ) {}

  private emit(e: NetEvent) {
    this.d.events.emit('net.event', e);
  }

  // ----------------------------------------------------------------------------------------- basics

  async context(): Promise<NetContext> {
    const [ifs, gw] = await Promise.all([si.networkInterfaces().catch(() => []), si.networkGatewayDefault().catch(() => '')]);
    const list = (Array.isArray(ifs) ? ifs : [ifs]).filter((i) => !i.internal && (i.ip4 || i.ip6));
    const def = await si.networkInterfaceDefault().catch(() => '');
    const primary = list.find((i) => i.iface === def) ?? list.find((i) => i.ip4);
    return {
      hostname: hostname(),
      interfaces: list.map((i) => ({
        name: i.ifaceName || i.iface,
        ip: i.ip4 || i.ip6,
        mac: i.mac,
        netmask: i.ip4subnet,
        type: i.type,
        speedMbps: i.speed && i.speed > 0 ? i.speed : null,
        up: i.operstate === 'up' || !!i.ip4,
      })),
      ip: primary?.ip4 || null,
      gateway: gw || null,
      dns: dns.getServers(),
    };
  }

  private async localIp(): Promise<{ ip: string | null; mask: string; mac: string; gateway: string | null }> {
    const ctx = await this.context();
    const iface = ctx.interfaces.find((i) => i.ip === ctx.ip);
    if (ctx.ip) return { ip: ctx.ip, mask: iface?.netmask || '255.255.255.0', mac: iface?.mac ?? '', gateway: ctx.gateway };
    for (const list of Object.values(networkInterfaces())) {
      const v4 = (list ?? []).find((a) => a.family === 'IPv4' && !a.internal);
      if (v4) return { ip: v4.address, mask: v4.netmask, mac: v4.mac, gateway: ctx.gateway };
    }
    return { ip: null, mask: '255.255.255.0', mac: '', gateway: ctx.gateway };
  }

  async publicIp(): Promise<{ ip: string | null; isp: string | null; location: string | null }> {
    if (!this.d.internet()) throw new CoreError('POLICY_DENIED', 'Internet access is blocked by policy');
    try {
      const j: any = await (await fetch('https://speed.cloudflare.com/meta', { signal: AbortSignal.timeout(6000) })).json();
      return { ip: j.clientIp ?? null, isp: j.asOrganization ?? null, location: [j.city, j.country].filter(Boolean).join(', ') || null };
    } catch {
      try {
        const j: any = await (await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(6000) })).json();
        return { ip: j.ip ?? null, isp: null, location: null };
      } catch {
        return { ip: null, isp: null, location: null };
      }
    }
  }

  async ping(hostRaw: string, count = 4, timeoutMs = 1000): Promise<PingResult> {
    const host = checkHost(hostRaw);
    const n = Math.max(1, Math.min(50, Math.round(count)));
    const args = IS_WIN ? ['-n', String(n), '-w', String(timeoutMs), host] : ['-c', String(n), '-W', String(Math.ceil(timeoutMs / 1000)), '-i', '0.2', host];
    const r = await exec('ping', args, { timeoutMs: n * (timeoutMs + 500) + 5000 });
    const samples: Array<number | null> = [];
    let ip: string | null = validIp(host) ? host : null;
    for (const line of r.out.split('\n')) {
      if (!ip) ip = line.match(/\[(\d+\.\d+\.\d+\.\d+)\]|\((\d+\.\d+\.\d+\.\d+)\)/)?.slice(1).find(Boolean) ?? null;
      if (/ttl/i.test(line)) {
        const m = line.match(/[=<]\s?([\d.]+)\s?ms/i);
        if (m) samples.push(line.includes('<') && !line.includes('=') ? 0.5 : parseFloat(m[1]));
      } else if (/timed out|unreachable/i.test(line)) samples.push(null);
    }
    const times = samples.filter((x): x is number => x != null);
    const recv = times.length;
    return {
      host,
      ip,
      sent: n,
      received: recv,
      lossPct: Math.round(((n - recv) / n) * 100),
      min: recv ? Math.min(...times) : null,
      avg: recv ? Math.round((times.reduce((a, b) => a + b, 0) / recv) * 10) / 10 : null,
      max: recv ? Math.max(...times) : null,
      jitter: recv > 1 ? Math.round((times.slice(1).reduce((a, t, i) => a + Math.abs(t - times[i]), 0) / (recv - 1)) * 10) / 10 : null,
      samples,
    };
  }

  async port(hostRaw: string, port: number): Promise<{ open: boolean; ms: number | null }> {
    const host = checkHost(hostRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CoreError('INVALID_ARGUMENT', 'Port must be 1-65535');
    const t0 = Date.now();
    const open = await probePort(host, port, 3000);
    return { open, ms: open ? Date.now() - t0 : null };
  }

  // ------------------------------------------------------------------------------------ vendor data

  private async loadOui(download: boolean): Promise<Map<string, string>> {
    if (this.oui) return this.oui;
    if (!existsSync(this.d.ouiFile) && download && this.d.internet()) {
      for (const url of ['https://www.wireshark.org/download/automated/data/manuf', 'https://standards-oui.ieee.org/oui/oui.txt']) {
        try {
          const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
          if (r.ok) {
            writeFileSync(this.d.ouiFile, await r.text());
            break;
          }
        } catch {
          /* try the next mirror */
        }
      }
    }
    const map = new Map<string, string>();
    try {
      for (const line of readFileSync(this.d.ouiFile, 'utf8').split('\n')) {
        let m = line.match(/^([0-9A-F]{2}[:-][0-9A-F]{2}[:-][0-9A-F]{2})\s+(\S+)\s*(.*)$/i);
        if (m) {
          map.set(m[1].replace(/[:-]/g, '').toUpperCase(), (m[3] || m[2]).trim());
          continue;
        }
        m = line.match(/^([0-9A-F]{6})\s+\(base 16\)\s+(.*)$/i);
        if (m) map.set(m[1].toUpperCase(), m[2].trim());
      }
    } catch {
      /* no vendor database yet */
    }
    if (map.size) this.oui = map;
    return map;
  }

  private vendorOf(mac: string | null): string | null {
    if (!mac) return null;
    const hex = mac.replace(/[^0-9a-f]/gi, '').toUpperCase();
    if (hex.length < 6) return null;
    if ([2, 6, 10, 14].includes(parseInt(hex[1], 16))) return 'Private (randomized) MAC';
    return this.oui?.get(hex.slice(0, 6)) ?? null;
  }

  private async arpTable(): Promise<Map<string, string>> {
    const r = IS_WIN ? await exec('arp', ['-a']) : await exec('ip', ['neigh']);
    const map = new Map<string, string>();
    for (const line of r.out.split('\n')) {
      const ip = line.match(IPV4)?.[1];
      const mac = line.match(/([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i)?.[0];
      if (!ip || !mac) continue;
      const m = mac.toLowerCase().replace(/-/g, ':');
      if (m === 'ff:ff:ff:ff:ff:ff' || m.startsWith('01:00:5e') || /^(22[4-9]|23\d|255)\./.test(ip) || ip.endsWith('.255')) continue;
      map.set(ip, m);
    }
    return map;
  }

  private async ipInfo(ip: string) {
    if (this.ipInfoCache.has(ip)) return this.ipInfoCache.get(ip)!;
    if (!this.d.internet()) return null;
    try {
      const j: any = await (await fetch(`https://ipinfo.io/${ip}/json`, { signal: AbortSignal.timeout(4000) })).json();
      const v = { org: j.org ?? null, location: [j.city, j.region, j.country].filter(Boolean).join(', ') || null, name: j.hostname ?? null };
      this.ipInfoCache.set(ip, v);
      return v;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------------------------- traceroute

  async traceroute(targetRaw: string, reqId: string): Promise<{ target: string; hops: TraceHop[] }> {
    const target = checkHost(targetRaw);
    const ctx = await this.localIp();
    let targetIp = target;
    if (!validIp(target)) {
      try {
        targetIp = (await dns.promises.lookup(target, { family: 4 })).address;
      } catch (e) {
        throw new CoreError('NOT_FOUND', `Cannot resolve ${target}: ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
      }
    }
    await this.loadOui(false);
    const hops: TraceHop[] = [];
    const role = (ip: string | null, idx: number): TraceHop['role'] => {
      if (!ip) return 'timeout';
      if (ip === targetIp) return 'target';
      if (idx === 0 && (ip === ctx.gateway || isPrivate(ip))) return 'gateway';
      if (isPrivate(ip)) return 'router';
      if (isCgnat(ip)) return 'isp';
      return idx <= 3 ? 'isp' : 'internet';
    };
    const onLine = (line: string) => {
      const m = line.match(/^\s*(\d{1,2})\s+(.*)$/);
      if (!m) return;
      const n = Number(m[1]);
      if (n < 1 || n > 64) return;
      const ip = m[2].match(IPV4)?.[1] ?? null;
      const timesPart = ip ? m[2].slice(0, m[2].indexOf(ip)) : m[2];
      const rtts = [...timesPart.matchAll(/(<?\s?\d+(?:\.\d+)?)\s*ms|\*/g)].map((x) => (x[0] === '*' ? null : parseFloat(x[1].replace('<', '').trim()) || 0.5)).slice(0, 3);
      if (!rtts.length && !ip) return;
      const ok = rtts.filter((x): x is number => x != null);
      const hop: TraceHop = { hop: n, ip, name: null, avg: ok.length ? Math.round((ok.reduce((a, b) => a + b, 0) / ok.length) * 10) / 10 : null, role: role(ip, hops.length), vendor: null, org: null, location: null };
      hops.push(hop);
      this.emit({ reqId, type: 'hop', hop });
    };
    if (IS_WIN) await exec('tracert', ['-d', '-h', '30', '-w', '900', targetIp], { timeoutMs: 30 * 9000, onLine });
    else {
      const r = await exec('traceroute', ['-n', '-q', '3', '-w', '1', '-m', '30', targetIp], { timeoutMs: 30 * 6000, onLine });
      if (r.code !== 0 && !hops.length) {
        const p = await this.ping(targetIp, 3);
        if (p.received) {
          const hop: TraceHop = { hop: 1, ip: targetIp, name: null, avg: p.avg, role: 'target', vendor: null, org: null, location: null };
          hops.push(hop);
          this.emit({ reqId, type: 'hop', hop });
        }
      }
    }
    const arp = await this.arpTable();
    await Promise.all(
      hops.map(async (h) => {
        if (!h.ip) return;
        h.name = await reverse(h.ip);
        if (isPrivate(h.ip)) h.vendor = this.vendorOf(arp.get(h.ip) ?? null);
        else if (!isCgnat(h.ip)) {
          const inf = await this.ipInfo(h.ip);
          if (inf) {
            h.org = inf.org;
            h.location = inf.location;
            h.name ??= inf.name;
          }
        }
      }),
    );
    this.emit({ reqId, type: 'done' });
    return { target, hops };
  }

  // -------------------------------------------------------------------------------------- discovery

  private ssdp(ms = 3500): Promise<Map<string, { friendlyName?: string; manufacturer?: string; model?: string }>> {
    return new Promise((resolve) => {
      const found = new Map<string, { location?: string; friendlyName?: string; manufacturer?: string; model?: string }>();
      let sock: dgram.Socket;
      try {
        sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      } catch {
        resolve(found);
        return;
      }
      sock.on('message', (msg, rinfo) => {
        const loc = msg.toString().match(/^location:\s*(.+)$/im)?.[1]?.trim();
        const e = found.get(rinfo.address) ?? {};
        if (loc) e.location = loc;
        found.set(rinfo.address, e);
      });
      sock.on('error', () => undefined);
      sock.bind(0, () => {
        const q = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n');
        try {
          sock.send(q, 1900, '239.255.255.250');
          setTimeout(() => sock.send(q, 1900, '239.255.255.250'), 600);
        } catch {
          /* no multicast */
        }
      });
      setTimeout(async () => {
        try {
          sock.close();
        } catch {
          /* closed */
        }
        await Promise.all(
          [...found.entries()].map(async ([ip, e]) => {
            // Only fetch descriptions from the device that answered (no redirects elsewhere).
            if (!e.location) return;
            try {
              const u = new URL(e.location);
              if (u.hostname !== ip || !/^https?:$/.test(u.protocol)) return;
              const x = await (await fetch(u, { signal: AbortSignal.timeout(2000), redirect: 'error' })).text();
              const tag = (t: string) => x.match(new RegExp(`<${t}>([^<]*)</${t}>`, 'i'))?.[1]?.trim();
              Object.assign(e, { friendlyName: tag('friendlyName'), manufacturer: tag('manufacturer'), model: tag('modelName') });
            } catch {
              /* ignore */
            }
          }),
        );
        resolve(found);
      }, ms);
    });
  }

  private mdns(ms = 3500): Promise<Map<string, { names: Set<string>; services: Set<string>; host: string; model?: string }>> {
    return new Promise((resolve) => {
      let m: ReturnType<typeof mdnsFactory>;
      try {
        m = mdnsFactory();
      } catch {
        resolve(new Map());
        return;
      }
      const A = new Map<string, string>();
      const SRV = new Map<string, { target: string }>();
      const PTR: Array<{ service: string; instance: string }> = [];
      const TXT = new Map<string, string>();
      m.on('response', (res: any) => {
        for (const r of [...(res.answers ?? []), ...(res.additionals ?? [])]) {
          if (r.type === 'A') A.set(r.name, r.data);
          else if (r.type === 'SRV') SRV.set(r.name, r.data);
          else if (r.type === 'PTR' && r.name !== '_services._dns-sd._udp.local') PTR.push({ service: r.name, instance: r.data });
          else if (r.type === 'TXT') TXT.set(r.name, arr<Buffer>(r.data).map((b) => b.toString()).join(' '));
        }
      });
      m.on('error', () => undefined);
      const query = () => {
        try {
          m.query(MDNS_SERVICES.map((name) => ({ name, type: 'PTR' as const })));
        } catch {
          /* ignore */
        }
      };
      query();
      setTimeout(query, 900);
      setTimeout(() => {
        try {
          m.destroy();
        } catch {
          /* ignore */
        }
        const byIp = new Map<string, { names: Set<string>; services: Set<string>; host: string; model?: string }>();
        for (const { service, instance } of PTR) {
          const srv = SRV.get(instance);
          const ip = srv ? A.get(srv.target) : undefined;
          if (!ip || !srv) continue;
          const e = byIp.get(ip) ?? { names: new Set<string>(), services: new Set<string>(), host: srv.target.replace(/\.local$/, '') };
          e.names.add(instance.split('._')[0].replace(/\\032/g, ' '));
          e.services.add(service.replace(/\._(tcp|udp)\.local$/, '').replace(/^_/, ''));
          const md = TXT.get(instance)?.match(/(?:^|\s)(?:ty|md|model)=([^\s][^=]*?)(?=\s\w+=|$)/);
          if (md) e.model = md[1];
          byIp.set(ip, e);
        }
        resolve(byIp);
      }, ms);
    });
  }

  private classify(d: { ip: string; ports: number[]; services: string[]; vendor: string | null; name: string | null; friendly: string | null; model: string | null }, ctx: { ip: string | null; gateway: string | null }): [string, string] {
    const p = new Set(d.ports);
    const s = new Set(d.services);
    const v = (d.vendor ?? '').toLowerCase();
    const n = `${d.name ?? ''} ${d.friendly ?? ''} ${d.model ?? ''}`.toLowerCase();
    if (d.ip === ctx.gateway) return ['router', 'Router / gateway'];
    if (d.ip === ctx.ip) return ['this', 'This computer'];
    if (p.has(9100) || p.has(631) || p.has(515) || s.has('ipp') || s.has('ipps') || s.has('printer') || s.has('pdl-datastream') || /printer|laserjet|officejet|epson|brother|canon|xerox|lexmark|kyocera|ricoh/.test(n + v)) return ['printer', 'Printer'];
    if (s.has('googlecast') || p.has(8009) || /chromecast|google|nest/.test(n)) return ['cast', 'Chromecast / Google device'];
    if (s.has('airplay') || s.has('raop') || /apple ?tv|homepod/.test(n)) return ['media', 'AirPlay device'];
    if (p.has(62078) || s.has('companion-link') || /iphone|ipad/.test(n)) return ['phone', 'iPhone / iPad'];
    if (s.has('sonos') || /sonos/.test(v + n)) return ['media', 'Sonos speaker'];
    if (/roku|samsung|lg electronics|vizio|sony|hisense|tcl/.test(v) && (p.has(8080) || p.has(7000) || d.friendly)) return ['tv', 'Smart TV / streaming device'];
    if (s.has('hap') || p.has(1883) || /espressif|tuya|shelly|philips lighting|signify|ring|wyze|ecobee/.test(v + n)) return ['iot', 'Smart-home / IoT device'];
    if (s.has('fbrx')) return ['pc', 'FBRX OS computer'];
    if (p.has(554)) return ['camera', 'IP camera / recorder'];
    if (p.has(3389) || (p.has(445) && !p.has(22))) return ['pc', 'Windows PC'];
    if (p.has(548) || /apple/.test(v)) return ['mac', 'Apple device'];
    if (p.has(5000) && /synology|qnap|western digital/.test(v + n)) return ['nas', 'NAS storage'];
    if (p.has(22)) return ['server', 'Linux / server'];
    if (/private/.test(v)) return ['phone', 'Phone or tablet (private MAC)'];
    if (/ubiquiti|netgear|tp-link|asus|linksys|eero|cisco|aruba|mikrotik|arris|technicolor|sagemcom/.test(v)) return ['network', 'Network equipment'];
    return ['unknown', 'Unknown device'];
  }

  /** Discovers devices on the local network and stores the scan. */
  async scan(reqId: string, subnet?: string, label?: string): Promise<LanScan> {
    const t0 = Date.now();
    const ctx = await this.localIp();
    if (!ctx.ip && !subnet) throw new CoreError('UNAVAILABLE', 'No active IPv4 network connection');
    const progress = (phase: string, done: number, total: number) => this.emit({ reqId, type: 'progress', phase, done, total });
    progress('Loading the vendor database', 0, 100);
    await this.loadOui(true);
    const range = cidrHosts(subnet || `${ctx.ip}/${Math.max(22, Math.min(30, maskToPrefix(ctx.mask) || 24))}`);
    const inRange = new Set(range.hosts);
    const targets = [...range.hosts];
    const discovery = Promise.all([this.mdns(4000), this.ssdp(3500)]);
    const alive = new Set<string>();
    let swept = 0;
    const worker = async () => {
      while (targets.length) {
        const ip = targets.shift()!;
        const r = await exec('ping', IS_WIN ? ['-n', '1', '-w', '450', ip] : ['-c', '1', '-W', '1', ip], { timeoutMs: 3000 });
        if (/ttl/i.test(r.out)) alive.add(ip);
        swept++;
        if (swept % 12 === 0) progress(`Sweeping ${range.label}`, swept, range.hosts.length);
      }
    };
    await Promise.all(Array.from({ length: 48 }, worker));
    progress('Reading the ARP table and listening for mDNS / UPnP', swept, range.hosts.length);
    const [arpMap, [mdns, ssdp]] = await Promise.all([this.arpTable(), discovery]);
    for (const ip of [...arpMap.keys(), ...mdns.keys(), ...ssdp.keys()]) if (inRange.has(ip)) alive.add(ip);
    if (ctx.ip && inRange.has(ctx.ip)) alive.add(ctx.ip);
    const ips = [...alive].sort((a, b) => ipNum(a) - ipNum(b));
    const devices: LanDevice[] = [];
    const queue = [...ips];
    let fp = 0;
    const fpWorker = async () => {
      while (queue.length) {
        const ip = queue.shift()!;
        const ports: number[] = [];
        const t = Date.now();
        await Promise.all(
          FINGERPRINT_PORTS.map(async (p) => {
            if (await probePort(ip, p, 400)) ports.push(p);
          }),
        );
        const mac = ip === ctx.ip ? ctx.mac || null : (arpMap.get(ip) ?? null);
        const md = mdns.get(ip);
        const sd = ssdp.get(ip);
        let vendor = this.vendorOf(mac);
        if (!vendor && sd?.manufacturer) vendor = sd.manufacturer;
        const name = (await reverse(ip, 1200)) ?? md?.host ?? null;
        const friendly = sd?.friendlyName ?? (md ? [...md.names][0] : null) ?? null;
        const base = { ip, ports: ports.sort((a, b) => a - b), services: md ? [...md.services] : [], vendor, name, friendly, model: sd?.model ?? md?.model ?? null };
        const [type, typeLabel] = this.classify(base, ctx);
        devices.push({
          ip,
          mac,
          vendor,
          name: friendly ?? name,
          type,
          typeLabel,
          ports: base.ports,
          services: base.services,
          latencyMs: ports.length ? Date.now() - t : null,
          isGateway: ip === ctx.gateway,
          isSelf: ip === ctx.ip,
        });
        fp++;
        progress(`Identifying devices (${fp}/${ips.length})`, fp, ips.length);
      }
    };
    await Promise.all(Array.from({ length: 12 }, fpWorker));
    devices.sort((a, b) => ipNum(a.ip) - ipNum(b.ip));
    const result: LanScan = { id: newId('scan'), subnet: range.label, label: label?.trim().slice(0, 80) || range.label, scannedAt: new Date().toISOString(), durationMs: Date.now() - t0, devices };
    this.d.db.run('INSERT INTO net_scans (id, subnet, label, scanned_at, duration_ms, devices) VALUES (?, ?, ?, ?, ?, ?)', result.id, result.subnet, result.label, result.scannedAt, result.durationMs, JSON.stringify(devices));
    this.d.db.run('DELETE FROM net_scans WHERE id NOT IN (SELECT id FROM net_scans ORDER BY scanned_at DESC LIMIT 50)');
    this.emit({ reqId, type: 'done' });
    return result;
  }

  scans(): Array<Omit<LanScan, 'devices'> & { count: number }> {
    return this.d.db
      .all<any>('SELECT id, subnet, label, scanned_at, duration_ms, json_array_length(devices) AS count FROM net_scans ORDER BY scanned_at DESC')
      .map((r) => ({ id: r.id, subnet: r.subnet, label: r.label, scannedAt: r.scanned_at, durationMs: r.duration_ms, count: r.count }));
  }

  getScan(id: string): LanScan {
    const r = this.d.db.get<any>('SELECT * FROM net_scans WHERE id = ?', id);
    if (!r) throw new CoreError('NOT_FOUND', 'Scan not found');
    return { id: r.id, subnet: r.subnet, label: r.label, scannedAt: r.scanned_at, durationMs: r.duration_ms, devices: JSON.parse(r.devices) };
  }

  deleteScan(id: string): boolean {
    return this.d.db.run('DELETE FROM net_scans WHERE id = ?', id).changes > 0;
  }

  /** MAC addresses seen in any earlier scan (to flag new devices). */
  knownMacs(exceptId?: string): Set<string> {
    const out = new Set<string>();
    for (const r of this.d.db.all<{ devices: string }>('SELECT devices FROM net_scans WHERE id != ?', exceptId ?? '')) {
      for (const d of JSON.parse(r.devices) as LanDevice[]) if (d.mac) out.add(d.mac.toLowerCase());
    }
    return out;
  }

  compare(aId: string, bId: string): LanScanCompare {
    const a = this.getScan(aId);
    const b = this.getScan(bId);
    const key = (d: LanDevice) => d.mac?.toLowerCase() ?? `ip:${d.ip}`;
    const before = new Map(a.devices.map((d) => [key(d), d]));
    const after = new Map(b.devices.map((d) => [key(d), d]));
    const added = b.devices.filter((d) => !before.has(key(d)));
    const removed = a.devices.filter((d) => !after.has(key(d)));
    const changed: LanScanCompare['changed'] = [];
    let unchanged = 0;
    for (const d of b.devices) {
      const old = before.get(key(d));
      if (!old) continue;
      const diffs: string[] = [];
      if (old.ip !== d.ip) diffs.push(`IP ${old.ip} → ${d.ip}`);
      if ((old.name ?? '') !== (d.name ?? '')) diffs.push(`name ${old.name ?? '—'} → ${d.name ?? '—'}`);
      const op = old.ports.join(',');
      const np = d.ports.join(',');
      if (op !== np) diffs.push(`open ports ${op || 'none'} → ${np || 'none'}`);
      if (diffs.length) changed.push({ device: d, diffs });
      else unchanged++;
    }
    return { added, removed, changed, unchanged };
  }

  exportCsv(id: string, path: string): { path: string; rows: number } {
    const s = this.getScan(id);
    const cell = (v: unknown) => {
      const t = String(v ?? '');
      // Neutralize spreadsheet formulas and quote everything.
      return `"${(/^[=+\-@]/.test(t) ? `'${t}` : t).replace(/"/g, '""')}"`;
    };
    const rows = [['IP', 'MAC', 'Vendor', 'Name', 'Type', 'Open ports', 'Services', 'Gateway', 'This computer'].map(cell).join(',')];
    for (const d of s.devices) rows.push([d.ip, d.mac, d.vendor, d.name, d.typeLabel, d.ports.join(' '), d.services.join(' '), d.isGateway ? 'yes' : '', d.isSelf ? 'yes' : ''].map(cell).join(','));
    writeFileSync(path, `${rows.join('\r\n')}\r\n`, 'utf8');
    return { path, rows: s.devices.length };
  }

  // ------------------------------------------------------------------------------------- speed test

  async speedTest(reqId: string, durationMs = 8000): Promise<SpeedTestResult> {
    if (!this.d.internet()) throw new CoreError('POLICY_DENIED', 'Internet access is blocked by policy');
    const BASE = 'https://speed.cloudflare.com';
    let meta: any = {};
    try {
      meta = await (await fetch(`${BASE}/meta`, { signal: AbortSignal.timeout(5000) })).json();
    } catch {
      /* optional */
    }
    this.emit({ reqId, type: 'speed', phase: 'latency' });
    const lat: number[] = [];
    for (let i = 0; i < 12; i++) {
      const t0 = performance.now();
      try {
        const r = await fetch(`${BASE}/__down?bytes=0&r=${Math.random()}`, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
        await r.arrayBuffer();
        lat.push(performance.now() - t0);
      } catch {
        /* skip */
      }
    }
    lat.sort((a, b) => a - b);
    const latency = lat.length ? Math.round(lat[Math.floor(lat.length / 2)]) : null;
    const jitter = lat.length > 1 ? Math.round(lat.slice(1).reduce((a, t, i) => a + Math.abs(t - lat[i]), 0) / (lat.length - 1)) : null;
    const measure = async (kind: 'download' | 'upload') => {
      let bytes = 0;
      const start = performance.now();
      let stop = false;
      const ctrls: AbortController[] = [];
      const tick = setInterval(() => this.emit({ reqId, type: 'speed', phase: kind, mbps: Math.round(((bytes * 8) / ((performance.now() - start) / 1000) / 1e6) * 10) / 10 }), 300);
      const chunk = Buffer.alloc(2 * 1024 * 1024, 0x61);
      const work = async () => {
        while (!stop) {
          const c = new AbortController();
          ctrls.push(c);
          try {
            if (kind === 'download') {
              const r = await fetch(`${BASE}/__down?bytes=25000000&r=${Math.random()}`, { cache: 'no-store', signal: c.signal });
              const reader = r.body!.getReader();
              for (;;) {
                const { value, done } = await reader.read();
                if (done || stop) break;
                bytes += value.length;
              }
              await reader.cancel().catch(() => undefined);
            } else {
              const r = await fetch(`${BASE}/__up?r=${Math.random()}`, { method: 'POST', body: chunk, signal: c.signal, headers: { 'Content-Type': 'application/octet-stream' } });
              await r.arrayBuffer();
              if (!stop) bytes += chunk.length;
            }
          } catch {
            if (!stop) await new Promise((r) => setTimeout(r, 200));
          }
        }
      };
      const workers = Array.from({ length: kind === 'download' ? 6 : 4 }, work);
      await new Promise((r) => setTimeout(r, durationMs));
      stop = true;
      for (const c of ctrls) c.abort();
      clearInterval(tick);
      await Promise.race([Promise.allSettled(workers), new Promise((r) => setTimeout(r, 1500))]);
      return Math.round(((bytes * 8) / ((performance.now() - start) / 1000) / 1e6) * 10) / 10;
    };
    const downloadMbps = await measure('download');
    const uploadMbps = await measure('upload');
    const res: SpeedTestResult = { at: new Date().toISOString(), downloadMbps, uploadMbps, latencyMs: latency, jitterMs: jitter, server: [meta.city, meta.country].filter(Boolean).join(', ') || meta.colo || 'Cloudflare' };
    this.d.db.run('INSERT INTO speed_tests (at, download, upload, latency, jitter, server) VALUES (?, ?, ?, ?, ?, ?)', res.at, downloadMbps, uploadMbps, latency, jitter, res.server);
    this.d.db.run('DELETE FROM speed_tests WHERE at NOT IN (SELECT at FROM speed_tests ORDER BY at DESC LIMIT 200)');
    this.emit({ reqId, type: 'done' });
    return res;
  }

  speedHistory(): SpeedTestResult[] {
    return this.d.db
      .all<any>('SELECT * FROM speed_tests ORDER BY at DESC LIMIT 50')
      .map((r) => ({ at: r.at, downloadMbps: r.download, uploadMbps: r.upload, latencyMs: r.latency, jitterMs: r.jitter, server: r.server }));
  }

  // ------------------------------------------------------------------------------- wireless & devices

  async wifi(): Promise<WifiInfo> {
    const [conns, nets] = await Promise.all([si.wifiConnections().catch(() => []), si.wifiNetworks().catch(() => [])]);
    const band = (f: number | null | undefined) => (!f ? '' : f >= 5900 ? '6 GHz' : f >= 4900 ? '5 GHz' : '2.4 GHz');
    let details: Record<string, string> = {};
    if (IS_WIN) {
      const r = await exec('netsh', ['wlan', 'show', 'interfaces']);
      for (const line of r.out.split('\n')) {
        const m = line.match(/^\s*([^:]+?)\s*:\s(.*)$/);
        if (m) details[m[1].trim()] = m[2].trim();
      }
    }
    const c = conns[0];
    const channels: Record<string, number> = {};
    for (const n of nets) if (n.channel) channels[String(n.channel)] = (channels[String(n.channel)] ?? 0) + 1;
    return {
      connection: c
        ? {
            ssid: c.ssid,
            signalPct: c.quality ?? Number(String(details.Signal ?? '').replace('%', '')) ?? 0,
            channel: c.channel ?? null,
            band: band(c.frequency) || details.Band || '',
            rxMbps: Number(details['Receive rate (Mbps)']) || c.txRate || null,
            txMbps: Number(details['Transmit rate (Mbps)']) || c.txRate || null,
            security: c.security ?? details.Authentication ?? '',
          }
        : null,
      networks: nets
        .filter((n) => n.ssid)
        .sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0))
        .slice(0, 60)
        .map((n) => ({ ssid: n.ssid, signalPct: n.quality ?? 0, channel: n.channel ?? null, band: band(n.frequency), security: arr(n.security).join(', ') })),
      channels,
    };
  }

  async bluetooth(): Promise<{ adapters: string[]; devices: BluetoothDevice[] }> {
    if (!IS_WIN) {
      const list = await si.bluetoothDevices().catch(() => []);
      return { adapters: [], devices: list.map((d) => ({ name: d.name, connected: d.connected, kind: d.type, battery: d.batteryPercent ?? null })) };
    }
    const r = await ps(
      `$all = Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue
$adapters = @($all | Where-Object { $_.InstanceId -match '^(USB|PCI|ACPI)\\\\' } | ForEach-Object { [string]$_.FriendlyName })
$devs = @($all | Where-Object { $_.InstanceId -match '^(BTHENUM\\\\DEV_|BTHLE\\\\DEV_)' } | ForEach-Object {
  $id = $_.InstanceId; $c = $null; $b = $null
  try { $c = (Get-PnpDeviceProperty -InstanceId $id -KeyName '{83DA6326-97A6-4088-9453-A1923F573B29} 15' -ErrorAction Stop).Data } catch {}
  try { $b = (Get-PnpDeviceProperty -InstanceId $id -KeyName '{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2' -ErrorAction Stop).Data } catch {}
  [pscustomobject]@{ name=[string]$_.FriendlyName; connected=[bool]$c; battery=$b; le=($id -like 'BTHLE*'); key=$(if ($id -match 'DEV_([0-9A-F]{12})') { $matches[1] } else { $id }) }
})
[pscustomobject]@{ adapters=$adapters; devices=$devs } | ConvertTo-Json -Depth 4 -Compress`,
      45_000,
    );
    let j: any;
    try {
      j = JSON.parse(r.out.trim());
    } catch {
      throw new CoreError('INTERNAL', (r.err || 'Could not read Bluetooth devices').slice(0, 300));
    }
    const seen = new Map<string, any>();
    for (const d of arr<any>(j.devices)) {
      const prev = seen.get(d.key);
      if (!prev || d.connected) seen.set(d.key, d);
    }
    return {
      adapters: arr<string>(j.adapters),
      devices: [...seen.values()].filter((d) => d.name).map((d) => ({ name: d.name, connected: !!d.connected, kind: d.le ? 'Bluetooth LE' : 'Bluetooth', battery: typeof d.battery === 'number' ? d.battery : null })),
    };
  }

  async printers(): Promise<PrinterInfo[]> {
    if (!IS_WIN) return [];
    const list = await psJson(
      `$ports = @{}; Get-PrinterPort -ErrorAction SilentlyContinue | ForEach-Object { $ports[$_.Name] = $_.PrinterHostAddress }
$def = (Get-CimInstance Win32_Printer -Filter 'Default=True' -ErrorAction SilentlyContinue).Name
@(Get-Printer -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ name=$_.Name; driver=$_.DriverName; port=$_.PortName; host=$ports[$_.PortName]; status=[string]$_.PrinterStatus; shared=$_.Shared; isDefault=($_.Name -eq $def); jobs=@(Get-PrintJob -PrinterName $_.Name -ErrorAction SilentlyContinue).Count } })`,
      45_000,
    );
    return list.map((p) => ({
      name: p.name,
      status: p.status,
      isDefault: !!p.isDefault,
      port: p.port ?? '',
      ip: p.host || String(p.port ?? '').match(IPV4)?.[1] || null,
      jobs: p.jobs ?? 0,
      driver: p.driver ?? '',
      shared: !!p.shared,
    }));
  }

  async printerAction(name: string, action: string): Promise<void> {
    requireWindows('Printer tools');
    if (!(PRINTER_ACTIONS as readonly string[]).includes(action)) throw new CoreError('INVALID_ARGUMENT', 'Unknown printer action');
    if (action !== 'spooler' && !name.trim()) throw new CoreError('INVALID_ARGUMENT', 'Choose a printer');
    const n = psq(name);
    switch (action) {
      case 'test':
        await ps(`$p=Get-CimInstance Win32_Printer | Where-Object { $_.Name -eq ${n} }; if (-not $p) { throw 'Printer not found' }; Invoke-CimMethod -InputObject $p -MethodName PrintTestPage | Out-Null`, 30_000);
        return;
      case 'queue':
        spawn('rundll32.exe', ['printui.dll,PrintUIEntry', '/o', '/n', name], { detached: true, stdio: 'ignore' }).unref();
        return;
      case 'props':
        spawn('rundll32.exe', ['printui.dll,PrintUIEntry', '/p', '/n', name], { detached: true, stdio: 'ignore' }).unref();
        return;
      case 'default':
        await ps(`$p=Get-CimInstance Win32_Printer | Where-Object { $_.Name -eq ${n} }; if (-not $p) { throw 'Printer not found' }; Invoke-CimMethod -InputObject $p -MethodName SetDefaultPrinter | Out-Null`, 30_000);
        return;
      case 'clear':
        await ps(`Get-PrintJob -PrinterName ${n} -ErrorAction SilentlyContinue | Remove-PrintJob`, 30_000);
        return;
      case 'spooler':
        await elevated("Restart-Service Spooler -Force; 'Print spooler restarted.'");
        return;
    }
  }

  async dnsTest(nameRaw: string): Promise<DnsTest> {
    const name = checkHost(nameRaw);
    let addresses: string[] = [];
    try {
      addresses = (await dns.promises.lookup(name, { all: true })).map((a) => a.address);
    } catch {
      /* reported per resolver */
    }
    const resolvers: DnsTest['resolvers'] = [];
    const sys = dns.getServers();
    const list: Array<[string, string[]]> = [['System', sys]];
    if (this.d.internet()) list.push(['Cloudflare', ['1.1.1.1']], ['Google', ['8.8.8.8']], ['Quad9', ['9.9.9.9']]);
    for (const [label, servers] of list) {
      const r = new dns.promises.Resolver({ timeout: 3000, tries: 1 });
      try {
        r.setServers(servers);
      } catch {
        continue;
      }
      const t0 = performance.now();
      try {
        await r.resolve4(name);
        resolvers.push({ name: label, ip: servers.join(', '), ms: Math.round(performance.now() - t0), ok: true });
      } catch {
        resolvers.push({ name: label, ip: servers.join(', '), ms: null, ok: false });
      }
    }
    return { name, addresses, resolvers };
  }

  // ---------------------------------------------------------------------------------------- adapters

  async adapters(): Promise<NetAdapter[]> {
    if (!IS_WIN) {
      const ifs = await si.networkInterfaces().catch(() => []);
      const gw = await si.networkGatewayDefault().catch(() => '');
      return (Array.isArray(ifs) ? ifs : [ifs])
        .filter((i) => !i.internal)
        .map((i) => ({ alias: i.iface, description: i.ifaceName, status: i.operstate === 'up' ? 'Up' : 'Down', mac: i.mac, speed: i.speed ? `${i.speed} Mbps` : '', dhcp: i.dhcp, ipv4: i.ip4 ? [{ ip: i.ip4, prefix: maskToPrefix(i.ip4subnet) }] : [], gateway: gw || null, dns: [] }));
    }
    const r = await psJson(
      "Get-NetAdapter | Where-Object { $_.Status -ne 'Not Present' } | ForEach-Object { $a=$_; $ipi=Get-NetIPInterface -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue; $ips=@(Get-NetIPAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ ip=$_.IPAddress; prefix=$_.PrefixLength } }); $gw=(Get-NetRoute -InterfaceIndex $a.ifIndex -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Select-Object -First 1).NextHop; $dns=@((Get-DnsClientServerAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue).ServerAddresses); [pscustomobject]@{ alias=$a.Name; description=$a.InterfaceDescription; status=[string]$a.Status; mac=$a.MacAddress; speed=$a.LinkSpeed; dhcp=([string]$ipi.Dhcp -eq 'Enabled'); ipv4=$ips; gateway=$gw; dns=$dns } }",
      40_000,
    );
    return r.map((a) => ({ ...a, ipv4: arr(a.ipv4), dns: arr(a.dns), gateway: a.gateway || null }));
  }

  setIp(p: { alias: string; mode: 'dhcp' | 'static' | 'secondary' | 'removeSecondary'; ip?: string; prefix?: number | string; gateway?: string; dns?: string[] }): Promise<ElevatedResult> {
    requireWindows('Adapter settings');
    const a = psq(p.alias);
    if (p.mode === 'dhcp') {
      return elevated(
        `Set-NetIPInterface -InterfaceAlias ${a} -Dhcp Enabled; Get-NetRoute -InterfaceAlias ${a} -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Remove-NetRoute -Confirm:$false; Set-DnsClientServerAddress -InterfaceAlias ${a} -ResetServerAddresses; ipconfig /renew ${a} | Out-Null; Start-Sleep 3; Get-NetIPConfiguration -InterfaceAlias ${a} | Format-List InterfaceAlias,IPv4Address,IPv4DefaultGateway,DNSServer`,
      );
    }
    if (!validIp(p.ip)) throw new CoreError('INVALID_ARGUMENT', 'Enter a valid IPv4 address');
    if (p.mode === 'removeSecondary') return elevated(`Remove-NetIPAddress -InterfaceAlias ${a} -IPAddress ${psq(p.ip)} -Confirm:$false; 'Removed ${p.ip}'`);
    const prefix = /\./.test(String(p.prefix)) ? maskToPrefix(String(p.prefix)) : Number(p.prefix);
    if (!(prefix >= 8 && prefix <= 30)) throw new CoreError('INVALID_ARGUMENT', 'Prefix must be between /8 and /30 (for example 24 or 255.255.255.0)');
    if (p.gateway && !validIp(p.gateway)) throw new CoreError('INVALID_ARGUMENT', 'Invalid gateway');
    const dnsList = (p.dns ?? []).filter(validIp);
    if (p.mode === 'secondary') {
      return elevated(
        `New-NetIPAddress -InterfaceAlias ${a} -IPAddress ${psq(p.ip)} -PrefixLength ${prefix} -SkipAsSource $true | Out-Null; "Added secondary address ${p.ip}/${prefix}. Your existing connection is unchanged."; Get-NetIPAddress -InterfaceAlias ${a} -AddressFamily IPv4 | Format-Table IPAddress,PrefixLength,PrefixOrigin`,
      );
    }
    return elevated(`Set-NetIPInterface -InterfaceAlias ${a} -Dhcp Disabled
Get-NetIPAddress -InterfaceAlias ${a} -AddressFamily IPv4 -ErrorAction SilentlyContinue | Remove-NetIPAddress -Confirm:$false
Get-NetRoute -InterfaceAlias ${a} -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Remove-NetRoute -Confirm:$false
New-NetIPAddress -InterfaceAlias ${a} -IPAddress ${psq(p.ip)} -PrefixLength ${prefix} ${p.gateway ? `-DefaultGateway ${psq(p.gateway)}` : ''} | Out-Null
${dnsList.length ? `Set-DnsClientServerAddress -InterfaceAlias ${a} -ServerAddresses ${dnsList.map(psq).join(',')}` : ''}
Get-NetIPConfiguration -InterfaceAlias ${a} | Format-List InterfaceAlias,IPv4Address,IPv4DefaultGateway,DNSServer`);
  }

  /** Opens an SSH session to a host in Windows Terminal (or a console window). */
  ssh(hostRaw: string, user?: string, port?: number): void {
    requireWindows('SSH');
    const host = checkHost(hostRaw);
    if (user && !/^[\w.-]{1,64}$/.test(user)) throw new CoreError('INVALID_ARGUMENT', 'Invalid user name');
    const p = port ?? 22;
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new CoreError('INVALID_ARGUMENT', 'Invalid port');
    const target = user ? `${user}@${host}` : host;
    const child = spawn('wt.exe', ['ssh', '-p', String(p), target], { detached: true, stdio: 'ignore' });
    child.on('error', () => spawn('cmd.exe', ['/c', 'start', '""', 'ssh', '-p', String(p), target], { detached: true, stdio: 'ignore' }).unref());
    child.unref();
  }
}
