import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearHog, duplicates, spaceChanges, spaceMap, spaceSummary } from '../src/system/space';
import { makeKernel, USER } from './helpers';

describe('the space map', () => {
  let root: string;
  const file = (p: string, bytes: number | Buffer) => {
    mkdirSync(join(root, p, '..'), { recursive: true });
    if (typeof bytes === 'number') {
      writeFileSync(join(root, p), '');
      truncateSync(join(root, p), bytes); // sparse: big on paper, nothing on disk
    } else writeFileSync(join(root, p), bytes);
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'fbrx-space-'));
    file('Movies/holiday.mp4', 80 * 1024 * 1024);
    file('Pictures/cat.jpg', 3 * 1024 * 1024);
    file('Music/song.flac', 2 * 1024 * 1024);
    file('site/node_modules/react/index.js', 900_000);
    file('site/node_modules/react/node_modules/inner/x.js', 100_000);
    file('site/index.html', 1000);
    file('tool/.venv/pyvenv.cfg', 100);
    file('tool/.venv/lib/big.so', 1_500_000);
    const same = Buffer.alloc(1_200_000, 7);
    file('Documents/report.pdf', same);
    file('Documents/copy of report.pdf', same);
    file('Documents/other.pdf', Buffer.alloc(1_200_000, 8)); // same size, different contents
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('shows where the space goes: by folder, by kind of file, the largest files and the space hogs inside', async () => {
    const m = await spaceMap(root);
    expect(m.partial).toBe(false);
    expect(m.files).toBe(11);
    expect(m.tree.children![0]).toMatchObject({ name: 'Movies', dir: true });
    // A big file shows on the map by itself, inside its folder.
    expect(m.tree.children![0].children?.[0]).toMatchObject({ name: 'holiday.mp4', dir: false });
    expect(m.kinds[0]).toMatchObject({ kind: 'videos', size: 80 * 1024 * 1024, files: 1 });
    expect(m.kinds.map((k) => k.kind)).toEqual(expect.arrayContaining(['pictures', 'music', 'documents', 'code', 'apps']));
    expect(m.largest[0].path).toBe(join(root, 'Movies', 'holiday.mp4'));
    // node_modules once (not the one nested inside it), and the Python environment.
    expect(m.found.map((h) => [h.id, h.path])).toEqual(
      expect.arrayContaining([
        ['node_modules', join(root, 'site', 'node_modules')],
        ['venv', join(root, 'tool', '.venv')],
      ]),
    );
    expect(m.found).toHaveLength(2);
  });

  it('finds files with the same contents, and says what grew since last time', async () => {
    const d = await duplicates(root);
    expect(d.groups).toHaveLength(1);
    expect(d.groups[0].paths.sort()).toEqual([join(root, 'Documents', 'copy of report.pdf'), join(root, 'Documents', 'report.pdf')]);
    expect(d.wasted).toBe(1_200_000);

    const before = spaceSummary(await spaceMap(root));
    file('Movies/trailer.mov', 200 * 1024 * 1024);
    const changes = spaceChanges(before, await spaceMap(root));
    expect(changes![0]).toMatchObject({ name: 'Movies', before: 80 * 1024 * 1024, after: 280 * 1024 * 1024 });
  });

  it('deletes a build folder it recognizes, and nothing else that way', async () => {
    await expect(clearHog('node_modules', join(root, 'Documents'))).rejects.toThrow(/Only caches and build folders/);
    await expect(clearHog('venv', join(root, 'site'))).rejects.toThrow(/Only caches and build folders/);
    const r = await clearHog('node_modules', join(root, 'site', 'node_modules'));
    expect(r.freed).toBe(1_000_000);
    expect(existsSync(join(root, 'site', 'node_modules'))).toBe(false);
    expect(existsSync(join(root, 'site', 'index.html'))).toBe(true);
  });

  it('maps deeper and remembers each folder on Endpoint Ultra; the Trash needs the desktop app', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      expect(['ultra', 'blackhole']).toContain(kernel.license.status().tier);
      const first = (await kernel.call('storage.space', { path: root }, USER)) as { ultra: boolean; changes: unknown; since: string | null };
      expect(first).toMatchObject({ ultra: true, changes: null, since: null });
      file('Music/album.flac', 300 * 1024 * 1024);
      const again = (await kernel.call('storage.space', { path: root }, USER)) as { changes: Array<{ name: string }>; since: string };
      expect(again.since).toBeTruthy();
      expect(again.changes.map((c) => c.name)).toEqual(['Music']);
      expect(((await kernel.call('storage.duplicates', { path: root }, USER)) as { groups: unknown[] }).groups).toHaveLength(1);
      await expect(kernel.call('files.trash', { paths: [join(root, 'Music', 'song.flac')] }, USER)).rejects.toThrow(/desktop app/);
    } finally {
      await cleanup();
    }
  });
});
