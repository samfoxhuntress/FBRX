import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bridgeInterfaces, hostPorts, outerHypervisor, portSetting } from '../src/host-bridge';
import { loadConfig } from '../src/config';
import { buildServer, type BuiltVirtual } from '../src/server';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// As the Debian installer writes it on a VMware machine.
const DEBIAN = `# This file describes the network interfaces available on your system
source /etc/network/interfaces.d/*

# The loopback network interface
auto lo
iface lo inet loopback

# The primary network interface
allow-hotplug ens192
iface ens192 inet dhcp
# This is an autoconfigured IPv6 interface
iface ens192 inet6 auto
`;

/** A fake /sys/class/net (and DMI) under `root`. */
function fakeSys(root: string, ports: Array<{ name: string; up?: boolean; physical?: boolean; master?: string; bridge?: boolean }>, vendor = 'VMware, Inc.') {
  for (const p of ports) {
    const d = join(root, 'sys/class/net', p.name);
    mkdirSync(d, { recursive: true });
    if (p.physical !== false) mkdirSync(join(d, 'device'));
    if (p.bridge) mkdirSync(join(d, 'bridge'));
    writeFileSync(join(d, 'address'), '00:50:56:aa:bb:cc\n');
    writeFileSync(join(d, 'operstate'), p.up === false ? 'down\n' : 'up\n');
    if (p.master) {
      mkdirSync(join(root, 'sys/class/net', p.master), { recursive: true });
      symlinkSync(join(root, 'sys/class/net', p.master), join(d, 'master'));
    }
  }
  mkdirSync(join(root, 'sys/class/dmi/id'), { recursive: true });
  writeFileSync(join(root, 'sys/class/dmi/id/sys_vendor'), `${vendor}\n`);
  writeFileSync(join(root, 'sys/class/dmi/id/product_name'), 'VMware Virtual Platform\n');
}

describe('a bridge on one of the server’s ports', () => {
  it('moves a DHCP port’s settings (IPv4 and IPv6) to br0 and brings the port up at boot', () => {
    const out = bridgeInterfaces(DEBIAN, 'ens192');
    expect(out).toContain('auto ens192\niface ens192 inet manual\n');
    expect(out).not.toMatch(/allow-hotplug ens192|iface ens192 inet dhcp|iface ens192 inet6/);
    expect(out).toContain('auto br0\niface br0 inet dhcp\n    bridge_ports ens192\n    bridge_stp off\n    bridge_fd 0\n');
    expect(out).toContain('iface br0 inet6 auto');
    // Everything else stays as it was.
    expect(out).toContain('auto lo\niface lo inet loopback');
    expect(out).toContain('source /etc/network/interfaces.d/*');
    expect(portSetting(out, 'br0').mode).toBe('dhcp');
  });

  it('moves a fixed address with its gateway and name servers', () => {
    const text = 'auto lo\niface lo inet loopback\n\nauto eno1\niface eno1 inet static\n    address 192.168.1.10/24\n    gateway 192.168.1.1\n    dns-nameservers 192.168.1.1\n\nauto eno2\niface eno2 inet dhcp\n';
    const out = bridgeInterfaces(text, 'eno1');
    expect(out).toContain('auto br0\niface br0 inet static\n    address 192.168.1.10/24\n    gateway 192.168.1.1\n    dns-nameservers 192.168.1.1\n    bridge_ports eno1\n');
    expect(out).toContain('auto eno1\niface eno1 inet manual\n\nauto eno2\niface eno2 inet dhcp');
  });

  it('bridges a spare card (not in the file) with no address for the server', () => {
    const out = bridgeInterfaces(DEBIAN, 'ens224');
    expect(out).toContain('auto ens224\niface ens224 inet manual\n');
    expect(out).toContain('iface br0 inet manual\n    bridge_ports ens224');
    expect(out).toContain('iface ens192 inet dhcp');
  });

  it('refuses what it cannot change safely', () => {
    expect(() => bridgeInterfaces(`${DEBIAN}\nauto br0\niface br0 inet dhcp\n    bridge_ports ens192\n`, 'ens224')).toThrow(/already set up/);
    expect(() => bridgeInterfaces(DEBIAN, 'ens256', 'iface ens256 inet dhcp\n')).toThrow(/interfaces\.d/);
    expect(() => bridgeInterfaces('iface eno1 inet ppp\n', 'eno1')).toThrow(/by hand/);
    expect(() => bridgeInterfaces(DEBIAN, 'ens192; rm -rf /')).toThrow(/not a network port/);
  });

  it('finds the server’s network cards and the hypervisor it runs on', () => {
    const root = mkdtempSync(join(tmpdir(), 'fbrx-sys-'));
    dirs.push(root);
    fakeSys(root, [{ name: 'ens192' }, { name: 'ens224', up: false }, { name: 'lo', physical: false }, { name: 'virbr0', physical: false, bridge: true }, { name: 'eno3', master: 'br9' }]);
    const ports = hostPorts(root, { ens192: [{ address: '192.168.1.50', family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '', cidr: null }] } as never);
    expect(ports.map((p) => [p.name, p.up, p.addresses, p.bridge])).toEqual([
      ['eno3', true, [], 'br9'],
      ['ens192', true, ['192.168.1.50'], null],
      ['ens224', false, [], null],
    ]);
    expect(outerHypervisor(root)).toBe('vmware');
    expect(outerHypervisor(join(root, 'nothing'))).toBeNull();
  });
});

describe('Networks → Bridge a port', () => {
  let dir: string;
  let s: BuiltVirtual;
  let admin = '';
  let operator = '';
  const req = async (method: string, url: string, token: string, payload?: unknown) => {
    const r = await s.app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${token}` }, payload: payload as never });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fbrx-bridge-'));
    const root = join(dir, 'root');
    fakeSys(root, [{ name: 'ens192' }, { name: 'ens224', up: false }]);
    mkdirSync(join(root, 'etc/network/interfaces.d'), { recursive: true });
    writeFileSync(join(root, 'etc/network/interfaces'), DEBIAN);
    const config = loadConfig({ FBRX_V_DATA_DIR: dir, FBRX_V_DRIVER: 'simulated', FBRX_V_TLS: 'off', FBRX_V_LOG_LEVEL: 'silent', FBRX_V_SYS_ROOT: root, FBRX_V_SERVER_STATE_DIR: join(dir, 'state'), FBRX_V_SERVER_CMD: join(dir, 'no-fbrx-server'), FBRX_V_ADMIN_USER: 'sam', FBRX_V_ADMIN_PASSWORD: 'correct horse battery', FBRX_V_CORE_TOKEN_FILE: join(dir, 'none.token') });
    s = await buildServer(config);
    const login = async (username: string, password: string) => (await s.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username, password } })).json().token as string;
    admin = await login('sam', 'correct horse battery');
    await req('POST', '/v1/users', admin, { username: 'olly', password: 'operator password', role: 'operator' });
    operator = await login('olly', 'operator password');
  });
  afterAll(async () => {
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists the ports, says the server is a VMware machine, writes the bridge, and waits for a restart', async () => {
    expect((await req('GET', '/v1/networks/host-bridge', operator)).status).toBe(403);
    const st = (await req('GET', '/v1/networks/host-bridge', admin)).body;
    expect(st).toMatchObject({ canMake: true, why: null, outer: 'vmware', pending: null, canRestart: false });
    expect(st.ports.map((p: { name: string; mode: string; usable: boolean }) => [p.name, p.mode, p.usable])).toEqual([
      ['ens192', 'dhcp', true],
      ['ens224', 'none', true],
    ]);
    expect((await req('POST', '/v1/networks/host-bridge', operator, { port: 'ens192' })).status).toBe(403);
    expect((await req('POST', '/v1/networks/host-bridge', admin, { port: 'eth9' })).status).toBe(400);
    const made = (await req('POST', '/v1/networks/host-bridge', admin, { port: 'ens192' })).body;
    expect(made).toMatchObject({ canMake: false, pending: { port: 'ens192' }, why: expect.stringContaining('restart the server') });
    const file = join(dir, 'root/etc/network/interfaces');
    expect(readFileSync(file, 'utf8')).toContain('iface br0 inet dhcp\n    bridge_ports ens192');
    expect(readFileSync(`${file}.fbrx-backup`, 'utf8')).toBe(DEBIAN);
    // Not twice.
    expect((await req('POST', '/v1/networks/host-bridge', admin, { port: 'ens224' })).status).toBe(409);
    // Restarting from the console is FBRX Server's alone (not this test's computer).
    expect((await req('POST', '/v1/server/restart', operator)).status).toBe(403);
    expect((await req('POST', '/v1/server/restart', admin)).status).toBe(409);
    // After the restart br0 is there: nothing is pending any more.
    mkdirSync(join(dir, 'root/sys/class/net/br0/bridge'), { recursive: true });
    expect((await req('GET', '/v1/networks/host-bridge', admin)).body).toMatchObject({ pending: null, canMake: false, why: expect.stringContaining('already set up') });
  });
});
