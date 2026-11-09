import { describe, expect, it } from 'vitest';
import { EVERYDAY_TASKS } from '../src/ai/eval/everyday-tasks';
import { aboutOwnWork, requestWords } from '../src/ai/request-words';
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
        // As the agent does it: the AI Toolkit actions and the skills that fit, the tools their steps name, then the
        // short list.
        const skills = kernel.skills.match(task.ask);
        const kit = kernel.toolkit.context(task.ask)?.tools ?? [];
        const named = [...new Set([...kit, ...skills.flatMap((s) => s.steps.join(' ').match(/\b[a-z_]+\.[a-z_]+\b/g) ?? [])])];
        const given = new Set(shortlistTools(available, [task.ask], named).map((t) => t.name));
        for (const tool of task.tools.filter((t) => exists.has(t))) if (!given.has(tool)) misses.push(`"${task.ask}" lacks ${tool}`);
        for (const tool of task.never ?? []) if (given.has(tool)) misses.push(`"${task.ask}" is offered ${tool}`);
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

describe('what a request asks', () => {
  it('leaves out a quoted name, the content to save and the subject of the person’s notes, not an error message', () => {
    expect(requestWords('My notes about the router are a mess. Can you tidy them up?')).not.toMatch(/router/);
    expect(requestWords('Check my notes about the router and then ping it')).toMatch(/and then ping it/);
    expect(requestWords("Save this as a snippet called 'disk usage': du -sh * | sort -h")).not.toMatch(/disk|du -sh/);
    expect(requestWords('Save a text file called shopping.txt in my workspace with: milk, eggs, bread.')).toMatch(/^Save a text file called\s+in my workspace/);
    expect(requestWords("My PC says 'DNS server not responding'")).toContain('DNS server not responding');
    expect(requestWords('Note: the wifi drops every hour')).toContain('wifi drops');
    expect(requestWords("What's my router's IP?")).toBe("What's my router's IP?");
  });

  it('knows a question about the person’s own notes and tasks from one about the task manager', () => {
    for (const q of ['What tasks do I have open?', 'Summarize my note about the router.', 'Email my list of open tasks to my manager.']) expect(aboutOwnWork(q), q).toBe(true);
    for (const q of ['Task manager says the disk is at 100%', 'My router keeps dropping', 'The taskbar froze']) expect(aboutOwnWork(q), q).toBe(false);
  });
});
