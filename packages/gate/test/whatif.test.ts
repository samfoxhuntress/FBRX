import { describe, expect, it } from 'vitest';
import { decide, decideConnection, starterConfig, whatIf, type GateConfig } from '../src/index';

/** A gate with a lan (full access, may manage the gate) and a guest network (internet only). */
function home(): GateConfig {
  const c = starterConfig({ wan: 'eno1', lan: 'eno2', lanAddress: '192.168.1.1/24' });
  c.interfaces.push({ name: 'eno2.20', kind: 'vlan', parent: 'eno2', vlanId: 20, mtu: 1500, description: 'Guests' });
  c.networks.push({ ...structuredClone(c.networks[0]), name: 'guest', purpose: 'guest', interface: 'eno2.20', address: '192.168.20.1/24', access: 'internet', manage: false, dhcp: { enabled: true, start: '192.168.20.100', end: '192.168.20.199', leaseHours: 4, reservations: [] }, description: 'Guests' });
  c.firewall.forwards.push({ id: 'web', name: 'Web server', enabled: true, proto: 'tcp', port: '443', to: '192.168.1.10' });
  return c;
}

describe('What If', () => {
  it('works the firewall out the way it is written', () => {
    const c = home();
    expect(decide(c, { from: 'lan', to: 'wan', proto: 'tcp', port: 443 })).toEqual({ verdict: 'allowed', because: 'lan has the internet' });
    expect(decide(c, { from: 'guest', to: 'lan', proto: 'tcp', port: 445 }).verdict).toBe('blocked');
    expect(decide(c, { from: 'lan', to: 'guest', proto: 'tcp', port: 443 })).toEqual({ verdict: 'allowed', because: 'lan has full access' });
    expect(decide(c, { from: 'lan', to: 'gate', proto: 'tcp', port: 9443 })).toEqual({ verdict: 'allowed', because: 'lan may manage the gate' });
    expect(decide(c, { from: 'guest', to: 'gate', proto: 'tcp', port: 9443 }).verdict).toBe('blocked');
    expect(decide(c, { from: 'guest', to: 'gate', proto: 'udp', port: 53 }).verdict).toBe('allowed');
    expect(decide(c, { from: 'wan', to: 'gate', proto: 'tcp', port: 9443 }).verdict).toBe('blocked');
    // A rule comes first; a disabled one does not count.
    c.firewall.rules.push({ id: 'no-smb', name: 'No file sharing to guests', enabled: true, from: 'lan', to: 'guest', proto: 'tcp', ports: '445', action: 'drop', log: false });
    expect(decide(c, { from: 'lan', to: 'guest', proto: 'tcp', port: 445 })).toEqual({ verdict: 'blocked', because: 'rule "No file sharing to guests"' });
    expect(decide(c, { from: 'lan', to: 'guest', proto: 'tcp', port: 443 }).verdict).toBe('allowed');
    c.firewall.rules[0].enabled = false;
    expect(decide(c, { from: 'lan', to: 'guest', proto: 'tcp', port: 445 }).verdict).toBe('allowed');
    // From the internet to the gate's address, a forwarded port reaches its device.
    expect(decideConnection(c, { proto: 'tcp', src: '198.51.100.7', dst: '203.0.113.9', port: 443 }, '203.0.113.9/24')).toMatchObject({ from: 'wan', to: 'lan', verdict: { verdict: 'allowed', because: 'port forward "Web server"' } });
    expect(decideConnection(c, { proto: 'tcp', src: '198.51.100.7', dst: '203.0.113.9', port: 22 }, '203.0.113.9/24')).toMatchObject({ to: 'gate', verdict: { verdict: 'blocked' } });
  });

  it('warns you before a change cuts you off from this console', () => {
    const now = home();
    const next = structuredClone(now);
    next.networks[0].manage = false;
    const r = whatIf(now, next, { you: '192.168.1.23' });
    expect(r.you).toMatchObject({ address: '192.168.1.23', from: 'lan', before: { verdict: 'allowed' }, after: { verdict: 'blocked' } });
    expect(r.summary.youCutOff).toBe(true);
    const cut = r.matrix.filter((m) => m.before.verdict === 'allowed' && m.after.verdict !== 'allowed').map((m) => `${m.from} → ${m.what}`);
    expect(cut).toEqual(['lan → this console', 'lan → SSH to the gate']);
    expect(r.summary.cutOff).toBe(2);
  });

  it('shows who gains and loses what, and replays the connections the gate saw', () => {
    const now = home();
    const next = structuredClone(now);
    next.networks[1].access = 'isolated'; // guests lose the internet
    next.firewall.rules.push({ id: 'printer', name: 'Guests may print', enabled: true, from: 'guest', to: 'lan', proto: 'tcp', ports: '9100', destination: '192.168.1.50/32', action: 'accept', log: false });
    const flows = [
      { proto: 'tcp' as const, src: '192.168.20.105', dst: '142.250.1.1', dport: 443, count: 31, lastAt: '2026-11-08T10:00:00Z' },
      { proto: 'tcp' as const, src: '192.168.20.105', dst: '192.168.1.50', dport: 9100, count: 2, lastAt: '2026-11-08T10:00:00Z' },
      { proto: 'tcp' as const, src: '192.168.1.23', dst: '142.250.1.1', dport: 443, count: 90, lastAt: '2026-11-08T10:00:00Z' },
      { proto: 'udp' as const, src: '192.168.1.23', dst: '192.168.1.50', dport: 5353, count: 9, lastAt: '2026-11-08T10:00:00Z' },
    ];
    const r = whatIf(now, next, { flows });
    expect(r.matrix.find((m) => m.from === 'guest' && m.to === 'wan')).toMatchObject({ before: { verdict: 'allowed' }, after: { verdict: 'blocked' } });
    // Unchanged: lan still has the internet.
    expect(r.matrix.find((m) => m.from === 'lan' && m.to === 'wan')).toMatchObject({ before: { verdict: 'allowed' }, after: { verdict: 'allowed' } });
    // The guest's web traffic is cut, the printer opens; lan's and same-network traffic are not listed.
    expect(r.flows.map((f) => [f.src, f.dst, f.after.verdict])).toEqual([
      ['192.168.20.105', '142.250.1.1', 'blocked'],
      ['192.168.20.105', '192.168.1.50', 'allowed'],
    ]);
    expect(r.flowsChecked).toBe(3);
    expect(r.summary).toMatchObject({ cutOff: 1, flowsCutOff: 1, flowsOpened: 1, youCutOff: false });
  });

  it('says what goes when a network is removed, and works before the first commit', () => {
    const now = home();
    const next = structuredClone(now);
    next.networks.pop();
    const r = whatIf(now, next);
    expect(r.matrix.find((m) => m.from === 'guest' && m.to === 'wan')?.after).toEqual({ verdict: 'absent', because: 'there is no guest network' });
    const first = whatIf(null, now, { you: '192.168.1.5' });
    expect(first.you?.after.verdict).toBe('allowed');
    expect(first.summary).toMatchObject({ cutOff: 0, opened: 0, youCutOff: false });
  });
});
