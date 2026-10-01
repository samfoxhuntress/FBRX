import { createHmac, randomUUID } from 'node:crypto';
import type { ToolSpec } from '../tools/types';
import type { ConnectorDriver, DriverContext } from './types';

/** Core events a webhook connector may subscribe to (sent as `event` in the JSON body). */
export const WEBHOOK_EVENTS = [
  'approval.requested',
  'approval.resolved',
  'agent.run.completed',
  'agent.run.failed',
  'policy.denied',
  'service.failed',
  'fleet.changed',
  'backup.completed',
  'notification',
] as const;

/** Pushes FBRX events (and agent-composed messages) to another system, HMAC-signed. */
export class WebhookConnector implements ConnectorDriver {
  constructor(private readonly c: DriverContext) {}

  private get cfg() {
    return this.c.record.config;
  }

  async connect() {
    new URL(String(this.cfg.url));
  }
  async disconnect() {}

  async deliver(event: string, payload: unknown, attempt = 1): Promise<number> {
    const body = JSON.stringify({ event, deliveryId: randomUUID(), sentAt: new Date().toISOString(), source: 'fbrx-os', payload });
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-fbrx-event': event, 'user-agent': `FBRX-OS/${this.c.appVersion}` };
    if (this.cfg.secretRef) {
      const key = this.c.secret(String(this.cfg.secretRef));
      if (key) headers['x-fbrx-signature'] = `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;
    }
    try {
      const res = await fetch(String(this.cfg.url), { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) });
      if (res.status >= 500 && attempt < 3) throw new Error(`HTTP ${res.status}`);
      return res.status;
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      return this.deliver(event, payload, attempt + 1);
    }
  }

  onEvent(event: string, payload: unknown) {
    const subscribed = (this.cfg.events as string[]) ?? [];
    if (!subscribed.includes(event)) return;
    this.deliver(event, payload).catch((err) => this.c.log('warn', `Webhook ${this.c.record.name} delivery failed`, { event, error: (err as Error).message }));
  }

  tools(): ToolSpec[] {
    if (!this.cfg.allowAgentSend) return [];
    return [
      {
        name: `${this.c.record.slug}.send`,
        title: `${this.c.record.name}: send message`,
        description: `Send a JSON message to the ${this.c.record.name} webhook.`,
        risk: 'network',
        source: 'connector',
        sourceId: this.c.record.id,
        feature: 'connectors',
        inputSchema: {
          type: 'object',
          properties: { event: { type: 'string', default: 'agent.message' }, payload: { description: 'Any JSON value' } },
          required: ['payload'],
        },
        run: async (i) => {
          const status = await this.deliver(String(i.event ?? 'agent.message'), i.payload);
          return { output: `Delivered (HTTP ${status})`, data: { status } };
        },
      },
    ];
  }

  async test() {
    const status = await this.deliver('test', { message: 'FBRX OS webhook test' });
    return { ok: status < 400, message: `HTTP ${status}` };
  }
}
