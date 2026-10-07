import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ServerResources } from '../src/system/server-resources';
import { tempDir } from './helpers';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

describe('FBRX Server resources inside FBRX Endpoint', () => {
  it('says when this copy carries none', () => {
    expect(new ServerResources(null, () => tempDir()).info()).toMatchObject({ available: false, files: [] });
    expect(new ServerResources(tempDir(), () => tempDir()).info().available).toBe(false);
  });

  it('lists, checks, copies and reads what the installer carried', async () => {
    const res = tempDir('fbrx-res-');
    const downloads = tempDir('fbrx-dl-');
    const dir = join(res, 'server');
    mkdirSync(join(dir, 'docs'), { recursive: true });
    const iso = Buffer.from('pretend installer');
    writeFileSync(join(dir, 'fbrx-server-0.1.0-amd64.iso'), iso);
    writeFileSync(join(dir, 'docs', 'SERVER.md'), '# FBRX Server\n\nHello.');
    writeFileSync(join(res, 'secret.txt'), 'not yours');
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        version: '0.1.0',
        builtAt: '2026-10-07T00:00:00.000Z',
        files: [
          { name: 'fbrx-server-0.1.0-amd64.iso', kind: 'iso', title: 'FBRX Server installer ISO', description: 'Boot it', size: iso.length, sha256: sha(iso) },
          { name: 'docs/SERVER.md', kind: 'doc', title: 'FBRX Server and FBRX Virtual', description: null, size: 1, sha256: 'stale' },
          { name: 'missing.tar.gz', kind: 'bundle', title: 'Gone', description: null, size: 1, sha256: 'x' },
          { name: '../secret.txt', kind: 'doc', title: 'Escape', description: null, size: 1, sha256: 'x' },
        ],
      }),
    );
    const r = new ServerResources(res, () => downloads);
    const info = r.info();
    expect(info).toMatchObject({ available: true, version: '0.1.0', iso: true });
    // Files that are not there, or outside the folder, are not offered.
    expect(info.files.map((f) => f.name)).toEqual(['fbrx-server-0.1.0-amd64.iso', 'docs/SERVER.md']);
    expect(info.files[0]).toMatchObject({ kind: 'iso', size: iso.length });

    expect(await r.verify('fbrx-server-0.1.0-amd64.iso')).toMatchObject({ ok: true });
    expect(await r.verify('docs/SERVER.md')).toMatchObject({ ok: false, expected: 'stale' });
    await expect(r.verify('../secret.txt')).rejects.toThrow();

    const first = await r.copy('fbrx-server-0.1.0-amd64.iso');
    const second = await r.copy('fbrx-server-0.1.0-amd64.iso');
    expect(first.path).toBe(join(downloads, 'fbrx-server-0.1.0-amd64.iso'));
    expect(second.path).toBe(join(downloads, 'fbrx-server-0.1.0-amd64 (2).iso'));
    expect(readFileSync(second.path).equals(iso)).toBe(true);
    expect(existsSync(join(downloads, 'secret.txt'))).toBe(false);

    expect(r.readDoc('docs/SERVER.md').text).toContain('Hello.');
    expect(() => r.readDoc('fbrx-server-0.1.0-amd64.iso')).toThrow(/Only guides/);
  });
});
