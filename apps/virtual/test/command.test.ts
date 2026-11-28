import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerCommandStatus } from '@fbrx/shared';
import { loadConfig } from '../src/config';
import { buildServer, gateStarter, type BuiltVirtual } from '../src/server';
import { commandRule, gateLetsIn } from '../src/routes/command';
import { SimulatedHypervisor } from '../src/drivers/simulated';
import { buildServer as buildCommand, type BuiltServer } from '../../control-plane/src/server';
import { loadConfig as loadCommandConfig } from '../../control-plane/src/config';
import { makeKernel, waitFor } from '../../../packages/core/test/helpers';
import type { Kernel } from '../../../packages/core/src/kernel';

// FBRX Command as a role of FBRX Server: a real FBRX Command with its own certificate, the server's own FBRX core
// (the ai role) joining it, and the server console showing both, as on a server installed with --roles …,command.
let dir: string;
let s: BuiltVirtual;
let command: BuiltServer;
let commandUrl: string;
let commandLocal: string;
let kernel: Kernel;
let cleanupKernel: () => Promise<void>;
let admin = '';
let viewer = '';
const SETUP = 'setup-token-123';
const PASSWORD = 'Super-Secret-Admin-Pass-1';

const req = async (method: string, url: string, token: string, payload?: unknown) => {
  const r = await s.app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${token}` }, payload: payload as never });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
const status = async (token = viewer) => (await req('GET', '/v1/server/command', token)).body as ServerCommandStatus;
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const p = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(p));
    });
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fbrx-virtual-command-'));
  // FBRX Command with the settings the installer gives it: its own certificate, and a local-only console port.
  command = await buildCommand(loadCommandConfig({}, { dataDir: join(dir, 'command'), port: 0, host: '127.0.0.1', logLevel: 'silent', setupToken: SETUP, adminConsoleDir: null, heartbeatSeconds: 10, tls: { mode: 'self-signed', names: [] } }));
  await command.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (command.app.server.address() as AddressInfo).port;
  commandUrl = `https://127.0.0.1:${port}`;
  command.ctx.config.publicUrl = commandUrl;
  commandLocal = `http://127.0.0.1:${await command.listenLocal(0)}`;
  writeFileSync(join(dir, 'fbrx-command.env'), `FBRX_CP_PORT=${port}\nFBRX_CP_PUBLIC_URL=${commandUrl}\n`);
  writeFileSync(join(dir, 'secrets.env'), `FBRX_CP_SETUP_TOKEN=${SETUP}\n`, { mode: 0o600 });

  // The server's own FBRX core (the ai role), reached with the console token.
  const corePort = await freePort();
  ({ kernel, cleanup: cleanupKernel } = await makeKernel({ localApiPort: corePort }));
  kernel.localApi.setConsoleToken('fbrx_console_one');
  writeFileSync(join(dir, 'console.token'), 'fbrx_console_one\n', { mode: 0o600 });

  const config = loadConfig({
    FBRX_V_DATA_DIR: join(dir, 'virtual'),
    FBRX_V_ROLES: 'virtual,ai,command',
    FBRX_V_DRIVER: 'simulated',
    FBRX_V_TLS: 'off',
    FBRX_V_LOG_LEVEL: 'silent',
    FBRX_V_SYS_ROOT: join(dir, 'no-sysfs'),
    FBRX_V_ADMIN_USER: 'sam',
    FBRX_V_ADMIN_PASSWORD: 'correct horse battery',
    FBRX_V_CORE_URL: `http://127.0.0.1:${corePort}`,
    FBRX_V_CORE_TOKEN_FILE: join(dir, 'console.token'),
    FBRX_V_COMMAND_ENV: join(dir, 'fbrx-command.env'),
    FBRX_V_COMMAND_SECRETS: join(dir, 'secrets.env'),
    // Where FBRX Command keeps the certificate it made for itself (/var/lib/fbrx-command/tls on the server).
    FBRX_V_COMMAND_CERT: join(dir, 'command', 'tls', 'command.crt'),
    FBRX_V_COMMAND_URL: commandLocal,
  });
  s = await buildServer(config, { hypervisor: new SimulatedHypervisor({ dataDir: join(dir, 'virtual'), isosDir: config.isosDir, seed: false }) });
  const login = async (username: string, password: string) => (await s.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username, password } })).json().token as string;
  admin = await login('sam', 'correct horse battery');
  await req('POST', '/v1/users', admin, { username: 'vic', password: 'viewer password', role: 'viewer' });
  viewer = await login('vic', 'viewer password');
}, 60_000);

afterAll(async () => {
  await s?.close();
  await cleanupKernel?.();
  await command?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('FBRX Command as a role of FBRX Server', () => {
  it('shows where FBRX Command is, its certificate, and its setup token to administrators until it is set up', async () => {
    const seen = await status();
    expect(seen).toMatchObject({ enabled: true, running: true, needsSetup: true, url: commandUrl, fingerprint: command.ctx.tls!.fingerprint, setupToken: null, error: null, gateOpen: null, joined: null, canJoin: true });
    expect((await status(admin)).setupToken).toBe(SETUP);

    const setup = await fetch(`${commandLocal}/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupToken: SETUP, organization: 'Rivera Dental', kind: 'business', name: 'Alex', email: 'alex@rivera.example', password: PASSWORD }) });
    expect(setup.status).toBe(200);
    expect(await status(admin)).toMatchObject({ needsSetup: false, setupToken: null });
  });

  it('joins this server to it with an enrollment token, trusting its own certificate, and leaves again', async () => {
    const login = (await (await fetch(`${commandLocal}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'alex@rivera.example', password: PASSWORD }) })).json()) as { token: string; user: { tenantId: string | null } };
    const tenantId = ((await (await fetch(`${commandLocal}/v1/admin/tenants`, { headers: { authorization: `Bearer ${login.token}` } })).json()) as Array<{ id: string }>)[0]!.id;
    const headers = { authorization: `Bearer ${login.token}`, 'x-fbrx-tenant': tenantId, 'content-type': 'application/json' };
    const { token } = (await (await fetch(`${commandLocal}/v1/admin/enrollment-tokens`, { method: 'POST', headers, body: JSON.stringify({ label: 'Servers' }) })).json()) as { token: string };

    expect((await req('POST', '/v1/server/command/join', viewer, { token })).status).toBe(403);
    const joined = await req('POST', '/v1/server/command/join', admin, { token });
    expect(joined.status).toBe(200);
    expect(joined.body).toMatchObject({ serverUrl: commandUrl, serverFingerprint: command.ctx.tls!.fingerprint, tenantName: 'Rivera Dental' });
    await waitFor(() => kernel.fleet.status().state === 'online', 15_000);
    expect((await status()).joined).toMatchObject({ server: commandUrl, organization: 'Rivera Dental', state: 'online' });
    const devices = (await (await fetch(`${commandLocal}/v1/admin/devices`, { headers })).json()) as Array<{ online: boolean }>;
    expect(devices).toHaveLength(1);
    const audit = (await req('GET', '/v1/audit', admin)).body.entries.find((e: { action: string }) => e.action === 'command.join');
    expect(audit).toMatchObject({ outcome: 'success', target: commandUrl });

    expect((await req('POST', '/v1/server/command/leave', admin)).status).toBe(200);
    expect((await status()).joined).toBeNull();
  }, 60_000);

  it('opens FBRX Command to your network on a new gate, and knows when a gate lets it in', () => {
    const config = loadConfig({ FBRX_V_ROLES: 'gate,command', FBRX_V_GATE_WAN: 'eno1', FBRX_V_GATE_LAN: 'eno2', FBRX_V_COMMAND_ENV: join(dir, 'fbrx-command.env'), FBRX_V_DATA_DIR: join(dir, 'gate') });
    const port = Number(new URL(commandUrl).port);
    const c = gateStarter(config, {});
    expect(c.firewall.rules).toContainEqual(commandRule(port));
    expect(gateLetsIn(c, port)).toBe(true);
    // Without it, or from the internet side only, it does not.
    const closed = gateStarter(loadConfig({ FBRX_V_ROLES: 'gate', FBRX_V_GATE_WAN: 'eno1', FBRX_V_GATE_LAN: 'eno2', FBRX_V_DATA_DIR: join(dir, 'gate') }), {});
    expect(gateLetsIn(closed, port)).toBe(false);
    closed.firewall.rules.push({ ...commandRule(port), id: 'from-wan', from: 'wan' });
    expect(gateLetsIn(closed, port)).toBe(false);
    closed.firewall.rules.push({ ...commandRule(port), id: 'range', ports: '22, 8000-9000' });
    expect(gateLetsIn(closed, 8787)).toBe(true);
  });
});
