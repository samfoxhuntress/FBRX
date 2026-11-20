import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDERS } from '@fbrx/shared';
import { makeKernel, waitFor, USER } from './helpers';
import { mockOpenAI } from './mock-llm';

describe('skills', () => {
  it('finds the skill that fits a request, and keeps the ones the person approves or writes', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const s = kernel.skills;
      expect(s.match('My Wi-Fi keeps dropping in the bedroom').map((x) => x.name)).toEqual(['Slow or dropping Wi-Fi']);
      expect(s.match('how do I free up space on my disk?')[0].name).toBe('Free up disk space');
      expect(s.match('what is the capital of France?')).toEqual([]);

      // Fabrix learns one (through skills.save, which asks first); the person turns a starter one off.
      const printer = s.save({ name: 'Set up the office printer', when: 'Adding the office printer to a computer', steps: ['net.scan_lan to find it', 'Add it from the printer settings'], source: 'learned' });
      expect(s.match('set up the office printer on this laptop').map((x) => x.id)).toEqual([printer.id]);
      kernel.call('skills.setEnabled', { id: 'skill_wifi', enabled: false }, USER);
      expect(s.match('My Wi-Fi keeps dropping')).toEqual([]);
      // The steps go with the request, and each use is counted.
      expect(s.context('set up the office printer')).toBe('### Set up the office printer\nWhen: Adding the office printer to a computer\n1. net.scan_lan to find it\n2. Add it from the printer settings');
      expect(s.list().find((x) => x.id === printer.id)?.uses).toBe(1);
      // The person's own, from Settings; starter skills can be turned off but not changed or removed.
      const mine = (await kernel.call('skills.save', { name: 'Monday report', when: 'Every Monday', steps: ['Collect the numbers'] }, USER)) as { source: string; id: string };
      expect(mine.source).toBe('yours');
      await expect(kernel.call('skills.remove', { id: 'skill_space' }, USER)).rejects.toThrow(/turned off, not removed/);
      expect(await kernel.call('skills.remove', { id: mine.id }, USER)).toEqual({ removed: true });
      await expect(kernel.call('skills.save', { name: 'x', when: '', steps: ['y'] }, { origin: 'api', actor: 'script' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await cleanup();
    }
  });

  it('sends the skill with the message, with the tools it names, even to a small model', async () => {
    const llm = await mockOpenAI(() => ({ text: 'Let me look.' }));
    const { kernel, cleanup } = await makeKernel();
    try {
      kernel.settings.update({ ai: { defaultProvider: 'lan', defaultModel: 'mock-model', providers: [...DEFAULT_PROVIDERS, { id: 'lan', type: 'openai-compatible', name: 'lan', enabled: true, baseUrl: `${llm.url}/v1`, cloud: false }] } } as never);
      const { runId } = (await kernel.call('ai.chat', { message: 'Am I hacked? Something feels off', model: 'mock-model' }, USER)) as { runId: string };
      await waitFor(() => llm.requests.length > 0 && !kernel.agent.activities().some((a) => a.runId === runId));
      const body = llm.requests.at(-1)!.body;
      expect(body.messages[0].content).toContain('## Skills');
      expect(body.messages.at(-1).content).toMatch(/^<skills>\n### Security check-up\n/);
      // Nothing in the request brings in alerts.recent, but the skill names it: a small model gets it. (The Windows-only
      // tools it names, such as pc.security_status, come in on Windows.)
      expect(body.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(expect.arrayContaining(['alerts__recent', 'shield__status']));
    } finally {
      await llm.close();
      await cleanup();
    }
  });
});
