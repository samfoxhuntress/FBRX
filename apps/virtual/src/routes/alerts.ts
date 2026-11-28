import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ALERT_SEVERITIES, SERVER_ALERT_CHANNELS } from '@fbrx/shared';
import { audited, need, type VirtualContext } from '../context';

const min = z.enum(ALERT_SEVERITIES);

/** The server's alerts: what is going on and what was (everyone who signs in), and where they go (administrators). */
export async function alertRoutes(app: FastifyInstance, ctx: VirtualContext) {
  app.get('/v1/alerts', async (req) => {
    need(req, 'viewer');
    return ctx.alerts.list();
  });

  app.get('/v1/alerts/settings', async (req) => {
    need(req, 'admin');
    return { settings: ctx.alerts.settings() };
  });

  app.put('/v1/alerts/settings', async (req) => {
    need(req, 'admin');
    const body = z
      .object({
        email: z.object({ enabled: z.boolean(), min, host: z.string().max(253), port: z.number().int().min(1).max(65535), secure: z.boolean(), user: z.string().max(200), from: z.string().max(300), to: z.string().max(1000), password: z.string().max(512) }).partial().optional(),
        webhook: z.object({ enabled: z.boolean(), min, url: z.string().max(1000), secret: z.string().max(512) }).partial().optional(),
        syslog: z.object({ enabled: z.boolean(), min, host: z.string().max(253), port: z.number().int().min(1).max(65535), protocol: z.enum(['udp', 'tcp', 'tls']) }).partial().optional(),
      })
      .strict()
      .parse(req.body);
    // The audit log keeps what changed, never a password or secret.
    const shown = JSON.parse(JSON.stringify(body, (k, v) => (k === 'password' || k === 'secret' ? (v ? '(new)' : '(removed)') : v)));
    return audited(ctx, req, 'alerts.settings', null, () => ({ settings: ctx.alerts.setSettings(body) }), shown);
  });

  app.post('/v1/alerts/test', async (req) => {
    need(req, 'admin');
    const { channel } = z.object({ channel: z.enum(SERVER_ALERT_CHANNELS) }).parse(req.body);
    return audited(ctx, req, 'alerts.test', channel, () => ctx.alerts.test(channel));
  });
}
