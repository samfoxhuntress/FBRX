import { describe, expect, it } from 'vitest';
import type { RemoteInput, RemoteMode } from '@fbrx/shared';
import { ScreenHost } from '../src/remote/screen-host';
import type { ScreenShare } from '../src/platform';

function fake(o: { answer?: RemoteMode | 'deny'; control?: boolean; capture?: boolean } = {}) {
  const calls = { captures: 0, inputs: [] as RemoteInput[][], banner: [] as Array<string | null>, asked: [] as string[] };
  let release: ((v: RemoteMode | 'deny') => void) | null = null;
  let stopFn: (() => void) | null = null;
  const share: ScreenShare = {
    capture: async () => (o.capture === false ? null : (calls.captures++, { jpeg: Buffer.from('jpeg'), width: 1600, height: 900, displays: 2 })),
    input: async (events) => void calls.inputs.push(events),
    canControl: async () => (o.control === false ? { ok: false, why: 'Wayland' } : { ok: true, why: null }),
    ask: (q) => (calls.asked.push(q.who), o.answer ? Promise.resolve(o.answer) : new Promise((r) => (release = r))),
    banner: (on, stop) => (calls.banner.push(on ? `${on.who}:${on.mode}` : null), (stopFn = stop)),
  };
  const audit: string[] = [];
  let now = 1_000_000;
  const host = new ScreenHost({ share: () => share, audit: (a) => void audit.push(a), now: () => now });
  return { host, calls, audit, answer: (v: RemoteMode | 'deny') => release?.(v), stop: () => stopFn?.(), tick: (ms: number) => (now += ms) };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const from = { kind: 'mesh' as const, name: 'Fox laptop', deviceId: 'dev_1' };

describe('this computer’s screen for remote view and control', () => {
  it('asks the person first; nothing is seen or used until they say yes, and they can narrow control to view', async () => {
    const f = fake();
    const s = await f.host.request(from, 'control', { unattended: false });
    expect(s).toMatchObject({ state: 'asking', mode: 'control', displays: 2 });
    await expect(f.host.frame(s.id)).rejects.toThrow(/Waiting for the person/);
    await expect(f.host.request({ ...from, deviceId: 'dev_2', name: 'Other' }, 'view', { unattended: false })).rejects.toThrow(/already asking/);
    f.answer('view');
    await flush();
    expect(f.host.session(s.id)).toMatchObject({ state: 'live', mode: 'view' });
    expect(f.calls.banner).toEqual(['Fox laptop:view']);
    await expect(f.host.input(s.id, [{ t: 'move', x: 0.5, y: 0.5 }])).rejects.toThrow(/view only/);
    const frame = await f.host.frame(s.id);
    expect(frame).toMatchObject({ seq: 1, width: 1600, jpeg: Buffer.from('jpeg').toString('base64') });
    // A picture asked again at once is the same one (at most one every 150 ms), and `after` skips it.
    expect(await f.host.frame(s.id, { after: 1 })).toBeNull();
    expect(f.calls.captures).toBe(2);
    expect(f.audit).toEqual(['screen.requested', 'screen.started']);
  });

  it('a no, or Stop on the banner, ends it; a viewer that went away times out', async () => {
    const no = fake({ answer: 'deny' });
    const s1 = await no.host.request(from, 'view', { unattended: false });
    await flush();
    expect(no.host.session(s1.id)).toMatchObject({ state: 'denied' });
    expect(no.audit).toContain('screen.denied');

    const f = fake({ answer: 'control' });
    const s2 = await f.host.request(from, 'control', { unattended: false });
    await flush();
    await f.host.input(s2.id, [{ t: 'down', x: 0.1, y: 0.2, button: 'left' }, { t: 'text', text: 'hi' }]);
    expect(f.calls.inputs).toHaveLength(1);
    await expect(f.host.input(s2.id, [{ t: 'text', text: 'a\u0007b' }])).rejects.toThrow(/control characters/);
    await expect(f.host.input(s2.id, [{ t: 'move', x: 2, y: 0 }])).rejects.toThrow(/0-1/);
    f.stop();
    expect(f.host.session(s2.id)).toMatchObject({ state: 'ended', why: 'The person at the computer stopped it' });
    expect(f.calls.banner).toEqual(['Fox laptop:control', null]);
    await expect(f.host.frame(s2.id)).rejects.toThrow(/over/);
  });

  it('lets one of the person’s own computers in without asking, still with the banner, and says when control cannot work', async () => {
    const f = fake({ control: false });
    const s = await f.host.request(from, 'control', { unattended: true });
    expect(s).toMatchObject({ state: 'live', mode: 'view', unattended: true, control: { ok: false, why: 'Wayland' } });
    expect(f.calls.asked).toEqual([]);
    expect(f.calls.banner).toEqual(['Fox laptop:view']);
    expect(f.host.end(s.id, 'viewer').state).toBe('ended');
  });

  it('refuses when the system does not let FBRX see the screen', async () => {
    await expect(fake({ capture: false }).host.request(from, 'view', { unattended: true })).rejects.toThrow(/screen recording/);
  });
});
