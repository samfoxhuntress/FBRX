import type { ServerNetworkReport } from '@fbrx/shared';
import type { SavedServers } from '../../system/saved-servers';
import type { ToolSpec } from '../types';

const ago = (iso: string | null, now: number) => {
  if (!iso) return 'never';
  const m = Math.round((now - Date.parse(iso)) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

/** The report as Fabrix reads it: what matters for troubleshooting first, in plain lines. */
export function describeNetworkReport(name: string, r: ServerNetworkReport, now = Date.now()): string {
  const out: string[] = [`${name} (${r.server.product} ${r.server.version}; roles: ${r.server.roles.join(', ') || 'none'}), checked ${ago(r.at, now)}.`];
  const mem = r.server.memory ? `, memory ${(r.server.memory.usedMb / 1024).toFixed(1)} of ${(r.server.memory.totalMb / 1024).toFixed(1)} GB` : '';
  out.push(`Server: processor ${r.server.cpuPct ?? '?'}%${mem}${r.server.uptimeSeconds ? `, up ${Math.round(r.server.uptimeSeconds / 3600)} h` : ''}.`);
  for (const w of r.server.warnings) out.push(`Server warning: ${w}`);

  const g = r.gate;
  if (!g) out.push('', 'FBRX Gate: not on this server.');
  else {
    out.push('', `FBRX Gate${g.mode === 'simulated' ? ' (simulated: nothing on the network really changes)' : ''}:`);
    if (!g.committed) out.push('- It has no settings in place yet (nothing was committed).');
    if (g.confirmPending) out.push(`- IMPORTANT: a change is waiting to be confirmed and rolls itself back at ${g.confirmPending.deadline} unless someone confirms it (FBRX Server → Gate → Changes).`);
    const w = g.wan;
    out.push(`- Internet side (${w.interface}${w.mode ? `, ${w.mode === 'dhcp' ? 'address from the provider' : 'fixed address'}` : ''}): ${w.up === null ? 'state unknown' : w.up ? 'link up' : 'LINK DOWN (cable, modem or the provider)'}; address ${w.address ?? 'NONE'}; router ${w.gateway ?? 'NONE'}.`);
    if (g.lastCommit) out.push(`- Last change: ${g.lastCommit.status} ${ago(g.lastCommit.at, now)} by ${g.lastCommit.by}${g.lastCommit.comment ? ` ("${g.lastCommit.comment}")` : ''}${g.lastCommit.error ? `; error: ${g.lastCommit.error}` : ''}.`);
    if (g.uncommittedChanges) out.push(`- ${g.uncommittedChanges} change${g.uncommittedChanges === 1 ? ' is' : 's are'} being edited and not in place yet.`);
    if (g.networks.length) out.push(`- Networks: ${g.networks.map((n) => `${n.name} (${n.purpose}, ${n.address} on ${n.interface}${n.dhcp ? ', DHCP on' : ', no DHCP'})`).join('; ')}.`);
    const down = g.interfaces.filter((i) => !i.up && !/^(lo|ifb|veth)/.test(i.name));
    if (down.length) out.push(`- Ports down: ${down.map((i) => i.name).join(', ')}.`);
    out.push(`- DHCP: ${g.leases ?? '?'} device${g.leases === 1 ? ' has' : 's have'} an address. DNS: ${g.dns.running === null ? 'unknown' : g.dns.running ? 'running' : 'NOT RUNNING (devices cannot look names up)'}${g.dns.blocking ? ', blocking unwanted names' : ''}. Connections: ${g.connections ?? '?'}. VPN peers: ${g.vpnPeers ?? 0}.`);
    for (const p of g.problems) out.push(`- Problem the gate found: ${p}`);
    for (const e of g.errors) out.push(`- Error in its settings: ${e}`);
    for (const e of g.warnings) out.push(`- Warning in its settings: ${e}`);
  }

  const d = r.dome;
  if (!d) out.push('', 'FBRX MiniDome: not on this server.');
  else {
    const open = Object.entries(d.open).filter(([, n]) => n > 0);
    out.push('', 'FBRX MiniDome:');
    out.push(`- Open findings: ${open.length ? open.map(([s, n]) => `${n} ${s}`).join(', ') : 'none'}. ${d.devices} devices seen; ${d.dnsQueries} names asked lately.`);
    if (d.learningUntil && Date.parse(d.learningUntil) > now) out.push(`- Still learning the network until ${d.learningUntil} (new devices are not reported yet).`);
    const bad = d.sensors.filter((s) => !s.ok);
    out.push(`- Sensors: ${bad.length ? bad.map((s) => `${s.name} NOT WORKING (${s.detail})`).join('; ') : 'all working'}.`);
    out.push(`- Threat lists: updated ${ago(d.feedUpdatedAt, now)}${d.feedErrors.length ? `; errors: ${d.feedErrors.join('; ')}` : ''}.`);
    if (d.findings.length) {
      out.push('- Worst open findings:');
      for (const f of d.findings) out.push(`  - [${f.severity}] ${f.title}${f.subject ? ` (${f.subject})` : ''}, ${f.count} time${f.count === 1 ? '' : 's'}, last ${ago(f.lastAt, now)}: ${f.detail}`);
    }
  }
  return out.join('\n');
}

/**
 * Troubleshooting through FBRX Server: what the person's own server sees of the network (FBRX Gate and MiniDome),
 * read with the read-only access they gave Fabrix there (FBRX Server → Let Fabrix look).
 */
export function serverTools(servers: SavedServers): ToolSpec[] {
  return [
    {
      name: 'server.network_check',
      title: 'Check the network through FBRX Server',
      description:
        "Look at the network from the person's FBRX Server: FBRX Gate (its internet side, networks, DHCP, DNS, a change waiting to be confirmed, problems it found) and FBRX MiniDome (its sensors and the worst open findings). Use it when troubleshooting the network or the internet. Read-only.",
      risk: 'read',
      source: 'builtin',
      sourceId: null,
      inputSchema: { type: 'object', properties: { server: { type: 'string', maxLength: 120, description: 'Which server, by name (optional when there is one)' } } },
      unavailable: () => (servers.looking().length ? null : 'No FBRX Server lets Fabrix look at it yet (FBRX Server → the server → Let Fabrix look)'),
      timeoutMs: 30_000,
      async run(i) {
        const { server, report } = await servers.networkReport(i.server);
        return { output: describeNetworkReport(server.name, report), data: report };
      },
    },
  ];
}
