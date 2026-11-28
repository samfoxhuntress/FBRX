import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FBRX_APPS, appUnlocked, handoffFor, type Tier } from '@fbrx/shared';
import { generateSigningKeyPair, signLicense, signSupportPass } from '@fbrx/shared/node';
import { AppRegistry, SHARED_LICENSE_FILE, looksLike } from '../src/apps/app-registry';
import { makeKernel, USER } from './helpers';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** appData with FBRX OS's and FBRX Digger's data folders, and Digger's program file. */
function computer() {
  const apps = mkdtempSync(join(tmpdir(), 'fbrx-apps-'));
  dirs.push(apps);
  const os = join(apps, 'FBRX OS');
  const digger = join(apps, 'FBRX Digger');
  mkdirSync(os);
  mkdirSync(digger);
  const exec = join(apps, 'FBRX Digger.exe');
  writeFileSync(exec, '');
  return { apps, os, digger, exec };
}

describe('the FBRX app family', () => {
  it('names each app with the edition that unlocks it and the release it arrives in', () => {
    expect(FBRX_APPS.digger).toMatchObject({ edition: 'ultra', since: '2.5.0', built: true, tag: 'digger-v' });
    expect(FBRX_APPS.browser.edition).toBe('essentials');
    expect(FBRX_APPS.shield.edition).toBe('basic');
    expect(FBRX_APPS.view.edition).toBe('ultra');
    expect(appUnlocked('digger', 'basic')).toBe(false);
    expect(appUnlocked('digger', 'blackhole')).toBe(true);
  });

  it('hands a taken page off: Open when installed, Get when the edition has it, the edition otherwise', () => {
    const h = (tier: Tier, installed: ('digger' | 'os')[], flavor: 'os' | 'digger' = 'os') => handoffFor('network/digger', { flavor, tier, installed })?.action ?? null;
    expect(h('ultra', ['digger'])).toBe('open');
    expect(h('ultra', [])).toBe('get');
    expect(h('basic', [])).toBe('upgrade');
    expect(h('ultra', [], 'digger')).toBeNull();
    expect(handoffFor('network', { flavor: 'os', tier: 'ultra', installed: [] })).toBeNull();
  });

  it('knows an installed app from what it wrote when it started, and opens only that program', () => {
    const c = computer();
    const launched: string[] = [];
    const digger = new AppRegistry({ self: 'digger', dataDir: c.digger, appsDir: c.apps, version: '1.3.0', exec: c.exec, tier: () => 'essentials', releases: () => ({}) });
    let tier: Tier = 'ultra';
    const os = new AppRegistry({ self: 'os', dataDir: c.os, appsDir: c.apps, version: '2.5.0', exec: null, tier: () => tier, releases: () => ({ digger: { version: '1.3.0', download: 'https://example.com/digger' } }), launch: (e) => launched.push(e) });
    expect(os.installed()).toEqual([]);
    expect(os.list().find((a) => a.id === 'digger')).toMatchObject({ installed: false, unlocked: true, download: 'https://example.com/digger' });
    expect(() => os.open('digger')).toThrow(/not installed/);

    digger.announce();
    expect(os.installed()).toEqual(['digger']);
    expect(os.list().find((a) => a.id === 'digger')).toMatchObject({ installed: true, version: '1.3.0' });
    expect(os.list().find((a) => a.id === 'os')).toMatchObject({ self: true, installed: true, version: '2.5.0' });
    expect(os.open('digger')).toEqual({ opened: 'digger' });
    expect(launched).toEqual([c.exec]);
    expect(() => os.open('os')).toThrow(/This is/);

    // A lighter edition: listed, not opened.
    tier = 'basic';
    expect(() => os.open('digger')).toThrow(/fuller edition/);

    // A record that names another program, or one that is gone, does not count.
    tier = 'ultra';
    writeFileSync(join(c.digger, 'app.json'), JSON.stringify({ id: 'digger', version: '9', exec: join(c.apps, 'calc.exe'), at: '' }));
    writeFileSync(join(c.apps, 'calc.exe'), '');
    expect(os.installed()).toEqual([]);
    writeFileSync(join(c.digger, 'app.json'), JSON.stringify({ id: 'digger', version: '9', exec: join(c.apps, 'gone', 'FBRX Digger.exe'), at: '' }));
    expect(os.installed()).toEqual([]);
    writeFileSync(join(c.digger, 'app.json'), '{ not json');
    expect(os.installed()).toEqual([]);
    // A Mac app bundle names the app by its folder.
    const mac = join(c.apps, 'FBRX Digger.app', 'Contents', 'MacOS');
    mkdirSync(mac, { recursive: true });
    writeFileSync(join(mac, 'FBRX Digger'), '');
    writeFileSync(join(c.digger, 'app.json'), JSON.stringify({ id: 'digger', version: '1.3.0', exec: join(mac, 'FBRX Digger'), at: '' }));
    expect(os.installed()).toEqual(['digger']);
  });

  it('knows each app by its program, however it was installed', () => {
    for (const exec of ['C:\\Program Files\\FBRX OS\\FBRX OS.exe', '/opt/FBRX OS/fbrx-os', '/Applications/FBRX OS.app/Contents/MacOS/FBRX OS', '/home/sam/FBRX-OS-2.5.0-x86_64.AppImage']) expect(looksLike('os', exec)).toBe(true);
    for (const exec of ['/opt/FBRX Digger/fbrx-digger', '/home/sam/FBRX-Digger-1.3.0-arm64.AppImage', 'C:\\Users\\sam\\AppData\\Local\\Programs\\FBRX Digger\\FBRX Digger.exe']) expect(looksLike('digger', exec)).toBe(true);
    for (const exec of ['/usr/bin/calc', '/home/sam/FBRX-OS-evil.AppImage', '/opt/FBRX OS/fbrx-digger']) expect(looksLike('os', exec)).toBe(false);
  });

  it('runs FBRX Digger at the edition FBRX Endpoint’s license gives this computer, checked again in Digger', async () => {
    const keys = generateSigningKeyPair();
    const sign = (tier: 'basic' | 'ultra', privateKeyPem = keys.privateKeyPem) =>
      signLicense({ v: 1, lid: `lic_${tier}`, tenantId: 't', customer: 'Sam', edition: 'pro', seats: 0, features: [], issuedAt: new Date().toISOString(), expiresAt: null, maxMajorVersion: null, tier }, privateKeyPem);
    const c = computer();
    const endpoint = await makeKernel({ devMode: false, licensePublicKeys: [keys.publicKeyPem] });
    const digger = await makeKernel({ devMode: false, licensePublicKeys: [keys.publicKeyPem], platform: { flavor: 'digger' } });
    try {
      const osExec = join(c.apps, 'fbrx-os');
      writeFileSync(osExec, '');
      const os = new AppRegistry({ self: 'os', dataDir: c.os, appsDir: c.apps, version: '2.5.0', exec: osExec, tier: () => endpoint.kernel.license.status().tier, releases: () => ({}) });
      const reader = new AppRegistry({ self: 'digger', dataDir: c.digger, appsDir: c.apps, version: '1.3.0', exec: c.exec, tier: () => 'essentials', releases: () => ({}) });
      const check = () => {
        digger.kernel.license.borrowFrom(() => reader.endpointLicense());
        return digger.kernel.license.status().tier;
      };
      // No FBRX Endpoint on this computer: Digger's network tools are locked.
      expect(check()).toBe('essentials');
      expect(digger.kernel.networkTools()).toBe(false);
      // Endpoint runs the FBRX account's Ultra and shares it: Digger opens.
      endpoint.kernel.license.applyAccount(sign('ultra'));
      endpoint.kernel.license.choose('ultra');
      os.announce();
      os.shareLicense(endpoint.kernel.license.shared());
      expect(check()).toBe('ultra');
      expect(digger.kernel.networkTools()).toBe(true);
      // Pro is not enough.
      endpoint.kernel.license.applyAccount(sign('basic'));
      os.shareLicense(endpoint.kernel.license.shared());
      expect(check()).toBe('basic');
      expect(digger.kernel.networkTools()).toBe(false);
      // A shared file edited to claim more, or a key someone else signed, counts for nothing.
      const file = join(c.os, SHARED_LICENSE_FILE);
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), 'license.account': sign('ultra', generateSigningKeyPair().privateKeyPem), 'edition.chosen': 'blackhole' }));
      expect(check()).toBe('essentials');
      // A damaged file (numbers, lists and objects where text belongs) counts for nothing, without an error.
      writeFileSync(file, JSON.stringify({ 'license.account': 42, 'install.id': ['x'], 'fleet.deviceId': {}, 'fleet.edition': { tier: 'gold' }, 'edition.chosen': 7 }));
      expect(check()).toBe('essentials');
      writeFileSync(file, '[1, 2]');
      expect(check()).toBe('essentials');
      // Endpoint in support mode counts in Digger too: the developer unlock (until 3.0)...
      os.shareLicense(endpoint.kernel.license.shared());
      expect(check()).toBe('basic');
      await endpoint.kernel.call('support.activate', { pass: '418teapotadmin' }, USER);
      os.shareLicense(endpoint.kernel.license.shared());
      expect(check()).toBe('blackhole');
      expect(digger.kernel.networkTools()).toBe(true);
      await endpoint.kernel.call('support.activate', { pass: 'refusetobrew' }, USER);
      os.shareLicense(endpoint.kernel.license.shared());
      expect(check()).toBe('basic');
      // ...and a support pass for this computer, checked again in Digger (one for another computer counts for nothing).
      const pass = (installId: string) => {
        const now = Date.now();
        return signSupportPass({ v: 1, installId, tier: 'ultra', scope: 'endpoint', note: 'Ticket 1', issuedBy: 'support', issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 3600_000).toISOString() }, keys.privateKeyPem);
      };
      await endpoint.kernel.call('support.activate', { pass: pass(endpoint.kernel.meta.get<string>('install.id')!) }, USER);
      os.shareLicense(endpoint.kernel.license.shared());
      expect(check()).toBe('ultra');
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), 'support.pass': pass('another-computer') }));
      expect(check()).toBe('basic');
      await endpoint.kernel.call('support.end', {}, USER);
      // Endpoint uninstalled (its program gone): its leftover license does not count.
      endpoint.kernel.license.applyAccount(sign('ultra'));
      os.shareLicense(endpoint.kernel.license.shared());
      expect(check()).toBe('ultra');
      rmSync(osExec);
      expect(check()).toBe('essentials');
    } finally {
      await endpoint.cleanup();
      await digger.cleanup();
    }
  });

  it('lists the family through the API, and only the person at the computer opens an app', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const list = (await kernel.call('apps.list', undefined, USER)) as any[];
      expect(list.map((a) => a.id)).toEqual(['os', 'digger', 'view', 'browser', 'shield', 'sandbox']);
      await expect(kernel.call('apps.open', { id: 'digger' }, { origin: 'api', actor: 'localapi:agent' })).rejects.toThrow(/person at this workstation/);
      await expect(kernel.call('apps.open', { id: 'digger' }, USER)).rejects.toThrow(/not installed/);
    } finally {
      await cleanup();
    }
  });
});

describe('Mesh by edition (2.5.0)', () => {
  it('lets a paired device do the Pro things anywhere, and approve, lock or hand out work only on Ultra', async () => {
    const pro = await makeKernel({ devMode: false });
    const full = await makeKernel();
    try {
      const phone = { permissions: { status: true, chat: true, ask: true, approve: true, workspace: true, alerts: true, control: true, assist: false, command: true, network: false, sync: false, remote: false, unattended: false } };
      expect(pro.kernel.license.status().tier).not.toBe('ultra');
      for (const p of ['status', 'chat', 'ask', 'workspace', 'alerts'] as const) expect(pro.kernel.mesh.may(phone, p)).toBe(true);
      for (const p of ['approve', 'control', 'command'] as const) expect(pro.kernel.mesh.may(phone, p)).toBe(false);
      expect(full.kernel.license.status().tier).toBe('blackhole');
      for (const p of ['approve', 'control', 'command'] as const) expect(full.kernel.mesh.may(phone, p)).toBe(true);
      expect(full.kernel.mesh.may({ permissions: { ...phone.permissions, approve: false } }, 'approve')).toBe(false);
    } finally {
      await pro.cleanup();
      await full.cleanup();
    }
  });
});

describe('the FBRX apps’ own data, out of the AI’s reach', () => {
  it('keeps file tools out of every FBRX app’s data folder, but not out of the workspace', async () => {
    const { checkPath } = await import('../src/governance/path-guard');
    const c = computer();
    const opts = { roots: [c.apps], denyPatterns: [], readOnly: false, dataDir: c.os, appDataDirs: [c.os, c.digger, join(c.apps, 'FBRX View')] };
    expect(checkPath(join(c.digger, 'app.json'), 'write', opts).ok).toBe(false);
    expect(checkPath(join(c.os, 'apps-license.json'), 'write', opts).ok).toBe(false);
    expect(checkPath(join(c.apps, 'FBRX View', 'app.json'), 'read', opts).ok).toBe(false);
    expect(checkPath(join(c.os, 'workspace', 'notes.txt'), 'write', opts).ok).toBe(true);
    expect(checkPath(join(c.apps, 'Other app', 'file.txt'), 'write', opts).ok).toBe(true);
  });
});

describe('the advanced network tools are FBRX Digger’s (2.5.0)', () => {
  it('leaves the computer’s health alerts (drives, processor, memory, battery, security) to FBRX OS', async () => {
    const endpoint = await makeKernel();
    const digger = await makeKernel({ platform: { flavor: 'digger' } });
    try {
      const ids = (k: typeof endpoint.kernel) => k.alerts.rules().map((r) => r.id);
      expect(ids(endpoint.kernel)).toEqual(expect.arrayContaining(['disk_low', 'cpu_high', 'shield_threat', 'net_down']));
      // No FBRX OS on this computer: Digger still says when the internet connection is lost.
      expect(ids(digger.kernel)).toEqual(expect.arrayContaining(['new_device', 'net_down', 'net_restored']));
      for (const id of ['disk_low', 'cpu_high', 'mem_high', 'temp_high', 'battery_low', 'shield_threat', 'av_problem', 'task_due']) expect(ids(digger.kernel)).not.toContain(id);
      expect(await digger.kernel.alerts.fire('disk_low', 'Drive / is running out of space', '1.0 GB free (2%).')).toBeNull();
      expect(await endpoint.kernel.alerts.fire('disk_low', 'Drive / is running out of space', '1.0 GB free (2%).')).not.toBeNull();
    } finally {
      await endpoint.cleanup();
      await digger.cleanup();
    }
  });

  it('leaves them out of FBRX Endpoint’s Fabrix, which says where they are, and keeps the everyday ones', async () => {
    const endpoint = await makeKernel();
    const digger = await makeKernel({ platform: { flavor: 'digger' } });
    try {
      const has = (k: typeof endpoint.kernel, n: string) => !!k.registry.get(n);
      for (const n of ['device_console.send', 'network_env.overview']) {
        expect(has(endpoint.kernel, n)).toBe(false);
        expect(has(digger.kernel, n)).toBe(true);
      }
      for (const n of ['net.diagnose', 'net.ping', 'net.port_check', 'net.traceroute', 'net.speed_test', 'net.scan_lan']) expect(has(endpoint.kernel, n)).toBe(true);
      const r = await endpoint.kernel.gate.invoke('device_console.sessions', {}, { origin: 'agent', actor: 'agent:test' });
      expect(r.ok).toBe(false);
      expect(r.output).toMatch(/is in FBRX Digger/);
      expect(endpoint.kernel.networkTools()).toBe(false);
      expect(digger.kernel.networkTools()).toBe(true);
    } finally {
      await endpoint.cleanup();
      await digger.cleanup();
    }
  });
});

describe('FBRX Endpoint’s saved connections and network environments move to FBRX Digger (2.5.0)', () => {
  it('copies them over once, checked, without passwords or keys', async () => {
    const { HANDOVER_FILE } = await import('../src/apps/app-registry');
    const c = computer();
    const endpoint = await makeKernel();
    const digger = await makeKernel({ platform: { flavor: 'digger' } });
    try {
      endpoint.kernel.consoles.saveBookmark({ host: '10.0.0.2', protocol: 'ssh', username: 'admin', label: 'Core switch', notes: 'Rack 2' });
      const osExec = join(c.apps, 'fbrx-os');
      writeFileSync(osExec, '');
      const os = new AppRegistry({ self: 'os', dataDir: c.os, appsDir: c.apps, version: '2.5.0', exec: osExec, tier: () => 'ultra', releases: () => ({}) });
      const reader = new AppRegistry({ self: 'digger', dataDir: c.digger, appsDir: c.apps, version: '1.3.0', exec: c.exec, tier: () => 'ultra', releases: () => ({}) });
      os.announce();
      os.share(HANDOVER_FILE, {
        connections: [
          ...endpoint.kernel.consoles.bookmarks().map(({ passwordSaved: _p, ...b }) => b),
          { host: 'bad host; rm -rf /', protocol: 'ssh' },
          { host: '10.0.0.9', protocol: 'ftp' },
        ],
        environments: [{ kind: 'unifi', name: 'School', url: 'https://192.168.1.1', fingerprint: null, defaultSiteId: null }, { kind: 'other', url: 'https://x' }],
      });
      const handed = reader.fromEndpoint(HANDOVER_FILE);
      expect(JSON.stringify(handed)).not.toMatch(/password|apiKey/i);
      expect(digger.kernel.adoptFromEndpoint(handed)).toEqual({ connections: 1, environments: 1 });
      expect(digger.kernel.consoles.bookmarks()).toMatchObject([{ label: 'Core switch', host: '10.0.0.2', username: 'admin', notes: 'Rack 2', passwordSaved: false }]);
      expect(digger.kernel.netenv.list()).toMatchObject([{ name: 'School', hasKey: false }]);
      // Once only: again, or after it was removed in Digger, nothing comes back.
      expect(digger.kernel.adoptFromEndpoint(handed)).toEqual({ connections: 0, environments: 0 });
      digger.kernel.consoles.removeBookmark(digger.kernel.consoles.bookmarks()[0]!.id);
      expect(digger.kernel.adoptFromEndpoint(handed)).toEqual({ connections: 0, environments: 0 });
      expect(digger.kernel.consoles.bookmarks()).toEqual([]);
    } finally {
      await endpoint.cleanup();
      await digger.cleanup();
    }
  });
});

describe('Get: an app’s installer from its GitHub release', () => {
  const assets = (v: string) =>
    [`FBRX-Digger-Setup-${v}.exe`, `FBRX-Digger-${v}-arm64.dmg`, `FBRX-Digger-${v}-x64.dmg`, `FBRX-Digger-${v}-arm64.AppImage`, `FBRX-Digger-${v}-x86_64.AppImage`, `FBRX-Digger-${v}-x64.deb`, `FBRX-OS-Setup-2.5.0.exe`].map((name) => ({ name, url: `https://github.com/x/${name}`, size: 4, digest: null }));

  it('picks the one for this computer', async () => {
    const { pickInstaller } = await import('../src/apps/app-installer');
    const a = assets('1.3.0');
    expect(pickInstaller('digger', a, 'win32', 'x64')?.name).toBe('FBRX-Digger-Setup-1.3.0.exe');
    expect(pickInstaller('digger', a, 'darwin', 'arm64')?.name).toBe('FBRX-Digger-1.3.0-arm64.dmg');
    expect(pickInstaller('digger', a, 'darwin', 'x64')?.name).toBe('FBRX-Digger-1.3.0-x64.dmg');
    expect(pickInstaller('digger', a, 'linux', 'x64')?.name).toBe('FBRX-Digger-1.3.0-x86_64.AppImage');
    expect(pickInstaller('digger', a, 'linux', 'arm64')?.name).toBe('FBRX-Digger-1.3.0-arm64.AppImage');
    expect(pickInstaller('digger', a.slice(6), 'win32', 'x64')).toBeNull();
  });

  it('downloads it from GitHub only, checks it against GitHub’s checksum and opens it', async () => {
    const { createHash } = await import('node:crypto');
    const { downloadAndOpen } = await import('../src/apps/app-installer');
    const dir = mkdtempSync(join(tmpdir(), 'fbrx-get-'));
    dirs.push(dir);
    const bytes = Buffer.from('FBRX');
    const good = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const fake = (digest: string | null, host = 'github.com') =>
      (async (u: string | URL | Request) => {
        const url = String(u);
        if (url.startsWith('https://api.github.com/')) return new Response(JSON.stringify({ assets: [{ name: 'FBRX-Digger-Setup-1.3.0.exe', browser_download_url: `https://${host}/d/FBRX-Digger-Setup-1.3.0.exe`, size: 4, digest }] }), { status: 200 });
        return new Response(bytes, { status: 200 });
      }) as unknown as typeof fetch;
    const opened: string[] = [];
    const base = { tag: 'digger-v1.3.0', downloads: dir, home: dir, platform: 'win32' as const, arch: 'x64', open: (f: string) => opened.push(f) };
    const got = await downloadAndOpen('digger', { ...base, fetch: fake(good) });
    expect(got.name).toBe('FBRX-Digger-Setup-1.3.0.exe');
    expect(readFileSync(got.file, 'utf8')).toBe('FBRX');
    expect(opened).toEqual([got.file]);
    await expect(downloadAndOpen('digger', { ...base, fetch: fake('sha256:' + '0'.repeat(64)) })).rejects.toThrow(/does not match the checksum/);
    await expect(downloadAndOpen('digger', { ...base, fetch: fake(good, 'evil.example') })).rejects.toThrow(/only taken from GitHub/);
    // No checksum from GitHub and no SHA256SUMS.txt: not opened.
    await expect(downloadAndOpen('digger', { ...base, fetch: fake(null) })).rejects.toThrow(/no checksum/);
    expect(opened).toHaveLength(1);
    // The release's SHA256SUMS.txt stands in for GitHub's checksum.
    const sum = good.slice(7);
    const withSums = (async (u: string | URL | Request) => {
      const url = String(u);
      if (url.startsWith('https://api.github.com/')) return new Response(JSON.stringify({ assets: [{ name: 'FBRX-Digger-Setup-1.3.0.exe', browser_download_url: 'https://github.com/d/FBRX-Digger-Setup-1.3.0.exe', size: 4, digest: null }, { name: 'SHA256SUMS.txt', browser_download_url: 'https://github.com/d/SHA256SUMS.txt', size: 100 }] }), { status: 200 });
      if (url.endsWith('SHA256SUMS.txt')) return new Response(`${'1'.repeat(64)}  FBRX-Digger-1.3.0-x64.dmg\n${sum}  FBRX-Digger-Setup-1.3.0.exe\n`, { status: 200 });
      return new Response(bytes, { status: 200 });
    }) as unknown as typeof fetch;
    await downloadAndOpen('digger', { ...base, fetch: withSums });
    expect(opened).toHaveLength(2);
  });

  it('gets only an app the edition unlocks, with a release', async () => {
    const c = computer();
    let tier: Tier = 'basic';
    const calls: string[] = [];
    const os = new AppRegistry({ self: 'os', dataDir: c.os, appsDir: c.apps, version: '2.5.0', exec: null, tier: () => tier, releases: () => ({ digger: { version: '1.3.0', download: 'https://github.com/x' } }), dirs: { downloads: c.apps, home: c.apps }, install: async (_id, d) => (calls.push(d.tag), { file: 'f', name: 'n' }) });
    await expect(os.get('digger')).rejects.toThrow(/fuller edition/);
    await expect(os.get('browser')).rejects.toThrow(/arrives in/);
    tier = 'ultra';
    await expect(os.get('digger')).resolves.toEqual({ file: 'f', name: 'n' });
    expect(calls).toEqual(['digger-v1.3.0']);
  });
});
