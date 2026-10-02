import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MigrateJob, MigrateRequest } from '@fbrx/shared';
import { EventBus } from '../src/events';
import { Migrator } from '../src/system/migrate';
import { tempDir } from './helpers';

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined, child: () => log } as any;

function setup() {
  const events = new EventBus();
  const audits: string[] = [];
  const m = new Migrator({ events, log, audit: (a) => audits.push(a) });
  const run = (r: Partial<MigrateRequest> & { source: string; dest: string }) =>
    new Promise<MigrateJob>((resolve) => {
      const off = events.on('migrate.event', (e) => {
        if (e.type === 'done') {
          off();
          resolve(e.job);
        }
      });
      m.start({ engine: 'builtin', mode: 'copy', ...r });
    });
  return { m, run, audits };
}

function tree() {
  const root = tempDir('fbrx-mig-');
  const src = join(root, 'src');
  mkdirSync(join(src, 'sub'), { recursive: true });
  writeFileSync(join(src, 'a.txt'), 'alpha');
  writeFileSync(join(src, 'sub', 'b.txt'), 'bravo');
  writeFileSync(join(src, 'Thumbs.db'), 'junk');
  return { root, src, dst: join(root, 'dst') };
}

describe('copy & migrate (FBRX copier)', () => {
  it('copies, updates, mirrors and moves, skipping clutter, with a preview that changes nothing', async () => {
    const { run, audits } = setup();
    const { src, dst } = tree();

    const preview = await run({ source: src, dest: dst, dryRun: true, skipJunk: true });
    expect(preview).toMatchObject({ state: 'done', files: 2 });
    expect(existsSync(dst)).toBe(false);

    const copy = await run({ source: src, dest: dst, skipJunk: true });
    expect(copy).toMatchObject({ state: 'done', files: 2, bytes: 10 });
    expect(readFileSync(join(dst, 'sub', 'b.txt'), 'utf8')).toBe('bravo');
    expect(existsSync(join(dst, 'Thumbs.db'))).toBe(false);
    expect((await run({ source: src, dest: dst, skipJunk: true })).files).toBe(0);

    // Update never overwrites a newer file at the destination.
    writeFileSync(join(dst, 'a.txt'), 'edited there');
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(dst, 'a.txt'), later, later);
    expect((await run({ source: src, dest: dst, mode: 'update', skipJunk: true })).files).toBe(0);
    expect(readFileSync(join(dst, 'a.txt'), 'utf8')).toBe('edited there');

    // Mirror makes the destination identical, removing extras.
    writeFileSync(join(dst, 'extra.txt'), 'x');
    await run({ source: src, dest: dst, mode: 'mirror', skipJunk: true });
    expect(existsSync(join(dst, 'extra.txt'))).toBe(false);
    expect(readFileSync(join(dst, 'a.txt'), 'utf8')).toBe('alpha');

    // Move empties the source.
    const dst2 = join(dst, '..', 'moved');
    await run({ source: src, dest: dst2, mode: 'move' });
    expect(readFileSync(join(dst2, 'sub', 'b.txt'), 'utf8')).toBe('bravo');
    expect(existsSync(join(src, 'a.txt'))).toBe(false);
    expect(audits).toContain('migrate.finish');
  });

  it('refuses the classic accidents and explains the command it would run', () => {
    const { m } = setup();
    const { src, dst, root } = tree();
    expect(() => m.plan({ engine: 'builtin', mode: 'copy', source: src, dest: src })).toThrow(/same folder/);
    expect(() => m.plan({ engine: 'builtin', mode: 'copy', source: src, dest: join(src, 'inner') })).toThrow(/inside the source/);
    expect(() => m.plan({ engine: 'builtin', mode: 'mirror', source: src, dest: process.platform === 'win32' ? 'D:\\' : '/' })).toThrow(/whole drive|system or home/);
    expect(() => m.plan({ engine: 'builtin', mode: 'copy', source: join(root, 'missing'), dest: dst })).toThrow(/does not exist/);
    expect(() => m.plan({ engine: 'builtin', mode: 'copy', source: 'relative/path', dest: dst })).toThrow(/full folder paths/);
    const p = m.plan({ engine: 'builtin', mode: 'mirror', source: src, dest: dst });
    expect(p.warnings.join(' ')).toMatch(/deletes files/);
    if (process.platform === 'win32') {
      const r = m.plan({ engine: 'robocopy', mode: 'mirror', source: src, dest: dst, skipJunk: true, threads: 8, dryRun: true });
      expect(r.command).toMatch(/^robocopy .* \/MIR .*\/MT:8 .*\/XF .*Thumbs\.db.* \/L /);
    }
  });
});
