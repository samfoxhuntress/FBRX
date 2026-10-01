import { createHmac, randomUUID } from 'node:crypto';
import { openString } from '@fbrx/shared/node';
import type { Db } from '@fbrx/shared/node';

export const CP_WEBHOOK_EVENTS = [
  'device.enrolled',
  'device.online',
  'device.offline',
  'device.retired',
  'device.alert',
  'command.completed',
  'command.failed',
  'snapshot.uploaded',
  'license.issued',
  'release.published',
] as const;
export type CpWebhookEvent = (typeof CP_WEBHOOK_EVENTS)[number];

/** Signed outgoing webhooks so other systems (ITSM, SIEM, chat, billing) can react to fleet events. */
export class WebhookDispatcher {
  constructor(
    private readonly db: Db,
    private readonly master: Buffer,
    private readonly version: string,
    private readonly log: (msg: string, data?: unknown) => void,
  ) {}

  emit(tenantId: string | null, event: CpWebhookEvent, payload: unknown): void {
    const hooks = this.db.all<{ id: string; url: string; secret_enc: string; events: string; tenant_id: string | null }>(
      'SELECT id, url, secret_enc, events, tenant_id FROM webhooks WHERE enabled = 1 AND (tenant_id IS NULL OR tenant_id = ?)',
      tenantId ?? '',
    );
    for (const h of hooks) {
      const events = JSON.parse(h.events) as string[];
      if (!events.includes(event) && !events.includes('*')) continue;
      void this.deliver(h.id, h.url, openString(this.master, h.secret_enc, `webhook:${h.id}`), event, tenantId, payload);
    }
  }

  async deliver(id: string, url: string, secret: string, event: string, tenantId: string | null, payload: unknown, attempt = 1): Promise<number | null> {
    const body = JSON.stringify({ event, deliveryId: randomUUID(), sentAt: new Date().toISOString(), tenantId, source: 'fbrx-control-plane', payload });
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': `FBRX-Control-Plane/${this.version}`,
          'x-fbrx-event': event,
          'x-fbrx-signature': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status >= 500 && attempt < 3) throw new Error(`HTTP ${res.status}`);
      this.db.run('UPDATE webhooks SET last_status = ?, last_delivery_at = ?, last_error = NULL WHERE id = ?', res.status, new Date().toISOString(), id);
      return res.status;
    } catch (err) {
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        return this.deliver(id, url, secret, event, tenantId, payload, attempt + 1);
      }
      this.db.run('UPDATE webhooks SET last_error = ?, last_delivery_at = ? WHERE id = ?', (err as Error).message, new Date().toISOString(), id);
      this.log('Webhook delivery failed', { id, event, error: (err as Error).message });
      return null;
    }
  }
}
