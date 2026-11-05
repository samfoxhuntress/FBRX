import { describe, expect, it } from 'vitest';
import { makeKernel, USER } from './helpers';

describe('offline account', () => {
  it('creates a local account, locks on start with a password, and removes it', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      expect((await kernel.call('localAccount.status', {}, USER)) as object).toMatchObject({ exists: false, locked: false });

      const made = (await kernel.call('localAccount.create', { name: 'Sam', email: 'sam@example.com' }, USER)) as { exists: boolean; account: { name: string } };
      expect(made).toMatchObject({ exists: true, account: { name: 'Sam', email: 'sam@example.com', passwordOnStart: false } });

      // A second account is refused.
      await expect(kernel.call('localAccount.create', { name: 'Other' }, USER)).rejects.toMatchObject({ code: 'CONFLICT' });

      // Turning on the start password.
      await kernel.call('localAccount.setPassword', { password: 'hunter2' }, USER);
      expect((await kernel.call('localAccount.status', {}, USER)) as { account: { passwordOnStart: boolean } }).toMatchObject({ account: { passwordOnStart: true } });

      // A wrong current password cannot change it.
      await expect(kernel.call('localAccount.setPassword', { password: 'newpass', current: 'wrong' }, USER)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

      // Rename.
      expect((await kernel.call('localAccount.update', { name: 'Samuel' }, USER)) as { account: { name: string } }).toMatchObject({ account: { name: 'Samuel' } });

      // Remove needs the confirm word.
      await expect(kernel.call('localAccount.remove', { confirm: 'nope' }, USER)).rejects.toThrow();
      expect((await kernel.call('localAccount.remove', { confirm: 'DELETE' }, USER)) as object).toMatchObject({ exists: false });
    } finally {
      await cleanup();
    }
  });

  it('locks the account at start and unlocks with the right password', async () => {
    const dataDir = (await import('node:os')).tmpdir() + '/fbrx-oa-' + Math.random().toString(36).slice(2);
    const first = await makeKernel({ dataDir });
    try {
      await first.kernel.call('localAccount.create', { name: 'Sam', password: 'secret' }, USER);
    } finally {
      await first.cleanup();
    }
    // A fresh kernel on the same data folder: the account is locked until the password is given.
    const again = await makeKernel({ dataDir });
    try {
      expect((again.kernel.localAccount.status()).locked).toBe(true);
      await expect(again.kernel.call('localAccount.unlock', { password: 'wrong' }, USER)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      expect((await again.kernel.call('localAccount.unlock', { password: 'secret' }, USER)) as { locked: boolean }).toMatchObject({ locked: false });
    } finally {
      await again.cleanup();
    }
  });
});
