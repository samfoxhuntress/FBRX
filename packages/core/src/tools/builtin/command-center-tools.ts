import { TASK_PRIORITIES, TASK_STATUSES } from '@fbrx/shared';
import type { AlertEngine } from '../../alerts/alert-engine';
import type { NetDiag } from '../../network/netdiag';
import { checkLink } from '../../security/linkcheck';
import type { SystemMonitor } from '../../system/system-monitor';
import { IS_WIN } from '../../windows/ps';
import * as sec from '../../windows/security';
import * as storage from '../../windows/storage';
import * as fixes from '../../windows/troubleshoot';
import * as updates from '../../windows/updates';
import type { WorkspaceStore } from '../../workspace/workspace-store';
import type { ToolSpec } from '../types';

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;
const tool = (t: Omit<ToolSpec, 'source' | 'sourceId'>): ToolSpec => ({ source: 'builtin', sourceId: null, ...t });

/** Notes, tasks, projects and snippets for the agent. They stay inside FBRX OS (allowed by a built-in rule). */
export function workspaceTools(w: WorkspaceStore): ToolSpec[] {
  const project = (name?: string) => (name ? (w.listProjects().find((p) => p.name.toLowerCase() === name.toLowerCase() || p.id === name)?.id ?? null) : undefined);
  return [
    tool({
      name: 'workspace.list_tasks',
      title: 'List tasks',
      description: 'Tasks from the FBRX workspace, open ones first. Optional filters: status (todo, doing, done) and project name.',
      risk: 'read',
      inputSchema: { type: 'object', properties: { status: { type: 'string', enum: [...TASK_STATUSES] }, project: { type: 'string' } } },
      async run(i) {
        const tasks = w.listTasks({ status: i.status, projectId: project(i.project) ?? undefined }).slice(0, 100);
        return {
          output: tasks.length ? tasks.map((t) => `- [${t.status}] ${t.title} (id ${t.id}, ${t.priority}${t.due ? `, due ${t.due.slice(0, 10)}` : ''})`).join('\n') : 'No tasks',
          data: tasks,
        };
      },
    }),
    tool({
      name: 'workspace.add_task',
      title: 'Add task',
      description: 'Create a task in the FBRX workspace. Due dates use YYYY-MM-DD.',
      risk: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 300 },
          details: { type: 'string', maxLength: 5000 },
          priority: { type: 'string', enum: [...TASK_PRIORITIES] },
          due: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          project: { type: 'string', description: 'Project name' },
        },
        required: ['title'],
      },
      async run(i) {
        const t = w.saveTask({ title: i.title, details: i.details, priority: i.priority, due: i.due, projectId: project(i.project) ?? null });
        return { output: `Added task "${t.title}" (id ${t.id})`, data: t };
      },
    }),
    tool({
      name: 'workspace.update_task',
      title: 'Update task',
      description: 'Change a task: status (todo, doing, done), title, priority or due date.',
      risk: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: [...TASK_STATUSES] },
          title: { type: 'string', maxLength: 300 },
          priority: { type: 'string', enum: [...TASK_PRIORITIES] },
          due: { type: ['string', 'null'] },
        },
        required: ['id'],
      },
      async run(i) {
        const cur = w.getTask(i.id);
        const t = w.saveTask({ id: cur.id, title: i.title ?? cur.title, status: i.status, priority: i.priority, due: i.due });
        return { output: `Task "${t.title}" is now ${t.status}`, data: t };
      },
    }),
    tool({
      name: 'workspace.search_notes',
      title: 'Search notes',
      description: 'Search the FBRX notes by words in the title, text or tags. Returns the matching notes with their text.',
      risk: 'read',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      async run(i) {
        const notes = w.listNotes({ query: i.query }).slice(0, 10);
        return { output: notes.length ? notes.map((n) => `## ${n.title} (id ${n.id})\n${n.content.slice(0, 2000)}`).join('\n\n') : 'No matching notes', data: notes };
      },
    }),
    tool({
      name: 'workspace.create_note',
      title: 'Create note',
      description: 'Save a note (Markdown) in the FBRX workspace.',
      risk: 'write',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string', minLength: 1, maxLength: 200 }, content: { type: 'string', maxLength: 100000 }, tags: { type: 'array', items: { type: 'string' } }, project: { type: 'string' } },
        required: ['title', 'content'],
      },
      async run(i) {
        const n = w.saveNote({ title: i.title, content: i.content, tags: i.tags, projectId: project(i.project) ?? null });
        return { output: `Saved note "${n.title}" (id ${n.id})`, data: n };
      },
    }),
    tool({
      name: 'workspace.append_note',
      title: 'Append to note',
      description: 'Add text to the end of an existing note.',
      risk: 'write',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string', maxLength: 50000 } }, required: ['id', 'text'] },
      async run(i) {
        const n = w.getNote(i.id);
        const saved = w.saveNote({ id: n.id, title: n.title, content: `${n.content}${n.content.endsWith('\n') || !n.content ? '' : '\n'}${i.text}` });
        return { output: `Updated note "${saved.title}"` };
      },
    }),
    tool({
      name: 'workspace.list_projects',
      title: 'List projects',
      description: 'Projects with their task progress, overdue tasks and milestones.',
      risk: 'read',
      inputSchema: { type: 'object', properties: {} },
      async run() {
        const ps = w.listProjects();
        return {
          output: ps.length
            ? ps.map((p) => `- ${p.name} [${p.status}] ${p.done}/${p.tasks} tasks done${p.overdue ? `, ${p.overdue} overdue` : ''}${p.due ? `, due ${p.due.slice(0, 10)}` : ''}${p.milestones.length ? `; milestones: ${p.milestones.map((m) => `${m.done ? '✓' : '○'} ${m.title}`).join(', ')}` : ''}`).join('\n')
            : 'No projects',
          data: ps,
        };
      },
    }),
    tool({
      name: 'workspace.search_snippets',
      title: 'Search snippets',
      description: 'Search saved code and text snippets.',
      risk: 'read',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      async run(i) {
        const s = w.listSnippets({ query: i.query }).slice(0, 10);
        return { output: s.length ? s.map((x) => `## ${x.title}${x.language ? ` (${x.language})` : ''}\n${x.content.slice(0, 3000)}`).join('\n\n') : 'No matching snippets', data: s };
      },
    }),
    tool({
      name: 'workspace.save_snippet',
      title: 'Save snippet',
      description: 'Save a reusable code or text snippet.',
      risk: 'write',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string', minLength: 1, maxLength: 200 }, language: { type: 'string', maxLength: 40 }, content: { type: 'string', maxLength: 100000 }, tags: { type: 'array', items: { type: 'string' } } },
        required: ['title', 'content'],
      },
      async run(i) {
        const s = w.saveSnippet(i);
        return { output: `Saved snippet "${s.title}"`, data: s };
      },
    }),
  ];
}

export interface PcToolDeps {
  monitor: SystemMonitor;
  net: NetDiag;
  alerts: AlertEngine;
  virustotalKey: () => string | undefined;
}

/** PC care and network diagnostics for the agent. */
export function pcTools(d: PcToolDeps): ToolSpec[] {
  const list: ToolSpec[] = [
    tool({
      name: 'pc.live_status',
      title: 'Live system status',
      description: 'Current CPU, memory, network throughput, battery and temperature, with 5-minute averages.',
      risk: 'read',
      inputSchema: { type: 'object', properties: {} },
      async run() {
        const c = d.monitor.current;
        if (!c) return { output: 'No samples yet; try again in a few seconds' };
        const lines = [
          `CPU ${c.cpu.toFixed(0)}% now, ${d.monitor.average('cpu', 300)?.toFixed(0) ?? '—'}% 5-min average (${c.cores.length} threads)`,
          `Memory ${gb(c.memUsed)} of ${gb(c.memTotal)} (${((c.memUsed / c.memTotal) * 100).toFixed(0)}%)`,
          `Network ↓ ${(c.netRx / 1e6).toFixed(2)} MB/s ↑ ${(c.netTx / 1e6).toFixed(2)} MB/s`,
          c.battery ? `Battery ${c.battery.percent}%${c.battery.charging ? ' (charging)' : ''}` : 'No battery',
          c.tempC ? `CPU temperature ${c.tempC} °C` : 'Temperature not reported',
          `Uptime ${(c.uptime / 3600).toFixed(1)} hours`,
        ];
        return { output: lines.join('\n'), data: c };
      },
    }),
    tool({
      name: 'pc.storage_report',
      title: 'Storage report',
      description: 'Drives with free space and health, plus how much space temporary files, Downloads and the Recycle Bin use.',
      risk: 'read',
      inputSchema: { type: 'object', properties: {} },
      async run() {
        const [drives, clean] = await Promise.all([storage.drives(), storage.cleanupInfo()]);
        return {
          output: [
            ...drives.map((x) => `${x.letter} ${x.label} (${x.fs}): ${gb(x.free)} free of ${gb(x.size)}, ${x.health}${x.bitlocker ? `, BitLocker ${x.bitlocker}` : ''}`),
            ...clean.temp.map((t) => `Temporary files ${t.path}: ${gb(t.size)}`),
            `Downloads: ${gb(clean.downloads.size)}`,
            clean.recycleBin != null ? `Recycle Bin: ${gb(clean.recycleBin)}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          data: { drives, clean },
        };
      },
    }),
    tool({
      name: 'pc.clean_temp',
      title: 'Clean temporary files',
      description: 'Delete temporary files older than one day from the user temp folder.',
      risk: 'write',
      inputSchema: { type: 'object', properties: {} },
      async run() {
        const r = await storage.cleanTemp();
        return { output: `Freed ${gb(r.freed)}; ${r.skipped} item(s) skipped (in use or recent)`, data: r };
      },
    }),
    tool({
      name: 'net.ping',
      title: 'Ping',
      description: 'Check whether a host answers and measure latency, jitter and packet loss.',
      risk: 'network',
      inputSchema: { type: 'object', properties: { host: { type: 'string' }, count: { type: 'integer', minimum: 1, maximum: 20, default: 4 } }, required: ['host'] },
      async run(i) {
        const r = await d.net.ping(i.host, i.count);
        return { output: `${r.host}${r.ip ? ` (${r.ip})` : ''}: ${r.received}/${r.sent} replies, ${r.lossPct}% loss${r.avg != null ? `, avg ${r.avg} ms (min ${r.min}, max ${r.max}, jitter ${r.jitter ?? 0})` : ''}`, data: r };
      },
    }),
    tool({
      name: 'net.traceroute',
      title: 'Trace route',
      description: 'Show each router between this computer and a host, identifying the local router, ISP and internet hops.',
      risk: 'network',
      timeoutMs: 300_000,
      inputSchema: { type: 'object', properties: { host: { type: 'string' } }, required: ['host'] },
      async run(i) {
        const r = await d.net.traceroute(i.host, `tool-${Date.now()}`);
        return {
          output: r.hops.map((h) => `${h.hop}. ${h.ip ?? '*'} ${h.name ? `(${h.name}) ` : ''}${h.avg != null ? `${h.avg} ms ` : ''}[${h.role}]${h.org ? ` ${h.org}` : ''}${h.location ? `, ${h.location}` : ''}`).join('\n') || 'No hops',
          data: r,
        };
      },
    }),
    tool({
      name: 'net.dns_lookup',
      title: 'DNS lookup',
      description: 'Resolve a name and compare the system resolver with public DNS servers.',
      risk: 'network',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      async run(i) {
        const r = await d.net.dnsTest(i.name);
        return { output: [`${r.name}: ${r.addresses.join(', ') || 'no addresses'}`, ...r.resolvers.map((x) => `${x.name} (${x.ip}): ${x.ok ? `${x.ms} ms` : 'failed'}`)].join('\n'), data: r };
      },
    }),
    tool({
      name: 'net.port_check',
      title: 'Check port',
      description: 'Check whether a TCP port on a host accepts connections.',
      risk: 'network',
      inputSchema: { type: 'object', properties: { host: { type: 'string' }, port: { type: 'integer', minimum: 1, maximum: 65535 } }, required: ['host', 'port'] },
      async run(i) {
        const r = await d.net.port(i.host, i.port);
        return { output: `${i.host}:${i.port} is ${r.open ? `open (${r.ms} ms)` : 'closed or filtered'}`, data: r };
      },
    }),
    tool({
      name: 'net.scan_lan',
      title: 'Scan local network',
      description: 'Find the devices on the local network (computers, phones, printers, TVs, smart-home devices) with their maker and open services.',
      risk: 'network',
      timeoutMs: 600_000,
      inputSchema: { type: 'object', properties: {} },
      async run() {
        const s = await d.net.scan(`tool-${Date.now()}`, undefined, 'Scan by Fabric');
        return {
          output: `${s.devices.length} devices on ${s.subnet}:\n${s.devices.map((x) => `- ${x.ip} ${x.typeLabel}${x.name ? ` "${x.name}"` : ''}${x.vendor ? ` (${x.vendor})` : ''}${x.ports.length ? ` ports ${x.ports.join(',')}` : ''}`).join('\n')}`,
          data: s,
        };
      },
    }),
    tool({
      name: 'net.check_link',
      title: 'Check a link',
      description: 'Inspect a suspicious link without opening it in a browser: look-alike domains, redirects, domain age, certificate and reputation.',
      risk: 'network',
      timeoutMs: 120_000,
      inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      async run(i) {
        const r = await checkLink(i.url, { virustotalKey: d.virustotalKey() });
        return { output: [`Verdict: ${r.verdict} (risk score ${r.score}/100)`, `Lands on: ${r.finalUrl}`, ...r.findings.map((f) => `- [${f.severity}] ${f.text}`)].join('\n'), data: r };
      },
    }),
    tool({
      name: 'net.speed_test',
      title: 'Internet speed test',
      description: 'Measure download and upload speed and latency (uses about 100 MB of data).',
      risk: 'network',
      timeoutMs: 120_000,
      inputSchema: { type: 'object', properties: {} },
      async run() {
        const r = await d.net.speedTest(`tool-${Date.now()}`);
        return { output: `Download ${r.downloadMbps} Mbps, upload ${r.uploadMbps} Mbps, latency ${r.latencyMs ?? '—'} ms, jitter ${r.jitterMs ?? '—'} ms (${r.server})`, data: r };
      },
    }),
    tool({
      name: 'alerts.recent',
      title: 'Recent alerts',
      description: 'The latest alerts FBRX OS raised on this computer (performance, storage, security, network, reliability).',
      risk: 'read',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 15 } } },
      async run(i) {
        const a = d.alerts.inbox({ limit: i.limit });
        return { output: a.length ? a.map((x) => `- ${x.createdAt.slice(0, 16).replace('T', ' ')} [${x.severity}] ${x.title}: ${x.body}`).join('\n') : 'No alerts', data: a };
      },
    }),
  ];

  if (IS_WIN) {
    list.push(
      tool({
        name: 'pc.security_status',
        title: 'Security status',
        description: 'Microsoft Defender protection, definitions age, recent threats and Windows Firewall profiles.',
        risk: 'read',
        inputSchema: { type: 'object', properties: {} },
        async run() {
          const [def, threats, fw] = await Promise.all([sec.defenderStatus().catch((e) => ({ error: (e as Error).message })), sec.threats().catch(() => []), sec.firewall().catch(() => [])]);
          return { output: JSON.stringify({ defender: def, threats: threats.slice(0, 10), firewall: fw }, null, 2), data: { def, threats, fw } };
        },
      }),
      tool({
        name: 'pc.event_errors',
        title: 'Errors and crashes',
        description: 'Errors from the Windows event log, app crashes, blue screens, unexpected shutdowns, problem devices and stopped services.',
        risk: 'read',
        timeoutMs: 180_000,
        inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 30, default: 3 } } },
        async run(i) {
          const r = await fixes.bugScan(i.days);
          return { output: JSON.stringify({ ...r, events: r.events.slice(0, 20) }, null, 2).slice(0, 30_000), data: r };
        },
      }),
      tool({
        name: 'pc.pending_updates',
        title: 'Pending updates',
        description: 'App updates available through winget and pending Windows updates.',
        risk: 'read',
        timeoutMs: 300_000,
        inputSchema: { type: 'object', properties: {} },
        async run() {
          const [apps, win] = await Promise.all([updates.appUpgrades().catch(() => []), updates.windowsUpdates().catch(() => [])]);
          return {
            output: [
              `App updates (${apps.length}):`,
              ...apps.map((a) => `- ${a.name} ${a.current} → ${a.available} (${a.id})`),
              `Windows updates (${win.length}):`,
              ...win.map((u) => `- ${u.title}${u.kb ? ` ${u.kb}` : ''}${u.severity ? ` [${u.severity}]` : ''}`),
            ].join('\n'),
            data: { apps, win },
          };
        },
      }),
      tool({
        name: 'pc.run_fix',
        title: 'Run a repair',
        description: `Run a Windows repair. Fixes: ${fixes
          .fixes()
          .map((f) => `${f.id} (${f.label}${f.admin ? ', asks for administrator rights' : ''})`)
          .join('; ')}. "service" needs the service name and "device" the device instance id as target.`,
        risk: 'execute',
        timeoutMs: 3_600_000,
        inputSchema: { type: 'object', properties: { id: { type: 'string', enum: fixes.fixes().map((f) => f.id) }, target: { type: 'string' } }, required: ['id'] },
        async run(i) {
          const r = await fixes.runFix(i.id, i.target);
          return { output: `${r.ok ? 'Completed' : 'Did not finish'}\n${r.output.slice(-8000)}`, data: r };
        },
      }),
    );
  }
  return list;
}
