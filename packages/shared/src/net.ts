/**
 * IPv4 and IPv6 address arithmetic shared by FBRX Mesh (Prefer Mesh), FBRX Gate and FBRX MiniDome. Pure functions,
 * no Node.js APIs, so the consoles can use them too.
 */

export interface Cidr {
  family: 4 | 6;
  /** The address as written (may have host bits set, like a router's own address 192.168.1.1/24). */
  address: string;
  prefix: number;
  /** Network address as a bigint (host bits cleared). */
  network: bigint;
}

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isIPv4(s: string): boolean {
  const m = V4.exec(s.trim());
  return !!m && m.slice(1).every((p) => Number(p) <= 255 && (p === '0' || !p.startsWith('0')));
}

export function isIPv6(s: string): boolean {
  return parseIPv6(s) !== null;
}

export function isIP(s: string): boolean {
  return isIPv4(s) || isIPv6(s);
}

export function ipv4ToInt(s: string): number {
  if (!isIPv4(s)) throw new Error(`Not an IPv4 address: ${s}`);
  return s
    .trim()
    .split('.')
    .reduce((acc, p) => ((acc << 8) | Number(p)) >>> 0, 0);
}

export function intToIPv4(n: number): string {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
}

function parseIPv6(raw: string): bigint | null {
  let s = raw.trim().toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(':') || !/^[0-9a-f:.]+$/.test(s)) return null;
  // An embedded IPv4 tail (::ffff:192.0.2.1).
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!isIPv4(tail)) return null;
    const n = ipv4ToInt(tail);
    s = `${s.slice(0, lastColon + 1)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  let out = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out = (out << 16n) | BigInt(parseInt(g, 16));
  }
  return out;
}

function toBig(ip: string): { family: 4 | 6; value: bigint } | null {
  if (isIPv4(ip)) return { family: 4, value: BigInt(ipv4ToInt(ip)) };
  const v6 = parseIPv6(ip);
  return v6 === null ? null : { family: 6, value: v6 };
}

const bits = (family: 4 | 6) => (family === 4 ? 32 : 128);
const maskOf = (family: 4 | 6, prefix: number) => {
  const b = BigInt(bits(family));
  return prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << (b - BigInt(prefix));
};

/** Parses "10.20.0.0/24", "10.20.0.1/24", "fd00::/64" or a bare address (a /32 or /128). */
export function parseCidr(s: string): Cidr | null {
  const [addr, p, extra] = String(s).trim().split('/');
  if (extra !== undefined || !addr) return null;
  const ip = toBig(addr);
  if (!ip) return null;
  const max = bits(ip.family);
  if (p !== undefined && !/^\d{1,3}$/.test(p)) return null;
  const prefix = p === undefined ? max : Number(p);
  if (prefix < 0 || prefix > max) return null;
  return { family: ip.family, address: addr, prefix, network: ip.value & maskOf(ip.family, prefix) };
}

export function isCidr(s: string): boolean {
  return parseCidr(s) !== null;
}

/** True when the address is inside the network. */
export function inCidr(ip: string, cidr: string | Cidr): boolean {
  const c = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  const a = toBig(ip);
  if (!c || !a || a.family !== c.family) return false;
  return (a.value & maskOf(c.family, c.prefix)) === c.network;
}

export function cidrsOverlap(a: string, b: string): boolean {
  const x = parseCidr(a);
  const y = parseCidr(b);
  if (!x || !y || x.family !== y.family) return false;
  const p = Math.min(x.prefix, y.prefix);
  const m = maskOf(x.family, p);
  return (x.network & m) === (y.network & m);
}

/** The network in canonical form (10.20.0.1/24 → 10.20.0.0/24). IPv4 only for the host range helpers below. */
export function networkOf(cidr: string): string {
  const c = parseCidr(cidr);
  if (!c) throw new Error(`Not a network: ${cidr}`);
  if (c.family === 4) return `${intToIPv4(Number(c.network))}/${c.prefix}`;
  return `${formatIPv6(c.network)}/${c.prefix}`;
}

/** RFC 5952 text form: lower case, the longest run of zero groups (two or more) shortened to "::". */
export function formatIPv6(v: bigint): string {
  const g: number[] = [];
  for (let i = 7; i >= 0; i--) g.push(Number((v >> BigInt(i * 16)) & 0xffffn));
  let best = -1;
  let bestLen = 1;
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = g.map((x) => x.toString(16));
  if (best < 0) return hex.join(':');
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`;
}

/** First and last usable IPv4 host (a /31 and /32 use every address). */
export function hostRange(cidr: string): { first: string; last: string; size: number } {
  const c = parseCidr(cidr);
  if (!c || c.family !== 4) throw new Error(`Not an IPv4 network: ${cidr}`);
  const net = Number(c.network);
  const size = 2 ** (32 - c.prefix);
  if (c.prefix >= 31) return { first: intToIPv4(net), last: intToIPv4(net + size - 1), size };
  return { first: intToIPv4(net + 1), last: intToIPv4(net + size - 2), size: size - 2 };
}

export function prefixToMask(prefix: number): string {
  return intToIPv4(Number(maskOf(4, prefix)));
}

/** RFC 1918, carrier-grade NAT, link-local and unique-local IPv6: addresses that stay inside a network. */
export function isPrivateIP(ip: string): boolean {
  return ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16', '127.0.0.0/8', 'fc00::/7', 'fe80::/10', '::1/128'].some((c) => inCidr(ip, c));
}

// ------------------------------------------------------------------------------------------ Prefer Mesh

/**
 * DSCP classes for marking FBRX Mesh traffic (RFC 4594 names). AF41 ("interactive video", low loss and delay, but
 * below voice) is the default: switches and FBRX Gate put it in a priority queue without starving phone calls.
 */
export const MESH_TRAFFIC_CLASSES = ['cs0', 'af21', 'af31', 'af41', 'cs5', 'ef'] as const;
export type MeshTrafficClass = (typeof MESH_TRAFFIC_CLASSES)[number];
export const DSCP_VALUES: Record<MeshTrafficClass, number> = { cs0: 0, af21: 18, af31: 26, af41: 34, cs5: 40, ef: 46 };
export const MESH_TRAFFIC_CLASS_WORDS: Record<MeshTrafficClass, string> = {
  cs0: 'Best effort (no priority)',
  af21: 'AF21: business data',
  af31: 'AF31: important data',
  af41: 'AF41: interactive (recommended)',
  cs5: 'CS5: signaling',
  ef: 'EF: real time (above calls; use with care)',
};

/** The nftables table that marks FBRX Mesh traffic leaving a Linux computer (idempotent: replaces itself). */
export function meshQosNftables(port: number, cls: MeshTrafficClass): string {
  return [
    'table inet fbrx_mesh',
    'delete table inet fbrx_mesh',
    'table inet fbrx_mesh {',
    '  # FBRX Mesh (Prefer Mesh): mark mesh traffic so switches and FBRX Gate give it priority.',
    '  chain mark_out {',
    '    type filter hook output priority mangle; policy accept;',
    `    tcp dport ${port} ip dscp set ${cls}`,
    `    tcp sport ${port} ip dscp set ${cls}`,
    `    tcp dport ${port} ip6 dscp set ${cls}`,
    `    tcp sport ${port} ip6 dscp set ${cls}`,
    '  }',
    '}',
    '',
  ].join('\n');
}

/** Removes the marking table again (no error when it is not there). */
export const MESH_QOS_NFT_REMOVE = 'table inet fbrx_mesh\ndelete table inet fbrx_mesh\n';

/**
 * Windows QoS policies that mark FBRX Mesh traffic. Windows only honors DSCP from QoS policies on computers that are
 * not in a domain when "Do not use NLA" is set, so that is set too.
 */
export function meshQosWindows(port: number, cls: MeshTrafficClass): string {
  const dscp = DSCP_VALUES[cls];
  return [
    "$ErrorActionPreference = 'Stop'",
    "Remove-NetQosPolicy -Name 'FBRX Mesh out','FBRX Mesh in' -Confirm:$false -ErrorAction SilentlyContinue",
    `New-NetQosPolicy -Name 'FBRX Mesh out' -IPProtocolMatchCondition TCP -IPDstPortMatchCondition ${port} -DSCPAction ${dscp} -NetworkProfile All | Out-Null`,
    `New-NetQosPolicy -Name 'FBRX Mesh in' -IPProtocolMatchCondition TCP -IPSrcPortMatchCondition ${port} -DSCPAction ${dscp} -NetworkProfile All | Out-Null`,
    "New-Item -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\QoS' -Force | Out-Null",
    "Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\QoS' -Name 'Do not use NLA' -Value '1' -Type String",
  ].join('\n');
}

export const MESH_QOS_WINDOWS_REMOVE = "Remove-NetQosPolicy -Name 'FBRX Mesh out','FBRX Mesh in' -Confirm:$false -ErrorAction SilentlyContinue";

/** Jumbo frames: an MTU of 9000 bytes, so 8972 bytes of ICMP payload fit in one unfragmented packet. */
export const JUMBO_MTU = 9000;

/** Orders addresses so the ones inside the preferred mesh networks come first (stable otherwise). */
export function preferAddresses(addresses: string[], subnets: string[]): string[] {
  if (!subnets.length) return [...addresses];
  const rank = (a: string) => {
    const i = subnets.findIndex((s) => inCidr(a, s));
    return i < 0 ? subnets.length : i;
  };
  return addresses.map((a, i) => ({ a, i, r: rank(a) })).sort((x, y) => x.r - y.r || x.i - y.i).map((x) => x.a);
}

export interface MeshLocalAddress {
  address: string;
  iface: string;
  cidr: string;
  mtu: number | null;
  /** Inside one of the preferred mesh networks. */
  preferred: boolean;
}

export interface MeshNetworkStatus {
  preferMesh: boolean;
  subnets: string[];
  trafficClass: MeshTrafficClass;
  dscp: number;
  port: number;
  jumbo: boolean;
  local: MeshLocalAddress[];
  /** Whether this computer marks its mesh traffic with the traffic class. */
  qos: {
    method: 'nftables' | 'windows' | 'none';
    /** null: could not tell (it needs administrator rights to look). */
    applied: boolean | null;
    canApply: boolean;
    detail: string;
    /** What an administrator runs to mark the traffic (when this computer cannot do it itself). */
    script: string | null;
  };
  warnings: string[];
}

export interface MeshPathTest {
  peerId: string;
  peerName: string;
  address: string | null;
  preferred: boolean;
  /** Round trip of a sealed mesh request (what Mesh Assist feels), in milliseconds. */
  rttMs: number | null;
  /** Whether a 9000-byte packet gets through without being split (only tested when jumbo frames are on). */
  jumbo: { tested: boolean; ok: boolean | null; detail: string };
  error: string | null;
}
