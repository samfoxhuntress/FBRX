import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { makeKernel, waitFor, USER } from './helpers';
import { b64, fingerprint, normalizeCode, open, pairingMac, ReplayGuard, seal, unb64 } from '../src/mesh/mesh-crypto';
import type { Kernel } from '../src/kernel';

/** HMAC-SHA512 exactly as FBRX Mobile computes it (on top of nacl.hash). */
function mobileHmac(keyStr: string, msg: string): string {
  let key: Uint8Array = new TextEncoder().encode(keyStr);
  if (key.length > 128) key = nacl.hash(key);
  const k = new Uint8Array(128);
  k.set(key);
  const ipad = k.map((b) => b ^ 0x36);
  const opad = k.map((b) => b ^ 0x5c);
  const cat = (a: Uint8Array, b: Uint8Array) => {
    const o = new Uint8Array(a.length + b.length);
    o.set(a);
    o.set(b, a.length);
    return o;
  };
  return b64(nacl.hash(cat(opad, nacl.hash(cat(ipad, new TextEncoder().encode(msg))))));
}

async function meshKernel(port: number) {
  const k = await makeKernel();
  k.kernel.settings.update({ mesh: { enabled: true, port }, general: { deviceName: `pc-${port}` } });
  await waitFor(() => k.kernel.mesh.running);
  return k;
}

/** A phone, implemented like packages/core/mobile/app.js. */
class Phone {
  kp = nacl.box.keyPair();
  pk = b64(this.kp.publicKey);
  id = fingerprint(this.pk);
  desktopPk = '';
  constructor(private readonly base: string) {}

  async pair(code: string) {
    const hello = await (await fetch(`${this.base}/mesh/hello`)).json();
    this.desktopPk = hello.publicKey;
    const c = normalizeCode(code);
    const res = await fetch(`${this.base}/mesh/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: this.pk, kind: 'mobile', name: 'Test phone', platform: 'Android', version: 'web', mac: mobileHmac(c, `fbrx-pair-v1|${this.pk}|${hello.publicKey}`) }),
    });
    const j = await res.json();
    if (!res.ok) throw Object.assign(new Error(j.error.message), { status: res.status });
    expect(j.mac).toBe(mobileHmac(c, `fbrx-pair-v1-ack|${hello.publicKey}|${this.pk}|${this.id}`));
    return j;
  }

  envelope(method: string, params: unknown = {}, ts = Date.now()) {
    return seal({ id: b64(nacl.randomBytes(9)), ts, method, params }, this.desktopPk, b64(this.kp.secretKey), this.id);
  }

  async post(env: unknown) {
    const res = await fetch(`${this.base}/mesh/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(env) });
    return { status: res.status, body: await res.json() };
  }

  async rpc(method: string, params: unknown = {}) {
    const { status, body } = await this.post(this.envelope(method, params));
    if (!body.nonce) throw Object.assign(new Error(body.error?.message), { status });
    const reply = open<any>(body, this.desktopPk, b64(this.kp.secretKey));
    if (!reply.ok) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
    return reply.result;
  }
}

describe('mesh crypto', () => {
  it('seals for one recipient and authenticates the sender', () => {
    const a = nacl.box.keyPair();
    const b = nacl.box.keyPair();
    const eve = nacl.box.keyPair();
    const env = seal({ hi: 1 }, b64(b.publicKey), b64(a.secretKey), 'a');
    expect(open(env, b64(a.publicKey), b64(b.secretKey))).toEqual({ hi: 1 });
    expect(open(env, b64(eve.publicKey), b64(b.secretKey))).toBeNull();
    const tampered = { ...env, box: b64(unb64(env.box).map((x, i) => (i === 3 ? x ^ 1 : x))) };
    expect(open(tampered, b64(a.publicKey), b64(b.secretKey))).toBeNull();
  });

  it('matches the phone HMAC and rejects replays and stale requests', () => {
    expect(mobileHmac('ABCD', 'x|y')).toBe(createHmac('sha512', 'ABCD').update('x|y').digest('base64'));
    expect(pairingMac('abcd-efgh', 'l', 'p')).toBe(pairingMac('ABCDEFGH', 'l', 'p'));
    const g = new ReplayGuard(1000);
    expect(g.check('d:1', Date.now())).toBe(true);
    expect(g.check('d:1', Date.now())).toBe(false);
    expect(g.check('d:2', Date.now() - 5000)).toBe(false);
  });
});

describe('mesh pairing and permissions', () => {
  it('pairs two computers with a one-time code and enforces per-device permissions', async () => {
    const A = await meshKernel(47811);
    const B = await meshKernel(47812);
    const ka: Kernel = A.kernel;
    const kb: Kernel = B.kernel;
    try {
      // A wrong code is refused and five failures end the pairing session.
      const pairing = await ka.call('mesh.startPairing', undefined, USER) as any;
      expect(pairing.code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/);
      expect(pairing.qrDataUrl).toMatch(/^data:image\/png;base64,/);
      await expect(kb.call('mesh.pair', { code: 'AAAA-AAAA-AAAA-AAAA-AAAA', host: '127.0.0.1:47811' }, USER)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

      // The right code pairs both ways.
      const peer = (await kb.call('mesh.pair', { code: pairing.code.toLowerCase(), host: '127.0.0.1:47811' }, USER)) as any;
      expect(peer).toMatchObject({ name: 'pc-47811', kind: 'desktop', online: true });
      expect(ka.mesh.devices()).toHaveLength(1);
      expect(ka.mesh.status().pairing).toBeNull();
      // The code works once.
      await expect(kb.call('mesh.pair', { code: pairing.code, host: '127.0.0.1:47811' }, USER)).rejects.toBeTruthy();

      // Default desktop permissions: status and chat, not the agent.
      const status = (await kb.call('mesh.peerInfo', { id: peer.id }, USER)) as any;
      expect(status.name).toBe('pc-47811');
      await expect(kb.call('mesh.ask', { id: peer.id, prompt: 'hi', reqId: 'r1' }, USER)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(kb.call('mesh.action', { id: peer.id, action: 'lock' }, USER)).rejects.toMatchObject({ code: 'FORBIDDEN' });

      const got = new Promise((r) => ka.events.on('mesh.message', r));
      expect(await kb.call('mesh.message', { text: 'hello A' }, USER)).toEqual({ delivered: 1, total: 1 });
      expect(await got).toMatchObject({ fromName: 'pc-47812', text: 'hello A' });

      // A revokes B: B's requests are refused immediately.
      const bOnA = ka.mesh.devices()[0];
      await ka.call('mesh.removeDevice', { id: bOnA.id }, USER);
      await expect(kb.call('mesh.peerInfo', { id: peer.id }, USER)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(ka.audit.query({ category: 'mesh', limit: 10 }).map((e) => e.action)).toEqual(expect.arrayContaining(['device.paired', 'device.removed', 'pairing.rejected']));
    } finally {
      await B.cleanup();
      await A.cleanup();
    }
  });

  it('locks pairing after repeated wrong codes', async () => {
    const A = await meshKernel(47813);
    try {
      await A.kernel.call('mesh.startPairing', undefined, USER);
      const phone = new Phone('http://127.0.0.1:47813');
      for (let i = 0; i < 5; i++) await expect(phone.pair('ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ')).rejects.toBeTruthy();
      expect(A.kernel.mesh.status().pairing).toBeNull();
    } finally {
      await A.cleanup();
    }
  });

  it('serves FBRX Mobile and speaks its sealed protocol', async () => {
    const A = await meshKernel(47814);
    try {
      const base = 'http://127.0.0.1:47814';
      const page = await fetch(`${base}/m/`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(await page.text()).toContain('nacl.min.js');
      expect((await fetch(`${base}/m/nacl.min.js`)).status).toBe(200);
      expect((await fetch(`${base}/m/..%2fpackage.json`)).status).toBe(404);

      const { code } = (await A.kernel.call('mesh.startPairing', undefined, USER)) as any;
      const phone = new Phone(base);
      const paired = await phone.pair(code);
      expect(paired.permissions).toMatchObject({ approve: true, ask: true, control: false });

      await phone.rpc('tasks.save', { title: 'From my phone' });
      expect(A.kernel.workspace.listTasks()[0].title).toBe('From my phone');
      const sync = await phone.rpc('sync');
      expect(sync).toMatchObject({ name: 'pc-47814', approvals: [], jobs: [] });

      // Alerts reach the phone through its outbox.
      A.kernel.settings.update({ alerts: { routing: { warning: ['inbox', 'mobile'] } } });
      await A.kernel.alerts.fire('cpu_high', 'CPU busy', 'Average 99%');
      expect((await phone.rpc('sync')).items[0]).toMatchObject({ type: 'alert', alert: { title: 'CPU busy' } });

      // Control is off for phones by default.
      await expect(phone.rpc('action', { action: 'lock' })).rejects.toMatchObject({ code: 'FORBIDDEN' });

      // A captured request cannot be replayed, and stale requests are refused.
      const env = phone.envelope('sync');
      expect((await phone.post(env)).body.nonce).toBeTruthy();
      expect((await phone.post(env)).status).toBe(401);
      expect((await phone.post(phone.envelope('sync', {}, Date.now() - 10 * 60_000))).status).toBe(401);

      // Somebody with a different key cannot speak for the phone.
      const eve = nacl.box.keyPair();
      const forged = seal({ id: 'x', ts: Date.now(), method: 'sync' }, phone.desktopPk, b64(eve.secretKey), phone.id);
      expect((await phone.post(forged)).status).toBe(401);

      // Turning a permission off takes effect at once.
      await A.kernel.call('mesh.setPermissions', { id: phone.id, permissions: { workspace: false } }, USER);
      await expect(phone.rpc('tasks.list')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await A.cleanup();
    }
  });
});
