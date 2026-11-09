import { describe, expect, it } from 'vitest';
import { ALL_FEATURES, SUPPORT_PASS_PREFIX, type SupportPass } from '@fbrx/shared';
import { generateSigningKeyPair, signSupportPass, verifySupportPass } from '@fbrx/shared/node';
import { makeKernel, USER } from './helpers';

/** A pass for `installId`, for `hours` from now, signed by `privateKeyPem`. */
function makePass(privateKeyPem: string, installId: string, over: Partial<SupportPass> = {}): string {
  const now = Date.now();
  const payload: SupportPass = {
    v: 1,
    installId,
    tier: 'blackhole',
    scope: 'endpoint',
    note: 'Ticket 123',
    issuedBy: 'support@fbrx.example',
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 2 * 3600_000).toISOString(),
    ...over,
  };
  return signSupportPass(payload, privateKeyPem);
}

describe('support passes (shared)', () => {
  it('signs and verifies, and rejects forgeries and expiry', () => {
    const keys = generateSigningKeyPair();
    const pass = makePass(keys.privateKeyPem, 'abc123');
    expect(pass.startsWith(`${SUPPORT_PASS_PREFIX}.`)).toBe(true);
    const ok = verifySupportPass(pass, [keys.publicKeyPem]);
    expect(ok).toMatchObject({ ok: true, expired: false });

    // Signed by a different key: not trusted.
    const forged = makePass(generateSigningKeyPair().privateKeyPem, 'abc123');
    expect(verifySupportPass(forged, [keys.publicKeyPem])).toMatchObject({ ok: false });

    // A past expiry still verifies but reports expired.
    const old = makePass(keys.privateKeyPem, 'abc123', { expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(verifySupportPass(old, [keys.publicKeyPem])).toMatchObject({ ok: true, expired: true });

    // A license key is not a support pass.
    expect(verifySupportPass('FBRX1.aaa.bbb', [keys.publicKeyPem])).toMatchObject({ ok: false });
  });
});

describe('support mode (kernel)', () => {
  it('elevates to Black Hole Edition with a valid pass, unlocks locked settings, and restores on end', async () => {
    const keys = generateSigningKeyPair();
    const { kernel, cleanup } = await makeKernel({ devMode: false, licensePublicKeys: [keys.publicKeyPem] });
    try {
      const installId = kernel.meta.get<string>('install.id')!;
      expect(installId).toBeTruthy();
      // A new computer on its own: Essentials.
      expect(kernel.license.status().tier).toBe('essentials');
      // The install id a pass is minted for is there to read (Settings → License, FBRX/1 show version).
      expect(kernel.support.status()).toMatchObject({ active: false, installId });
      expect(((await kernel.call('cli.exec', { session: 's1', line: 'show version' }, USER)) as { output: string }).output).toContain(`Install id:   ${installId}`);

      // The organization locks a setting; the person cannot change it.
      kernel.settings.applyManaged({ general: { telemetry: false } }, ['general.telemetry']);
      await expect(kernel.call('settings.update', { patch: { general: { telemetry: true } } }, USER)).rejects.toMatchObject({ code: 'MANAGED' });

      // A pass for another computer is refused.
      await expect(kernel.call('support.activate', { pass: makePass(keys.privateKeyPem, 'someone-else') }, USER)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      // An expired pass is refused.
      await expect(kernel.call('support.activate', { pass: makePass(keys.privateKeyPem, installId, { expiresAt: new Date(Date.now() - 1000).toISOString() }) }, USER)).rejects.toThrow(/expired/);

      // A valid pass elevates the computer to Black Hole Edition with everything on.
      const st = (await kernel.call('support.activate', { pass: makePass(keys.privateKeyPem, installId) }, USER)) as { active: boolean; tier: string };
      expect(st).toMatchObject({ active: true, tier: 'blackhole' });
      expect(kernel.license.status()).toMatchObject({ tier: 'blackhole', source: 'support', support: true });

      // Locked settings can now be changed.
      expect(await kernel.call('settings.update', { patch: { general: { telemetry: true } } }, USER)).toBeTruthy();

      // Ending support restores Essentials and re-locks the setting.
      const ended = (await kernel.call('support.end', {}, USER)) as { active: boolean };
      expect(ended.active).toBe(false);
      expect(kernel.license.status().tier).toBe('essentials');
      await expect(kernel.call('settings.update', { patch: { general: { telemetry: false } } }, USER)).rejects.toMatchObject({ code: 'MANAGED' });
    } finally {
      await cleanup();
    }
  });

  it('on an organization\'s computer, works only when the organization turned it on, and ends when it turns it off', async () => {
    const keys = generateSigningKeyPair();
    const { kernel, cleanup } = await makeKernel({ devMode: false, licensePublicKeys: [keys.publicKeyPem] });
    try {
      const installId = kernel.meta.get<string>('install.id')!;
      // In an organization (FBRX Command), with support access not turned on: even a valid pass is refused.
      kernel.meta.set('fleet.deviceId', 'dev_test');
      await expect(kernel.call('support.activate', { pass: makePass(keys.privateKeyPem, installId) }, USER)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(kernel.license.status().source).not.toBe('support');

      // The organization turns it on: the pass works.
      kernel.settings.applyManaged({ support: { allowOnManaged: true } }, ['support.allowOnManaged']);
      expect((await kernel.call('support.activate', { pass: makePass(keys.privateKeyPem, installId) }, USER)) as { active: boolean }).toMatchObject({ active: true });
      expect(kernel.license.status().tier).toBe('blackhole');

      // ...and turns it off again: support ends at once.
      kernel.settings.applyManaged({ support: { allowOnManaged: false } }, ['support.allowOnManaged']);
      expect(kernel.support.status().active).toBe(false);
      expect(kernel.meta.get('support.pass')).toBeNull();
      expect(kernel.license.status().source).not.toBe('support');
    } finally {
      await cleanup();
    }
  });

  it('ends by itself once the pass has run out', async () => {
    const keys = generateSigningKeyPair();
    const { kernel, cleanup } = await makeKernel({ devMode: false, licensePublicKeys: [keys.publicKeyPem] });
    try {
      const installId = kernel.meta.get<string>('install.id')!;
      // A pass that is already in the past: activating is refused, but a stored, expired pass never elevates.
      kernel.meta.set('support.pass', makePass(keys.privateKeyPem, installId, { expiresAt: new Date(Date.now() - 1000).toISOString() }));
      expect(kernel.support.status().active).toBe(false);
      expect(kernel.license.status().tier).toBe('essentials');
    } finally {
      await cleanup();
    }
  });

  it('takes a pass its own organization made without the extra setting, but not one made for another organization', async () => {
    const keys = generateSigningKeyPair();
    const { kernel, cleanup } = await makeKernel({ devMode: false, licensePublicKeys: [keys.publicKeyPem] });
    try {
      const installId = kernel.meta.get<string>('install.id')!;
      kernel.meta.set('fleet.deviceId', 'dev_test');
      kernel.meta.set('fleet.tenantId', 'ten_mine');
      // Made in another organization's FBRX Command: refused (support access is not turned on).
      await expect(kernel.call('support.activate', { pass: makePass(keys.privateKeyPem, installId, { tenantId: 'ten_other' }) }, USER)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      // Made in its own organization's FBRX Command: works.
      expect(await kernel.call('support.activate', { pass: makePass(keys.privateKeyPem, installId, { tenantId: 'ten_mine' }) }, USER)).toMatchObject({ active: true, tier: 'blackhole' });
      // Turning support access off does not end a session the organization started itself.
      kernel.settings.applyManaged({ support: { allowOnManaged: false } }, ['support.allowOnManaged']);
      expect(kernel.support.status().active).toBe(true);
      // The resume phrase, taken where a pass is, ends it.
      expect(await kernel.call('support.activate', { pass: 'refusetobrew' }, USER)).toMatchObject({ active: false });
      expect(kernel.license.status().source).not.toBe('support');
    } finally {
      await cleanup();
    }
  });

  it('starts from FBRX Command with the support.start command', async () => {
    const keys = generateSigningKeyPair();
    const { kernel, cleanup } = await makeKernel({ devMode: false, licensePublicKeys: [keys.publicKeyPem] });
    try {
      const installId = kernel.meta.get<string>('install.id')!;
      kernel.meta.set('fleet.deviceId', 'dev_test');
      kernel.meta.set('fleet.tenantId', 'ten_mine');
      const run = (kernel as unknown as { executeRemoteCommand(c: unknown): Promise<unknown> }).executeRemoteCommand.bind(kernel);
      const now = new Date().toISOString();
      expect(await run({ id: 'cmd_1', type: 'support.start', payload: { pass: makePass(keys.privateKeyPem, installId, { tenantId: 'ten_mine' }) }, createdAt: now, expiresAt: null })).toMatchObject({ active: true, tier: 'blackhole' });
      expect(kernel.license.status().source).toBe('support');
    } finally {
      await cleanup();
    }
  });

  it('the developer phrase unlocks Black Hole Edition at once, until FBRX 3.0', async () => {
    const keys = generateSigningKeyPair();
    const { kernel, cleanup } = await makeKernel({ devMode: false, licensePublicKeys: [keys.publicKeyPem], platform: { appVersion: '2.3.1' } });
    try {
      expect(kernel.license.status().tier).toBe('essentials');
      const st = await kernel.call('support.activate', { pass: '418TeapotAdmin' }, USER);
      // Not a support pass: no banner, no unlocked organization settings, no end time.
      expect(st).toMatchObject({ active: false, developer: true });
      expect(kernel.license.status()).toMatchObject({ tier: 'blackhole', source: 'support' });
      expect(kernel.license.status().features).toEqual([...ALL_FEATURES]);
      // It survives a restart of the services (it is stored), and a support pass coming and going leaves it on.
      kernel.support.start();
      const installId = kernel.meta.get<string>('install.id')!;
      await kernel.call('support.activate', { pass: makePass(keys.privateKeyPem, installId, { tier: 'ultra' }) }, USER);
      expect(kernel.license.status().tier).toBe('ultra');
      kernel.meta.set('support.pass', makePass(keys.privateKeyPem, installId, { expiresAt: new Date(Date.now() - 1000).toISOString() }));
      kernel.support.start();
      expect(kernel.support.status()).toMatchObject({ active: false, developer: true });
      expect(kernel.license.status().tier).toBe('blackhole');
      // Ending it puts the edition back.
      await kernel.call('support.end', {}, USER);
      expect(kernel.support.status().developer).toBe(false);
      expect(kernel.license.status().tier).toBe('essentials');
    } finally {
      await cleanup();
    }
  });

  it('the developer phrase does nothing from FBRX 3.0 on', async () => {
    const { kernel, cleanup } = await makeKernel({ devMode: false, platform: { appVersion: '3.0.0' } });
    try {
      // An unlock left from a 2.x build is forgotten.
      kernel.meta.set('support.developer', { at: new Date().toISOString() });
      kernel.support.start();
      expect(kernel.meta.get('support.developer')).toBeNull();
      await expect(kernel.call('support.activate', { pass: '418teapotadmin' }, USER)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(kernel.license.status().tier).toBe('essentials');
    } finally {
      await cleanup();
    }
  });
});
