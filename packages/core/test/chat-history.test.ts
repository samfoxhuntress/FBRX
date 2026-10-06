import { describe, expect, it } from 'vitest';
import type { ConversationSummary, ProjectSummary } from '@fbrx/shared';
import { makeKernel, USER } from './helpers';

const LOCAL_API = { origin: 'api' as const, actor: 'script' };

/** Cleaning up the chat history, and keeping chats with a project. */
describe('chat history', () => {
  it('adds chats to projects, lists them by project, and keeps them when the project goes', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const a = kernel.conversations.create('Garden plan', 'user');
      const b = kernel.conversations.create('Tax questions', 'user');
      const project = (await kernel.call('projects.save', { name: 'Garden' }, USER)) as { id: string };

      const moved = (await kernel.call('ai.conversations.setProject', { id: a.id, projectId: project.id }, USER)) as ConversationSummary;
      expect(moved.projectId).toBe(project.id);
      expect(((await kernel.call('ai.conversations.list', { projectId: project.id }, USER)) as ConversationSummary[]).map((c) => c.title)).toEqual(['Garden plan']);
      expect(((await kernel.call('ai.conversations.list', { projectId: 'none' }, USER)) as ConversationSummary[]).map((c) => c.title)).toEqual(['Tax questions']);
      expect(((await kernel.call('projects.list', undefined, USER)) as ProjectSummary[])[0]).toMatchObject({ name: 'Garden', chats: 1 });
      await expect(kernel.call('ai.conversations.setProject', { id: b.id, projectId: 'proj_missing' }, USER)).rejects.toThrow(/Project not found/);

      // Deleting the project, even with everything in it, puts its chats back in the main history.
      await kernel.call('projects.delete', { id: project.id, cascade: true }, USER);
      expect(kernel.conversations.summary(a.id).projectId).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('deletes several chats at once, and cleans up old ones (counting first, keeping project chats)', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const old = (title: string, days: number) => {
        const c = kernel.conversations.create(title, 'user');
        (kernel as any).db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', new Date(Date.now() - days * 86400_000).toISOString(), c.id);
        return c;
      };
      const ancient = old('Last spring', 200);
      const stale = old('Two months ago', 60);
      const kept = old('Old but in a project', 300);
      const fresh = old('This morning', 0);
      const project = (await kernel.call('projects.save', { name: 'Keep' }, USER)) as { id: string };
      await kernel.call('ai.conversations.setProject', { id: kept.id, projectId: project.id }, USER);

      expect(await kernel.call('ai.conversations.cleanup', { olderThanDays: 30, dryRun: true }, USER)).toEqual({ deleted: 2 });
      expect(kernel.conversations.exists(ancient.id)).toBe(true);
      expect(await kernel.call('ai.conversations.cleanup', { olderThanDays: 30 }, USER)).toEqual({ deleted: 2 });
      expect(kernel.conversations.exists(ancient.id) || kernel.conversations.exists(stale.id)).toBe(false);
      expect(kernel.conversations.exists(kept.id) && kernel.conversations.exists(fresh.id)).toBe(true);
      expect(await kernel.call('ai.conversations.cleanup', { olderThanDays: 30, includeProjects: true, dryRun: true }, USER)).toEqual({ deleted: 1 });

      const x = kernel.conversations.create('One', 'user');
      const y = kernel.conversations.create('Two', 'user');
      expect(await kernel.call('ai.conversations.deleteMany', { ids: [x.id, y.id, x.id, 'conv_gone'] }, USER)).toEqual({ deleted: 2, skipped: 0 });

      // Only the person at the computer can clear the history in bulk.
      await expect(kernel.call('ai.conversations.cleanup', { olderThanDays: 0 }, LOCAL_API)).rejects.toThrow(/person at the|only|user/i);
      await expect(kernel.call('ai.conversations.deleteMany', { ids: [fresh.id] }, LOCAL_API)).rejects.toThrow();
      expect(kernel.conversations.exists(fresh.id)).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
