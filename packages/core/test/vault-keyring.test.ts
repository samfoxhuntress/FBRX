import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openBytes, sealString } from '@fbrx/shared/node';
import type { Kernel } from '../src/kernel';
import { FileKeychain, type KeychainAdapter } from '../src/platform';
import { makeKernel, tempDir } from './helpers';

/** The desktop's keyring as the vault sees it (Linux: the secret service through Electron), with the key file to fall back on. */
function keyring(fallback: KeychainAdapter | null = null): KeychainAdapter {
  const key = randomBytes(32);
  return {
    kind: 'os',
    fallback,
    available: () => true,
    protect: async (d) => sealString(key, d, 'test-keyring'),
    unprotect: async (b) => openBytes(key, b, 'test-keyring'),
  };
}

/** A start outside the desktop session (Linux): no keyring, only the key file. */
function outsideSession(dataDir: string): FileKeychain {
  const f = new FileKeychain(join(dataDir, 'keychain.key'));
  f.unreachable = true;
  return f;
}

const kept = (k: Kernel) => k.db.get<{ keychain_kind: string }>('SELECT keychain_kind FROM vault_keys')?.keychain_kind;

describe('vault: the keyring on Linux', () => {
  it('waits for a start that reaches the keyring, and never moves the key out of it', async () => {
    const os = keyring();
    const first = await makeKernel({ keychain: os });
    first.kernel.vault.set({ name: 'DB_PASSWORD', value: 'hunter2-hunter2' });
    await first.kernel.vault.setRecoveryPassphrase('correct horse battery staple');
    await first.kernel.stop();

    // Started by another app: the keyring is out of reach.
    const port = 41000 + Math.floor(Math.random() * 5000);
    const outside = await makeKernel({ dataDir: first.dataDir, keychain: outsideSession(first.dataDir), localApiPort: port });
    expect(outside.kernel.vault.status()).toMatchObject({ state: 'locked', lockReason: 'keyring' });
    // The Local API waits for the vault, and says so.
    expect(outside.kernel.services.get('localapi')).toMatchObject({ state: 'stopped', message: 'Waiting for the vault to be unlocked' });
    const info = (await outside.kernel.call('localapi.info', {}, { origin: 'user', actor: 't' })) as { running: boolean; problem: string; waitsForVault: boolean };
    expect(info).toMatchObject({ running: false, waitsForVault: true });
    expect(info.problem).toMatch(/outside your desktop session/);
    // Unlocking for now with the recovery passphrase starts it, and leaves the key in the keyring.
    await outside.kernel.call('vault.unlock', { recoveryPassphrase: 'correct horse battery staple' }, { origin: 'user', actor: 't' });
    expect(outside.kernel.vault.get('DB_PASSWORD')).toBe('hunter2-hunter2');
    expect(outside.kernel.services.get('localapi')?.state).toBe('running');
    expect(kept(outside.kernel)).toBe('os');
    await outside.kernel.stop();

    // Opened from the desktop again: unlocks by itself.
    const back = await makeKernel({ dataDir: first.dataDir, keychain: os });
    try {
      expect(back.kernel.vault.status().state).toBe('unlocked');
      expect(back.kernel.vault.get('DB_PASSWORD')).toBe('hunter2-hunter2');
    } finally {
      await back.kernel.stop();
      await first.cleanup().catch(() => undefined);
    }
  });

  it('opens a key saved in the key file (a start without the keyring), then keeps it in the keyring', async () => {
    // The vault was made by a start without the keyring: its key is in the data folder's key file.
    const dataDir = tempDir();
    const made = await makeKernel({ dataDir, keychain: outsideSession(dataDir) });
    made.kernel.vault.set({ name: 'TOKEN', value: 'abc-123-xyz' });
    expect(kept(made.kernel)).toBe('file');
    await made.kernel.stop();

    const desktop = await makeKernel({ dataDir, keychain: keyring(new FileKeychain(join(dataDir, 'keychain.key'))) });
    try {
      expect(desktop.kernel.vault.status().state).toBe('unlocked');
      expect(desktop.kernel.vault.get('TOKEN')).toBe('abc-123-xyz');
      expect(kept(desktop.kernel)).toBe('os');
    } finally {
      await desktop.kernel.stop();
      await made.cleanup().catch(() => undefined);
    }
  });
});
