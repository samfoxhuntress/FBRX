import { cpus, freemem, homedir, hostname, totalmem, uptime as osUptime } from 'node:os';
import si from 'systeminformation';
import type { ProcessInfo, SystemLive, SystemStatic } from '@fbrx/shared';
import { CoreError, errorMessage } from '../errors';
import type { EventBus } from '../events';
import type { Logger } from '../logger';
import { IS_WIN } from '../windows/ps';

const HISTORY = 180; // 6 minutes at 2 s
const TICK_MS = 2000;
/** While no window shows the numbers, sample every 10 s (the alert rules average over minutes anyway). */
const BACKGROUND_TICK_MS = 10_000;
/** Windows reads interface counters, battery, swap and temperature by starting PowerShell, so read them less often. */
const NET_EVERY_MS = IS_WIN ? 10_000 : 0;
const SLOW_EVERY_MS = IS_WIN ? 90_000 : 30_000;

/** Processes FBRX refuses to end: killing them crashes or logs off Windows. */
const PROTECTED = /^(system|idle|registry|smss|csrss|wininit|winlogon|services|lsass|lsaiso|svchost|fontdrvhost|dwm|memory compression|secure system|launchd|kernel_task|init|systemd)(\.exe)?$/i;

/**
 * Live system metrics: CPU (overall and per core), memory, swap, network throughput, battery and temperature,
 * sampled every 2 seconds while anyone is watching (the dashboard, the alert engine, a mesh phone).
 */
export class SystemMonitor {
  private timer: NodeJS.Timeout | null = null;
  private prevCpu: Array<{ idle: number; total: number }> | null = null;
  private readonly history: SystemLive[] = [];
  private staticCache: { at: number; value: SystemStatic } | null = null;
  private slow = { swapUsed: 0, swapTotal: 0, battery: null as SystemLive['battery'], tempC: null as number | null, at: 0 };
  private ticks = 0;
  private sampling = false;
  private net = { rx: 0, tx: 0, at: 0 };
  private background = false;
  /** Sensors this computer does not have stop being asked for (each ask is a PowerShell process on Windows). */
  private noBattery = false;
  private tempMisses = 0;

  constructor(
    private readonly events: EventBus,
    private readonly log: Logger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sample(), this.background ? BACKGROUND_TICK_MS : TICK_MS);
    this.timer.unref?.();
    void this.sample();
  }

  /** Slows sampling down while the app is hidden or minimized, and back to every 2 s when it is shown. */
  setBackground(background: boolean): void {
    if (this.background === background) return;
    this.background = background;
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.start();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get current(): SystemLive | null {
    return this.history[this.history.length - 1] ?? null;
  }

  live(): { current: SystemLive | null; history: SystemLive[] } {
    return { current: this.current, history: [...this.history] };
  }

  /** Average of a metric over the last `seconds`. */
  average(metric: 'cpu' | 'mem', seconds: number): number | null {
    const since = Date.now() - seconds * 1000;
    const pts = this.history.filter((h) => h.ts >= since);
    if (pts.length < Math.min(5, (seconds * 1000) / (this.background ? BACKGROUND_TICK_MS : TICK_MS))) return null;
    const v = (h: SystemLive) => (metric === 'cpu' ? h.cpu : (h.memUsed / Math.max(1, h.memTotal)) * 100);
    return pts.reduce((a, h) => a + v(h), 0) / pts.length;
  }

  private cpuSample(): { overall: number; cores: number[] } {
    const now = cpus().map((c) => {
      const t = c.times;
      return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
    });
    const prev = this.prevCpu;
    this.prevCpu = now;
    if (!prev || prev.length !== now.length) return { overall: 0, cores: now.map(() => 0) };
    const cores = now.map((c, i) => {
      const dt = c.total - prev[i].total;
      return dt > 0 ? Math.max(0, Math.min(100, (1 - (c.idle - prev[i].idle) / dt) * 100)) : 0;
    });
    return { overall: cores.reduce((a, b) => a + b, 0) / Math.max(1, cores.length), cores };
  }

  private async sample(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      this.ticks++;
      const cpu = this.cpuSample();
      // Windows reads interface counters through a PowerShell process, so sample them every 10 s there (every 30 s
      // in the background; the rates are per second either way). The library's shared persistent PowerShell is not
      // used: it is process-global and releasing it while another monitor still samples breaks its pipe.
      if (Date.now() - this.net.at >= (this.background ? NET_EVERY_MS * 3 : NET_EVERY_MS)) {
        this.net.at = Date.now();
        try {
          const stats = await si.networkStats('*');
          let rx = 0;
          let tx = 0;
          for (const s of stats) {
            if (s.rx_sec && s.rx_sec > 0) rx += s.rx_sec;
            if (s.tx_sec && s.tx_sec > 0) tx += s.tx_sec;
          }
          this.net = { rx, tx, at: this.net.at };
        } catch {
          /* no network stats on this system */
        }
      }
      const netRx = this.net.rx;
      const netTx = this.net.tx;
      if (Date.now() - this.slow.at > SLOW_EVERY_MS) {
        this.slow.at = Date.now();
        const [mem, bat, temp] = await Promise.all([
          si.mem().catch(() => null),
          this.noBattery ? null : si.battery().catch(() => null),
          // Most Windows PCs only report a temperature to administrators; stop asking after three blanks.
          this.tempMisses >= 3 ? null : si.cpuTemperature().catch(() => null),
        ]);
        if (mem) {
          this.slow.swapUsed = mem.swapused;
          this.slow.swapTotal = mem.swaptotal;
        }
        if (bat && !bat.hasBattery) this.noBattery = true;
        this.slow.battery = bat?.hasBattery ? { percent: Math.round(bat.percent), charging: !!bat.isCharging || !!bat.acConnected } : null;
        if (this.tempMisses < 3) {
          this.slow.tempC = temp && typeof temp.main === 'number' && temp.main > 0 ? Math.round(temp.main) : null;
          this.tempMisses = this.slow.tempC == null ? this.tempMisses + 1 : 0;
        }
      }
      const total = totalmem();
      const point: SystemLive = {
        ts: Date.now(),
        cpu: Math.round(cpu.overall * 10) / 10,
        cores: cpu.cores.map((c) => Math.round(c)),
        memUsed: total - freemem(),
        memTotal: total,
        swapUsed: this.slow.swapUsed,
        swapTotal: this.slow.swapTotal,
        netRx: Math.round(netRx),
        netTx: Math.round(netTx),
        battery: this.slow.battery,
        tempC: this.slow.tempC,
        uptime: Math.round(osUptime()),
      };
      this.history.push(point);
      if (this.history.length > HISTORY) this.history.shift();
      this.events.emit('sysinfo.live', point);
    } catch (err) {
      if (this.ticks % 30 === 1) this.log.debug('System sample failed', { error: errorMessage(err) });
    } finally {
      this.sampling = false;
    }
  }

  async static(): Promise<SystemStatic> {
    if (this.staticCache && Date.now() - this.staticCache.at < 10 * 60_000) return this.staticCache.value;
    const [os, cpu, gfx, fsz, sys, bat] = await Promise.all([
      si.osInfo().catch(() => null),
      si.cpu().catch(() => null),
      si.graphics().catch(() => null),
      si.fsSize().catch(() => []),
      si.system().catch(() => null),
      si.battery().catch(() => null),
    ]);
    const value: SystemStatic = {
      os: {
        name: os?.distro || process.platform,
        version: os?.release ?? '',
        build: os?.build ?? '',
        arch: os?.arch ?? process.arch,
        hostname: os?.hostname || hostname(),
      },
      cpu: {
        model: cpu ? `${cpu.manufacturer} ${cpu.brand}`.trim() : (cpus()[0]?.model ?? 'Unknown'),
        cores: cpu?.physicalCores ?? cpus().length,
        threads: cpu?.cores ?? cpus().length,
        speedGHz: cpu?.speed ?? null,
      },
      memoryTotal: totalmem(),
      gpus: (gfx?.controllers ?? []).map((g) => ({ model: g.model, vramMB: g.vram ?? null })),
      disks: (fsz ?? [])
        .filter((d) => d.size > 1e9 && !/^\/(snap|boot|run|dev|sys|proc)/.test(d.mount))
        .map((d) => ({ mount: d.mount, label: d.fs, fs: d.type, size: d.size, used: d.used })),
      machine: { manufacturer: sys?.manufacturer ?? '', model: sys?.model ?? '' },
      hasBattery: !!bat?.hasBattery,
    };
    this.staticCache = { at: Date.now(), value };
    return value;
  }

  async processes(p: { sort?: 'cpu' | 'memory'; filter?: string; limit?: number } = {}): Promise<{ total: number; list: ProcessInfo[] }> {
    const data = await si.processes();
    const f = p.filter?.trim().toLowerCase();
    let list: ProcessInfo[] = data.list
      .filter((x) => x.pid > 0)
      .map((x) => ({
        pid: x.pid,
        name: x.name,
        cpu: Math.round((x.cpu ?? 0) * 10) / 10,
        memBytes: (x.memRss ?? 0) * 1024,
        user: x.user ?? '',
        path: x.path ? `${x.path}` : (x.command ?? ''),
        started: x.started ?? '',
      }));
    if (f) list = list.filter((x) => x.name.toLowerCase().includes(f) || String(x.pid) === f || x.path.toLowerCase().includes(f));
    list.sort((a, b) => (p.sort === 'memory' ? b.memBytes - a.memBytes : b.cpu - a.cpu || b.memBytes - a.memBytes));
    return { total: data.all, list: list.slice(0, Math.min(p.limit ?? 150, 1000)) };
  }

  kill(pid: number, name?: string): boolean {
    if (!Number.isInteger(pid) || pid <= 4 || pid === process.pid || pid === process.ppid) {
      throw new CoreError('FORBIDDEN', 'FBRX will not end this process');
    }
    if (name && PROTECTED.test(name)) throw new CoreError('FORBIDDEN', `${name} is a core operating-system process and cannot be ended`);
    try {
      process.kill(pid);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return false;
      if (code === 'EPERM') throw new CoreError('FORBIDDEN', 'Permission denied: the process belongs to another user or to Windows');
      throw err;
    }
  }

  static homeDir(): string {
    return homedir();
  }
}
