import { availableParallelism, constants } from 'node:os';
import type { AiResources } from '@fbrx/shared';

export interface ResourcePlan {
  /** Processor threads a local model may use. */
  threads: number;
  /** OS scheduling priority for the model process (os.setPriority). */
  priority: number;
  /** How long Ollama keeps a model loaded after the last request. */
  keepAlive: string;
}

/**
 * How hard a local model may work the computer. A model left to itself takes every core at normal priority, which
 * makes the whole PC stutter while it thinks; these plans keep the desktop responsive.
 */
export function resourcePlan(mode: AiResources, logical = availableParallelism()): ResourcePlan {
  const n = Math.max(1, logical);
  switch (mode) {
    case 'light':
      return { threads: Math.max(1, Math.round(n / 4)), priority: constants.priority.PRIORITY_LOW, keepAlive: '2m' };
    case 'full':
      return { threads: Math.max(1, n - 1), priority: constants.priority.PRIORITY_NORMAL, keepAlive: '30m' };
    default:
      return { threads: Math.max(1, Math.floor(n / 2)), priority: constants.priority.PRIORITY_BELOW_NORMAL, keepAlive: '5m' };
  }
}
