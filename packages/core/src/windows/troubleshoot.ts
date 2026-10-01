import type { BugReport, ElevatedResult, EventLogEntry, FixInfo } from '@fbrx/shared';
import { CoreError } from '../errors';
import { arr, elevated, IS_WIN, ps, psJson, psq, requireWindows } from './ps';

/** Reads the Windows event log, crash reports and device/service state for the last `days` days. */
export async function bugScan(days = 3): Promise<BugReport> {
  const d = Math.max(1, Math.min(30, Math.round(days) || 3));
  if (!IS_WIN) return { days: d, events: [], crashes: [], stopErrors: [], unexpectedShutdowns: [], problemDevices: [], stoppedServices: [] };
  const r = await ps(
    `$since=(Get-Date).AddDays(-${d})
$ev=@(Get-WinEvent -FilterHashtable @{LogName='System','Application'; Level=1,2; StartTime=$since} -MaxEvents 600 -ErrorAction SilentlyContinue)
$groups=@($ev | Group-Object { "$($_.ProviderName)|$($_.Id)" } | Sort-Object Count -Descending | Select-Object -First 40 | ForEach-Object { $f=$_.Group[0]; [pscustomobject]@{ source=$f.ProviderName; eventId=$f.Id; level=$f.LevelDisplayName; count=$_.Count; last=$f.TimeCreated.ToUniversalTime().ToString('o'); message=([string]$f.Message).Substring(0,[math]::Min(400,([string]$f.Message).Length)) } })
$crash=@($ev | Where-Object { $_.ProviderName -eq 'Application Error' -and $_.Id -eq 1000 } | ForEach-Object { [pscustomobject]@{ app=[string]$_.Properties[0].Value; module=[string]$_.Properties[3].Value; time=$_.TimeCreated.ToUniversalTime().ToString('o') } })
$bsod=@(Get-WinEvent -FilterHashtable @{LogName='System'; Id=1001; ProviderName='Microsoft-Windows-WER-SystemErrorReporting'; StartTime=(Get-Date).AddDays(-90)} -MaxEvents 10 -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ time=$_.TimeCreated.ToUniversalTime().ToString('o'); code=$(if ([string]$_.Message -match '0x[0-9a-fA-F]{8}') { $matches[0] } else { 'unknown' }) } })
$kp=@(Get-WinEvent -FilterHashtable @{LogName='System'; Id=41; ProviderName='Microsoft-Windows-Kernel-Power'; StartTime=(Get-Date).AddDays(-30)} -MaxEvents 50 -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ time=$_.TimeCreated.ToUniversalTime().ToString('o') } })
$dev=@(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.Status -in 'Error','Degraded','Unknown' } | ForEach-Object { [pscustomobject]@{ name=[string]$_.FriendlyName; id=[string]$_.InstanceId; status=[string]$_.Status; error=[string]$_.Problem } })
$svc=@(Get-CimInstance Win32_Service -Filter "StartMode='Auto' AND State<>'Running'" | Where-Object { $_.Name -notmatch 'sppsvc|RemoteRegistry|edgeupdate|gupdate|MapsBroker|TrustedInstaller|WbioSrvc|GoogleUpdater|BITS|wuauserv|UsoSvc|tiledatamodelsvc|cbdhsvc|OneSyncSvc|CDPUserSvc|WpnUserService|ShellHWDetection|DoSvc|IntelAudioService' -and $_.ExitCode -ne 0 } | ForEach-Object { [pscustomobject]@{ name=$_.Name; display=$_.DisplayName } })
[pscustomobject]@{ events=$groups; crashes=$crash; bsod=$bsod; kp=$kp; devices=$dev; services=$svc } | ConvertTo-Json -Depth 4 -Compress`,
    120_000,
  );
  let j: any;
  try {
    j = JSON.parse(r.out.trim());
  } catch {
    throw new CoreError('INTERNAL', (r.err || r.out).slice(0, 300) || 'Event log scan failed');
  }
  return {
    days: d,
    events: arr<any>(j.events),
    crashes: arr<any>(j.crashes),
    stopErrors: arr<any>(j.bsod),
    unexpectedShutdowns: arr<any>(j.kp),
    problemDevices: arr<any>(j.devices).filter((x) => x.name),
    stoppedServices: arr<any>(j.services),
  };
}

const FIXES: Record<string, { label: string; admin: boolean; script: string }> = {
  sfc: { label: 'Repair system files (sfc /scannow)', admin: true, script: 'sfc /scannow' },
  dism: { label: 'Repair the Windows image (DISM RestoreHealth)', admin: true, script: 'DISM /Online /Cleanup-Image /RestoreHealth' },
  winsock: { label: 'Reset the network stack (Winsock + TCP/IP)', admin: true, script: 'netsh winsock reset; netsh int ip reset; ipconfig /flushdns; "Restart the PC to finish."' },
  flushdns: { label: 'Flush the DNS cache', admin: false, script: 'ipconfig /flushdns' },
  wureset: {
    label: 'Reset Windows Update components',
    admin: true,
    script:
      "Stop-Service wuauserv,bits,cryptsvc -Force -ErrorAction SilentlyContinue; Rename-Item \"$env:windir\\SoftwareDistribution\" \"SoftwareDistribution.bak-$(Get-Date -f yyyyMMddHHmm)\" -ErrorAction SilentlyContinue; Start-Service cryptsvc,bits,wuauserv; 'Windows Update cache reset.'",
  },
  explorer: { label: 'Restart Windows Explorer (taskbar and desktop)', admin: false, script: 'Stop-Process -Name explorer -Force; Start-Sleep 1; Start-Process explorer.exe; "Explorer restarted."' },
  iconcache: {
    label: 'Rebuild the icon and thumbnail cache',
    admin: false,
    script:
      "Stop-Process -Name explorer -Force; Remove-Item \"$env:LOCALAPPDATA\\IconCache.db\" -Force -ErrorAction SilentlyContinue; Remove-Item \"$env:LOCALAPPDATA\\Microsoft\\Windows\\Explorer\\iconcache_*\",\"$env:LOCALAPPDATA\\Microsoft\\Windows\\Explorer\\thumbcache_*\" -Force -ErrorAction SilentlyContinue; Start-Process explorer.exe; 'Caches cleared.'",
  },
  spooler: {
    label: 'Clear a stuck print queue',
    admin: true,
    script: "Stop-Service Spooler -Force; Remove-Item \"$env:windir\\System32\\spool\\PRINTERS\\*\" -Force -ErrorAction SilentlyContinue; Start-Service Spooler; 'Print queue cleared.'",
  },
  storeapps: { label: 'Reset the Microsoft Store cache', admin: false, script: 'Start-Process wsreset.exe -Wait; "Store cache reset."' },
  timesync: { label: 'Resync the system clock', admin: true, script: 'Start-Service w32time -ErrorAction SilentlyContinue; w32tm /resync /force' },
  battery: {
    label: 'Battery health report',
    admin: false,
    script: '$f="$env:USERPROFILE\\Desktop\\battery-report.html"; powercfg /batteryreport /output $f | Out-Null; Start-Process $f; "Saved to $f"',
  },
  energy: { label: 'Power efficiency diagnostics (60 s)', admin: true, script: '$f="$env:USERPROFILE\\Desktop\\energy-report.html"; powercfg /energy /output $f /duration 60; "Saved to $f"' },
};

export function fixes(): FixInfo[] {
  return [
    ...Object.entries(FIXES).map(([id, f]) => ({ id, label: f.label, admin: f.admin, target: 'none' as const })),
    { id: 'service', label: 'Start a stopped service', admin: true, target: 'service' },
    { id: 'device', label: 'Restart a problem device', admin: true, target: 'device' },
  ];
}

export async function runFix(id: string, target?: string): Promise<ElevatedResult> {
  requireWindows('Fixes');
  if (id === 'service') {
    if (!target || !/^[\w.$-]{1,256}$/.test(target)) throw new CoreError('INVALID_ARGUMENT', 'Choose a service');
    return elevated(`Start-Service -Name ${psq(target)} -Verbose; Get-Service -Name ${psq(target)} | Format-List Name,Status`);
  }
  if (id === 'device') {
    if (!target) throw new CoreError('INVALID_ARGUMENT', 'Choose a device');
    return elevated(
      `$d=Get-PnpDevice -InstanceId ${psq(target)}; $d | Disable-PnpDevice -Confirm:$false; Start-Sleep 2; $d | Enable-PnpDevice -Confirm:$false; Get-PnpDevice -InstanceId ${psq(target)} | Format-List FriendlyName,Status`,
    );
  }
  const f = FIXES[id];
  if (!f) throw new CoreError('NOT_FOUND', 'Unknown fix');
  if (f.admin) return elevated(f.script);
  const r = await ps(f.script, 600_000);
  return { ok: r.code === 0, output: (r.out + r.err).trim() };
}

const LEVELS = { 1: 'critical', 2: 'error', 3: 'warning', 4: 'information', 0: 'information' } as const;

/** Recent entries of a Windows event log, newest first (for the bug catcher's log view). */
export async function eventLog(log: 'System' | 'Application' | 'Setup', days = 3, minLevel: 'error' | 'warning' | 'information' = 'warning', limit = 300): Promise<EventLogEntry[]> {
  requireWindows('The event log');
  const levels = minLevel === 'error' ? '1,2' : minLevel === 'warning' ? '1,2,3' : '0,1,2,3,4';
  const rows = await psJson<{ t: string; l: number; s: string; i: number; m: string }>(
    `Get-WinEvent -FilterHashtable @{LogName=${psq(log)}; Level=${levels}; StartTime=(Get-Date).AddDays(-${Math.max(1, Math.min(30, Math.floor(days)))})} -MaxEvents ${Math.max(1, Math.min(2000, Math.floor(limit)))} -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ t=$_.TimeCreated.ToUniversalTime().ToString('o'); l=[int]$_.Level; s=[string]$_.ProviderName; i=[int]$_.Id; m=([string]$_.Message).Substring(0, [Math]::Min(1500, ([string]$_.Message).Length)) } }`,
    90_000,
  );
  return rows.map((r) => ({ time: r.t, log, level: LEVELS[r.l as keyof typeof LEVELS] ?? 'information', source: r.s, eventId: r.i, message: (r.m ?? '').trim() }));
}
