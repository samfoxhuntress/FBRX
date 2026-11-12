import { inventoryText, systemInventory } from '../../system/inventory';
import { freemem, loadavg, totalmem, userInfo } from 'node:os';
import { statfs } from 'node:fs/promises';
import type { ToolSpec } from '../types';
import { runShell } from './shell-tools';

export interface SystemDeps {
  workspace: string;
  notify: (title: string, body: string) => void;
  /** The AI's name: every notification it shows says who it is from. */
  agentName?: () => string;
  /** Tests: the clock. */
  now?: () => number;
}

/** At most this many notifications from the AI a minute, and an hour: more is a loop, or a nuisance. */
export const NOTIFY_LIMITS = { perMinute: 3, perHour: 20 } as const;

export async function diskFreeGb(path: string): Promise<number | null> {
  try {
    const s = await statfs(path);
    return Math.round(((s.bavail * s.bsize) / 1024 ** 3) * 10) / 10;
  } catch {
    return null;
  }
}

export function systemTools(d: SystemDeps): ToolSpec[] {
  const now = d.now ?? Date.now;
  /** When the AI's last notifications were shown (the last hour's). */
  let shown: number[] = [];
  return [
    {
      name: 'system.info',
      title: 'System information',
      description: "This computer: its make, model and serial number, the system and BIOS, the processor, the memory (each module's size, type and speed), each drive (kind, size, health), graphics, screens, network adapters and the battery.",
      risk: 'read',
      source: 'builtin',
      sourceId: null,
      inputSchema: { type: 'object', properties: {} },
      async run() {
        const inv = await systemInventory();
        const extra = [`User: ${userInfo().username}`, `Memory in use: ${((totalmem() - freemem()) / 1024 ** 3).toFixed(1)} of ${(totalmem() / 1024 ** 3).toFixed(1)} GB`, `Load: ${loadavg().map((l) => l.toFixed(2)).join(' ')}`];
        return { output: `${inventoryText(inv)}\n${extra.join('\n')}`, data: inv };
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
      description: `Show a desktop notification to the person at this workstation (its title starts with your name; at most ${NOTIFY_LIMITS.perMinute} a minute and ${NOTIFY_LIMITS.perHour} an hour).`,
      risk: 'read',
      source: 'builtin',
      sourceId: null,
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string', maxLength: 200 }, body: { type: 'string', maxLength: 2000 } },
        required: ['title', 'body'],
      },
      async run(i: { title: string; body: string }) {
        const at = now();
        shown = shown.filter((t) => at - t < 3_600_000);
        if (shown.filter((t) => at - t < 60_000).length >= NOTIFY_LIMITS.perMinute || shown.length >= NOTIFY_LIMITS.perHour) {
          return { output: `Not shown: that is more than ${NOTIFY_LIMITS.perMinute} notifications a minute or ${NOTIFY_LIMITS.perHour} an hour. Tell the person in the chat instead.` };
        }
        shown.push(at);
        // Who it is from, so a notification cannot pass for the system's or another app's.
        const name = d.agentName?.().trim() || 'FBRX';
        const title = String(i.title ?? '').trim();
        d.notify(title.toLowerCase().startsWith(`${name.toLowerCase()}:`) ? title : `${name}: ${title}`, String(i.body ?? ''));
        return { output: 'Notification shown' };
      },
    },
    {
      name: 'plan.update',
      title: 'Plan',
      description:
        'Show the person your plan for a job of three or more steps, as a checklist in the chat: set it before you start (each step a few words), and send it again with steps marked done as you finish them.',
      risk: 'read',
      source: 'builtin',
      sourceId: null,
      inputSchema: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            minItems: 1,
            maxItems: 10,
            items: { type: 'object', properties: { step: { type: 'string', minLength: 1, maxLength: 160 }, done: { type: 'boolean' } }, required: ['step'] },
          },
        },
        required: ['steps'],
      },
      async run(i) {
        const steps = (i.steps as Array<{ step: string; done?: boolean }>).map((s) => ({ step: s.step, done: !!s.done }));
        const done = steps.filter((s) => s.done).length;
        const next = steps.find((s) => !s.done);
        return { output: done === steps.length ? `All ${steps.length} steps done.` : `${done} of ${steps.length} done. Next: ${next!.step}`, data: { steps } };
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
