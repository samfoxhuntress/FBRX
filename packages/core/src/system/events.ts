import { execFile } from 'node:child_process';
import type { EventLevel, EventLogEntry, EventLogInfo, EventQuery } from '@fbrx/shared';
import { CoreError } from '../errors';
import { IS_WIN, psJson, psq } from '../windows/ps';

/**
 * The event viewer: Windows event logs (Get-WinEvent), the systemd journal on Linux (journalctl) and the unified log
 * on macOS (log show). Read-only. Messages are trimmed so a chatty log stays quick to show and to hand to Fabrix.
 */

const WINDOWS_LOGS: EventLogInfo[] = [
  { id: 'Application', name: 'Application', description: 'Programs and services: crashes, errors and warnings' },
  { id: 'System', name: 'System', description: 'Windows itself: drivers, services, disks, shutdowns and restarts' },
  { id: 'Setup', name: 'Setup', description: 'Windows updates and feature installs' },
  { id: 'Security', name: 'Security', description: 'Sign-ins, account changes and audit events', admin: true },
  { id: 'Microsoft-Windows-Windows Defender/Operational', name: 'Microsoft Defender', description: 'Scans, threats and protection changes' },
  { id: 'Microsoft-Windows-PowerShell/Operational', name: 'PowerShell', description: 'PowerShell engine and script block events' },
  { id: 'Microsoft-Windows-TaskScheduler/Operational', name: 'Task Scheduler', description: 'Scheduled tasks that ran, failed or were skipped' },
  { id: 'Microsoft-Windows-WLAN-AutoConfig/Operational', name: 'Wi-Fi', description: 'Wi-Fi connections and disconnections' },
];

const UNIX_LOGS: EventLogInfo[] =
  process.platform === 'darwin'
    ? [{ id: 'system', name: 'System log', description: 'The macOS unified log (errors and faults)' }]
    : [
        { id: 'system', name: 'System journal', description: 'Everything systemd collects' },
        { id: 'kernel', name: 'Kernel', description: 'Kernel messages: drivers, disks, memory' },
      ];

export function eventLogs(): EventLogInfo[] {
  return IS_WIN ? WINDOWS_LOGS : UNIX_LOGS;
}

const WIN_LEVEL: Record<EventLevel, number[]> = { critical: [1], error: [2], warning: [3], information: [0, 4] };
const FROM_WIN: Record<number, EventLevel> = { 1: 'critical', 2: 'error', 3: 'warning', 4: 'information', 0: 'information', 5: 'information' };

function run(cmd: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout))),
  );
}

export async function queryEvents(q: EventQuery): Promise<{ entries: EventLogEntry[]; note: string | null }> {
  const limit = Math.max(1, Math.min(2000, Math.floor(q.limit ?? 300)));
  const hours = Math.max(1, Math.min(24 * 30, Math.floor(q.hours)));
  const levels = q.levels.length ? q.levels : (['critical', 'error', 'warning'] as EventLevel[]);
  if (IS_WIN) {
    if (!WINDOWS_LOGS.some((l) => l.id === q.log)) throw new CoreError('INVALID_ARGUMENT', 'Unknown event log');
    const filter = [`LogName=${psq(q.log)}`, `Level=${levels.flatMap((l) => WIN_LEVEL[l]).join(',')}`, `StartTime=(Get-Date).AddHours(-${hours})`];
    if (q.source?.trim()) filter.push(`ProviderName=${psq(q.source.trim().slice(0, 200))}`);
    if (q.eventId !== undefined) filter.push(`Id=${Math.max(0, Math.min(65535, Math.floor(q.eventId)))}`);
    // Wrapped in a script block so its output can be piped to ConvertTo-Json by psJson.
    const script = `& {
$ErrorActionPreference='Stop'
try {
  Get-WinEvent -FilterHashtable @{${filter.join('; ')}} -MaxEvents ${limit} | ForEach-Object {
    $m=[string]$_.Message
    [pscustomobject]@{ t=$_.TimeCreated.ToUniversalTime().ToString('o'); l=[int]$_.Level; s=[string]$_.ProviderName; i=[int]$_.Id; r=[long]$_.RecordId; k=[string]$_.TaskDisplayName; u=$(if ($_.UserId) { [string]$_.UserId } else { '' }); p=[int]$_.ProcessId; m=$m.Substring(0, [Math]::Min(4000, $m.Length)) }
  }
} catch {
  $id = [string]$_.FullyQualifiedErrorId
  if ($id -match 'NoMatchingEventsFound') { }
  elseif ($id -match 'NoMatchingLogsFound') { [pscustomobject]@{ missing=$true } }
  elseif ($_.Exception -is [System.UnauthorizedAccessException] -or $id -match 'UnauthorizedAccess' -or $_.Exception.Message -match 'unauthorized|denied|privilege') { [pscustomobject]@{ denied=$true } }
  else { throw }
}
}`;
    const rows = await psJson<any>(script, 90_000);
    if (rows.some((r) => r.denied)) return { entries: [], note: `Reading the ${q.log} log needs administrator rights. Start FBRX as administrator to see it.` };
    if (rows.some((r) => r.missing)) return { entries: [], note: `This computer doesn't keep the ${q.log} log (the feature may not be installed).` };
    return {
      entries: rows.map((r) => ({ time: r.t, log: q.log, level: FROM_WIN[r.l] ?? 'information', source: r.s, eventId: r.i, message: (r.m ?? '').trim(), recordId: r.r, task: r.k || undefined, user: r.u || undefined, pid: r.p || undefined })),
      note: null,
    };
  }
  if (process.platform === 'darwin') {
    // The unified log is huge: errors and faults only, at most the last six hours.
    const h = Math.min(hours, 6);
    const predicate = ['(messageType == error OR messageType == fault)', q.source?.trim() ? `process == "${q.source.trim().replace(/["\\]/g, '')}"` : ''].filter(Boolean).join(' AND ');
    const out = await run('/usr/bin/log', ['show', '--style', 'json', '--last', `${h}h`, '--predicate', predicate], 120_000).catch((e) => {
      throw new CoreError('UNAVAILABLE', `Could not read the system log: ${(e as Error).message}`);
    });
    let rows: any[] = [];
    try {
      rows = JSON.parse(out);
    } catch {
      rows = [];
    }
    const entries = rows
      .slice(-limit)
      .reverse()
      .map((r) => ({ time: new Date(r.timestamp).toISOString(), log: 'system', level: (r.messageType === 'Fault' ? 'critical' : 'error') as EventLevel, source: String(r.processImagePath ?? '').split('/').pop() || String(r.subsystem ?? 'system'), eventId: 0, message: String(r.eventMessage ?? '').slice(0, 4000), pid: r.processID }))
      .filter((e) => levels.includes(e.level));
    return { entries, note: hours > 6 ? 'macOS keeps a very large log, so FBRX shows the last six hours.' : null };
  }
  // Linux: journalctl, newest first.
  const prio = Math.max(...levels.map((l) => ({ critical: 2, error: 3, warning: 4, information: 6 })[l]));
  const args = ['-o', 'json', '--no-pager', '-r', '-n', String(limit), `--since=-${hours}h`, '-p', String(prio)];
  if (q.log === 'kernel') args.push('-k');
  if (q.source?.trim()) args.push('-t', q.source.trim().slice(0, 100));
  let out: string;
  try {
    out = await run('journalctl', args, 60_000);
  } catch (e) {
    return { entries: [], note: `The systemd journal is not available here (${(e as Error).message.split('\n')[0]}).` };
  }
  const level = (p: number): EventLevel => (p <= 2 ? 'critical' : p === 3 ? 'error' : p === 4 ? 'warning' : 'information');
  const entries: EventLogEntry[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      const msg = Array.isArray(r.MESSAGE) ? Buffer.from(r.MESSAGE).toString('utf8') : String(r.MESSAGE ?? '');
      entries.push({ time: new Date(Number(r.__REALTIME_TIMESTAMP) / 1000).toISOString(), log: q.log, level: level(Number(r.PRIORITY ?? 6)), source: String(r.SYSLOG_IDENTIFIER ?? r._COMM ?? 'system'), eventId: 0, message: msg.slice(0, 4000), pid: r._PID ? Number(r._PID) : undefined });
    } catch {
      /* skip a line that is not JSON */
    }
  }
  return { entries: entries.filter((e) => levels.includes(e.level)), note: null };
}
