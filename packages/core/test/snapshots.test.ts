import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { snapshotName, type ScreenSnapshot } from '@fbrx/shared';
import { makeKernel, tempDir, USER } from './helpers';

/** A 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

describe('FBRX Snapshot', () => {
  it('names snapshots for when they were taken', () => {
    expect(snapshotName(new Date(2026, 9, 24, 8, 5, 3))).toBe('Snapshot 2026-10-24 at 08.05.03');
  });

  it('keeps snapshots in the Pictures folder: saves, lists, marks up and removes them', async () => {
    const { kernel, cleanup } = await makeKernel();
    const home = tempDir('fbrx-home-');
    kernel.platform.specialDirs = () => ({ home, documents: join(home, 'Documents'), desktop: join(home, 'Desktop'), downloads: join(home, 'Downloads'), pictures: join(home, 'Pictures') });
    try {
      const folder = join(home, 'Pictures', 'FBRX Snapshots');
      const changed: string[] = [];
      kernel.events.on('snapshots.changed', (e) => changed.push(e.id));
      const shot = (await kernel.call('snapshots.save', { data: PNG.toString('base64') }, USER)) as ScreenSnapshot;
      expect(shot).toMatchObject({ path: join(folder, shot.id), size: PNG.length });
      expect(shot.id).toMatch(/^Snapshot \d{4}-\d\d-\d\d at \d\d\.\d\d\.\d\d\.png$/);
      // Two in the same second keep both.
      const again = (await kernel.call('snapshots.save', { data: PNG.toString('base64') }, USER)) as ScreenSnapshot;
      expect(again.id).not.toBe(shot.id);
      expect((await kernel.call('snapshots.list', undefined, USER)) as ScreenSnapshot[]).toHaveLength(2);
      expect(changed).toEqual([shot.id, again.id]);

      // Read back whole; a thumbnail comes from the app's graphics engine where there is one.
      expect(await kernel.call('snapshots.read', { id: shot.id }, USER)).toEqual({ mime: 'image/png', data: PNG.toString('base64') });
      expect(await kernel.call('snapshots.read', { id: shot.id, size: 320 }, USER)).toMatchObject({ mime: 'image/png' });
      kernel.platform.images = { thumbnail: (data, side) => Buffer.from(`thumb ${data.length} ${side}`) };
      expect(await kernel.call('snapshots.read', { id: shot.id, size: 320 }, USER)).toEqual({ mime: 'image/jpeg', data: Buffer.from(`thumb ${PNG.length} 320`).toString('base64') });

      // Marked up: saved over the same file.
      const marked = Buffer.concat([PNG, Buffer.from('more')]);
      expect(await kernel.call('snapshots.save', { id: shot.id, data: marked.toString('base64') }, USER)).toMatchObject({ id: shot.id, size: marked.length });

      // Only PNG pictures, and only files in the folder.
      await expect(kernel.call('snapshots.save', { data: Buffer.from('not a picture').toString('base64') }, USER)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(kernel.call('snapshots.read', { id: '../secret.png' }, USER)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(kernel.call('snapshots.read', { id: 'gone.png' }, USER)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // A script with the Local API key sees none of them.
      await expect(kernel.call('snapshots.list', undefined, { origin: 'api', actor: 'script' })).rejects.toMatchObject({ code: 'FORBIDDEN' });

      expect(await kernel.call('snapshots.remove', { id: again.id }, USER)).toEqual({ removed: true });
      expect(existsSync(again.path)).toBe(false);
      expect(((await kernel.call('snapshots.list', undefined, USER)) as ScreenSnapshot[]).map((s) => s.id)).toEqual([shot.id]);
    } finally {
      await cleanup();
    }
  });
});
