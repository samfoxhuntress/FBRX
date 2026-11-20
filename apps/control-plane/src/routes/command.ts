import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { actorOf, adminAuth, requirePerm } from '../auth';
import { conflict } from '../errors';
import type { CommandUpdater } from '../services/command-update';

/**
 * FBRX Command's own version and its updates (Releases page, and the banner for the platform operator). Administrators
 * see the version; only the platform operator (who set FBRX Command up) checks, installs or turns the checks off.
 */
export async function commandRoutes(app: FastifyInstance, ctx: AppContext, updater: CommandUpdater) {
  app.addHook('preHandler', adminAuth(ctx));

  app.get('/v1/admin/command/update', async (req) => {
    requirePerm(req, 'command.read');
    return updater.status();
  });

  app.post('/v1/admin/command/update/check', async (req) => {
    requirePerm(req, 'command.update');
    return updater.check();
  });

  app.post('/v1/admin/command/update/install', async (req) => {
    requirePerm(req, 'command.update');
    let status;
    try {
      status = updater.install();
    } catch (e) {
      throw conflict((e as Error).message);
    }
    ctx.audit.record(actorOf(req), 'command.update.started', { type: 'command' }, { from: ctx.version, to: status.latest?.version ?? null });
    return status;
  });

  app.post('/v1/admin/command/update/skip', async (req) => {
    requirePerm(req, 'command.update');
    const { version } = z.object({ version: z.string().max(40).nullable() }).parse(req.body ?? {});
    return updater.skip(version);
  });

  app.post('/v1/admin/command/update/auto', async (req) => {
    requirePerm(req, 'command.update');
    const { on } = z.object({ on: z.boolean() }).parse(req.body ?? {});
    ctx.audit.record(actorOf(req), on ? 'command.update.checks-on' : 'command.update.checks-off', { type: 'command' });
    return updater.setAutoCheck(on);
  });
}
