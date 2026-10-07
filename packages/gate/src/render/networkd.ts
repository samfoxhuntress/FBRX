import type { GateConfig } from '../model';
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
      if (net) lines.push(`Address=${net.address}`);
      lines.push('ConfigureWithoutCarrier=yes', 'IPv6AcceptRA=no', 'LinkLocalAddressing=no');
    }
    files.push({ name: `10-fbrx-${i.name}.network`, mode: 0o644, content: `${lines.join('\n')}\n` });
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
  for (const n of c.networks) plan.push(['addr', 'flush', 'dev', n.interface, 'scope', 'global'], ['addr', 'add', n.address, 'dev', n.interface]);
  if (c.wan.mode === 'static' && c.wan.address && c.wan.gateway) {
    plan.push(['addr', 'flush', 'dev', c.wan.interface, 'scope', 'global'], ['addr', 'add', c.wan.address, 'dev', c.wan.interface], ['route', 'replace', 'default', 'via', c.wan.gateway, 'dev', c.wan.interface]);
  }
  return plan;
}

/** Kernel settings: the gate routes IPv4 (IPv6 routing comes later). */
export function renderSysctl(): Array<[string, string]> {
  return [['net.ipv4.ip_forward', '1']];
}
