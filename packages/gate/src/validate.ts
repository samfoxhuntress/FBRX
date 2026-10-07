import { cidrsOverlap, hostRange, inCidr, ipv4ToInt, isPrivateIP, JUMBO_MTU, networkOf, parseCidr } from '@fbrx/shared';
import { GateConfigSchema, RESERVED_ZONES, type GateConfig } from './model';

export interface GateIssue {
  /** Where: "networks.guest.dhcp.start", "firewall.rules.r3", … */
  path: string;
  message: string;
}

export interface GateCheck {
  ok: boolean;
  errors: GateIssue[];
  warnings: GateIssue[];
  /** The parsed configuration (defaults filled in), when it has the right shape. */
  config: GateConfig | null;
}

/** Port numbers in a "22,80,6000-6100" list, as ranges. */
export function portRanges(ports: string): Array<[number, number]> {
  return ports.split(',').map((p) => {
    const [a, b] = p.trim().split('-').map(Number);
    return [a, b ?? a];
  });
}

const rangesOverlap = (a: Array<[number, number]>, b: Array<[number, number]>) => a.some(([x1, x2]) => b.some(([y1, y2]) => x1 <= y2 && y1 <= x2));

/** Checks a configuration: its shape, then whether it makes sense as a whole. Errors stop a commit; warnings do not. */
export function checkConfig(input: unknown): GateCheck {
  const parsed = GateConfigSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, config: null, warnings: [], errors: parsed.error.issues.map((i) => ({ path: i.path.join('.') || 'config', message: i.message })) };
  }
  const c = parsed.data;
  const errors: GateIssue[] = [];
  const warnings: GateIssue[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  const warn = (path: string, message: string) => warnings.push({ path, message });

  // ------------------------------------------------------------------------------------------- interfaces
  const ifaces = new Map(c.interfaces.map((i) => [i.name, i]));
  if (ifaces.size !== c.interfaces.length) err('interfaces', 'Two interfaces have the same name');
  const tags = new Set<string>();
  for (const i of c.interfaces) {
    const p = `interfaces.${i.name}`;
    if (i.kind === 'vlan') {
      const parent = i.parent ? ifaces.get(i.parent) : undefined;
      if (!parent) err(p, `VLAN ${i.name} needs the port it rides on (parent)`);
      else if (parent.kind !== 'ethernet') err(p, `VLAN ${i.name} must ride on a port, not on another VLAN`);
      if (!i.vlanId) err(p, `VLAN ${i.name} needs its tag (1 to 4094)`);
      if (parent && i.vlanId) {
        const key = `${parent.name}:${i.vlanId}`;
        if (tags.has(key)) err(p, `VLAN ${i.vlanId} is already on ${parent.name}`);
        tags.add(key);
      }
      if (parent && i.mtu > parent.mtu) err(p, `${i.name} has an MTU of ${i.mtu} but its port ${parent.name} only ${parent.mtu}: raise ${parent.name} too`);
      if (parent?.name === c.wan.interface) warn(p, `${i.name} rides on the internet port ${parent.name}`);
    } else if (i.parent || i.vlanId) err(p, `${i.name} is a port: it has no parent or VLAN tag`);
  }

  // ------------------------------------------------------------------------------------------------ WAN
  const wan = ifaces.get(c.wan.interface);
  if (!wan) err('wan.interface', `There is no interface ${c.wan.interface}`);
  if (c.wan.mode === 'static') {
    if (!c.wan.address) err('wan.address', 'A fixed internet address needs the address (with its size, like 203.0.113.2/29)');
    if (!c.wan.gateway) err('wan.gateway', 'A fixed internet address needs the provider’s gateway');
    if (c.wan.address && c.wan.gateway && !inCidr(c.wan.gateway, c.wan.address)) err('wan.gateway', `The gateway ${c.wan.gateway} is not in ${networkOf(c.wan.address)}`);
  }

  // ------------------------------------------------------------------------------------------- networks
  const names = new Set<string>();
  const onIface = new Map<string, string>();
  const subnets: Array<{ what: string; cidr: string }> = [];
  if (c.wan.mode === 'static' && c.wan.address) subnets.push({ what: 'the internet side', cidr: c.wan.address });
  if (c.vpn.enabled) subnets.push({ what: 'the VPN', cidr: c.vpn.address });
  for (const n of c.networks) {
    const p = `networks.${n.name}`;
    if ((RESERVED_ZONES as readonly string[]).includes(n.name)) err(p, `"${n.name}" is taken (wan, vpn, gate and any are zones of their own)`);
    if (names.has(n.name)) err(p, `Two networks are called ${n.name}`);
    names.add(n.name);
    const i = ifaces.get(n.interface);
    if (!i) err(p, `There is no interface ${n.interface}`);
    if (n.interface === c.wan.interface) err(p, `${n.name} cannot be on the internet port ${n.interface}`);
    const other = onIface.get(n.interface);
    if (other) err(p, `${n.interface} already carries ${other}: give ${n.name} its own port or VLAN`);
    onIface.set(n.interface, n.name);
    const cidr = parseCidr(n.address)!;
    if (cidr.prefix > 30) err(`${p}.address`, `${n.address} is too small for a network (use /30 or bigger)`);
    const net = networkOf(n.address);
    const range = cidr.prefix <= 30 ? hostRange(net) : null;
    const gw = n.address.split('/')[0];
    if (range && (ipv4ToInt(gw) < ipv4ToInt(range.first) || ipv4ToInt(gw) > ipv4ToInt(range.last))) err(`${p}.address`, `${gw} is the network or broadcast address of ${net}: pick another address for the gate`);
    for (const s of subnets) if (cidrsOverlap(n.address, s.cidr)) err(`${p}.address`, `${net} overlaps ${s.what} (${networkOf(s.cidr)})`);
    subnets.push({ what: `network ${n.name}`, cidr: n.address });
    if (n.dhcp.enabled) {
      const d = n.dhcp;
      if (!inCidr(d.start, n.address) || !inCidr(d.end, n.address)) err(`${p}.dhcp`, `The addresses handed out (${d.start} to ${d.end}) must be inside ${net}`);
      else if (ipv4ToInt(d.start) > ipv4ToInt(d.end)) err(`${p}.dhcp`, `${d.start} comes after ${d.end}`);
      else if (ipv4ToInt(gw) >= ipv4ToInt(d.start) && ipv4ToInt(gw) <= ipv4ToInt(d.end)) err(`${p}.dhcp`, `The gate’s own address ${gw} is inside the range handed out`);
      else if (range && (ipv4ToInt(d.start) < ipv4ToInt(range.first) || ipv4ToInt(d.end) > ipv4ToInt(range.last))) err(`${p}.dhcp`, `The range must leave out the network and broadcast addresses of ${net}`);
    }
    const macs = new Set<string>();
    const addrs = new Set<string>();
    for (const r of n.dhcp.reservations) {
      const rp = `${p}.dhcp.reservations.${r.mac.toLowerCase()}`;
      if (!inCidr(r.address, n.address)) err(rp, `${r.address} is not in ${net}`);
      if (r.address === gw) err(rp, `${r.address} is the gate itself`);
      if (macs.has(r.mac.toLowerCase())) err(rp, `${r.mac} is reserved twice`);
      if (addrs.has(r.address)) err(rp, `${r.address} is reserved twice`);
      macs.add(r.mac.toLowerCase());
      addrs.add(r.address);
    }
    if (i && i.kind === 'ethernet' && i.mtu > 1500 && c.interfaces.some((v) => v.parent === i.name && v.mtu > 1500) && n.purpose !== 'mesh')
      warn(p, `${i.name} is at MTU ${i.mtu} for its jumbo VLANs, so ${n.name} (untagged on it) uses jumbo frames too: every device on ${n.name} must take them`);
    if (n.purpose === 'mesh' && i && i.mtu < JUMBO_MTU) {
      const shared = i.kind === 'vlan' ? c.networks.find((x) => x.interface === i.parent) : undefined;
      warn(
        p,
        shared
          ? `Prefer Mesh works at MTU ${i.mtu}; for jumbo frames give ${n.name} a port of its own (${i.parent} also carries ${shared.name} untagged, which would get them too)`
          : `Prefer Mesh works at MTU ${i.mtu}; if your switch and computers take jumbo frames, set ${n.interface}${i.kind === 'vlan' ? ' (and its port)' : ''} to ${JUMBO_MTU}`,
      );
    }
    if (n.purpose === 'guest' && n.access === 'full') warn(p, `${n.name} is for guests but can reach all your networks`);
    if (n.manage && n.access === 'internet' && n.purpose === 'guest') warn(p, `Guests on ${n.name} can reach the gate’s console`);
  }
  if (!c.networks.length) warn('networks', 'There is no network behind the gate yet');

  // ------------------------------------------------------------------------------------------ firewall
  const zones = new Set<string>(['wan', 'gate', 'any', ...names, ...(c.vpn.enabled ? ['vpn'] : [])]);
  const ids = new Set<string>();
  for (const r of c.firewall.rules) {
    const p = `firewall.rules.${r.id}`;
    if (ids.has(r.id)) err(p, `Two rules have the id ${r.id}`);
    ids.add(r.id);
    if (!zones.has(r.from) || r.from === 'gate') err(p, `"${r.name}": traffic cannot come from ${r.from}`);
    if (!zones.has(r.to)) err(p, `"${r.name}": there is no zone ${r.to}`);
    if (r.from === r.to && r.from !== 'any') warn(p, `"${r.name}": traffic inside ${r.from} does not pass the gate`);
    if (r.ports && !['tcp', 'udp', 'tcp+udp'].includes(r.proto)) err(p, `"${r.name}": ports need TCP or UDP`);
    if (r.action === 'accept' && r.from === 'wan' && r.to === 'gate' && (!r.source || !isPrivateIP(r.source.split('/')[0])) && (!r.ports || portRanges(r.ports).some(([a, b]) => a <= 22 && 22 <= b)) && ['tcp', 'tcp+udp', 'any'].includes(r.proto))
      warn(p, `"${r.name}" opens SSH to ${r.source ? r.source : 'the whole internet'}`);
  }
  const fids = new Set<string>();
  const used: Array<{ proto: string; ranges: Array<[number, number]>; name: string }> = [];
  for (const f of c.firewall.forwards) {
    const p = `firewall.forwards.${f.id}`;
    if (fids.has(f.id) || ids.has(f.id)) err(p, `The id ${f.id} is used twice`);
    fids.add(f.id);
    const into = c.networks.find((n) => inCidr(f.to, n.address));
    if (!into) err(p, `"${f.name}": ${f.to} is not in any of the gate’s networks`);
    else if (f.to === into.address.split('/')[0]) err(p, `"${f.name}": ${f.to} is the gate itself`);
    const ranges = portRanges(f.port);
    if (f.toPort && (ranges.length > 1 || ranges[0][0] !== ranges[0][1])) err(p, `"${f.name}": a different inside port needs a single outside port`);
    for (const u of used) if ((u.proto === f.proto || u.proto === 'tcp+udp' || f.proto === 'tcp+udp') && rangesOverlap(u.ranges, ranges)) err(p, `"${f.name}" and "${u.name}" both forward port ${f.port}`);
    used.push({ proto: f.proto, ranges, name: f.name });
    if (c.vpn.enabled && f.proto !== 'tcp' && rangesOverlap(ranges, [[c.vpn.port, c.vpn.port]])) err(p, `"${f.name}" takes the VPN’s port ${c.vpn.port}`);
  }

  // ------------------------------------------------------------------------------------------------ DNS
  const recs = new Set<string>();
  for (const r of c.dns.records) {
    if (recs.has(r.name.toLowerCase())) err(`dns.records.${r.name}`, `${r.name} is listed twice`);
    recs.add(r.name.toLowerCase());
  }
  if (c.dns.block.enabled && !c.dns.block.lists.length && !c.dns.block.domains.length) warn('dns.block', 'Blocking is on but no list or domain is given');

  // ------------------------------------------------------------------------------------------------ VPN
  if (c.vpn.enabled) {
    const keys = new Set<string>();
    const peerAddrs = new Set<string>();
    const gw = c.vpn.address.split('/')[0];
    for (const peer of c.vpn.peers) {
      const p = `vpn.peers.${peer.name}`;
      if (keys.has(peer.publicKey)) err(p, `${peer.name} has the same key as another device`);
      keys.add(peer.publicKey);
      if (!inCidr(peer.address, c.vpn.address)) err(p, `${peer.address} is not in the VPN network ${networkOf(c.vpn.address)}`);
      if (peer.address === gw) err(p, `${peer.address} is the gate’s own VPN address`);
      if (peerAddrs.has(peer.address)) err(p, `${peer.address} is given to two devices`);
      peerAddrs.add(peer.address);
    }
    if (!c.vpn.peers.length) warn('vpn', 'The VPN is on but no device can use it yet');
  }

  // ------------------------------------------------------------------------------------------------ QoS
  for (const n of c.qos.preferMesh.networks) if (!names.has(n)) err('qos.preferMesh.networks', `There is no network ${n}`);
  if (c.qos.enabled && c.qos.preferMesh.enabled && c.qos.preferMesh.networks.length === 0 && c.networks.some((n) => n.purpose === 'mesh')) warn('qos.preferMesh', 'There is a mesh network: add it to Prefer Mesh so all its traffic goes first');

  // -------------------------------------------------------------------------------------- management
  if (!c.networks.some((n) => n.manage)) warn('management', 'No network may reach the gate’s console: you can only manage it from its own screen');

  return { ok: errors.length === 0, errors, warnings, config: c };
}
