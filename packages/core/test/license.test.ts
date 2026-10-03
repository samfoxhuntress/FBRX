import { existsSync, writeFileSync } from 'node:fs';
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
      expect(kernel.license.status().tier).toBe('basic');
      const status = (await kernel.call('license.activate', { key }, USER)) as any;
      expect(status).toMatchObject({ state: 'valid', edition: 'enterprise', tier: 'ultra', commandUrl: null });
      await waitFor(() => kernel.services.get('plugins')?.state === 'running');

      await kernel.call('license.remove', {}, USER);
      await waitFor(() => kernel.services.get('plugins')?.state === 'disabled');
      expect(kernel.license.status().tier).toBe('basic');

      // Community runs Endpoint Basic; a tier claim overrides the edition either way.
      const sign = (over: object) => signLicense({ v: 1, lid: 'lic_t', tenantId: 't', customer: 'Acme', edition: 'enterprise', seats: 5, features: [], issuedAt: new Date().toISOString(), expiresAt: null, maxMajorVersion: null, ...over }, keys.privateKeyPem);
      expect(await kernel.call('license.activate', { key: sign({ edition: 'community' }) }, USER)).toMatchObject({ tier: 'basic' });
      expect(await kernel.call('license.activate', { key: sign({ tier: 'basic' }) }, USER)).toMatchObject({ edition: 'enterprise', tier: 'basic' });
      expect(await kernel.call('license.activate', { key: sign({ edition: 'community', tier: 'ultra' }) }, USER)).toMatchObject({ tier: 'ultra' });
    } finally {
      await cleanup();
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
