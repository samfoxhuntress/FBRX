import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RemoteFrame, RemoteInput, RemoteMode, RemoteSession } from '@fbrx/shared';
import type { ScreenShare } from '../src/platform';
import type { Kernel } from '../src/kernel';
import { makeKernel, waitFor, USER } from './helpers';

/** Remote screen over FBRX Mesh: off until the computer allows it, asked there, and only the asker's session. */
let D: Awaited<ReturnType<typeof makeKernel>>;
let L: Awaited<ReturnType<typeof makeKernel>>;
let kd: Kernel;
let kl: Kernel;
let laptopOnDesk = '';
let deskOnLaptop = '';
let answer: RemoteMode | 'deny' = 'control';
const inputs: RemoteInput[][] = [];
const banners: Array<string | null> = [];

const share: ScreenShare = {
  capture: async () => ({ jpeg: Buffer.from('a picture'), width: 1280, height: 720, displays: 1 }),
  input: async (events) => void inputs.push(events),
  canControl: async () => ({ ok: true, why: null }),
  ask: async () => answer,
  banner: (on) => void banners.push(on ? `${on.who}:${on.mode}` : null),
};

beforeAll(async () => {
  D = await makeKernel();
  L = await makeKernel({ platform: { screenShare: share } });
  kd = D.kernel;
  kl = L.kernel;
  kd.settings.update({ mesh: { enabled: true, port: 47891 }, general: { deviceName: 'desk' } });
  kl.settings.update({ mesh: { enabled: true, port: 47892 }, general: { deviceName: 'laptop' } });
  await waitFor(() => kd.mesh.running && kl.mesh.running);
  const pairing = (await kl.call('mesh.startPairing', undefined, USER)) as { code: string };
  laptopOnDesk = ((await kd.call('mesh.pair', { code: pairing.code, host: '127.0.0.1:47892' }, USER)) as { id: string }).id;
  deskOnLaptop = kl.mesh.devices()[0].id;
}, 60_000);

afterAll(async () => {
  await L?.cleanup();
  await D?.cleanup();
});

describe('Remote screen over FBRX Mesh', () => {
  it('is refused until the computer gives Remote screen, then asked there each time', async () => {
    await expect(kd.call('screen.connect', { peerId: laptopOnDesk, mode: 'control' }, USER)).rejects.toThrow(/remote/);
    await kl.call('mesh.setPermissions', { id: deskOnLaptop, permissions: { remote: true } }, USER);
    const s = (await kd.call('screen.connect', { peerId: laptopOnDesk, mode: 'control' }, USER)) as RemoteSession;
    expect(s.viewer).toMatchObject({ kind: 'mesh', name: 'desk' });
    await waitFor(async () => ((await kd.call('screen.session', { peerId: laptopOnDesk, id: s.id }, USER)) as RemoteSession).state === 'live');
    const f = (await kd.call('screen.frame', { peerId: laptopOnDesk, id: s.id }, USER)) as RemoteFrame;
    expect(Buffer.from(f.jpeg, 'base64').toString()).toBe('a picture');
    await kd.call('screen.input', { peerId: laptopOnDesk, id: s.id, events: [{ t: 'key', key: 'Enter', mods: [] }] }, USER);
    expect(inputs).toEqual([[{ t: 'key', key: 'Enter', mods: [] }]]);
    await expect(kd.call('screen.input', { peerId: laptopOnDesk, id: s.id, events: [{ t: 'key', key: 'Insert', mods: [] }] }, USER)).rejects.toThrow(/key/);
    // The laptop's own person sees it and can stop it.
    expect(((await kl.call('screen.here', undefined, USER)) as RemoteSession).id).toBe(s.id);
    await kl.call('screen.stopHere', undefined, USER);
    await expect(kd.call('screen.frame', { peerId: laptopOnDesk, id: s.id }, USER)).rejects.toThrow(/over/);
    expect(banners).toEqual(['desk:control', null]);
  });

  it('a no stays a no; without asking only once the laptop allows that too', async () => {
    answer = 'deny';
    const s = (await kd.call('screen.connect', { peerId: laptopOnDesk, mode: 'view' }, USER)) as RemoteSession;
    // The answer here comes at once, so the reply may already say so.
    expect(['asking', 'denied']).toContain(s.state);
    await waitFor(async () => ((await kd.call('screen.session', { peerId: laptopOnDesk, id: s.id }, USER)) as RemoteSession).state === 'denied');
    await kl.call('mesh.setPermissions', { id: deskOnLaptop, permissions: { unattended: true } }, USER);
    const u = (await kd.call('screen.connect', { peerId: laptopOnDesk, mode: 'view' }, USER)) as RemoteSession;
    expect(u).toMatchObject({ state: 'live', unattended: true, mode: 'view' });
    await kd.call('screen.end', { peerId: laptopOnDesk, id: u.id }, USER);
    const actions = kl.audit.query({ limit: 50 }).map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['screen.requested', 'screen.started', 'screen.denied', 'screen.ended']));
  });

  it('the AI cannot start or use a remote screen', async () => {
    await expect(kd.call('screen.connect', { peerId: laptopOnDesk, mode: 'view' }, { origin: 'agent' } as never)).rejects.toThrow();
  });
});
