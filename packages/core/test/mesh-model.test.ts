import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDERS, type ProviderStatus } from '@fbrx/shared';
import { freePort, makeKernel, waitFor, USER } from './helpers';
import type { Kernel } from '../src/kernel';

/** A scriptable OpenAI-compatible model that streams its answer in a few pieces. */
async function model(reply: (body: any) => { tool?: { name: string; args: unknown }; text?: string; delayMs?: number }) {
  const requests: any[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (req.url?.endsWith('/models')) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'big-model' }] }));
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    requests.push(body);
    const r = reply(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (d: unknown) => res.write(`data: ${JSON.stringify(d)}\n\n`);
    if (r.tool) {
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: r.tool.name, arguments: JSON.stringify(r.tool.args) } }] } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      for (const word of (r.text ?? '').split(/(?<= )/)) {
        if (r.delayMs) await new Promise((x) => setTimeout(x, r.delayMs));
        if (res.destroyed) return;
        send({ choices: [{ index: 0, delta: { content: word } }] });
      }
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

let laptop: Awaited<ReturnType<typeof makeKernel>>;
let server: Awaited<ReturnType<typeof makeKernel>>;
let kl: Kernel;
let ks: Kernel;
let big: Awaited<ReturnType<typeof model>>;
let script: (body: any) => ReturnType<Parameters<typeof model>[0]> = () => ({ text: 'Hello from home.' });
let serverOnLaptop = '';

const lend = (offer: 'off' | 'ask' | 'auto') => ks.settings.update({ mesh: { assist: { offer } as never } });
const useServerAi = () =>
  kl.settings.update({
    ai: { defaultProvider: 'home', defaultModel: '', providers: [...DEFAULT_PROVIDERS, { id: 'home', type: 'mesh', name: 'Home server AI', enabled: true, cloud: false, peer: serverOnLaptop }] },
  });

beforeAll(async () => {
  big = await model((b) => script(b));
  laptop = await makeKernel();
  server = await makeKernel();
  kl = laptop.kernel;
  ks = server.kernel;
  const [lp, sp] = [await freePort(), await freePort()];
  kl.settings.update({ mesh: { enabled: true, port: lp }, general: { deviceName: 'laptop' } });
  ks.settings.update({ mesh: { enabled: true, port: sp }, general: { deviceName: 'home-server' } });
  await waitFor(() => kl.mesh.running && ks.mesh.running);
  ks.settings.update({ ai: { defaultProvider: 'big', defaultModel: 'big-model', providers: [...DEFAULT_PROVIDERS, { id: 'big', type: 'openai-compatible', name: 'Big', enabled: true, baseUrl: big.url, cloud: false }] } });
  const pairing = (await ks.call('mesh.startPairing', undefined, USER)) as any;
  serverOnLaptop = ((await kl.call('mesh.pair', { code: pairing.code, host: `127.0.0.1:${sp}` }, USER)) as any).id;
  useServerAi();
}, 60_000);

afterAll(async () => {
  await laptop?.cleanup();
  await server?.cleanup();
  await big?.close();
}, 60_000);

describe('Thinking with another computer’s AI over FBRX Mesh', () => {
  it('runs the agent here with its tools, while the model works on the server', async () => {
    lend('auto');
    let turn = 0;
    script = () => (++turn === 1 ? { tool: { name: 'time__now', args: {} } } : { text: 'It is time for a big answer, worked out at home.', delayMs: 5 });
    const r = await kl.agent.runToCompletion({ message: 'What time is it?', origin: 'user', actor: 'test' });
    expect(r.status).toBe('completed');
    expect(r.answer).toBe('It is time for a big answer, worked out at home.');

    // The server's model saw the laptop's agent: its instructions, its tools, and the tool's result from the laptop.
    expect(big.requests).toHaveLength(2);
    expect(big.requests[0].messages[0].content).toContain('Workstation: laptop');
    expect(big.requests[0].tools.map((t: any) => t.function.name)).toContain('time__now');
    expect(big.requests[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });

    // The tool ran on the laptop, under its governance, and the answer says where it was worked out.
    const msgs = kl.conversations.messages(r.conversationId);
    expect(msgs.find((m) => m.toolCalls?.length)?.toolCalls?.[0]).toMatchObject({ name: 'time.now', status: 'succeeded' });
    expect(msgs.at(-1)).toMatchObject({ role: 'assistant', model: 'big-model · home-server' });
    expect(ks.conversations.list()).toHaveLength(0);
  });

  it('shows the server’s AI as a provider, with what the server can hold', async () => {
    const status = (await kl.call('ai.providers', undefined, USER)) as ProviderStatus[];
    expect(status.find((p) => p.id === 'home')).toMatchObject({ type: 'mesh', cloud: false, available: true, defaultModel: 'big-model' });
    expect(await kl.call('ai.models', { providerId: 'home' }, USER)).toEqual([{ id: 'big-model', name: 'big-model', providerId: 'home', details: 'on home-server' }]);
  });

  it('asks the person at the server first, once, when it is set to ask', async () => {
    lend('ask');
    script = () => ({ text: 'Allowed.' });
    const run = kl.agent.runToCompletion({ message: 'Hello', origin: 'user', actor: 'test' });
    const asked = await waitFor(() => ks.approvals.list().find((a) => a.toolTitle === 'Let laptop think with this computer’s AI'));
    ks.approvals.resolve(asked.id, 'approve', 'test');
    expect((await run).answer).toBe('Allowed.');
    expect((await kl.agent.runToCompletion({ message: 'Again', origin: 'user', actor: 'test' })).answer).toBe('Allowed.');
    expect(ks.approvals.list()).toHaveLength(0);
  });

  it('stops the model on the server when the person here stops the answer', async () => {
    lend('auto');
    script = () => ({ text: 'word '.repeat(400), delayMs: 20 });
    const before = big.requests.length;
    const run = kl.agent.start({ message: 'Write a lot', origin: 'user', actor: 'test' });
    await waitFor(() => (kl.agent.activityIn(run.conversationId)?.reply?.text.length ?? 0) > 20);
    kl.agent.cancel(run.runId);
    expect((await run.done).status).toBe('cancelled');
    expect(big.requests.length).toBe(before + 1);
  });

  it('lends only an AI the server runs itself, and nothing when it does not lend', async () => {
    lend('off');
    expect(await kl.providers.build(kl.providers.config('home')).health()).toEqual({ ok: false, message: 'home-server: This computer does not lend its AI' });
    await expect(kl.agent.runToCompletion({ message: 'Hello', origin: 'user', actor: 'test' })).resolves.toMatchObject({ status: 'failed', error: expect.stringMatching(/does not lend its AI/) });

    // The server's own AI is a cloud provider: the conversation would leave your computers, so it is not lent.
    lend('auto');
    const cloud = (on: boolean) => ks.settings.update({ ai: { providers: ks.settings.get().ai.providers.map((p) => (p.id === 'big' ? { ...p, cloud: on } : p)) } });
    ks.policy.updateLocal({ ...ks.policy.policy, ai: { ...ks.policy.policy.ai, allowCloudProviders: true } });
    cloud(true);
    expect(await kl.mesh.call(serverOnLaptop, 'assist.model.offer', {})).toMatchObject({ accepts: 'off', reason: expect.stringContaining('lends only an AI it runs itself') });
    await expect(kl.mesh.call(serverOnLaptop, 'assist.model.start', { messages: [{ role: 'user', content: 'Hi' }], tools: [] })).rejects.toThrow(/runs itself/);
    cloud(false);
  });
});
