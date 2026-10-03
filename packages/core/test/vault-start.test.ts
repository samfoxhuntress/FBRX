import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openBytes, sealString } from '@fbrx/shared/node';
import { Kernel } from '../src/kernel';
import { createNodePlatform } from '../src/node-platform';
import { FileKeychain, type KeychainAdapter, type MovedKeychain } from '../src/platform';
import { openMacSafeStorage, sealMacSafeStorage } from '../src/vault/oscrypt';
import { hiddenConsoleStdio } from '../src/windows/hide-consoles';
import { makeKernel, tempDir } from './helpers';

/** Stands in for the operating-system keychain an earlier version used. */
function fakeOsKeychain(): KeychainAdapter {
  const key = randomBytes(32);
  return {
    kind: 'os',
    available: () => true,
    protect: async (data) => sealString(key, data, 'os'),
    unprotect: async (blob) => openBytes(key, blob, 'os'),
  };
}

async function boot(dataDir: string, keychain: KeychainAdapter, moved?: MovedKeychain, onRestart?: (r: string) => void) {
  const platform = createNodePlatform({ dataDir, devMode: true, keychain, requestRestart: onRestart });
  platform.movedKeychain = moved ?? null;
  const k = await Kernel.create({ dataDir, platform });
  k.settings.update({ localApi: { enabled: false }, runtime: { enabled: false } });
  await k.start();
  return k;
}

const USER = { origin: 'user' as const, actor: 't' };

describe('vault on start', () => {
  it('never opens the old keychain by itself, and brings the key over when asked', async () => {
    const dataDir = tempDir();
    const os = fakeOsKeychain();
    const a = await boot(dataDir, os);
    a.vault.set({ name: 'CLAUDE_KEY', value: 'sk-test-123' });
    await a.stop();

    const unprotect = vi.fn(os.unprotect);
    const moved: MovedKeychain = { kind: 'os', label: 'the Mac Keychain', unprotect };
    const file = new FileKeychain(join(dataDir, 'keychain.key'));
    const b = await boot(dataDir, file, moved);
    try {
      expect(b.vault.status()).toMatchObject({ state: 'locked', lockReason: 'moved', movedFrom: 'the Mac Keychain', keychainKind: 'file' });
      expect(unprotect).not.toHaveBeenCalled();
      await expect(b.call('vault.importMoved', undefined, { origin: 'api', actor: 'script' })).rejects.toThrow();
      await b.call('vault.importMoved', undefined, USER);
      expect(unprotect).toHaveBeenCalledTimes(1);
      expect(b.vault.status()).toMatchObject({ state: 'unlocked', lockReason: null });
      expect(b.vault.get('CLAUDE_KEY')).toBe('sk-test-123');
      expect(b.db.get<{ keychain_kind: string }>('SELECT keychain_kind FROM vault_keys')?.keychain_kind).toBe('file');
    } finally {
      await b.stop();
    }

    // From now on it opens silently with the key file, without the old keychain.
    const c = await boot(dataDir, new FileKeychain(join(dataDir, 'keychain.key')), { ...moved, unprotect: vi.fn() });
    try {
      expect(c.vault.status()).toMatchObject({ state: 'unlocked', lockReason: null });
      expect(c.vault.get('CLAUDE_KEY')).toBe('sk-test-123');
    } finally {
      await c.stop();
    }
  });

  it('asks for the password at every start when turned on, and stops asking when turned off', async () => {
    const dataDir = tempDir();
    const keychain = new FileKeychain(join(dataDir, 'keychain.key'));
    const a = await boot(dataDir, keychain);
    a.vault.set({ name: 'TOKEN', value: 'abc' });
    await a.call('vault.passwordOnStart', { enabled: true, passphrase: 'a good long passphrase' }, USER);
    expect(a.vault.status()).toMatchObject({ state: 'unlocked', passwordOnStart: true, hasRecovery: true });
    await a.stop();

    const b = await boot(dataDir, keychain);
    expect(b.vault.status()).toMatchObject({ state: 'locked', lockReason: 'password' });
    // Locked on purpose: no alert-worthy degraded service.
    expect((await b.status()).services.find((s) => s.name === 'vault')?.state).toBe('running');
    await expect(b.call('vault.unlock', { recoveryPassphrase: 'not the passphrase' }, USER)).rejects.toThrow(/not right/);
    await b.call('vault.unlock', { recoveryPassphrase: 'a good long passphrase' }, USER);
    expect(b.vault.get('TOKEN')).toBe('abc');
    await b.stop();

    // Unlocking did not quietly bind the key to the computer again.
    const c = await boot(dataDir, keychain);
    expect(c.vault.status().lockReason).toBe('password');
    await c.call('vault.unlock', { recoveryPassphrase: 'a good long passphrase' }, USER);
    await c.call('vault.passwordOnStart', { enabled: false, passphrase: 'a good long passphrase' }, USER);
    await c.stop();

    const d = await boot(dataDir, keychain);
    try {
      expect(d.vault.status()).toMatchObject({ state: 'unlocked', passwordOnStart: false });
    } finally {
      await d.stop();
    }
  });

  it('starts over with an empty vault and restarts', async () => {
    const restarts: string[] = [];
    const { kernel, cleanup } = await makeKernel({ onRestart: (r) => restarts.push(r) });
    try {
      kernel.vault.set({ name: 'OLD', value: 'x' });
      await expect(kernel.call('vault.reset', { confirm: 'yes' } as never, USER)).rejects.toThrow();
      await kernel.call('vault.reset', { confirm: 'DELETE' }, USER);
      expect(kernel.vault.status()).toMatchObject({ state: 'unlocked', secretCount: 0 });
      expect(kernel.vault.has('OLD')).toBe(false);
      expect(restarts).toEqual(['vault-reset']);
    } finally {
      await cleanup();
    }
  });

  it('reads the Mac Keychain format of earlier versions', () => {
    // Made with openssl: AES-128-CBC, key = PBKDF2-SHA1("Xy9+kQ3pZ0==", "saltysalt", 1003, 16), IV of spaces.
    const blob = Buffer.from('djEwzn1OFuGGyekXt3o8eweaDRiiLUWq4tm51kMhvtsA0L4=', 'base64');
    expect(openMacSafeStorage('Xy9+kQ3pZ0==', blob)).toBe('c2VjcmV0LWtleS1ieXRlcw==');
    expect(() => openMacSafeStorage('wrong', blob)).toThrow();
    expect(openMacSafeStorage('pw', sealMacSafeStorage('pw', 'hello'))).toBe('hello');
  });
});

describe('hidden consoles on Windows', () => {
  it('gives hidden children a console of their own unless something is inherited already', () => {
    expect(hiddenConsoleStdio(undefined)).toEqual(['pipe', 'pipe', 'pipe', 2]);
    expect(hiddenConsoleStdio('ignore')).toEqual(['ignore', 'ignore', 'ignore', 2]);
    expect(hiddenConsoleStdio(['ignore', 'pipe', 'pipe'])).toEqual(['ignore', 'pipe', 'pipe', 2]);
    expect(hiddenConsoleStdio(['pipe'])).toEqual(['pipe', undefined, undefined, 2]);
    expect(hiddenConsoleStdio('inherit')).toBeNull();
    expect(hiddenConsoleStdio(['inherit', 'pipe', 'pipe'])).toBeNull();
    expect(hiddenConsoleStdio(['pipe', 'pipe', 'pipe', 'ipc'])).toBeNull();
    expect(hiddenConsoleStdio([0, 'pipe', 'pipe'])).toBeNull();
  });
});
