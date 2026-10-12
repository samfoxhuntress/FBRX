import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, NOTIFICATION_KINDS, notificationDelivery, notificationKind, shouldNotify, type NotificationSettings } from '@fbrx/shared';
import { makeKernel, USER } from './helpers';

// Notifications: which kinds show, and one place for each (inside FBRX or the system's notifications), one sound.

const base: NotificationSettings = { ...DEFAULT_SETTINGS.notifications };

describe('Where a notification shows', () => {
  it('shows in one place by default: inside FBRX while it is in front, otherwise the system’s', () => {
    expect(base).toEqual({ enabled: true, show: 'auto', sound: 'fbrx', volume: 0.7, muted: [] });
    expect(notificationDelivery(base, 'alerts', { inFront: true, open: true })).toEqual({ app: true, system: false, sound: 'fbrx' });
    expect(notificationDelivery(base, 'alerts', { inFront: false, open: true })).toEqual({ app: false, system: true, sound: 'fbrx' });
    expect(notificationDelivery(base, 'alerts', { inFront: false, open: false })).toEqual({ app: false, system: true, sound: 'fbrx' });
  });

  it('follows the choice: only in FBRX, only the system’s, or both', () => {
    const at = (show: NotificationSettings['show'], inFront: boolean, open = true) => notificationDelivery({ ...base, show }, 'mesh', { inFront, open });
    expect(at('app', false)).toEqual({ app: true, system: false, sound: 'fbrx' });
    // Only in FBRX, with no window to show it in: nothing shows, and nothing sounds.
    expect(at('app', false, false)).toEqual({ app: false, system: false, sound: null });
    expect(at('system', true)).toEqual({ app: false, system: true, sound: 'fbrx' });
    expect(at('both', true)).toEqual({ app: true, system: true, sound: 'fbrx' });
  });

  it('plays the chosen sound once, and none for a macro you just ran', () => {
    expect(notificationDelivery({ ...base, sound: 'system' }, 'calendar', { inFront: false, open: true }).sound).toBe('system');
    expect(notificationDelivery({ ...base, sound: 'off' }, 'calendar', { inFront: false, open: true }).sound).toBeNull();
    expect(notificationDelivery(base, 'macros', { inFront: true, open: true }).sound).toBeNull();
  });

  it('knows each source’s kind, and lets each kind be turned off', () => {
    expect(notificationKind('governance')).toBe('approvals');
    expect(notificationKind('administrator')).toBe('organization');
    expect(notificationKind('watchdog')).toBe('fbrx');
    expect(notificationKind('com.example.plugin')).toBe('plugins');
    expect(new Set(NOTIFICATION_KINDS.map((k) => k.id)).size).toBe(NOTIFICATION_KINDS.length);
    expect(shouldNotify(base, 'calendar')).toBe(true);
    expect(shouldNotify({ ...base, muted: ['calendar'] }, 'calendar')).toBe(false);
    expect(shouldNotify({ ...base, muted: ['plugins'] }, 'com.example.plugin')).toBe(false);
    expect(shouldNotify({ ...base, enabled: false }, 'alerts')).toBe(false);
  });
});

describe('Turning notifications off', () => {
  it('keeps a switched-off kind, or all of them, from popping up', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const shown: string[] = [];
      (kernel.platform as unknown as { notify: (n: { title: string }) => void }).notify = vi.fn((n) => shown.push(n.title));
      const notify = (title: string, source: string) => kernel.events.emit('notification', { title, body: '', level: 'info', source });

      notify('Meeting in 10 minutes', 'calendar');
      await kernel.call('settings.update', { patch: { notifications: { muted: ['calendar'] } } }, USER);
      notify('Another meeting', 'calendar');
      notify('Paired with the office laptop', 'mesh');
      await kernel.call('settings.update', { patch: { notifications: { enabled: false } } }, USER);
      notify('Paired again', 'mesh');
      expect(shown).toEqual(['Meeting in 10 minutes', 'Paired with the office laptop']);
    } finally {
      await cleanup();
    }
  });
});
