import type { FastifyInstance } from 'fastify';
import { DOME_SEVERITIES } from '@fbrx/dome';
import { need, type VirtualContext } from '../context';
import { hostInfo } from '../host';

/** How the worst open findings come first. */
const RANK = Object.fromEntries(DOME_SEVERITIES.map((s, i) => [s, DOME_SEVERITIES.length - i]));

/**
 * One look at the network from the server, for troubleshooting (Fabrix on a computer asks for it with its read-only
 * app access): the server's own warnings, FBRX Gate (its internet side, networks, DHCP, DNS, a change waiting to be
 * confirmed, problems it found) and FBRX MiniDome (its sensors and the worst open findings). Nothing secret: no keys,
 * no passwords, no VPN peers' keys.
 */
export async function troubleshootRoutes(app: FastifyInstance, ctx: VirtualContext): Promise<void> {
  app.get('/v1/troubleshoot', async (req) => {
    need(req, 'viewer');
    const host = await hostInfo(ctx.hv, ctx.version, ctx.config.sysRoot).catch(() => null);
    const server = {
      hostname: host?.hostname ?? null,
      product: host?.product ?? 'FBRX Virtual',
      version: ctx.version,
      roles: ctx.config.roles,
      uptimeSeconds: host?.uptimeSeconds ?? null,
      cpuPct: host?.cpuPct ?? null,
      memory: host?.memory ?? null,
      warnings: host?.warnings ?? [],
    };

    let gate = null;
    if (ctx.gate) {
      const st = ctx.gate.engine.state();
      const live = await ctx.gate.engine.live().catch((e: Error) => ({ error: e.message }) as const);
      const run = st.running;
      const wanIf = run?.wan.interface ?? st.candidate.wan.interface;
      const ok = !('error' in live);
      gate = {
        mode: ctx.gate.applier.kind,
        committed: !!run,
        uncommittedChanges: st.changes.length,
        confirmPending: st.confirm ? { deadline: st.confirm.deadline } : null,
        lastCommit: st.lastCommit ? { at: st.lastCommit.at, by: st.lastCommit.by, comment: st.lastCommit.comment, status: st.lastCommit.status, error: st.lastCommit.error } : null,
        errors: st.errors.map((e) => e.message),
        warnings: st.warnings.map((w) => w.message),
        wan: {
          interface: wanIf,
          mode: run?.wan.mode ?? null,
          up: ok ? (live.interfaces.find((i) => i.name === wanIf)?.up ?? null) : null,
          address: ok ? live.wan.address : null,
          gateway: ok ? live.wan.gateway : null,
        },
        networks: (run?.networks ?? []).map((n) => ({ name: n.name, purpose: n.purpose, interface: n.interface, address: n.address, dhcp: n.dhcp.enabled })),
        interfaces: ok ? live.interfaces.map((i) => ({ name: i.name, up: i.up, addresses: i.addresses })) : [],
        leases: ok ? live.leases.length : null,
        dns: { running: ok ? live.dns.running : null, blocking: run?.dns.block.enabled ?? false },
        connections: ok ? live.conntrack : null,
        vpnPeers: ok ? live.vpn.length : null,
        problems: ok ? live.problems : [`The gate could not be read: ${live.error}`],
      };
    }

    let dome = null;
    if (ctx.dome) {
      const st = ctx.dome.state();
      const worst = ctx.dome
        .findings('active', 200)
        .sort((a, b) => (RANK[b.severity] ?? 0) - (RANK[a.severity] ?? 0) || b.lastAt.localeCompare(a.lastAt))
        .slice(0, 8);
      dome = {
        mode: st.mode,
        learningUntil: st.learningUntil,
        open: st.open,
        devices: st.stats.devices,
        dnsQueries: st.stats.dnsQueries,
        sensors: st.stats.sensors,
        feedUpdatedAt: st.stats.feedUpdatedAt,
        feedErrors: st.stats.feedErrors,
        findings: worst.map((f) => ({ severity: f.severity, title: f.title, detail: f.detail, device: f.device.name ?? f.device.ip ?? f.device.mac, subject: f.subject, lastAt: f.lastAt, count: f.count })),
      };
    }
    return { at: new Date().toISOString(), server, gate, dome };
  });
}
