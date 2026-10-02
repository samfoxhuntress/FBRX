import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDERS, type EventLogEntry } from '@fbrx/shared';
import { makeKernel, tempDir, USER } from './helpers';
import { mockOpenAI } from './mock-llm';
import { CodeLab } from '../src/system/codelab';
import { eventLogs, queryEvents } from '../src/system/events';

const API = { origin: 'api' as const, actor: 'localapi:agent' };

describe('code lab', () => {
  it('keeps simple code files in its own folder and refuses anything else', async () => {
    const dir = join(tempDir('fbrx-codelab-'), 'codelab');
    const lab = new CodeLab(dir);
    expect(lab.list()).toEqual([]);
    expect(existsSync(dir)).toBe(true);
    const saved = lab.save('rps.py', 'print("rock")\n');
    expect(saved).toMatchObject({ name: 'rps.py', language: 'python' });
    lab.save('Rps.java', 'class Rps {}');
    expect(lab.list().map((f) => f.language).sort()).toEqual(['java', 'python']);
    expect(lab.read('rps.py').content).toBe('print("rock")\n');
    for (const bad of ['../evil.py', 'a/b.py', 'notes.txt', '.hidden.js', 'x.PY', 'C:\\x.ps1', '']) expect(() => lab.save(bad, 'x')).toThrow(/simple file name/);
    expect(() => lab.save('big.js', 'x'.repeat(600 * 1024))).toThrow(/512 KB/);
    expect(() => lab.read('missing.py')).toThrow(/not in the code lab/);
    await expect(lab.sandbox('rps.py', dir)).rejects.toThrow(/PowerShell and batch/);
    lab.remove('rps.py');
    expect(lab.list().map((f) => f.name)).toEqual(['Rps.java']);
    const ed = lab.editors();
    expect(typeof ed.vscode).toBe('boolean');
    expect(ed.sandbox).toBe(process.platform === 'win32' ? ed.sandbox : false);
  });

  it('is reachable through the API only for the person at the computer', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      await kernel.call('codelab.save', { name: 'hello.js', content: 'console.log(1)' }, USER);
      expect(((await kernel.call('codelab.list', undefined, USER)) as any[]).map((f) => f.name)).toEqual(['hello.js']);
      expect(((await kernel.call('codelab.folder', undefined, USER)) as any).path).toMatch(/codelab$/);
      await expect(kernel.call('codelab.read', { name: 'hello.js' }, API)).rejects.toThrow(/person at this workstation/);
      await expect(kernel.call('codelab.save', { name: 'x.js', content: 'x' }, API)).rejects.toThrow(/person at this workstation/);
      await expect(kernel.call('ai.quick', { reqId: 'r1', prompt: 'hi' }, API)).rejects.toThrow(/person at this workstation/);
    } finally {
      await cleanup();
    }
  });
});

describe('quick answers (ai.quick)', () => {
  it('streams an answer without tools, masks secrets in the context, and respects the emergency stop', async () => {
    const { kernel, cleanup } = await makeKernel();
    const llm = await mockOpenAI(() => ({ text: 'This script plays rock paper scissors. Safe to run.' }));
    try {
      kernel.settings.update({ ai: { defaultProvider: 'mock', defaultModel: 'm', providers: [...DEFAULT_PROVIDERS, { id: 'mock', type: 'openai-compatible', name: 'Mock', enabled: true, baseUrl: `${llm.url}/v1`, cloud: false }] } });
      kernel.vault.set({ name: 'API_TOKEN', value: 'sk-very-secret-value-123' });
      const deltas: string[] = [];
      kernel.events.on('ai.quick', (e) => e.reqId === 'q1' && deltas.push(e.delta));
      const r = (await kernel.call('ai.quick', { reqId: 'q1', prompt: 'What if I run this?', context: 'token = "sk-very-secret-value-123"', history: [{ role: 'user', content: 'earlier' }] }, USER)) as any;
      expect(r.answer).toBe('This script plays rock paper scissors. Safe to run.');
      expect(deltas.join('')).toBe(r.answer);
      const body = llm.requests.find((x) => x.path?.includes('/chat/completions'))!.body;
      expect(body.tools ?? []).toEqual([]);
      expect(body.messages[0].role).toBe('system');
      // Back-to-back questions are merged, so turns alternate (some providers insist).
      expect(body.messages.map((m: any) => m.role)).toEqual(['system', 'user']);
      expect(body.messages.at(-1).content).toContain('earlier');
      expect(body.messages.at(-1).content).toContain('What if I run this?');
      // Known secrets never leave in the context.
      expect(JSON.stringify(body)).not.toContain('sk-very-secret-value-123');

      await kernel.call('ai.hardStop', undefined, USER);
      await expect(kernel.call('ai.quick', { reqId: 'q2', prompt: 'hi' }, USER)).rejects.toThrow(/emergency stop/);
      await kernel.call('ai.resume', undefined, USER);
      expect(await kernel.call('ai.quickCancel', { reqId: 'nothing' }, USER)).toEqual({ ok: true });
    } finally {
      await llm.close();
      await cleanup();
    }
  });
});

describe('event viewer', () => {
  it('lists the logs for this system and reads one without throwing', { timeout: 120_000 }, async () => {
    const logs = eventLogs();
    expect(logs.length).toBeGreaterThan(0);
    if (process.platform === 'win32') expect(logs.map((l) => l.id)).toContain('System');
    if (process.platform === 'darwin') return; // the unified log is slow to search; covered on Windows and Linux
    const r = await queryEvents({ log: logs[0].id, levels: ['critical', 'error', 'warning'], hours: 2, limit: 20 });
    expect(Array.isArray(r.entries)).toBe(true);
    expect(r.entries.length).toBeLessThanOrEqual(20);
    for (const e of r.entries as EventLogEntry[]) {
      expect(['critical', 'error', 'warning']).toContain(e.level);
      expect(Number.isNaN(Date.parse(e.time))).toBe(false);
      expect(e.message.length).toBeLessThanOrEqual(4000);
    }
    if (process.platform === 'win32') await expect(queryEvents({ log: 'Not-A-Log', levels: [], hours: 1 })).rejects.toThrow(/Unknown event log/);
  });
});
