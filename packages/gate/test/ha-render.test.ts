import { describe, expect, it } from 'vitest';
import { GateConfigSchema, haMac, haProblem, render, starterConfig, type GateHa } from '../src/index';

const paths = { varDir: '/var/lib/fbrx-gate', logDir: '/var/log/fbrx-gate', etcDir: '/etc/fbrx-gate' };
const config = () => GateConfigSchema.parse(starterConfig({ hostname: 'office-gate', wan: 'eno1', lan: 'eno2', lanAddress: '192.168.50.1/24' }));
const ha: GateHa = { own: { lan: '192.168.50.2/24' }, vrid: 7, heartbeatPort: 9454, link: null, partner: ['192.168.50.3'], sync: { iface: 'eno2', own: '192.168.50.2', partner: '192.168.50.3' } };

describe('FBRX Gate in a high-availability pair: what it renders', () => {
  it('needs an address of its own in each network', () => {
    expect(haProblem(config(), { ...ha, own: {} })).toMatch(/address of its own in lan/);
    expect(haProblem(config(), { ...ha, own: { lan: '10.0.0.2/24' } })).toMatch(/is not in lan/);
    expect(haProblem(config(), { ...ha, own: { lan: '192.168.50.1/24' } })).toMatch(/gateway address, which moves/);
    expect(haProblem(config(), ha)).toBeNull();
  });

  it('puts the gateway address on a link of its own with a virtual MAC, switched on by hand, and the internet port too', () => {
    const r = render(config(), paths, ha);
    const file = (name: string) => r.networkd.find((f) => f.name === name)!.content;
    expect(file('10-fbrx-eno2.network')).toContain('Address=192.168.50.2/24');
    expect(file('10-fbrx-eno2.network')).toContain('MACVLAN=fbrxv0');
    expect(file('10-fbrx-eno2.network')).not.toContain('192.168.50.1');
    expect(file('10-fbrx-fbrxv0.netdev')).toContain(`MACAddress=${haMac(7, 1)}`);
    expect(file('10-fbrx-fbrxv0.network')).toMatch(/ActivationPolicy=manual[\s\S]*Address=192\.168\.50\.1\/24/);
    expect(file('10-fbrx-eno1.network')).toMatch(new RegExp(`MACAddress=${haMac(7, 0)}\\nActivationPolicy=manual`));
    expect(r.sysctl).toEqual(expect.arrayContaining([['net.ipv4.conf.all.arp_ignore', '1']]));
    // DHCP answers on the gateway link; the firewall counts it as the network.
    expect(r.dnsmasq).toContain('interface=fbrxv0');
    expect(r.dnsmasq).not.toContain('interface=eno2');
    expect(r.nftables).toContain('iifname { "eno2", "fbrxv0" } oifname "eno1" accept comment "internet:lan"');
    expect(r.nftables).toContain('udp dport 9454 accept comment "ha:heartbeat"');
    expect(r.nftables).toContain('ip saddr 192.168.50.3 udp dport 3780 accept comment "ha:connections"');
    // The open connections go to the partner; the gate's own addresses stay out of it.
    expect(r.conntrackd).toMatch(/IPv4_address 192\.168\.50\.2\n\s+IPv4_Destination_Address 192\.168\.50\.3/);
    expect(r.conntrackd).toMatch(/Address Ignore \{[\s\S]*IPv4_address 192\.168\.50\.1[\s\S]*\}/);
  });

  it('renders as before when the server is not paired', () => {
    const r = render(config(), paths);
    expect(r.networkd.some((f) => f.name.includes('fbrxv'))).toBe(false);
    expect(r.dnsmasq).toContain('interface=eno2');
    expect(r.conntrackd).toBeNull();
    expect(r.sysctl).toEqual([['net.ipv4.ip_forward', '1']]);
  });
});
