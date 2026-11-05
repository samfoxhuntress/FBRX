import { describe, expect, it } from 'vitest';
import { EVERYDAY_TASKS } from '../src/ai/eval/everyday-tasks';
import { shortlistTools } from '../src/ai/tool-shortlist';
import { makeKernel } from './helpers';

describe('everyday tasks', () => {
  it('give a small model the tools and the skill each job needs', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const available = kernel.registry.list();
      const exists = new Set(available.map((t) => t.name));
      const misses: string[] = [];
      for (const task of EVERYDAY_TASKS) {
        // As the agent does it: the skills that fit, the tools their steps name, then the short list.
        const skills = kernel.skills.match(task.ask);
        const named = [...new Set(skills.flatMap((s) => s.steps.join(' ').match(/\b[a-z_]+\.[a-z_]+\b/g) ?? []))];
        const given = new Set(shortlistTools(available, [task.ask], named).map((t) => t.name));
        for (const tool of task.tools.filter((t) => exists.has(t))) if (!given.has(tool)) misses.push(`"${task.ask}" lacks ${tool}`);
        if (!given.has('plan.update')) misses.push(`"${task.ask}" lacks plan.update`);
        if ((skills[0]?.name ?? null) !== task.skill) misses.push(`"${task.ask}" got skill ${skills[0]?.name ?? 'none'}, not ${task.skill ?? 'none'}`);
      }
      expect(misses).toEqual([]);
      // Every tool the list names exists (on Windows all of them; elsewhere all but the Windows-only ones).
      const unknown = EVERYDAY_TASKS.flatMap((t) => t.tools).filter((t) => !exists.has(t) && !['pc.security_status'].includes(t));
      expect(unknown).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
