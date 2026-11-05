import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DIGGER_AI_PROVIDER, DIGGER_ICON_SVG } from '@fbrx/shared';
import { DIGGER_LINK_FILE, DiggerLinkServer, diggerLinkCall } from '../src/mesh/digger-link';
import { makeKernel, tempDir } from './helpers';

/** FBRX Endpoint's side of the link, answering as its model lender does: an offer, then one short answer. */
function endpoint(dir: string) {
  const asked: string[] = [];
  const link = new DiggerLinkServer({
    dir,
    log: { warn: () => undefined },
    handle: async (method) => {
      asked.push(method);
      if (method === 'assist.model.offer') return { accepts: 'auto', reason: null, model: 'qwen3-8b', models: [{ id: 'qwen3-8b', name: 'Qwen3 8B' }], historyChars: 60_000 };
      if (method === 'assist.model.start') return { id: 'lend_1' };
      if (method === 'assist.model.read') return { chunks: [{ type: 'text', delta: 'Your router is 192.168.1.1.' }, { type: 'done', finishReason: 'stop' }], next: 2, done: true, error: null };
      return { ok: true };
    },
  });
  return { link, asked };
}

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('FBRX Digger and FBRX Endpoint on the same computer', () => {
  it('finds Endpoint by the link in its data folder, and Endpoint answers only that, only for the model', async () => {
    const dir = tempDir();
    const call = diggerLinkCall(dir);
    // Endpoint not installed, or not running: no link.
    await expect(call('assist.model.offer', {})).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'FBRX Endpoint is not running on this computer' });

    const { link } = endpoint(dir);
    await link.start();
    cleanups.push(() => link.stop());
    expect(await call('assist.model.offer', {})).toMatchObject({ accepts: 'auto', model: 'qwen3-8b' });
    // Only the model lender's requests, and only with the secret in the link file.
    await expect(call('system.status', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const { url } = JSON.parse(readFileSync(join(dir, DIGGER_LINK_FILE), 'utf8')) as { url: string };
    const stranger = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer guess', 'content-type': 'application/json' }, body: JSON.stringify({ method: 'assist.model.offer' }) });
    expect(stranger.status).toBe(401);

    // Endpoint closing takes the link away.
    await link.stop();
    await expect(call('assist.model.offer', {})).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('runs none of Endpoint’s background work, and thinks with Endpoint’s AI while it is there', async () => {
    const endpointDir = tempDir();
    const { kernel, cleanup } = await makeKernel({ platform: { flavor: 'digger', endpointDataDir: endpointDir } });
    cleanups.push(cleanup);
    // No local AI, backups, antivirus, organization, calendar, mesh or Local API.
    const states = Object.fromEntries(kernel.services.list().map((s) => [s.name, s.state]));
    for (const name of ['runtime', 'backup', 'fleet', 'protection', 'calendar', 'mesh', 'localapi']) expect(states[name], name).toBe('disabled');
    expect(states.agent).toBe('running');

    // Its one AI is Endpoint's: not there while Endpoint is not running.
    expect(kernel.providers.configs()).toEqual([DIGGER_AI_PROVIDER]);
    expect((await kernel.providers.status()).find((p) => p.id === DIGGER_AI_PROVIDER.id)).toMatchObject({ available: false });

    const { link, asked } = endpoint(endpointDir);
    await link.start();
    cleanups.push(() => link.stop());
    expect((await kernel.providers.status()).find((p) => p.id === DIGGER_AI_PROVIDER.id)).toMatchObject({ available: true });
    const { provider } = kernel.providers.resolve();
    let text = '';
    for await (const c of provider.chat({ model: '', messages: [{ role: 'user', content: 'What is my router?' }], tools: [], signal: new AbortController().signal })) if (c.type === 'text') text += c.delta;
    expect(text).toBe('Your router is 192.168.1.1.');
    expect(asked).toEqual(expect.arrayContaining(['assist.model.offer', 'assist.model.start', 'assist.model.read']));
  });

  it('draws its icon from the one mole', () => {
    // Line ends as git checked the file out (CRLF on Windows) do not count.
    expect(readFileSync(join(__dirname, '../../../apps/desktop/build/digger-icon.svg'), 'utf8').replace(/\r\n/g, '\n').trim()).toBe(DIGGER_ICON_SVG);
  });
});
