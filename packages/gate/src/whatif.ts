import { inCidr, intToIPv4, ipv4ToInt, isIPv4, parseCidr } from '@fbrx/shared';
import type { GateConfig, GateRule } from './model';
import { portRanges } from './validate';

/**
 * What If: what a change would do to traffic, before it is committed. The firewall is worked out here exactly as
 * render/nftables.ts writes it (the rules in order, then the gate's own allowances, then the default), for what runs
 * now and for what is being edited, and the two answers are compared: for every kind of connection between the zones
 * (each network to the internet, to the others and to the gate's console, DNS and DHCP; the internet to the console
 * and the port forwards), for the person asking (can they still reach the console?), and for the connections the gate
 * really saw lately (MiniDome's recent flows).
 */

export type FlowProto = 'tcp' | 'udp' | 'icmp';

export interface Flow {
  /** A network's name, "wan" (the internet) or "vpn". */
  from: string;
  /** A network's name, "wan", "vpn" or "gate" (the gate itself). */
  to: string;
  proto: FlowProto;
  port?: number;
  src?: string;
  dst?: string;
  /** It came in from the internet through a port forward (sent on to its device). */
  dnat?: boolean;
}

export interface Verdict {
  /** "absent": the network it comes from or goes to is not there in this configuration. */
  verdict: 'allowed' | 'blocked' | 'absent';
  because: string;
}

const RESERVED = new Set(['wan', 'gate', 'vpn']);

const zoneExists = (c: GateConfig, z: string) => z === 'wan' || z === 'gate' || (z === 'vpn' ? c.vpn.enabled : c.networks.some((n) => n.name === z));
const gateIp = (cidr: string) => cidr.split('/')[0];

/** A device's address in a network (where its DHCP range starts), to stand for any device there. */
function hostIn(c: GateConfig, zone: string): string | undefined {
  if (zone === 'wan') return '203.0.113.50';
  if (zone === 'vpn') {
    const p = parseCidr(c.vpn.address);
    return p ? intToIPv4(ipv4ToInt(gateIp(c.vpn.address)) + 1) : undefined;
  }
  const n = c.networks.find((x) => x.name === zone);
  return n ? (n.dhcp.enabled ? n.dhcp.start : intToIPv4(ipv4ToInt(gateIp(n.address)) + 9)) : undefined;
}

/** The zone an address is in, for a configuration: "gate" for the gate's own addresses. */
export function zoneOf(c: GateConfig, ip: string, wanAddress?: string | null): string {
  if (!isIPv4(ip)) return 'wan';
  if (c.networks.some((n) => gateIp(n.address) === ip) || (c.vpn.enabled && gateIp(c.vpn.address) === ip)) return 'gate';
  if (wanAddress && gateIp(wanAddress) === ip) return 'gate';
  if (c.wan.mode === 'static' && c.wan.address && gateIp(c.wan.address) === ip) return 'gate';
  const n = c.networks.find((x) => inCidr(ip, x.address));
  if (n) return n.name;
  if (c.vpn.enabled && inCidr(ip, c.vpn.address)) return 'vpn';
  return 'wan';
}

function ruleMatches(r: GateRule, f: Flow, chain: 'input' | 'forward'): boolean {
  if (r.from !== 'any' && r.from !== f.from) return false;
  if (chain === 'forward' && r.to !== 'any' && r.to !== f.to) return false;
  if (r.proto === 'tcp' || r.proto === 'udp') {
    if (f.proto !== r.proto) return false;
  } else if (r.proto === 'tcp+udp') {
    if (f.proto !== 'tcp' && f.proto !== 'udp') return false;
  } else if (r.proto === 'icmp' && f.proto !== 'icmp') return false;
  if (r.ports && r.proto !== 'any' && r.proto !== 'icmp') {
    if (f.port === undefined || !portRanges(r.ports).some(([a, b]) => f.port! >= a && f.port! <= b)) return false;
  }
  if (r.source && !(f.src && inCidr(f.src, r.source))) return false;
  if (r.destination && !(f.dst && inCidr(f.dst, r.destination))) return false;
  return true;
}

const byRule = (r: GateRule): Verdict => ({ verdict: r.action === 'accept' ? 'allowed' : 'blocked', because: `rule "${r.name}"` });

/** The gate's answer to a new connection in a configuration (as render/nftables.ts has it). */
export function decide(c: GateConfig, f: Flow): Verdict {
  if (!zoneExists(c, f.from)) return { verdict: 'absent', because: `there is no ${f.from} network` };
  if (!zoneExists(c, f.to)) return { verdict: 'absent', because: `there is no ${f.to} network` };
  const tcpUdp = f.proto === 'tcp' || f.proto === 'udp';

  if (f.to === 'gate') {
    for (const r of c.firewall.rules) if (r.enabled && r.to === 'gate' && ruleMatches(r, f, 'input')) return byRule(r);
    const mgmt = [...(c.management.ssh ? [22] : []), c.management.consolePort, c.qos.preferMesh.port];
    const n = c.networks.find((x) => x.name === f.from);
    if (n) {
      if (n.dhcp.enabled && f.proto === 'udp' && f.port === 67) return { verdict: 'allowed', because: `DHCP on ${n.name}` };
      if (tcpUdp && f.port === 53) return { verdict: 'allowed', because: `DNS for ${n.name}` };
      if (f.proto === 'icmp') return { verdict: 'allowed', because: `ping from ${n.name}` };
      if (n.manage && f.proto === 'tcp' && f.port !== undefined && mgmt.includes(f.port)) return { verdict: 'allowed', because: `${n.name} may manage the gate` };
    }
    if (f.from === 'vpn' && c.vpn.enabled) {
      if (tcpUdp && f.port === 53) return { verdict: 'allowed', because: 'DNS for the VPN' };
      if (f.proto === 'icmp') return { verdict: 'allowed', because: 'ping from the VPN' };
      if (c.vpn.access === 'full' && f.proto === 'tcp' && f.port !== undefined && mgmt.includes(f.port)) return { verdict: 'allowed', because: 'the VPN has full access' };
    }
    if (f.from === 'wan') {
      if (c.vpn.enabled && f.proto === 'udp' && f.port === c.vpn.port) return { verdict: 'allowed', because: 'the VPN' };
      if (c.wan.ping && f.proto === 'icmp') return { verdict: 'allowed', because: 'answering pings from the internet' };
    }
    return { verdict: 'blocked', because: 'nothing lets it in (the default)' };
  }

  // Through the gate. A connection from the internet to a port forward arrives here already sent on to its device.
  for (const r of c.firewall.rules) if (r.enabled && r.to !== 'gate' && ruleMatches(r, f, 'forward')) return byRule(r);
  if (f.from === 'wan' && f.dnat && c.firewall.forwards.some((x) => x.enabled)) {
    const forward = c.firewall.forwards.find((x) => x.enabled && x.to === f.dst);
    return { verdict: 'allowed', because: forward ? `port forward "${forward.name}"` : 'a port forward' };
  }
  const n = c.networks.find((x) => x.name === f.from);
  if (n) {
    if (n.vmSwitch && f.to === n.name) return { verdict: 'allowed', because: `within ${n.name}` };
    if (n.access !== 'isolated' && f.to === 'wan') return { verdict: 'allowed', because: `${n.name} has the internet` };
    if (n.access === 'full' && f.to !== 'wan' && f.to !== n.name) return { verdict: 'allowed', because: `${n.name} has full access` };
  }
  if (f.from === 'vpn' && c.vpn.enabled) {
    if (f.to === 'wan') return { verdict: 'allowed', because: 'the VPN has the internet' };
    if (c.vpn.access === 'full' && !RESERVED.has(f.to)) return { verdict: 'allowed', because: 'the VPN has full access' };
  }
  return { verdict: 'blocked', because: 'nothing lets it through (the default)' };
}

/**
 * A connection as it arrives (addresses and a port), worked out for a configuration: its zones, and the device a port
 * forward sends it to.
 */
export function decideConnection(c: GateConfig, x: { proto: FlowProto; src: string; dst: string; port?: number }, wanAddress?: string | null): { from: string; to: string; verdict: Verdict } {
  const from = zoneOf(c, x.src, wanAddress);
  let to = zoneOf(c, x.dst, wanAddress);
  let dst = x.dst;
  let port = x.port;
  let dnat = false;
  if (from === 'wan' && to === 'gate' && x.proto !== 'icmp' && port !== undefined) {
    const fw = c.firewall.forwards.find((f) => f.enabled && (f.proto === 'tcp+udp' || f.proto === x.proto) && portRanges(f.port).some(([a, b]) => port! >= a && port! <= b) && (!f.source || inCidr(x.src, f.source)));
    if (fw) {
      dst = fw.to;
      port = fw.toPort ?? port;
      to = zoneOf(c, fw.to, wanAddress);
      dnat = true;
    }
  }
  return { from, to, verdict: decide(c, { from, to, proto: x.proto, port, src: x.src, dst, dnat }) };
}

export interface WhatIfRow {
  from: string;
  to: string;
  /** What kind of connection, in words: "the internet (web)", "this console", "devices on guest". */
  what: string;
  before: Verdict;
  after: Verdict;
}

export interface WhatIfFlow {
  proto: FlowProto;
  src: string;
  dst: string;
  port: number;
  count: number;
  lastAt: string;
  from: string;
  to: string;
  before: Verdict;
  after: Verdict;
}

export interface WhatIfReport {
  /** The person asking: where they are, and whether they could still reach this console. */
  you: { address: string; from: string; fromAfter: string; before: Verdict; after: Verdict } | null;
  /** Every kind of connection between the zones, with its answer now and after the change. */
  matrix: WhatIfRow[];
  /** The connections the gate saw lately whose answer the change turns around. */
  flows: WhatIfFlow[];
  flowsChecked: number;
  /** How many kinds of connection (and recent connections) would be cut off, and how many opened. */
  summary: { cutOff: number; opened: number; flowsCutOff: number; flowsOpened: number; youCutOff: boolean };
}

const changed = (a: Verdict, b: Verdict) => (a.verdict === 'allowed') !== (b.verdict === 'allowed');

/** Compares what runs (null before the first commit) with what is being edited. */
export function whatIf(
  running: GateConfig | null,
  candidate: GateConfig,
  o: { you?: string | null; wanAddress?: string | null; flows?: Array<{ proto: 'tcp' | 'udp'; src: string; dst: string; dport: number; count: number; lastAt: string }> } = {},
): WhatIfReport {
  const before = running;
  const none: Verdict = { verdict: 'absent', because: 'nothing runs yet' };
  const both = (f: (c: GateConfig) => Flow | null): { before: Verdict; after: Verdict } => {
    const fb = before ? f(before) : null;
    const fa = f(candidate);
    return {
      before: !before ? none : fb ? decide(before, fb) : { verdict: 'absent', because: 'not in what runs' },
      after: fa ? decide(candidate, fa) : { verdict: 'absent', because: 'not in the change' },
    };
  };
  const configs = before ? [before, candidate] : [candidate];
  const zones = [...new Set(configs.flatMap((c) => [...c.networks.map((n) => n.name), ...(c.vpn.enabled ? ['vpn'] : [])]))];
  const ssh = configs.some((c) => c.management.ssh);
  const matrix: WhatIfRow[] = [];
  const add = (from: string, to: string, what: string, f: (c: GateConfig) => Flow | null) => matrix.push({ from, to, what, ...both(f) });
  for (const z of zones) {
    const src = (c: GateConfig) => hostIn(c, z);
    add(z, 'wan', 'the internet (web)', (c) => ({ from: z, to: 'wan', proto: 'tcp', port: 443, src: src(c), dst: '1.1.1.1' }));
    for (const other of zones.filter((x) => x !== z)) add(z, other, `devices on ${other}`, (c) => ({ from: z, to: other, proto: 'tcp', port: 443, src: src(c), dst: hostIn(c, other) }));
    add(z, 'gate', 'this console', (c) => ({ from: z, to: 'gate', proto: 'tcp', port: c.management.consolePort, src: src(c) }));
    if (ssh) add(z, 'gate', 'SSH to the gate', (c) => (c.management.ssh ? { from: z, to: 'gate', proto: 'tcp', port: 22, src: src(c) } : null));
    add(z, 'gate', 'names (DNS)', (c) => ({ from: z, to: 'gate', proto: 'udp', port: 53, src: src(c) }));
    if (z !== 'vpn') add(z, 'gate', 'an address (DHCP)', (c) => ({ from: z, to: 'gate', proto: 'udp', port: 67, src: src(c) }));
  }
  add('wan', 'gate', 'this console', (c) => ({ from: 'wan', to: 'gate', proto: 'tcp', port: c.management.consolePort, src: hostIn(c, 'wan') }));
  const forwardIds = [...new Set(configs.flatMap((c) => c.firewall.forwards.map((f) => f.id)))];
  for (const id of forwardIds) {
    const name = [candidate, ...(before ? [before] : [])].flatMap((c) => c.firewall.forwards).find((f) => f.id === id)!.name;
    add('wan', 'forward', `port forward "${name}"`, (c) => {
      const f = c.firewall.forwards.find((x) => x.id === id && x.enabled);
      if (!f) return null;
      const port = portRanges(f.port)[0][0];
      const to = zoneOf(c, f.to);
      return { from: 'wan', to, proto: f.proto === 'udp' ? 'udp' : 'tcp', port: f.toPort ?? port, src: hostIn(c, 'wan'), dst: f.to, dnat: true };
    });
  }

  let you: WhatIfReport['you'] = null;
  if (o.you && isIPv4(o.you)) {
    const fromNow = before ? zoneOf(before, o.you, o.wanAddress) : zoneOf(candidate, o.you, o.wanAddress);
    const fromAfter = zoneOf(candidate, o.you, o.wanAddress);
    you = {
      address: o.you,
      from: fromNow,
      fromAfter,
      before: before ? decide(before, { from: fromNow, to: 'gate', proto: 'tcp', port: before.management.consolePort, src: o.you }) : none,
      after: decide(candidate, { from: fromAfter, to: 'gate', proto: 'tcp', port: candidate.management.consolePort, src: o.you }),
    };
  }

  const flows: WhatIfFlow[] = [];
  let flowsChecked = 0;
  if (before) {
    for (const x of o.flows ?? []) {
      const b = decideConnection(before, { proto: x.proto, src: x.src, dst: x.dst, port: x.dport }, o.wanAddress);
      const a = decideConnection(candidate, { proto: x.proto, src: x.src, dst: x.dst, port: x.dport }, o.wanAddress);
      // Within a network, traffic does not pass the gate.
      if (b.from === b.to && a.from === a.to) continue;
      flowsChecked++;
      if (changed(b.verdict, a.verdict)) flows.push({ ...x, port: x.dport, from: b.from, to: b.to, before: b.verdict, after: a.verdict });
    }
    flows.sort((p, q) => (p.after.verdict === 'allowed' ? 1 : 0) - (q.after.verdict === 'allowed' ? 1 : 0) || q.count - p.count);
  }

  const cut = matrix.filter((r) => r.before.verdict === 'allowed' && r.after.verdict !== 'allowed').length;
  const opened = matrix.filter((r) => r.before.verdict !== 'allowed' && r.after.verdict === 'allowed' && before).length;
  return {
    you,
    matrix,
    flows: flows.slice(0, 200),
    flowsChecked,
    summary: {
      cutOff: cut,
      opened,
      flowsCutOff: flows.filter((f) => f.after.verdict !== 'allowed').length,
      flowsOpened: flows.filter((f) => f.after.verdict === 'allowed').length,
      youCutOff: !!you && you.before.verdict === 'allowed' && you.after.verdict !== 'allowed',
    },
  };
}
