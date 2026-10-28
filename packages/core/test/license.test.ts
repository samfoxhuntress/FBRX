import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LICENSE_FILE_NAME } from '@fbrx/shared';
import { generateSigningKeyPair, signLicense } from '@fbrx/shared/node';
import { makeKernel, tempDir, USER, waitFor } from './helpers';

describe('licensing', () => {
  it('starts and stops licensed services as soon as a license is activated or removed', async () => {
    const keys = generateSigningKeyPair();
    const { kernel, cleanup } = await makeKernel({ devMode: false, licensePublicKeys: [keys.publicKeyPem] });
    try {
      expect(kernel.license.status().edition).toBe('community');
      expect(kernel.services.get('plugins')?.state).toBe('disabled');
      await expect(kernel.call('plugins.install', { path: '/nonexistent' }, USER)).rejects.toThrow(/not included/);

      // A key signed by someone else's control plane is rejected.
      const forged = signLicense(
        { v: 1, lid: 'lic_forged', tenantId: 't', customer: 'Mallory', edition: 'enterprise', seats: 1, features: [], issuedAt: new Date().toISOString(), expiresAt: null, maxMajorVersion: null },
        generateSigningKeyPair().privateKeyPem,
      );
      await expect(kernel.call('license.activate', { key: forged }, USER)).rejects.toThrow();

      const key = signLicense(
        { v: 1, lid: 'lic_1', tenantId: 't', customer: 'Acme', edition: 'enterprise', seats: 5, features: [], issuedAt: new Date().toISOString(), expiresAt: null, maxMajorVersion: null },
        keys.privateKeyPem,
      );
      // A new computer opens in Essentials, free; on its own, Standard and Ultra are bought (Standard can be tried).
      expect(kernel.license.status()).toMatchObject({ tier: 'essentials', chosen: 'essentials', ceiling: 'essentials', ceilingReason: 'standalone', trialUntil: null, trialAvailable: true });
      expect(kernel.edition()).toMatchObject({ productName: 'FBRX Endpoint Essentials', tourDone: false, trialUntil: null, trialAvailable: true });
      await expect(kernel.call('edition.choose', { tier: 'basic' }, USER)).rejects.toThrow(/FBRX Endpoint Standard is \$4\.99 a month .*, or try it free for 7 days/);
      const status = (await kernel.call('license.activate', { key }, USER)) as any;
      // A license (one bought for this computer) turns on its features and goes up to Ultra; Black Hole comes only
      // through an organization.
      expect(status).toMatchObject({ state: 'valid', edition: 'enterprise', tier: 'essentials', ceiling: 'ultra', ceilingReason: 'license', commandUrl: null });
      await waitFor(() => kernel.services.get('plugins')?.state === 'running');
      await expect(kernel.call('edition.choose', { tier: 'blackhole' }, USER)).rejects.toThrow(/comes only through an organization's FBRX Command/);
      expect(await kernel.call('edition.choose', { tier: 'basic' }, USER)).toMatchObject({ tier: 'basic', productName: 'FBRX Endpoint Standard' });
      expect(await kernel.call('edition.choose', { tier: 'ultra' }, USER)).toMatchObject({ tier: 'ultra', productName: 'FBRX Endpoint Ultra' });
      // Only the person at the computer chooses.
      await expect(kernel.call('edition.choose', { tier: 'essentials' }, { origin: 'api', actor: 'localapi:x' })).rejects.toMatchObject({ code: 'FORBIDDEN' });

      await kernel.call('license.remove', {}, USER);
      await waitFor(() => kernel.services.get('plugins')?.state === 'disabled');
      expect(kernel.license.status()).toMatchObject({ tier: 'essentials', chosen: 'ultra', ceiling: 'essentials' });

      // In an organization (FBRX Command): what its license allows, held lower for the computer or its group.
      kernel.meta.set('fleet.deviceId', 'dev_test');
      const sign = (over: object) => signLicense({ v: 1, lid: 'lic_t', tenantId: 't', customer: 'Acme', edition: 'enterprise', seats: 5, features: [], issuedAt: new Date().toISOString(), expiresAt: null, maxMajorVersion: null, ...over }, keys.privateKeyPem);
      expect(await kernel.call('license.activate', { key: sign({ edition: 'community' }) }, USER)).toMatchObject({ ceiling: 'basic', ceilingReason: 'license' });
      expect(await kernel.call('license.activate', { key: sign({ tier: 'basic' }) }, USER)).toMatchObject({ edition: 'enterprise', ceiling: 'basic' });
      expect(await kernel.call('license.activate', { key: sign({ edition: 'community', tier: 'ultra' }) }, USER)).toMatchObject({ ceiling: 'ultra', tier: 'ultra' });
      await expect(kernel.call('edition.choose', { tier: 'blackhole' }, USER)).rejects.toThrow(/license allows up to FBRX Endpoint Ultra/);
      // Black Hole: only in an organization whose license allows it.
      expect(await kernel.call('license.activate', { key: sign({ tier: 'blackhole' }) }, USER)).toMatchObject({ ceiling: 'blackhole', tier: 'ultra' });
      expect(await kernel.call('edition.choose', { tier: 'blackhole' }, USER)).toMatchObject({ tier: 'blackhole', productName: 'FBRX Endpoint Black Hole' });
      expect(kernel.ultraOnly('Mesh')).toBeNull();
      expect(kernel.blackHoleOnly('Network environments')).toBeNull();
      // The same license on a computer on its own goes up to Ultra.
      kernel.meta.delete('fleet.deviceId');
      expect(kernel.license.refresh()).toMatchObject({ tier: 'ultra', chosen: 'blackhole', ceiling: 'ultra', ceilingReason: 'license' });
      expect(kernel.blackHoleOnly('Network environments')).toMatch(/come with FBRX Endpoint Black Hole/);
      kernel.meta.set('fleet.deviceId', 'dev_test');
      expect(await kernel.call('edition.choose', { tier: 'ultra' }, USER)).toMatchObject({ tier: 'ultra' });
      kernel.meta.set('fleet.edition', { vertical: 'business', audience: 'staff', tier: 'essentials', helpdesk: { enabled: true, receiver: false }, autoUpdate: 'notify' });
      expect(kernel.license.refresh()).toMatchObject({ tier: 'essentials', chosen: 'ultra', ceiling: 'essentials', ceilingReason: 'organization' });
      await expect(kernel.call('edition.choose', { tier: 'basic' }, USER)).rejects.toThrow(/holds this computer to FBRX Endpoint Essentials/);

      // The walkthrough, done and asked for again.
      expect(kernel.setTourDone(true).tourDone).toBe(true);
      expect(((await kernel.call('edition.tourDone', { done: false }, USER)) as any).tourDone).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('lets a computer on its own try Standard free for 7 days, once', async () => {
    const { kernel, cleanup } = await makeKernel({ devMode: false });
    try {
      // Only the person at the computer starts it.
      await expect(kernel.call('edition.startTrial', undefined, { origin: 'api', actor: 'localapi:x' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const ed = (await kernel.call('edition.startTrial', undefined, USER)) as any;
      expect(ed).toMatchObject({ tier: 'basic', chosen: 'basic', ceiling: 'basic', ceilingReason: 'trial', trialAvailable: false, productName: 'FBRX Endpoint Standard' });
      const left = Date.parse(ed.trialUntil) - Date.now();
      expect(left).toBeGreaterThan(6.9 * 86_400_000);
      expect(left).toBeLessThanOrEqual(7 * 86_400_000);
      await expect(kernel.call('edition.startTrial', undefined, USER)).rejects.toThrow(/once/);
      // Nothing to say until its last day; then once that it ends tomorrow, and once that it has ended.
      expect(kernel.license.takeTrialNotice()).toBeNull();
      const day = 86_400_000;
      const until = Date.parse(ed.trialUntil);
      expect(kernel.license.takeTrialNotice(until - day / 2)).toBe('ending');
      expect(kernel.license.takeTrialNotice(until - day / 3)).toBeNull();
      kernel.meta.set('edition.trial', { until: new Date(Date.now() - 1000).toISOString(), told: 'ending' });
      kernel.license.refresh();
      expect(kernel.license.takeTrialNotice()).toBe('ended');
      expect(kernel.license.takeTrialNotice()).toBeNull();
      // When it ends, the computer runs Essentials; what was chosen comes back once Standard is bought.
      kernel.meta.set('edition.trial', { until: new Date(Date.now() - 1000).toISOString() });
      expect(kernel.license.refresh()).toMatchObject({ tier: 'essentials', chosen: 'basic', ceilingReason: 'standalone', trialUntil: null, trialAvailable: false });
    } finally {
      await cleanup();
    }
    // A computer in an organization does not take it: its organization decides what it runs.
    const inOrg = await makeKernel({ devMode: false });
    try {
      inOrg.kernel.meta.set('fleet.deviceId', 'dev_test');
      expect(inOrg.kernel.license.refresh()).toMatchObject({ trialAvailable: false });
      await expect(inOrg.kernel.call('edition.startTrial', undefined, USER)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await inOrg.cleanup();
    }
  });

  it('keeps the edition of a computer set up before Essentials existed', async () => {
    const dataDir = tempDir();
    const first = await makeKernel({ dataDir, devMode: false });
    // As a computer from before: set up, and no edition chosen yet (nor anything from 2.0).
    first.kernel.settings.update({ general: { onboardingComplete: true } });
    first.kernel.meta.delete('edition.chosen');
    first.kernel.meta.delete('edition.tourDone');
    first.kernel.meta.delete('edition.v2');
    await first.cleanup();
    const again = await makeKernel({ dataDir, devMode: false, keychain: first.keychain });
    try {
      // It keeps the most it ran on its own (Standard) through its 7-day trial, started by itself, and is not walked
      // through the app again.
      const st = again.kernel.license.status();
      expect(st).toMatchObject({ chosen: 'ultra', tier: 'basic', ceiling: 'basic', ceilingReason: 'trial', trialAvailable: false });
      expect(Date.parse(st.trialUntil!) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
      expect(again.kernel.edition()).toMatchObject({ tourDone: true, ceilingReason: 'trial', trialUntil: st.trialUntil });
      // Then Essentials, unless Standard is bought.
      again.kernel.meta.set('edition.trial', { until: new Date(Date.now() - 1000).toISOString() });
      expect(again.kernel.license.refresh()).toMatchObject({ tier: 'essentials', ceiling: 'essentials', ceilingReason: 'standalone', trialUntil: null });
      // It was had once: starting again does not give it again.
      again.kernel.license.beginV2(true);
      expect(again.kernel.license.refresh()).toMatchObject({ tier: 'essentials', trialAvailable: false });
    } finally {
      await again.cleanup();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('activates a license key file dropped into the data folder (setup wizard / IT tooling) on start', async () => {
    const keys = generateSigningKeyPair();
    const payload = { v: 1 as const, lid: 'lic_file', tenantId: 'offline', customer: 'Sam', edition: 'enterprise' as const, seats: 0, features: [], issuedAt: new Date().toISOString(), expiresAt: null, maxMajorVersion: null };

    const dataDir = tempDir();
    writeFileSync(join(dataDir, LICENSE_FILE_NAME), `${signLicense(payload, keys.privateKeyPem)}\n`);
    const ok = await makeKernel({ dataDir, devMode: false, licensePublicKeys: [keys.publicKeyPem] });
    try {
      expect(ok.kernel.license.status()).toMatchObject({ state: 'valid', edition: 'enterprise', customer: 'Sam', source: 'local' });
      expect(existsSync(join(dataDir, LICENSE_FILE_NAME))).toBe(false);
      await waitFor(() => ok.kernel.services.get('plugins')?.state === 'running');
    } finally {
      await ok.cleanup();
    }

    const otherDir = tempDir();
    writeFileSync(join(otherDir, LICENSE_FILE_NAME), signLicense(payload, generateSigningKeyPair().privateKeyPem));
    const bad = await makeKernel({ dataDir: otherDir, devMode: false, licensePublicKeys: [keys.publicKeyPem] });
    try {
      expect(bad.kernel.license.status().edition).toBe('community');
      expect(existsSync(join(otherDir, `${LICENSE_FILE_NAME}.rejected`))).toBe(true);
    } finally {
      await bad.cleanup();
    }
  });
});
