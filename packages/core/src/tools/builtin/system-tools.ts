import { arch, cpus, freemem, hostname, loadavg, networkInterfaces, platform, release, totalmem, uptime, userInfo, version } from 'node:os';
import { statfs } from 'node:fs/promises';
import type { ToolSpec } from '../types';
import { runShell } from './shell-tools';

export interface SystemDeps {
  workspace: string;
  notify: (title: string, body: string) => void;
}

export async function diskFreeGb(path: string): Promise<number | null> {
  try {
    const s = await statfs(path);
    return Math.round(((s.bavail * s.bsize) / 1024 ** 3) * 10) / 10;
  } catch {
    return null;
  }
}

export function systemTools(d: SystemDeps): ToolSpec[] {
  return [
    {
      name: 'system.info',
      title: 'System information',
      description: 'Operating system, CPU, memory, disk and network overview of this workstation.',
      risk: 'read',
      source: 'builtin',
      sourceId: null,
      inputSchema: { type: 'object', properties: {} },
      async run() {
        const c = cpus();
        const nets = Object.entries(networkInterfaces())
          .flatMap(([name, addrs]) => (addrs ?? []).filter((a) => !a.internal).map((a) => `${name}: ${a.address} (${a.family})`));
        const info = {
          hostname: hostname(),
          user: userInfo().username,
          os: `${platform()} ${release()} (${version()})`,
          arch: arch(),
          cpu: `${c[0]?.model ?? 'unknown'} × ${c.length}`,
          load: loadavg().map((l) => l.toFixed(2)).join(' '),
          memory: `${((totalmem() - freemem()) / 1024 ** 3).toFixed(1)} / ${(totalmem() / 1024 ** 3).toFixed(1)} GB used`,
          diskFreeGb: await diskFreeGb(d.workspace),
          uptimeHours: Math.round(uptime() / 360) / 10,
          network: nets,
        };
        return {
          output: Object.entries(info)
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
            .join('\n'),
          data: info,
        };
      },
    },
    {
      name: 'system.processes',
      title: 'Running processes',
      description: 'Top running processes by CPU usage.',
      risk: 'read',
      source: 'builtin',
      sourceId: null,
      inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 25 } } },
      async run(i, ctx) {
        const cmd =
          process.platform === 'win32'
            ? `Get-Process | Sort-Object CPU -Descending | Select-Object -First ${i.limit} Id,ProcessName,CPU,@{n='MemMB';e={[math]::Round($_.WorkingSet64/1MB)}} | Format-Table -AutoSize | Out-String -Width 200`
            : `ps -Ao pid,pcpu,pmem,comm -r 2>/dev/null | head -n ${i.limit + 1} || ps -eo pid,pcpu,pmem,comm --sort=-pcpu | head -n ${i.limit + 1}`;
        const r = await runShell(cmd, d.workspace, 20_000, ctx.signal);
        return { output: r.stdout.trim() || r.stderr.trim() || 'No output' };
      },
    },
    {
      name: 'system.notify',
      title: 'Notify user',
      description: 'Show a desktop notification to the person at this workstation.',
      risk: 'read',
      source: 'builtin',
      sourceId: null,
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string', maxLength: 200 }, body: { type: 'string', maxLength: 2000 } },
        required: ['title', 'body'],
      },
      async run(i) {
        d.notify(i.title, i.body);
        return { output: 'Notification shown' };
      },
    },
    {
      name: 'time.now',
      title: 'Current time',
      description: 'Current date, time and time zone of this workstation.',
      risk: 'read',
      source: 'builtin',
      sourceId: null,
      inputSchema: { type: 'object', properties: {} },
      async run() {
        const now = new Date();
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return {
          output: `${now.toLocaleString('en-US', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' })} (${tz}); ISO ${now.toISOString()}`,
          data: { iso: now.toISOString(), timeZone: tz },
        };
      },
    },
  ];
}
