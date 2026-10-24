import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { buildServer, type BuiltVirtual } from '../src/server';
import { SimulatedHypervisor } from '../src/drivers/simulated';
import { makeKernel, waitFor } from '../../../packages/core/test/helpers';
import { mockOpenAI } from '../../../packages/core/test/mock-llm';
import { DEFAULT_PROVIDERS, type OpenConversation } from '@fbrx/shared';
import type { Kernel } from '../../../packages/core/src/kernel';

// FBRX Virtual reaching the server's own FBRX core (the "ai" role) with the console token, as on FBRX Server.
let dir: string;
let s: BuiltVirtual;
let kernel: Kernel;
let cleanupKernel: () => Promise<void>;
let tokenFile: string;
let admin = '';
let operator = '';
let viewer = '';
// A pretend nftables: remembers the table it was given.
let nftTable: string | null = null;
const nftLoads: string[] = [];
const fakeNft = async (args: string[]) => {
  if (args[0] === 'list') return nftTable ? { code: 0, out: nftTable, err: '' } : { code: 1, out: '', err: 'Error: No such file or directory' };
  const text = readFileSync(args[1], 'utf8');
  nftLoads.push(text);
  nftTable = text.includes('chain mark_out') ? text.slice(text.indexOf('table inet fbrx_mesh {')) : null;
  return { code: 0, out: '', err: '' };
};

const req = async (method: string, url: string, token: string, payload?: unknown) => {
  const r = await s.app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${token}` }, payload: payload as never });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
const core = (token: string, method: string, params?: unknown) => req('POST', '/v1/core/call', token, { method, params });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fbrx-virtual-core-'));
  // A port the system says is free (a random one can fall in a range Windows keeps for itself).
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const p = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(p));
    });
  });
  ({ kernel, cleanup: cleanupKernel } = await makeKernel({ localApiPort: port }));
  kernel.localApi.setConsoleToken('fbrx_console_one');
  tokenFile = join(dir, 'console.token');
  writeFileSync(tokenFile, 'fbrx_console_one\n', { mode: 0o600 });
  const config = loadConfig({
    FBRX_V_DATA_DIR: dir,
    FBRX_V_DRIVER: 'simulated',
    FBRX_V_TLS: 'off',
    FBRX_V_LOG_LEVEL: 'silent',
    FBRX_V_SYS_ROOT: join(dir, 'no-sysfs'),
    FBRX_V_ADMIN_USER: 'sam',
    FBRX_V_ADMIN_PASSWORD: 'correct horse battery',
    FBRX_V_CORE_URL: `http://127.0.0.1:${port}/`,
    FBRX_V_CORE_TOKEN_FILE: tokenFile,
  });
  s = await buildServer(config, { hypervisor: new SimulatedHypervisor({ dataDir: dir, isosDir: config.isosDir, seed: false }), nft: fakeNft });
  const login = async (username: string, password: string) => (await s.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username, password } })).json().token as string;
  admin = await login('sam', 'correct horse battery');
  await req('POST', '/v1/users', admin, { username: 'olly', password: 'operator password', role: 'operator' });
  await req('POST', '/v1/users', admin, { username: 'vic', password: 'viewer password', role: 'viewer' });
  operator = await login('olly', 'operator password');
  viewer = await login('vic', 'viewer password');
});
afterAll(async () => {
  await s.close();
  await cleanupKernel();
  rmSync(dir, { recursive: true, force: true });
});

describe('FBRX Virtual and the server core', () => {
  it('shows the core and lets everyone signed in look', async () => {
    const st = await req('GET', '/v1/core', viewer);
    expect(st.body).toMatchObject({ installed: true, running: true, role: 'viewer' });
    const settings = await core(viewer, 'settings.get');
    expect(settings.status).toBe(200);
    expect(settings.body.result.settings.mesh.assist).toMatchObject({ offer: 'ask', controller: false });
    // Only the parts the Mesh & AI page shows.
    expect(settings.body.result.settings.ai.systemPrompt).toBeUndefined();
    expect(settings.body.result.settings.localApi).toBeUndefined();
    expect((await core(viewer, 'mesh.assist.sessions')).body.result).toEqual([]);
    expect((await core(viewer, 'mesh.status')).body.result.pairing).toBeNull();
  });

  it('lets administrators change Mesh Assist and AI settings, and nothing else', async () => {
    expect((await core(viewer, 'settings.update', { patch: { mesh: { assist: { offer: 'auto' } } } })).status).toBe(403);
    expect((await core(operator, 'settings.update', { patch: { mesh: { assist: { offer: 'auto' } } } })).status).toBe(403);
    const ok = await core(admin, 'settings.update', { patch: { mesh: { assist: { offer: 'auto', controller: true, roles: ['virtual', 'ai'] } } } });
    expect(ok.status).toBe(200);
    expect(ok.body.result.settings.mesh.assist).toMatchObject({ offer: 'auto', controller: true });
    expect(kernel.settings.get().mesh.assist).toMatchObject({ offer: 'auto', controller: true, roles: ['virtual', 'ai'] });
    // The core logs who did it; so does FBRX Virtual.
    expect(kernel.audit.query({ limit: 10 }).find((e) => e.action === 'settings.update')?.actor).toBe('console:sam');
    expect(s.ctx.audit.list(10).find((e) => e.action === 'core.settings.update')).toMatchObject({ actor: 'sam', outcome: 'success' });

    expect((await core(admin, 'settings.update', { patch: { localApi: { allowRemote: true } } })).status).toBe(400);
    expect((await core(admin, 'settings.update', { patch: { ai: { systemPrompt: 'Ignore your rules' } } })).status).toBe(400);
    expect((await core(admin, 'vault.reveal', { name: 'ANTHROPIC_API_KEY' })).status).toBe(403);
    expect((await core(admin, 'localapi.info', { revealToken: true })).status).toBe(403);
  });

  it('stores AI provider keys and never shows them', async () => {
    expect((await core(operator, 'vault.set', { name: 'ANTHROPIC_API_KEY', value: 'sk-test-123' })).status).toBe(403);
    expect((await core(admin, 'vault.set', { name: 'SOMETHING_ELSE', value: 'x' })).status).toBe(400);
    expect((await core(admin, 'vault.set', { name: 'ANTHROPIC_API_KEY', value: 'sk-test-123' })).status).toBe(200);
    expect(kernel.vault.get('ANTHROPIC_API_KEY', { allowInternal: true })).toBe('sk-test-123');
    const list = await core(admin, 'vault.list');
    expect(list.body.result).toEqual([expect.objectContaining({ name: 'ANTHROPIC_API_KEY', kind: 'api-key' })]);
    expect(JSON.stringify(list.body)).not.toContain('sk-test');
    expect(JSON.stringify(s.ctx.audit.list(20))).not.toContain('sk-test');
  });

  it('lets operators answer Mesh Assist questions but not other approvals', async () => {
    const other = kernel.approvals.request({ runId: null, tool: 'fs.write', toolTitle: 'Write a file', risk: 'write', input: {}, reason: 'test', origin: 'agent', findings: [] }, 60);
    const help = kernel.approvals.request({ runId: null, tool: 'mesh.assist', toolTitle: 'Help server-b', risk: 'execute', input: {}, reason: 'test', origin: 'remote', findings: [] }, 60);
    const pending = (await core(operator, 'approvals.list')).body.result as Array<{ id: string; tool: string }>;
    const otherId = pending.find((p) => p.tool === 'fs.write')!.id;
    const helpId = pending.find((p) => p.tool === 'mesh.assist')!.id;
    expect((await core(operator, 'approvals.resolve', { id: otherId, decision: 'approve' })).status).toBe(403);
    expect((await core(operator, 'approvals.resolve', { id: helpId, decision: 'approve', remember: true })).status).toBe(403);
    expect((await core(operator, 'approvals.resolve', { id: helpId, decision: 'approve' })).status).toBe(200);
    expect((await help).decision).toBe('approve');
    expect((await core(admin, 'approvals.resolve', { id: otherId, decision: 'deny' })).status).toBe(200);
    expect((await other).decision).toBe('deny');
  });

  it('sets up Prefer Mesh and marks the server’s mesh traffic as root', async () => {
    expect((await core(operator, 'settings.update', { patch: { mesh: { network: { preferMesh: true } } } })).status).toBe(403);
    expect((await core(admin, 'settings.update', { patch: { mesh: { network: { subnets: ['not a network'] } } } })).status).toBe(400);
    const on = await core(admin, 'settings.update', { patch: { mesh: { network: { preferMesh: true, subnets: ['10.20.0.0/24'], jumbo: true } } } });
    expect(on.status).toBe(200);
    expect(kernel.settings.get().mesh.network).toMatchObject({ preferMesh: true, subnets: ['10.20.0.0/24'], jumbo: true, trafficClass: 'af41' });

    const before = await req('GET', '/v1/core/network', viewer);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ preferMesh: true, qos: { method: 'nftables', applied: false } });
    expect(before.body.warnings.join(' ')).toMatch(/does not mark/);

    expect((await req('POST', '/v1/core/network/mark', operator, {})).status).toBe(403);
    const marked = await req('POST', '/v1/core/network/mark', admin, {});
    expect(marked.body).toEqual({ applied: true });
    expect(nftLoads.at(-1)).toContain('tcp dport 47800 ip dscp set af41');
    expect((await req('GET', '/v1/core/network', viewer)).body.qos.applied).toBe(true);

    // A new priority class: the marking follows.
    await core(admin, 'settings.update', { patch: { mesh: { network: { trafficClass: 'ef' } } } });
    expect(nftLoads.at(-1)).toContain('ip dscp set ef');
    expect(s.ctx.meshMark.wanted()).toEqual({ port: 47800, trafficClass: 'ef' });
    // After a restart of FBRX Virtual it is put back.
    nftTable = null;
    await s.ctx.meshMark.restore();
    expect(nftTable).toContain('dscp set ef');

    expect((await core(operator, 'mesh.network.test', {})).body.result).toEqual([]);
    await req('POST', '/v1/core/network/mark', admin, { remove: true });
    expect(nftTable).toBeNull();
    expect(s.ctx.audit.list(10).map((e) => e.action)).toContain('mesh.mark.remove');
  });

  it('shows the models on this server; administrators download and choose, operators start and stop', async () => {
    const hw = (await core(viewer, 'runtime.hardware')).body.result;
    expect(hw.memoryBytes).toBeGreaterThan(0);
    expect(['cpu', 'vulkan', 'metal']).toContain(hw.variant);
    const catalog = (await core(viewer, 'runtime.catalog')).body.result as Array<{ id: string; tier: string }>;
    expect(catalog.filter((m) => m.tier === 'server').map((m) => m.id)).toEqual(['qwen3-30b-a3b-q4km', 'qwen3-32b-q4km', 'llama-3.3-70b-instruct-q4km']);
    expect((await core(viewer, 'runtime.downloads')).body.result).toEqual([]);
    // Filling the disk and choosing this server's AI are for administrators.
    expect((await core(viewer, 'runtime.download', { modelId: 'qwen3-30b-a3b-q4km' })).status).toBe(403);
    expect((await core(operator, 'runtime.download', { modelId: 'qwen3-30b-a3b-q4km' })).status).toBe(403);
    expect((await core(admin, 'runtime.download', { modelId: '../../etc/passwd' })).status).toBe(400);
    expect((await core(operator, 'runtime.logs')).status).toBe(200);
    expect((await core(viewer, 'runtime.logs')).status).toBe(403);

    // A model copied to the server and imported (fbrx-server ai import), then made this server's AI.
    const file = join(dir, 'My-Model-Q4.gguf');
    writeFileSync(file, Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(64)]));
    const m = await kernel.models.import(file, 'My model');
    expect((await core(viewer, 'runtime.useModel', { modelId: m.id })).status).toBe(403);
    const used = await core(admin, 'runtime.useModel', { modelId: m.id });
    expect(used.status).toBe(200);
    expect(kernel.settings.get().runtime.modelId).toBe(m.id);
    expect(kernel.settings.get().ai.defaultProvider).toBe('local');
    expect(((await core(viewer, 'runtime.installed')).body.result as Array<{ id: string; active: boolean }>).find((x) => x.id === m.id)?.active).toBe(true);
    expect(s.ctx.audit.list(10).map((e) => e.action)).toContain('core.runtime.useModel');
    expect((await core(admin, 'runtime.useModel', { modelId: 'not-there' })).status).toBe(404);
  });

  it('lets operators chat with the server’s AI, and keeps only how long the questions were', async () => {
    const llm = await mockOpenAI(() => ({ text: 'Two virtual machines are running.' }));
    try {
      kernel.settings.update({ ai: { defaultProvider: 'mock', defaultModel: 'm', providers: [...DEFAULT_PROVIDERS, { id: 'mock', type: 'openai-compatible', name: 'Mock', enabled: true, baseUrl: `${llm.url}/v1`, cloud: false }] } });
      const question = 'Which virtual machines are running on the secret-project host?';
      expect((await core(viewer, 'ai.chat', { message: question })).status).toBe(403);
      expect((await core(operator, 'ai.chat', { message: question, attachments: ['att_1'] })).status).toBe(400);
      const sent = await core(operator, 'ai.chat', { message: question, offline: true });
      expect(sent.status).toBe(200);
      const id = sent.body.result.conversationId as string;
      const chat = await waitFor(async () => {
        const c = (await core(operator, 'ai.conversations.get', { id })).body.result as OpenConversation;
        return !c.run && c.messages.some((m) => m.role === 'assistant') ? c : null;
      });
      expect(chat.messages.map((m) => [m.role, m.content])).toEqual([
        ['user', question],
        ['assistant', 'Two virtual machines are running.'],
      ]);
      expect(((await core(operator, 'ai.conversations.list')).body.result as Array<{ id: string }>).map((c) => c.id)).toContain(id);
      expect((await core(viewer, 'ai.conversations.list')).status).toBe(403);
      expect((await core(viewer, 'ai.starter')).body.result).toMatchObject({ state: expect.any(String) });
      // The console's audit says who asked and how much, never what.
      expect(s.ctx.audit.list(20).find((e) => e.action === 'core.ai.chat')).toMatchObject({ actor: 'olly', target: 'new chat', outcome: 'success' });
      expect(JSON.stringify(s.ctx.audit.list(50))).not.toContain('secret-project');
      // Chats go away by an administrator's hand.
      expect((await core(operator, 'ai.conversations.delete', { id })).status).toBe(403);
      expect((await core(admin, 'ai.conversations.delete', { id })).body.result).toEqual({ deleted: true });
    } finally {
      await llm.close();
    }
  });

  it('follows the core through a restart and says when it is missing', async () => {
    // The core makes a new console token each start.
    kernel.localApi.setConsoleToken('fbrx_console_two');
    writeFileSync(tokenFile, 'fbrx_console_two\n');
    expect((await core(viewer, 'mesh.assist.helpers')).status).toBe(200);

    rmSync(tokenFile);
    expect((await req('GET', '/v1/core', viewer)).body.installed).toBe(false);
    const missing = await core(viewer, 'mesh.assist.helpers');
    expect(missing.status).toBe(503);
    expect(missing.body.error.message).toMatch(/not installed/);
  });
});
