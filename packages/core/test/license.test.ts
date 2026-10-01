import { describe, expect, it } from 'vitest';
import { generateSigningKeyPair, signLicense } from '@fbrx/shared/node';
import { makeKernel, USER, waitFor } from './helpers';

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
      const status = (await kernel.call('license.activate', { key }, USER)) as any;
      expect(status).toMatchObject({ state: 'valid', edition: 'enterprise' });
      await waitFor(() => kernel.services.get('plugins')?.state === 'running');

      await kernel.call('license.remove', {}, USER);
      await waitFor(() => kernel.services.get('plugins')?.state === 'disabled');
    } finally {
      await cleanup();
    }
  });
});
