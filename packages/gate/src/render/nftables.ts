import type { GateConfig, GateRule } from '../model';
import { portRanges } from '../validate';

export const WG_IFACE = 'wg-fbrx';
export const NFT_TABLE = 'fbrx_gate';

const q = (s: string) => `"${s}"`;
const set = (items: string[]) => (items.length === 1 ? items[0] : `{ ${items.join(', ')} }`);
const ports = (p: string) => set(portRanges(p).map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)));

/** The interfaces of each zone. */
export function zoneInterfaces(c: GateConfig): Map<string, string> {
  const m = new Map<string, string>([['wan', c.wan.interface]]);
  for (const n of c.networks) m.set(n.name, n.interface);
  if (c.vpn.enabled) m.set('vpn', WG_IFACE);
  return m;
}

/** Every interface the gate governs (traffic on the others, a hypervisor's own networks say, is left alone). */
export function gateInterfaces(c: GateConfig): string[] {
  const out = [...new Set([...c.interfaces.map((i) => i.name), c.wan.interface, ...c.networks.map((n) => n.interface)])];
  if (c.vpn.enabled) out.push(WG_IFACE);
  return out;
}

function match(r: Pick<GateRule, 'proto' | 'ports' | 'source' | 'destination'>): string {
  const parts: string[] = [];
  if (r.source) parts.push(`ip saddr ${r.source}`);
  if (r.destination) parts.push(`ip daddr ${r.destination}`);
  if (r.proto === 'tcp' || r.proto === 'udp') parts.push(r.ports ? `${r.proto} dport ${ports(r.ports)}` : `meta l4proto ${r.proto}`);
  else if (r.proto === 'tcp+udp') parts.push(r.ports ? `meta l4proto { tcp, udp } th dport ${ports(r.ports)}` : 'meta l4proto { tcp, udp }');
  else if (r.proto === 'icmp') parts.push('meta l4proto icmp');
  return parts.join(' ');
}

function ruleLine(r: GateRule, zones: Map<string, string>, chain: 'input' | 'forward'): string {
  const parts: string[] = [];
  if (r.from !== 'any') parts.push(`iifname ${q(zones.get(r.from)!)}`);
  if (chain === 'forward' && r.to !== 'any') parts.push(`oifname ${q(zones.get(r.to)!)}`);
  const m = match(r);
  if (m) parts.push(m);
  if (r.log) parts.push(`log prefix "fbrx-gate ${r.id}: " level info`);
  parts.push('counter');
  parts.push(r.action === 'reject' ? 'reject with icmpx type admin-prohibited' : r.action);
  parts.push(`comment "rule:${r.id}"`);
  return parts.join(' ');
}

/**
 * The whole firewall as one nftables table, replaced atomically: filtering for the gate itself (input) and for the
 * traffic it routes (forward), NAT to the internet and port forwards, and the Prefer Mesh priority mark.
 */
export function renderNftables(c: GateConfig): string {
  const zones = zoneInterfaces(c);
  const wan = q(c.wan.interface);
  const L: string[] = [];
  const add = (s: string) => L.push(s);
  add(`table inet ${NFT_TABLE}`);
  add(`delete table inet ${NFT_TABLE}`);
  add(`# FBRX Gate firewall. Made by FBRX Gate from its configuration: changes here are overwritten.`);
  add(`table inet ${NFT_TABLE} {`);
  add(`  set gate_ifaces {`);
  add(`    type ifname`);
  add(`    elements = { ${gateInterfaces(c).map(q).join(', ')} }`);
  add(`  }`);

  // ----------------------------------------------------------------------------------- the gate itself
  add(`  chain input {`);
  add(`    type filter hook input priority filter; policy accept;`);
  add(`    iifname != @gate_ifaces accept`);
  add(`    ct state established,related accept`);
  add(`    ct state invalid drop`);
  for (const r of c.firewall.rules) if (r.enabled && r.to === 'gate') add(`    ${ruleLine(r, zones, 'input')}`);
  const mgmt = [...(c.management.ssh ? [22] : []), c.management.consolePort];
  for (const n of c.networks) {
    const i = q(n.interface);
    if (n.dhcp.enabled) add(`    iifname ${i} udp dport 67 accept comment "dhcp:${n.name}"`);
    add(`    iifname ${i} meta l4proto { tcp, udp } th dport 53 accept comment "dns:${n.name}"`);
    add(`    iifname ${i} icmp type echo-request accept`);
    add(`    iifname ${i} meta l4proto ipv6-icmp accept`);
    if (n.manage) add(`    iifname ${i} tcp dport ${set(mgmt.map(String))} accept comment "manage:${n.name}"`);
  }
  if (c.vpn.enabled) {
    const w = q(WG_IFACE);
    add(`    iifname ${w} meta l4proto { tcp, udp } th dport 53 accept comment "dns:vpn"`);
    add(`    iifname ${w} icmp type echo-request accept`);
    if (c.vpn.access === 'full') add(`    iifname ${w} tcp dport ${set(mgmt.map(String))} accept comment "manage:vpn"`);
    add(`    iifname ${wan} udp dport ${c.vpn.port} accept comment "vpn"`);
  }
  if (c.wan.mode === 'dhcp') add(`    iifname ${wan} udp sport 67 udp dport 68 accept comment "wan-dhcp"`);
  if (c.wan.ping) add(`    iifname ${wan} icmp type echo-request limit rate 10/second accept comment "wan-ping"`);
  add(`    iifname @gate_ifaces counter drop comment "default:input"`);
  add(`  }`);

  // ---------------------------------------------------------------------------- traffic passing through
  add(`  chain forward {`);
  add(`    type filter hook forward priority filter; policy accept;`);
  add(`    iifname != @gate_ifaces oifname != @gate_ifaces accept`);
  add(`    ct state established,related accept`);
  add(`    ct state invalid drop`);
  // Networks the gate does not govern (a hypervisor's own, say) keep reaching the internet as they would without it.
  add(`    iifname != @gate_ifaces oifname ${wan} accept comment "other:internet"`);
  for (const r of c.firewall.rules) if (r.enabled && r.to !== 'gate') add(`    ${ruleLine(r, zones, 'forward')}`);
  if (c.firewall.forwards.some((f) => f.enabled)) add(`    iifname ${wan} ct status dnat counter accept comment "forwards"`);
  const lans = c.networks.map((n) => n.interface);
  for (const n of c.networks) {
    const i = q(n.interface);
    if (n.access !== 'isolated') add(`    iifname ${i} oifname ${wan} accept comment "internet:${n.name}"`);
    if (n.access === 'full') {
      const others = [...lans.filter((x) => x !== n.interface), ...(c.vpn.enabled ? [WG_IFACE] : [])];
      if (others.length) add(`    iifname ${i} oifname ${set(others.map(q))} accept comment "networks:${n.name}"`);
    }
  }
  if (c.vpn.enabled) {
    const w = q(WG_IFACE);
    add(`    iifname ${w} oifname ${wan} accept comment "internet:vpn"`);
    if (c.vpn.access === 'full' && lans.length) add(`    iifname ${w} oifname ${set(lans.map(q))} accept comment "networks:vpn"`);
  }
  add(`    counter drop comment "default:forward"`);
  add(`  }`);

  // ------------------------------------------------------------------------------------------------ NAT
  const forwards = c.firewall.forwards.filter((f) => f.enabled);
  add(`  chain dstnat {`);
  add(`    type nat hook prerouting priority dstnat; policy accept;`);
  for (const f of forwards) {
    const proto = f.proto === 'tcp+udp' ? 'meta l4proto { tcp, udp } th' : f.proto;
    const to = f.toPort ? `${f.to}:${f.toPort}` : f.to;
    add(`    iifname ${wan}${f.source ? ` ip saddr ${f.source}` : ''} ${proto} dport ${ports(f.port)} counter dnat ip to ${to} comment "forward:${f.id}"`);
  }
  add(`  }`);
  add(`  chain srcnat {`);
  add(`    type nat hook postrouting priority srcnat; policy accept;`);
  add(`    oifname ${wan} meta nfproto ipv4 masquerade`);
  add(`  }`);

  // -------------------------------------------------------------------------------------- Prefer Mesh
  const pm = c.qos.preferMesh;
  if (pm.enabled) {
    const meshIfaces = c.networks.filter((n) => pm.networks.includes(n.name)).map((n) => q(n.interface));
    add(`  # Prefer Mesh: traffic between FBRX computers, and everything from the mesh networks, goes first.`);
    add(`  chain mark_forward {`);
    add(`    type filter hook forward priority mangle; policy accept;`);
    // Counted ("mesh:…"), so the console can say how much traffic went first.
    add(`    tcp dport ${pm.port} ip dscp set ${pm.trafficClass} counter comment "mesh:to-port"`);
    add(`    tcp sport ${pm.port} ip dscp set ${pm.trafficClass} counter comment "mesh:from-port"`);
    if (meshIfaces.length) {
      add(`    iifname ${set(meshIfaces)} ip dscp set ${pm.trafficClass} counter comment "mesh:from-networks"`);
      add(`    oifname ${set(meshIfaces)} ip dscp set ${pm.trafficClass} counter comment "mesh:to-networks"`);
    }
    add(`  }`);
    add(`  chain mark_output {`);
    add(`    type filter hook output priority mangle; policy accept;`);
    add(`    tcp dport ${pm.port} ip dscp set ${pm.trafficClass} counter comment "mesh:gate-to-port"`);
    add(`    tcp sport ${pm.port} ip dscp set ${pm.trafficClass} counter comment "mesh:gate-from-port"`);
    add(`  }`);
  }
  add(`}`);
  return `${L.join('\n')}\n`;
}
