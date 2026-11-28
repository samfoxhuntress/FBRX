import { haLinks, type GateHa } from '../ha';
import type { GateConfig } from '../model';
import type { GatePaths } from './paths';

/** conntrackd's port between the two servers of a pair. */
export const CONNTRACKD_PORT = 3780;

/**
 * conntrackd for a high-availability pair: the firewall's table of open connections (with their NAT) sent to the
 * partner as it changes (FTFW: acknowledged, resent when lost), over the dedicated link or the network. On a takeover
 * the new active server puts what it was sent into its own table before its gateway links come up, so connections
 * carry on. The gate's own connections (to its addresses, the gateway addresses and the internet address) are left
 * out: they belong to one server.
 */
export function renderConntrackd(c: GateConfig, ha: GateHa, paths: GatePaths): string | null {
  if (!ha.sync) return null;
  const own = [
    '127.0.0.1',
    ...haLinks(c, ha).flatMap((l) => [l.address.split('/')[0]!, ...(l.own ? [l.own.split('/')[0]!] : [])]),
    ...(c.wan.mode === 'static' && c.wan.address ? [c.wan.address.split('/')[0]!] : []),
    ha.sync.own,
  ];
  return [
    '# FBRX Gate: open connections kept in step with the other server of the pair. Made by FBRX Gate: changes here are overwritten.',
    'Sync {',
    '  Mode FTFW {',
    '    DisableExternalCache Off',
    '    CommitTimeout 1800',
    '    PurgeTimeout 5',
    '  }',
    '  UDP {',
    `    IPv4_address ${ha.sync.own}`,
    `    IPv4_Destination_Address ${ha.sync.partner}`,
    `    Port ${CONNTRACKD_PORT}`,
    `    Interface ${ha.sync.iface}`,
    '    SndSocketBuffer 1249280',
    '    RcvSocketBuffer 1249280',
    '    Checksum on',
    '  }',
    '}',
    'General {',
    '  HashSize 32768',
    '  HashLimit 131072',
    '  LogFile off',
    '  Syslog on',
    `  LockFile ${paths.varDir}/conntrackd.lock`,
    '  UNIX {',
    `    Path ${paths.varDir}/conntrackd.ctl`,
    '  }',
    '  NetlinkBufferSize 2097152',
    '  NetlinkBufferSizeMaxGrowth 8388608',
    '  Filter From Userspace {',
    '    Protocol Accept {',
    '      TCP',
    '      UDP',
    '      ICMP',
    '    }',
    '    Address Ignore {',
    ...[...new Set(own)].map((a) => `      IPv4_address ${a}`),
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
}
