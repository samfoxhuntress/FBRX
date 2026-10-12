import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { rolesProblem, SERVER_ROLE_CATALOG, type RoleChange, type ServerRolesStatus } from '@fbrx/shared';
import { audited, need, type VirtualContext } from '../context';
import { badRequest, conflict } from '../errors';

/** KEY=value lines, as fbrx-server writes them. */
function readEnv(file: string): Record<string, string> {
  const v: Record<string, string> = {};
  if (!existsSync(file)) return v;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) v[m[1]!] = m[2]!.replace(/^"|"$/g, '');
  }
  return v;
}

/** The end of a log file (the installer's output). */
function tail(file: string, bytes = 6000): string {
  if (!existsSync(file)) return '';
  const size = statSync(file).size;
  const buf = readFileSync(file);
  return buf.subarray(Math.max(0, size - bytes)).toString('utf8');
}

/** The server's own network ports (not loopback, virtual switches or machines' cards). */
export function physicalPorts(nics = networkInterfaces()): string[] {
  return Object.keys(nics)
    .filter((n) => !/^(lo|virbr|vnet|br-|docker|veth|tap|tun|wg|fbrx)/.test(n))
    .sort();
}

/**
 * The server's roles, and changing them: an administrator picks roles in the console and FBRX Server's own installer
 * (the copy it keeps) adds and removes what they need, the same as sudo fbrx-server roles set. It runs as a job of
 * its own, so it carries on while this console restarts at the end; the console shows how it went when it is back.
 */
export async function roleRoutes(app: FastifyInstance, ctx: VirtualContext) {
  const s = ctx.config.server;
  const stateFile = join(s.stateDir, 'roles.env');

  const change = (): RoleChange | null => {
    const v = readEnv(stateFile);
    if (!v.STATE) return null;
    return { state: v.STATE === 'running' ? 'running' : v.STATE === 'done' ? 'done' : 'failed', roles: v.ROLES ?? '', startedAt: v.STARTED || null, finishedAt: v.FINISHED || null, log: tail(s.logFile) };
  };
  const why = (): string | null =>
    !existsSync(s.command)
      ? 'fbrx-server is not installed on this computer (a development copy of the console)'
      : !existsSync(join(s.bundleDir, 'install.sh'))
        ? 'This server keeps no copy of its installer yet. Update it once (sudo fbrx-server update check, then update commit), or run install.sh --roles … from a bundle.'
        : null;

  app.get('/v1/server/roles', async (req): Promise<ServerRolesStatus> => {
    need(req, 'viewer');
    const reason = why();
    return { roles: ctx.config.roles, catalog: SERVER_ROLE_CATALOG, canChange: !reason, why: reason, change: change(), ports: physicalPorts(), gate: { wan: ctx.config.gate.wan, lan: ctx.config.gate.lan } };
  });

  app.post('/v1/server/roles', async (req) => {
    need(req, 'admin');
    const body = z
      .object({
        roles: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/)).max(12),
        gateWan: z.string().regex(/^[A-Za-z0-9._-]{1,15}$/).optional(),
        gateLan: z.string().regex(/^[A-Za-z0-9._-]{1,15}$/).optional(),
        /** Turning the gate off takes its networks away: only when asked for in so many words. */
        force: z.boolean().default(false),
      })
      .parse(req.body);
    const roles = [...new Set(body.roles)];
    const problem = rolesProblem(roles);
    if (problem) throw badRequest(problem);
    const reason = why();
    if (reason) throw conflict(reason);
    if (change()?.state === 'running') throw conflict('A change of roles is already running');
    const gateNew = roles.includes('gate') && !ctx.config.roles.includes('gate');
    if (gateNew) {
      if (!body.gateWan || !body.gateLan) throw badRequest('FBRX Gate needs its two ports: the internet port and your network’s port');
      if (body.gateWan === body.gateLan) throw badRequest('The internet port and your network’s port must be different ports');
    }
    if (ctx.config.roles.includes('gate') && !roles.includes('gate') && !body.force) throw conflict('Turning FBRX Gate off takes your network’s router away: confirm it to go ahead');

    const args = ['roles', 'set', roles.join(','), '--yes'];
    if (gateNew) args.push('--gate-wan', body.gateWan!, '--gate-lan', body.gateLan!);
    if (body.force) args.push('--force');
    return audited(ctx, req, 'server.roles', roles.join(','), () => {
      mkdirSync(s.stateDir, { recursive: true });
      writeFileSync(stateFile, `STATE=running\nROLES=${roles.join(',')}\nSTARTED=${new Date().toISOString()}\nFINISHED=\n`);
      const [cmd, argv] = s.spawn === 'systemd-run' ? ['systemd-run', ['--unit', `fbrx-roles-${Date.now()}`, '--collect', '--quiet', s.command, ...args]] : [s.command, args];
      const child = spawn(cmd, argv as string[], { detached: true, stdio: 'ignore' });
      child.on('error', (e) => writeFileSync(stateFile, `STATE=failed\nROLES=${roles.join(',')}\nSTARTED=${new Date().toISOString()}\nFINISHED=${new Date().toISOString()}\nERROR=${e.message}\n`));
      child.unref();
      return { started: true, roles };
    }, { from: ctx.config.roles.join(','), to: roles.join(',') });
  });
}
