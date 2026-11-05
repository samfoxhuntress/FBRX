import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDERS } from '@fbrx/shared';
import { shortlistTools } from '../src/ai/tool-shortlist';
import { makeKernel } from './helpers';
import { mockOpenAI } from './mock-llm';

describe('Fabrix and the workspace: "create a project and add this note"', () => {
  it('has the tools for it, even with the short list a small model gets', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const names = shortlistTools(kernel.registry.list(), ['Create a project for me called Garden and add this note: buy soil']).map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(['workspace.create_project', 'workspace.create_note', 'workspace.list_projects']));
    } finally {
      await cleanup();
    }
  });

  it('makes the project, files the note in it, and says so only as the tools did', async () => {
    const { kernel, cleanup } = await makeKernel();
    const results: string[] = [];
    const llm = await mockOpenAI((body, turn) => {
      const tool = body.messages.filter((m: any) => m.role === 'tool').pop();
      if (tool) results.push(tool.content);
      if (turn === 0) return { tool: { name: 'workspace__create_project', args: { name: 'Garden', milestones: ['Plant'] } } };
      if (turn === 1) return { tool: { name: 'workspace__create_note', args: { title: 'Soil', content: 'Buy soil', project: 'garden' } } };
      if (turn === 2) return { tool: { name: 'workspace__create_note', args: { title: 'Seeds', content: 'Buy seeds', project: 'Orchard' } } };
      return { text: 'Made the Garden project with the Soil note in it.' };
    });
    try {
      kernel.settings.update({ ai: { defaultProvider: 'mock', defaultModel: 'm', providers: [...DEFAULT_PROVIDERS, { id: 'mock', type: 'openai-compatible', name: 'Mock', enabled: true, baseUrl: `${llm.url}/v1`, cloud: false }] } });
      const r = await kernel.agent.start({ message: 'Create a project called Garden and add this note: buy soil', origin: 'user', actor: 'u' }).done;
      expect(r.status).toBe('completed');
      const [garden] = kernel.workspace.listProjects();
      expect(garden).toMatchObject({ name: 'Garden', milestones: [expect.objectContaining({ title: 'Plant' })] });
      expect(kernel.workspace.listNotes({ projectId: garden.id }).map((n) => n.title)).toEqual(['Soil']);
      expect(results[0]).toContain(`Created project "Garden" (id ${garden.id})`);
      expect(results[1]).toContain('in project "Garden"');
      // A project that does not exist is said so, not quietly left out.
      expect(results[2]).toContain('No project is called "Orchard"');
      expect(kernel.workspace.listNotes({}).map((n) => n.title)).not.toContain('Seeds');
    } finally {
      await llm.close();
      await cleanup();
    }
  });
});
