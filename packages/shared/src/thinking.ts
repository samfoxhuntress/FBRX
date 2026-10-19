import { MAX_STEPS_PER_TASK, type Policy } from './policy';
import type { Settings } from './settings';

/**
 * How much the agent does on one task, in plain terms (Settings → Agent → Thinking, in every edition). Each level sets
 * the whole work budget underneath it: steps per task, how much of a conversation a local model keeps in mind, and the
 * longest answer (left to the model). From Standard up, each of these is also set on its own, which makes the level
 * Custom.
 */
export const THINKING_LEVELS = ['quick', 'everyday', 'thorough'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ThinkingBudget {
  /** Steps per task (the policy's maxStepsPerRun, so an organization can set it). */
  steps: number;
  /** How much of the conversation the built-in model keeps in mind, in tokens (runtime.contextSize). */
  contextSize: number;
  /** The same for Ollama models (ai.ollamaContext; 0: Ollama's own setting). */
  ollamaContext: number;
  /** The longest answer, in tokens (ai.maxOutputTokens; 0: the model decides). */
  maxOutputTokens: number;
}

/** Everyday is where every computer starts (the default policy and settings); Thorough takes every step there is. */
export const THINKING_BUDGETS: Record<ThinkingLevel, ThinkingBudget> = {
  quick: { steps: 10, contextSize: 8192, ollamaContext: 0, maxOutputTokens: 0 },
  everyday: { steps: 30, contextSize: 8192, ollamaContext: 0, maxOutputTokens: 0 },
  thorough: { steps: MAX_STEPS_PER_TASK, contextSize: 16384, ollamaContext: 16384, maxOutputTokens: 0 },
};

export const THINKING_NAMES: Record<ThinkingLevel, string> = { quick: 'Quick', everyday: 'Everyday', thorough: 'Thorough' };

/** The settings a level sets (its steps are in the policy). An organization that locks one of them sets the level. */
export const THINKING_SETTINGS = ['runtime.contextSize', 'ai.ollamaContext', 'ai.maxOutputTokens'] as const;

/** The work budget a computer has now. */
export function thinkingBudget(policy: Policy, settings: Settings): ThinkingBudget {
  return { steps: policy.ai.maxStepsPerRun, contextSize: settings.runtime.contextSize, ollamaContext: settings.ai.ollamaContext, maxOutputTokens: settings.ai.maxOutputTokens };
}

/** The level a work budget is, or custom when its parts were set one by one. */
export function thinkingLevelOf(b: ThinkingBudget): ThinkingLevel | 'custom' {
  return THINKING_LEVELS.find((l) => sameBudget(THINKING_BUDGETS[l], b)) ?? 'custom';
}

/** The policy with this many steps per task, and room for up to three tool calls a step. */
export function withSteps(policy: Policy, steps: number): Policy {
  const next = structuredClone(policy);
  next.ai.maxStepsPerRun = steps;
  next.ai.maxToolCallsPerRun = Math.max(next.ai.maxToolCallsPerRun, steps * 3);
  return next;
}

function sameBudget(a: ThinkingBudget, b: ThinkingBudget): boolean {
  return a.steps === b.steps && a.contextSize === b.contextSize && a.ollamaContext === b.ollamaContext && a.maxOutputTokens === b.maxOutputTokens;
}
