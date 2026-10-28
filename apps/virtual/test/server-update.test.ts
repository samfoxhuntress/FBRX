import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkForUpdate, installedVersion, readServerRelease, readStaged, type UpdatePaths } from '../src/server-update';

let work: string;
let paths: UpdatePaths;

/** A small FBRX Server bundle, packed like bundle.mjs packs the real one. */
function bundle(version: string, o: { name?: string; broken?: boolean } = {}): { file: string; sha256: string } {
  const top = join(work, `src-${version}-${Math.random().toString(36).slice(2)}`);
  const dir = join(top, o.name ?? `fbrx-server-${version}`);
  mkdirSync(join(dir, 'fbrx-virtual'), { recursive: true });
  writeFileSync(join(dir, 'VERSION'), `${version}\n`);
  if (!o.broken) writeFileSync(join(dir, 'install.sh'), '#!/usr/bin/env bash\necho installing\n');
  writeFileSync(join(dir, 'fbrx-virtual', 'server.mjs'), '// FBRX Virtual\n');
  const file = join(work, `fbrx-server-${version}${o.broken ? '-broken' : ''}.tar.gz`);
  execFileSync('tar', ['-czf', file, '-C', top, '.']);
  return { file, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') };
}

function manifest(server: object): string {
  const f = join(work, `release-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify({ version: '1.9.6', server }));
  return f;
}

/** github.com, as far as the update check sees it: the bundle and its checksum file. */
function fakeGitHub(files: Record<string, Buffer | string>): typeof fetch {
  return (async (url: string | URL) => {
    const body = files[String(url)];
    if (body === undefined) return new Response('not found', { status: 404 });
    const buf = typeof body === 'string' ? Buffer.from(body) : body;
    return new Response(new Uint8Array(buf), { status: 200, headers: { 'content-length': String(buf.length) } });
  }) as typeof fetch;
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'fbrx-update-'));
  paths = { dir: join(work, 'update'), releaseFile: join(work, 'fbrx-server-release') };
  writeFileSync(paths.releaseFile, 'NAME="FBRX Server"\nVERSION="0.1.0"\nROLES="virtual,ai,gate"\n');
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe('fbrx-server update check', () => {
  it('reads what runs and what the release list offers', async () => {
    expect(installedVersion(paths)).toBe('0.1.0');
    expect(installedVersion({ ...paths, releaseFile: join(work, 'none') })).toBe('0.0.0');
    await expect(readServerRelease(manifest({ version: 'soon', bundle: 'x' }))).rejects.toThrow(/names no FBRX Server release/);
    await expect(readServerRelease(join(work, 'missing.json'))).rejects.toThrow(/Could not read the release list/);
  });

  it('says so when this server is up to date, and downloads nothing', async () => {
    const r = await checkForUpdate({ paths, manifest: manifest({ version: '0.1.0', bundle: 'https://example.invalid/b.tar.gz' }), fetchImpl: fakeGitHub({}) });
    expect(r).toEqual({ state: 'current', installed: '0.1.0', latest: '0.1.0' });
    expect(readStaged(paths)).toBeNull();
  });

  it('downloads a newer one, checks it against the checksum published next to it, and gets it ready', async () => {
    const b = bundle('0.1.1');
    const url = 'https://github.com/samfoxhuntress/FBRX/releases/download/v1.9.6/fbrx-server-0.1.1.tar.gz';
    const gh = fakeGitHub({ [url]: readFileSync(b.file), [`${url}.sha256`]: `${b.sha256}  fbrx-server-0.1.1.tar.gz\n` });
    const lines: string[] = [];
    const r = await checkForUpdate({ paths, manifest: manifest({ version: '0.1.1', summary: 'Gate fixes', notes: ['Clear of the router'], bundle: url }), fetchImpl: gh, log: (l) => lines.push(l) });
    expect(r.state).toBe('staged');
    if (r.state !== 'staged') return;
    expect(r.staged).toMatchObject({ version: '0.1.1', from: url, sha256: b.sha256, summary: 'Gate fixes', notes: ['Clear of the router'] });
    expect(existsSync(join(r.staged.bundleDir, 'install.sh'))).toBe(true);
    expect(lines).toContain('Checksum matches.');
    // What fbrx-server (bash) reads.
    const env = readFileSync(join(paths.dir, 'staged.env'), 'utf8');
    expect(env).toContain('VERSION=0.1.1\n');
    expect(env).toContain(`BUNDLE=${r.staged.bundleDir}\n`);
    expect(readStaged(paths)).toMatchObject({ version: '0.1.1', notes: ['Clear of the router'] });

    // Asked again, it is already there: nothing downloaded twice.
    const again = await checkForUpdate({ paths, manifest: manifest({ version: '0.1.1', bundle: url }), fetchImpl: fakeGitHub({}) });
    expect(again).toMatchObject({ state: 'staged', already: true });
  });

  it('takes bundles only from GitHub releases, unless the release list is a mirror chosen on the server', async () => {
    const b = bundle('0.1.1');
    const url = 'https://downloads.example.com/fbrx-server-0.1.1.tar.gz';
    const m = manifest({ version: '0.1.1', bundle: url, sha256: b.sha256 });
    await expect(checkForUpdate({ paths, manifest: m, fetchImpl: fakeGitHub({ [url]: readFileSync(b.file) }) })).rejects.toThrow(/downloads.example.com, not github.com: refused/);
    expect(await checkForUpdate({ paths, manifest: m, anyHost: true, fetchImpl: fakeGitHub({ [url]: readFileSync(b.file) }) })).toMatchObject({ state: 'staged' });
  });

  it('refuses a download that does not match its checksum, or one with no checksum at all', async () => {
    const b = bundle('0.1.1');
    const url = 'https://github.com/x/y/releases/download/v1/fbrx-server-0.1.1.tar.gz';
    await expect(checkForUpdate({ paths, manifest: manifest({ version: '0.1.1', bundle: url, sha256: 'ab'.repeat(32) }), fetchImpl: fakeGitHub({ [url]: readFileSync(b.file) }) })).rejects.toThrow(
      /does not match its checksum/,
    );
    expect(readStaged(paths)).toBeNull();
    expect(existsSync(join(paths.dir, 'downloads', 'fbrx-server-0.1.1.tar.gz'))).toBe(false);
    await expect(checkForUpdate({ paths, manifest: manifest({ version: '0.1.1', bundle: url }), fetchImpl: fakeGitHub({ [url]: readFileSync(b.file) }) })).rejects.toThrow(/no published checksum/);
  });

  it('refuses a bundle that is not the version the list names, or not a bundle at all', async () => {
    const wrong = bundle('0.1.2');
    await expect(checkForUpdate({ paths, manifest: manifest({ version: '0.1.1', bundle: wrong.file, sha256: wrong.sha256 }) })).rejects.toThrow(/is FBRX Server 0.1.2, not 0.1.1/);
    const broken = bundle('0.1.1', { broken: true });
    await expect(checkForUpdate({ paths, file: broken.file })).rejects.toThrow(/not an FBRX Server bundle/);
    expect(readStaged(paths)).toBeNull();
    expect(existsSync(join(paths.dir, 'staged.new'))).toBe(false);
  });

  it('takes a bundle brought along (a USB stick), newer only unless forced', async () => {
    const b = bundle('0.2.0');
    const r = await checkForUpdate({ paths, file: b.file });
    expect(r).toMatchObject({ state: 'staged', staged: { version: '0.2.0', from: b.file, sha256: b.sha256 } });

    const old = bundle('0.0.9');
    expect(await checkForUpdate({ paths, file: old.file })).toEqual({ state: 'current', installed: '0.1.0', latest: '0.0.9' });
    // The newer one stays ready.
    expect(readStaged(paths)?.version).toBe('0.2.0');
    expect(await checkForUpdate({ paths, file: old.file, force: true })).toMatchObject({ state: 'staged', staged: { version: '0.0.9' } });

    // A checksum file next to it is checked.
    const c = bundle('0.3.0');
    writeFileSync(`${c.file}.sha256`, `${'cd'.repeat(32)}  x\n`);
    await expect(checkForUpdate({ paths, file: c.file })).rejects.toThrow(/does not match its checksum/);
    expect(existsSync(c.file)).toBe(true);
  });
});
