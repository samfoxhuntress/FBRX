import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkConfig, dhcpRange, pickLanAddress, renumberNetwork, starterConfig } from '../src/index';
import { LinuxApplier, type Runner } from '../src/node/index';

describe('a new gate behind a router', () => {
  it('keeps your network clear of the addresses the internet side uses', () => {
    expect(pickLanAddress([])).toBe('192.168.1.1/24');
    // A home router handing out 192.168.1.x: the gate's own network goes elsewhere.
    expect(pickLanAddress(['192.168.1.20/24'])).toBe('192.168.10.1/24');
    expect(pickLanAddress(['192.168.1.20/24', '192.168.10.0/24'])).toBe('192.168.50.1/24');
    expect(pickLanAddress(['192.168.0.0/16'])).toBe('10.10.0.1/24');
    expect(pickLanAddress(['192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12'])).toBe('10.250.0.1/24');
    // A single address counts as itself.
    expect(pickLanAddress(['192.168.1.7'])).toBe('192.168.10.1/24');

    const c = starterConfig({ wan: 'eno1', lan: 'eno2', avoid: ['192.168.1.20/24'] });
    expect(c.networks[0]).toMatchObject({ address: '192.168.10.1/24', dhcp: { start: '192.168.10.100', end: '192.168.10.199' } });
    expect(c.wan.mode).toBe('dhcp');
    expect(checkConfig(c).ok).toBe(true);
  });

  it('starts with a fixed internet address when the port had one', () => {
    const c = starterConfig({ wan: 'eno1', lan: 'eno2', wanStatic: { address: '192.168.1.20/24', gateway: '192.168.1.1' } });
    expect(c.wan).toEqual({ interface: 'eno1', mode: 'static', address: '192.168.1.20/24', gateway: '192.168.1.1', ping: false });
    expect(c.networks[0].address).toBe('192.168.10.1/24');
    expect(checkConfig(c).ok).toBe(true);
    // An explicit choice wins, and a clash with the internet side is refused at the check.
    const clash = starterConfig({ wan: 'eno1', lan: 'eno2', lanAddress: '192.168.1.1/24', wanStatic: { address: '192.168.1.20/24', gateway: '192.168.1.1' } });
    expect(checkConfig(clash).errors.map((e) => e.path)).toContain('networks.lan.address');
  });

  it('hands out the usual range in any size of network', () => {
    expect(dhcpRange('192.168.50.1/24')).toEqual({ start: '192.168.50.100', end: '192.168.50.199' });
    expect(dhcpRange('10.0.0.1/16')).toEqual({ start: '10.0.64.0', end: '10.0.255.253' });
    expect(dhcpRange('10.0.0.1/28')).toEqual({ start: '10.0.0.4', end: '10.0.0.13' });
    expect(dhcpRange('10.0.0.1/31')).toEqual({ start: '', end: '' });
  });

  it('moves a network and everything pointing inside it', () => {
    const c = starterConfig({ wan: 'eno1', lan: 'eno2', lanAddress: '192.168.1.1/24' });
    c.networks[0].dhcp.reservations.push({ mac: 'aa:bb:cc:dd:ee:ff', address: '192.168.1.20', name: 'nas' });
    c.firewall.forwards.push({ id: 'web', name: 'Web', enabled: true, proto: 'tcp', port: '443', to: '192.168.1.20' });
    c.firewall.rules.push({ id: 'cam', name: 'Camera', enabled: true, from: 'lan', to: 'wan', proto: 'any', source: '192.168.1.30/32', action: 'drop', log: false });
    c.firewall.rules.push({ id: 'all', name: 'Whole net', enabled: true, from: 'lan', to: 'wan', proto: 'any', source: '192.168.0.0/16', action: 'accept', log: false });
    c.dns.records.push({ name: 'nas', address: '192.168.1.20' }, { name: 'outside', address: '8.8.8.8' });

    const m = renumberNetwork(c, 'lan', '192.168.50.1/24');
    expect(m.networks[0]).toMatchObject({ address: '192.168.50.1/24', dhcp: { start: '192.168.50.100', end: '192.168.50.199', reservations: [{ address: '192.168.50.20' }] } });
    expect(m.firewall.forwards[0].to).toBe('192.168.50.20');
    expect(m.firewall.rules[0].source).toBe('192.168.50.30/32');
    // A rule about a bigger network than this one stays as it was.
    expect(m.firewall.rules[1].source).toBe('192.168.0.0/16');
    expect(m.dns.records.map((r) => r.address)).toEqual(['192.168.50.20', '8.8.8.8']);
    expect(checkConfig(m).ok).toBe(true);
    // The original is left alone.
    expect(c.networks[0].address).toBe('192.168.1.1/24');

    expect(() => renumberNetwork(c, 'guest', '10.0.0.1/24')).toThrow(/no network guest/);
    expect(() => renumberNetwork(c, 'lan', '10.0.0.1/16')).toThrow(/same size/);
  });
});

describe('the gate’s live view on a server', () => {
  const live = async (o: { wanAddr: string; services?: Record<string, boolean>; interfaces?: string }) => {
    const root = mkdtempSync(join(tmpdir(), 'fbrx-gate-live-'));
    try {
      if (o.interfaces) {
        mkdirSync(join(root, 'etc/network'), { recursive: true });
        writeFileSync(join(root, 'etc/network/interfaces'), o.interfaces);
      }
      const ok = (out = '') => ({ code: 0, out, err: '' });
      const run: Runner = async (cmd, args) => {
        const a = args.join(' ');
        if (cmd === 'ip' && a === '-j -s link show') return ok(JSON.stringify([{ ifname: 'eno1', flags: ['UP'], mtu: 1500 }, { ifname: 'eno2', flags: ['UP'], mtu: 1500 }]));
        if (cmd === 'ip' && a === '-j addr show') {
          const [local, prefixlen] = o.wanAddr.split('/');
          return ok(JSON.stringify([{ ifname: 'eno1', addr_info: [{ family: 'inet', local, prefixlen: Number(prefixlen) }] }, { ifname: 'eno2', addr_info: [{ family: 'inet', local: '192.168.1.1', prefixlen: 24 }] }]));
        }
        if (cmd === 'ip' && a === '-j route show default') return ok(JSON.stringify([{ gateway: '192.168.1.254', dev: 'eno1' }]));
        if (cmd === 'nft') return ok(JSON.stringify({ nftables: [] }));
        if (cmd === 'pgrep') return { code: o.services?.dnsmasq === false ? 1 : 0, out: '', err: '' };
        if (cmd === 'systemctl' && args[0] === 'is-active') return { code: o.services?.[args[2]] === false ? 3 : 0, out: '', err: '' };
        return { code: 1, out: '', err: '' };
      };
      const applier = new LinuxApplier({ paths: { varDir: root, logDir: root, etcDir: root }, mode: 'networkd', root, run });
      return await applier.live(starterConfig({ wan: 'eno1', lan: 'eno2', lanAddress: '192.168.1.1/24' }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it('says so when the router in front hands out the same addresses as your network, with a free one to move to', async () => {
    const l = await live({ wanAddr: '192.168.1.37/24' });
    const p = l.problems.find((x) => x.includes('inside your network lan'));
    expect(p).toContain('192.168.1.37');
    expect(p).toContain('sudo fbrx-gate renumber lan 192.168.10.1/24');
    expect((await live({ wanAddr: '203.0.113.9/24' })).problems.some((x) => x.includes('inside your network'))).toBe(false);
  });

  it('names the services that are off, and system settings that fight over the gate’s ports', async () => {
    const l = await live({
      wanAddr: '203.0.113.9/24',
      services: { dnsmasq: false, 'systemd-networkd': false },
      interfaces: 'auto lo\niface lo inet loopback\n\nallow-hotplug eno1\niface eno1 inet dhcp\n# FBRX Gate runs this port: iface eno2 inet dhcp\n',
    });
    expect(l.problems.join('\n')).toMatch(/dnsmasq\) are not running: sudo systemctl enable --now dnsmasq/);
    expect(l.problems.join('\n')).toMatch(/systemd-networkd is not running/);
    expect(l.problems.filter((x) => x.includes('/etc/network/interfaces'))).toEqual([expect.stringContaining('sets up eno1')]);
  });
});
