import { THINKING_BUDGETS, withSteps, type ThinkingBudget, type ThinkingLevel } from '@fbrx/shared';
import { CoreError } from '../errors';
import type { PolicyEngine } from '../governance/policy-engine';
import type { SettingsService } from '../settings/settings-service';

/**
 * Sets how much the agent does on one task (a thinking level): the steps per task in this computer's policy; how much
 * of a conversation a local model keeps in mind, whether it thinks before answering, and the longest answer in its
 * settings. Nothing changes when an
 * organization sets any of them.
 */
export function setThinkingLevel(level: ThinkingLevel, d: { policy: PolicyEngine; settings: SettingsService }): ThinkingBudget {
  const budget = THINKING_BUDGETS[level];
  if (d.policy.effective().source === 'managed') throw new CoreError('MANAGED', 'Your organization sets how many steps a task may take');
  // Settings first: a locked one refuses before anything has changed.
  d.settings.update({ runtime: { contextSize: budget.contextSize }, ai: { ollamaContext: budget.ollamaContext, maxOutputTokens: budget.maxOutputTokens, localThinking: budget.localThinking } });
  d.policy.updateLocal(withSteps(d.policy.policy, budget.steps));
  return budget;
}
