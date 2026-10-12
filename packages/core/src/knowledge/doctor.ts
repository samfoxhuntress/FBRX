import { freemem, totalmem } from 'node:os';
import type { LogLine, RuntimeStatus, ServiceStatus, Settings } from '@fbrx/shared';

/**
 * fbrx.doctor: FBRX looks at itself. Each check says what it found in plain words and, when something can be done, the
 * fix fbrx.fix applies (after the person agrees). Nothing here changes anything.
 */

export type DoctorSeverity = 'ok' | 'info' | 'warning' | 'problem';

export interface DoctorFinding {
  id: string;
  severity: DoctorSeverity;
  title: string;
  detail: string;
  /** fbrx.fix's id for the fix, when there is one. */
  fix?: string;
}

export interface DoctorDeps {
  services: () => ServiceStatus[];
  /** Recent warnings and errors in FBRX's log. */
  logs: () => LogLine[];
  runtime: () => RuntimeStatus;
  /** The loaded (or chosen) model's file size. */
  modelBytes: () => number | null;
  settings: () => Settings;
  scanRunning: () => boolean;
  shieldWaiting: () => number;
  /** FBRX's database file, with its write-ahead log. */
  databaseBytes: () => number;
  diskFreeGb: () => Promise<number | null>;
  halted: () => boolean;
  vaultLocked: () => boolean;
  presenting: () => boolean;
  updateAvailable: () => string | null;
  appVersion: string;
  /** The core's own memory (this process). */
  rss?: () => number;
  mem?: () => { total: number; free: number };
}

const GB = 1024 ** 3;
const gb = (b: number) => `${(b / GB).toFixed(1)} GB`;

export async function runDoctor(d: DoctorDeps): Promise<DoctorFinding[]> {
  const out: DoctorFinding[] = [];
  const add = (f: DoctorFinding) => out.push(f);
  const s = d.settings();

  if (d.halted()) add({ id: 'halted', severity: 'problem', title: 'The AI is on emergency stop', detail: 'Nothing the AI asks to do runs. The person lifts it with Resume at the top of FBRX.' });

  // Services.
  for (const svc of d.services()) {
    if (svc.state === 'failed' || svc.state === 'degraded')
      add({ id: `service:${svc.name}`, severity: svc.state === 'failed' ? 'problem' : 'warning', title: `${svc.title} is ${svc.state === 'failed' ? 'not running' : 'having trouble'}`, detail: `${svc.message ?? 'No message.'}${svc.restarts ? ` Restarted ${svc.restarts} times.` : ''}`, fix: `restart-service:${svc.name}` });
  }

  // Memory: the computer's, FBRX's own, and the local model against it.
  const mem = d.mem?.() ?? { total: totalmem(), free: freemem() };
  const rss = d.rss?.() ?? process.memoryUsage().rss;
  const rt = d.runtime();
  const model = d.modelBytes();
  if (mem.free / mem.total < 0.1) add({ id: 'memory-low', severity: 'warning', title: 'The computer is short of memory', detail: `${gb(mem.free)} free of ${gb(mem.total)}. Everything slows down when memory runs out; a loaded AI model is often the biggest user.`, fix: rt.state === 'running' ? 'unload-model' : undefined });
  if (rss > 1.5 * GB) add({ id: 'fbrx-memory', severity: 'warning', title: 'FBRX is using a lot of memory', detail: `FBRX itself uses ${gb(rss)} (without the AI model).` });
  if (model && rt.state !== 'disabled') {
    if (model > mem.total * 0.6) add({ id: 'model-too-big', severity: 'problem', title: 'The local AI model is too big for this computer', detail: `The model is ${gb(model)} and the computer has ${gb(mem.total)} of memory: answers will be very slow or the model will fail to load. A smaller model (Settings → AI → Models) fits better.`, fix: rt.state === 'running' ? 'unload-model' : undefined });
    else if (rt.state === 'running') add({ id: 'model-loaded', severity: 'info', title: `A local AI model is loaded (${gb(model)})`, detail: 'It holds that much memory while loaded. Unloading frees it until the AI is next asked something.', fix: 'unload-model' });
  }
  if (rt.state === 'failed') add({ id: 'runtime-failed', severity: 'problem', title: 'The local AI runtime did not start', detail: rt.message ?? 'No message.', fix: 'restart-service:runtime' });
  if (rt.state !== 'disabled' && s.runtime.contextSize > 16384) add({ id: 'long-context', severity: 'warning', title: `The local model’s context window is long (${s.runtime.contextSize.toLocaleString()} tokens)`, detail: 'A long context window makes a local model slower and use more memory. 8,192 tokens is plenty for most chats.', fix: 'lower-context' });

  // Background work.
  if (d.scanRunning()) add({ id: 'scan-running', severity: 'info', title: 'An antivirus scan is running', detail: 'It reads many files and can slow the computer until it finishes.', fix: 'cancel-scan' });
  const waiting = d.shieldWaiting();
  if (waiting > 100) add({ id: 'shield-list', severity: 'warning', title: `FBRX Shield has ${waiting.toLocaleString()} findings waiting`, detail: 'A long list slows FBRX Shield’s page. Checking the list again clears findings the current rules no longer flag; Trust all suspicious handles the rest.', fix: 'recheck-shield' });

  // Storage.
  const dbBytes = d.databaseBytes();
  if (dbBytes > 750 * 1024 ** 2) add({ id: 'database', severity: 'warning', title: `FBRX’s database is large (${gb(dbBytes)})`, detail: 'Tidying it gives back unused space and can make FBRX quicker.', fix: 'compact-database' });
  const free = await d.diskFreeGb();
  if (free !== null && free < 5) add({ id: 'disk', severity: 'problem', title: `Only ${free} GB free on the drive FBRX uses`, detail: 'FBRX, Windows and the AI all slow down or fail when the drive is nearly full. Storage in FBRX shows what is using the space.' });

  // Errors in the log.
  const errors = d.logs().filter((l) => l.level === 'error');
  if (errors.length) {
    const byScope = new Map<string, number>();
    for (const e of errors) byScope.set(e.scope, (byScope.get(e.scope) ?? 0) + 1);
    const last = errors[errors.length - 1];
    add({ id: 'log-errors', severity: errors.length > 20 ? 'warning' : 'info', title: `${errors.length} recent error${errors.length === 1 ? '' : 's'} in FBRX’s log`, detail: `By part: ${[...byScope].map(([k, n]) => `${k} ${n}`).join(', ')}. Latest: ${last.scope}: ${last.message}` });
  }

  // Things that explain "it is not doing X".
  if (!s.notifications.enabled) add({ id: 'notifications-off', severity: 'info', title: 'Notifications are turned off', detail: 'Alerts → Notifications turns them back on.' });
  if (d.presenting()) add({ id: 'presenting', severity: 'info', title: 'Presenter-safe mode is on', detail: 'Notifications stay quiet and private lists are blurred until it is turned off.' });
  if (d.vaultLocked()) add({ id: 'vault-locked', severity: 'info', title: 'Credentials are locked', detail: 'Tools that need saved keys cannot use them until Credentials is unlocked.' });
  const newer = d.updateAvailable();
  if (newer) add({ id: 'update', severity: 'info', title: `FBRX ${newer} is available (this is ${d.appVersion})`, detail: 'Settings → About installs it. Newer versions often fix slowness and bugs.' });

  if (!out.some((f) => f.severity === 'warning' || f.severity === 'problem')) out.unshift({ id: 'healthy', severity: 'ok', title: 'FBRX looks healthy', detail: 'Its services are running and nothing it checks stands out.' });
  return out;
}

const ICON: Record<DoctorSeverity, string> = { ok: '✓', info: 'ℹ', warning: '⚠', problem: '✗' };

export function doctorReport(findings: DoctorFinding[]): string {
  return findings.map((f) => `${ICON[f.severity]} [${f.severity}] ${f.title}\n  ${f.detail}${f.fix ? `\n  Fix (fbrx.fix): ${f.fix}` : ''}`).join('\n');
}
