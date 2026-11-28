import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HA_SIGNED_TYPE, signHaRequest } from '@fbrx/shared/node';
import { buildServer, type BuiltServer } from '../src/server';
import { loadConfig } from '../src/config';

/** FBRX Command as the third vote of the organization's FBRX Server pairs: keys, leases, and only the pair's own. */
const PASSWORD = 'Super-Secret-Admin-Pass-1';
let server: BuiltServer;
let base = '';
let token = '';
let tenantId = '';
let dataDir = '';
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'x-fbrx-tenant': tenantId, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};
/** What a pair's server sends: signed with the key's secret. */
const lease = async (key: string, node: string, term: number, secretOverride?: string) => {
  const [, id, secret] = /^fbrxw1\.([^.]+)\.(.+)$/.exec(key)!;
  const body = JSON.stringify({ id, node, term, leaseMs: 1000 });
  const res = await fetch(`${base}/v1/ha/witness/lease`, { method: 'POST', headers: { 'content-type': HA_SIGNED_TYPE, 'FBRX-Signature': signHaRequest(body, secretOverride ?? secret!) }, body });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'fbrx-cp-witness-'));
  server = await buildServer(loadConfig({}, { dataDir, port: 0, host: '127.0.0.1', logLevel: 'silent', setupToken: 'setup-token-123', adminConsoleDir: null, heartbeatSeconds: 10 }));
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
  server.ctx.config.publicUrl = base;
  const setup = await (await fetch(`${base}/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupToken: 'setup-token-123', organization: 'Fox Lab', name: 'Sam', email: 'sam@fox.example', password: PASSWORD }) })).json();
  tenantId = setup.tenantId;
  token = (await (await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'sam@fox.example', password: PASSWORD }) })).json()).token;
}, 60_000);

afterAll(async () => {
  await server?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('FBRX Command as a third vote', () => {
  it('gives a pair’s lease to one server at a time, only with the pair’s key, until the key is removed', async () => {
    const made = (await call('POST', '/v1/admin/ha/witness/keys', { label: 'Office servers' })).body as { id: string; key: string; url: string };
    expect(made.key).toMatch(/^fbrxw1\./);
    expect(made.url).toBe(base);
    // The primary holds the pair; the standby is told no while it does.
    expect((await lease(made.key, 'primary-node-1', 1)).body).toMatchObject({ granted: true, holder: 'primary-node-1' });
    expect((await lease(made.key, 'standby-node-1', 2)).body).toMatchObject({ granted: false, holder: 'primary-node-1' });
    // Not signed with the key's secret: refused.
    expect((await lease(made.key, 'standby-node-1', 2, 'not-the-secret-not-the-secret-xx')).status).toBe(401);
    const list = (await call('GET', '/v1/admin/ha/witness')).body as { keys: Array<{ id: string; label: string; holding: boolean; lastUsedAt: string | null }> };
    expect(list.keys).toEqual([expect.objectContaining({ id: made.id, label: 'Office servers', holding: true })]);
    expect(list.keys[0]!.lastUsedAt).not.toBeNull();
    // The audit log has it; removing the key ends it.
    expect((await call('DELETE', `/v1/admin/ha/witness/keys/${made.id}`)).status).toBe(200);
    expect((await lease(made.key, 'primary-node-1', 1)).status).toBe(401);
    expect((await call('GET', '/v1/admin/ha/witness')).body.keys).toEqual([]);
  });
});
