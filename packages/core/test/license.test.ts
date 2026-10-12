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
      // A new computer opens in Essentials; on its own it may go up to Standard.
      expect(kernel.license.status()).toMatchObject({ tier: 'essentials', chosen: 'essentials', ceiling: 'basic', ceilingReason: 'standalone' });
      expect(kernel.edition()).toMatchObject({ productName: 'FBRX Endpoint Essentials', tourDone: false });
      const status = (await kernel.call('license.activate', { key }, USER)) as any;
      // The license turns on its features; Ultra still comes only through FBRX Command.
      expect(status).toMatchObject({ state: 'valid', edition: 'enterprise', tier: 'essentials', ceiling: 'basic', commandUrl: null });
      await waitFor(() => kernel.services.get('plugins')?.state === 'running');
      await expect(kernel.call('edition.choose', { tier: 'ultra' }, USER)).rejects.toThrow(/comes through FBRX Command/);
      expect(await kernel.call('edition.choose', { tier: 'basic' }, USER)).toMatchObject({ tier: 'basic', productName: 'FBRX Endpoint Standard' });
      // Only the person at the computer chooses.
      await expect(kernel.call('edition.choose', { tier: 'essentials' }, { origin: 'api', actor: 'localapi:x' })).rejects.toMatchObject({ code: 'FORBIDDEN' });

      await kernel.call('license.remove', {}, USER);
      await waitFor(() => kernel.services.get('plugins')?.state === 'disabled');
      expect(kernel.license.status().tier).toBe('basic');

      // In an organization (FBRX Command): what its license allows, held lower for the computer or its group.
      kernel.meta.set('fleet.deviceId', 'dev_test');
      const sign = (over: object) => signLicense({ v: 1, lid: 'lic_t', tenantId: 't', customer: 'Acme', edition: 'enterprise', seats: 5, features: [], issuedAt: new Date().toISOString(), expiresAt: null, maxMajorVersion: null, ...over }, keys.privateKeyPem);
      expect(await kernel.call('license.activate', { key: sign({ edition: 'community' }) }, USER)).toMatchObject({ ceiling: 'basic', ceilingReason: 'license' });
      expect(await kernel.call('license.activate', { key: sign({ tier: 'basic' }) }, USER)).toMatchObject({ edition: 'enterprise', ceiling: 'basic' });
      expect(await kernel.call('license.activate', { key: sign({ edition: 'community', tier: 'ultra' }) }, USER)).toMatchObject({ ceiling: 'ultra', tier: 'basic' });
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

  it('keeps the edition of a computer set up before Essentials existed', async () => {
    const dataDir = tempDir();
    const first = await makeKernel({ dataDir, devMode: false });
    // As a computer from before: set up, and no edition chosen yet.
    first.kernel.settings.update({ general: { onboardingComplete: true } });
    first.kernel.meta.delete('edition.chosen');
    first.kernel.meta.delete('edition.tourDone');
    await first.cleanup();
    const again = await makeKernel({ dataDir, devMode: false, keychain: first.keychain });
    try {
      // It keeps the most it may run (on its own, Standard) and is not walked through the app again.
      expect(again.kernel.license.status()).toMatchObject({ chosen: 'ultra', tier: 'basic', ceiling: 'basic' });
      expect(again.kernel.edition().tourDone).toBe(true);
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
