import { describe, expect, it } from 'vitest';
import type { MessagesOverview, ThreadMessage } from '@fbrx/shared';
import { makeKernel, waitFor, USER } from './helpers';
import type { Kernel } from '../src/kernel';

async function meshKernel(port: number) {
  const k = await makeKernel();
  k.kernel.settings.update({ mesh: { enabled: true, port }, general: { deviceName: `pc-${port}` } });
  await waitFor(() => k.kernel.mesh.running);
  return k;
}

async function pairUp(ka: Kernel, kb: Kernel, portA: number) {
  const pairing = (await ka.call('mesh.startPairing', undefined, USER)) as { code: string };
  await kb.call('mesh.pair', { code: pairing.code, host: `127.0.0.1:${portA}` }, USER);
  return { aOnB: kb.mesh.devices()[0].id, bOnA: ka.mesh.devices()[0].id };
}

const overview = (k: Kernel) => k.call('messages.overview', undefined, USER) as Promise<MessagesOverview>;
const thread = (k: Kernel, id: string) => k.call('messages.thread', { id }, USER) as Promise<ThreadMessage[]>;

describe('Messages on the mesh', () => {
  it('talks to one computer or everyone, waits for a computer that is off, and respects Messages being off', async () => {
    const A = await meshKernel(47871);
    const B = await meshKernel(47872);
    const ka = A.kernel;
    const kb = B.kernel;
    try {
      const { aOnB, bOnA } = await pairUp(ka, kb, 47871);
      const o = await overview(kb);
      expect(o.mesh).toMatchObject({ on: true, devices: 1, note: null });
      expect(o.threads.map((t) => [t.id, t.title, t.kind])).toEqual([
        ['mesh:all', 'Everyone on my mesh', 'group'],
        [`mesh:${aOnB}`, 'pc-47871', 'direct'],
      ]);

      // Just the two of them: it lands in A's conversation with B, unread, with a pop-up that opens it.
      const notes: Array<{ title: string; open?: string }> = [];
      ka.events.on('notification', (n) => n.source === 'messages' && notes.push(n));
      const sent = (await kb.call('messages.send', { id: `mesh:${aOnB}`, text: 'Lunch at noon?' }, USER)) as ThreadMessage;
      expect(sent).toMatchObject({ mine: true, state: 'sent', threadId: `mesh:${aOnB}` });
      expect((await thread(ka, `mesh:${bOnA}`)).map((m) => [m.fromName, m.mine, m.text])).toEqual([['pc-47872', false, 'Lunch at noon?']]);
      expect(notes).toEqual([expect.objectContaining({ title: 'Message from pc-47872', open: `messages/mesh:${bOnA}` })]);
      expect((await overview(ka)).threads.find((t) => t.id === `mesh:${bOnA}`)).toMatchObject({ unread: 1, last: { text: 'Lunch at noon?', mine: false } });
      await ka.call('messages.read', { id: `mesh:${bOnA}` }, USER);
      expect(((await ka.call('messages.unread', undefined, USER)) as { unread: number }).unread).toBe(0);

      // Everyone: it goes to the group conversation instead.
      await kb.call('messages.send', { id: 'mesh:all', text: 'Back online' }, USER);
      expect((await thread(ka, 'mesh:all')).map((m) => m.text)).toEqual(['Back online']);
      expect((await thread(ka, `mesh:${bOnA}`)).map((m) => m.text)).toEqual(['Lunch at noon?']);

      // A is off: the message waits, and goes when A is back.
      ka.settings.update({ mesh: { enabled: false } });
      await waitFor(() => !ka.mesh.running);
      const waiting = (await kb.call('messages.send', { id: `mesh:${aOnB}`, text: 'Did you see this?' }, USER)) as ThreadMessage;
      expect(waiting).toMatchObject({ state: 'waiting' });
      expect(waiting.error).toMatch(/gets this when it is back/);
      ka.settings.update({ mesh: { enabled: true } });
      await waitFor(() => ka.mesh.running);
      await kb.mesh.hello(aOnB);
      await waitFor(async () => (await thread(ka, `mesh:${bOnA}`)).some((m) => m.text === 'Did you see this?'));
      await waitFor(async () => (await thread(kb, `mesh:${aOnB}`)).find((m) => m.id === waiting.id)?.state === 'sent');

      // Messages off on A: B is told so, and can try again later.
      ka.settings.update({ messages: { enabled: false } });
      const refused = (await kb.call('messages.send', { id: `mesh:${aOnB}`, text: 'Hello?' }, USER)) as ThreadMessage;
      expect(refused).toMatchObject({ state: 'failed', error: 'Messages are turned off on this computer' });
      expect((await overview(ka)).enabled).toBe(false);
      await expect(ka.call('messages.send', { id: `mesh:${bOnA}`, text: 'x' }, USER)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      ka.settings.update({ messages: { enabled: true } });
      expect((await kb.call('messages.resend', { messageId: refused.id }, USER)) as ThreadMessage).toMatchObject({ state: 'sent' });
      expect((await thread(ka, `mesh:${bOnA}`)).map((m) => m.text)).toContain('Hello?');

      // Unknown conversations are refused plainly.
      await expect(kb.call('messages.thread', { id: 'nowhere:1' }, USER)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    } finally {
      await B.cleanup();
      await A.cleanup();
    }
  }, 60_000);

  it('shows nobody to message until the mesh is on or the computer joins an organization', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const o = await overview(kernel);
      expect(o).toMatchObject({ enabled: true, threads: [], unread: 0, org: { on: false, note: null } });
      expect(o.mesh.note).toMatch(/Turn on FBRX Mesh/);
    } finally {
      await cleanup();
    }
  });
});
