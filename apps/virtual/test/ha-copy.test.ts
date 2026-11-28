import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GateConfig } from '@fbrx/gate';
import type { HaStatus } from '@fbrx/shared';
import { openString, sealString } from '@fbrx/shared/node';
import { loadConfig } from '../src/config';
import { buildServer, type BuiltVirtual } from '../src/server';

// High availability's copy: two FBRX Servers with the directory, gate and MiniDome roles, each with things of its
// own before they pair.
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
  const dir = mkdtempSync(join(tmpdir(), `fbrx-hacopy-${name}-`));
  const port = await freeTcp();
  const s = await buildServer(
    loadConfig({
      FBRX_V_DATA_DIR: dir,
      FBRX_V_ROLES: 'directory,gate,minidome',
      FBRX_V_GATE: 'simulated',
      FBRX_V_LOG_LEVEL: 'silent',
      FBRX_V_PORT: String(port),
      FBRX_V_HOST: '127.0.0.1',
      FBRX_V_HA_PORT: String(await freeUdp()),
      FBRX_V_HA_BIND: '127.0.0.1',
      FBRX_V_HA_BEAT_MS: '50',
      FBRX_V_SYS_ROOT: join(dir, 'no-sysfs'),
      FBRX_V_ADMIN_USER: 'sam',
      FBRX_V_ADMIN_PASSWORD: 'correct horse battery',
      FBRX_V_CORE_TOKEN_FILE: join(dir, 'none.token'),
    }),
    {},
  );
  await s.app.listen({ port, host: '127.0.0.1' });
  const login = async () => (await s.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'sam', password: 'correct horse battery' } })).json().token as string;
  let token = await login();
  const call = async (method: string, url: string, body?: unknown, again = true): Promise<{ status: number; body: any }> => {
    const r = await s.app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${token}` }, payload: body as never });
    // A full copy replaces the standby's console accounts with the active one's: sign in again.
    if (r.statusCode === 401 && again) {
      token = await login();
      return call(method, url, body, false);
    }
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };
  return { s, port, dir, call };
}

describe('high availability: the standby’s copy', () => {
  let A: Node;
  let B: Node;
  const st = (n: Node) => n.s.ctx.ha.currentState();
  const key = (n: Node) => (n.s.ctx.ha as unknown as { o: { key: Buffer } }).o.key;
  const waitFor = async (what: string, ok: () => boolean | Promise<boolean>, ms = 8000) => {
    const end = Date.now() + ms;
    while (!(await ok())) {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what} (A ${st(A)}, B ${st(B)})`);
      await sleep(25);
    }
  };
  const caughtUp = () => {
    const c = A.s.ctx.ha.status().copy;
    return c.length > 0 && c.every((v) => v.state === 'caught-up');
  };
  const people = async (n: Node) => ((await n.call('GET', '/v1/directory')).body.users as Array<{ username: string }>).map((u) => u.username).sort();

  beforeAll(async () => {
    [A, B] = await Promise.all([node('a'), node('b')]);
  });
  afterAll(async () => {
    for (const n of [A, B]) {
      await n?.s.close();
      if (n) rmSync(n.dir, { recursive: true, force: true });
    }
  });

  it('copies everything the pair keeps when they pair, and keeps what belongs to each server', async () => {
    // A: people, where alerts go (with a sealed password), a gate change committed.
    expect((await A.call('POST', '/v1/directory/users', { username: 'jane', password: 'Abcdefgh12345' })).status).toBe(200);
    expect((await A.call('PUT', '/v1/alerts/settings', { email: { enabled: true, host: 'smtp.example.org', to: 'it@example.org', user: 'fbrx', password: 'smtp-secret' } })).status).toBe(200);
    const cand: GateConfig = (await A.call('GET', '/v1/gate')).body.state.candidate;
    cand.hostname = 'office-gate';
    expect((await A.call('PUT', '/v1/gate/candidate', { config: cand })).status).toBe(200);
    await A.s.ctx.gate!.engine.commit({ by: 'sam', comment: 'Named the gate' });
    // B: a person and a console account of its own, and its management controller (which stays B's).
    await B.call('POST', '/v1/directory/users', { username: 'old', password: 'Abcdefgh12345' });
    await B.call('POST', '/v1/users', { username: 'local', password: 'a long password', role: 'viewer' });
    B.s.ctx.db.run("INSERT INTO settings (key, value) VALUES ('bmc', ?)", JSON.stringify({ host: '10.0.0.9', username: 'root', password: sealString(key(B), 'idrac-secret', 'bmc'), fingerprint: null, kind: 'idrac', connectedAt: new Date().toISOString(), lastError: null }));

    const code = (await B.call('POST', '/v1/ha/code')).body as { code: string; fingerprint: string };
    expect((await A.call('POST', '/v1/ha/pair', { address: `127.0.0.1:${B.port}`, fingerprint: code.fingerprint, code: code.code })).status).toBe(200);
    await A.call('PUT', '/v1/ha/settings', { takeoverMs: 600 });
    await waitFor('A active, B standby, copy caught up', () => st(A) === 'active' && st(B) === 'standby' && caughtUp());

    // B has A's people, accounts, alert settings and gate; its own are gone.
    expect(await people(B)).toEqual(['jane']);
    const users = B.s.ctx.db.all<{ username: string }>('SELECT username FROM users ORDER BY username').map((u) => u.username);
    expect(users).toEqual(['sam']);
    expect(B.s.ctx.gate!.engine.candidate().hostname).toBe('office-gate');
    expect(B.s.ctx.gate!.engine.history().map((c) => c.comment)).toEqual(A.s.ctx.gate!.engine.history().map((c) => c.comment));
    // The two have the same key now: B opens what A sealed, and B's own controller password still opens.
    expect(readFileSync(join(B.dir, 'keys/master.key'), 'utf8')).toBe(readFileSync(join(A.dir, 'keys/master.key'), 'utf8'));
    const alerts = JSON.parse(B.s.ctx.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'alerts.settings'")!.value);
    expect(openString(key(B), alerts.email.password, 'alerts.email')).toBe('smtp-secret');
    const bmc = JSON.parse(B.s.ctx.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'bmc'")!.value);
    expect(bmc.host).toBe('10.0.0.9');
    expect(openString(key(B), bmc.password, 'bmc')).toBe('idrac-secret');
    // A's own controller is not copied over B's.
    expect(A.s.ctx.db.get("SELECT 1 FROM settings WHERE key = 'bmc'")).toBeUndefined();
    // The page shows each role's copy.
    const s = A.s.ctx.ha.status() as HaStatus;
    expect(s.copy.map((c) => c.name).sort()).toEqual(['directory', 'gate', 'minidome', 'server']);
    expect(B.s.ctx.ha.status().copy.every((c) => c.state === 'caught-up' && c.currentAt)).toBe(true);
  });

  it('copies each change as it is made', async () => {
    const t0 = Date.now();
    await A.call('POST', '/v1/directory/users', { username: 'kim', password: 'Abcdefgh12345' });
    await waitFor('kim on B', async () => (await people(B)).includes('kim'), 3000);
    expect(Date.now() - t0).toBeLessThan(2000);
    await A.call('DELETE', '/v1/directory/users/jane');
    await waitFor('jane gone from B', async () => !(await people(B)).includes('jane'), 3000);
  });

  it('takes over with its copy, then the old primary gets the new one in full', async () => {
    A.s.ctx.ha.testDrop({ send: ['network', 'link'], receive: ['network', 'link'] });
    await waitFor('B to take over', () => st(B) === 'active');
    const ev = B.s.ctx.ha.events().find((e) => e.kind === 'takeover')!;
    expect(ev.steps.map((x) => x.text).join(' | ')).toMatch(/Its copy of .+'s data was current as of \d+(\.\d)? s before/);
    // A change on B while A is away.
    expect((await B.call('POST', '/v1/directory/users', { username: 'lee', password: 'Abcdefgh12345' })).status).toBe(200);
    A.s.ctx.ha.testDrop({});
    await waitFor('A back as the standby with B’s copy', async () => st(A) === 'standby' && (await people(A)).includes('lee'));
    expect(await people(A)).toEqual(['kim', 'lee']);
  });

  it('switches over with nothing lost: the last change made just before goes too', async () => {
    expect((await B.call('POST', '/v1/directory/users', { username: 'max', password: 'Abcdefgh12345' })).status).toBe(200);
    const r = await B.call('POST', '/v1/ha/switchover');
    expect(r.body?.error?.message ?? 'ok').toBe('ok');
    expect(st(A)).toBe('active');
    expect(await people(A)).toEqual(['kim', 'lee', 'max']);
    // And the copy goes the other way now.
    await waitFor('B caught up', async () => st(B) === 'standby' && caughtUp());
    expect(await people(B)).toEqual(['kim', 'lee', 'max']);
  });

  it('ends the pair: both keep what they have and journal nothing', async () => {
    expect((await A.call('DELETE', '/v1/ha')).status).toBe(200);
    await waitFor('both single', () => st(A) === 'single' && st(B) === 'single');
    for (const n of [A, B]) {
      expect(n.s.ctx.db.all("SELECT name FROM sqlite_master WHERE name LIKE 'ha_journal_%' OR (type = 'trigger' AND name LIKE 'ha_copy_%')")).toEqual([]);
      expect(await people(n)).toEqual(['kim', 'lee', 'max']);
    }
  });
});
