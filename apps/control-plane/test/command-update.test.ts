import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Db } from '@fbrx/shared/node';
import { buildServer, type BuiltServer } from '../src/server';
import { loadConfig } from '../src/config';
import { CP_MIGRATIONS } from '../src/migrations';
import { CommandUpdater, type CommandUpdateStatus } from '../src/services/command-update';
import { makeZip } from '../../../packages/core/test/helpers';

const PASSWORD = 'Super-Secret-Admin-Pass-1';
const FBRX_VERSION = JSON.parse(readFileSync(new URL('../../desktop/package.json', import.meta.url), 'utf8')).version as string;
const dirs: string[] = [];
const temp = (prefix = 'fbrx-cmd-') => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
const servers: Array<{ close: () => void }> = [];

async function serve(files: Record<string, Buffer | string>) {
  const srv = createServer((req, res) => {
    const body = files[req.url!];
    if (body === undefined) return res.writeHead(404).end();
    res.writeHead(200, { 'content-length': Buffer.byteLength(body) }).end(body);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv);
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}

const manifest = (download: string, version: string) =>
  JSON.stringify({
    version,
    stage: 'Alpha',
    released: '2026-10-20',
    importance: 'recommended',
    summary: 'For FBRX OS.',
    notes: ['An FBRX OS note'],
    download,
    page: 'https://github.com/samfoxhuntress/FBRX',
    command: { summary: 'FBRX Command updates itself.', notes: ['A note for FBRX Command'] },
  });

afterEach(() => {
  servers.splice(0).forEach((s) => s.close());
  delete process.env.FBRX_RELEASE_MANIFEST;
});
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('FBRX Command updates itself', () => {
  let server: BuiltServer;
  let base: string;
  let token: string;
  let tenantId: string;
  const api = async (method: string, path: string, body?: unknown, as = token) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${as}`, 'x-fbrx-tenant': tenantId ?? '', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
  };
  const login = async (email: string) => (await (await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) })).json()).token as string;

  beforeAll(async () => {
    server = await buildServer(loadConfig({}, { dataDir: temp('fbrx-cp-'), port: 0, host: '127.0.0.1', logLevel: 'silent', setupToken: 'setup-token-123', adminConsoleDir: null }));
    await server.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
    tenantId = (await (await fetch(`${base}/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupToken: 'setup-token-123', organization: 'Home', kind: 'home', name: 'Sam', email: 'sam@home.example', password: PASSWORD }) })).json()).tenantId;
    token = await login('sam@home.example');
  });
  afterAll(async () => server?.close());

  it('carries the FBRX version, checks the release list, and lets only the platform operator update', async () => {
    expect((await (await fetch(`${base}/healthz`)).json()).version).toBe(FBRX_VERSION);
    const first = (await api('GET', '/v1/admin/command/update')).json as CommandUpdateStatus;
    expect(first).toMatchObject({ currentVersion: FBRX_VERSION, state: 'idle', autoCheck: true, latest: null, canInstall: false });

    process.env.FBRX_RELEASE_MANIFEST = `${await serve({ '/release.json': manifest('https://github.com/samfoxhuntress/FBRX/archive/refs/tags/v99.0.0.zip', '99.0.0') })}/release.json`;
    const checked = (await api('POST', '/v1/admin/command/update/check')).json as CommandUpdateStatus;
    // FBRX Command's own notes, when the release has them.
    expect(checked).toMatchObject({ state: 'available', latest: { version: '99.0.0', summary: 'FBRX Command updates itself.', notes: ['A note for FBRX Command'] } });
    // Not installed with "Install FBRX Command" (no FBRX folder known): Update now says what to do instead.
    const install = await api('POST', '/v1/admin/command/update/install');
    expect(install.status).toBe(409);
    expect(install.json.error.message).toMatch(/Install FBRX Command/);
    expect((await api('POST', '/v1/admin/command/update/skip', { version: '99.0.0' })).json.skipped).toBe(true);
    expect((await api('POST', '/v1/admin/command/update/auto', { on: false })).json).toMatchObject({ autoCheck: false });
    expect((await api('POST', '/v1/admin/command/update/auto', { on: true })).json).toMatchObject({ autoCheck: true });

    // An administrator sees the version but cannot update FBRX Command.
    expect((await api('POST', '/v1/admin/users', { email: 'alex@home.example', name: 'Alex', role: 'admin', password: PASSWORD })).status).toBe(200);
    const alex = await login('alex@home.example');
    expect((await api('GET', '/v1/admin/command/update', undefined, alex)).json.currentVersion).toBe(FBRX_VERSION);
    expect((await api('POST', '/v1/admin/command/update/check', undefined, alex)).status).toBe(403);
    expect((await api('POST', '/v1/admin/command/update/install', undefined, alex)).status).toBe(403);
  });
});

describe('Update now', () => {
  /** An installed FBRX Command: its home (config.json naming the FBRX folder, data/) and that FBRX folder. */
  function installed(version: string) {
    const root = temp('fbrx-src-');
    mkdirSync(join(root, 'apps', 'desktop'), { recursive: true });
    mkdirSync(join(root, 'scripts', 'setup'), { recursive: true });
    mkdirSync(join(root, '.fbrx-keys'));
    writeFileSync(join(root, 'package-lock.json'), '{}');
    writeFileSync(join(root, 'scripts', 'setup', 'command.mjs'), '// old');
    writeFileSync(join(root, 'apps', 'desktop', 'package.json'), JSON.stringify({ version }));
    writeFileSync(join(root, '.fbrx-keys', 'license-signing.pem'), 'MY KEY');
    const home = temp('fbrx-cmd-home-');
    mkdirSync(join(home, 'data'));
    writeFileSync(join(home, 'config.json'), JSON.stringify({ installedFrom: root }));
    const db = new Db(join(home, 'data', 'control-plane.db'));
    db.migrate(CP_MIGRATIONS);
    return { root, home, db };
  }

  it('downloads the new FBRX folder over the old one, keeps this computer’s keys and starts the installer', async () => {
    const zip = makeZip([
      { name: 'FBRX-1.9.9/package-lock.json', data: '{}' },
      { name: 'FBRX-1.9.9/apps/desktop/package.json', data: JSON.stringify({ version: '1.9.9' }) },
      { name: 'FBRX-1.9.9/scripts/setup/command.mjs', data: '// new' },
      { name: 'FBRX-1.9.9/Install FBRX Command.command', data: '#!/bin/sh', mode: 0o755 },
      { name: 'FBRX-1.9.9/.fbrx-keys/license-signing.pem', data: 'SHOULD NOT REPLACE' },
    ]);
    const zipBase = await serve({ '/fbrx.zip': zip });
    const { root, home, db } = installed('1.9.8');
    const launch = vi.fn(() => 'started');
    const u = new CommandUpdater({ version: '1.9.8', db, dataDir: join(home, 'data'), log: () => undefined, launchInstaller: launch, manifestUrl: `${await serve({ '/release.json': manifest(`${zipBase}/fbrx.zip`, '1.9.9') })}/release.json` });
    try {
      expect(() => u.install()).toThrow(/Check for updates first/);
      expect(await u.check()).toMatchObject({ state: 'available', canInstall: true, installedFrom: root });
      u.install();
      for (let i = 0; i < 100 && u.status().installing?.phase !== 'started' && u.status().installing?.phase !== 'failed'; i++) await new Promise((r) => setTimeout(r, 50));
      expect(u.status().installing).toMatchObject({ phase: 'started', message: 'started' });
      expect(launch).toHaveBeenCalledWith(root, home);
      expect(readFileSync(join(root, 'scripts', 'setup', 'command.mjs'), 'utf8')).toBe('// new');
      expect(JSON.parse(readFileSync(join(root, 'apps', 'desktop', 'package.json'), 'utf8')).version).toBe('1.9.9');
      expect(readFileSync(join(root, '.fbrx-keys', 'license-signing.pem'), 'utf8')).toBe('MY KEY');
      expect(existsSync(join(root, 'Install FBRX Command.command'))).toBe(true);
    } finally {
      db.close();
    }
  });

  it('leaves new versions to FBRX Server when it is the server’s command role', async () => {
    const { home, db } = installed('1.9.8');
    const launch = vi.fn(() => 'started');
    process.env.FBRX_CP_MANAGED_BY = 'fbrx-server';
    try {
      const u = new CommandUpdater({ version: '1.9.8', db, dataDir: join(home, 'data'), log: () => undefined, launchInstaller: launch, manifestUrl: `${await serve({ '/release.json': manifest('https://github.com/x.zip', '1.9.9') })}/release.json` });
      expect(await u.check()).toMatchObject({ state: 'available', canInstall: false, installedFrom: null, managedBy: 'FBRX Server' });
      expect(() => u.install()).toThrow(/role of FBRX Server.*fbrx-server update check/);
      expect(launch).not.toHaveBeenCalled();
    } finally {
      delete process.env.FBRX_CP_MANAGED_BY;
      db.close();
    }
  });

  it('refuses a download that holds another version, or comes from somewhere else', async () => {
    const zip = makeZip([
      { name: 'x/package-lock.json', data: '{}' },
      { name: 'x/scripts/setup/command.mjs', data: '' },
      { name: 'x/apps/desktop/package.json', data: JSON.stringify({ version: '1.7.0' }) },
    ]);
    const zipBase = await serve({ '/fbrx.zip': zip });
    const { home, db } = installed('1.9.8');
    const launch = vi.fn(() => 'started');
    try {
      const u = new CommandUpdater({ version: '1.9.8', db, dataDir: join(home, 'data'), log: () => undefined, launchInstaller: launch, manifestUrl: `${await serve({ '/release.json': manifest(`${zipBase}/fbrx.zip`, '1.9.9') })}/release.json` });
      await u.check();
      u.install();
      for (let i = 0; i < 100 && u.status().installing?.phase !== 'failed'; i++) await new Promise((r) => setTimeout(r, 50));
      expect(u.status().installing?.message).toMatch(/holds version 1.7.0, not 1.9.9/);
      expect(launch).not.toHaveBeenCalled();

      const elsewhere = new CommandUpdater({ version: '1.9.8', db, dataDir: join(home, 'data'), log: () => undefined, launchInstaller: launch, manifestUrl: `${await serve({ '/release.json': manifest('https://example.com/fbrx.zip', '1.9.9') })}/release.json` });
      await elsewhere.check();
      expect(() => elsewhere.install()).toThrow(/only taken from GitHub/);
    } finally {
      db.close();
    }
  });
});
