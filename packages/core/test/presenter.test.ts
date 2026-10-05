import { describe, expect, it, vi } from 'vitest';
import type { PresenterStatus } from '@fbrx/shared';
import { makeKernel, USER } from './helpers';

describe('presenter-safe mode', () => {
  it('turns on by hand or with a projector, keeps notifications quiet, and can be snoozed until the screen is unplugged', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const shown: Array<{ title: string; body: string }> = [];
      (kernel.platform as unknown as { notify: (n: { title: string; body: string }) => void }).notify = vi.fn((n) => shown.push(n));
      const status = () => kernel.call('presenter.status', undefined, USER) as Promise<PresenterStatus>;
      const notify = (level: 'info' | 'error', title: string) => kernel.events.emit('notification', { title, body: 'Your grades export finished', level, source: 'test' });

      expect(await status()).toMatchObject({ active: false, reason: null });
      notify('info', 'Before');
      expect(shown.map((n) => n.title)).toEqual(['Before']);

      // A projector is plugged in, but the automatic switch is off by default.
      kernel.setExternalDisplay(true);
      expect((await status()).active).toBe(false);
      await kernel.call('settings.update', { patch: { presenter: { auto: true } } }, USER);
      expect(await status()).toMatchObject({ active: true, reason: 'display', externalDisplay: true });

      notify('info', 'Private');
      notify('error', 'Backup failed for Room 12');
      expect(shown.map((n) => n.title)).toEqual(['Before', 'FBRX needs your attention']);
      expect(JSON.stringify(shown)).not.toContain('Room 12');

      // Turned off by hand while the projector is still connected: stays off until it is unplugged.
      await kernel.call('presenter.set', { on: false }, USER);
      expect((await status()).active).toBe(false);
      kernel.setExternalDisplay(false);
      kernel.setExternalDisplay(true);
      expect(await status()).toMatchObject({ active: true, reason: 'display' });

      // By hand, without any projector.
      kernel.setExternalDisplay(false);
      const on = (await kernel.call('presenter.set', { on: true }, USER)) as PresenterStatus;
      expect(on).toMatchObject({ active: true, reason: 'manual' });
      expect(kernel.settings.get().presenter.enabled).toBe(true);
      await kernel.call('presenter.set', { on: false }, USER);
      expect((await status()).active).toBe(false);
    } finally {
      await cleanup();
    }
  });
});
