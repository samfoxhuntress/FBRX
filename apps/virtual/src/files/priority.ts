import { readFileSync } from 'node:fs';
import { FILES_PORTS, isIPv4, type MeshTrafficClass } from '@fbrx/shared';
import type { NftRunner } from '../mesh-mark';

const PORTS = `{ ${FILES_PORTS.join(', ')} }`;

/**
 * The nftables tables that give the file server's traffic priority: SMB and NFS marked with a DSCP class, so switches
 * that honor it and FBRX Gate's traffic shaping let it go first. On this server: what its shares send. For a virtual
 * machine: its traffic as it passes through the server, routed (a NAT network or a gate network) or bridged (br0).
 * Each table replaces itself.
 */
export function filesPriorityNft(cls: MeshTrafficClass, vmAddress: string | null): { inet: string; bridge: string | null } {
  const vm = vmAddress && isIPv4(vmAddress) ? vmAddress : null;
  const forward = (indent: string) =>
    vm
      ? [`${indent}ip saddr ${vm} tcp sport ${PORTS} ip dscp set ${cls}`, `${indent}ip daddr ${vm} tcp dport ${PORTS} ip dscp set ${cls}`]
      : [];
  const inet = [
    'table inet fbrx_files',
    'delete table inet fbrx_files',
    'table inet fbrx_files {',
    '  # FBRX file server: its traffic goes first on switches and FBRX Gate.',
    ...(vm
      ? ['  chain mark_forward {', '    type filter hook forward priority mangle; policy accept;', ...forward('    '), '  }']
      : ['  chain mark_out {', '    type filter hook output priority mangle; policy accept;', `    tcp sport ${PORTS} ip dscp set ${cls}`, `    tcp sport ${PORTS} ip6 dscp set ${cls}`, '  }']),
    '}',
    '',
  ].join('\n');
  const bridge = vm
    ? ['table bridge fbrx_files', 'delete table bridge fbrx_files', 'table bridge fbrx_files {', '  chain mark_forward {', '    type filter hook forward priority 0; policy accept;', ...forward('    '), '  }', '}', ''].join('\n')
    : null;
  return { inet, bridge };
}

export const FILES_PRIORITY_REMOVE = { inet: 'table inet fbrx_files\ndelete table inet fbrx_files\n', bridge: 'table bridge fbrx_files\ndelete table bridge fbrx_files\n' };

/** nft for development and tests: keeps the tables it is given, and lists them back. */
export function memoryNft(): NftRunner & { tables: Map<string, string> } {
  const tables = new Map<string, string>();
  const runner = (async (args: string[]) => {
    if (args[0] === '-f') {
      const text = readFileSync(args[1]!, 'utf8');
      for (const fam of ['inet', 'bridge']) {
        const name = new RegExp(`^table ${fam} (\\S+) \\{`, 'm').exec(text)?.[1];
        const deleted = new RegExp(`^delete table ${fam} (\\S+)$`, 'm').exec(text)?.[1];
        if (deleted) tables.delete(`${fam} ${deleted}`);
        if (name) tables.set(`${fam} ${name}`, text.slice(text.indexOf(`table ${fam} ${name} {`)));
      }
      return { code: 0, out: '', err: '' };
    }
    if (args[0] === 'list' && args[1] === 'table') {
      const t = tables.get(`${args[2]} ${args[3]}`);
      return t ? { code: 0, out: t, err: '' } : { code: 1, out: '', err: 'Error: No such file or directory' };
    }
    return { code: 0, out: '', err: '' };
  }) as NftRunner & { tables: Map<string, string> };
  runner.tables = tables;
  return runner;
}
