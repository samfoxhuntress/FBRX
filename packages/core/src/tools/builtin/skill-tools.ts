import { SKILL_LIMITS } from '@fbrx/shared';
import type { SkillStore } from '../../ai/skills';
import type { ToolSpec } from '../types';

/**
 * Skills for the agent (ai/skills.ts). Saving one is a write: FBRX asks the person first, so every learned skill is one
 * they approved. The skills that fit a request already come with it; skills.list is for "what can you do?".
 */
export function skillTools(skills: SkillStore): ToolSpec[] {
  return [
    {
      name: 'skills.save',
      title: 'Save a skill',
      description:
        'Save how you did a job of several steps, so you do it the same good way next time: a short name, when to use it, and the steps with the tools you used. Offer it at the end of such a job; the person approves it before it is kept.',
      risk: 'write',
      source: 'builtin',
      sourceId: null,
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 3, maxLength: SKILL_LIMITS.name, description: 'Short, like "Set up a new printer"' },
          when: { type: 'string', maxLength: SKILL_LIMITS.when, description: 'When it applies, in the words a person would use' },
          steps: { type: 'array', minItems: 1, maxItems: SKILL_LIMITS.steps, items: { type: 'string', maxLength: SKILL_LIMITS.step }, description: 'What to do, in order, naming the tools' },
        },
        required: ['name', 'when', 'steps'],
      },
      async run(i) {
        const s = skills.save({ name: i.name, when: i.when, steps: i.steps, source: 'learned' });
        return { output: `Saved the skill "${s.name}" (${s.steps.length} steps). It is used when a request fits it; Settings → Skills shows it.`, data: { id: s.id } };
      },
    },
    {
      name: 'skills.list',
      title: 'List skills',
      description: 'The skills you have: jobs you know how to do step by step (starter ones, learned ones and the person\'s own).',
      risk: 'read',
      source: 'builtin',
      sourceId: null,
      inputSchema: { type: 'object', properties: {} },
      async run() {
        const list = skills.list().filter((s) => s.enabled);
        return { output: list.map((s) => `- ${s.name}: ${s.when}`).join('\n') || 'No skills yet.', data: list.map((s) => ({ id: s.id, name: s.name, source: s.source })) };
      },
    },
  ];
}
