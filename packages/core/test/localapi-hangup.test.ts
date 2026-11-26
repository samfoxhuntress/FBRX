import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDERS } from '@fbrx/shared';
import { freePort, makeKernel, USER } from './helpers';

describe('Local API: an app that stops waiting', () => {
  it('stops the run it asked for, so the model is free for what comes next', async () => {
    // A model that takes its time: it never answers on its own, and tells when the request to it is dropped.
    let asked = 0;
    let dropped = 0;
    const model = createServer((req, res) => {
      asked++;
      req.resume();
      res.on('close', () => dropped++);
    });
    await new Promise<void>((r) => model.listen(0, '127.0.0.1', () => r()));
    const port = await freePort();
    const { kernel, cleanup } = await makeKernel({ localApiPort: port });
    try {
      kernel.settings.update({
        ai: {
          defaultProvider: 'slow',
          defaultModel: 'm',
          providers: [...DEFAULT_PROVIDERS, { id: 'slow', type: 'openai-compatible', name: 'slow', enabled: true, baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`, cloud: false }],
        },
      });
      const info = (await kernel.call('localapi.info', { revealToken: true }, USER)) as { token: string };
      const runs: Array<{ type: string; status?: string; error?: string }> = [];
      kernel.events.on('agent', (e) => runs.push(e as never));

      // The app (an MCP bridge whose caller cancelled) hangs up after a moment.
      const app = new AbortController();
      const asking = fetch(`http://127.0.0.1:${port}/v1/agent/run`, {
        method: 'POST',
        headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Take your time' }),
        signal: app.signal,
      }).catch((e: Error) => e);
      const until = async (ok: () => boolean) => {
        for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 25));
        expect(ok()).toBe(true);
      };
      await until(() => asked > 0);
      expect(kernel.agent.activities().length).toBe(1);
      app.abort();
      await asking;

      // FBRX stopped the run, and with it the request to the model.
      await until(() => kernel.agent.activities().length === 0);
      await until(() => dropped > 0);
      expect(runs.some((e) => e.type === 'run.cancelled' || (e.type === 'run.completed' && e.status === 'cancelled') || /stopped waiting/.test(JSON.stringify(e)))).toBe(true);
    } finally {
      model.close();
      await kernel.stop();
      await cleanup();
    }
  }, 30_000);
});
