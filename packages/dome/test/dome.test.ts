import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { starterConfig, type GateConfig } from '@fbrx/gate';
import { baseDomain, Detectors, DOME_TEST_DOMAIN, looksRandom, parseConntrackLine, parseDnsmasqLine, parseFeed, parseNeighbors, type DetectContext, type DomeEvent, type DomeFinding } from '../src/index';
import { DnsLogSensor, DomeEngine, DomeStore, type DomeSensor } from '../src/node/index';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

function ctx(o: Partial<DetectContext> = {}): DetectContext {
  return {
    gateAddresses: new Set(['192.168.1.1']),
    networks: [{ name: 'lan', cidr: '192.168.1.1/24' }],
    feed: new Set(['evil.example', DOME_TEST_DOMAIN]),
    blocked: new Set(),
    allow: new Set(),
    sensitivity: 'normal',
    meshPort: 47800,
    leaseMac: () => null,
    ...o,
  };
}
const T0 = Date.parse('2026-10-07T12:00:00Z');
const dns = (client: string, name: string, at = T0, qtype = 'A'): DomeEvent => ({ type: 'dns', at, client, name, qtype });
const flow = (src: string, dst: string, dport: number, at = T0, proto: 'tcp' | 'udp' = 'tcp'): DomeEvent => ({ type: 'flow', at, proto, src, dst, dport });

describe('names', () => {
  it('finds the registered part and made-up names', () => {
    expect(baseDomain('a.b.mail.example.co.uk')).toBe('example.co.uk');
    expect(baseDomain('www.example.com')).toBe('example.com');
    for (const n of ['xkqjzvbwmrtpl.com', 'q8f3k2l9z0x7v.net', 'zzkq4jx9vbw2r.info']) expect(looksRandom(n)).toBe(true);
    for (const n of ['stackoverflow.com', 'microsoftonline.com', 'googleusercontent.com', 'wikipedia.org', 'd1a2b3c4d5e6f7.cloudfront.net', '4.3.2.1.in-addr.arpa', 'my-printer.lan']) expect(looksRandom(n)).toBe(false);
  });

  it('reads threat lists as hosts files or plain lists', () => {
    expect(parseFeed('# a list\n0.0.0.0 bad.example\n127.0.0.1 localhost\nworse.example.net # comment\n\nnot a domain\n::1 ip6.example.org')).toEqual(['bad.example', 'worse.example.net', 'ip6.example.org']);
  });
});

describe('what the gate tells MiniDome', () => {
  it('reads dnsmasq questions and missing names', () => {
    expect(parseDnsmasqLine('Oct  7 05:42:01 dnsmasq[812]: 17 192.168.1.23/53001 query[A] Example.COM. from 192.168.1.23', T0)).toEqual({ type: 'dns', at: T0, qtype: 'A', name: 'example.com', client: '192.168.1.23' });
    expect(parseDnsmasqLine('Oct  7 05:42:01 dnsmasq[812]: query[TXT] t.example from 10.0.0.9', T0)).toMatchObject({ qtype: 'TXT', client: '10.0.0.9' });
    expect(parseDnsmasqLine('Oct  7 05:42:01 dnsmasq[812]: 17 192.168.1.23/53001 reply nope.example is NXDOMAIN', T0)).toEqual({ type: 'nxdomain', at: T0, client: '192.168.1.23', name: 'nope.example' });
    expect(parseDnsmasqLine('Oct  7 05:42:01 dnsmasq[812]: 17 192.168.1.23/53001 forwarded example.com to 1.1.1.1', T0)).toBeNull();
  });

  it('reads connections from the event stream and the kernel table', () => {
    expect(parseConntrackLine('    [NEW] tcp      6 120 SYN_SENT src=192.168.1.23 dst=93.184.216.34 sport=50432 dport=443 [UNREPLIED] src=93.184.216.34 dst=203.0.113.20 sport=443 dport=50432', T0)).toEqual({ type: 'flow', at: T0, proto: 'tcp', src: '192.168.1.23', dst: '93.184.216.34', dport: 443 });
    expect(parseConntrackLine('ipv4     2 udp      17 29 src=192.168.1.5 dst=8.8.8.8 sport=5353 dport=53 src=8.8.8.8 dst=203.0.113.20 sport=53 dport=5353 mark=0 use=1', T0)).toMatchObject({ proto: 'udp', dst: '8.8.8.8', dport: 53 });
    expect(parseConntrackLine('ipv4 2 icmp 1 29 src=1.2.3.4 dst=5.6.7.8 type=8 code=0 id=1', T0)).toBeNull();
  });

  it('reads the neighbor table', () => {
    const out = parseNeighbors(JSON.stringify([{ dst: '192.168.1.23', dev: 'eno2', lladdr: 'AA:BB:CC:DD:EE:01', state: ['REACHABLE'] }, { dst: '192.168.1.9', dev: 'eno2', state: ['FAILED'] }, { dst: 'fe80::1', lladdr: 'aa:bb:cc:dd:ee:02' }]), T0);
    expect(out).toEqual([{ type: 'neighbor', at: T0, ip: '192.168.1.23', mac: 'aa:bb:cc:dd:ee:01', dev: 'eno2' }]);
  });
});

describe('the detectors', () => {
  it('flag known-bad names, more gently when the gate blocks them, never allowed ones', () => {
    const d = new Detectors(() => ctx());
    expect(d.handle(dns('192.168.1.20', 'cdn.evil.example'))[0]).toMatchObject({ kind: 'bad-domain', severity: 'serious', subject: 'evil.example' });
    expect(new Detectors(() => ctx({ blocked: new Set(['evil.example']) })).handle(dns('192.168.1.20', 'evil.example'))[0].severity).toBe('warning');
    expect(new Detectors(() => ctx({ allow: new Set(['evil.example']) })).handle(dns('192.168.1.20', 'x.evil.example'))).toEqual([]);
    // Once per half minute per device and subject.
    expect(d.handle(dns('192.168.1.20', 'evil.example', T0 + 5000))).toEqual([]);
    expect(d.handle(dns('192.168.1.20', 'evil.example', T0 + 31_000))).toHaveLength(1);
  });

  it('see made-up names and data hidden in names', () => {
    const d = new Detectors(() => ctx());
    const names = Array.from({ length: 8 }, (_x, i) => `${'xkqjzvbwmrtpl'.slice(i)}${'qzxkvbwm'.slice(0, i + 2)}${i}r.com`);
    const out = names.flatMap((n, i) => d.handle(dns('192.168.1.30', n, T0 + i)));
    expect(out.map((s) => s.kind)).toEqual(['dga']);
    expect(d.handle(dns('192.168.1.31', `${'a1b2c3d4e5'.repeat(6)}.t.example.org`))[0]).toMatchObject({ kind: 'dns-tunnel', subject: 'example.org' });
    const many = new Detectors(() => ctx());
    let hits = 0;
    for (let i = 0; i < 70; i++) hits += many.handle(dns('192.168.1.32', `chunk${i}-aGVsbG8gd29ybGQgdGhpcw.data.example.net`, T0 + i * 1000)).length;
    expect(hits).toBeGreaterThan(0);
    // Reverse lookups are long and many: not tunnels.
    expect(Array.from({ length: 70 }, (_x, i) => many.handle(dns('192.168.1.33', `${i}.1.168.192.in-addr.arpa`, T0 + i, 'PTR'))).flat()).toEqual([]);
  });

  it('see DNS around the gate, scans and checking in like clockwork', () => {
    const d = new Detectors(() => ctx());
    expect(d.handle(flow('192.168.1.40', '8.8.8.8', 53, T0, 'udp'))[0]).toMatchObject({ kind: 'dns-bypass', severity: 'warning' });
    expect(d.handle(flow('192.168.1.40', '192.168.1.1', 53, T0 + 40_000, 'udp'))).toEqual([]);
    const scan = Array.from({ length: 30 }, (_x, i) => d.handle(flow('192.168.1.41', '192.168.1.50', 1000 + i, T0 + i * 100))).flat();
    expect(scan[0]).toMatchObject({ kind: 'port-scan', subject: '192.168.1.50' });
    const sweep = Array.from({ length: 35 }, (_x, i) => d.handle(flow('192.168.1.42', `192.168.1.${100 + i}`, 445, T0 + i * 100))).flat();
    expect(sweep[0]).toMatchObject({ kind: 'port-scan', subject: 'port 445' });
    // Browsing many web servers is not a sweep.
    expect(Array.from({ length: 40 }, (_x, i) => d.handle(flow('192.168.1.43', `93.184.216.${i}`, 443, T0 + i * 100))).flat()).toEqual([]);
    const beacon = Array.from({ length: 9 }, (_x, i) => d.handle(flow('192.168.1.44', '203.0.113.77', 8883, T0 + i * 300_000 + (i % 2) * 2000))).flat();
    // From the eighth check-in on, each one is counted.
    expect(beacon.map((s) => s.kind)).toEqual(['beaconing', 'beaconing']);
    expect(beacon[0].detail).toMatch(/every 5 minutes/);
    // Irregular visits, FBRX Mesh and private addresses are not beacons.
    expect(Array.from({ length: 9 }, (_x, i) => d.handle(flow('192.168.1.45', '203.0.113.78', 443, T0 + i * i * 60_000))).flat()).toEqual([]);
    expect(Array.from({ length: 9 }, (_x, i) => d.handle(flow('192.168.1.45', '203.0.113.79', 47800, T0 + i * 60_000))).flat()).toEqual([]);
  });

  it('see devices fighting over an address', () => {
    const leases = new Map([['192.168.1.60', 'aa:aa:aa:aa:aa:01']]);
    const d = new Detectors(() => ctx({ leaseMac: (ip) => leases.get(ip) ?? null }));
    const n = (ip: string, mac: string, at: number): DomeEvent => ({ type: 'neighbor', at, ip, mac, dev: 'eno2' });
    expect(d.handle(n('192.168.1.60', 'aa:aa:aa:aa:aa:01', T0))).toEqual([]);
    expect(d.handle(n('192.168.1.60', 'bb:bb:bb:bb:bb:01', T0 + 1000))[0]).toMatchObject({ kind: 'arp-spoof', severity: 'warning' });
    // Back and forth: getting worse speaks up at once, then waits its half minute.
    expect(d.handle(n('192.168.1.60', 'aa:aa:aa:aa:aa:01', T0 + 2000)).map((s) => s.severity)).toEqual(['serious']);
    expect(d.handle(n('192.168.1.60', 'bb:bb:bb:bb:bb:01', T0 + 3000)).map((s) => s.severity)).toEqual([]);
    expect(Array.from({ length: 4 }, (_x, i) => d.handle(n(`192.168.1.${70 + i}`, 'cc:cc:cc:cc:cc:01', T0 + i))).flat().map((s) => s.subject)).toEqual(['cc:cc:cc:cc:cc:01']);
  });

  it('speak up sooner when sensitive, later when not', () => {
    const run = (sensitivity: DetectContext['sensitivity']) => {
      const d = new Detectors(() => ctx({ sensitivity }));
      return Array.from({ length: 20 }, (_x, i) => d.handle(flow('192.168.1.41', '192.168.1.50', 2000 + i, T0 + i))).flat().length;
    };
    expect(run('high')).toBe(1);
    expect(run('normal')).toBe(0);
  });
});

class FakeSensor implements DomeSensor {
  readonly name = 'fake';
  emit: (e: DomeEvent) => void = () => undefined;
  start(emit: (e: DomeEvent) => void) {
    this.emit = emit;
  }
  stop() {}
  status() {
    return { name: this.name, ok: true, detail: 'test' };
  }
}

function engine(o: { learnMs?: number; notify?: (f: DomeFinding) => Promise<string | null>; feed?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fbrx-dome-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new DomeStore(join(dir, 'dome.db'));
  cleanups.push(() => store.close());
  const sensor = new FakeSensor();
  const gate: GateConfig = starterConfig({ wan: 'eno1', lan: 'eno2' });
  const e = new DomeEngine({ store, sensors: [sensor], mode: 'simulated', gate: () => gate, feedCache: join(dir, 'feeds.json'), fetchFeed: async () => o.feed ?? '0.0.0.0 evil.example\n', notify: o.notify, learnMs: o.learnMs ?? 0 });
  cleanups.push(() => e.stop());
  e.start();
  return { e, sensor, store, dir };
}

describe('MiniDome', () => {
  it('keeps one finding per device and subject, counted, with the device by name', async () => {
    const told: DomeFinding[] = [];
    const { e, sensor } = engine({ notify: async (f) => (told.push(f), 'Sam laptop') });
    sensor.emit({ type: 'lease', at: Date.now(), ip: '192.168.1.120', mac: 'aa:bb:cc:00:00:01', name: 'sam-laptop', network: 'lan' });
    sensor.emit(dns('192.168.1.120', DOME_TEST_DOMAIN, Date.now()));
    sensor.emit(dns('192.168.1.120', DOME_TEST_DOMAIN, Date.now() + 31_000));
    const bad = e.findings('active').find((f) => f.kind === 'bad-domain')!;
    expect(bad).toMatchObject({ title: 'sam-laptop asked for a known-bad name', count: 2, status: 'open', device: { ip: '192.168.1.120', mac: 'aa:bb:cc:00:00:01', name: 'sam-laptop', network: 'lan' } });
    // A new device (the learning period is over at once here), told no one: it is only information.
    expect(e.findings().find((f) => f.kind === 'new-device')?.title).toBe('New device on lan: sam-laptop');
    await new Promise((r) => setTimeout(r, 20));
    expect(told.map((f) => f.kind)).toEqual(['bad-domain']);
    expect(e.finding(bad.id)!.notified).toBe('Sam laptop');
    expect(e.state().open).toMatchObject({ serious: 1, info: 1 });
    expect((await e.devices())[0]).toMatchObject({ mac: 'aa:bb:cc:00:00:01', name: 'sam-laptop', fbrx: null });
  });

  it('opens a resolved finding again when it happens again, and only counts a muted one', () => {
    const { e, sensor } = engine();
    sensor.emit(dns('192.168.1.121', DOME_TEST_DOMAIN, Date.now()));
    const f = e.findings()[0];
    e.setStatus(f.id, 'resolved');
    sensor.emit(dns('192.168.1.121', DOME_TEST_DOMAIN, Date.now() + 31_000));
    expect(e.finding(f.id)).toMatchObject({ status: 'open', count: 2 });
    e.setStatus(f.id, 'muted');
    sensor.emit(dns('192.168.1.121', DOME_TEST_DOMAIN, Date.now() + 62_000));
    expect(e.finding(f.id)).toMatchObject({ status: 'muted', count: 3 });
    expect(e.state().open.serious).toBe(0);
  });

  it('learns the network before it reports new devices', () => {
    const { e, sensor } = engine({ learnMs: 60_000 });
    sensor.emit({ type: 'lease', at: Date.now(), ip: '192.168.1.122', mac: 'aa:bb:cc:00:00:02', name: 'tv', network: 'lan' });
    expect(e.findings()).toEqual([]);
    expect(e.state().learningUntil).not.toBeNull();
    expect(e.state().stats.devices).toBe(1);
  });

  it('fetches threat lists, keeps them, and checks its settings', async () => {
    const { e, sensor } = engine({ feed: '0.0.0.0 malware.example\nphish.example\n' });
    expect(() => e.setSettings({ ...e.settings(), feeds: ['ftp://lists.example/x'] })).toThrow();
    e.setSettings({ ...e.settings(), feeds: ['https://lists.example/threats.txt'], allow: ['Phish.Example'] });
    const r = await e.refreshFeeds();
    expect(r).toEqual({ domains: 3, errors: [] });
    expect(e.settings().allow).toEqual(['phish.example']);
    sensor.emit(dns('192.168.1.123', 'cdn.malware.example', Date.now()));
    sensor.emit(dns('192.168.1.123', 'phish.example', Date.now()));
    expect(e.findings().map((f) => f.subject)).toEqual(['malware.example']);
    expect(e.state().stats).toMatchObject({ feedDomains: 3, dnsQueries: 2 });
  });
});

describe('the question log', () => {
  it('is followed from its end, and from its start again after rotation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fbrx-dome-log-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'dnsmasq.log');
    writeFileSync(file, 'Oct  7 05:42:01 dnsmasq[1]: 1 192.168.1.5/1 query[A] old.example from 192.168.1.5\n');
    const seen: string[] = [];
    const s = new DnsLogSensor(file, 20);
    cleanups.push(() => s.stop());
    s.start((e) => e.type === 'dns' && seen.push(e.name));
    appendFileSync(file, 'Oct  7 05:42:02 dnsmasq[1]: 2 192.168.1.5/1 query[A] new.example from 192.168.1.5\nOct  7 05:42:02 dnsmasq[1]: 3 192.168.1.5/1 query[AAAA] half');
    await new Promise((r) => setTimeout(r, 80));
    appendFileSync(file, '.example from 192.168.1.5\n');
    await new Promise((r) => setTimeout(r, 80));
    writeFileSync(file, 'Oct  7 05:43:00 dnsmasq[1]: 4 192.168.1.5/1 query[A] rotated.example from 192.168.1.5\n');
    await new Promise((r) => setTimeout(r, 80));
    expect(seen).toEqual(['new.example', 'half.example', 'rotated.example']);
    expect(s.status().ok).toBe(true);
  });
});
