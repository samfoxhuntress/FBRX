import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, labShown } from '@fbrx/shared';
import { makeKernel, USER } from './helpers';

const CONSOLE = { host: '127.0.0.1', port: 1, protocol: 'telnet' as const };

describe('the Lab: the Terminal in every edition, device consoles from Pro, off when the organization says so', () => {
  it('shows the Lab in the advanced menu by default, in the simple one when the person turns it on', () => {
    const lab = (show: 'auto' | 'on' | 'off', terminal = true) => ({ lab: { show, terminal } });
    expect(DEFAULT_SETTINGS.lab).toEqual({ show: 'auto', terminal: true });
    expect(labShown(lab('auto'), false)).toBe(true);
    expect(labShown(lab('auto'), true)).toBe(false);
    expect(labShown(lab('on'), true)).toBe(true);
    expect(labShown(lab('off'), false)).toBe(false);
    // The organization turned the Terminal off: no Lab, whatever the person chose.
    expect(labShown(lab('on', false), true)).toBe(false);
  });

  it('gives Essentials the command line and FBRX/1, and device consoles from Pro', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      kernel.meta.set('edition.chosen', 'essentials');
      kernel.license.refresh();
      expect(kernel.license.status().tier).toBe('essentials');
      expect(kernel.terminalOff()).toBeNull();
      expect(kernel.consolesOff()).toBe('Device consoles come with FBRX Endpoint Pro');
      await expect(kernel.call('console.connect', CONSOLE, USER)).rejects.toMatchObject({ code: 'FEATURE_UNAVAILABLE' });
      // FBRX/1 answers in Essentials.
      expect(await kernel.call('cli.exec', { session: 'lab', line: 'help' }, USER)).toBeTruthy();
      kernel.meta.set('edition.chosen', 'basic');
      kernel.license.refresh();
      expect(kernel.consolesOff()).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('refuses the Terminal, FBRX/1 and device consoles when the organization turned the Terminal off', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      kernel.settings.applyManaged({ lab: { terminal: false } }, ['lab.terminal']);
      expect(kernel.terminalOff()).toBe('Your organization turned off the Terminal on this computer');
      await expect(kernel.call('terminal.run', { command: 'echo hi' }, USER)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(kernel.call('cli.exec', { session: 'lab', line: 'help' }, USER)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(kernel.call('console.connect', CONSOLE, USER)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      // Locked: the person cannot turn it back on.
      await expect(kernel.call('settings.update', { patch: { lab: { terminal: true } } }, USER)).rejects.toBeTruthy();
      expect(kernel.settings.get().lab.terminal).toBe(false);
      kernel.settings.applyManaged({}, []);
      expect(kernel.terminalOff()).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('keeps device consoles in FBRX Digger whatever the edition', async () => {
    const { kernel, cleanup } = await makeKernel({ platform: { flavor: 'digger' } });
    try {
      kernel.meta.set('edition.chosen', 'essentials');
      kernel.license.refresh();
      expect(kernel.consolesOff()).toBeNull();
    } finally {
      await cleanup();
    }
  });
});
