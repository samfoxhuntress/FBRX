import { execFile } from 'node:child_process';
import { VirtualError, conflict, notFound } from '../errors';

/**
 * Runs virsh (libvirt's command line) against the system hypervisor. Arguments are passed as a list, never through a
 * shell, so names people type cannot run anything. libvirt's own wording is kept in error messages, with the
 * "error:" prefixes taken off.
 */
export interface VirshRunner {
  (args: string[], opts?: { timeoutMs?: number }): Promise<string>;
}

export function virshRunner(uri: string, bin = 'virsh'): VirshRunner {
  return (args, opts = {}) =>
    new Promise((resolve, reject) => {
      execFile(bin, ['-c', uri, ...args], { timeout: opts.timeoutMs ?? 120_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
        reject(missing ? new VirtualError(503, 'libvirt is not installed on this server (virsh was not found)') : virshError(stderr || err.message, args));
      });
    });
}

/** Turns virsh's error text into an error with a fitting status. */
export function virshError(stderr: string, args: string[] = []): VirtualError {
  const message =
    stderr
      .split('\n')
      .map((l) => l.replace(/^error:\s*/i, '').trim())
      .filter((l) => l && !/^Failed to (?:get|start|revert|create|delete|define|attach|detach|resize|reboot|shutdown|destroy|suspend|resume|undefine)\b/i.test(l))
      .join(' ') ||
    stderr.trim() ||
    `virsh ${args[0] ?? ''} failed`;
  if (/failed to get (?:domain|network|pool|vol)|not found|no (?:domain|network|storage pool|storage vol) with matching|Storage volume not found/i.test(stderr)) return notFound(message);
  if (/already (?:running|active|exists)|is not running|not active|domain is active|in use|already in use|exists already|Requested operation is not valid/i.test(stderr)) return conflict(message);
  if (/Failed to connect socket|Cannot recv data|No such file or directory.*libvirt|authentication failed|Connection refused/i.test(stderr)) return new VirtualError(503, `Cannot reach libvirt: ${message}`);
  return new VirtualError(500, message);
}

/** "key: value" lines (dominfo, pool-info, net-info). */
export function parseInfo(out: string): Record<string, string> {
  const r: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const m = /^([^:]+):\s*(.*)$/.exec(line.trim());
    if (m) r[m[1]!.trim().toLowerCase()] = m[2]!.trim();
  }
  return r;
}

/** `domstats --raw`: one record per domain, keyed by name. */
export function parseDomstats(out: string): Map<string, Record<string, string>> {
  const all = new Map<string, Record<string, string>>();
  let cur: Record<string, string> | null = null;
  for (const line of out.split('\n')) {
    const head = /^Domain:\s*'(.*)'\s*$/.exec(line.trim());
    if (head) {
      cur = {};
      all.set(head[1]!, cur);
      continue;
    }
    const kv = /^\s*([\w.-]+)=(.*)$/.exec(line);
    if (cur && kv) cur[kv[1]!] = kv[2]!;
  }
  return all;
}

/** `domblkinfo --all`: capacity and allocation (bytes) per target; "-" for an empty CD drive. */
export function parseBlkinfo(out: string): Map<string, { capacity: number | null; allocation: number | null }> {
  const r = new Map<string, { capacity: number | null; allocation: number | null }>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\S+)\s+(\d+|-)\s+(\d+|-)\s+(\d+|-)\s*$/.exec(line);
    if (!m || m[1] === 'Target') continue;
    r.set(m[1]!, { capacity: m[2] === '-' ? null : Number(m[2]), allocation: m[3] === '-' ? null : Number(m[3]) });
  }
  return r;
}

/** `domifaddr`: the first IPv4 address per MAC. */
export function parseIfaddr(out: string): Map<string, string> {
  const r = new Map<string, string>();
  for (const line of out.split('\n')) {
    const m = /^\s*\S+\s+([0-9a-f:]{17})\s+ipv4\s+([\d.]+)\/\d+/i.exec(line);
    if (m && !r.has(m[1]!.toLowerCase())) r.set(m[1]!.toLowerCase(), m[2]!);
  }
  return r;
}

/** Table output with a dashed rule under the header: the first column of each row. */
export function firstColumn(out: string): string[] {
  const lines = out.split('\n');
  const rule = lines.findIndex((l) => /^-{3,}/.test(l.trim()));
  return lines
    .slice(rule + 1)
    .map((l) => l.trim().split(/\s+/)[0] ?? '')
    .filter(Boolean);
}

export const nonEmptyLines = (out: string) =>
  out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** libvirt's numeric domain state (state.state). */
export function stateName(n: number): import('@fbrx/shared').VmState {
  switch (n) {
    case 1:
      return 'running';
    case 2:
      return 'running'; // blocked on I/O: still running
    case 3:
      return 'paused';
    case 4:
      return 'shutting-down';
    case 5:
      return 'stopped';
    case 6:
      return 'crashed';
    case 7:
      return 'suspended';
    default:
      return 'unknown';
  }
}

/** dominfo's "State:" words. */
export function stateFromWords(s: string): import('@fbrx/shared').VmState {
  const w = s.toLowerCase();
  if (w === 'running' || w === 'idle' || w === 'blocked') return 'running';
  if (w === 'paused') return 'paused';
  if (w === 'in shutdown') return 'shutting-down';
  if (w === 'shut off') return 'stopped';
  if (w === 'crashed') return 'crashed';
  if (w === 'pmsuspended') return 'suspended';
  return 'unknown';
}
