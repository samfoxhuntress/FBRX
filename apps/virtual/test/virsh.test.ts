import { describe, expect, it } from 'vitest';
import { firstColumn, parseBlkinfo, parseDomstats, parseIfaddr, parseInfo, stateFromWords, stateName, virshError } from '../src/drivers/virsh';
import { planSubnet } from '../src/drivers/libvirt';

describe('virsh output', () => {
  it('parses domstats, blkinfo, ifaddr, info and tables', () => {
    const stats = parseDomstats("Domain: 'a'\n  state.state=1\n  cpu.time=629708000\n  balloon.rss=56552\n\nDomain: 'b c'\n  state.state=5\n");
    expect(stats.get('a')).toEqual({ 'state.state': '1', 'cpu.time': '629708000', 'balloon.rss': '56552' });
    expect(stats.get('b c')).toEqual({ 'state.state': '5' });
    const blk = parseBlkinfo(' Target   Capacity     Allocation   Physical\n----------------------------------------------\n vda      1073741824   200704       196624\n sda      -            -            -\n');
    expect(blk.get('vda')).toEqual({ capacity: 1073741824, allocation: 200704 });
    expect(blk.get('sda')).toEqual({ capacity: null, allocation: null });
    const ips = parseIfaddr(' Name       MAC address          Protocol     Address\n-------------------------------------------------------------------------------\n vnet0      52:54:00:AB:cd:ef    ipv6         fe80::1/64\n vnet0      52:54:00:ab:cd:ef    ipv4         192.168.122.45/24\n');
    expect(ips.get('52:54:00:ab:cd:ef')).toBe('192.168.122.45');
    expect(parseInfo('Name:           default\nActive:         yes\nBridge:         virbr0\n')).toEqual({ name: 'default', active: 'yes', bridge: 'virbr0' });
    expect(firstColumn(' Name      Path\n----------------------------------------------\n a.qcow2   /x/a.qcow2\n b.iso     /x/b.iso\n')).toEqual(['a.qcow2', 'b.iso']);
  });

  it('maps states', () => {
    expect([1, 3, 4, 5, 6, 7, 0].map(stateName)).toEqual(['running', 'paused', 'shutting-down', 'stopped', 'crashed', 'suspended', 'unknown']);
    expect(stateFromWords('shut off')).toBe('stopped');
    expect(stateFromWords('running')).toBe('running');
  });

  it('turns virsh errors into fitting statuses', () => {
    expect(virshError("error: failed to get domain 'x'\nerror: Domain not found: no domain with matching name 'x'").status).toBe(404);
    const busy = virshError('error: Failed to start domain \'a\'\nerror: Requested operation is not valid: domain is already running');
    expect(busy.status).toBe(409);
    expect(busy.message).toBe('Requested operation is not valid: domain is already running');
    expect(virshError('error: failed to connect to the hypervisor\nerror: Failed to connect socket to \'/var/run/libvirt/virtqemud-sock\': No such file or directory').status).toBe(503);
  });

  it('plans private subnets only', () => {
    expect(planSubnet('192.168.50.0/24')).toEqual({ address: '192.168.50.1', prefix: 24, dhcpStart: '192.168.50.100', dhcpEnd: '192.168.50.254' });
    expect(planSubnet('10.20.30.77/28')).toEqual({ address: '10.20.30.65', prefix: 28, dhcpStart: '10.20.30.66', dhcpEnd: '10.20.30.78' });
    expect(() => planSubnet('8.8.8.0/24')).toThrow(/private/);
    expect(() => planSubnet('192.168.0.0/8')).toThrow(/16/);
    expect(() => planSubnet('nope')).toThrow();
  });
});
