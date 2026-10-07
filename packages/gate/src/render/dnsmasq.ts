import { networkOf, prefixToMask, parseCidr } from '@fbrx/shared';
import type { GateConfig } from '../model';
import { WG_IFACE } from './nftables';
import type { GatePaths } from './paths';

/** dnsmasq: DHCP for each network, DNS for all of them (local names, blocking, a question log for MiniDome). */
export function renderDnsmasq(c: GateConfig, paths: GatePaths): string {
  const L: string[] = [
    '# FBRX Gate: DHCP and DNS. Made by FBRX Gate from its configuration: changes here are overwritten.',
    'port=53',
    'domain-needed',
    'bogus-priv',
    'no-resolv',
    'no-poll',
    ...c.dns.upstream.map((s) => `server=${s}`),
    `local=/${c.dns.domain}/`,
    `domain=${c.dns.domain}`,
    'expand-hosts',
    'bind-dynamic',
    ...c.networks.map((n) => `interface=${n.interface}`),
    ...(c.vpn.enabled ? [`interface=${WG_IFACE}`] : []),
    'cache-size=10000',
    'dhcp-authoritative',
    `dhcp-leasefile=${paths.varDir}/dnsmasq.leases`,
  ];
  for (const n of c.networks) {
    const gw = n.address.split('/')[0];
    const mask = prefixToMask(parseCidr(n.address)!.prefix);
    L.push(`# ${n.name}: ${networkOf(n.address)} on ${n.interface}`);
    if (n.dhcp.enabled) {
      L.push(`dhcp-range=set:${n.name},${n.dhcp.start},${n.dhcp.end},${mask},${n.dhcp.leaseHours}h`);
      L.push(`dhcp-option=tag:${n.name},option:router,${gw}`);
      L.push(`dhcp-option=tag:${n.name},option:dns-server,${gw}`);
      L.push(`dhcp-option=tag:${n.name},option:domain-search,${c.dns.domain}`);
    }
    for (const r of n.dhcp.reservations) L.push(`dhcp-host=${r.mac.toLowerCase()},${r.address}${r.name ? `,${r.name}` : ''}`);
  }
  // The gate answers to its own name in each network.
  for (const n of c.networks) L.push(`interface-name=${c.hostname}.${c.dns.domain},${n.interface}/4`);
  for (const r of c.dns.records) {
    const name = r.name.includes('.') ? r.name : `${r.name},${r.name}.${c.dns.domain}`;
    L.push(`host-record=${name},${r.address}`);
  }
  if (c.dns.block.enabled) {
    for (const d of c.dns.block.domains) L.push(`address=/${d}/0.0.0.0`, `address=/${d}/::`);
    if (c.dns.block.lists.length) L.push(`conf-file=${paths.varDir}/blocklist.conf`);
  }
  if (c.dns.logQueries) L.push('log-queries=extra', 'log-dhcp', `log-facility=${paths.logDir}/dnsmasq.log`);
  return `${L.join('\n')}\n`;
}
