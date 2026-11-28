import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IsoLibrary } from '../src/isos';
import { ISO_CATALOG, isoCatalog, resolveIso } from '../src/iso-catalog';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const answer = (body: string | Buffer, status = 200) => (async () => new Response(typeof body === 'string' ? body : new Uint8Array(body), { status })) as unknown as typeof fetch;

describe('ISO quick downloads', () => {
  it('offers Ubuntu 26.04 LTS Desktop and Server for the server’s processor', () => {
    expect(isoCatalog('x64').map((e) => [e.id, e.arch])).toEqual([
      ['ubuntu-26.04-desktop', 'amd64'],
      ['ubuntu-26.04-server', 'amd64'],
    ]);
    expect(isoCatalog('arm64').every((e) => e.arch === 'arm64' && e.sums.startsWith('https://cdimage.ubuntu.com/'))).toBe(true);
  });

  it('takes the newest point release from the publisher’s SHA256SUMS, with its checksum', async () => {
    const sums = [
      `${'a'.repeat(64)} *ubuntu-26.04-desktop-amd64.iso`,
      `${'b'.repeat(64)} *ubuntu-26.04-live-server-amd64.iso`,
      `${'c'.repeat(64)} *ubuntu-26.04.2-desktop-amd64.iso`,
      `${'d'.repeat(64)} *ubuntu-26.04.1-desktop-amd64.iso`,
      `${'e'.repeat(64)} *ubuntu-26.04.2-wsl-amd64.wsl`,
    ].join('\n');
    const desktop = ISO_CATALOG.find((e) => e.id === 'ubuntu-26.04-desktop' && e.arch === 'amd64')!;
    expect(await resolveIso(desktop, answer(sums))).toEqual({ url: 'https://releases.ubuntu.com/26.04/ubuntu-26.04.2-desktop-amd64.iso', name: 'ubuntu-26.04.2-desktop-amd64.iso', sha256: 'c'.repeat(64) });
    const server = ISO_CATALOG.find((e) => e.id === 'ubuntu-26.04-server' && e.arch === 'amd64')!;
    expect((await resolveIso(server, answer(sums))).name).toBe('ubuntu-26.04-live-server-amd64.iso');
    // The ARM server image, not its "+largemem" variant.
    const arm = ISO_CATALOG.find((e) => e.id === 'ubuntu-26.04-server' && e.arch === 'arm64')!;
    expect((await resolveIso(arm, answer(`${'f'.repeat(64)} *ubuntu-26.04.1-live-server-arm64+largemem.iso\n${'1'.repeat(64)} *ubuntu-26.04.1-live-server-arm64.iso`))).name).toBe('ubuntu-26.04.1-live-server-arm64.iso');
    await expect(resolveIso(desktop, answer('nothing here'))).rejects.toThrow(/not listed/);
    await expect(resolveIso(desktop, answer('', 503))).rejects.toThrow(/Could not reach releases\.ubuntu\.com/);
  });

  it('keeps a quick download only when it matches the published checksum', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fbrx-isos-'));
    dirs.push(dir);
    const lib = new IsoLibrary(dir, 1024 ** 3);
    const image = Buffer.alloc(64 * 1024, 7);
    const wait = async (id: string) => {
      for (let i = 0; i < 200 && lib.listDownloads().find((d) => d.id === id)?.state === 'running'; i++) await new Promise((r) => setTimeout(r, 5));
      return lib.listDownloads().find((d) => d.id === id)!;
    };
    const good = lib.download('https://example.com/good.iso', 'good.iso', answer(image), sha(image));
    expect(await wait(good.id)).toMatchObject({ state: 'done' });
    expect(existsSync(join(dir, 'good.iso'))).toBe(true);
    const bad = lib.download('https://example.com/bad.iso', 'bad.iso', answer(image), sha(Buffer.from('something else')));
    expect(await wait(bad.id)).toMatchObject({ state: 'failed', error: expect.stringMatching(/does not match the checksum/) });
    expect(existsSync(join(dir, 'bad.iso'))).toBe(false);
    expect(existsSync(join(dir, '.bad.iso.part'))).toBe(false);
  });
});
