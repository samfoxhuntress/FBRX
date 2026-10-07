import type { GateConfig } from '../model';

export const IFB = 'ifb-fbrx';

export interface QosPlan {
  wan: string;
  /** cake with four priority lanes by DSCP (EF/CS5 voice, AF4x video: where Prefer Mesh goes, best effort, bulk). */
  cake: string[][];
  /** The same lanes with HTB, for kernels without cake (egress only). Leaf qdiscs are added by the applier. */
  htb: { commands: string[][]; leaves: string[] };
  /** Removes all of it. */
  clear: string[][];
}

const kbit = (mbit: number, share = 1) => `${Math.max(8, Math.round(mbit * 1000 * share))}kbit`;

/** DSCP values (the whole TOS byte, masked 0xfc) that go in the priority class. */
const PRIORITY = { ef: 0xb8, cs5: 0xa0, af41: 0x88, af42: 0x90, af43: 0x98, cs4: 0x80 } as const;
const BULK = { cs1: 0x20 } as const;

/** Traffic shaping on the internet port, so the line never queues up and marked traffic goes first. */
export function renderQos(c: GateConfig): QosPlan | null {
  if (!c.qos.enabled) return null;
  const dev = c.wan.interface;
  const up = c.qos.upload;
  const cake: string[][] = [['qdisc', 'replace', 'dev', dev, 'root', 'cake', 'bandwidth', kbit(up), 'diffserv4', 'nat']];
  if (c.qos.download > 0) {
    cake.push(
      ['qdisc', 'replace', 'dev', dev, 'handle', 'ffff:', 'ingress'],
      ['filter', 'replace', 'dev', dev, 'parent', 'ffff:', 'protocol', 'all', 'prio', '10', 'matchall', 'action', 'mirred', 'egress', 'redirect', 'dev', IFB],
      ['qdisc', 'replace', 'dev', IFB, 'root', 'cake', 'bandwidth', kbit(c.qos.download), 'diffserv4', 'nat', 'ingress'],
    );
  }
  const htb: string[][] = [
    ['qdisc', 'replace', 'dev', dev, 'root', 'handle', '1:', 'htb', 'default', '20'],
    ['class', 'replace', 'dev', dev, 'parent', '1:', 'classid', '1:1', 'htb', 'rate', kbit(up), 'quantum', '1514'],
    ['class', 'replace', 'dev', dev, 'parent', '1:1', 'classid', '1:10', 'htb', 'rate', kbit(up, 0.3), 'ceil', kbit(up), 'prio', '0', 'quantum', '1514'],
    ['class', 'replace', 'dev', dev, 'parent', '1:1', 'classid', '1:20', 'htb', 'rate', kbit(up, 0.6), 'ceil', kbit(up), 'prio', '1', 'quantum', '1514'],
    ['class', 'replace', 'dev', dev, 'parent', '1:1', 'classid', '1:30', 'htb', 'rate', kbit(up, 0.1), 'ceil', kbit(up), 'prio', '2', 'quantum', '1514'],
  ];
  let prio = 1;
  for (const v of Object.values(PRIORITY)) {
    htb.push(['filter', 'add', 'dev', dev, 'parent', '1:', 'protocol', 'ip', 'prio', String(prio++), 'u32', 'match', 'ip', 'dsfield', `0x${v.toString(16)}`, '0xfc', 'flowid', '1:10']);
  }
  for (const v of Object.values(BULK)) htb.push(['filter', 'add', 'dev', dev, 'parent', '1:', 'protocol', 'ip', 'prio', String(prio++), 'u32', 'match', 'ip', 'dsfield', `0x${v.toString(16)}`, '0xfc', 'flowid', '1:30']);
  return {
    wan: dev,
    cake,
    htb: { commands: htb, leaves: ['1:10', '1:20', '1:30'] },
    clear: [
      ['qdisc', 'del', 'dev', dev, 'root'],
      ['qdisc', 'del', 'dev', dev, 'ingress'],
    ],
  };
}
