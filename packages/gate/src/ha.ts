import { isIPv4, networkOf, parseCidr } from '@fbrx/shared';
import { netDevice, type GateConfig } from './model';

/**
 * FBRX Gate in a high-availability pair (two FBRX Servers). Both servers keep the same configuration (the standby's
 * is a copy); what moves to the active one is each network's gateway address and the internet port:
 *
 * - each network's gateway address lives on a small link of its own (a macvlan on the network's port, VLAN or
 *   switch) with a virtual MAC address from VRRP's range, up only on the active server; since the address keeps its
 *   MAC, devices' ARP caches stay right, and the link announces itself when it comes up so switches learn where it is;
 * - the internet port carries a virtual MAC address too and is up only on the active server, so the provider (and a
 *   DHCP lease from it) sees the same machine whichever server it is;
 * - each server has an address of its own in each network, for the pair to talk and for managing it.
 *
 * DHCP and DNS (dnsmasq) answer on the gateway links, on the active server only, with the leases copied over.
 */
export interface GateHa {
  /** This server's own address in each network (by network name), with its size: 192.168.50.2/24. */
  own: Record<string, string>;
  /** The pair's number for its virtual MAC addresses (1 to 200, the same on both servers). */
  vrid: number;
  /** The heartbeat's UDP port, let in from the networks and the dedicated link. */
  heartbeatPort: number;
  /** The dedicated link's interface, when the pair has one (outside the gate's ports). */
  link: string | null;
  /** The partner's addresses, let in to this console. */
  partner: string[];
  /**
   * Where the open connections go to the partner (conntrackd): the dedicated link, or else a network, with this
   * server's address and the partner's there. Null: connections are not kept in step (a takeover breaks downloads).
   */
  sync: { iface: string; own: string; partner: string } | null;
}

/** The link that holds a network's gateway address (the nth network). */
export const haVip = (index: number) => `fbrxv${index}`;

/** A virtual MAC address from VRRP's range (00:00:5e:00:01:xx): slot 0 is the internet port, then each network. */
export function haMac(vrid: number, slot: number): string {
  const n = ((vrid + slot - 1) % 255) + 1;
  return `00:00:5e:00:01:${n.toString(16).padStart(2, '0')}`;
}

export interface GateHaLink {
  network: string;
  /** The gateway link, and the port, VLAN or switch it sits on. */
  dev: string;
  parent: string;
  mac: string;
  /** The gateway address it holds, and this server's own address on the parent. */
  address: string;
  own: string;
}

/** The gateway links of a configuration. */
export function haLinks(c: GateConfig, ha: GateHa): GateHaLink[] {
  return c.networks.map((n, i) => ({ network: n.name, dev: haVip(i), parent: netDevice(n), mac: haMac(ha.vrid, i + 1), address: n.address, own: ha.own[n.name] ?? '' }));
}

/** Each network's device and its gateway link, for the firewall and DHCP. */
export function haAliases(c: GateConfig, ha: GateHa | null | undefined): Map<string, string> {
  return new Map(ha ? haLinks(c, ha).map((l) => [l.parent, l.dev]) : []);
}

/** What is missing or wrong for the gate to be part of the pair (null: ready). */
export function haProblem(c: GateConfig, ha: GateHa): string | null {
  for (const n of c.networks) {
    const own = ha.own[n.name];
    if (!own) return `Give this server an address of its own in ${n.name} (${networkOf(n.address)})`;
    const p = parseCidr(own);
    if (!p || p.family !== 4 || !isIPv4(own.split('/')[0]!)) return `${own} is not an IPv4 address with its size (like 192.168.50.2/24)`;
    if (networkOf(own) !== networkOf(n.address)) return `${own} is not in ${n.name} (${networkOf(n.address)})`;
    if (own.split('/')[0] === n.address.split('/')[0]) return `${own.split('/')[0]} is ${n.name}'s gateway address, which moves between the two: give this server another`;
  }
  return null;
}
