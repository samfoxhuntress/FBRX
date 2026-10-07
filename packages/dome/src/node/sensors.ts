import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { inCidr, intToIPv4, ipv4ToInt } from '@fbrx/shared';
import type { GateConfig } from '@fbrx/gate';
import { parseLeases, runCommand, type Runner } from '@fbrx/gate/node';
import { parseConntrackLine, parseDnsmasqLine, parseNeighbors } from '../parse';
import { DOME_TEST_DOMAIN, type DomeEvent, type DomeSensorStatus } from '../types';

/** Something MiniDome listens to. */
export interface DomeSensor {
  readonly name: string;
  start(emit: (e: DomeEvent) => void): void;
  stop(): void;
  status(): DomeSensorStatus;
}

// ----------------------------------------------------------------------------------------- DNS question log

/** Follows dnsmasq's question log (from its end; a rotated or emptied log is followed from its start). */
export class DnsLogSensor implements DomeSensor {
  readonly name = 'Names asked (dnsmasq log)';
  private timer: NodeJS.Timeout | null = null;
  private offset = -1;
  private rest = '';
  private lines = 0;

  constructor(
    private readonly file: string,
    private readonly everyMs = 1000,
  ) {}

  start(emit: (e: DomeEvent) => void) {
    const tick = () => {
      if (!existsSync(this.file)) return;
      const size = statSync(this.file).size;
      if (this.offset < 0 || size < this.offset) this.offset = this.offset < 0 ? size : 0;
      if (size === this.offset) return;
      const fd = openSync(this.file, 'r');
      try {
        const len = Math.min(size - this.offset, 8 * 1024 * 1024);
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, this.offset);
        this.offset += len;
        const text = this.rest + buf.toString('utf8');
        const parts = text.split('\n');
        this.rest = parts.pop() ?? '';
        const at = Date.now();
        for (const line of parts) {
          const e = parseDnsmasqLine(line, at);
          if (e) {
            this.lines++;
            emit(e);
          }
        }
      } finally {
        closeSync(fd);
      }
    };
    tick();
    this.timer = setInterval(() => {
      try {
        tick();
      } catch {
        /* the log comes and goes with rotation */
      }
    }, this.everyMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): DomeSensorStatus {
    return existsSync(this.file)
      ? { name: this.name, ok: true, detail: `${this.lines.toLocaleString()} names read from ${this.file}` }
      : { name: this.name, ok: false, detail: `No question log yet (${this.file}): turn on "Keep a log of questions" under DNS & VPN, and commit` };
  }
}

// ----------------------------------------------------------------------------------------- connections

/**
 * New connections through the gate: conntrack's event stream when the conntrack tool is there, otherwise the
 * kernel's connection table read every few seconds (connections that come and go between two reads are missed).
 */
export class ConntrackSensor implements DomeSensor {
  readonly name = 'Connections (conntrack)';
  private child: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private restart: NodeJS.Timeout | null = null;
  private stopped = true;
  private mode: 'events' | 'table' | 'none' = 'none';
  private flows = 0;
  private seen = new Set<string>();
  private error: string | null = null;

  /** `command` and `args` run the event stream some other way (tests: inside a network namespace). */
  constructor(private readonly o: { table?: string; everyMs?: number; command?: string; args?: string[] } = {}) {}

  start(emit: (e: DomeEvent) => void) {
    this.stopped = false;
    const onLine = (line: string) => {
      const e = parseConntrackLine(line);
      if (e) {
        this.flows++;
        emit(e);
      }
    };
    const poll = () => {
      const table = this.o.table ?? '/proc/net/nf_conntrack';
      if (!existsSync(table)) {
        this.mode = 'none';
        this.error = 'Neither the conntrack tool nor the kernel connection table is available';
        return;
      }
      this.mode = 'table';
      const next = new Set<string>();
      for (const line of readFileSync(table, 'utf8').split('\n')) {
        const e = parseConntrackLine(line);
        if (!e) continue;
        const key = `${e.proto} ${e.src} ${e.dst} ${/\bsport=(\d+)/.exec(line)?.[1] ?? ''} ${e.dport}`;
        next.add(key);
        if (!this.seen.has(key)) {
          this.flows++;
          emit(e);
        }
      }
      this.seen = next;
    };
    const events = () => {
      if (this.stopped) return;
      const child = spawn(this.o.command ?? 'conntrack', this.o.args ?? ['-E', '-e', 'NEW'], { stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      let rest = '';
      let errText = '';
      let alive = false;
      child.stdout!.on('data', (d: Buffer) => {
        alive = true;
        this.mode = 'events';
        this.error = null;
        const parts = (rest + d.toString('utf8')).split('\n');
        rest = parts.pop() ?? '';
        for (const l of parts) onLine(l);
      });
      child.stderr!.on('data', (d: Buffer) => (errText = (errText + d.toString('utf8')).slice(-400)));
      let done = false;
      const fallback = (why: string) => {
        if (done) return;
        done = true;
        this.child = null;
        if (this.stopped) return;
        this.error = why;
        if (!this.timer) {
          poll();
          this.timer = setInterval(() => {
            try {
              poll();
            } catch {
              /* try again */
            }
          }, this.o.everyMs ?? 5000);
          this.timer.unref?.();
        }
        // Back to the event stream later (the tool may come with an update, or the module load).
        if (alive) {
          this.restart = setTimeout(() => {
            if (this.timer) clearInterval(this.timer);
            this.timer = null;
            events();
          }, 30_000);
          this.restart.unref?.();
        }
      };
      child.on('error', (e) => fallback(`conntrack: ${e.message}`));
      child.on('exit', (code) => fallback(`conntrack stopped (${code ?? 'signal'}) ${errText.trim().split('\n').pop() ?? ''}`.trim()));
    };
    events();
  }

  stop() {
    this.stopped = true;
    this.child?.kill();
    this.child = null;
    if (this.timer) clearInterval(this.timer);
    if (this.restart) clearTimeout(this.restart);
    this.timer = null;
    this.restart = null;
  }

  status(): DomeSensorStatus {
    if (this.mode === 'events') return { name: this.name, ok: true, detail: `${this.flows.toLocaleString()} new connections (event stream)` };
    if (this.mode === 'table') return { name: this.name, ok: true, detail: `${this.flows.toLocaleString()} new connections (connection table every few seconds; install conntrack to see them all)` };
    return { name: this.name, ok: false, detail: this.error ?? 'Starting' };
  }
}

// ------------------------------------------------------------------------------- neighbors and leases

/** The gate's neighbor table (who has which address on the wire) and its DHCP leases, every few seconds. */
export class DevicesSensor implements DomeSensor {
  readonly name = 'Devices (neighbors and leases)';
  private timer: NodeJS.Timeout | null = null;
  private lastCount = 0;
  private error: string | null = null;

  constructor(
    private readonly o: { leases: string; gate: () => GateConfig | null; run?: Runner; everyMs?: number },
  ) {}

  start(emit: (e: DomeEvent) => void) {
    const run = this.o.run ?? runCommand;
    const tick = async () => {
      const at = Date.now();
      const c = this.o.gate();
      let n = 0;
      if (existsSync(this.o.leases)) {
        for (const l of parseLeases(readFileSync(this.o.leases, 'utf8'), c)) {
          n++;
          emit({ type: 'lease', at, ip: l.address, mac: l.mac, name: l.name, network: l.network });
        }
      }
      const r = await run('ip', ['-j', 'neigh', 'show']);
      if (r.code === 0) {
        this.error = null;
        for (const e of parseNeighbors(r.out, at)) {
          n++;
          emit(e);
        }
      } else this.error = r.err.trim() || 'ip neigh failed';
      this.lastCount = n;
    };
    void tick().catch(() => undefined);
    this.timer = setInterval(() => void tick().catch(() => undefined), this.o.everyMs ?? 15_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): DomeSensorStatus {
    return this.error ? { name: this.name, ok: false, detail: this.error } : { name: this.name, ok: true, detail: `${this.lastCount} addresses at the last look` };
  }
}

// ------------------------------------------------------------------------------------------- simulated

/**
 * For the console's demo and development: a small household on the gate's first network, living its life, with a
 * few of the things MiniDome is there for happening a little after the start (a known-bad name, made-up names, a
 * device with its own DNS, one checking in like clockwork, a port scan, two devices fighting over an address).
 */
export class SimulatedSensor implements DomeSensor {
  readonly name = 'Simulated network';
  private timers: NodeJS.Timeout[] = [];
  private events = 0;

  constructor(
    private readonly gate: () => GateConfig | null,
    private readonly speed = 1,
  ) {}

  start(emit: (e: DomeEvent) => void) {
    const c = this.gate();
    const net = c?.networks.find((n) => n.dhcp.enabled) ?? null;
    const base = net ? ipv4ToInt(net.dhcp.start) : ipv4ToInt('192.168.1.100');
    const people = ['laptop', 'phone', 'tablet', 'printer', 'tv', 'camera'].map((name, i) => ({
      name,
      ip: intToIPv4(base + i),
      mac: `02:fb:10:00:00:${(i + 1).toString(16).padStart(2, '0')}`,
    }));
    const send = (e: DomeEvent) => {
      this.events++;
      emit(e);
    };
    const later = (ms: number, fn: () => void) => this.timers.push(setTimeout(fn, ms / this.speed));
    const every = (ms: number, fn: () => void) => {
      const t = setInterval(fn, ms / this.speed);
      t.unref?.();
      this.timers.push(t);
    };
    const now = () => Date.now();
    for (const p of people) send({ type: 'lease', at: now(), ip: p.ip, mac: p.mac, name: p.name, network: net?.name ?? 'lan' });
    const everyday = ['www.example.com', 'mail.example.org', 'cdn.example.net', 'api.example.com', 'time.example.org', 'news.example.net', 'video.example.com'];
    every(400, () => {
      const p = people[Math.floor(Math.random() * people.length)];
      send({ type: 'dns', at: now(), client: p.ip, name: everyday[Math.floor(Math.random() * everyday.length)], qtype: Math.random() < 0.8 ? 'A' : 'AAAA' });
      send({ type: 'flow', at: now(), proto: 'tcp', src: p.ip, dst: `93.184.216.${10 + Math.floor(Math.random() * 30)}`, dport: 443 });
    });
    every(15_000, () => {
      for (const p of people) send({ type: 'neighbor', at: now(), ip: p.ip, mac: p.mac, dev: net?.interface ?? null });
    });
    const [laptop, phone, tablet, printer, tv, camera] = people;
    // A known-bad name (the MiniDome test name, always on its list).
    later(4000, () => send({ type: 'dns', at: now(), client: phone.ip, name: DOME_TEST_DOMAIN, qtype: 'A' }));
    // Made-up names that do not exist.
    later(9000, () => {
      for (let i = 0; i < 9; i++) {
        const name = `${Math.random().toString(36).slice(2, 9)}${Math.random().toString(36).slice(2, 9)}q.com`;
        send({ type: 'dns', at: now(), client: printer.ip, name, qtype: 'A' });
        send({ type: 'nxdomain', at: now(), client: printer.ip, name });
      }
    });
    // Its own DNS server.
    later(14_000, () => send({ type: 'flow', at: now(), proto: 'udp', src: tv.ip, dst: '198.51.100.53', dport: 53 }));
    // Checking in every five minutes for the last forty (told at once).
    later(19_000, () => {
      const t = now();
      for (let i = 9; i >= 0; i--) send({ type: 'flow', at: t - i * 300_000 + Math.round(Math.random() * 3000), proto: 'tcp', src: camera.ip, dst: '203.0.113.77', dport: 8883 });
    });
    // A port scan of the printer.
    later(25_000, () => {
      const t = now();
      for (let port = 20; port < 60; port++) send({ type: 'flow', at: t + port * 10, proto: 'tcp', src: tablet.ip, dst: printer.ip, dport: port });
    });
    // Someone answering for the laptop's address, back and forth.
    later(31_000, () => {
      const t = now();
      const other = '02:fb:10:00:00:99';
      [other, laptop.mac, other].forEach((mac, i) => send({ type: 'neighbor', at: t + i * 1000, ip: laptop.ip, mac, dev: net?.interface ?? null }));
    });
  }

  stop() {
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers = [];
  }

  status(): DomeSensorStatus {
    return { name: this.name, ok: true, detail: `${this.events.toLocaleString()} pretend events (nothing on this computer is watched)` };
  }
}

/** Whether an address is in one of the gate's networks. */
export function inGateNetworks(ip: string, c: GateConfig | null): string | null {
  return c?.networks.find((n) => inCidr(ip, n.address))?.name ?? null;
}
