import { describe, expect, it } from 'vitest';
import type { RemoteViewer } from '@fbrx/shared';
import { openRemote, remoteViewers } from '../src/network/remote-desktop';
import { makeKernel, USER } from './helpers';

describe('remote desktop and screen sharing', () => {
  it('says how this computer opens each, or what to install', async () => {
    const v = await remoteViewers();
    expect(v.map((x) => x.protocol)).toEqual(['rdp', 'vnc']);
    for (const x of v) expect(x.available ? !!x.viewer : !!x.hint, x.protocol).toBe(true);
  });

  it('refuses a bad address, port or user name before opening anything', async () => {
    await expect(openRemote({ protocol: 'rdp', host: 'a b;rm -rf /' }, '/tmp/x')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(openRemote({ protocol: 'vnc', host: '10.0.0.5', port: 70000 }, '/tmp/x')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(openRemote({ protocol: 'rdp', host: '10.0.0.5', username: 'bad"name' }, '/tmp/x')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('keeps remote desktops with the saved connections, on their own ports', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const rdp = await kernel.call('console.saveBookmark', { host: '10.0.0.5', protocol: 'rdp', username: 'sam' }, USER);
      const vnc = await kernel.call('console.saveBookmark', { host: '10.0.0.6', protocol: 'vnc' }, USER);
      expect(rdp).toMatchObject({ port: 3389, protocol: 'rdp', username: 'sam' });
      expect(vnc).toMatchObject({ port: 5900, protocol: 'vnc' });
      const viewers = (await kernel.call('remote.viewers', {}, USER)) as RemoteViewer[];
      const rdpViewer = viewers.find((x) => x.protocol === 'rdp')!;
      // Without a viewer (as on this test machine), opening says what to install and saves nothing new.
      if (!rdpViewer.available) await expect(kernel.call('remote.open', { protocol: 'rdp', host: '10.0.0.7' }, USER)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      await expect(kernel.call('remote.open', { protocol: 'ssh', host: '10.0.0.7' }, USER)).rejects.toBeTruthy();
    } finally {
      await cleanup();
    }
  });
});
