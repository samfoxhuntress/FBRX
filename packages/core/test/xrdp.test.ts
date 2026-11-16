import { describe, expect, it } from 'vitest';
import { localNetworks, setXrdp, xrdpPort, xrdpScript, xrdpStatus, type XrdpDeps } from '../src/system/xrdp';

/** Remote desktop on Linux (xrdp): what it reads, the script it runs as root, and what it says when that fails. */

const ifs = {
  eth0: [{ address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:01', internal: false, cidr: '192.168.1.20/24' }],
  wg0: [{ address: '10.8.3.7', netmask: '255.255.0.0', family: 'IPv4', mac: '00:00:00:00:00:02', internal: false, cidr: '10.8.3.7/16' }],
  pub: [{ address: '203.0.113.9', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:03', internal: false, cidr: '203.0.113.9/24' }],
  lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }],
} as never;

const server = (o: Partial<XrdpDeps> & { installed?: boolean; active?: string } = {}): XrdpDeps => ({
  platform: 'linux',
  root: true,
  exists: (p) => !!o.installed && p === '/usr/sbin/xrdp',
  read: () => '[Globals]\nport=3389\n',
  sessions: () => [],
  which: async (c) => c === 'apt-get' || c === 'pkexec',
  systemctl: async (a) => (a[0] === 'is-active' ? (o.active ?? 'inactive') : 'enabled'),
  interfaces: () => ifs,
  ...o,
});

describe('remote desktop (xrdp)', () => {
  it('reads the port and the local networks (private addresses only)', () => {
    expect(xrdpPort('port=3390')).toBe(3390);
    expect(xrdpPort('[Globals]\nport=tcp://:3391\n')).toBe(3391);
    expect(xrdpPort(null)).toBe(3389);
    expect(localNetworks(ifs)).toEqual({ addresses: ['192.168.1.20', '10.8.3.7'], networks: ['192.168.1.0/24', '10.8.0.0/16'] });
  });

  it('says what it is on Windows and a Mac, and what a server has', async () => {
    expect((await xrdpStatus({ platform: 'win32' })).why).toMatch(/Remote Desktop/);
    expect((await xrdpStatus({ platform: 'darwin' })).supported).toBe(false);
    const s = await xrdpStatus(server({ installed: true, active: 'active' }));
    expect(s).toMatchObject({ supported: true, installed: true, running: true, enabled: true, port: 3389, desktops: [], addresses: ['192.168.1.20', '10.8.3.7'], manager: 'apt', canSetUp: true, why: null });
    const none = await xrdpStatus(server({ which: async () => false }));
    expect(none.canSetUp).toBe(false);
    expect(none.why).toMatch(/apt, dnf or zypper/);
  });

  it('writes a script that installs it, a desktop where there is none, and opens it to the local networks only', () => {
    const s = xrdpScript({ on: true, manager: 'apt', desktop: true, networks: ['192.168.1.0/24', '1.2.3.4/8; rm -rf /', '10.8.0.0/16'] });
    expect(s).toContain('apt-get install -y -q xrdp xorgxrdp');
    expect(s).toContain('xfce4');
    expect(s).toContain('systemctl enable --now xrdp');
    expect(s).toContain('ufw allow from 192.168.1.0/24 to any port 3389 proto tcp');
    expect(s).toContain('source address="10.8.0.0/16"');
    expect(s).not.toContain('rm -rf');
    expect(xrdpScript({ on: true, manager: 'dnf', desktop: false, networks: [] })).not.toContain('xfce');
    const off = xrdpScript({ on: false, manager: 'apt', desktop: false, networks: ['192.168.1.0/24'] });
    expect(off).toContain('systemctl disable --now xrdp');
    expect(off).toContain('ufw delete allow from 192.168.1.0/24');
    expect(off).not.toContain('apt-get');
  });

  it('runs it as root, and says where it stopped or that the prompt was closed', async () => {
    let ran = '';
    const ok = await setXrdp(true, { deps: server(), exec: async (script) => ((ran = script), { code: 0, out: 'FBRX-STEP install\nFBRX-STEP done', err: '' }) });
    expect(ran).toContain('xfce4');
    expect(ok.supported).toBe(true);
    await expect(setXrdp(true, { root: false, deps: server({ root: false }), exec: async () => ({ code: 126, out: '', err: '' }) })).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(setXrdp(true, { deps: server(), exec: async () => ({ code: 100, out: 'FBRX-STEP install\n', err: 'E: Unable to locate package xorgxrdp' }) })).rejects.toThrow(/install step: E: Unable to locate package xorgxrdp/);
    // Turning off what was never set up changes nothing.
    let called = false;
    await setXrdp(false, { deps: server(), exec: async () => ((called = true), { code: 0, out: '', err: '' }) });
    expect(called).toBe(false);
  });
});
