import { describe, expect, it } from 'vitest';
import type { PingResult } from '@fbrx/shared';
import { stackReport, stackText, type StackFacts } from '../src/network/stack-check';
import { TOOLKIT_LIBRARY } from '../src/ai/toolkit-library';
import { makeKernel } from './helpers';

const ping = (avg: number | null, lossPct = 0): PingResult => ({ host: 'x', ip: null, sent: 3, received: avg == null ? 0 : 3, lossPct: avg == null ? 100 : lossPct, min: avg, avg, max: avg, jitter: 0, samples: [avg] });

/** A home network where everything works, over Wi-Fi. */
const healthy = (): StackFacts => ({
  os: 'windows',
  interfaces: [{ name: 'Wi-Fi', type: 'wireless', up: true, ip4: '192.168.1.23', ip6: null, mac: 'aa:bb:cc:dd:ee:ff', speedMbps: 866, virtual: false, dhcp: true }],
  wifi: { ssid: 'Home', signalPct: 80, signalDbm: -55, band: '5 GHz' },
  gateway: '192.168.1.1',
  gatewayPing: ping(3),
  gatewayMac: '11:22:33:44:55:66',
  internetAllowed: true,
  internetPing: ping(18),
  dnsServers: ['192.168.1.1'],
  dnsSystem: { ok: true, ms: 20 },
  dnsDirect: { ok: true, ms: 15 },
  tcp443: { byIp: true, byName: true },
  proxy: null,
  vpn: null,
  web: { portal: false, status: 200, error: null, clockSkewMin: 0 },
  target: null,
});
const all = () => true;
const at = (r: ReturnType<typeof stackReport>, layer: string) => r.steps.find((s) => s.layer === layer)!;
const tools = (r: ReturnType<typeof stackReport>) => r.steps.flatMap((s) => s.next.map((n) => n.tool));

describe('the full network check', () => {
  it('says every layer works on a healthy network, with the commands for each', () => {
    const r = stackReport(healthy(), all);
    expect(r.breaksAt).toBeNull();
    expect(r.summary).toMatch(/Every layer works/);
    expect(r.steps.map((s) => s.layer)).toEqual(['physical', 'link', 'ip', 'routing', 'dns', 'transport', 'application']);
    for (const s of r.steps) {
      expect(s.status, s.layer).toBe('ok');
      expect(s.commands.windows.length && s.commands.mac.length && s.commands.linux.length, s.layer).toBeTruthy();
      expect(s.headline, s.layer).not.toBe('');
    }
    expect(at(r, 'physical').headline).toMatch(/Home.*-55 dBm \(strong\)/);
    expect(stackText(r, 'windows')).toMatch(/By hand: ipconfig \/all/);
  });

  it('stops at the first layer that fails and skips the ones above it', () => {
    const cases: Array<[string, (f: StackFacts) => void, string, RegExp, string[]]> = [
      ['nothing connected', (f) => (f.interfaces[0]!.up = false), 'physical', /No network adapter is connected/, ['kit.network_adapters']],
      ['the router out of reach', (f) => ((f.gatewayPing = ping(null)), (f.gatewayMac = null)), 'link', /does not answer on the local network/, ['net.scan_lan']],
      ['DHCP failed', (f) => ((f.interfaces[0]!.ip4 = '169.254.10.20'), (f.gateway = null)), 'ip', /169\.254\.10\.20.*DHCP failed/, ['kit.get_a_fresh_address']],
      ['an address and no router', (f) => (f.gateway = null), 'ip', /no router/, ['kit.use_an_automatic_address']],
      ['the internet down', (f) => ((f.internetPing = ping(null)), (f.tcp443 = { byIp: false, byName: false }), (f.dnsDirect = { ok: false, ms: null }), (f.web = null)), 'routing', /Nothing past the router answers/, ['net.traceroute']],
      ['the DNS server dead', (f) => (f.dnsSystem = { ok: false, ms: null }), 'dns', /Your DNS server \(192\.168\.1\.1\) does not answer, but a public one does/, ['kit.flush_the_dns_cache', 'net.dns_lookup']],
      ['secure traffic blocked', (f) => ((f.tcp443 = { byIp: false, byName: false }), (f.web = { portal: false, status: null, error: 'it timed out', clockSkewMin: null })), 'transport', /port 443\) does not get out/, ['net.port_check']],
      ['a sign-in page in the way', (f) => (f.web = { portal: true, status: 200, error: null, clockSkewMin: 0 }), 'application', /sign-in page is in the way/, []],
      ['the site down', (f) => (f.target = { name: 'shop.example.org', resolved: true, port443: false, status: null, error: null }), 'application', /shop\.example\.org does not answer on port 443/, ['net.port_check', 'net.traceroute']],
      ['a misspelled site', (f) => (f.target = { name: 'gogle.example', resolved: false, port443: null, status: null, error: null }), 'application', /does not resolve/, ['net.dns_lookup']],
    ];
    for (const [what, change, layer, why, next] of cases) {
      const f = healthy();
      change(f);
      const r = stackReport(f, all);
      expect(r.breaksAt, what).toBe(layer);
      expect(at(r, layer).headline, what).toMatch(why);
      expect(r.summary, what).toMatch(why);
      for (const t of next) expect(tools(r), what).toContain(t);
      const i = r.steps.findIndex((s) => s.layer === layer);
      for (const s of r.steps.slice(i + 1)) {
        expect(s.status, `${what}: ${s.layer}`).toBe('skipped');
        expect(s.next, `${what}: ${s.layer}`).toEqual([]);
      }
      for (const s of r.steps.slice(0, i)) expect(s.status, `${what}: ${s.layer}`).not.toBe('fail');
    }
  });

  it('does not call the internet down on a network that only blocks pings', () => {
    const f = healthy();
    f.internetPing = ping(null);
    f.gatewayPing = ping(null);
    const r = stackReport(f, all);
    expect(r.breaksAt).toBeNull();
    expect(at(r, 'routing').headline).toMatch(/internet works.*blocks pings/);
    expect(at(r, 'link').status).toBe('ok');
  });

  it('warns about a weak signal, a slow cable, a lossy line, a proxy, a VPN and a wrong clock', () => {
    const f = healthy();
    f.wifi!.signalDbm = -81;
    f.internetPing = ping(220, 10);
    f.proxy = 'proxy.local:8080';
    f.vpn = 'wg0';
    f.web!.clockSkewMin = -42;
    const r = stackReport(f, all);
    expect(r.breaksAt).toBeNull();
    expect(at(r, 'physical')).toMatchObject({ status: 'warn', headline: expect.stringMatching(/weak/) });
    expect(at(r, 'routing').status).toBe('warn');
    expect(at(r, 'routing').found.join(' ')).toMatch(/VPN is on \(wg0\)/);
    expect(at(r, 'transport').headline).toMatch(/proxy is set \(proxy\.local:8080\)/);
    expect(at(r, 'application').headline).toMatch(/42 minutes behind/);
    expect(tools(r)).toEqual(expect.arrayContaining(['net.wifi_channels', 'net.speed_test']));
    expect(r.summary).toMatch(/It works, with 4 things to look at/);
    const wired = healthy();
    wired.interfaces[0] = { ...wired.interfaces[0]!, name: 'Ethernet', type: 'wired', speedMbps: 100 };
    wired.wifi = null;
    expect(at(stackReport(wired, all), 'physical').headline).toMatch(/Ethernet runs at 100 Mbps/);
  });

  it('checks only this computer and the router in an offline chat', () => {
    const f = healthy();
    f.internetAllowed = false;
    f.internetPing = null;
    f.dnsSystem = f.dnsDirect = null;
    f.web = null;
    const r = stackReport(f, all);
    expect(r.localOnly).toBe(true);
    expect(r.breaksAt).toBeNull();
    expect(['dns', 'transport', 'application'].map((l) => at(r, l).status)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(r.summary).toMatch(/internet was not checked/);
  });

  it('names only the tools this FBRX has, and every tool it names is a real one', async () => {
    const f = healthy();
    f.dnsSystem = { ok: false, ms: null };
    expect(tools(stackReport(f, (t) => t.startsWith('net.')))).toEqual(['net.dns_lookup']);
    const { kernel, cleanup } = await makeKernel();
    try {
      expect(kernel.registry.get('net.diagnose')).toBeTruthy();
      const real = new Set([...kernel.registry.list().map((t) => t.name), ...TOOLKIT_LIBRARY.map((a) => a.tool), 'server.network_check']);
      const named = new Set<string>();
      const variants: Array<(x: StackFacts) => void> = [
        (x) => (x.interfaces[0]!.up = false),
        (x) => ((x.gatewayPing = ping(null)), (x.gatewayMac = null)),
        (x) => (x.interfaces[0]!.ip4 = '169.254.1.1'),
        (x) => (x.gateway = null),
        (x) => ((x.internetPing = ping(null)), (x.tcp443 = { byIp: false, byName: false }), (x.dnsDirect = { ok: false, ms: null }), (x.web = null)),
        (x) => (x.dnsSystem = { ok: false, ms: null }),
        (x) => ((x.dnsSystem = { ok: false, ms: null }), (x.dnsDirect = { ok: false, ms: null })),
        (x) => ((x.tcp443 = { byIp: false, byName: false }), (x.web = { portal: false, status: null, error: 'x', clockSkewMin: null })),
        (x) => ((x.wifi!.signalDbm = -85), (x.internetPing = ping(300, 20))),
        (x) => (x.target = { name: 'a.example', resolved: true, port443: true, status: null, error: 'it timed out' }),
      ];
      for (const v of variants) {
        const x = healthy();
        v(x);
        stackReport(x, all).steps.forEach((s) => s.next.forEach((n) => named.add(n.tool)));
      }
      expect([...named].filter((t) => !real.has(t))).toEqual([]);
      expect(named.size).toBeGreaterThan(8);
    } finally {
      await cleanup();
    }
  });
});
