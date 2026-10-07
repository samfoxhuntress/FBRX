import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, DEFAULT_PROVIDERS, type AssistSession, type Policy } from '@fbrx/shared';
import { makeKernel, waitFor, USER } from './helpers';
import { isCapacityError } from '../src/mesh/mesh-assist';
import type { Kernel } from '../src/kernel';

/**
 * A scriptable OpenAI-compatible model: each request gets `reply(body)` (a tool call or text), optionally after a
 * delay, or an error status (to play an AI provider that ran out of credits).
 */
async function model(reply: (body: any) => { tool?: { name: string; args: unknown }; text?: string; delayMs?: number; status?: number; error?: string }) {
  const requests: any[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (req.url?.endsWith('/models')) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'm' }] }));
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    requests.push(body);
    const r = reply(body);
    if (r.delayMs) await new Promise((x) => setTimeout(x, r.delayMs));
    if (r.status) return res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: r.error ?? 'error', type: 'insufficient_quota' } }));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (d: unknown) => res.write(`data: ${JSON.stringify(d)}\n\n`);
    if (r.tool) {
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: r.tool.name, arguments: JSON.stringify(r.tool.args) } }] } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      send({ choices: [{ index: 0, delta: { content: r.text ?? '' } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const lastUser = (body: any) => String([...(body.messages ?? [])].reverse().find((m: any) => m.role === 'user')?.content ?? '');
const toolNames = (body: any) => (body.tools ?? []).map((t: any) => t.function?.name);

let A: Awaited<ReturnType<typeof makeKernel>>;
let B: Awaited<ReturnType<typeof makeKernel>>;
let ka: Kernel;
let kb: Kernel;
let modelA: Awaited<ReturnType<typeof model>>;
let modelB: Awaited<ReturnType<typeof model>>;
let scriptA: (body: any) => ReturnType<Parameters<typeof model>[0]> = () => ({ text: 'A here.' });
let scriptB: (body: any) => ReturnType<Parameters<typeof model>[0]> = () => ({ text: 'B here.' });
let aOnB = '';
let bOnA = '';

const useModel = (k: Kernel, url: string) =>
  k.settings.update({ ai: { defaultProvider: 'mock', defaultModel: 'm', providers: [...DEFAULT_PROVIDERS, { id: 'mock', type: 'openai-compatible', name: 'Mock', enabled: true, baseUrl: url, cloud: false }] } });
const assist = (k: Kernel, patch: Record<string, unknown>) => k.settings.update({ mesh: { assist: patch as never } });

beforeAll(async () => {
  modelA = await model((b) => scriptA(b));
  modelB = await model((b) => scriptB(b));
  A = await makeKernel();
  B = await makeKernel();
  ka = A.kernel;
  kb = B.kernel;
  ka.settings.update({ mesh: { enabled: true, port: 47831 }, general: { deviceName: 'server-a' } });
  kb.settings.update({ mesh: { enabled: true, port: 47832 }, general: { deviceName: 'server-b' } });
  await waitFor(() => ka.mesh.running && kb.mesh.running);
  useModel(ka, modelA.url);
  useModel(kb, modelB.url);
  for (const k of [ka, kb]) {
    k.assist.setPollInterval(50);
    k.assist.setAdmin(false);
  }
  const pairing = (await ka.call('mesh.startPairing', undefined, USER)) as any;
  const peer = (await kb.call('mesh.pair', { code: pairing.code, host: '127.0.0.1:47831' }, USER)) as any;
  aOnB = peer.id;
  bOnA = ka.mesh.devices()[0].id;
}, 60_000);

afterAll(async () => {
  await B?.cleanup();
  await A?.cleanup();
  await modelA?.close();
  await modelB?.close();
}, 60_000);

describe('Mesh Assist', () => {
  it('knows when an AI provider has run out of room', () => {
    expect(isCapacityError('429 You exceeded your current quota')).toBe(true);
    expect(isCapacityError('Your credit balance is too low to access the API')).toBe(true);
    expect(isCapacityError('connect ECONNREFUSED 127.0.0.1:8080')).toBe(true);
    expect(isCapacityError('The file was not found')).toBe(false);
  });

  it('lets one computer’s agent consult another, back and forth', async () => {
    assist(ka, { request: 'auto' });
    assist(kb, { offer: 'auto' });
    const helpers = await ka.call('mesh.assist.helpers', undefined, USER);
    expect(helpers).toMatchObject([{ name: 'server-b', accepts: 'auto', ai: { ready: true, model: 'm' }, capacity: 1 }]);

    let turn = 0;
    scriptA = () => {
      turn++;
      if (turn === 1) return { tool: { name: 'mesh__consult', args: { question: 'What is 6 x 7?' } } };
      if (turn === 2) return { tool: { name: 'mesh__consult', args: { question: 'And doubled?', followUp: true } } };
      return { text: 'server-b says 42, and 84 doubled.' };
    };
    scriptB = (b) => ({ text: lastUser(b).includes('doubled') ? 'Doubled it is 84.' : 'It is 42.' });
    const r = await ka.agent.runToCompletion({ message: 'Ask the other server what 6 x 7 is, then double it', origin: 'user', actor: 'test' });
    expect(r.status).toBe('completed');
    expect(r.answer).toBe('server-b says 42, and 84 doubled.');
    const toolResults = ka.conversations.messages(r.conversationId).filter((m) => m.role === 'tool').map((m) => m.content);
    expect(toolResults).toEqual(['server-b answered:\nIt is 42.', 'server-b answered:\nDoubled it is 84.']);

    // On the helper: one session, both turns in one conversation, with no way to pass the work along.
    const given = kb.assist.list().filter((s) => s.direction === 'in');
    expect(given).toHaveLength(1);
    expect(given[0]).toMatchObject({ peerName: 'server-a', kind: 'consult', status: 'done', answer: 'Doubled it is 84.' });
    const helperChat = kb.conversations.messages(given[0].conversationId!).filter((m) => m.role === 'user');
    expect(helperChat).toHaveLength(2);
    expect(helperChat[0].content).toContain('[FBRX Mesh Assist');
    const helperRequest = modelB.requests.at(-1);
    expect(toolNames(helperRequest).some((n: string) => n.startsWith('mesh__'))).toBe(false);
    expect(toolNames(helperRequest).every((n: string) => !/write|delete|run_command|shell/.test(n))).toBe(true);
  }, 60_000);

  it('hands a task to another computer when the agent runs out of steps', async () => {
    const policy: Policy = structuredClone(DEFAULT_POLICY);
    policy.ai.maxStepsPerRun = 2;
    ka.policy.updateLocal(policy);
    try {
      scriptA = () => ({ tool: { name: 'time__now', args: {} } });
      scriptB = (b) => ({ text: lastUser(b).includes('Tool time.now') ? 'Finished: the report is ready.' : 'No context?' });
      const r = await ka.agent.runToCompletion({ message: 'Write the weekly report', origin: 'user', actor: 'test' });
      expect(r.status).toBe('completed');
      expect(r.answer).toContain('**server-b** finished this through Mesh Assist');
      expect(r.answer).toContain('Finished: the report is ready.');
      const handed = kb.assist.list().find((s) => s.direction === 'in' && s.kind === 'continue');
      expect(handed).toMatchObject({ trigger: 'steps', status: 'done' });
      expect(ka.audit.query({ category: 'agent', limit: 20 }).some((e) => e.action === 'run.handoff')).toBe(true);
    } finally {
      ka.policy.updateLocal(structuredClone(DEFAULT_POLICY));
    }
  }, 60_000);

  it('hands a task over when the AI provider has run out of credits', async () => {
    scriptA = () => ({ status: 429, error: 'You exceeded your current quota, please check your plan and billing details.' });
    scriptB = () => ({ text: 'Here is the summary you asked for.' });
    const r = await ka.agent.runToCompletion({ message: 'Summarize the incident', origin: 'user', actor: 'test' });
    expect(r.status).toBe('completed');
    expect(r.answer).toContain('the AI provider stopped answering here');
    expect(r.answer).toContain('Here is the summary you asked for.');
    expect(kb.assist.list()[0]).toMatchObject({ trigger: 'provider', kind: 'continue', status: 'done' });

    // With hand-overs off, the run fails as before.
    assist(ka, { onProviderError: false });
    const r2 = await ka.agent.runToCompletion({ message: 'Summarize it again', origin: 'user', actor: 'test' });
    expect(r2.status).toBe('failed');
    assist(ka, { onProviderError: true });
  }, 60_000);

  it('asks the people involved unless set to automatic, and respects off', async () => {
    scriptB = () => ({ text: 'Done on B.' });
    // Asking side "ask": the agent's consultation waits for the person here.
    assist(ka, { request: 'ask' });
    scriptA = (b) => (toolNames(b).length && !b.messages.some((m: any) => m.role === 'tool') ? { tool: { name: 'mesh__consult', args: { question: 'Check the backups' } } } : { text: 'ok' });
    const run = ka.agent.runToCompletion({ message: 'Have the other server check the backups', origin: 'user', actor: 'test' });
    const ask = await waitFor(() => ka.approvals.list().find((x) => x.tool === 'mesh.assist'));
    expect(ask.toolTitle).toBe('Bring in server-b');
    ka.approvals.resolve(ask.id, 'deny', 'test');
    const denied = await run;
    expect(ka.conversations.messages(denied.conversationId).find((m) => m.role === 'tool')?.content).toMatch(/did not answer \(denied/);
    assist(ka, { request: 'auto' });

    // Helping side "ask": the work waits for the person on B.
    assist(kb, { offer: 'ask' });
    const [s] = (await ka.call('mesh.assist.send', { peerIds: [bOnA], goal: 'Rotate the logs' }, USER)) as AssistSession[];
    expect(s.status).toBe('waiting-approval');
    const onB = await waitFor(() => kb.approvals.list().find((x) => x.tool === 'mesh.assist'));
    expect(onB.toolTitle).toBe('Help server-a');
    kb.approvals.resolve(onB.id, 'approve', 'test');
    await waitFor(() => (ka.assist.list().find((x) => x.id === s.id)?.status === 'done' ? true : null));

    // Off: nobody helps.
    assist(kb, { offer: 'off' });
    expect(((await ka.call('mesh.assist.helpers', undefined, USER)) as any[])[0]).toMatchObject({ accepts: 'off', reason: 'This computer does not lend its AI' });
    await expect(ka.call('mesh.assist.send', { peerIds: 'any', goal: 'Anything' }, USER)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    // Without the "Help with AI" permission, the same.
    assist(kb, { offer: 'auto' });
    kb.mesh.setPermissions(aOnB, { assist: false });
    expect(((await ka.call('mesh.assist.helpers', undefined, USER)) as any[])[0].accepts).toBe('off');
    kb.mesh.setPermissions(aOnB, { assist: true });
  }, 60_000);

  it('lets a controller run as administrator hand out work without asking, at any priority', async () => {
    assist(kb, { offer: 'ask', maxConcurrent: 1 });
    scriptB = () => ({ text: 'Handled.' });

    // Not a controller: asks, and urgent is capped at high.
    const [plain] = (await ka.call('mesh.assist.send', { peerIds: [bOnA], goal: 'Plain request', priority: 'urgent' }, USER)) as AssistSession[];
    expect(plain).toMatchObject({ status: 'waiting-approval', priority: 'high' });
    await ka.call('mesh.assist.cancel', { sessionId: plain.id }, USER);

    // B trusts A as a controller; A runs as administrator: no question, urgent allowed.
    kb.mesh.setPermissions(aOnB, { command: true });
    ka.assist.setAdmin(true);
    try {
      const [boss] = (await ka.call('mesh.assist.send', { peerIds: [bOnA], goal: 'Controller request', priority: 'urgent' }, USER)) as AssistSession[];
      expect(boss.status).not.toBe('waiting-approval');
      expect(boss).toMatchObject({ priority: 'urgent', admin: true, trigger: 'controller' });
      await waitFor(() => (ka.assist.list().find((x) => x.id === boss.id)?.status === 'done' ? true : null));
      expect(kb.assist.list().find((x) => x.goal === 'Controller request')).toMatchObject({ admin: true, status: 'done' });
      expect(kb.audit.query({ category: 'mesh', limit: 50 }).some((e) => e.action === 'assist.requested' && (e.details as any)?.controller === true)).toBe(true);
    } finally {
      ka.assist.setAdmin(false);
    }
  }, 60_000);

  it('runs higher priorities first and lets urgent controller work stop lower help', async () => {
    assist(kb, { offer: 'auto', maxConcurrent: 1, allowPreempt: true });
    scriptB = (b) => (lastUser(b).includes('SLOW') ? { text: 'slow done', delayMs: 4000 } : { text: `done: ${lastUser(b).includes('FIRST') ? 'first' : 'other'}` });

    const [slow] = (await ka.call('mesh.assist.send', { peerIds: [bOnA], goal: 'SLOW background job', priority: 'background' }, USER)) as AssistSession[];
    await waitFor(() => kb.assist.list().find((x) => x.goal.startsWith('SLOW') && x.status === 'running'));
    const [low] = (await ka.call('mesh.assist.send', { peerIds: [bOnA], goal: 'second normal job', priority: 'normal' }, USER)) as AssistSession[];
    const [high] = (await ka.call('mesh.assist.send', { peerIds: [bOnA], goal: 'FIRST high job', priority: 'high' }, USER)) as AssistSession[];
    expect(kb.assist.list().filter((x) => x.status === 'queued')).toHaveLength(2);

    // An urgent controller request stops the background job; the high job still goes before the normal one.
    kb.mesh.setPermissions(aOnB, { command: true });
    ka.assist.setAdmin(true);
    try {
      await ka.call('mesh.assist.send', { peerIds: [bOnA], goal: 'urgent fix', priority: 'urgent' }, USER);
      const stopped = await waitFor(() => kb.assist.list().find((x) => x.goal.startsWith('SLOW') && x.status === 'cancelled'));
      expect(stopped.error).toBe('Stopped to make way for an urgent request from server-a');
      await waitFor(() => ['urgent fix', 'FIRST high job', 'second normal job'].every((g) => kb.assist.list().find((x) => x.goal === g)?.status === 'done'));
      const finished = kb.assist
        .list()
        .filter((x) => ['urgent fix', 'FIRST high job', 'second normal job'].includes(x.goal))
        .sort((a, b) => a.finishedAt!.localeCompare(b.finishedAt!))
        .map((x) => x.goal);
      expect(finished).toEqual(['urgent fix', 'FIRST high job', 'second normal job']);
      await waitFor(() => (ka.assist.list().find((x) => x.id === slow.id)?.status === 'cancelled' ? true : null));
      // The asking side catches up on its next look.
      await waitFor(() => ka.assist.list().find((x) => x.id === low.id)?.status === 'done');
      await waitFor(() => ka.assist.list().find((x) => x.id === high.id)?.answer === 'done: first');
    } finally {
      ka.assist.setAdmin(false);
      kb.mesh.setPermissions(aOnB, { command: false });
    }
  }, 60_000);

  it('never passes help along a second time', async () => {
    await expect(ka.mesh.call(bOnA, 'assist.start', { kind: 'task', goal: 'loop', hops: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
