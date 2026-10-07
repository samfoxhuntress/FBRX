import type { GateConfig } from '../model';
import { renderDnsmasq } from './dnsmasq';
import { renderIpPlan, renderNetworkd, renderSysctl, type NetworkdFile } from './networkd';
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
}

/** Everything a configuration turns into. */
export function render(c: GateConfig, paths: GatePaths): GateRendered {
  return {
    nftables: renderNftables(c),
    dnsmasq: renderDnsmasq(c, paths),
    networkd: renderNetworkd(c, paths),
    ip: renderIpPlan(c),
    sysctl: renderSysctl(),
    qos: renderQos(c),
    blocklists: c.dns.block.enabled ? c.dns.block.lists : [],
  };
}

export { renderDnsmasq, renderNetworkd, renderIpPlan, renderNftables, renderQos, renderSysctl };
export type { NetworkdFile, QosPlan };
