import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FBRX_APPS, appUnlocked, handoffFor, type Tier } from '@fbrx/shared';
import { generateSigningKeyPair, signLicense } from '@fbrx/shared/node';
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
    expect(FBRX_APPS.reach.edition).toBe('ultra');
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
      expect(list.map((a) => a.id)).toEqual(['os', 'digger', 'reach', 'browser', 'shield', 'sandbox']);
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
      const phone = { permissions: { status: true, chat: true, ask: true, approve: true, workspace: true, alerts: true, control: true, assist: false, command: true, network: false, sync: false } };
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
