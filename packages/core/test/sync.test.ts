import { describe, expect, it } from 'vitest';
import type { Note, Project, Task } from '@fbrx/shared';
import { makeKernel, waitFor, USER } from './helpers';
import type { Kernel } from '../src/kernel';

/** Two computers on FBRX Mesh, paired with each other. */
async function twoComputers() {
  const made = await Promise.all([47831, 47832].map(async (port) => {
    const k = await makeKernel();
    k.kernel.settings.update({ mesh: { enabled: true, port }, general: { deviceName: `pc-${port}` } });
    await waitFor(() => k.kernel.mesh.running);
    return k;
  }));
  const [a, b] = made.map((m) => m.kernel);
  const pairing = (await a.call('mesh.startPairing', undefined, USER)) as { code: string };
  const peerOfB = (await b.call('mesh.pair', { code: pairing.code, host: '127.0.0.1:47831' }, USER)) as { id: string };
  const peerOfA = a.mesh.devices()[0];
  return { a, b, aSeesB: peerOfA.id, bSeesA: peerOfB.id, cleanup: () => Promise.all(made.map((m) => m.cleanup())) };
}

const tick = () => new Promise((r) => setTimeout(r, 15));
const tasks = (k: Kernel) => k.workspace.listTasks();
const notes = (k: Kernel) => k.workspace.listNotes();

describe('FBRX Sync, computer to computer', () => {
  it('syncs only when both computers allow it, then both ways: new items, newer edits and deletions', async () => {
    const { a, b, aSeesB, bSeesA, cleanup } = await twoComputers();
    try {
      // Nothing until this computer allows it, then nothing until the other one does too.
      await expect(a.call('sync.now', { id: aSeesB }, USER)).rejects.toThrow(/Allow Sync for pc-47832 first/);
      await a.call('mesh.setPermissions', { id: aSeesB, permissions: { sync: true } }, USER);
      await expect(a.call('sync.now', { id: aSeesB }, USER)).rejects.toThrow(/pc-47832 does not allow syncing with this computer yet/);
      await b.call('mesh.setPermissions', { id: bSeesA, permissions: { sync: true } }, USER);
      // Only the person at the computer starts it, never the agent.
      await expect(a.call('sync.now', { id: aSeesB }, { origin: 'agent', actor: 'agent' } as never)).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(/only be performed by a person/) });

      // A has a project with a task and a note, a snippet and a calendar event; B has a task of its own.
      const project = a.workspace.saveProject({ name: 'Garage' }) as Project;
      const shelf = a.workspace.saveTask({ title: 'Build a shelf', projectId: project.id }) as Task;
      const plan = a.workspace.saveNote({ title: 'Plan', content: 'Pine, 4 boards', projectId: project.id }) as Note;
      a.workspace.saveSnippet({ title: 'Cut list', content: '4 × 90 cm' });
      await a.call('calendar.create', { title: 'Buy wood', start: '2026-11-07T10:00:00.000Z', durationMinutes: 60 }, USER);
      const call = b.workspace.saveTask({ title: 'Call the plumber' }) as Task;

      const first = (await a.call('sync.now', { id: aSeesB }, USER)) as { total: Record<string, number>; kinds: Record<string, Record<string, number>> };
      expect(first.total).toMatchObject({ received: 1, sent: 5, deleted: 0, conflicts: 0 });
      expect(b.workspace.listProjects().map((p) => p.name)).toEqual(['Garage']);
      expect(tasks(b).find((t) => t.id === shelf.id)).toMatchObject({ title: 'Build a shelf', projectId: project.id });
      expect(tasks(a).find((t) => t.id === call.id)?.title).toBe('Call the plumber');
      expect(b.workspace.listSnippets().map((s) => s.title)).toEqual(['Cut list']);
      expect(b.db.get<{ title: string }>("SELECT title FROM calendar_items")?.title).toBe('Buy wood');
      // Both remember it, each from its own side.
      const bPeers = (await b.call('sync.peers', undefined, USER)) as Array<{ last: { total: Record<string, number> } }>;
      expect(bPeers[0].last.total).toMatchObject({ received: 5, sent: 1 });

      // Nothing changed: nothing moves.
      expect(((await a.call('sync.now', { id: aSeesB }, USER)) as any).total).toEqual({ received: 0, sent: 0, deleted: 0, conflicts: 0 });

      // B edits the task, A deletes the note: each reaches the other, whichever computer starts the sync.
      await tick();
      b.workspace.saveTask({ id: shelf.id, title: 'Build two shelves', projectId: project.id });
      a.workspace.deleteNote(plan.id);
      const second = (await b.call('sync.now', { id: bSeesA }, USER)) as any;
      expect(second.total).toMatchObject({ sent: 1, deleted: 1 });
      expect(tasks(a).find((t) => t.id === shelf.id)?.title).toBe('Build two shelves');
      expect(notes(b).find((n) => n.id === plan.id)).toBeUndefined();

      // Deleting a project keeps what was in it, in no project, on both.
      a.workspace.deleteProject(project.id);
      await a.call('sync.now', { id: aSeesB }, USER);
      expect(b.workspace.listProjects()).toEqual([]);
      expect(tasks(b).find((t) => t.id === shelf.id)?.projectId).toBeNull();

      // A newer edit beats an older deletion: the task comes back.
      a.workspace.deleteTask(call.id);
      await tick();
      b.workspace.saveTask({ id: call.id, title: 'Call the plumber today' });
      await a.call('sync.now', { id: aSeesB }, USER);
      expect(tasks(a).find((t) => t.id === call.id)?.title).toBe('Call the plumber today');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('keeps both versions of a note changed on both computers, and refuses what it cannot read', async () => {
    const { a, b, aSeesB, bSeesA, cleanup } = await twoComputers();
    try {
      await a.call('mesh.setPermissions', { id: aSeesB, permissions: { sync: true } }, USER);
      await b.call('mesh.setPermissions', { id: bSeesA, permissions: { sync: true } }, USER);
      const n = a.workspace.saveNote({ title: 'Packing list', content: 'tent' }) as Note;
      await a.call('sync.now', { id: aSeesB }, USER);

      // Changed on both since they last synced: the newer wins everywhere, the other stays as a copy beside it.
      await tick();
      a.workspace.saveNote({ id: n.id, title: 'Packing list', content: 'tent, stove' });
      await tick();
      b.workspace.saveNote({ id: n.id, title: 'Packing list', content: 'tent, sleeping bags' });
      const r = (await a.call('sync.now', { id: aSeesB }, USER)) as any;
      expect(r.kinds.notes.conflicts).toBe(1);
      for (const k of [a, b]) {
        const list = notes(k);
        expect(list.find((x) => x.id === n.id)?.content).toBe('tent, sleeping bags');
        expect(list.find((x) => x.title === 'Packing list (copy from pc-47831)')?.content).toBe('tent, stove');
        expect(list).toHaveLength(2);
      }

      // What the other computer sends is checked like anything from outside: a made-up status is refused.
      const bad = { id: 'task_x', title: 'x', details: '', status: 'evil', priority: 'low', due: null, project_id: null, created_at: '2026-11-03T10:00:00.000Z', updated_at: '2026-11-03T10:00:00.000Z', completed_at: null };
      const device = b.mesh.devices()[0];
      await expect(b.sync.handle(device, 'sync.put', { kind: 'tasks', rows: [bad], gone: [] })).rejects.toThrow(/not understood/);
      expect(tasks(b).find((t) => t.id === 'task_x')).toBeUndefined();
    } finally {
      await cleanup();
    }
  }, 60_000);
});
