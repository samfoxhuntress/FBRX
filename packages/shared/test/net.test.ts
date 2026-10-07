import { describe, expect, it } from 'vitest';
import { cidrsOverlap, hostRange, inCidr, isCidr, isIPv4, isIPv6, meshQosNftables, meshQosWindows, networkOf, parseCidr, preferAddresses, prefixToMask } from '../src/net';

describe('address arithmetic', () => {
  it('parses IPv4 and IPv6', () => {
    expect(isIPv4('192.168.1.1')).toBe(true);
    expect(isIPv4('192.168.1.256')).toBe(false);
    expect(isIPv4('01.2.3.4')).toBe(false);
    expect(isIPv6('fd00::1')).toBe(true);
    expect(isIPv6('::ffff:192.0.2.1')).toBe(true);
    expect(isIPv6('fd00:::1')).toBe(false);
    expect(isIPv6('1:2:3:4:5:6:7:8:9')).toBe(false);
    expect(isCidr('10.20.0.0/24')).toBe(true);
    expect(isCidr('10.20.0.0/33')).toBe(false);
    expect(parseCidr('10.20.0.1/24')).toMatchObject({ family: 4, prefix: 24, address: '10.20.0.1' });
  });

  it('answers membership, overlap and ranges', () => {
    expect(inCidr('10.20.0.7', '10.20.0.0/24')).toBe(true);
    expect(inCidr('10.20.1.7', '10.20.0.0/24')).toBe(false);
    expect(inCidr('fd00:20::5', 'fd00:20::/64')).toBe(true);
    expect(inCidr('10.20.0.7', 'fd00::/8')).toBe(false);
    expect(cidrsOverlap('10.0.0.0/8', '10.20.0.0/24')).toBe(true);
    expect(cidrsOverlap('192.168.1.0/24', '192.168.2.0/24')).toBe(false);
    expect(networkOf('192.168.1.1/24')).toBe('192.168.1.0/24');
    expect(networkOf('fd00:20:0:0:0:0:0:1/64')).toBe('fd00:20::/64');
    expect(hostRange('192.168.1.0/24')).toEqual({ first: '192.168.1.1', last: '192.168.1.254', size: 254 });
    expect(hostRange('10.0.0.0/31')).toEqual({ first: '10.0.0.0', last: '10.0.0.1', size: 2 });
    expect(prefixToMask(20)).toBe('255.255.240.0');
  });
});

describe('Prefer Mesh', () => {
  it('puts addresses in the preferred mesh networks first', () => {
    expect(preferAddresses(['192.168.1.20', '10.20.0.5', '172.16.0.9'], ['10.20.0.0/24'])).toEqual(['10.20.0.5', '192.168.1.20', '172.16.0.9']);
    expect(preferAddresses(['192.168.1.20', '10.20.0.5'], [])).toEqual(['192.168.1.20', '10.20.0.5']);
    expect(preferAddresses(['10.30.0.5', '10.20.0.5'], ['10.20.0.0/24', '10.30.0.0/24'])).toEqual(['10.20.0.5', '10.30.0.5']);
  });

  it('writes the traffic marking for Linux and Windows', () => {
    const nft = meshQosNftables(47800, 'af41');
    expect(nft).toContain('tcp dport 47800 ip dscp set af41');
    expect(nft).toContain('tcp sport 47800 ip6 dscp set af41');
    expect(nft.indexOf('delete table inet fbrx_mesh')).toBeLessThan(nft.indexOf('table inet fbrx_mesh {'));
    const ps = meshQosWindows(47800, 'ef');
    expect(ps).toContain('-IPDstPortMatchCondition 47800 -DSCPAction 46');
    expect(ps).toContain("'Do not use NLA'");
  });
});
