import { describe, expect, it } from 'vitest';
import { checkConfig, diffConfig, peerConfig, render, renderDnsmasq, renderNetworkd, renderNftables, renderQos, starterConfig, type GateConfig } from '../src/index';
import { wgKeyPair, wgPublicKey } from '../src/node/keys';

const paths = { varDir: '/var/lib/fbrx-gate', logDir: '/var/log/fbrx-gate', etcDir: '/etc/fbrx-gate' };

/** A small office: internet on eno1, the LAN on eno2 with a guest VLAN and a mesh VLAN for FBRX computers. */
function office(): GateConfig {
  const c = starterConfig({ hostname: 'gate', wan: 'eno1', lan: 'eno2', lanAddress: '192.168.1.1/24' });
  c.interfaces[1].mtu = 9000;
  c.interfaces.push({ name: 'eno2.20', kind: 'vlan', parent: 'eno2', vlanId: 20, mtu: 1500, description: 'Guests' }, { name: 'eno2.30', kind: 'vlan', parent: 'eno2', vlanId: 30, mtu: 9000, description: 'Mesh' });
  c.networks.push(
    { name: 'guest', purpose: 'guest', interface: 'eno2.20', address: '192.168.20.1/24', access: 'internet', manage: false, dhcp: { enabled: true, start: '192.168.20.50', end: '192.168.20.250', leaseHours: 4, reservations: [] }, description: '' },
    { name: 'mesh', purpose: 'mesh', interface: 'eno2.30', address: '10.30.0.1/24', access: 'full', manage: true, dhcp: { enabled: true, start: '10.30.0.100', end: '10.30.0.200', leaseHours: 24, reservations: [{ mac: 'AA:BB:CC:00:00:01', address: '10.30.0.10', name: 'fbrx-server-1' }] }, description: '' },
  );
  c.firewall.rules.push({ id: 'smtp', name: 'No mail servers from guests', enabled: true, from: 'guest', to: 'wan', proto: 'tcp', ports: '25,465,587', action: 'reject', log: true });
  c.firewall.forwards.push({ id: 'nas', name: 'NAS photos', enabled: true, proto: 'tcp', port: '8443', to: '192.168.1.20', toPort: 443 });
  c.dns.records.push({ name: 'nas', address: '192.168.1.20' });
  c.dns.block = { enabled: true, lists: ['https://example.org/hosts.txt'], domains: ['ads.example'] };
  c.qos = { enabled: true, upload: 40, download: 300, preferMesh: { enabled: true, trafficClass: 'af41', port: 47800, networks: ['mesh'] } };
  return c;
}

describe('FBRX Gate configuration checks', () => {
  it('accepts the starter and a full office', () => {
    expect(checkConfig(starterConfig({ wan: 'eth0', lan: 'eth1' })).ok).toBe(true);
    const r = checkConfig(office());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('explains what does not fit together', () => {
    const c = office();
    c.networks[1].address = '192.168.1.129/25'; // overlaps lan
    c.networks[2].dhcp.start = '10.31.0.5'; // outside mesh
    c.interfaces[1].mtu = 1500; // mesh VLAN 9000 on a 1500 port
    c.firewall.forwards.push({ id: 'nas2', name: 'Twice', enabled: true, proto: 'tcp+udp', port: '8000-9000', to: '172.16.0.5' });
    c.firewall.rules.push({ id: 'bad', name: 'Nowhere', enabled: true, from: 'lan', to: 'office', proto: 'icmp', ports: '22', action: 'accept', log: false });
    c.vpn = { enabled: true, port: 51820, address: '10.99.0.1/24', access: 'full', peers: [{ name: 'phone', publicKey: wgKeyPair().publicKey, address: '10.98.0.2', keepalive: 25 }] };
    const r = checkConfig(c);
    const msgs = r.errors.map((e) => `${e.path}: ${e.message}`).join('\n');
    expect(r.ok).toBe(false);
    expect(msgs).toMatch(/networks\.guest\.address: 192\.168\.1\.128\/25 overlaps network lan/);
    expect(msgs).toMatch(/networks\.mesh\.dhcp: .* must be inside 10\.30\.0\.0\/24/);
    expect(msgs).toMatch(/eno2\.30 has an MTU of 9000 but its port eno2 only 1500/);
    expect(msgs).toMatch(/"Twice": 172\.16\.0\.5 is not in any of the gate’s networks/);
    expect(msgs).toMatch(/"Twice" and "NAS photos" both forward port/);
    expect(msgs).toMatch(/"Nowhere": there is no zone office/);
    expect(msgs).toMatch(/"Nowhere": ports need TCP or UDP/);
    expect(msgs).toMatch(/10\.98\.0\.2 is not in the VPN network/);
  });

  it('refuses the wrong shape with the field it is about', () => {
    const r = checkConfig({ ...office(), hostname: 'not a host!' });
    expect(r.config).toBeNull();
    expect(r.errors[0].path).toBe('hostname');
  });
});

describe('what a configuration turns into', () => {
  it('writes one nftables table: the gate, routing, NAT, forwards and Prefer Mesh', () => {
    const nft = renderNftables(office());
    expect(nft.startsWith('table inet fbrx_gate\ndelete table inet fbrx_gate\n')).toBe(true);
    expect(nft).toContain('elements = { "eno1", "eno2", "eno2.20", "eno2.30" }');
    // Guests reach the internet only; the LAN and the mesh reach everything.
    expect(nft).toContain('iifname "eno2.20" oifname "eno1" accept comment "internet:guest"');
    expect(nft).not.toContain('comment "networks:guest"');
    expect(nft).toContain('iifname "eno2" oifname { "eno2.20", "eno2.30" } accept comment "networks:lan"');
    // The custom rule comes before the defaults, with logging.
    expect(nft.indexOf('rule:smtp')).toBeLessThan(nft.indexOf('internet:guest'));
    expect(nft).toContain('iifname "eno2.20" oifname "eno1" tcp dport { 25, 465, 587 } log prefix "fbrx-gate smtp: " level info counter reject with icmpx type admin-prohibited comment "rule:smtp"');
    // Management only from networks that may.
    expect(nft).toContain('iifname "eno2" tcp dport { 22, 9443 } accept comment "manage:lan"');
    expect(nft).not.toContain('manage:guest');
    // The WAN keeps its DHCP lease; NAT and the port forward.
    expect(nft).toContain('iifname "eno1" udp sport 67 udp dport 68 accept');
    expect(nft).toContain('oifname "eno1" meta nfproto ipv4 masquerade');
    expect(nft).toContain('iifname "eno1" tcp dport 8443 counter dnat ip to 192.168.1.20:443 comment "forward:nas"');
    // Prefer Mesh: the mesh port and the mesh VLAN are marked AF41.
    expect(nft).toContain('tcp dport 47800 ip dscp set af41');
    expect(nft).toContain('iifname "eno2.30" ip dscp set af41');
    // Other networks (a hypervisor's) are left alone.
    expect(nft).toContain('iifname != @gate_ifaces oifname != @gate_ifaces accept');
  });

  it('writes dnsmasq: DHCP per network, names, blocking and the question log', () => {
    const d = renderDnsmasq(office(), paths);
    expect(d).toContain('dhcp-range=set:guest,192.168.20.50,192.168.20.250,255.255.255.0,4h');
    expect(d).toContain('dhcp-option=tag:mesh,option:router,10.30.0.1');
    expect(d).toContain('dhcp-host=aa:bb:cc:00:00:01,10.30.0.10,fbrx-server-1');
    expect(d).toContain('host-record=nas,nas.lan,192.168.1.20');
    expect(d).toContain('address=/ads.example/0.0.0.0');
    expect(d).toContain('conf-file=/var/lib/fbrx-gate/blocklist.conf');
    expect(d).toContain('log-facility=/var/log/fbrx-gate/dnsmasq.log');
    expect(d).toContain('interface=eno2.30');
    expect(d).not.toContain('interface=eno1');
  });

  it('writes systemd-networkd files for the ports and VLANs', () => {
    const files = Object.fromEntries(renderNetworkd(office(), paths).map((f) => [f.name, f.content]));
    expect(files['10-fbrx-eno2.30.netdev']).toMatch(/Kind=vlan[\s\S]*MTUBytes=9000[\s\S]*Id=30/);
    expect(files['10-fbrx-eno2.network']).toMatch(/MTUBytes=9000[\s\S]*VLAN=eno2\.20\nVLAN=eno2\.30\nAddress=192\.168\.1\.1\/24/);
    expect(files['10-fbrx-eno1.network']).toMatch(/DHCP=ipv4/);
  });

  it('shapes the internet line with priority lanes', () => {
    const q = renderQos(office())!;
    expect(q.cake[0]).toEqual(['qdisc', 'replace', 'dev', 'eno1', 'root', 'cake', 'bandwidth', '40000kbit', 'diffserv4', 'nat']);
    expect(q.cake.at(-1)).toContain('ingress');
    expect(q.htb.commands.some((c) => c.join(' ').includes('dsfield 0x88 0xfc flowid 1:10'))).toBe(true);
    expect(renderQos({ ...office(), qos: { ...office().qos, enabled: false } })).toBeNull();
  });

  it('makes VPN settings for a device, and keys that belong together', () => {
    const k = wgKeyPair();
    expect(wgPublicKey(k.privateKey)).toBe(k.publicKey);
    const c = office();
    c.vpn = { enabled: true, port: 51820, address: '10.99.0.1/24', access: 'full', peers: [{ name: 'Phone', publicKey: k.publicKey, address: '10.99.0.2', keepalive: 25 }] };
    expect(checkConfig(c).ok).toBe(true);
    const conf = peerConfig({ config: c, peer: c.vpn.peers[0], privateKey: k.privateKey, gatePublicKey: wgKeyPair().publicKey, endpoint: 'gate.example.com', fullTunnel: false });
    expect(conf).toContain('Endpoint = gate.example.com:51820');
    expect(conf).toContain('AllowedIPs = 10.99.0.0/24, 192.168.1.0/24, 192.168.20.0/24, 10.30.0.0/24');
    const all = render(c, paths);
    expect(all.networkd.find((f) => f.name === '10-fbrx-wg-fbrx.netdev')?.content).toContain(`PublicKey=${k.publicKey}`);
    expect(all.nftables).toContain('iifname "eno1" udp dport 51820 accept comment "vpn"');
  });

  it('lists what changed, by name', () => {
    const a = office();
    const b = office();
    b.networks[1].access = 'isolated';
    b.firewall.rules = [];
    b.dns.upstream = ['9.9.9.9'];
    const d = diffConfig(a, b).map((x) => `${x.kind} ${x.path}`);
    expect(d).toEqual(expect.arrayContaining(['changed networks.guest.access', 'removed firewall.rules.smtp', 'changed dns.upstream']));
  });
});
