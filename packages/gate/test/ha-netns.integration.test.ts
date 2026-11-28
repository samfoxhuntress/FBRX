import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GateConfigSchema, haMac, starterConfig, type GateConfig, type GateHa } from '../src/index';
import { GateEngine, GateHaSwitch, GateStore, LinuxApplier, runCommand } from '../src/node/index';

/**
 * FBRX Gate in a high-availability pair, inside Linux network namespaces: an "internet" host and two gates on one
 * internet segment, the two gates and a client on one LAN. The client downloads from the internet through gate A;
 * gate A is pulled from both networks in the middle of it and gate B takes over (its gateway link and internet port
 * up, with the pair's MAC addresses). The download must carry on. Needs root, iproute2 and nftables, and conntrackd
 * for the download (CI runs it with sudo; it is skipped elsewhere).
 */
const can = process.platform === 'linux' && process.getuid?.() === 0 && ['ip', 'nft'].every((c) => spawnSync(c, ['-V']).error === undefined);

const id = process.pid % 100000;
const NS = { sw: `has${id}`, inet: `hai${id}`, a: `haa${id}`, b: `hab${id}`, client: `hac${id}` };
const ip = (...a: string[]) => execFileSync('ip', a, { encoding: 'utf8' });
const inNs = (ns: string, cmd: string, ...a: string[]) => execFileSync('ip', ['netns', 'exec', ns, cmd, ...a], { encoding: 'utf8', timeout: 20_000 });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// DHCP is off in this test; where dnsmasq is not installed its configuration check is taken as passed.
const dnsmasq = spawnSync('dnsmasq', ['--version']).error === undefined;
// Keeping a download going needs the open connections in step (conntrackd): CI installs it.
const conntrackd = spawnSync('conntrackd', ['-v']).error === undefined;

// A slow download: the server sends a numbered line every 50 ms; the client notes the longest gap and how it ended.
const TOOL = `
import net from 'node:net';
import { writeFileSync } from 'node:fs';
const [mode, a, b, c, d] = process.argv.slice(2);
if (mode === 'serve') net.createServer((s) => { let i = 0; const t = setInterval(() => s.write(String(i++) + '\\n'), 50); s.on('error', () => clearInterval(t)); s.on('close', () => clearInterval(t)); }).listen(Number(b), a);
if (mode === 'download') {
  const out = { lines: 0, maxGapMs: 0, error: null, ended: false };
  let last = Date.now();
  const s = net.connect({ host: a, port: Number(b) });
  s.on('data', (x) => { const now = Date.now(); out.maxGapMs = Math.max(out.maxGapMs, now - last); last = now; out.lines += String(x).split('\\n').length - 1; });
  s.on('error', (e) => { out.error = e.code; });
  s.on('close', () => { out.ended = true; writeFileSync(d, JSON.stringify(out)); process.exit(0); });
  setTimeout(() => { writeFileSync(d, JSON.stringify(out)); process.exit(0); }, Number(c));
}
`;

describe.runIf(can)('FBRX Gate in a high-availability pair (network namespaces)', () => {
  let dir = '';
  let tool = '';
  const procs: ChildProcess[] = [];
  const gates: Record<'a' | 'b', { engine: GateEngine; store: GateStore; applier: LinuxApplier; ha: GateHa; switch: GateHaSwitch; serving: boolean }> = {} as never;
  let config: GateConfig;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fbrx-gate-ha-'));
    tool = join(dir, 'tool.mjs');
    writeFileSync(tool, TOOL);
    for (const ns of Object.values(NS)) ip('netns', 'add', ns);
    // The switch: one bridge for the internet side, one for the LAN.
    inNs(NS.sw, 'ip', 'link', 'add', 'brw', 'type', 'bridge');
    inNs(NS.sw, 'ip', 'link', 'add', 'brl', 'type', 'bridge');
    inNs(NS.sw, 'ip', 'link', 'set', 'brw', 'up');
    inNs(NS.sw, 'ip', 'link', 'set', 'brl', 'up');
    const cable = (ns: string, name: string, bridge: string, port: string) => {
      ip('link', 'add', port, 'netns', NS.sw, 'type', 'veth', 'peer', 'name', name, 'netns', ns);
      inNs(NS.sw, 'ip', 'link', 'set', port, 'master', bridge);
      inNs(NS.sw, 'ip', 'link', 'set', port, 'up');
    };
    cable(NS.inet, 'eth0', 'brw', 'pi');
    cable(NS.a, 'wan0', 'brw', 'paw');
    cable(NS.b, 'wan0', 'brw', 'pbw');
    cable(NS.a, 'lan0', 'brl', 'pal');
    cable(NS.b, 'lan0', 'brl', 'pbl');
    cable(NS.client, 'eth0', 'brl', 'pc');
    for (const ns of Object.values(NS)) inNs(ns, 'ip', 'link', 'set', 'lo', 'up');
    inNs(NS.inet, 'ip', 'addr', 'add', '203.0.113.1/24', 'dev', 'eth0');
    inNs(NS.inet, 'ip', 'link', 'set', 'eth0', 'up');
    inNs(NS.client, 'ip', 'addr', 'add', '192.168.77.10/24', 'dev', 'eth0');
    inNs(NS.client, 'ip', 'link', 'set', 'eth0', 'up');
    inNs(NS.client, 'ip', 'route', 'add', 'default', 'via', '192.168.77.1');
    procs.push(spawn('ip', ['netns', 'exec', NS.inet, process.execPath, tool, 'serve', '203.0.113.1', '8080'], { stdio: 'ignore' }));

    config = GateConfigSchema.parse(starterConfig({ hostname: 'office-gate', wan: 'wan0', lan: 'lan0', lanAddress: '192.168.77.1/24', wanStatic: { address: '203.0.113.2/24', gateway: '203.0.113.1' } }));
    config.networks[0]!.dhcp.enabled = false;
    for (const [k, own, other] of [['a', '192.168.77.2', '192.168.77.3'], ['b', '192.168.77.3', '192.168.77.2']] as const) {
      const ns = k === 'a' ? NS.a : NS.b;
      const paths = { varDir: join(dir, k, 'var'), logDir: join(dir, k, 'log'), etcDir: join(dir, k, 'etc') };
      const inGate = (cmd: string, args: string[]) => runCommand('ip', ['netns', 'exec', ns, cmd, ...args]);
      const applier = new LinuxApplier({
        paths,
        mode: 'iproute',
        root: join(dir, k, 'root'),
        dnsmasqConf: join(dir, k, 'dnsmasq.conf'),
        run: (cmd, args) => ((cmd === 'dnsmasq' && !dnsmasq) || (cmd === 'conntrackd' && !conntrackd) ? Promise.resolve({ code: 0, out: '', err: '' }) : inGate(cmd, args)),
        restartDns: async () => undefined,
        stopDns: async () => undefined,
        // conntrackd in the gate's namespace (its lock file and socket in the gate's own folder).
        restartConntrackd: async (conf) => {
          if (!conntrackd) return;
          await inGate('conntrackd', ['-C', conf, '-k']);
          await wait(200);
          const r = await inGate('conntrackd', ['-C', conf, '-d']);
          if (r.code !== 0) console.log(`conntrackd (${k}) did not start: ${r.err || r.out}`);
        },
      });
      const ha: GateHa = { own: { lan: `${own}/24` }, vrid: 7, heartbeatPort: 9454, link: null, partner: [other], sync: { iface: 'lan0', own, partner: other } };
      const store = new GateStore(join(dir, `${k}.db`));
      const g = { engine: null as unknown as GateEngine, store, applier, ha, switch: new GateHaSwitch(applier), serving: k === 'a' };
      g.engine = new GateEngine({
        store,
        applier,
        paths,
        initial: () => config,
        ha: () => ({ paired: true, serving: g.serving, ha }),
        onApplied: async (c) => void (g.serving ? await g.switch.up(c, ha) : await g.switch.down(c, ha)),
      });
      gates[k] = g;
      // Both have the same configuration (on the standby, it is the copy).
      expect((await g.engine.commit({ by: 'test', comment: 'Office' })).status).toBe('confirmed');
    }
  }, 60_000);

  afterAll(() => {
    for (const p of procs) p.kill();
    if (conntrackd) for (const [ns, k] of [[NS.a, 'a'], [NS.b, 'b']]) spawnSync('ip', ['netns', 'exec', ns!, 'conntrackd', '-C', join(dir, k!, 'root/etc/conntrackd/conntrackd.conf'), '-k']);
    for (const g of Object.values(gates)) g.store.close();
    for (const ns of Object.values(NS)) spawnSync('ip', ['netns', 'del', ns]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves from the active gate only: its gateway link and internet port are up, the standby’s are down', () => {
    const link = (ns: string, dev: string) => inNs(ns, 'ip', '-br', 'link', 'show', 'dev', dev);
    expect(link(NS.a, 'fbrxv0')).toMatch(/UP/);
    expect(link(NS.a, 'fbrxv0').toLowerCase()).toContain(haMac(7, 1));
    expect(link(NS.b, 'fbrxv0')).toMatch(/DOWN/);
    expect(link(NS.b, 'wan0')).toMatch(/DOWN/);
    // Each has its own address on the LAN; the gateway address is on the active one's link.
    expect(inNs(NS.a, 'ip', '-4', '-br', 'addr', 'show', 'dev', 'lan0')).toContain('192.168.77.2/24');
    expect(inNs(NS.b, 'ip', '-4', '-br', 'addr', 'show', 'dev', 'lan0')).toContain('192.168.77.3/24');
    expect(inNs(NS.a, 'ip', '-4', '-br', 'addr', 'show', 'dev', 'fbrxv0')).toContain('192.168.77.1/24');
    // The firewall counts the gateway link as the LAN.
    expect(inNs(NS.a, 'nft', 'list', 'table', 'inet', 'fbrx_gate')).toMatch(/iifname \{ "lan0", "fbrxv0" \} oifname "wan0" accept comment "internet:lan"/);
  });

  it.runIf(conntrackd)('keeps a download going when the active gate is pulled in the middle of it', async () => {
    const out = join(dir, 'download.json');
    const client = spawn('ip', ['netns', 'exec', NS.client, process.execPath, tool, 'download', '203.0.113.1', '8080', '7000', out], { stdio: 'ignore' });
    procs.push(client);
    const exited = new Promise((r) => client.once('exit', r));
    await wait(2000);
    // What each conntrackd has (printed, for when this fails in CI).
    const ctd = async (k: 'a' | 'b', flag: string) => {
      const r = await runCommand('ip', ['netns', 'exec', k === 'a' ? NS.a : NS.b, 'conntrackd', '-C', gates[k].applier.conntrackdConf, flag]);
      return `${r.code} ${(r.out + r.err).trim().slice(0, 1500)}`;
    };
    console.log('A conntrackd stats:', await ctd('a', '-s'));
    // Gate A loses power: off both networks at once. Gate B takes over.
    inNs(NS.a, 'ip', 'link', 'set', 'wan0', 'down');
    inNs(NS.a, 'ip', 'link', 'set', 'lan0', 'down');
    console.log('B external cache:', await ctd('b', '-e'));
    const t0 = performance.now();
    gates.b.serving = true;
    const steps = await gates.b.switch.up(gates.b.engine.running()!, gates.b.ha);
    const took = performance.now() - t0;
    console.log('B steps:', steps.join(' | '));
    console.log('B table:', (await runCommand('ip', ['netns', 'exec', NS.b, 'conntrack', '-L'])).out.slice(0, 1500));
    console.log('B log:', (() => { try { return readFileSync(join(dir, 'b', 'log', 'conntrackd.log'), 'utf8').slice(-2500); } catch (e) { return String(e); } })());
    expect(took).toBeLessThan(1000);
    expect(steps.join(' | ')).toMatch(/Open connections taken over from the other server.*gateway address moved here and was announced: 192\.168\.77\.1 \(lan\)/);
    await exited;
    const r = JSON.parse(readFileSync(out, 'utf8')) as { lines: number; maxGapMs: number; error: string | null; ended: boolean };
    // Still going, not broken off, and the gap was short.
    expect(r.error).toBeNull();
    expect(r.ended).toBe(false);
    expect(r.lines).toBeGreaterThan(80);
    expect(r.maxGapMs).toBeLessThan(3000);
    // The client never had to learn a new MAC address for its gateway.
    expect(inNs(NS.client, 'ip', 'neigh', 'show', '192.168.77.1').toLowerCase()).toContain(haMac(7, 1));
  }, 30_000);
});
