import type { GateConfig } from '../model';
import type { GateHa } from '../ha';
import { renderDnsmasq } from './dnsmasq';
import { CONNTRACKD_PORT, renderConntrackd } from './conntrackd';
import { linkNames, renderIpPlan, renderNetworkd, renderSysctl, type NetworkdFile } from './networkd';
import { renderNftables } from './nftables';
import type { GatePaths } from './paths';
import { renderQos, type QosPlan } from './qos';

export interface GateRendered {
  nftables: string;
  dnsmasq: string;
  networkd: NetworkdFile[];
  ip: string[][];
  sysctl: Array<[string, string]>;
  qos: QosPlan | null;
  /** Blocklists to fetch into the blocklist file. */
  blocklists: string[];
  /** conntrackd's settings, in a high-availability pair (null otherwise). */
  conntrackd: string | null;
}

/** Everything a configuration turns into (on a server of a high-availability pair, with the pair's links). */
export function render(c: GateConfig, paths: GatePaths, ha?: GateHa | null): GateRendered {
  return {
    nftables: renderNftables(c, ha),
    dnsmasq: renderDnsmasq(c, paths, ha),
    networkd: renderNetworkd(c, paths, ha),
    ip: renderIpPlan(c, ha),
    sysctl: renderSysctl(ha),
    qos: renderQos(c),
    blocklists: c.dns.block.enabled ? c.dns.block.lists : [],
    conntrackd: ha ? renderConntrackd(c, ha, paths) : null,
  };
}

export { CONNTRACKD_PORT, renderConntrackd };
export { linkNames, renderDnsmasq, renderNetworkd, renderIpPlan, renderNftables, renderQos, renderSysctl };
export type { NetworkdFile, QosPlan };
