import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HaStatus, ServerAlertsList } from '@fbrx/shared';
import { HaWitness, signHaRequest, type StoredLease } from '@fbrx/shared/node';
import { loadConfig } from '../src/config';
import { buildServer, type BuiltVirtual } from '../src/server';

describe('the third vote', () => {
  it('lets one server hold the pair at a time, hands it over only once the holder goes quiet, and survives a restart', () => {
    let now = 0;
    const saved: StoredLease[] = [];
    const w = new HaWitness({ secretOf: (id) => (id === 'key-0001' ? 'secret' : null), now: () => now, save: (l) => saved.push(l) });
    const ask = (node: string, term: number, release = false) => w.decide({ id: 'key-0001', node, term, leaseMs: 1000, release });
    expect(ask('primary-1', 1)).toMatchObject({ granted: true, holder: 'primary-1', term: 1 });
    now = 500;
    // The standby asks while the primary's lease runs: no.
    expect(ask('standby-1', 2)).toMatchObject({ granted: false, holder: 'primary-1', remainingMs: 500 });
    expect(ask('primary-1', 1)).toMatchObject({ granted: true });
    // The primary goes quiet: after its lease (and a moment), the standby gets it, with a higher term.
    now = 1600;
    expect(ask('standby-1', 2).granted).toBe(false);
    now = 1800;
    expect(ask('standby-1', 2)).toMatchObject({ granted: true, holder: 'standby-1', term: 2 });
    // The old primary comes back: it is told no.
    expect(ask('primary-1', 1)).toMatchObject({ granted: false, holder: 'standby-1' });
    // Given up on purpose (a switchover): free at once.
    expect(ask('standby-1', 2, true).granted).toBe(false);
    expect(ask('primary-1', 3)).toMatchObject({ granted: true, term: 3 });
    // After a restart the holder counts as just renewed.
    const again = new HaWitness({ secretOf: () => 'secret', now: () => now, load: () => [saved.at(-1)!] });
    expect(again.decide({ id: 'key-0001', node: 'standby-1', term: 4, leaseMs: 1000 }).granted).toBe(false);
    // Only signed requests count.
    const body = JSON.stringify({ id: 'key-0001', node: 'standby-1', term: 4, leaseMs: 1000 });
    expect(() => w.handle(body, signHaRequest(body, 'wrong'))).toThrow(/key is not right/);
    expect(w.handle(body, signHaRequest(body, 'secret')).granted).toBe(false);
  });
});

// Three FBRX Servers on HTTPS: a pair (A and B) and a third vote (W).
const freeTcp = () =>
  new Promise<number>((r) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });
const freeUdp = () =>
  new Promise<number>((r) => {
    const s = createSocket('udp4').bind(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Node {
  s: BuiltVirtual;
  port: number;
  dir: string;
  call: <T = any>(method: string, url: string, body?: unknown) => Promise<{ status: number; body: T }>;
}

async function node(name: string): Promise<Node> {
  const dir = mkdtempSync(join(tmpdir(), `fbrx-ha-${name}-`));
  const port = await freeTcp();
  const config = loadConfig({
    FBRX_V_DATA_DIR: dir,
    FBRX_V_ROLES: 'directory',
    FBRX_V_LOG_LEVEL: 'silent',
    FBRX_V_PORT: String(port),
    FBRX_V_HOST: '127.0.0.1',
    FBRX_V_HA_PORT: String(await freeUdp()),
    FBRX_V_HA_BIND: '127.0.0.1',
    FBRX_V_HA_BEAT_MS: '50',
    FBRX_V_HA_HANDBACK_MS: '1500',
    FBRX_V_SYS_ROOT: join(dir, 'no-sysfs'),
    FBRX_V_ADMIN_USER: 'sam',
    FBRX_V_ADMIN_PASSWORD: 'correct horse battery',
    FBRX_V_CORE_TOKEN_FILE: join(dir, 'none.token'),
  });
  const s = await buildServer(config, {});
  await s.app.listen({ port, host: '127.0.0.1' });
  const login = async () => (await s.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'sam', password: 'correct horse battery' } })).json().token as string;
  let token = await login();
  const call = async (method: string, url: string, body?: unknown, again = true): Promise<{ status: number; body: any }> => {
    const r = await s.app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${token}` }, payload: body as never });
    // The standby's console accounts are the active one's copy: sign in again after a full copy.
    if (r.statusCode === 401 && again) {
      token = await login();
      return call(method, url, body, false);
    }
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };
  return { s, port, dir, call };
}

describe('an FBRX Server pair', () => {
  let A: Node;
  let B: Node;
  let W: Node;
  const st = (n: Node) => n.s.ctx.ha.currentState();
  const waitFor = async (what: string, ok: () => boolean, ms = 6000) => {
    const end = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what} (A ${st(A)}, B ${st(B)})`);
      await sleep(20);
    }
  };
  /** Watches that the two are never active at once, until stopped. */
  const watchBoth = () => {
    let both = 0;
    const t = setInterval(() => {
      if (st(A) === 'active' && st(B) === 'active') both++;
    }, 5);
    return () => {
      clearInterval(t);
      return both;
    };
  };
  const alerts = async (n: Node) => (await n.call<ServerAlertsList>('GET', '/v1/alerts')).body;

  beforeAll(async () => {
    [A, B, W] = await Promise.all([node('a'), node('b'), node('w')]);
  });
  afterAll(async () => {
    for (const n of [A, B, W]) {
      await n?.s.close();
      if (n) rmSync(n.dir, { recursive: true, force: true });
    }
  });

  it('pairs with the standby’s code, over HTTPS trusted by its fingerprint', async () => {
    // A wrong fingerprint: nothing is sent.
    const code = (await B.call('POST', '/v1/ha/code')).body as { code: string; fingerprint: string };
    expect(code.code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    const wrongFp = Array.from({ length: 32 }, () => 'AB').join(':');
    const bad = await A.call('POST', '/v1/ha/pair', { address: `127.0.0.1:${B.port}`, fingerprint: wrongFp, code: code.code });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/different certificate/);
    // A wrong code.
    expect((await A.call('POST', '/v1/ha/pair', { address: `127.0.0.1:${B.port}`, fingerprint: code.fingerprint, code: 'AAAAA-AAAAA' })).body.error.message).toMatch(/pairing code is not right/);

    const r = await A.call<HaStatus>('POST', '/v1/ha/pair', { address: `127.0.0.1:${B.port}`, fingerprint: code.fingerprint, code: code.code.toLowerCase() });
    expect(r.status).toBe(200);
    expect(r.body.me.preference).toBe('primary');
    expect(r.body.partner).toMatchObject({ name: B.s.ctx.ha.status().me.name, preference: 'standby' });
    // Quicker for the tests: the shortest takeover time.
    expect((await A.call('PUT', '/v1/ha/settings', { takeoverMs: 600 })).status).toBe(200);
    await waitFor('A active, B standby', () => st(A) === 'active' && st(B) === 'standby');
    expect(B.s.ctx.ha.status().settings.takeoverMs).toBe(600);
    expect(A.s.ctx.ha.status().warnings.join(' ')).toMatch(/no third vote and no dedicated link/);
    // The code was used up.
    expect(B.s.ctx.ha.status().code).toBeNull();
  });

  it('makes changes on the active server only', async () => {
    const onB = await B.call('POST', '/v1/users', { username: 'robin', password: 'a long password', role: 'viewer' });
    expect(onB.status).toBe(409);
    expect(onB.body.error.message).toMatch(/not the active server of its high-availability pair: make changes on/);
    expect((await A.call('POST', '/v1/users', { username: 'robin', password: 'a long password', role: 'viewer' })).status).toBe(200);
  });

  it('takes over when the active one stops answering, then the primary comes back as the standby', async () => {
    const stop = watchBoth();
    const cut = Date.now();
    A.s.ctx.ha.testDrop({ send: ['network', 'link'], receive: ['network', 'link'] });
    await waitFor('B to take over', () => st(B) === 'active');
    const took = Date.now() - cut;
    expect(took).toBeGreaterThanOrEqual(550);
    expect(took).toBeLessThan(2500);
    // Without a third vote, A cannot know: it serves too until they hear each other again.
    A.s.ctx.ha.testDrop({});
    await waitFor('A to step back', () => st(A) === 'standby' && st(B) === 'active');
    stop();
    const kinds = A.s.ctx.ha.events().map((e) => e.kind);
    expect(kinds).toContain('both-active');
    const ev = B.s.ctx.ha.events().find((e) => e.kind === 'takeover')!;
    expect(ev.text).toMatch(/took over from/);
    expect(ev.steps.map((s) => s.text).join(' | ')).toMatch(/stopped answering: nothing heard on the network.*is serving/);
    // The takeover is an alert with its steps, cleared once A is back as the standby.
    await waitFor('the all-clear', () => B.s.ctx.alerts.list().recent.some((r) => r.alert.rule === 'ha_takeover'));
    const t = (await alerts(B)).recent.find((r) => r.alert.rule === 'ha_takeover')!;
    expect(t.alert).toMatchObject({ state: 'resolved', severity: 'critical', source: { role: 'ha' } });
    expect(t.alert.steps!.map((s) => s.text).join(' | ')).toMatch(/stopped answering.*is serving.*answered again and is the standby/);
  });

  it('hands the work back to the primary on request', async () => {
    const stop = watchBoth();
    // Asked on the standby (A): it passes it to the active one.
    const r = await A.call('POST', '/v1/ha/handback');
    expect(r.status).toBe(200);
    await waitFor('A active again', () => st(A) === 'active' && st(B) === 'standby');
    expect(stop()).toBe(0);
    const hb = A.s.ctx.ha.events().find((e) => e.kind === 'handback')!;
    expect(hb.steps.map((s) => s.text).join(' | ')).toMatch(/handed the work back to .* is serving/);
    expect(A.s.ctx.ha.status().lastDrill?.kind).toBe('handback');
  });

  it('with a third vote, never has two active servers: a broken link is not a takeover, a cut-off primary stops', async () => {
    const key = (await W.call('POST', '/v1/ha/witness/keys', { label: 'Office pair' })).body as { key: string; fingerprint: string };
    expect(key.key).toMatch(/^fbrxw1\./);
    // Set on the standby: refused (the active one holds the lease).
    expect((await B.call('PUT', '/v1/ha/witness', { url: `https://127.0.0.1:${W.port}`, fingerprint: key.fingerprint, key: key.key })).status).toBe(409);
    const set = await A.call<HaStatus>('PUT', '/v1/ha/witness', { url: `https://127.0.0.1:${W.port}`, fingerprint: key.fingerprint, key: key.key });
    expect(set.status).toBe(200);
    expect(set.body.witness).toMatchObject({ ok: true, holder: 'me' });
    expect(B.s.ctx.ha.status().witness?.url).toBe(`https://127.0.0.1:${W.port}`);
    expect(A.s.ctx.ha.status().warnings.join(' ')).not.toMatch(/third vote/);

    // The network between them breaks, both still reach the third vote: B asks, is told no, and stays the standby.
    const stop = watchBoth();
    A.s.ctx.ha.testDrop({ send: ['network'], receive: ['network'] });
    await sleep(2000);
    expect([st(A), st(B)]).toEqual(['active', 'standby']);
    A.s.ctx.ha.testDrop({});
    await sleep(300);

    // A is cut off from B and from the third vote: it stops before B takes over.
    A.s.ctx.ha.testDrop({ send: ['network'], receive: ['network'], witness: true });
    await waitFor('B to take over', () => st(B) === 'active', 8000);
    expect(st(A)).toBe('stopped');
    expect(A.s.ctx.ha.events().find((e) => e.kind === 'stopped')?.text).toMatch(/could reach neither/);
    expect((await alerts(A)).open.some((r) => r.alert.rule === 'ha_stopped')).toBe(true);
    // A is reachable again: it sees B serving and becomes the standby.
    A.s.ctx.ha.testDrop({});
    await waitFor('A standby', () => st(A) === 'standby');
    expect(stop()).toBe(0);
    await waitFor('the stop cleared', () => !A.s.ctx.alerts.list().open.some((r) => r.alert.rule === 'ha_stopped'));
  });

  it('switches over as a drill, and hands back by itself when asked to', async () => {
    const set = await B.call('PUT', '/v1/ha/settings', { autoHandBack: true });
    expect(set.body?.error?.message ?? 'ok').toBe('ok');
    expect(A.s.ctx.ha.status().settings.autoHandBack).toBe(true);
    // B serves now (after the last test); with hand back by itself, A gets the work back once it has been the
    // standby for a while.
    const stop = watchBoth();
    await waitFor('A active by itself', () => st(A) === 'active' && st(B) === 'standby', 8000);
    // A drill: to B and back.
    const sw = await A.call('POST', '/v1/ha/switchover');
    expect(sw.body?.error?.message ?? 'ok').toBe('ok');
    expect([st(A), st(B)]).toEqual(['standby', 'active']);
    expect(stop()).toBe(0);
    expect((await alerts(B)).recent.some((r) => r.alert.rule === 'ha_switchover')).toBe(true);
  });

  it('ends the pair on either side, and the third vote key can be removed', async () => {
    expect((await A.call('DELETE', '/v1/ha')).status).toBe(200);
    await waitFor('both single', () => st(A) === 'single' && st(B) === 'single');
    const keys = (await W.call('GET', '/v1/ha/witness/keys')).body as { keys: Array<{ id: string; lastUsedAt: string | null }> };
    expect(keys.keys[0]!.lastUsedAt).not.toBeNull();
    expect((await W.call('DELETE', `/v1/ha/witness/keys/${keys.keys[0]!.id}`)).status).toBe(200);
    // Changes on B again.
    expect((await B.call('POST', '/v1/users', { username: 'kim', password: 'a long password', role: 'viewer' })).status).toBe(200);
  });
});
