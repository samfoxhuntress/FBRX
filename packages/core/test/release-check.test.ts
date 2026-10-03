import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, codenameFor, displayVersion, type Settings } from '@fbrx/shared';
import { EventBus } from '../src/events';
import { Logger, LogSink } from '../src/logger';
import { ReleaseChecker } from '../src/updates/release-check';
import { makeZip, tempDir } from './helpers';

const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  servers.splice(0).forEach((s) => s.close());
  delete process.env.FBRX_RELEASE_MANIFEST;
});

async function serve(files: Record<string, Buffer | string>) {
  const hits: string[] = [];
  const srv = createServer((req, res) => {
    hits.push(req.url!);
    const body = files[req.url!];
    if (body === undefined) return res.writeHead(404).end();
    res.writeHead(200, { 'content-length': Buffer.byteLength(body) }).end(body);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv);
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, hits };
}

function checker(dataRoot: string, over: Partial<ConstructorParameters<typeof ReleaseChecker>[0]> = {}) {
  let settings: Settings = structuredClone(DEFAULT_SETTINGS);
  const notify = vi.fn(async (_title: string, _body: string, _version: string) => undefined as unknown);
  const launch = vi.fn(() => 'started');
  const events = new EventBus();
  const c = new ReleaseChecker({
    appVersion: '1.8.1',
    dataRoot,
    settings: () => settings,
    skip: (v) => (settings = { ...settings, updates: { ...settings.updates, skipVersion: v } }),
    events,
    log: new Logger(new LogSink(), 'release'),
    internet: () => true,
    notify,
    launchInstaller: launch,
    ...over,
  });
  return { c, notify, launch, events };
}

const manifest = (base: string, version: string) =>
  JSON.stringify({ version, stage: 'Alpha', codename: 'Spindle', released: '2026-10-10', importance: 'recommended', summary: 'Better things.', notes: ['One', 'Two'], download: `${base}/fbrx.zip`, page: 'https://github.com/samfoxhuntress/FBRX' });

describe('new versions', () => {
  it('offers a newer version once, and not one that was skipped', async () => {
    const srv = await serve({ '/release.json': manifest('https://github.com', '1.8.2') });
    process.env.FBRX_RELEASE_MANIFEST = `${srv.base}/release.json`;
    const dataRoot = tempDir();
    const { c, notify } = checker(dataRoot);
    const r = await c.check();
    expect(r).toMatchObject({ state: 'available', latest: { version: '1.8.2', notes: ['One', 'Two'] }, skipped: false, canInstall: false });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe('FBRX OS Alpha 1.8.2 is available');
    await c.check();
    expect(notify).toHaveBeenCalledTimes(1);
    // Another start of the app does not remind again either.
    const again = checker(dataRoot);
    await again.c.check();
    expect(again.notify).not.toHaveBeenCalled();
    expect(c.skip('1.8.2').skipped).toBe(true);
  });

  it('says so when this is the latest, and reports a broken list', async () => {
    const srv = await serve({ '/release.json': manifest('https://github.com', '1.8.1'), '/bad.json': '{"version":"soon"}' });
    process.env.FBRX_RELEASE_MANIFEST = `${srv.base}/release.json`;
    const { c, notify } = checker(tempDir());
    expect((await c.check()).state).toBe('current');
    expect(notify).not.toHaveBeenCalled();
    process.env.FBRX_RELEASE_MANIFEST = `${srv.base}/bad.json`;
    expect(await c.check()).toMatchObject({ state: 'error', message: 'The release list could not be read' });
  });

  it('downloads the new version into the install folder, keeps this computer’s files and starts the installer', async () => {
    const zip = makeZip([
      { name: 'FBRX-main/package-lock.json', data: '{}' },
      { name: 'FBRX-main/apps/desktop/package.json', data: JSON.stringify({ version: '1.8.2' }) },
      { name: 'FBRX-main/README.md', data: 'new readme' },
      { name: 'FBRX-main/Install FBRX OS.command', data: '#!/bin/sh', mode: 0o755 },
      { name: 'FBRX-main/.fbrx-keys/license-signing.pem', data: 'SHOULD NOT REPLACE' },
    ]);
    const srv = await serve({ '/fbrx.zip': zip });
    const files = await serve({ '/release.json': manifest(srv.base, '1.8.2') });
    process.env.FBRX_RELEASE_MANIFEST = `${files.base}/release.json`;

    const root = tempDir('fbrx-src-');
    mkdirSync(join(root, 'apps', 'desktop'), { recursive: true });
    mkdirSync(join(root, '.fbrx-keys'));
    writeFileSync(join(root, 'package-lock.json'), '{}');
    writeFileSync(join(root, 'apps', 'desktop', 'package.json'), JSON.stringify({ version: '1.8.1' }));
    writeFileSync(join(root, 'README.md'), 'old readme');
    writeFileSync(join(root, '.fbrx-keys', 'license-signing.pem'), 'MY KEY');
    const dataRoot = tempDir();
    writeFileSync(join(dataRoot, 'install-source.json'), JSON.stringify({ root }));

    const { c, launch, events } = checker(dataRoot);
    expect(() => c.install()).toThrow(/Check for updates first/);
    expect((await c.check()).canInstall).toBe(true);
    const done = new Promise<void>((resolve) => events.on('release.changed', (s) => s.installing?.phase === 'started' && resolve()));
    c.install();
    await done;
    expect(launch).toHaveBeenCalledWith(root);
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('new readme');
    expect(JSON.parse(readFileSync(join(root, 'apps', 'desktop', 'package.json'), 'utf8')).version).toBe('1.8.2');
    expect(readFileSync(join(root, '.fbrx-keys', 'license-signing.pem'), 'utf8')).toBe('MY KEY');
    expect(existsSync(join(root, 'Install FBRX OS.command'))).toBe(true);
  });

  it('refuses a download that holds another version', async () => {
    const zip = makeZip([
      { name: 'x/package-lock.json', data: '{}' },
      { name: 'x/apps/desktop/package.json', data: JSON.stringify({ version: '1.7.0' }) },
    ]);
    const srv = await serve({ '/fbrx.zip': zip });
    const files = await serve({ '/release.json': manifest(srv.base, '1.8.2') });
    process.env.FBRX_RELEASE_MANIFEST = `${files.base}/release.json`;
    const root = tempDir('fbrx-src-');
    mkdirSync(join(root, 'apps', 'desktop'), { recursive: true });
    writeFileSync(join(root, 'package-lock.json'), '{}');
    const dataRoot = tempDir();
    writeFileSync(join(dataRoot, 'install-source.json'), JSON.stringify({ root }));
    const { c, launch, events } = checker(dataRoot);
    await c.check();
    const failed = new Promise<string | null>((resolve) => events.on('release.changed', (s) => s.installing?.phase === 'failed' && resolve(s.installing.message)));
    c.install();
    expect(await failed).toMatch(/holds version 1.7.0, not 1.8.2/);
    expect(launch).not.toHaveBeenCalled();
  });

  it('names versions the Alpha way, with codenames', () => {
    expect(displayVersion('1.8.1')).toBe('Alpha 1.8.1');
    expect(codenameFor('1.8.1')?.name).toBe('Spindle');
    expect(codenameFor('2.0.0')?.name).toBe('Loom');
    expect(codenameFor('9.9.9')).toBeNull();
  });
});
