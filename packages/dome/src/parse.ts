import type { DomeEvent } from './types';

/**
 * One line of dnsmasq's log (log-queries=extra, as FBRX Gate sets it up):
 *   Oct  7 05:42:01 dnsmasq[812]: 17 192.168.1.23/53001 query[A] example.com from 192.168.1.23
 *   Oct  7 05:42:01 dnsmasq[812]: 17 192.168.1.23/53001 reply nope.example is NXDOMAIN
 * Plain log-queries lines (without the request number and client) work too.
 */
export function parseDnsmasqLine(line: string, at = Date.now()): DomeEvent | null {
  const q = /query\[([A-Za-z0-9]+)\]\s+(\S+)\s+from\s+([0-9a-fA-F:.]+)/.exec(line);
  if (q) return { type: 'dns', at, qtype: q[1].toUpperCase(), name: q[2].toLowerCase().replace(/\.$/, ''), client: q[3] };
  const r = /(?:\s(\d+\.\d+\.\d+\.\d+)\/\d+\s+)?reply\s+(\S+)\s+is\s+NXDOMAIN/.exec(line);
  if (r) return { type: 'nxdomain', at, client: r[1] ?? null, name: r[2].toLowerCase().replace(/\.$/, '') };
  return null;
}

/**
 * A connection from conntrack: an event line (conntrack -E: "[NEW] tcp 6 120 SYN_SENT src=… dst=… sport=… dport=…"),
 * a listing line (conntrack -L) or /proc/net/nf_conntrack ("ipv4 2 tcp 6 …"). The first src/dst/dport are the
 * original direction.
 */
export function parseConntrackLine(line: string, at = Date.now()): Extract<DomeEvent, { type: 'flow' }> | null {
  const proto = /(?:^|\s)(tcp|udp)\s+\d+\s/.exec(line)?.[1] as 'tcp' | 'udp' | undefined;
  if (!proto) return null;
  const src = /\bsrc=(\S+)/.exec(line)?.[1];
  const dst = /\bdst=(\S+)/.exec(line)?.[1];
  const dport = Number(/\bdport=(\d+)/.exec(line)?.[1]);
  if (!src || !dst || !dport) return null;
  return { type: 'flow', at, proto, src, dst, dport };
}

/** The gate's neighbor table (ip -j neigh): addresses with their hardware addresses. */
export function parseNeighbors(json: string, at = Date.now()): Array<Extract<DomeEvent, { type: 'neighbor' }>> {
  let rows: Array<{ dst?: string; dev?: string; lladdr?: string; state?: string[] }> = [];
  try {
    rows = JSON.parse(json);
  } catch {
    return [];
  }
  return rows
    .filter((r) => r.dst && r.lladdr && /^\d+\.\d+\.\d+\.\d+$/.test(r.dst) && !(r.state ?? []).some((s) => s === 'FAILED' || s === 'INCOMPLETE'))
    .map((r) => ({ type: 'neighbor' as const, at, ip: r.dst!, mac: r.lladdr!.toLowerCase(), dev: r.dev ?? null }));
}
