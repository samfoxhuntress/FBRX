import { bridgeName, netDevice, type GateConfig } from '../model';
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

/** systemd-networkd files: the ports, VLANs and addresses, kept across restarts. */
export function renderNetworkd(c: GateConfig, paths: GatePaths): NetworkdFile[] {
  const files: NetworkdFile[] = [];
  const nets = new Map(c.networks.map((n) => [n.interface, n]));
  for (const i of c.interfaces) {
    if (i.kind === 'vlan') files.push({ name: `10-fbrx-${i.name}.netdev`, mode: 0o644, content: [HEAD, '[NetDev]', `Name=${i.name}`, 'Kind=vlan', `MTUBytes=${i.mtu}`, '', '[VLAN]', `Id=${i.vlanId}`, ''].join('\n') });
    const net = nets.get(i.name);
    const vlans = c.interfaces.filter((v) => v.kind === 'vlan' && v.parent === i.name).map((v) => `VLAN=${v.name}`);
    // Only the internet side holds back "the network is up" at boot (a LAN port without a cable must not).
    const lines = [HEAD, '[Match]', `Name=${i.name}`, '', '[Link]', `MTUBytes=${i.mtu}`, ...(i.name === c.wan.interface ? [] : ['RequiredForOnline=no']), '', '[Network]', ...vlans];
    if (i.name === c.wan.interface) {
      if (c.wan.mode === 'dhcp') lines.push('DHCP=ipv4');
      else lines.push(`Address=${c.wan.address}`, `Gateway=${c.wan.gateway}`);
      lines.push('IPv6AcceptRA=no', 'LinkLocalAddressing=no');
      if (c.wan.mode === 'dhcp') lines.push('', '[DHCPv4]', 'UseDNS=no', 'UseNTP=yes');
    } else {
      // A network machines may join: the port (or VLAN) is one more port on its bridge, which holds the address.
      if (net?.vmSwitch) lines.push(`Bridge=${bridgeName(net)}`);
      else if (net) lines.push(`Address=${net.address}`);
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
      content: [HEAD, '[Match]', `Name=${br}`, '', '[Link]', `MTUBytes=${mtu}`, 'RequiredForOnline=no', '', '[Network]', `Address=${n.address}`, 'ConfigureWithoutCarrier=yes', 'IPv6AcceptRA=no', 'LinkLocalAddressing=no', ''].join('\n'),
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
export function renderIpPlan(c: GateConfig): string[][] {
  const plan: string[][] = [];
  for (const i of c.interfaces.filter((x) => x.kind === 'ethernet')) plan.push(['link', 'set', 'dev', i.name, 'mtu', String(i.mtu)], ['link', 'set', 'dev', i.name, 'up']);
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
  for (const n of c.networks) plan.push(['addr', 'flush', 'dev', netDevice(n), 'scope', 'global'], ['addr', 'add', n.address, 'dev', netDevice(n)]);
  if (c.wan.mode === 'static' && c.wan.address && c.wan.gateway) {
    plan.push(['addr', 'flush', 'dev', c.wan.interface, 'scope', 'global'], ['addr', 'add', c.wan.address, 'dev', c.wan.interface], ['route', 'replace', 'default', 'via', c.wan.gateway, 'dev', c.wan.interface]);
  }
  return plan;
}

/** The links an ip plan creates (VLANs and virtual switches), so the next change can remove the ones it no longer has. */
export function linkNames(plan: string[][]): Set<string> {
  return new Set(plan.filter((a) => a[0] === 'link' && a[1] === 'add').map((a) => a[a.indexOf('name') + 1]));
}

/** Kernel settings: the gate routes IPv4 (IPv6 routing comes later). */
export function renderSysctl(): Array<[string, string]> {
  return [['net.ipv4.ip_forward', '1']];
}
