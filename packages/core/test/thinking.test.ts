import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, thinkingBudget, thinkingLevelOf } from '@fbrx/shared';
import { makeKernel, USER } from './helpers';

describe('how much the agent does on one task (thinking levels)', () => {
  it('sets the steps in the policy and the rest in the settings, for the person at the computer only', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const level = () => thinkingLevelOf(thinkingBudget(kernel.policy.policy, kernel.settings.get()));
      expect(level()).toBe('everyday');
      expect(await kernel.call('ai.setThinking', { level: 'thorough' }, USER)).toMatchObject({ steps: 60, contextSize: 16384 });
      expect(level()).toBe('thorough');
      expect(kernel.policy.policy.ai.maxToolCallsPerRun).toBeGreaterThanOrEqual(180);
      // Fine-tuning one part (Ultra) makes it custom; a level puts all of it back.
      kernel.settings.update({ ai: { maxOutputTokens: 2048 } });
      expect(level()).toBe('custom');
      await kernel.call('ai.setThinking', { level: 'quick' }, USER);
      expect(level()).toBe('quick');
      await expect(kernel.call('ai.setThinking', { level: 'everyday' }, { origin: 'api', actor: 'script' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(kernel.call('ai.setThinking', { level: 'enormous' }, USER)).rejects.toBeTruthy();
    } finally {
      await cleanup();
    }
  });

  it('changes nothing when the organization sets any part of it', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const before = () => thinkingBudget(kernel.policy.policy, kernel.settings.get());
      kernel.settings.applyManaged({ runtime: { contextSize: 8192 } }, ['runtime.contextSize']);
      const was = before();
      await expect(kernel.call('ai.setThinking', { level: 'thorough' }, USER)).rejects.toMatchObject({ code: 'MANAGED' });
      expect(before()).toEqual(was);
      kernel.settings.applyManaged({}, []);
      kernel.policy.applyManaged(structuredClone(DEFAULT_POLICY));
      await expect(kernel.call('ai.setThinking', { level: 'thorough' }, USER)).rejects.toMatchObject({ code: 'MANAGED' });
      expect(before()).toEqual(was);
    } finally {
      await cleanup();
    }
  });
});
