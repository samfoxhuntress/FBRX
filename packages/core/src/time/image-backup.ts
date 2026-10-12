import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nextDue, SCHEDULE_TIME_PATTERN, WEEKDAYS, type ImageBackupConfig, type ImageBackupRun, type ImageBackupStatus } from '@fbrx/shared';
import { CoreError, errorMessage } from '../errors';
import type { ExecResult } from '../windows/ps';
import { psq } from '../windows/ps';

/**
 * FBRX Time on a computer: a full image of the whole computer, by hand or on a schedule, to a drive or a network folder
 * (an FBRX Server's backup folder, say). On Windows it is the system image Windows makes itself (every volume Windows
 * needs to start, as virtual disks), so Windows' own recovery screen can put it back, and FBRX Time on a server can
 * check it by starting it.
 *
 * Making an image needs administrator rights, so setting it up asks once (UAC): it makes a scheduled task that runs as
 * the system, on the schedule (catching up when the computer was off) and whenever someone asks for one now. It lets
 * the people at this computer start it without asking again, so "Back up now" and FBRX Command's request just start
 * the task. The task writes how it went to a status file FBRX reads. The network folder's password is kept in a file
 * only the system and administrators can read.
 */

export const TASK_PATH = '\\FBRX\\';
export const TASK_NAME = 'Image backup';

export interface ImageBackupDeps {
  platform: NodeJS.Platform;
  /** Where the task's files live (C:\ProgramData\FBRX\Time on Windows). */
  dir: string;
  ps: (script: string, timeoutMs?: number) => Promise<ExecResult>;
  elevated: (script: string, o?: { timeoutMs?: number }) => Promise<{ ok: boolean; output: string }>;
  audit: (action: string, outcome: 'success' | 'failure', details: Record<string, unknown>) => void;
  log: { info: (m: string, d?: Record<string, unknown>) => void; warn: (m: string, d?: Record<string, unknown>) => void };
}

const DRIVE = /^[A-Za-z]:$/;
const UNC = /^\\\\[^\\/:*?"<>|\s]+\\[^\\/:*?"<>|]+(\\[^\\/:*?"<>|]+)*$/;

/** What is wrong with a target, in words (null: fine). */
export function targetProblem(target: string, systemDrive = 'C:'): string | null {
  const t = target.trim();
  if (DRIVE.test(t)) return t.toUpperCase() === systemDrive.toUpperCase() ? 'Pick another drive than the one Windows is on (an external drive, say)' : null;
  if (UNC.test(t)) return null;
  return 'Use a drive letter (E:) or a network folder (\\\\server\\folder)';
}

/** The task's own script: makes the image, then writes how it went. Runs as the system. */
export function runnerScript(): string {
  return String.raw`$ErrorActionPreference = 'Continue'
$dir = Join-Path $env:ProgramData 'FBRX\Time'
$statusFile = Join-Path $dir 'status.json'
$job = Get-Content (Join-Path $dir 'job.json') -Raw | ConvertFrom-Json
function Save($o) { $o | ConvertTo-Json -Depth 4 | Set-Content -Path $statusFile -Encoding UTF8 }
$start = (Get-Date).ToUniversalTime().ToString('o')
# The last image's result stays readable while the next one is made.
$previous = $null
if (Test-Path $statusFile) {
  try { $old = Get-Content $statusFile -Raw | ConvertFrom-Json; $previous = $(if ($old.state -eq 'running') { $old.previous } else { $old }) } catch { }
}
Save @{ state = 'running'; startedAt = $start; finishedAt = $null; target = $job.target; ok = $false; exitCode = $null; detail = 'Making the image'; versions = @(); previous = $previous }
$secret = Join-Path $dir 'secret.txt'
$mapped = $false
if ($job.user -and (Test-Path $secret)) {
  $pw = (Get-Content $secret -Raw).Trim()
  & net.exe use $job.target $pw "/user:$($job.user)" /persistent:no 2>&1 | Out-Null
  $mapped = $LASTEXITCODE -eq 0
}
$out = & wbadmin.exe start backup "-backupTarget:$($job.target)" -allCritical "-include:$($env:SystemDrive)" -quiet 2>&1 | Out-String
$code = $LASTEXITCODE
$out | Set-Content -Path (Join-Path $dir 'last.log') -Encoding UTF8
$list = & wbadmin.exe get versions "-backupTarget:$($job.target)" 2>&1 | Out-String
$versions = @([regex]::Matches($list, 'Version identifier:\s*(\S+)') | ForEach-Object { $_.Groups[1].Value })
if ($mapped) { & net.exe use $job.target /delete /y 2>&1 | Out-Null }
$detail = (($out -split "\r?\n") | Where-Object { $_.Trim() } | Select-Object -Last 4) -join ' '
Save @{ state = $(if ($code -eq 0) { 'done' } else { 'failed' }); startedAt = $start; finishedAt = (Get-Date).ToUniversalTime().ToString('o'); target = $job.target; ok = ($code -eq 0); exitCode = $code; detail = $detail; versions = $versions }
`;
}

/** Sets the task up (as administrator): its files, the password kept from everyone else, and the schedule. undefined keeps the saved password. */
export function setupScript(c: ImageBackupConfig, password: string | null | undefined): string {
  const job = JSON.stringify({ target: c.target, user: c.user || null, schedule: c.schedule, time: c.time, day: c.day });
  const trigger =
    c.schedule === 'daily'
      ? `$trigger = New-ScheduledTaskTrigger -Daily -At ${psq(c.time)}`
      : c.schedule === 'weekly'
        ? `$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek ${WEEKDAYS[c.day]} -At ${psq(c.time)}`
        : '$trigger = $null';
  return [
    `$dir = Join-Path $env:ProgramData 'FBRX\\Time'`,
    `New-Item -ItemType Directory -Force -Path $dir | Out-Null`,
    `Set-Content -Path (Join-Path $dir 'job.json') -Value ${psq(job)} -Encoding UTF8`,
    `Set-Content -Path (Join-Path $dir 'image-backup.ps1') -Value ${psq(runnerScript())} -Encoding UTF8`,
    `$secret = Join-Path $dir 'secret.txt'`,
    password === undefined
      ? `# The password saved before stays.`
      : password === null
      ? `Remove-Item -Force -ErrorAction SilentlyContinue $secret`
      : [
          `Set-Content -Path $secret -Value ${psq(password)} -NoNewline -Encoding UTF8`,
          // Only the system (which runs the task) and administrators can read it.
          `$acl = New-Object System.Security.AccessControl.FileSecurity`,
          `$acl.SetAccessRuleProtection($true, $false)`,
          `foreach ($who in 'NT AUTHORITY\\SYSTEM', 'BUILTIN\\Administrators') { $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($who, 'FullControl', 'Allow'))) }`,
          `Set-Acl -Path $secret -AclObject $acl`,
        ].join('\n'),
    `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $dir 'image-backup.ps1') + '"')`,
    trigger,
    `$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest`,
    // A computer that was off at the time makes the image when it is next on; one at a time; at most 12 hours.
    `$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 12)`,
    `$reg = @{ TaskPath = ${psq(TASK_PATH)}; TaskName = ${psq(TASK_NAME)}; Action = $action; Principal = $principal; Settings = $settings; Description = 'FBRX Time: an image of the whole computer (FBRX → Backup).'; Force = $true }`,
    `if ($trigger) { $reg.Trigger = $trigger }`,
    `Register-ScheduledTask @reg | Out-Null`,
    // The people at this computer may start it (Back up now, and FBRX Command's request) without asking again.
    `$svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect()`,
    `$task = $svc.GetFolder(${psq(TASK_PATH.replace(/\\$/, ''))}).GetTask(${psq(TASK_NAME)})`,
    `$sd = $task.GetSecurityDescriptor(0xF)`,
    `if ($sd -notmatch '\\(A;;GRGX;;;AU\\)') { $task.SetSecurityDescriptor($sd + '(A;;GRGX;;;AU)', 0) }`,
    `'set up'`,
  ].join('\n');
}

export function removeScript(): string {
  return [
    `Unregister-ScheduledTask -TaskPath ${psq(TASK_PATH)} -TaskName ${psq(TASK_NAME)} -Confirm:$false -ErrorAction SilentlyContinue`,
    `Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $env:ProgramData 'FBRX\\Time')`,
    `'removed'`,
  ].join('\n');
}

interface StatusFile {
  state?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  target?: string;
  ok?: boolean;
  detail?: string;
  versions?: string[] | string | null;
  /** While one is being made: how the one before went. */
  previous?: StatusFile | null;
}

/** Reads the task's status file (PowerShell writes it with a byte-order mark). */
export function readStatusFile(text: string): StatusFile | null {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, '')) as StatusFile;
  } catch {
    return null;
  }
}

export class ImageBackupService {
  constructor(private readonly d: ImageBackupDeps) {}

  get supported(): boolean {
    return this.d.platform === 'win32';
  }

  private config(): ImageBackupConfig | null {
    const f = join(this.d.dir, 'job.json');
    if (!existsSync(f)) return null;
    try {
      const j = JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, '')) as Partial<ImageBackupConfig> & { user?: string | null };
      if (!j.target) return null;
      return { target: j.target, user: j.user ?? '', schedule: j.schedule ?? 'off', time: j.time ?? '12:00', day: j.day ?? 0 };
    } catch {
      return null;
    }
  }

  private statusFile(): StatusFile | null {
    const f = join(this.d.dir, 'status.json');
    return existsSync(f) ? readStatusFile(readFileSync(f, 'utf8')) : null;
  }

  status(now = new Date()): ImageBackupStatus {
    if (!this.supported)
      return { supported: false, reason: 'Images of the whole computer are made on Windows in this version. Backup & restore keeps FBRX’s own data here.', configured: false, config: null, running: false, startedAt: null, last: null, versions: [], nextAt: null };
    const config = this.config();
    const s = this.statusFile();
    // A run that never wrote its end (the computer went off) counts as finished after a day.
    const running = s?.state === 'running' && !!s.startedAt && now.getTime() - Date.parse(s.startedAt) < 24 * 3600_000;
    // While one is being made, the last finished one is the one before it.
    const done = s?.state === 'running' ? (s.previous ?? null) : s;
    const last: ImageBackupRun | null =
      done && done.state !== 'running' && done.startedAt ? { at: done.startedAt, finishedAt: done.finishedAt ?? null, ok: !!done.ok, target: done.target ?? '', detail: (done.detail ?? '').slice(0, 2000) } : null;
    const versions = Array.isArray(done?.versions) ? done.versions : typeof done?.versions === 'string' && done.versions ? [done.versions] : [];
    return {
      supported: true,
      reason: null,
      configured: !!config,
      config,
      running,
      startedAt: running ? (s?.startedAt ?? null) : null,
      last,
      versions: [...versions].reverse(),
      nextAt: config ? (nextDue(config.schedule, config.time, config.day, now)?.toISOString() ?? null) : null,
    };
  }

  /** Sets image backups up (or changes them): one administrator prompt on this computer. password undefined: keep the one saved. */
  async configure(c: ImageBackupConfig, password: string | null | undefined): Promise<ImageBackupStatus> {
    if (!this.supported) throw new CoreError('UNAVAILABLE', 'Images of the whole computer are made on Windows in this version');
    const problem = targetProblem(c.target);
    if (problem) throw new CoreError('INVALID_ARGUMENT', problem);
    if (!SCHEDULE_TIME_PATTERN.test(c.time)) throw new CoreError('INVALID_ARGUMENT', 'Pick a time like 21:30');
    if (DRIVE.test(c.target) && (c.user || password)) throw new CoreError('INVALID_ARGUMENT', 'A drive needs no account: the account is for a network folder');
    const r = await this.d.elevated(setupScript({ ...c, target: c.target.trim(), user: c.user.trim() }, DRIVE.test(c.target.trim()) ? null : password), { timeoutMs: 120_000 });
    if (!r.ok || !/set up/.test(r.output)) {
      this.d.audit('imageBackup.configure', 'failure', { target: c.target, output: r.output.slice(-400) });
      throw new CoreError('INTERNAL', `Windows did not set it up: ${r.output.trim().split('\n').slice(-3).join(' ') || 'no answer'}`);
    }
    this.d.audit('imageBackup.configure', 'success', { target: c.target, schedule: c.schedule, time: c.time, day: c.day, account: !!c.user });
    return this.status();
  }

  /** Starts an image now (the task runs as the system; no prompt once it is set up). */
  async run(actor: string): Promise<ImageBackupStatus> {
    if (!this.supported) throw new CoreError('UNAVAILABLE', 'Images of the whole computer are made on Windows in this version');
    const st = this.status();
    if (!st.configured) throw new CoreError('CONFLICT', 'Image backups are not set up on this computer: FBRX → Backup → Whole computer');
    if (st.running) throw new CoreError('CONFLICT', 'An image is being made now');
    const r = await this.d.ps(`Start-ScheduledTask -TaskPath ${psq(TASK_PATH)} -TaskName ${psq(TASK_NAME)}; 'started'`, 30_000);
    if (r.code !== 0 || !/started/.test(r.out)) {
      // Set up before people could start it themselves: ask for administrator once more.
      if (actor === 'control-plane') throw new CoreError('FORBIDDEN', `Windows did not let FBRX start the task: ${errorMessage(r.err.trim() || r.out.trim())}`);
      const e = await this.d.elevated(`Start-ScheduledTask -TaskPath ${psq(TASK_PATH)} -TaskName ${psq(TASK_NAME)}; 'started'`, { timeoutMs: 60_000 });
      if (!e.ok) throw new CoreError('INTERNAL', `The image did not start: ${e.output.trim().slice(-300)}`);
    }
    this.d.audit('imageBackup.run', 'success', { target: st.config?.target, actor });
    this.d.log.info('Started a whole-computer image', { target: st.config?.target, actor });
    return { ...this.status(), running: true, startedAt: new Date().toISOString() };
  }

  /** Stops image backups here (the images already made stay where they are). */
  async remove(): Promise<ImageBackupStatus> {
    if (!this.supported) throw new CoreError('UNAVAILABLE', 'Images of the whole computer are made on Windows in this version');
    const r = await this.d.elevated(removeScript(), { timeoutMs: 60_000 });
    if (!r.ok) throw new CoreError('INTERNAL', `Windows did not remove it: ${r.output.trim().slice(-300)}`);
    this.d.audit('imageBackup.remove', 'success', {});
    return this.status();
  }

  /** For the heartbeat to FBRX Command: set up or not, and the last image. */
  summary(): { configured: boolean; lastAt: string | null; ok: boolean | null; running: boolean } | null {
    if (!this.supported) return null;
    const s = this.status();
    return { configured: s.configured, lastAt: s.last?.at ?? null, ok: s.last ? s.last.ok : null, running: s.running };
  }
}
