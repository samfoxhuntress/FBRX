import { describe, expect, it } from 'vitest';
import { addPath, deletePath, getPath, parseValue, setPath, starterConfig } from '../src/index';

describe('command-line paths', () => {
  const c = starterConfig({ wan: 'eno1', lan: 'eno2.30' });
  it('finds list items by name, even with dots in them', () => {
    expect(getPath(c, ['networks', 'lan', 'dhcp', 'end'])).toBe('192.168.1.199');
    expect(getPath(c, ['interfaces', 'eno2.30', 'mtu'])).toBe(1500);
    expect(getPath(c, ['interfaces', '0', 'name'])).toBe('eno1');
    expect(getPath(c, ['networks', 'nope'])).toBeUndefined();
  });
  it('reads values as what the setting holds', () => {
    expect(parseValue('9000', 1500)).toBe(9000);
    expect(parseValue('on', false)).toBe(true);
    expect(parseValue('1.1.1.1,9.9.9.9', [])).toEqual(['1.1.1.1', '9.9.9.9']);
    expect(parseValue('internet', 'full')).toBe('internet');
    expect(() => parseValue('fast', 1500)).toThrow(/not a number/);
  });
  it('sets, adds and deletes without touching the original', () => {
    const a = setPath(c, ['interfaces', 'eno2.30', 'mtu'], 9000);
    expect(getPath(a, ['interfaces', 'eno2.30', 'mtu'])).toBe(9000);
    expect(getPath(c, ['interfaces', 'eno2.30', 'mtu'])).toBe(1500);
    const b = addPath(a, ['dns', 'records'], { name: 'nas', address: '192.168.1.20' });
    expect(getPath(b, ['dns', 'records', 'nas', 'address'])).toBe('192.168.1.20');
    expect(getPath(deletePath(b, ['dns', 'records', 'nas']), ['dns', 'records'])).toEqual([]);
    expect(() => setPath(c, ['networks', 'guest', 'access'], 'internet')).toThrow(/no networks guest/);
  });
});
