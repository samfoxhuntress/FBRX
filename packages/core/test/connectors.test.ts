import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { makeKernel, USER, waitFor } from './helpers';

async function server(handler: (req: any, body: string) => { status?: number; json?: unknown }) {
  const hits: Array<{ method: string; url: string; headers: any; body: string }> = [];
  const s = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    hits.push({ method: req.method!, url: req.url!, headers: req.headers, body });
    const r = handler(req, body);
    res.writeHead(r.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(r.json ?? {}));
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, hits, close: () => new Promise<void>((r) => s.close(() => r())) };
}

describe('connectors', () => {
  it('exposes a REST API as governed tools with vault-backed auth', async () => {
    const api = await server((req) => (req.url.startsWith('/v1/orders/42') ? { json: { id: 42, status: 'shipped' } } : { status: 404, json: { error: 'nf' } }));
    const { kernel, cleanup } = await makeKernel();
    try {
      kernel.vault.set({ name: 'ORDERS_TOKEN', value: 'orders-token-123456' });
      const conn = (await kernel.call(
        'connectors.create',
        {
          name: 'Orders',
          type: 'rest',
          config: {
            baseUrl: `${api.url}/v1`,
            authType: 'bearer',
            secretRef: 'ORDERS_TOKEN',
            operations: [{ name: 'get_order', method: 'GET', path: 'orders/{id}', description: 'Fetch one order' }],
          },
        },
        USER,
      )) as any;
      expect(conn.state).toBe('connected');
      expect(conn.tools).toEqual(['orders.get', 'orders.get_order']);
      const r = await kernel.gate.invoke('orders.get_order', { params: { id: 42 } }, { origin: 'agent', actor: 'a' });
      expect(r.status).toBe('succeeded');
      expect(r.output).toContain('shipped');
      expect(r.output).not.toContain('orders-token-123456');
      expect(api.hits[0].headers.authorization).toBe('Bearer orders-token-123456');
      // Paths cannot escape the configured base URL.
      const esc = await kernel.gate.invoke('orders.get', { path: 'http://169.254.169.254/latest' }, { origin: 'agent', actor: 'a' });
      expect(esc.status).toBe('failed');
      // Inline credentials are rejected.
      await expect(kernel.call('connectors.create', { name: 'Bad', type: 'rest', config: { baseUrl: api.url, authType: 'none', token: 'abcdefghijk' } }, USER)).rejects.toThrow(/vault/);
    } finally {
      await api.close();
      await cleanup();
    }
  });

  it('delivers HMAC-signed webhook events', async () => {
    const hook = await server(() => ({ json: { ok: true } }));
    const { kernel, cleanup } = await makeKernel();
    try {
      kernel.vault.set({ name: 'HOOK_SECRET', value: 'hook-signing-secret' });
      await kernel.call('connectors.create', { name: 'SIEM', type: 'webhook', config: { url: hook.url, secretRef: 'HOOK_SECRET', events: ['policy.denied'] } }, USER);
      await kernel.gate.invoke('fs.read_file', { path: '/etc/passwd' }, { origin: 'agent', actor: 'a' });
      await waitFor(() => hook.hits.length > 0);
      const hit = hook.hits[0];
      const body = JSON.parse(hit.body);
      expect(body.event).toBe('policy.denied');
      expect(body.payload.action).toBe('fs.read_file');
      expect(hit.headers['x-fbrx-signature']).toBe(`sha256=${createHmac('sha256', 'hook-signing-secret').update(hit.body).digest('hex')}`);
    } finally {
      await hook.close();
      await cleanup();
    }
  });
});
