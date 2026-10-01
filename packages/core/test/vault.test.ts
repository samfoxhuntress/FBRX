import { describe, expect, it } from 'vitest';
import { makeKernel, memoryKeychain } from './helpers';
import { Kernel } from '../src/kernel';
import { createNodePlatform } from '../src/node-platform';

describe('vault', () => {
  it('stores secrets encrypted and returns metadata only in listings', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      kernel.vault.set({ name: 'API_TOKEN', value: 'super-secret-value', kind: 'api-key', description: 'test' });
      expect(kernel.vault.list().map((s) => s.name)).toEqual(['API_TOKEN']);
      expect(JSON.stringify(kernel.vault.list())).not.toContain('super-secret-value');
      const raw = kernel.db.get<{ value_enc: string }>('SELECT value_enc FROM secrets WHERE name = ?', 'API_TOKEN');
      expect(raw?.value_enc).toMatch(/^v1\./);
      expect(raw?.value_enc).not.toContain('super-secret');
      expect(kernel.vault.get('API_TOKEN')).toBe('super-secret-value');
    } finally {
      await cleanup();
    }
  });

  it('rejects reserved names and hides internal secrets', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      expect(() => kernel.vault.set({ name: 'fbrx.thing', value: 'x' })).toThrow(/reserved/);
      kernel.vault.set({ name: 'fbrx.internal', value: 'hidden' }, { internal: true });
      expect(kernel.vault.list().find((s) => s.name === 'fbrx.internal')).toBeUndefined();
      expect(() => kernel.vault.get('fbrx.internal')).toThrow(/Internal/);
    } finally {
      await cleanup();
    }
  });

  it('locks on a machine whose keychain cannot unwrap the key, and unlocks with the recovery passphrase', async () => {
    const { kernel, dataDir, cleanup } = await makeKernel();
    kernel.vault.set({ name: 'DB_PASSWORD', value: 'hunter2-hunter2' });
    await kernel.vault.setRecoveryPassphrase('correct horse battery staple');
    await kernel.stop();

    // Same data folder, different machine keychain.
    const other = await Kernel.create({ dataDir, platform: createNodePlatform({ dataDir, devMode: true, keychain: memoryKeychain() }) });
    other.settings.update({ localApi: { enabled: false }, runtime: { enabled: false } });
    await other.start();
    try {
      expect(other.vault.status().state).toBe('locked');
      await expect(other.vault.unlockWithRecovery('wrong passphrase!!')).rejects.toThrow(/incorrect/);
      await other.call('vault.unlock', { recoveryPassphrase: 'correct horse battery staple' }, { origin: 'user', actor: 't' });
      expect(other.vault.status().state).toBe('unlocked');
      expect(other.vault.get('DB_PASSWORD')).toBe('hunter2-hunter2');
    } finally {
      await other.stop();
      await cleanup().catch(() => undefined);
    }
  });

  it('applies organisation-managed secrets as read-only', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      kernel.vault.applyManaged([{ name: 'ORG_KEY', value: 'org-value-123', version: 1, description: 'from admin' }]);
      expect(kernel.vault.list()[0]).toMatchObject({ name: 'ORG_KEY', managed: true });
      expect(() => kernel.vault.set({ name: 'ORG_KEY', value: 'mine' })).toThrow(/managed/);
      kernel.vault.applyManaged([]);
      expect(kernel.vault.list()).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});
