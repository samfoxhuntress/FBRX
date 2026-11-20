import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type FolderAccessStatus, type FolderRequest } from '@fbrx/shared';
import { makeKernel, tempDir, USER, waitFor } from './helpers';

const LOCAL_API = { origin: 'api' as const, actor: 'script' };

describe('The folders the AI may use', () => {
  it('are added with a picker, taken away, and never include the operating system', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const projects = tempDir('fbrx-projects-');
      const before = (await kernel.call('governance.folders', undefined, USER)) as FolderAccessStatus;
      expect(before.managed).toBe(false);
      expect(before.folders.map((f) => f.entry)).toEqual(kernel.policy.policy.filesystem.allowedRoots);
      // Tokens read as names, with what they are on this computer.
      kernel.policy.updateLocal({ ...kernel.policy.policy, filesystem: { ...kernel.policy.policy.filesystem, allowedRoots: [...kernel.policy.policy.filesystem.allowedRoots, '${HOME}'] } });
      const home = ((await kernel.call('governance.folders', undefined, USER)) as FolderAccessStatus).folders.find((f) => f.entry === '${HOME}');
      expect(home).toMatchObject({ label: 'Your home folder', path: kernel.platform.specialDirs().home });

      await expect(kernel.call('governance.addFolder', { path: projects }, LOCAL_API)).rejects.toThrow();
      const added = (await kernel.call('governance.addFolder', { path: projects }, USER)) as FolderAccessStatus;
      expect(added.folders.map((f) => f.path)).toContain(projects);
      expect(kernel.policy.allowedRoots()).toContain(projects);
      // Adding it twice keeps one.
      await kernel.call('governance.addFolder', { path: projects }, USER);
      expect(kernel.policy.policy.filesystem.allowedRoots.filter((r) => r === projects)).toHaveLength(1);

      await expect(kernel.call('governance.addFolder', { path: join(projects, 'missing') }, USER)).rejects.toThrow(/no folder/);
      await expect(kernel.call('governance.addFolder', { path: process.platform === 'win32' ? 'C:\\Windows' : '/etc' }, USER)).rejects.toThrow(/operating system/);

      const removed = (await kernel.call('governance.removeFolder', { entry: projects }, USER)) as FolderAccessStatus;
      expect(removed.folders.map((f) => f.path)).not.toContain(projects);
    } finally {
      await cleanup();
    }
  });

  it('the AI asks for one, and the person grants it, picks another, or says no', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const share = tempDir('fbrx-share-');
      const other = join(share, 'photos');
      mkdirSync(other);
      const asked: Array<FolderRequest & { state: string }> = [];
      kernel.events.on('governance.folderRequest', (r) => asked.push(r));
      const tool = kernel.registry.get('files.request_access')!;
      expect(tool.risk).toBe('read');
      const ctx = { signal: new AbortController().signal } as never;

      // Granted as asked.
      const first = tool.run({ path: share, reason: 'To sort the photos you mentioned' }, ctx);
      await waitFor(() => asked.some((r) => r.state === 'open'));
      const open = asked.find((r) => r.state === 'open')!;
      expect(open).toMatchObject({ path: share, reason: 'To sort the photos you mentioned' });
      expect(((await kernel.call('governance.folders', undefined, USER)) as FolderAccessStatus).requests).toHaveLength(1);
      await expect(kernel.call('governance.answerFolder', { id: open.id, path: share }, LOCAL_API)).rejects.toThrow();
      await kernel.call('governance.answerFolder', { id: open.id, path: share }, USER);
      expect((await first).data).toEqual({ granted: share });
      expect(kernel.policy.allowedRoots()).toContain(share);

      // Already allowed: no question.
      expect((await tool.run({ path: other, reason: 'Again' }, ctx)).data).toEqual({ granted: other });

      // The person picks another folder.
      await kernel.call('governance.removeFolder', { entry: share }, USER);
      asked.length = 0;
      const second = tool.run({ reason: 'Somewhere to save the report' }, ctx);
      await waitFor(() => asked.some((r) => r.state === 'open'));
      await kernel.call('governance.answerFolder', { id: asked[0].id, path: other }, USER);
      expect((await second).data).toEqual({ granted: other });

      // Says no.
      asked.length = 0;
      const third = tool.run({ path: share, reason: 'More photos' }, ctx);
      await waitFor(() => asked.some((r) => r.state === 'open'));
      await kernel.call('governance.answerFolder', { id: asked[0].id, path: null }, USER);
      const no = await third;
      expect(no.data).toEqual({ granted: null });
      expect(no.output).toMatch(/did not give you a folder/);

      // Decided by the organization: the AI is told so, and nobody is asked.
      kernel.policy.applyManaged(DEFAULT_POLICY);
      asked.length = 0;
      expect((await tool.run({ path: share, reason: 'More' }, ctx)).output).toMatch(/FBRX Command/);
      expect(asked).toHaveLength(0);
      await expect(kernel.call('governance.addFolder', { path: share }, USER)).rejects.toThrow(/organization/);
    } finally {
      await cleanup();
    }
  });
});
