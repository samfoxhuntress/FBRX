import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FbrxAlertSchema, type FbrxAlert } from '@fbrx/shared';
import { Db, verifyFbrxAlertSignature } from '@fbrx/shared/node';
import { ServerAlerts } from '../src/alerts/service';
import { VIRTUAL_MIGRATIONS } from '../src/migrations';
import { loadConfig } from '../src/config';
import { buildServer, type BuiltVirtual } from '../src/server';

const posted: Array<{ alert: FbrxAlert; sig: string; body: string }> = [];
const logged: string[] = [];
const hook = createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    posted.push({ alert: FbrxAlertSchema.parse(JSON.parse(b)), sig: String(req.headers['fbrx-signature']), body: b });
    res.end();
  });
});
const udp = createSocket('udp4');
let dir: string;
let db: Db;
const wait = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
};

beforeAll(async () => {
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
  udp.on('message', (m) => logged.push(m.toString()));
  await new Promise<void>((r) => udp.bind(0, '127.0.0.1', () => r()));
  dir = mkdtempSync(join(tmpdir(), 'fbrx-alerts-'));
  db = new Db(join(dir, 'virtual.db'));
  db.migrate(VIRTUAL_MIGRATIONS);
});
afterAll(() => {
  hook.close();
  udp.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("FBRX Server's alerts", () => {
  it('says a problem once to each channel from its severity, then its all-clear where it went', async () => {
    let free = 50;
    let problems: string[] = [];
    const alerts = new ServerAlerts({ db, key: randomBytes(32), host: 'srv-1', log: () => undefined, dirs: ['/srv/images'], space: () => ({ freePct: free, freeBytes: free * 1e9, device: '1' }), gateProblems: async () => problems });
    const s = alerts.setSettings({
      webhook: { enabled: true, min: 'info', url: `http://127.0.0.1:${(hook.address() as AddressInfo).port}/alerts`, secret: 'shh' },
      syslog: { enabled: true, min: 'warning', host: '127.0.0.1', port: udp.address().port, protocol: 'udp' },
    });
    // Secrets are kept, never shown.
    expect(s.webhook).toMatchObject({ enabled: true, secretSet: true });
    expect(JSON.stringify(s)).not.toContain('shh');
    expect(() => alerts.setSettings({ webhook: { url: 'ftp://x' } })).toThrow('https://');

    // A drive getting full: a warning, said once.
    free = 6;
    await alerts.checkDisks();
    await alerts.checkDisks();
    await wait(() => logged.length >= 1);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.alert).toMatchObject({ state: 'open', severity: 'warning', rule: 'disk_low', source: { app: 'fbrx-server', host: 'srv-1' }, key: 'fbrx-server|srv-1|disk_low|/srv/images' });
    expect(verifyFbrxAlertSignature(posted[0]!.body, posted[0]!.sig, 'shh')).toBe(true);
    expect(logged[0]).toMatch(/^<132>1 .* srv-1 fbrx-server - OPEN - The drive of \/srv\/images is running out of space/);
    // Worse: said again, as critical.
    free = 2;
    await alerts.checkDisks();
    await wait(() => posted.length >= 3);
    expect(posted.slice(1).map((p) => [p.alert.state, p.alert.severity])).toEqual([
      ['resolved', 'warning'],
      ['open', 'critical'],
    ]);
    // Over at 12% free (not at 10.5%, so it does not flap).
    free = 10.5;
    await alerts.checkDisks();
    expect(alerts.list().open).toHaveLength(1);
    free = 20;
    await alerts.checkDisks();
    await wait(() => posted.length >= 4);
    expect(posted[3]!.alert).toMatchObject({ state: 'resolved', severity: 'critical', key: posted[0]!.alert.key });
    expect(posted[3]!.alert.endedAt).toBeTruthy();

    // An event below syslog's severity goes to the webhook only.
    const before = logged.length;
    await alerts.event({ rule: 'dome_new-device', role: 'minidome', severity: 'info', title: 'New device on LAN: printer' });
    await wait(() => posted.length >= 5);
    expect(posted[4]!.alert).toMatchObject({ state: 'event', source: { role: 'minidome' } });
    await new Promise((r) => setTimeout(r, 100));
    expect(logged.length).toBe(before);

    // The gate's own list of problems: each one open until the gate no longer reports it; the simulated note is none.
    problems = ['The internet port has no address yet', 'Simulated gate: nothing on this computer is changed.'];
    await alerts.checkGate();
    await alerts.checkGate();
    expect(alerts.list().open.map((r) => [r.alert.title, r.alert.severity, r.alert.source.role])).toEqual([['The gate has lost the internet', 'critical', 'gate']]);
    problems = [];
    await alerts.checkGate();
    expect(alerts.list().open).toHaveLength(0);
    expect(alerts.list().recent[0]).toMatchObject({ alert: { state: 'resolved', rule: 'gate_problem' }, cleared: { webhook: 'ok', syslog: 'ok' } });
    expect(await alerts.clear('gate_problem', 'nothing')).toBe(false);
    expect(await alerts.test('webhook')).toEqual({ ok: true, result: 'Sent' });
  });

  it('lets everyone see the alerts and only administrators change where they go', async () => {
    const d = mkdtempSync(join(tmpdir(), 'fbrx-alerts-api-'));
    let s: BuiltVirtual | null = null;
    try {
      s = await buildServer(loadConfig({ FBRX_V_DATA_DIR: d, FBRX_V_ROLES: 'virtual', FBRX_V_DRIVER: 'simulated', FBRX_V_TLS: 'off', FBRX_V_LOG_LEVEL: 'silent', FBRX_V_SYS_ROOT: join(d, 'no-sysfs'), FBRX_V_ADMIN_USER: 'sam', FBRX_V_ADMIN_PASSWORD: 'correct horse battery', FBRX_V_CORE_TOKEN_FILE: join(d, 'none.token') }));
      const app = s.app;
      const login = async (u: string, p: string) => (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: u, password: p } })).json().token as string;
      const admin = await login('sam', 'correct horse battery');
      const as = (t: string) => ({ authorization: `Bearer ${t}` });
      await app.inject({ method: 'POST', url: '/v1/users', headers: as(admin), payload: { username: 'vic', password: 'viewer password', role: 'viewer' } });
      const viewer = await login('vic', 'viewer password');
      expect((await app.inject({ method: 'GET', url: '/v1/alerts', headers: as(viewer) })).json()).toEqual({ open: [], recent: [] });
      expect((await app.inject({ method: 'GET', url: '/v1/alerts/settings', headers: as(viewer) })).statusCode).toBe(403);
      const put = await app.inject({ method: 'PUT', url: '/v1/alerts/settings', headers: as(admin), payload: { email: { enabled: true, host: 'smtp.example.com', to: 'it@example.com', password: 'mail-pass' } } });
      expect(put.statusCode).toBe(200);
      expect(put.json().settings.email).toMatchObject({ enabled: true, passwordSet: true, min: 'warning' });
      expect(put.body).not.toContain('mail-pass');
      expect((await app.inject({ method: 'PUT', url: '/v1/alerts/settings', headers: as(viewer), payload: { syslog: { enabled: true } } })).statusCode).toBe(403);
      // The audit log says what changed, never the password.
      const audit = (await app.inject({ method: 'GET', url: '/v1/audit', headers: as(admin) })).body;
      expect(audit).toContain('alerts.settings');
      expect(audit).not.toContain('mail-pass');
    } finally {
      await s?.close();
      rmSync(d, { recursive: true, force: true });
    }
  });
});
