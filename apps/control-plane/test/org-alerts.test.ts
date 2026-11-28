import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fbrxAlertKey, type FbrxAlert, type OrgAlertRow } from '@fbrx/shared';
import { postFbrxAlert } from '@fbrx/shared/node';
import { buildServer, type BuiltServer } from '../src/server';
import { loadConfig } from '../src/config';
import { Kernel } from '../../../packages/core/src/kernel';
import { createNodePlatform } from '../../../packages/core/src/node-platform';
import { StaticKeyKeychain } from '../../../packages/core/src/platform';

/**
 * FBRX Alerts in an organization: who gets what (e-mail, FBRX OS on chosen computers), acknowledging from either
 * side, the all-clear to whoever heard the alert, escalation, quiet hours, and FBRX Servers' signed alerts.
 */
const USER = { origin: 'user' as const, actor: 'tester' };
const PASSWORD = 'Super-Secret-Admin-Pass-1';

async function waitFor<T>(fn: () => T | Promise<T>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timeout');
}

let server: BuiltServer;
let base = '';
let token = '';
let tenantId = '';
let kernel: Kernel;
let dataDir = '';
let kernelDir = '';
let deviceId = '';
const mail: Array<{ to: string; subject: string; text: string }> = [];

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'x-fbrx-tenant': tenantId, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

const rule = (o: Record<string, unknown> = {}) => ({
  name: 'IT',
  enabled: true,
  min: 'warning',
  apps: [],
  tags: [],
  emails: ['it@fox.example'],
  computerTags: ['it'],
  helpdeskComputers: false,
  quiet: { enabled: false, from: '22:00', to: '07:00', timeZone: 'UTC' },
  escalateAfterMinutes: 0,
  escalateEmails: [],
  escalateComputerTags: [],
  ...o,
});

const alert = (o: Partial<FbrxAlert> = {}): FbrxAlert => {
  const now = new Date().toISOString();
  return {
    v: 1,
    id: `fa_${randomBytes(4).toString('hex')}`,
    key: fbrxAlertKey('fbrx-os', 'front-desk', 'disk_low', 'C:'),
    state: 'open',
    severity: 'warning',
    source: { app: 'fbrx-os', host: 'front-desk' },
    rule: 'disk_low',
    title: 'Drive C: is running out of space',
    detail: '4 GB free (3%).',
    startedAt: now,
    sentAt: now,
    ...o,
  };
};

const hhmm = (d: Date) => d.toISOString().slice(11, 16);

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'fbrx-cp-alerts-'));
  server = await buildServer(loadConfig({}, { dataDir, port: 0, host: '127.0.0.1', logLevel: 'silent', setupToken: 'setup-token-123', adminConsoleDir: null, heartbeatSeconds: 10 }));
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
  server.ctx.config.publicUrl = base;
  server.ctx.mail.send = async (m) => void mail.push({ to: m.to, subject: m.subject, text: m.text });
  const setup = await (await fetch(`${base}/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupToken: 'setup-token-123', organization: 'Fox Lab', name: 'Sam', email: 'sam@fox.example', password: PASSWORD }) })).json();
  tenantId = setup.tenantId;
  token = (await (await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'sam@fox.example', password: PASSWORD }) })).json()).token;

  const enr = (await call('POST', '/v1/admin/enrollment-tokens', { label: 'Office', maxUses: 2, expiresInDays: 1 })).body;
  kernelDir = mkdtempSync(join(tmpdir(), 'fbrx-cp-alerts-dev-'));
  process.env.FBRX_ALLOW_INSECURE_FLEET = '1';
  kernel = await Kernel.create({ dataDir: kernelDir, platform: createNodePlatform({ dataDir: kernelDir, devMode: false, keychain: new StaticKeyKeychain(randomBytes(32), 'memory') }) });
  kernel.settings.update({ localApi: { enabled: false }, runtime: { enabled: false }, protection: { shield: { updateSignatures: false } }, profile: { name: 'Robin' } });
  await kernel.start();
  await kernel.call('fleet.enroll', { serverUrl: base, token: enr.token, deviceName: 'IT desk' }, USER);
  await waitFor(() => kernel.fleet.status().state === 'online');
  deviceId = await waitFor(async () => (await call('GET', '/v1/admin/devices')).body?.find?.((d: { name: string; online: boolean }) => d.name === 'IT desk' && d.online)?.id);
  server.ctx.db.run('UPDATE devices SET tags = ? WHERE id = ?', JSON.stringify(['it']), deviceId);
}, 60_000);

afterAll(async () => {
  await kernel?.stop().catch(() => undefined);
  await server?.close();
  rmSync(dataDir, { recursive: true, force: true });
  if (kernelDir) rmSync(kernelDir, { recursive: true, force: true });
});

describe('FBRX Alerts in an organization', () => {
  it('tells the people a rule names, by e-mail and in FBRX OS, and both sides can acknowledge', async () => {
    const saved = await call('PUT', '/v1/admin/alerts/rules', { rules: [rule()] });
    expect(saved.status).toBe(200);
    expect(saved.body.rules[0]).toMatchObject({ name: 'IT', emails: ['it@fox.example'] });
    expect((await call('PUT', '/v1/admin/alerts/rules', { rules: [rule({ emails: ['not an address'] })] })).status).toBe(400);

    // A computer's alert, as FBRX OS 2.6.0 sends it (the FBRX Alert rides along).
    const a = alert();
    kernel.fleet.reportEvent({ kind: 'alert', severity: 'warning', message: `${a.title}: ${a.detail}`, data: { ruleId: 'disk_low', fbrxAlert: a }, at: a.sentAt });
    const row = (await waitFor(async () => ((await call('GET', '/v1/admin/alerts')).body.open as OrgAlertRow[]).find((r) => r.alert.key === a.key)))!;
    expect(row.deviceName).toBe('IT desk');
    expect(row.notified).toEqual(expect.arrayContaining(['e-mail it@fox.example', 'FBRX OS on IT desk']));
    expect(mail.find((m) => m.to === 'it@fox.example')?.subject).toBe('[FBRX WARNING] Drive C: is running out of space');

    // The same problem again is folded into it, and nobody hears it twice.
    kernel.fleet.reportEvent({ kind: 'alert', severity: 'warning', message: 'again', data: { fbrxAlert: alert({ key: a.key }) }, at: a.sentAt });
    await waitFor(async () => (await call('GET', '/v1/admin/alerts')).body.open.find((r: OrgAlertRow) => r.id === row.id)?.count === 2);
    expect(mail.filter((m) => m.to === 'it@fox.example')).toHaveLength(1);

    // FBRX OS on the IT desk shows it with Acknowledge; acknowledging there tells FBRX Command.
    const item = (await waitFor(() => kernel.alerts.inbox().find((i) => i.org?.alertId === row.id)))!;
    expect(item.body).toContain('From your organization');
    const acked = (await kernel.call('alerts.acknowledge', { id: item.id }, USER)) as { org: { acknowledged: { by: string } } };
    expect(acked.org.acknowledged.by).toBe('Robin');
    const after = await waitFor(async () => (await call('GET', '/v1/admin/alerts')).body.open.find((r: OrgAlertRow) => r.id === row.id && r.acknowledged));
    expect(after.acknowledged.by).toBe('Robin on IT desk');
    // An AI app or script cannot acknowledge for a person.
    await expect(kernel.call('alerts.acknowledge', { id: item.id }, { origin: 'api', actor: 'script' })).rejects.toThrow();

    // Its all-clear reaches whoever heard it.
    kernel.fleet.reportEvent({ kind: 'alert', severity: 'info', message: 'over', data: { fbrxAlert: alert({ key: a.key, state: 'resolved', endedAt: new Date().toISOString() }) }, at: a.sentAt });
    await waitFor(async () => (await call('GET', '/v1/admin/alerts')).body.recent.find((r: OrgAlertRow) => r.id === row.id)?.alert.state === 'resolved');
    await waitFor(() => mail.some((m) => m.subject === '[FBRX ALL CLEAR] Drive C: is running out of space'));
    await waitFor(() => kernel.alerts.inbox().find((i) => i.id === item.id)?.title.startsWith('All clear:'));
  }, 30_000);

  it('escalates what nobody acknowledged in time, holds the rest through quiet hours and lets critical ones through', async () => {
    const now = new Date();
    await call('PUT', '/v1/admin/alerts/rules', {
      rules: [rule({ name: 'Night', emails: ['night@fox.example'], computerTags: [], quiet: { enabled: true, from: hhmm(new Date(now.getTime() - 3600_000)), to: hhmm(new Date(now.getTime() + 3600_000)), timeZone: 'UTC' }, escalateAfterMinutes: 5, escalateEmails: ['boss@fox.example'] })],
    });
    const held = server.ctx.alerts.ingest(tenantId, alert({ key: 'fbrx-server|srv|disk_low|/srv', source: { app: 'fbrx-server', host: 'srv', role: 'files' } }))!;
    expect(held.notified).toEqual(['held for quiet hours (Night)']);
    expect(mail.some((m) => m.to === 'night@fox.example')).toBe(false);
    const critical = server.ctx.alerts.ingest(tenantId, alert({ key: 'fbrx-server|srv|no_internet', severity: 'critical', title: 'FBRX Gate has no internet address' }))!;
    expect(critical.notified).toEqual(['e-mail night@fox.example']);

    // Older than five minutes, nobody acknowledged it: the next people hear it.
    server.ctx.db.run('UPDATE org_alerts SET started_at = ? WHERE id = ?', new Date(now.getTime() - 6 * 60_000).toISOString(), critical.id);
    server.ctx.alerts.tick();
    expect(mail.find((m) => m.to === 'boss@fox.example')?.subject).toBe('[Not acknowledged] [FBRX CRITICAL] FBRX Gate has no internet address');
    expect(server.ctx.alerts.get(critical.id)!.escalatedAt).not.toBeNull();
    // Acknowledged in the console: no more escalation for it.
    const ack = await call('POST', `/v1/admin/alerts/${held.id}/acknowledge`, { note: 'Clearing old copies' });
    expect(ack.body.acknowledged).toMatchObject({ by: 'sam@fox.example', note: 'Clearing old copies' });
  });

  it('takes FBRX Servers’ alerts signed with the organization’s secret, and nothing else', async () => {
    const inbound = await call('POST', '/v1/admin/alerts/inbound/secret');
    expect(inbound.body.url).toBe(`${base}/v1/alerts/inbound/${tenantId}`);
    const a = alert({ key: 'fbrx-server|srv|time_task_failed|nightly', source: { app: 'fbrx-server', host: 'srv', role: 'time' }, title: 'FBRX Time: nightly copy failed' });
    await postFbrxAlert(inbound.body.url, a, inbound.body.secret);
    expect((await call('GET', '/v1/admin/alerts')).body.open.some((r: OrgAlertRow) => r.alert.key === a.key)).toBe(true);
    await expect(postFbrxAlert(inbound.body.url, alert({ key: 'forged' }), 'wrong-secret')).rejects.toThrow('HTTP 401');
    await expect(postFbrxAlert(`${base}/v1/alerts/inbound/ten_nope`, a, inbound.body.secret)).rejects.toThrow('HTTP 401');
    expect((await call('GET', '/v1/admin/alerts/inbound')).body).toEqual({ url: inbound.body.url, secretSet: true });
  });

  it('keeps an incident report for each alert: what happened, in order, linked from the alert', async () => {
    await call('PUT', '/v1/admin/alerts/rules', { rules: [rule({ computerTags: [] })] });
    const key = fbrxAlertKey('fbrx-server', 'srv-office', 'ha_takeover');
    const started = new Date(Date.now() - 5 * 60_000).toISOString();
    // A step written with the sender's own offset (+02:00) still sorts by when it happened.
    const moved = new Date(Date.parse(started) + 30_000 + 2 * 3_600_000).toISOString().replace('Z', '+02:00');
    const a = alert({ key, title: 'The standby took over the gate', source: { app: 'fbrx-server', host: 'srv-office', role: 'gate' }, startedAt: started, steps: [{ at: started, text: 'The primary stopped answering (3 heartbeats missed)' }, { at: moved, text: 'The standby took the gate address' }] });
    const row = server.ctx.alerts.ingest(tenantId, a)!;
    expect(row.alert.report).toBe(`${base}/#/alerts/${row.id}`);
    server.ctx.alerts.ingest(tenantId, { ...a, id: 'fa_again1', sentAt: new Date().toISOString() });
    server.ctx.alerts.ingest(tenantId, { ...a, id: 'fa_again2', sentAt: new Date().toISOString(), severity: 'critical' });
    server.ctx.alerts.acknowledge(row.id, 'Robin', 'On it');
    server.ctx.alerts.ingest(tenantId, { ...a, id: 'fa_over', state: 'resolved', steps: [...a.steps!, { at: new Date().toISOString(), text: 'The gate moved back to the primary; no downloads were lost' }], endedAt: new Date().toISOString() });

    const r = await call('GET', `/v1/admin/alerts/${row.id}/report`);
    expect(r.status).toBe(200);
    const kinds = (r.body.timeline as Array<{ kind: string; text: string }>).map((e) => e.kind);
    expect(kinds[0]).toBe('opened');
    expect(kinds).toEqual(expect.arrayContaining(['step', 'told', 'repeated', 'worse', 'acknowledged', 'resolved']));
    expect(kinds.filter((k) => k === 'step')).toHaveLength(3);
    expect(r.body.timeline[2]).toMatchObject({ kind: 'step', text: 'The standby took the gate address', at: new Date(moved).toISOString() });
    expect(kinds.at(-1)).toBe('resolved');
    expect(r.body.lastedMs).toBeGreaterThan(4 * 60_000);
    expect(r.body.acknowledgedAfterMs).toBeGreaterThan(4 * 60_000);
    expect(r.body.markdown).toContain('# Incident report: The standby took over the gate');
    expect(r.body.markdown).toContain('Acknowledged by Robin: On it');
    expect(r.body.markdown).toContain('no downloads were lost');
    expect((await call('GET', '/v1/admin/alerts/alr_nope/report')).status).toBe(404);
  });
});
