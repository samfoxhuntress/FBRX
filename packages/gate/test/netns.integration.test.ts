import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GateConfig } from '../src/index';
import { GateEngine, GateStore, LinuxApplier, runCommand } from '../src/node/index';
// FBRX MiniDome listens to this gate too (it depends on FBRX Gate, so its real-network check lives here).
import { DOME_TEST_DOMAIN } from '../../dome/src/index';
import { ConntrackSensor, DnsLogSensor, DomeEngine, DomeStore } from '../../dome/src/node/index';

/**
 * FBRX Gate as a real router, inside Linux network namespaces: an "internet" host, the gate, and clients on the LAN,
 * the guest network and the mesh network (VLANs on one cable where the kernel has 802.1Q, separate cables otherwise).
 * Needs root, nftables, dnsmasq and iproute2; skipped elsewhere (CI runs it with sudo).
 */
const can = process.platform === 'linux' && process.getuid?.() === 0 && ['nft', 'dnsmasq', 'ip', 'tc'].every((c) => spawnSync(c, ['-V']).error === undefined || spawnSync(c, ['--version']).error === undefined);

const id = process.pid % 100000;
const NS = { gw: `fgw${id}`, wan: `fwan${id}`, lan: `flan${id}`, guest: `fgst${id}`, mesh: `fmsh${id}` };
const sh = (...a: string[]) => execFileSync('ip', a, { encoding: 'utf8' });
const inNs = (ns: string, cmd: string, ...a: string[]) => execFileSync('ip', ['netns', 'exec', ns, cmd, ...a], { encoding: 'utf8', timeout: 20_000 });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TOOL = `
import net from 'node:net';
import dns from 'node:dns';
const [mode, a, b, c] = process.argv.slice(2);
if (mode === 'serve') net.createServer((s) => s.end(String(s.remoteAddress).replace('::ffff:', '') + '\\n')).listen(Number(b), a);
if (mode === 'connect') {
  const t = setTimeout(() => { console.log('TIMEOUT'); process.exit(0); }, Number(c));
  const s = net.connect({ host: a, port: Number(b) });
  let d = '';
  s.on('data', (x) => (d += x));
  s.on('end', () => { clearTimeout(t); console.log('OK ' + d.trim()); process.exit(0); });
  s.on('error', (e) => { clearTimeout(t); console.log('ERR ' + e.code); process.exit(0); });
}
if (mode === 'dns') {
  const r = new dns.promises.Resolver({ timeout: 1500, tries: 1 });
  r.setServers([a]);
  r.resolve4(b).then((x) => console.log('OK ' + x.join(',')), (e) => console.log('ERR ' + e.code));
}
`;

describe.runIf(can)('FBRX Gate on a real (namespaced) network', () => {
  let dir = '';
  let tool = '';
  let vlans = false;
  let engine: GateEngine;
  let store: GateStore;
  const procs: ChildProcess[] = [];
  const connect = (ns: string, host: string, port: number, ms = 1500) => inNs(ns, process.execPath, tool, 'connect', host, String(port), String(ms)).trim();
  const dnsq = (ns: string, server: string, name: string) => inNs(ns, process.execPath, tool, 'dns', server, name).trim();
  const serve = (ns: string, host: string, port: number) => procs.push(spawn('ip', ['netns', 'exec', ns, process.execPath, tool, 'serve', host, String(port)], { stdio: 'ignore' }));
  const counter = (ns: string, table: string, comment: string) => {
    const m = new RegExp(`counter packets (\\d+) bytes \\d+ comment "${comment}"`).exec(inNs(ns, 'nft', 'list', 'table', 'inet', table));
    return m ? Number(m[1]) : -1;
  };
  const LAN = { lan: 'gwlan', guest: 'gwlan.20', mesh: 'gwlan.30' };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fbrx-gate-netns-'));
    tool = join(dir, 'tool.mjs');
    writeFileSync(tool, TOOL);
    for (const ns of Object.values(NS)) {
      sh('netns', 'add', ns);
      sh('-n', ns, 'link', 'set', 'lo', 'up');
    }
    // Does this kernel do VLANs?
    sh('-n', NS.lan, 'link', 'add', 'probe0', 'type', 'veth', 'peer', 'name', 'probe1');
    vlans = spawnSync('ip', ['-n', NS.lan, 'link', 'add', 'link', 'probe0', 'name', 'probe0.9', 'type', 'vlan', 'id', '9']).status === 0;
    spawnSync('ip', ['-n', NS.lan, 'link', 'del', 'probe0']);

    // The internet.
    sh('-n', NS.gw, 'link', 'add', 'gwwan', 'type', 'veth', 'peer', 'name', 'up0', 'netns', NS.wan);
    sh('-n', NS.wan, 'addr', 'add', '203.0.113.1/24', 'dev', 'up0');
    sh('-n', NS.wan, 'link', 'set', 'up0', 'up');
    // The clients.
    const client = (ns: string, ifname: string, addr: string, gw: string, mtu = 1500) => {
      sh('-n', ns, 'link', 'set', ifname, 'mtu', String(mtu), 'up');
      sh('-n', ns, 'addr', 'add', addr, 'dev', ifname);
      sh('-n', ns, 'route', 'add', 'default', 'via', gw);
    };
    if (vlans) {
      sh('-n', NS.gw, 'link', 'add', 'gwlan', 'type', 'veth', 'peer', 'name', 'sw0', 'netns', NS.lan);
      sh('-n', NS.lan, 'link', 'set', 'sw0', 'mtu', '9000', 'up');
      for (const [tag, ns] of [
        ['20', NS.guest],
        ['30', NS.mesh],
      ]) {
        sh('-n', NS.lan, 'link', 'add', 'link', 'sw0', 'name', `sw0.${tag}`, 'type', 'vlan', 'id', tag);
        sh('-n', NS.lan, 'link', 'set', `sw0.${tag}`, 'netns', ns);
      }
      client(NS.lan, 'sw0', '192.168.50.10/24', '192.168.50.1', 9000);
      client(NS.guest, 'sw0.20', '192.168.60.10/24', '192.168.60.1');
      client(NS.mesh, 'sw0.30', '10.30.0.10/24', '10.30.0.1', 9000);
    } else {
      Object.assign(LAN, { guest: 'gwgst', mesh: 'gwmsh' });
      for (const [gwIf, peer, ns] of [
        ['gwlan', 'sw0', NS.lan],
        ['gwgst', 'sg0', NS.guest],
        ['gwmsh', 'sm0', NS.mesh],
      ]) sh('-n', NS.gw, 'link', 'add', gwIf, 'type', 'veth', 'peer', 'name', peer, 'netns', ns);
      client(NS.lan, 'sw0', '192.168.50.10/24', '192.168.50.1', 9000);
      client(NS.guest, 'sg0', '192.168.60.10/24', '192.168.60.1');
      client(NS.mesh, 'sm0', '10.30.0.10/24', '10.30.0.1', 9000);
    }

    const config: GateConfig = {
      version: 1,
      hostname: 'gate',
      interfaces: vlans
        ? [
            { name: 'gwwan', kind: 'ethernet', mtu: 1500, description: '' },
            { name: 'gwlan', kind: 'ethernet', mtu: 9000, description: '' },
            { name: 'gwlan.20', kind: 'vlan', parent: 'gwlan', vlanId: 20, mtu: 1500, description: '' },
            { name: 'gwlan.30', kind: 'vlan', parent: 'gwlan', vlanId: 30, mtu: 9000, description: '' },
          ]
        : [
            { name: 'gwwan', kind: 'ethernet', mtu: 1500, description: '' },
            { name: 'gwlan', kind: 'ethernet', mtu: 9000, description: '' },
            { name: 'gwgst', kind: 'ethernet', mtu: 1500, description: '' },
            { name: 'gwmsh', kind: 'ethernet', mtu: 9000, description: '' },
          ],
      wan: { interface: 'gwwan', mode: 'static', address: '203.0.113.2/24', gateway: '203.0.113.1', ping: false },
      networks: [
        { name: 'lan', purpose: 'lan', interface: LAN.lan, address: '192.168.50.1/24', access: 'full', manage: true, dhcp: { enabled: true, start: '192.168.50.100', end: '192.168.50.150', leaseHours: 12, reservations: [] }, description: '' },
        { name: 'guest', purpose: 'guest', interface: LAN.guest, address: '192.168.60.1/24', access: 'internet', manage: false, dhcp: { enabled: true, start: '192.168.60.100', end: '192.168.60.150', leaseHours: 2, reservations: [] }, description: '' },
        { name: 'mesh', purpose: 'mesh', interface: LAN.mesh, address: '10.30.0.1/24', access: 'full', manage: true, dhcp: { enabled: false, start: '10.30.0.100', end: '10.30.0.150', leaseHours: 12, reservations: [] }, description: '' },
      ],
      firewall: { rules: [], forwards: [{ id: 'web', name: 'Web server', enabled: true, proto: 'tcp', port: '8443', to: '192.168.50.10', toPort: 8081 }] },
      dns: { upstream: ['203.0.113.1'], domain: 'lan', records: [{ name: 'nas', address: '192.168.50.20' }], block: { enabled: true, lists: [], domains: ['ads.example'] }, logQueries: true },
      vpn: { enabled: false, port: 51820, address: '10.99.0.1/24', access: 'full', peers: [] },
      qos: { enabled: true, upload: 100, download: 0, preferMesh: { enabled: true, trafficClass: 'af41', port: 47800, networks: ['mesh'] } },
      management: { ssh: false, consolePort: 9443 },
    };

    const pidFile = join(dir, 'dnsmasq.pid');
    const applier = new LinuxApplier({
      paths: { varDir: join(dir, 'var'), logDir: join(dir, 'log'), etcDir: join(dir, 'etc-gate') },
      mode: 'iproute',
      root: join(dir, 'root'),
      dnsmasqConf: join(dir, 'dnsmasq.conf'),
      run: (cmd, args) => runCommand('ip', ['netns', 'exec', NS.gw, cmd, ...args]),
      restartDns: async (conf) => {
        if (existsSync(pidFile)) spawnSync('kill', [readFileSync(pidFile, 'utf8').trim()]);
        await wait(200);
        if (existsSync(conf)) inNs(NS.gw, 'dnsmasq', `--conf-file=${conf}`, `--pid-file=${pidFile}`, '--user=root');
      },
    });
    store = new GateStore(join(dir, 'gate.db'));
    engine = new GateEngine({ store, applier, paths: { varDir: join(dir, 'var'), logDir: join(dir, 'log'), etcDir: join(dir, 'etc-gate') }, initial: () => config });
    const c = await engine.commit({ by: 'test', comment: 'Office' });
    expect(c.status).toBe('confirmed');

    // A probe on the internet side counts what arrives marked for priority.
    const probe = join(dir, 'probe.nft');
    writeFileSync(
      probe,
      'table inet probe {\n chain pre {\n  type filter hook prerouting priority -300;\n  tcp dport 47800 ip dscp af41 counter comment "mesh-port"\n  tcp dport 8080 ip dscp af41 counter comment "af41-8080"\n  tcp dport 8080 counter comment "all-8080"\n }\n}\n',
    );
    inNs(NS.wan, 'nft', '-f', probe);
    serve(NS.wan, '203.0.113.1', 8080);
    serve(NS.wan, '203.0.113.1', 47800);
    serve(NS.lan, '192.168.50.10', 8081);
    serve(NS.mesh, '10.30.0.10', 47800);
    await wait(800);
  }, 60_000);

  afterAll(() => {
    for (const p of procs) p.kill();
    const pid = join(dir, 'dnsmasq.pid');
    if (existsSync(pid)) spawnSync('kill', [readFileSync(pid, 'utf8').trim()]);
    for (const ns of Object.values(NS)) spawnSync('ip', ['netns', 'del', ns]);
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('routes every network to the internet behind one address', () => {
    expect(connect(NS.lan, '203.0.113.1', 8080)).toBe('OK 203.0.113.2');
    expect(connect(NS.guest, '203.0.113.1', 8080)).toBe('OK 203.0.113.2');
    expect(connect(NS.mesh, '203.0.113.1', 8080)).toBe('OK 203.0.113.2');
  });

  it('keeps guests away from the other networks, and lets the LAN reach the mesh', () => {
    expect(connect(NS.guest, '192.168.50.10', 8081, 1000)).toBe('TIMEOUT');
    expect(connect(NS.guest, '10.30.0.10', 47800, 1000)).toBe('TIMEOUT');
    expect(connect(NS.lan, '10.30.0.10', 47800)).toBe('OK 192.168.50.10');
  });

  it('forwards a port from the internet to a device inside', () => {
    expect(connect(NS.wan, '203.0.113.2', 8443)).toBe('OK 203.0.113.1');
  });

  it('lets only the right networks talk to the gate itself', () => {
    // Nothing listens on the console port here: "refused" means the firewall let it through, a timeout that it did not.
    expect(connect(NS.lan, '192.168.50.1', 9443)).toBe('ERR ECONNREFUSED');
    expect(connect(NS.guest, '192.168.60.1', 9443, 1000)).toBe('TIMEOUT');
    expect(connect(NS.wan, '203.0.113.2', 53, 1000)).toBe('TIMEOUT');
  });

  it('answers names, local and blocked', () => {
    expect(dnsq(NS.lan, '192.168.50.1', 'nas.lan')).toBe('OK 192.168.50.20');
    expect(dnsq(NS.guest, '192.168.60.1', 'ads.example')).toBe('OK 0.0.0.0');
    expect(dnsq(NS.lan, '192.168.50.1', 'gate.lan')).toMatch(/^OK .*192\.168\.50\.1/);
  });

  it('marks mesh traffic AF41 on its way out (Prefer Mesh), and nothing else', () => {
    const before = { mesh: counter(NS.wan, 'probe', 'mesh-port'), af: counter(NS.wan, 'probe', 'af41-8080'), all: counter(NS.wan, 'probe', 'all-8080') };
    expect(connect(NS.lan, '203.0.113.1', 47800)).toBe('OK 203.0.113.2');
    expect(counter(NS.wan, 'probe', 'mesh-port')).toBeGreaterThan(before.mesh);
    // Ordinary LAN traffic is not marked…
    connect(NS.lan, '203.0.113.1', 8080);
    expect(counter(NS.wan, 'probe', 'af41-8080')).toBe(before.af);
    expect(counter(NS.wan, 'probe', 'all-8080')).toBeGreaterThan(before.all);
    // …everything from the mesh network is.
    connect(NS.mesh, '203.0.113.1', 8080);
    expect(counter(NS.wan, 'probe', 'af41-8080')).toBeGreaterThan(before.af);
  });

  it('shapes the line with the priority lane in front', async () => {
    for (let i = 0; i < 3; i++) connect(NS.mesh, '203.0.113.1', 47800);
    const live = await engine.live();
    expect(live.qos.kind === 'cake' || live.qos.kind === 'htb').toBe(true);
    if (live.qos.kind === 'htb') {
      // "class htb 1:10 parent 1:1 … \n Sent 1234 bytes 20 pkt …"
      const text = inNs(NS.gw, 'tc', '-s', 'class', 'show', 'dev', 'gwwan');
      const sent = /class htb 1:10 [^\n]*\n\s*Sent (\d+) bytes/.exec(text);
      expect(Number(sent?.[1] ?? 0)).toBeGreaterThan(0);
      expect(engine.lastNotes().join(' ')).toMatch(/HTB/);
    }
    expect(live.interfaces.map((i) => i.name)).toEqual(expect.arrayContaining(['gwwan', 'gwlan']));
    expect(live.wan).toEqual({ address: '203.0.113.2', gateway: '203.0.113.1' });
    expect(live.counters['forward:web']?.packets).toBeGreaterThan(0);
    expect(live.dns.running).toBe(true);
    if (vlans) expect(live.interfaces.find((i) => i.name === 'gwlan.30')?.mtu).toBe(9000);
  });

  it('is heard by FBRX MiniDome: a known-bad name, and DNS around the gate', async () => {
    const domeStore = new DomeStore(join(dir, 'dome.db'));
    const conntrack = spawnSync('conntrack', ['--version']).error === undefined;
    const sensors = [new DnsLogSensor(join(dir, 'log', 'dnsmasq.log'), 100), ...(conntrack ? [new ConntrackSensor({ command: 'ip', args: ['netns', 'exec', NS.gw, 'conntrack', '-E', '-e', 'NEW'] })] : [])];
    const dome = new DomeEngine({ store: domeStore, sensors, mode: 'linux', gate: () => engine.running(), feedCache: join(dir, 'feeds.json'), fetchFeed: async () => '', learnMs: 0 });
    try {
      dome.start();
      await wait(600);
      dnsq(NS.lan, '192.168.50.1', DOME_TEST_DOMAIN);
      if (conntrack) dnsq(NS.lan, '203.0.113.1', 'example.com');
      for (let i = 0; i < 40 && dome.findings().length < (conntrack ? 2 : 1); i++) await wait(200);
      const found = dome.findings();
      expect(found.find((f) => f.kind === 'bad-domain')).toMatchObject({ device: { ip: '192.168.50.10' }, subject: 'fbrx.invalid' });
      if (conntrack) expect(found.find((f) => f.kind === 'dns-bypass')).toMatchObject({ subject: '203.0.113.1:53' });
      expect(dome.state().stats.sensors.every((s) => s.ok)).toBe(true);
    } finally {
      dome.stop();
      domeStore.close();
    }
  }, 20_000);

  it('undoes a commit that cut something off, unless it is confirmed', async () => {
    const c = structuredClone(engine.candidate());
    c.firewall.rules.push({ id: 'cut', name: 'Block the web from the LAN', enabled: true, from: 'lan', to: 'wan', proto: 'tcp', ports: '8080', action: 'drop', log: false });
    engine.setCandidate(c, 'test');
    await engine.commit({ by: 'test', confirmMinutes: 0.04 });
    expect(connect(NS.lan, '203.0.113.1', 8080, 800)).toBe('TIMEOUT');
    await wait(2800);
    expect(engine.history()[0].status).toBe('rolled-back');
    expect(connect(NS.lan, '203.0.113.1', 8080)).toBe('OK 203.0.113.2');
  }, 20_000);
});
