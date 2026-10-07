import { inCidr, isPrivateIP } from '@fbrx/shared';
import { DOME_SEVERITIES } from './types';
import { baseDomain, looksRandom, normalizeName, parentDomains, under } from './domains';
import type { DomeEvent, DomeSignal } from './types';

/** What the detectors need to know about the gate and the settings. */
export interface DetectContext {
  /** The gate's own addresses (in its networks and on the internet side). */
  gateAddresses: Set<string>;
  /** The gate's networks, to tell inside from outside. */
  networks: Array<{ name: string; cidr: string }>;
  /** Threat list (domains; their subdomains count too). */
  feed: Set<string>;
  /** Names the gate blocks anyway (asked for, but no answer given). */
  blocked: Set<string>;
  allow: Set<string>;
  sensitivity: 'low' | 'normal' | 'high';
  /** FBRX Mesh's port: computers keep in touch on it at regular intervals, by design. */
  meshPort: number;
  /** The hardware address the gate gave an address to (DHCP), if it did. */
  leaseMac: (ip: string) => string | null;
}

/** Names with lots of made-up-looking subdomains by design: not tunnels. */
const NOISY_OK = new Set(['arpa', 'amazonaws.com', 'cloudfront.net', 'akamaiedge.net', 'akamaihd.net', 'akadns.net', 'edgekey.net', 'fastly.net', 'googlevideo.com', 'gvt1.com', 'azureedge.net', 'trafficmanager.net', 'windows.net', 'spotify.com', 'local', 'lan', 'home.arpa']);

const MINUTE = 60_000;
const FACTOR = { low: 1.6, normal: 1, high: 0.6 } as const;

interface DnsSeen {
  at: number;
  name: string;
}

/**
 * The detectors: each event goes past all of them; what looks wrong comes back as signals. They keep short
 * windows of what they saw (minutes), nothing more. Each kind of signal speaks up at most every half minute per
 * device and subject, so a busy device does not flood the findings.
 */
export class Detectors {
  private readonly randomNames = new Map<string, DnsSeen[]>();
  private readonly randomNx = new Map<string, DnsSeen[]>();
  private readonly subdomains = new Map<string, DnsSeen[]>();
  private readonly textQueries = new Map<string, number[]>();
  private readonly flows = new Map<string, Array<{ at: number; dst: string; dport: number; proto: string }>>();
  private readonly beacons = new Map<string, number[]>();
  private readonly ipMac = new Map<string, { mac: string; changes: number[] }>();
  private readonly macIps = new Map<string, Map<string, number>>();
  private readonly spoken = new Map<string, { at: number; rank: number }>();

  constructor(private readonly ctx: () => DetectContext) {}

  private n(base: number): number {
    return Math.max(2, Math.ceil(base * FACTOR[this.ctx().sensitivity]));
  }

  private inside(ip: string): boolean {
    return this.ctx().networks.some((n) => inCidr(ip, n.cidr));
  }

  /** Remembers within the window (and at most `cap` entries). */
  private keep<T extends { at: number }>(map: Map<string, T[]>, key: string, item: T, windowMs: number, cap = 2000): T[] {
    const list = (map.get(key) ?? []).filter((x) => item.at - x.at <= windowMs);
    list.push(item);
    if (list.length > cap) list.splice(0, list.length - cap);
    map.set(key, list);
    return list;
  }

  /** Speaks up at most every half minute per key, unless it got worse. */
  private say(s: DomeSignal, at: number, out: DomeSignal[]) {
    const rank = DOME_SEVERITIES.indexOf(s.severity);
    const last = this.spoken.get(s.key);
    if (last && at - last.at < 30_000 && rank <= last.rank) return;
    this.spoken.set(s.key, { at, rank: Math.max(rank, last && at - last.at < 30_000 ? last.rank : -1) });
    out.push(s);
  }

  /** Forgets what is older than any window (the engine calls this now and then). */
  prune(now = Date.now()) {
    const drop = <T>(map: Map<string, T[]>, age: (x: T) => number, windowMs: number) => {
      for (const [k, v] of map) {
        const keep = v.filter((x) => now - age(x) <= windowMs);
        if (keep.length) map.set(k, keep);
        else map.delete(k);
      }
    };
    drop(this.randomNames, (x) => x.at, 10 * MINUTE);
    drop(this.randomNx, (x) => x.at, 10 * MINUTE);
    drop(this.subdomains, (x) => x.at, 10 * MINUTE);
    drop(this.textQueries, (t) => t, 10 * MINUTE);
    drop(this.flows, (x) => x.at, MINUTE);
    drop(this.beacons, (t) => t, 6 * 3600_000);
    for (const [k, v] of this.macIps) if ([...v.values()].every((at) => now - at > 10 * MINUTE)) this.macIps.delete(k);
    for (const [k, v] of this.spoken) if (now - v.at > 10 * MINUTE) this.spoken.delete(k);
  }

  handle(e: DomeEvent): DomeSignal[] {
    const out: DomeSignal[] = [];
    if (e.type === 'dns') this.dns(e, out);
    else if (e.type === 'nxdomain') this.nx(e, out);
    else if (e.type === 'flow') this.flow(e, out);
    else if (e.type === 'neighbor') this.neighbor(e, out);
    return out;
  }

  // ---------------------------------------------------------------------------------------------- names

  private dns(e: Extract<DomeEvent, { type: 'dns' }>, out: DomeSignal[]) {
    const c = this.ctx();
    const name = normalizeName(e.name);
    if (!name || under(name, c.allow)) return;
    const base = baseDomain(name);
    const time = new Date(e.at).toLocaleTimeString();

    // On a threat list.
    if (under(name, c.feed)) {
      const blocked = under(name, c.blocked);
      this.say(
        {
          key: `bad-domain:${e.client}:${base}`,
          kind: 'bad-domain',
          severity: blocked ? 'warning' : 'serious',
          title: `{device} asked for a known-bad name`,
          detail: `${name} is on a threat list${blocked ? '. The gate blocks it, but something on the device keeps trying: it is worth a look' : ': malware, phishing or tracking. Check the device'}.`,
          ip: e.client,
          subject: base,
          evidence: [`${time} ${e.qtype} ${name}${blocked ? ' (blocked)' : ''}`],
        },
        e.at,
        out,
      );
    }

    // Made-up names, many of them: domain generation.
    if (looksRandom(name)) {
      const list = this.keep(this.randomNames, e.client, { at: e.at, name }, 10 * MINUTE);
      const distinct = [...new Set(list.map((x) => x.name))];
      if (distinct.length >= this.n(8)) {
        this.say(
          {
            key: `dga:${e.client}`,
            kind: 'dga',
            severity: 'serious',
            title: `{device} is asking for made-up names`,
            detail: `${distinct.length} random-looking names in ten minutes. Some malware makes up names like these to find its servers.`,
            ip: e.client,
            subject: null,
            evidence: distinct.slice(-5).map((n) => `${time} ${n}`),
          },
          e.at,
          out,
        );
      }
    }

    // Data hidden in names: very long ones, or very many different ones under one domain, or many text lookups.
    if (parentDomains(name).some((d) => NOISY_OK.has(d))) return;
    const sub = name.slice(0, Math.max(0, name.length - base.length - 1));
    const longest = Math.max(0, ...name.split('.').map((l) => l.length));
    if (longest >= 50 || name.length >= 120) {
      this.say(
        {
          key: `dns-tunnel:${e.client}:${base}`,
          kind: 'dns-tunnel',
          severity: 'serious',
          title: `{device} sends data hidden in names`,
          detail: `A ${name.length}-character name under ${base}: names this long usually carry data out (a DNS tunnel), past the firewall.`,
          ip: e.client,
          subject: base,
          evidence: [`${time} ${e.qtype} ${name.slice(0, 160)}`],
        },
        e.at,
        out,
      );
    }
    if (sub) {
      const list = this.keep(this.subdomains, `${e.client}|${base}`, { at: e.at, name: sub }, 10 * MINUTE);
      const distinct = new Set(list.map((x) => x.name));
      const avg = [...distinct].reduce((n, s) => n + s.length, 0) / Math.max(1, distinct.size);
      if (distinct.size >= this.n(60) && avg >= 18) {
        this.say(
          {
            key: `dns-tunnel:${e.client}:${base}`,
            kind: 'dns-tunnel',
            severity: 'serious',
            title: `{device} sends data hidden in names`,
            detail: `${distinct.size} different long names under ${base} in ten minutes: the pattern of a DNS tunnel carrying data past the firewall.`,
            ip: e.client,
            subject: base,
            evidence: [...distinct].slice(-4).map((s) => `${time} ${s}.${base}`),
          },
          e.at,
          out,
        );
      }
    }
    if (e.qtype === 'TXT' || e.qtype === 'NULL') {
      const key = `${e.client}|${base}`;
      const times = (this.textQueries.get(key) ?? []).filter((t) => e.at - t <= 10 * MINUTE);
      times.push(e.at);
      this.textQueries.set(key, times.slice(-500));
      if (times.length >= this.n(40)) {
        this.say(
          {
            key: `dns-tunnel:${e.client}:${base}`,
            kind: 'dns-tunnel',
            severity: 'serious',
            title: `{device} sends data hidden in names`,
            detail: `${times.length} text lookups under ${base} in ten minutes: a way to move data through DNS.`,
            ip: e.client,
            subject: base,
            evidence: [`${time} ${e.qtype} ${name}`],
          },
          e.at,
          out,
        );
      }
    }
  }

  private nx(e: Extract<DomeEvent, { type: 'nxdomain' }>, out: DomeSignal[]) {
    if (!e.client || !looksRandom(e.name) || under(e.name, this.ctx().allow)) return;
    const list = this.keep(this.randomNx, e.client, { at: e.at, name: normalizeName(e.name) }, 10 * MINUTE);
    const distinct = [...new Set(list.map((x) => x.name))];
    if (distinct.length >= this.n(5)) {
      this.say(
        {
          key: `dga:${e.client}`,
          kind: 'dga',
          severity: 'serious',
          title: `{device} is asking for made-up names`,
          detail: `${distinct.length} random-looking names that do not exist, in ten minutes. Malware does this when it hunts for its servers.`,
          ip: e.client,
          subject: null,
          evidence: distinct.slice(-5).map((n) => `${new Date(e.at).toLocaleTimeString()} ${n} (no such name)`),
        },
        e.at,
        out,
      );
    }
  }

  // ---------------------------------------------------------------------------------------- connections

  private flow(e: Extract<DomeEvent, { type: 'flow' }>, out: DomeSignal[]) {
    const c = this.ctx();
    if (c.gateAddresses.has(e.src) || !/^\d+\.\d+\.\d+\.\d+$/.test(e.src)) return;
    const inside = this.inside(e.src);
    const time = new Date(e.at).toLocaleTimeString();

    // DNS around the gate: its names (and blocking, and MiniDome) are skipped.
    if (inside && (e.dport === 53 || e.dport === 853) && !c.gateAddresses.has(e.dst) && !this.inside(e.dst)) {
      this.say(
        {
          key: `dns-bypass:${e.src}:${e.dst}`,
          kind: 'dns-bypass',
          severity: 'warning',
          title: `{device} uses its own DNS server`,
          detail: `It asks ${e.dst}${e.dport === 853 ? ' over encrypted DNS (port 853)' : ''} instead of the gate, so the gate's blocking and MiniDome do not see its names. Fine for some devices; unexpected for most.`,
          ip: e.src,
          subject: `${e.dst}:${e.dport}`,
          evidence: [`${time} ${e.proto.toUpperCase()} ${e.src} → ${e.dst}:${e.dport}`],
        },
        e.at,
        out,
      );
    }

    if (!inside) return;
    // Scanning: many ports on one device, or one port on many devices of your own networks.
    const list = this.keep(this.flows, e.src, { at: e.at, dst: e.dst, dport: e.dport, proto: e.proto }, MINUTE, 5000);
    const ports = new Set(list.filter((f) => f.dst === e.dst && f.proto === 'tcp').map((f) => f.dport));
    if (ports.size >= this.n(25)) {
      this.say(
        {
          key: `port-scan:${e.src}`,
          kind: 'port-scan',
          severity: 'serious',
          title: `{device} is probing another device's ports`,
          detail: `${ports.size} different ports on ${e.dst} within a minute. Scanning tools do this; so does malware looking for a way into other devices.`,
          ip: e.src,
          subject: e.dst,
          evidence: [`${time} TCP ${e.src} → ${e.dst} ports ${[...ports].sort((a, b) => a - b).slice(0, 12).join(', ')}${ports.size > 12 ? ', …' : ''}`],
        },
        e.at,
        out,
      );
    }
    const hosts = new Set(list.filter((f) => f.dport === e.dport && this.inside(f.dst)).map((f) => f.dst));
    if (hosts.size >= this.n(30)) {
      this.say(
        {
          key: `port-scan:${e.src}`,
          kind: 'port-scan',
          severity: 'serious',
          title: `{device} is sweeping your network`,
          detail: `It tried port ${e.dport} on ${hosts.size} devices of your networks within a minute: a scan, or malware spreading.`,
          ip: e.src,
          subject: `port ${e.dport}`,
          evidence: [`${time} ${e.proto.toUpperCase()} ${e.src} → ${[...hosts].slice(0, 6).join(', ')}, … port ${e.dport}`],
        },
        e.at,
        out,
      );
    }

    // Calling home: the same place, again and again, like clockwork.
    if (isPrivateIP(e.dst) || e.dport === 53 || e.dport === 123 || e.dport === c.meshPort) return;
    const key = `${e.src}|${e.dst}|${e.dport}`;
    const times = [...(this.beacons.get(key) ?? []).filter((t) => e.at - t <= 6 * 3600_000), e.at].slice(-24);
    this.beacons.set(key, times);
    if (times.length >= Math.max(6, this.n(8))) {
      const gaps = times.slice(1).map((t, i) => t - times[i]);
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
      const cvMax = 0.12 / FACTOR[c.sensitivity];
      if (mean >= 20_000 && mean <= 3600_000 && sd / mean <= cvMax) {
        const every = mean >= 120_000 ? `${Math.round(mean / 60_000)} minutes` : `${Math.round(mean / 1000)} seconds`;
        this.say(
          {
            key: `beaconing:${e.src}:${e.dst}:${e.dport}`,
            kind: 'beaconing',
            severity: 'warning',
            title: `{device} checks in somewhere like clockwork`,
            detail: `A new connection to ${e.dst} port ${e.dport} every ${every}, ${times.length} times in a row. Smart devices and updaters do this; so does malware calling home. Mute it if you know what it is.`,
            ip: e.src,
            subject: `${e.dst}:${e.dport}`,
            evidence: times.slice(-4).map((t) => `${new Date(t).toLocaleTimeString()} ${e.proto.toUpperCase()} ${e.src} → ${e.dst}:${e.dport}`),
          },
          e.at,
          out,
        );
      }
    }
  }

  // ------------------------------------------------------------------------------------------ neighbors

  private neighbor(e: Extract<DomeEvent, { type: 'neighbor' }>, out: DomeSignal[]) {
    const c = this.ctx();
    if (c.gateAddresses.has(e.ip) || !this.inside(e.ip)) return;
    const time = new Date(e.at).toLocaleTimeString();
    const cur = this.ipMac.get(e.ip);
    if (!cur) this.ipMac.set(e.ip, { mac: e.mac, changes: [] });
    else if (cur.mac !== e.mac) {
      const changes = [...cur.changes.filter((t) => e.at - t <= 10 * MINUTE), e.at];
      this.ipMac.set(e.ip, { mac: e.mac, changes });
      if (changes.length >= 2) {
        this.say(
          {
            key: `arp-spoof:${e.ip}`,
            kind: 'arp-spoof',
            severity: 'serious',
            title: `Two devices are fighting over ${e.ip}`,
            detail: `${e.ip} keeps changing hands between ${cur.mac} and ${e.mac}. That is how a device on your network puts itself in the middle of someone else's traffic (ARP spoofing), or two devices were given the same address.`,
            ip: e.ip,
            mac: e.mac,
            subject: e.ip,
            evidence: [`${time} ${e.ip} is now at ${e.mac} (was ${cur.mac})`],
          },
          e.at,
          out,
        );
      }
    }
    const leased = c.leaseMac(e.ip);
    if (leased && leased !== e.mac) {
      this.say(
        {
          key: `arp-spoof:${e.ip}`,
          kind: 'arp-spoof',
          severity: 'warning',
          title: `Another device answers for ${e.ip}`,
          detail: `The gate gave ${e.ip} to ${leased}, but ${e.mac} answers for it. A device set to a fixed address in the range the gate hands out, or one putting itself in the middle.`,
          ip: e.ip,
          mac: e.mac,
          subject: e.ip,
          evidence: [`${time} ${e.ip} at ${e.mac}; leased to ${leased}`],
        },
        e.at,
        out,
      );
    }
    const ips = this.macIps.get(e.mac) ?? new Map<string, number>();
    ips.set(e.ip, e.at);
    for (const [ip, at] of ips) if (e.at - at > 10 * MINUTE) ips.delete(ip);
    this.macIps.set(e.mac, ips);
    if (ips.size >= this.n(4)) {
      this.say(
        {
          key: `arp-spoof:${e.mac}`,
          kind: 'arp-spoof',
          severity: 'warning',
          title: `One device answers for ${ips.size} addresses`,
          detail: `${e.mac} answers for ${[...ips.keys()].slice(0, 6).join(', ')}. Wi-Fi extenders in some modes do this; so does a device putting itself in the middle of others' traffic.`,
          ip: e.ip,
          mac: e.mac,
          subject: e.mac,
          evidence: [`${time} ${e.mac} at ${[...ips.keys()].join(', ')}`],
        },
        e.at,
        out,
      );
    }
  }
}
