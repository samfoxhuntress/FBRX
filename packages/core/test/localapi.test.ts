import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import { makeKernel, USER } from './helpers';

describe('local API', () => {
  it('requires a token, enforces scopes and exposes the governed core', async () => {
    const port = 48000 + Math.floor(Math.random() * 1000);
    const { kernel, cleanup } = await makeKernel({ localApiPort: port });
    try {
      const base = `http://127.0.0.1:${port}`;
      expect((await fetch(`${base}/v1/health`)).status).toBe(200);
      expect((await fetch(`${base}/v1/rpc`, { method: 'POST', body: '{}' })).status).toBe(401);

      const info = (await kernel.call('localapi.info', { revealToken: true }, USER)) as any;
      expect(info.running).toBe(true);
      const auth = { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' };

      const status = await (await fetch(`${base}/v1/rpc`, { method: 'POST', headers: auth, body: JSON.stringify({ method: 'system.status' }) })).json();
      expect(status.result.product).toBe('FBRX OS');

      const tool = await (await fetch(`${base}/v1/tools/time.now`, { method: 'POST', headers: auth, body: JSON.stringify({ input: {} }) })).json();
      expect(tool.ok).toBe(true);

      // User-only methods are refused over the API even with the full token.
      kernel.vault.set({ name: 'S', value: 'secret-value' });
      const reveal = await fetch(`${base}/v1/rpc`, { method: 'POST', headers: auth, body: JSON.stringify({ method: 'vault.reveal', params: { name: 'S' } }) });
      expect(reveal.status).toBe(403);

      // DNS-rebinding protection.
      const rebindingStatus = await new Promise<number>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: '/v1/health', headers: { host: `evil.example:${port}` } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
      expect(rebindingStatus).toBe(403);

      // Agent-scope token cannot call admin methods.
      const agentToken = kernel.vault.get('fbrx.localapi.agentToken', { allowInternal: true });
      const scoped = await fetch(`${base}/v1/rpc`, {
        method: 'POST',
        headers: { authorization: `Bearer ${agentToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'plugins.list' }),
      });
      expect(scoped.status).toBe(403);
    } finally {
      await cleanup();
    }
  });
});
