import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { buildServer, type BuiltVirtual } from '../src/server';
import { SimulatedHypervisor } from '../src/drivers/simulated';

let dir: string;
let s: BuiltVirtual;
let base = '';
let admin = '';
let operator = '';

const call = async (method: string, url: string, token: string, payload?: unknown) => {
  const r = await s.app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${token}` }, payload: payload as never });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};

/** A terminal over a real WebSocket: what it printed so far, and waiting for something to show up. */
function connect(path: string, ticket: string, size = { cols: 100, rows: 30 }) {
  const ws = new WebSocket(`${base}${path}?ticket=${encodeURIComponent(ticket)}&cols=${size.cols}&rows=${size.rows}`);
  let out = '';
  const closed = new Promise<{ code: number; reason: string }>((res) => ws.on('close', (code, reason) => res({ code, reason: reason.toString() })));
  ws.on('message', (d: Buffer) => (out += d.toString('utf8')));
  const opened = new Promise<void>((res, rej) => (ws.on('open', () => res()), ws.on('error', rej)));
  const until = async (re: RegExp, ms = 8000) => {
    const end = Date.now() + ms;
    while (!re.test(out)) {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${re} in: ${JSON.stringify(out.slice(-400))}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return { ws, opened, closed, until, type: (text: string) => ws.send(Buffer.from(text), { binary: true }), get out() { return out; } };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fbrx-virtual-term-'));
  const config = loadConfig({ FBRX_V_DATA_DIR: dir, FBRX_V_DRIVER: 'simulated', FBRX_V_TLS: 'off', FBRX_V_LOG_LEVEL: 'silent', FBRX_V_SYS_ROOT: join(dir, 'no-sysfs'), FBRX_V_ADMIN_USER: 'sam', FBRX_V_ADMIN_PASSWORD: 'correct horse battery', FBRX_V_TERMINAL: 'on', FBRX_V_SPAWN: 'direct' });
  s = await buildServer(config, { hypervisor: new SimulatedHypervisor({ dataDir: dir, isosDir: config.isosDir, seed: false }) });
  await s.app.listen({ host: '127.0.0.1', port: 0 });
  base = `ws://127.0.0.1:${(s.app.server.address() as AddressInfo).port}`;
  const login = async (username: string, password: string) => (await s.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username, password } })).json().token as string;
  admin = await login('sam', 'correct horse battery');
  expect((await call('POST', '/v1/users', admin, { username: 'olly', password: 'operator password', role: 'operator' })).status).toBe(200);
  operator = await login('olly', 'operator password');
});
afterAll(async () => {
  await s.close();
  rmSync(dir, { recursive: true, force: true });
});

describe.runIf(process.platform === 'linux')('Server terminal', () => {
  it('is on with FBRX Server and off elsewhere unless asked for', () => {
    expect(loadConfig({ FBRX_V_SYS_ROOT: join(dir, 'no-sysfs') }).terminal.enabled).toBe(false);
    expect(loadConfig({ FBRX_V_TERMINAL: 'on' }).terminal).toMatchObject({ enabled: true, spawn: 'direct', shell: '/bin/bash', keepDays: 30 });
    expect(loadConfig({ FBRX_V_TERMINAL: 'on', INVOCATION_ID: 'abc' }).terminal.spawn).toBe('systemd-run');
    expect(loadConfig({ FBRX_V_TERMINAL: 'on', FBRX_V_TERMINAL_RECORD: 'off' }).terminal.recordDir).toBeNull();
  });

  it('is for administrators only', async () => {
    expect((await call('GET', '/v1/host/terminal', operator)).status).toBe(403);
    expect((await call('POST', '/v1/host/terminal', operator)).status).toBe(403);
    expect((await call('GET', '/v1/host/terminal', admin)).body).toMatchObject({ available: true, recorded: true, keepDays: 30, open: 0 });
  });

  it('runs the shell, types into it, follows the window size and records the session', async () => {
    const { ticket, path } = (await call('POST', '/v1/host/terminal', admin)).body;
    const t = connect(path, ticket);
    await t.opened;
    t.type('stty size; echo done-$((40+2))\r');
    await t.until(/done-42/);
    expect(t.out).toContain('30 100');
    expect(t.out).not.toContain('\x1b]7777;');
    t.ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    await new Promise((r) => setTimeout(r, 300));
    t.type('stty size\r');
    await t.until(/40 120/);
    // Ctrl+C stops what is running, like on the server's own screen.
    t.type('sleep 30; echo slept-$((2+3))\r');
    await new Promise((r) => setTimeout(r, 300));
    t.type('\x03echo after-$((1+1))\r');
    await t.until(/after-2/);
    expect(t.out).not.toContain('slept-5');
    t.type('exit\r');
    expect((await t.closed).code).toBe(1000);
    const audit = (await call('GET', '/v1/audit', admin)).body.entries as Array<{ action: string; actor: string }>;
    expect(audit.filter((e) => e.action.startsWith('host.terminal')).map((e) => [e.actor, e.action])).toEqual([
      ['sam', 'host.terminal.close'],
      ['sam', 'host.terminal'],
    ]);
    const files = readdirSync(join(dir, 'terminal'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/-sam-[0-9a-f]{10}\.log$/);
    expect(readFileSync(join(dir, 'terminal', files[0]), 'utf8')).toContain('done-42');
  });

  it('takes a ticket once, and ends the shell when the console closes', async () => {
    const { ticket, path } = (await call('POST', '/v1/host/terminal', admin)).body;
    const t = connect(path, ticket);
    await t.opened;
    t.type('echo $FBRX_TERMINAL ready\r');
    await t.until(/[0-9a-f]{10} ready/);
    const again = connect(path, ticket);
    expect((await again.closed).code).toBe(4401);
    expect((await call('GET', '/v1/host/terminal', admin)).body.open).toBe(1);
    t.ws.close();
    await t.closed;
    await new Promise((r) => setTimeout(r, 200));
    expect((await call('GET', '/v1/host/terminal', admin)).body.open).toBe(0);
  });
});
