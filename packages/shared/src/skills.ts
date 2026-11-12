/**
 * Skills: how Fabrix does a job that takes several steps, written down so it does it the same good way next time.
 * FBRX comes with a few (starter); Fabrix offers to save the ones it works out with you (learned), each saved only
 * when you approve it; and you can write your own. The ones that fit a request go to the model with the message.
 */
export interface Skill {
  id: string;
  name: string;
  /** When to use it, in the person's words. */
  when: string;
  /** What to do, in order, with the tools by name. */
  steps: string[];
  source: 'starter' | 'learned' | 'yours';
  enabled: boolean;
  /** How many requests it went with. */
  uses: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export const SKILL_LIMITS = { name: 80, when: 300, step: 400, steps: 12 } as const;
