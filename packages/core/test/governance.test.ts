import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type Policy } from '@fbrx/shared';
import { makeKernel, waitFor } from './helpers';

const AGENT = { origin: 'agent' as const, actor: 'agent:test' };

describe('governance gate', () => {
  it('allows read tools inside allowed roots and denies paths outside them', async () => {
    const { kernel, sandbox, cleanup } = await makeKernel();
    try {
      writeFileSync(join(sandbox, 'notes.txt'), 'hello governance');
      const ok = await kernel.gate.invoke('fs.read_file', { path: join(sandbox, 'notes.txt') }, AGENT);
      expect(ok.status).toBe('succeeded');
      expect(ok.output).toContain('hello governance');

      const denied = await kernel.gate.invoke('fs.read_file', { path: '/etc/hostname' }, AGENT);
      expect(denied.status).toBe('denied');
      expect(denied.output).toMatch(/outside the allowed folders/);
      expect(kernel.audit.query({ outcome: 'denied', limit: 1 })[0].action).toBe('fs.read_file');
    } finally {
      await cleanup();
    }
  });

  it('never exposes the FBRX data directory or protected patterns', async () => {
    const { kernel, dataDir, sandbox, cleanup } = await makeKernel();
    try {
      const policy = structuredClone(kernel.policy.policy);
      policy.filesystem.allowedRoots = [dataDir, sandbox];
      kernel.policy.updateLocal(policy);
      const r = await kernel.gate.invoke('fs.read_file', { path: join(dataDir, 'fbrx.db') }, AGENT);
      expect(r.status).toBe('denied');
      expect(r.output).toMatch(/internal data/);
      writeFileSync(join(sandbox, 'server.pem'), 'x');
      const pem = await kernel.gate.invoke('fs.read_file', { path: join(sandbox, 'server.pem') }, AGENT);
      expect(pem.status).toBe('denied');
    } finally {
      await cleanup();
    }
  });

  it('waits for human approval on write tools and records the decision', async () => {
    const { kernel, sandbox, cleanup } = await makeKernel();
    try {
      const pending = kernel.gate.invoke('fs.write_file', { path: join(sandbox, 'out.txt'), content: 'approved write' }, AGENT);
      const req = await waitFor(() => kernel.approvals.list()[0]);
      expect(req.tool).toBe('fs.write_file');
      expect(kernel.approvals.resolve(req.id, 'approve', 'tester', true)).toBe(true);
      const res = await pending;
      expect(res.status).toBe('succeeded');
      // "remember" created an allow rule, so the next write needs no approval
      expect(kernel.policy.effective().rememberedRules[0].match.tool).toBe('fs.write_file');
      const again = await kernel.gate.invoke('fs.write_file', { path: join(sandbox, 'out2.txt'), content: 'x' }, AGENT);
      expect(again.status).toBe('succeeded');
    } finally {
      await cleanup();
    }
  });

  it('denies when the approver rejects', async () => {
    const { kernel, sandbox, cleanup } = await makeKernel();
    try {
      const pending = kernel.gate.invoke('fs.write_file', { path: join(sandbox, 'no.txt'), content: 'x' }, AGENT);
      const req = await waitFor(() => kernel.approvals.list()[0]);
      kernel.approvals.resolve(req.id, 'deny', 'tester');
      expect((await pending).status).toBe('denied');
    } finally {
      await cleanup();
    }
  });

  it('blocks dangerous shell commands even if a person would approve them', async () => {
    const { kernel, sandbox, cleanup } = await makeKernel();
    try {
      const r = await kernel.gate.invoke('shell.run', { command: 'rm -rf / ', cwd: sandbox }, { origin: 'user', actor: 'u' });
      expect(r.status).toBe('denied');
      const r2 = await kernel.gate.invoke('shell.run', { command: 'echo aGVsbG8= | base64 -d | sh', cwd: sandbox }, { origin: 'user', actor: 'u' });
      expect(r2.status).toBe('denied');
      expect(r2.output).toMatch(/Guardian/);
    } finally {
      await cleanup();
    }
  });

  it('runs approved shell commands from a person directly', async () => {
    const { kernel, sandbox, cleanup } = await makeKernel();
    try {
      const r = await kernel.gate.invoke('shell.run', { command: 'echo fbrx-ok', cwd: sandbox }, { origin: 'user', actor: 'u' });
      expect(r.status).toBe('succeeded');
      expect(r.output).toContain('fbrx-ok');
    } finally {
      await cleanup();
    }
  });

  it('blocks private network targets unless policy allows them', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const r = await kernel.gate.invoke('http.request', { url: 'http://127.0.0.1:1/' }, AGENT);
      expect(r.status).toBe('denied');
      expect(r.output).toMatch(/Private network/);
    } finally {
      await cleanup();
    }
  });

  it('redacts vault secrets from tool output', async () => {
    const { kernel, sandbox, cleanup } = await makeKernel();
    try {
      kernel.vault.set({ name: 'PAYMENTS_KEY', value: 'pk_live_abcdef123456' });
      writeFileSync(join(sandbox, 'leak.txt'), 'the key is pk_live_abcdef123456 ok');
      const r = await kernel.gate.invoke('fs.read_file', { path: join(sandbox, 'leak.txt') }, AGENT);
      expect(r.output).not.toContain('pk_live_abcdef123456');
      expect(r.output).toContain('[REDACTED:PAYMENTS_KEY]');
    } finally {
      await cleanup();
    }
  });

  it('applies rules, risk defaults and audit mode', async () => {
    const { kernel, sandbox, cleanup } = await makeKernel();
    try {
      const p: Policy = structuredClone(kernel.policy.policy);
      p.rules.unshift({ id: 'no-time', match: { tool: 'time.*' }, action: 'deny' });
      kernel.policy.updateLocal(p);
      expect((await kernel.gate.invoke('time.now', {}, AGENT)).status).toBe('denied');
      p.mode = 'audit';
      kernel.policy.updateLocal(p);
      const audited = await kernel.gate.invoke('time.now', {}, AGENT);
      expect(audited.status).toBe('succeeded');
      // Safety constraints still apply in audit mode.
      expect((await kernel.gate.invoke('fs.read_file', { path: '/etc/hostname' }, AGENT)).status).toBe('denied');
      void sandbox;
    } finally {
      await cleanup();
    }
  });

  it('rejects local policy edits when the organization manages policy', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      kernel.policy.applyManaged(DEFAULT_POLICY);
      expect(() => kernel.policy.updateLocal(DEFAULT_POLICY)).toThrow(/managed/);
    } finally {
      await cleanup();
    }
  });

  it('enforces the tool call rate limit', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const p = structuredClone(kernel.policy.policy);
      p.rateLimits.toolCallsPerMinute = 3;
      kernel.policy.updateLocal(p);
      const results = [];
      for (let i = 0; i < 5; i++) results.push((await kernel.gate.invoke('time.now', {}, AGENT)).status);
      expect(results.filter((s) => s === 'denied')).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });
});

describe('settings', () => {
  it('layers managed settings over local ones and locks managed paths', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      kernel.settings.update({ ai: { temperature: 0.7 } });
      kernel.settings.applyManaged({ ai: { temperature: 0.1 }, general: { telemetry: true } }, ['ai.temperature']);
      expect(kernel.settings.get().ai.temperature).toBe(0.1);
      expect(() => kernel.settings.update({ ai: { temperature: 0.9 } })).toThrow(/managed/);
      kernel.settings.update({ general: { theme: 'dark' } });
      expect(kernel.settings.get().general.theme).toBe('dark');
      kernel.settings.clearManaged();
      expect(kernel.settings.get().ai.temperature).toBe(0.7);
    } finally {
      await cleanup();
    }
  });

  it('refuses user-only methods from the Local API or remote commands', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      kernel.vault.set({ name: 'X', value: 'secret-value' });
      await expect(kernel.call('vault.reveal', { name: 'X' }, { origin: 'api', actor: 'script' })).rejects.toThrow(/person at this workstation/);
      await expect(kernel.call('vault.reveal', { name: 'X' }, { origin: 'user', actor: 'me' })).resolves.toEqual({ name: 'X', value: 'secret-value' });
    } finally {
      await cleanup();
    }
  });
});
