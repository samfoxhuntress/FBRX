import type { FastifyBaseLogger } from 'fastify';
import { newId } from '@fbrx/shared';
import type { Db } from '@fbrx/shared/node';
import type { Config } from './config';
import type { Keys } from './keys';
import type { CpAudit } from './audit';
import type { Realtime } from './realtime';
import type { WebhookDispatcher } from './services/webhooks';

export interface AppContext {
  config: Config;
  db: Db;
  keys: Keys;
  audit: CpAudit;
  realtime: Realtime;
  webhooks: WebhookDispatcher;
  version: string;
  log: FastifyBaseLogger;
  /** Increments a tenant's configuration version and tells its online devices to re-sync. */
  bumpConfig(tenantId: string): number;
  /** Delivers a queued command immediately if the device is connected. */
  dispatch(commandId: string): boolean;
}

export function createContextHelpers(ctx: Omit<AppContext, 'bumpConfig' | 'dispatch'>): Pick<AppContext, 'bumpConfig' | 'dispatch'> {
  return {
    bumpConfig(tenantId: string) {
      ctx.db.run('UPDATE tenants SET config_version = config_version + 1, updated_at = ? WHERE id = ?', new Date().toISOString(), tenantId);
      const version = Number(ctx.db.get<{ v: number }>('SELECT config_version AS v FROM tenants WHERE id = ?', tenantId)?.v ?? 0);
      ctx.realtime.broadcastToTenantDevices(tenantId, { type: 'config.changed', version });
      return version;
    },
    dispatch(commandId: string) {
      const c = ctx.db.get<any>("SELECT * FROM commands WHERE id = ? AND status = 'queued'", commandId);
      if (!c) return false;
      const sent = ctx.realtime.sendToDevice(c.device_id, {
        type: 'command',
        command: { id: c.id, type: c.type, payload: JSON.parse(c.payload), createdAt: c.created_at, expiresAt: c.expires_at },
      });
      if (sent) {
        ctx.db.run("UPDATE commands SET status = 'sent', sent_at = ? WHERE id = ?", new Date().toISOString(), c.id);
        ctx.realtime.emitAdmin({ type: 'command.updated', tenantId: c.tenant_id, command: { id: c.id, deviceId: c.device_id, status: 'sent' } });
      }
      return sent;
    },
  };
}

export const ids = {
  tenant: () => newId('ten'),
  user: () => newId('usr'),
  session: () => newId('ses'),
  apiKey: () => newId('key'),
  profile: () => newId('prf'),
  group: () => newId('grp'),
  enrollment: () => newId('enr'),
  device: () => newId('dev'),
  command: () => newId('cmd'),
  release: () => newId('rel'),
  file: () => newId('fil'),
  license: () => newId('lic'),
  secret: () => newId('sec'),
  snapshot: () => newId('snp'),
  pkg: () => newId('pkg'),
  webhook: () => newId('whk'),
  event: () => newId('evt'),
  sso: () => newId('sso'),
  ticket: () => newId('tkt'),
  ticketMessage: () => newId('tkm'),
};
