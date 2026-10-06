import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { HwFlows } from '@fbrx/shared';
import { pciOwner } from './topology';

interface Counter {
  id: string;
  kind: 'network' | 'disk';
  device: string | null;
  rx: number;
  tx: number;
}

const num = (p: string) => {
  try {
    return Number(readFileSync(p, 'utf8').trim()) || 0;
  } catch {
    return 0;
  }
};

/** Byte counters for every physical network port and disk (virtual ones, such as VM taps and loops, are skipped). */
export function readCounters(root = '/'): Counter[] {
  const out: Counter[] = [];
  const net = join(root, 'sys/class/net');
  let names: string[] = [];
  try {
    names = readdirSync(net);
  } catch {
    /* none */
  }
  for (const n of names) {
    let device: string | null = null;
    try {
      device = pciOwner(realpathSync(join(net, n)));
    } catch {
      /* gone */
    }
    if (!device) continue;
    out.push({ id: n, kind: 'network', device, rx: num(join(net, n, 'statistics/rx_bytes')), tx: num(join(net, n, 'statistics/tx_bytes')) });
  }
  const block = join(root, 'sys/block');
  try {
    names = readdirSync(block);
  } catch {
    names = [];
  }
  for (const b of names) {
    if (/^(loop|ram|zram|dm-|md|sr|nbd)/.test(b)) continue;
    let device: string | null = null;
    try {
      device = pciOwner(realpathSync(join(block, b)));
    } catch {
      /* gone */
    }
    let stat: number[] = [];
    try {
      stat = readFileSync(join(block, b, 'stat'), 'utf8').trim().split(/\s+/).map(Number);
    } catch {
      continue;
    }
    // Fields 3 and 7: sectors read and written (512 bytes each, whatever the disk's own sector size).
    out.push({ id: b, kind: 'disk', device, rx: (stat[2] ?? 0) * 512, tx: (stat[6] ?? 0) * 512 });
  }
  return out;
}

/**
 * Live throughput: bytes per second through each network port and disk since the last look. The first look (or one
 * after a long pause) measures over half a second.
 */
export class FlowSampler {
  private last: { at: number; counters: Map<string, Counter> } | null = null;

  constructor(private readonly root = '/') {}

  private get sample(): boolean {
    return !existsSync(join(this.root, 'sys/bus/pci/devices'));
  }

  async flows(): Promise<HwFlows> {
    if (this.sample) return sampleFlows();
    if (!this.last || Date.now() - this.last.at > 30_000) {
      this.last = { at: Date.now(), counters: new Map(readCounters(this.root).map((c) => [c.id, c])) };
      await new Promise((r) => setTimeout(r, 500));
    }
    const now = Date.now();
    const counters = readCounters(this.root);
    const prev = this.last;
    this.last = { at: now, counters: new Map(counters.map((c) => [c.id, c])) };
    const secs = Math.max(0.001, (now - prev.at) / 1000);
    return {
      at: new Date(now).toISOString(),
      intervalMs: now - prev.at,
      items: counters.map((c) => {
        const p = prev.counters.get(c.id);
        const rate = (a: number, b: number | undefined) => (b === undefined || a < b ? 0 : Math.round((a - b) / secs));
        return { id: c.id, kind: c.kind, device: c.device, rxBps: rate(c.rx, p?.rx), txBps: rate(c.tx, p?.tx) };
      }),
    };
  }
}

/** Moving numbers for the sample server. */
export function sampleFlows(): HwFlows {
  const t = Date.now() / 1000;
  const wave = (speed: number, phase: number, peak: number) => Math.round(((Math.sin(t * speed + phase) + 1.2) / 2.2) * peak);
  return {
    at: new Date().toISOString(),
    intervalMs: 1000,
    items: [
      { id: 'eno1', kind: 'network', device: '0000:02:00.0', rxBps: wave(0.7, 0, 60e6), txBps: wave(0.5, 1, 18e6) },
      { id: 'eno2', kind: 'network', device: '0000:02:00.1', rxBps: wave(0.3, 2, 4e6), txBps: wave(0.4, 3, 2e6) },
      { id: 'sda', kind: 'disk', device: '0000:01:00.0', rxBps: wave(0.6, 1, 120e6), txBps: wave(0.8, 2, 45e6) },
      { id: 'sdb', kind: 'disk', device: '0000:01:00.0', rxBps: wave(0.2, 0, 20e6), txBps: wave(0.3, 1, 8e6) },
      { id: 'sdc', kind: 'disk', device: '0000:00:17.0', rxBps: wave(0.1, 0, 2e6), txBps: wave(0.15, 0, 1e6) },
    ],
  };
}
