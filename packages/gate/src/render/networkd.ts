import { bridgeName, netDevice, type GateConfig } from '../model';
import { haLinks, haMac, type GateHa } from '../ha';
import { WG_IFACE } from './nftables';
import type { GatePaths } from './paths';

export interface NetworkdFile {
  /** In /etc/systemd/network. */
  name: string;
  content: string;
  /** Readable by systemd-networkd only (the VPN key is referenced, never written here). */
  mode: number;
}

const HEAD = '# Made by FBRX Gate from its configuration: changes here are overwritten.';

/**
 * systemd-networkd files: the ports, VLANs and addresses, kept across restarts. In a high-availability pair each
 * network's port (or switch) has this server's own address and a gateway link (a macvlan with a virtual MAC) that
 * holds the gateway address; the gateway links and the internet port are switched on by hand (ActivationPolicy=manual),
 * on the active server only.
 */
export function renderNetworkd(c: GateConfig, paths: GatePaths, ha?: GateHa | null): NetworkdFile[] {
  const files: NetworkdFile[] = [];
  const nets = new Map(c.networks.map((n) => [n.interface, n]));
  const vips = new Map(ha ? haLinks(c, ha).map((l) => [l.network, l]) : []);
  // The address a network's port or switch holds: the gateway's, or in a pair this server's own (and its gateway link).
  const addressLines = (n: GateConfig['networks'][number]) => {
    const v = vips.get(n.name);
    return v ? [...(v.own ? [`Address=${v.own}`] : []), `MACVLAN=${v.dev}`] : [`Address=${n.address}`];
  };
  for (const i of c.interfaces) {
    if (i.kind === 'vlan') files.push({ name: `10-fbrx-${i.name}.netdev`, mode: 0o644, content: [HEAD, '[NetDev]', `Name=${i.name}`, 'Kind=vlan', `MTUBytes=${i.mtu}`, '', '[VLAN]', `Id=${i.vlanId}`, ''].join('\n') });
    const net = nets.get(i.name);
    const vlans = c.interfaces.filter((v) => v.kind === 'vlan' && v.parent === i.name).map((v) => `VLAN=${v.name}`);
    // Only the internet side holds back "the network is up" at boot (a LAN port without a cable must not).
    const wanHa = ha && i.name === c.wan.interface ? [`MACAddress=${haMac(ha.vrid, 0)}`, 'ActivationPolicy=manual'] : [];
    const lines = [HEAD, '[Match]', `Name=${i.name}`, '', '[Link]', `MTUBytes=${i.mtu}`, ...wanHa, ...(i.name === c.wan.interface ? [] : ['RequiredForOnline=no']), '', '[Network]', ...vlans];
    if (i.name === c.wan.interface) {
      if (c.wan.mode === 'dhcp') lines.push('DHCP=ipv4');
      else lines.push(`Address=${c.wan.address}`, `Gateway=${c.wan.gateway}`);
      lines.push('IPv6AcceptRA=no', 'LinkLocalAddressing=no');
      if (c.wan.mode === 'dhcp') lines.push('', '[DHCPv4]', 'UseDNS=no', 'UseNTP=yes');
    } else {
      // A network machines may join: the port (or VLAN) is one more port on its bridge, which holds the address.
      if (net?.vmSwitch) lines.push(`Bridge=${bridgeName(net)}`);
      else if (net) lines.push(...addressLines(net));
      lines.push('ConfigureWithoutCarrier=yes', 'IPv6AcceptRA=no', 'LinkLocalAddressing=no');
    }
    files.push({ name: `10-fbrx-${i.name}.network`, mode: 0o644, content: `${lines.join('\n')}\n` });
  }
  // The virtual switches: no spanning tree and no forwarding delay, so a machine is on the network as it starts.
  for (const n of c.networks.filter((x) => x.vmSwitch)) {
    const br = bridgeName(n);
    const mtu = c.interfaces.find((i) => i.name === n.interface)?.mtu ?? 1500;
    files.push({ name: `10-fbrx-${br}.netdev`, mode: 0o644, content: [HEAD, '[NetDev]', `Name=${br}`, 'Kind=bridge', `MTUBytes=${mtu}`, '', '[Bridge]', 'STP=no', 'ForwardDelaySec=0', ''].join('\n') });
    files.push({
      name: `10-fbrx-${br}.network`,
      mode: 0o644,
      content: [HEAD, '[Match]', `Name=${br}`, '', '[Link]', `MTUBytes=${mtu}`, 'RequiredForOnline=no', '', '[Network]', ...addressLines(n), 'ConfigureWithoutCarrier=yes', 'IPv6AcceptRA=no', 'LinkLocalAddressing=no', ''].join('\n'),
    });
  }
  // The gateway links: up on the active server only.
  for (const v of vips.values()) {
    files.push({ name: `10-fbrx-${v.dev}.netdev`, mode: 0o644, content: [HEAD, '[NetDev]', `Name=${v.dev}`, 'Kind=macvlan', `MACAddress=${v.mac}`, '', '[MACVLAN]', 'Mode=bridge', ''].join('\n') });
    files.push({
      name: `10-fbrx-${v.dev}.network`,
      mode: 0o644,
      content: [HEAD, '[Match]', `Name=${v.dev}`, '', '[Link]', 'ActivationPolicy=manual', 'RequiredForOnline=no', '', '[Network]', `Address=${v.address}`, 'ConfigureWithoutCarrier=yes', 'IPv6AcceptRA=no', 'LinkLocalAddressing=no', ''].join('\n'),
    });
  }
  if (c.vpn.enabled) {
    const netdev = [HEAD, '[NetDev]', `Name=${WG_IFACE}`, 'Kind=wireguard', '', '[WireGuard]', `PrivateKeyFile=${paths.etcDir}/wg-fbrx.key`, `ListenPort=${c.vpn.port}`];
    for (const p of c.vpn.peers) netdev.push('', '[WireGuardPeer]', `# ${p.name}`, `PublicKey=${p.publicKey}`, `AllowedIPs=${p.address}/32`, ...(p.keepalive ? [`PersistentKeepalive=${p.keepalive}`] : []));
    files.push({ name: `10-fbrx-${WG_IFACE}.netdev`, mode: 0o640, content: `${netdev.join('\n')}\n` });
    files.push({ name: `10-fbrx-${WG_IFACE}.network`, mode: 0o644, content: [HEAD, '[Match]', `Name=${WG_IFACE}`, '', '[Link]', 'RequiredForOnline=no', '', '[Network]', `Address=${c.vpn.address}`, ''].join('\n') });
  }
  return files;
}

/**
 * The same, as ip commands applied right away (for systems without systemd-networkd, and the network-namespace
 * tests). A WAN on DHCP is left to the system's own DHCP client.
 */
export function renderIpPlan(c: GateConfig, ha?: GateHa | null): string[][] {
  const plan: string[][] = [];
  // In a pair the internet port has the pair's virtual MAC address and is switched on with the gateway links.
  for (const i of c.interfaces.filter((x) => x.kind === 'ethernet')) {
    plan.push(['link', 'set', 'dev', i.name, 'mtu', String(i.mtu)]);
    if (ha && i.name === c.wan.interface) plan.push(['link', 'set', 'dev', i.name, 'address', haMac(ha.vrid, 0)]);
    else plan.push(['link', 'set', 'dev', i.name, 'up']);
  }
  for (const i of c.interfaces.filter((x) => x.kind === 'vlan')) plan.push(['link', 'add', 'link', i.parent!, 'name', i.name, 'type', 'vlan', 'id', String(i.vlanId)], ['link', 'set', 'dev', i.name, 'mtu', String(i.mtu)], ['link', 'set', 'dev', i.name, 'up']);
  for (const n of c.networks.filter((x) => x.vmSwitch)) {
    const br = bridgeName(n);
    const mtu = String(c.interfaces.find((i) => i.name === n.interface)?.mtu ?? 1500);
    plan.push(
      ['link', 'add', 'name', br, 'type', 'bridge', 'stp_state', '0', 'forward_delay', '0'],
      ['link', 'set', 'dev', br, 'mtu', mtu],
      ['addr', 'flush', 'dev', n.interface, 'scope', 'global'],
      ['link', 'set', 'dev', n.interface, 'master', br],
      ['link', 'set', 'dev', br, 'up'],
    );
  }
  // A port or VLAN no longer on a switch leaves it (its bridge is deleted with the change, see linkNames).
  for (const n of c.networks.filter((x) => !x.vmSwitch)) plan.push(['link', 'set', 'dev', n.interface, 'nomaster']);
  if (ha) {
    // Each port or switch: this server's own address; its gateway link (left as it is: up on the active server only).
    for (const v of haLinks(c, ha)) {
      plan.push(['addr', 'flush', 'dev', v.parent, 'scope', 'global'], ...(v.own ? [['addr', 'add', v.own, 'dev', v.parent]] : []));
      plan.push(['link', 'add', 'link', v.parent, 'name', v.dev, 'address', v.mac, 'type', 'macvlan', 'mode', 'bridge'], ['addr', 'flush', 'dev', v.dev, 'scope', 'global'], ['addr', 'add', v.address, 'dev', v.dev]);
    }
  } else for (const n of c.networks) plan.push(['addr', 'flush', 'dev', netDevice(n), 'scope', 'global'], ['addr', 'add', n.address, 'dev', netDevice(n)]);
  if (c.wan.mode === 'static' && c.wan.address && c.wan.gateway) {
    plan.push(['addr', 'flush', 'dev', c.wan.interface, 'scope', 'global'], ['addr', 'add', c.wan.address, 'dev', c.wan.interface]);
    // In a pair the route comes when the port is switched on.
    if (!ha) plan.push(['route', 'replace', 'default', 'via', c.wan.gateway, 'dev', c.wan.interface]);
  }
  return plan;
}

/** The links an ip plan creates (VLANs and virtual switches), so the next change can remove the ones it no longer has. */
export function linkNames(plan: string[][]): Set<string> {
  return new Set(plan.filter((a) => a[0] === 'link' && a[1] === 'add').map((a) => a[a.indexOf('name') + 1]));
}

/**
 * Kernel settings: the gate routes IPv4 (IPv6 routing comes later). In a high-availability pair each port answers ARP
 * only for its own addresses (otherwise the standby's port would answer for the gateway address it keeps switched
 * off, and devices would send it their traffic).
 */
export function renderSysctl(ha?: GateHa | null): Array<[string, string]> {
  return [['net.ipv4.ip_forward', '1'], ...(ha ? ([['net.ipv4.conf.all.arp_ignore', '1'], ['net.ipv4.conf.all.arp_announce', '2']] as Array<[string, string]>) : [])];
}
