import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DEFAULT_CONTROL_PLANE_PORT, type FleetStatus, type ServerCommandStatus } from '@fbrx/shared';
import type { GateConfig, GateRule } from '@fbrx/gate';
import { allows } from '../auth';
import { audited, need, type VirtualContext } from '../context';
import { badRequest, conflict } from '../errors';
import { readEnv } from './roles';

/** The gate's firewall rule that lets your network reach FBRX Command on this server (made with a new gate). */
export function commandRule(port: number): GateRule {
  return { id: 'fbrx-command', name: 'FBRX Command for your network', enabled: true, from: 'lan', to: 'gate', proto: 'tcp', ports: String(port), action: 'accept', log: false };
}

/** Whether a "1-100, 443" list of ports holds this one. */
function holds(ports: string, port: number): boolean {
  return ports.split(',').some((p) => {
    const [a, b = a] = p.trim().split('-').map(Number);
    return port >= a! && port <= b!;
  });
}

/** Some network of the gate (not the internet side) may reach this port on the gate itself. */
export function gateLetsIn(c: GateConfig, port: number): boolean {
  return c.firewall.rules.some((r) => r.enabled && r.to === 'gate' && r.from !== 'wan' && r.action === 'accept' && (r.proto === 'any' || ((r.proto === 'tcp' || r.proto === 'tcp+udp') && (!r.ports || holds(r.ports, port)))));
}

/** The SHA-256 fingerprint (AB:CD:…) of the certificate FBRX Command made for itself, once it has. */
function fingerprintOf(file: string): string | null {
  try {
    return new X509Certificate(readFileSync(file)).fingerprint256;
  } catch {
    return null;
  }
}

/**
 * FBRX Command on this server (the command role): whether it runs, where people and computers reach it, its
 * certificate's fingerprint and, until someone sets it up, its setup token for administrators. And this server in an
 * FBRX Command: its FBRX core (the ai role) joins one (this server's own, or another) as any FBRX computer does, and
 * takes its settings and policy from it.
 */
export async function commandRoutes(app: FastifyInstance, ctx: VirtualContext) {
  const c = ctx.config.command;
  const enabled = () => ctx.config.roles.includes('command');
  const settings = () => readEnv(c.envFile);
  const port = () => Number(settings().FBRX_CP_PORT ?? DEFAULT_CONTROL_PLANE_PORT);
  const actor = (req: FastifyRequest) => req.user?.username ?? 'admin';

  /** FBRX Command's own answer, on its local-only address. */
  const ask = async (): Promise<{ needsSetup: boolean; version: string | null } | string> => {
    try {
      const res = await fetch(`${c.localUrl}/v1/setup/status`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return `FBRX Command answered ${res.status}`;
      const body = (await res.json()) as { needsSetup?: boolean; version?: string };
      return { needsSetup: !!body.needsSetup, version: body.version ?? null };
    } catch {
      return 'FBRX Command is not answering (sudo fbrx-server doctor; fbrx-server logs command says why)';
    }
  };

  /** This server's core in an FBRX Command, when it has joined one. */
  const joined = async (req: FastifyRequest): Promise<ServerCommandStatus['joined']> => {
    const core = await ctx.core.state();
    if (!core.running) return null;
    const f = await ctx.core.call<FleetStatus>('fleet.status', {}, actor(req)).catch(() => null);
    return f && f.state !== 'unenrolled' && f.serverUrl ? { server: f.serverUrl, organization: f.tenantName, state: f.state } : null;
  };

  app.get('/v1/server/command', async (req): Promise<ServerCommandStatus> => {
    const user = need(req, 'viewer');
    const core = await ctx.core.state();
    const base = { joined: await joined(req), canJoin: core.installed };
    if (!enabled()) return { enabled: false, running: false, version: null, needsSetup: null, url: null, fingerprint: null, setupToken: null, error: null, gateOpen: null, ...base };
    const env = settings();
    const answer = await ask();
    const up = typeof answer !== 'string';
    const running = ctx.gate?.engine.running();
    return {
      enabled: true,
      running: up,
      version: up ? answer.version : null,
      needsSetup: up ? answer.needsSetup : null,
      url: env.FBRX_CP_PUBLIC_URL || null,
      fingerprint: fingerprintOf(c.certFile),
      // The token only matters until someone sets FBRX Command up, and only administrators see it.
      setupToken: up && answer.needsSetup && allows(user.role, 'admin') ? readEnv(c.secretsFile).FBRX_CP_SETUP_TOKEN || null : null,
      error: up ? null : answer,
      gateOpen: running ? gateLetsIn(running, port()) : null,
      ...base,
    };
  });

  app.post('/v1/server/command/join', async (req) => {
    need(req, 'admin');
    const body = z
      .object({
        token: z.string().trim().min(8, 'Paste the enrollment token from FBRX Command (Deploy & enroll)').max(400),
        url: z.string().trim().max(300).optional(),
        fingerprint: z.string().trim().max(200).optional(),
      })
      .parse(req.body);
    if (!(await ctx.core.state()).installed) throw conflict('This server joins FBRX Command through its FBRX core: add the AI role first (Roles)');
    const own = enabled() ? settings().FBRX_CP_PUBLIC_URL || null : null;
    const url = body.url || own;
    if (!url) throw badRequest('Enter the FBRX Command address, like https://command.example.lan:8787');
    // Its own FBRX Command: the certificate is right here to trust.
    const fingerprint = body.fingerprint || (url === own ? fingerprintOf(c.certFile) : null) || undefined;
    return audited(ctx, req, 'command.join', url, () => ctx.core.call<FleetStatus>('fleet.enroll', { serverUrl: url, token: body.token, deviceName: hostname(), ...(fingerprint ? { fingerprint } : {}) }, actor(req), 60_000), { url });
  });

  app.post('/v1/server/command/leave', async (req) => {
    need(req, 'admin');
    if (!(await ctx.core.state()).installed) throw conflict('This server has no AI role, so it is in no FBRX Command');
    return audited(ctx, req, 'command.leave', null, () => ctx.core.call<FleetStatus>('fleet.unenroll', {}, actor(req)));
  });
}
