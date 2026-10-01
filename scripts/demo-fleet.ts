/**
 * Local demo: a control plane + several FBRX OS cores (headless) enrolled into it, so you can explore the
 * admin console and fleet features on one machine.
 *
 *   npx tsx scripts/demo-fleet.ts [--devices 3] [--port 8787]
 *
 * Admin console: http://localhost:8787  (admin@fbrx.local / FbrxDemo-Admin-2026)
 * Data lives in .fbrx-demo/ (delete it to start over).
 */
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { buildServer } from '../apps/control-plane/src/server';
import { loadConfig } from '../apps/control-plane/src/config';
import { Kernel } from '../packages/core/src/kernel';
import { createNodePlatform } from '../packages/core/src/node-platform';
import { StaticKeyKeychain } from '../packages/core/src/platform';
import { DEFAULT_POLICY } from '../packages/shared/src';

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1];
};
const deviceCount = Number(arg('--devices', '3'));
const port = Number(arg('--port', '8787'));
const root = resolve('.fbrx-demo');
const ADMIN = { email: 'admin@fbrx.local', password: 'FbrxDemo-Admin-2026' };
const NAMES = ['Design Studio Mac', 'Finance Laptop 01', 'Reception PC', 'Engineering Workstation', 'Field Tablet', 'Ops Console'];

process.env.FBRX_ALLOW_INSECURE_FLEET = '1';
mkdirSync(root, { recursive: true });

const server = await buildServer(
  loadConfig(
    { ...process.env, FBRX_CP_ADMIN_EMAIL: ADMIN.email, FBRX_CP_ADMIN_PASSWORD: ADMIN.password, FBRX_CP_ORGANIZATION: 'Fabrics Demo Co', FBRX_CP_ADMIN_NAME: 'Demo Admin' },
    { dataDir: join(root, 'control-plane'), port, host: '127.0.0.1', publicUrl: `http://localhost:${port}`, logLevel: 'warn', heartbeatSeconds: 15 },
  ),
);
await server.app.listen({ port, host: '127.0.0.1' });
const base = `http://127.0.0.1:${port}`;

const login = await (await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ADMIN) })).json();
const me = await (await fetch(`${base}/v1/auth/me`, { headers: { authorization: `Bearer ${login.token}` } })).json();
const tenantId = me.tenants[0].id;
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${login.token}`, 'x-fbrx-tenant': tenantId, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json();
};

const existing = await api('GET', '/v1/admin/devices');
let token: string | null = null;
if (!existing.length) {
  const profile = await api('POST', '/v1/admin/profiles', {
    name: 'Standard workstation',
    description: 'Daily backups, local-first AI, approvals for writes',
    settings: { backup: { scheduleEnabled: true, intervalHours: 24 }, ai: { temperature: 0.2 } },
    locked: ['backup.scheduleEnabled'],
    policy: DEFAULT_POLICY,
  });
  await api('PATCH', `/v1/admin/tenants/${tenantId}`, { defaultProfileId: profile.id });
  await api('POST', '/v1/admin/groups', { name: 'Finance', description: 'Finance team laptops' });
  await api('POST', '/v1/admin/secrets', { scope: 'tenant', name: 'FBRX_BACKUP_PASSPHRASE', value: randomBytes(18).toString('base64url'), description: 'Organisation backup key' });
  await api('POST', '/v1/admin/licenses', { edition: 'enterprise', seats: 25 });
  token = (await api('POST', '/v1/admin/enrollment-tokens', { label: 'Demo devices', maxUses: 50, expiresInDays: 30 })).token;
}
const { publicKeyPem } = await api('GET', '/v1/admin/licensing/public-key');

const kernels: Kernel[] = [];
for (let i = 0; i < deviceCount; i++) {
  const dataDir = join(root, `device-${i + 1}`);
  const keyFile = join(dataDir, 'demo-master.key');
  mkdirSync(dataDir, { recursive: true });
  const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('base64'));
  const kernel = await Kernel.create({
    dataDir,
    platform: createNodePlatform({ dataDir, devMode: false, keychain: new StaticKeyKeychain(Buffer.from(readFileSync(keyFile, 'utf8'), 'base64'), 'env'), licensePublicKeys: [publicKeyPem] }),
  });
  kernel.settings.update({ localApi: { enabled: i === 0, port: 47821 }, runtime: { enabled: false } });
  await kernel.start();
  if (!kernel.fleet.enrolled && token) {
    await kernel.call('fleet.enroll', { serverUrl: base, token, deviceName: NAMES[i % NAMES.length] }, { origin: 'user', actor: 'demo' });
  }
  kernels.push(kernel);
}

console.log(`\nFBRX OS demo fleet is running.\n  Admin console: http://localhost:${port}\n  Sign in:       ${ADMIN.email} / ${ADMIN.password}\n  Devices:       ${deviceCount} headless cores (data in ${root})\n  Local API:     http://127.0.0.1:47821 (device 1)\n\nPress Ctrl+C to stop.`);

const stop = async () => {
  for (const k of kernels) await k.stop().catch(() => undefined);
  await server.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
