import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import si from 'systeminformation';
import type { AuditItem, DefenderStatus, DefenderThreat, ElevatedResult, FileReport, FirewallProfile, ListeningPort } from '@fbrx/shared';
import { CoreError } from '../errors';
import { expandPath } from '../system/files';
import { arr, elevated, exec, IS_WIN, ps, psJson, psq, requireWindows } from './ps';

const MPCMD = '"$env:ProgramFiles\\Windows Defender\\MpCmdRun.exe"';
const iso = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export async function defenderStatus(): Promise<DefenderStatus> {
  requireWindows('Microsoft Defender');
  const [s] = await psJson(
    "Get-MpComputerStatus | Select-Object AntivirusEnabled,RealTimeProtectionEnabled,BehaviorMonitorEnabled,IsTamperProtected,AntivirusSignatureVersion,AntivirusSignatureAge,AMEngineVersion,@{n='QuickScanEnd';e={ if ($_.QuickScanEndTime) { $_.QuickScanEndTime.ToUniversalTime().ToString('o') } }},@{n='FullScanEnd';e={ if ($_.FullScanEndTime) { $_.FullScanEndTime.ToUniversalTime().ToString('o') } }}",
    30_000,
  ).catch(() => [] as any[]);
  if (!s) throw new CoreError('UNAVAILABLE', 'Microsoft Defender status is unavailable (another antivirus may be active)');
  return {
    realtime: !!s.RealTimeProtectionEnabled,
    antivirus: !!s.AntivirusEnabled,
    tamperProtected: !!s.IsTamperProtected,
    behaviorMonitor: !!s.BehaviorMonitorEnabled,
    signatureVersion: s.AntivirusSignatureVersion ?? '',
    signatureAgeDays: typeof s.AntivirusSignatureAge === 'number' ? s.AntivirusSignatureAge : null,
    engineVersion: s.AMEngineVersion ?? '',
    lastQuickScan: iso(s.QuickScanEnd),
    lastFullScan: iso(s.FullScanEnd),
  };
}

const PREFS = [
  'DisableRealtimeMonitoring',
  'DisableBehaviorMonitoring',
  'DisableIOAVProtection',
  'DisableScriptScanning',
  'DisableArchiveScanning',
  'DisableEmailScanning',
  'DisableRemovableDriveScanning',
  'MAPSReporting',
  'SubmitSamplesConsent',
  'CloudBlockLevel',
  'PUAProtection',
  'EnableControlledFolderAccess',
  'EnableNetworkProtection',
  'ScanAvgCPULoadFactor',
  'CheckForSignaturesBeforeRunningScan',
  'SignatureUpdateInterval',
];

export async function defenderPrefs(): Promise<Record<string, unknown>> {
  requireWindows('Microsoft Defender');
  const [p] = await psJson(`Get-MpPreference | Select-Object ${PREFS.join(',')},ExclusionPath,ExclusionExtension,ExclusionProcess`, 30_000);
  return p ?? {};
}

export function setDefenderPref(name: string, value: boolean | number | string): Promise<ElevatedResult> {
  requireWindows('Microsoft Defender');
  if (!PREFS.includes(name)) throw new CoreError('INVALID_ARGUMENT', 'Unsupported preference');
  const v = typeof value === 'boolean' ? (value ? '$true' : '$false') : Number.isFinite(Number(value)) ? String(Number(value)) : psq(value);
  return elevated(`Set-MpPreference -${name} ${v}; "${name} is now $((Get-MpPreference).${name})"`);
}

export function exclusion(kind: 'path' | 'ext' | 'process', value: string, remove = false): Promise<ElevatedResult> {
  requireWindows('Microsoft Defender');
  const k = { path: 'ExclusionPath', ext: 'ExclusionExtension', process: 'ExclusionProcess' }[kind];
  if (!k || !value.trim()) throw new CoreError('INVALID_ARGUMENT', 'Enter what to exclude');
  return elevated(`${remove ? 'Remove' : 'Add'}-MpPreference -${k} ${psq(value.trim())}; 'Exclusions now:'; (Get-MpPreference).${k}`);
}

export async function threats(): Promise<DefenderThreat[]> {
  requireWindows('Microsoft Defender');
  const [det, thr] = await Promise.all([
    psJson("Get-MpThreatDetection | Select-Object ThreatID,@{n='Time';e={$_.InitialDetectionTime.ToUniversalTime().ToString('o')}},Resources,ThreatStatusID", 30_000).catch(() => [] as any[]),
    psJson('Get-MpThreat | Select-Object ThreatID,ThreatName,SeverityID,IsActive', 30_000).catch(() => [] as any[]),
  ]);
  const sev: Record<number, string> = { 0: 'Unknown', 1: 'Low', 2: 'Moderate', 4: 'High', 5: 'Severe' };
  const status: Record<number, string> = { 0: 'Unknown', 1: 'Detected', 2: 'Cleaned', 3: 'Quarantined', 4: 'Removed', 5: 'Allowed', 6: 'Blocked', 102: 'Quarantine failed', 103: 'Remove failed', 104: 'Allow failed', 105: 'Abandoned', 107: 'Block failed' };
  return det
    .map((d) => {
      const t = thr.find((x) => String(x.ThreatID) === String(d.ThreatID)) ?? {};
      return {
        id: String(d.ThreatID),
        name: t.ThreatName ?? `Threat ${d.ThreatID}`,
        severity: sev[t.SeverityID] ?? 'Unknown',
        active: !!t.IsActive,
        time: iso(d.Time),
        status: status[d.ThreatStatusID] ?? String(d.ThreatStatusID),
        resources: arr<string>(d.Resources).slice(0, 5),
      };
    })
    .sort((a, b) => String(b.time).localeCompare(String(a.time)));
}

export async function scan(type: 'quick' | 'full' | 'custom', path?: string): Promise<{ threatsFound: boolean; output: string }> {
  requireWindows('Microsoft Defender');
  const t = { quick: 1, full: 2, custom: 3 }[type];
  if (!t) throw new CoreError('INVALID_ARGUMENT', 'Unknown scan type');
  const target = t === 3 ? ` -File ${psq(expandPath(path ?? ''))}` : '';
  const r = await ps(`& ${MPCMD} -Scan -ScanType ${t}${target} 2>&1 | ForEach-Object { $_ }; "EXIT:$LASTEXITCODE"`, 6 * 3600_000);
  const out = r.out.trim();
  const code = Number(out.match(/EXIT:(-?\d+)/)?.[1] ?? -1);
  return { threatsFound: code === 2 || (/found \d+ threats?/i.test(out) && !/found no threats/i.test(out)), output: out.replace(/EXIT:-?\d+/, '').trim() };
}

export async function updateSignatures(): Promise<{ ok: boolean; output: string }> {
  requireWindows('Microsoft Defender');
  const r = await ps(`& ${MPCMD} -SignatureUpdate 2>&1; "EXIT:$LASTEXITCODE"`, 600_000);
  return { ok: /EXIT:0/.test(r.out), output: r.out.replace(/EXIT:-?\d+/, '').trim() };
}

export function removeThreats(): Promise<ElevatedResult> {
  requireWindows('Microsoft Defender');
  return elevated("Remove-MpThreat; 'Active threats removed.'; Get-MpThreat | Select-Object ThreatName,IsActive | Format-Table -AutoSize");
}

export async function firewall(): Promise<FirewallProfile[]> {
  requireWindows('Windows Firewall');
  const list = await psJson("Get-NetFirewallProfile | Select-Object Name,Enabled,@{n='Inbound';e={[string]$_.DefaultInboundAction}},@{n='Outbound';e={[string]$_.DefaultOutboundAction}}", 30_000);
  return list.map((p) => ({ name: p.Name, enabled: !!p.Enabled, inbound: p.Inbound, outbound: p.Outbound }));
}

export function setFirewall(profile: string, enabled: boolean): Promise<ElevatedResult> {
  requireWindows('Windows Firewall');
  if (!['Domain', 'Private', 'Public'].includes(profile)) throw new CoreError('INVALID_ARGUMENT', 'Unknown firewall profile');
  return elevated(`Set-NetFirewallProfile -Profile ${profile} -Enabled ${enabled ? 'True' : 'False'}; Get-NetFirewallProfile -Profile ${profile} | Format-List Name,Enabled`);
}

/** Programs listening for network connections; "exposed" ones accept connections from other computers. */
export async function listeningPorts(): Promise<ListeningPort[]> {
  const exposed = (a: string) => !/^(127\.|::1$|localhost)/.test(a);
  if (!IS_WIN) {
    const c = await si.networkConnections().catch(() => []);
    return c
      .filter((x) => x.state === 'LISTEN')
      .map((x) => ({ protocol: 'TCP' as const, address: x.localAddress, port: Number(x.localPort), pid: x.pid, process: x.process, exposed: exposed(x.localAddress) }))
      .sort((a, b) => a.port - b.port);
  }
  const r = await psJson(
    "$p=@{}; Get-Process | ForEach-Object { $p[$_.Id]=$_.ProcessName }; @(Get-NetTCPConnection -State Listen | ForEach-Object { [pscustomobject]@{ proto='TCP'; address=$_.LocalAddress; port=$_.LocalPort; pid=$_.OwningProcess; process=$p[[int]$_.OwningProcess] } }) + @(Get-NetUDPEndpoint | Where-Object { $_.LocalPort -lt 49152 } | ForEach-Object { [pscustomobject]@{ proto='UDP'; address=$_.LocalAddress; port=$_.LocalPort; pid=$_.OwningProcess; process=$p[[int]$_.OwningProcess] } })",
    30_000,
  );
  const seen = new Set<string>();
  return r
    .filter((x) => {
      const k = `${x.proto}:${x.address}:${x.port}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((x) => ({ protocol: x.proto, address: x.address, port: x.port, pid: x.pid, process: x.process ?? '', exposed: exposed(x.address) }))
    .sort((a, b) => a.port - b.port);
}

/** Running programs started from user-writable folders, with their code signature: a classic malware signal. */
export async function processAudit(): Promise<AuditItem[]> {
  requireWindows('Process audit');
  const list = await psJson(
    "Get-Process | Where-Object { $_.Path -and ($_.Path -match '\\\\AppData\\\\|\\\\Temp\\\\|\\\\Downloads\\\\|\\\\Users\\\\Public\\\\|\\\\ProgramData\\\\') } | Group-Object Path | ForEach-Object { $x=$_.Group[0]; $sig=Get-AuthenticodeSignature -FilePath $x.Path -ErrorAction SilentlyContinue; [pscustomobject]@{ name=$x.ProcessName; pid=$x.Id; path=$x.Path; signed=[string]$sig.Status; signer=[string]$sig.SignerCertificate.Subject; count=$_.Count } }",
    90_000,
  );
  return list
    .map((x) => {
      const flags: string[] = [];
      if (x.signed !== 'Valid') flags.push('unsigned');
      if (/\\(Temp|Downloads|Users\\Public)\\/i.test(x.path)) flags.push('unusual location');
      return { name: x.name, detail: `PID ${x.pid}${x.count > 1 ? ` (+${x.count - 1})` : ''}${x.signer ? ` · ${String(x.signer).replace(/^CN=/, '').split(',')[0]}` : ''}`, path: x.path, signed: x.signed, flags };
    })
    .sort((a, b) => b.flags.length - a.flags.length);
}

/** Programs that start with Windows (startup entries and non-Microsoft scheduled tasks). */
export async function startupAudit(): Promise<AuditItem[]> {
  requireWindows('Startup audit');
  const [items, tasks] = await Promise.all([
    psJson('Get-CimInstance Win32_StartupCommand | Select-Object Name,Command,Location,User', 30_000).catch(() => [] as any[]),
    psJson(
      "Get-ScheduledTask | Where-Object { $_.TaskPath -notlike '\\Microsoft*' -and $_.State -ne 'Disabled' } | Select-Object TaskName,TaskPath,@{n='Action';e={ ($_.Actions | ForEach-Object { \"$($_.Execute) $($_.Arguments)\" }) -join '; ' }},Author",
      30_000,
    ).catch(() => [] as any[]),
  ]);
  const flag = (cmd: string) => {
    const f: string[] = [];
    if (/\\(AppData|Temp|Downloads|Users\\Public)\\/i.test(cmd)) f.push('user-writable location');
    if (/powershell.*(-enc|-e\s|frombase64)|mshta|wscript|cscript|rundll32.*,|regsvr32.*\/i:/i.test(cmd)) f.push('script launcher');
    return f;
  };
  return [
    ...items.map((x) => ({ name: x.Name, detail: `Startup · ${x.Location}${x.User ? ` · ${x.User}` : ''}`, path: x.Command ?? '', signed: '', flags: flag(String(x.Command ?? '')) })),
    ...tasks.map((x) => ({ name: x.TaskName, detail: `Scheduled task · ${x.TaskPath}${x.Author ? ` · ${x.Author}` : ''}`, path: x.Action ?? '', signed: '', flags: flag(String(x.Action ?? '')) })),
  ].sort((a, b) => b.flags.length - a.flags.length);
}

/** SHA-256, Authenticode signature and (with a saved key) VirusTotal verdict for a file. */
export async function fileReport(path: string, virustotalKey?: string): Promise<FileReport> {
  const file = expandPath(path);
  const st = await stat(file).catch(() => null);
  if (!st?.isFile()) throw new CoreError('NOT_FOUND', 'File not found');
  const sha256 = await new Promise<string>((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
  let signature: FileReport['signature'] = null;
  if (IS_WIN) {
    const [s] = await psJson(`Get-AuthenticodeSignature -FilePath ${psq(file)} | Select-Object @{n='Status';e={[string]$_.Status}},@{n='Signer';e={[string]$_.SignerCertificate.Subject}}`, 30_000).catch(() => [] as any[]);
    if (s) signature = { status: s.Status, signer: String(s.Signer ?? '').replace(/^CN=/, '').split(',')[0] };
  }
  let virustotal: FileReport['virustotal'] = null;
  if (virustotalKey) {
    try {
      const r = await fetch(`https://www.virustotal.com/api/v3/files/${sha256}`, { headers: { 'x-apikey': virustotalKey }, signal: AbortSignal.timeout(15_000) });
      if (r.status === 404) virustotal = { known: false, malicious: 0, suspicious: 0, harmless: 0, link: `https://www.virustotal.com/gui/file/${sha256}` };
      else if (r.ok) {
        const a = ((await r.json()) as any).data.attributes.last_analysis_stats;
        virustotal = { known: true, malicious: a.malicious ?? 0, suspicious: a.suspicious ?? 0, harmless: (a.harmless ?? 0) + (a.undetected ?? 0), link: `https://www.virustotal.com/gui/file/${sha256}` };
      } else virustotal = { error: `VirusTotal HTTP ${r.status}` };
    } catch (e) {
      virustotal = { error: (e as Error).message };
    }
  }
  return { path: file, size: st.size, sha256, signature, virustotal };
}

/**
 * Opens a link or folder inside Windows Sandbox: a throw-away virtual machine that is wiped when closed.
 * Clipboard, printers, microphone and camera are not shared; a mapped folder is read-only.
 */
export async function openSandbox(o: { url?: string; folder?: string; networking?: boolean }, workDir: string): Promise<void> {
  requireWindows('Windows Sandbox');
  const esc = (s: string) => s.replace(/[<>&"]/g, '');
  let url = '';
  if (o.url) {
    const u = new URL(/^[a-z]+:/i.test(o.url) ? o.url : `https://${o.url}`);
    if (!/^https?:$/.test(u.protocol)) throw new CoreError('INVALID_ARGUMENT', 'Only web links can be opened in the sandbox');
    url = u.href;
  }
  const folder = o.folder ? expandPath(o.folder) : '';
  const xml = `<Configuration>
  <VGpu>Disable</VGpu>
  <Networking>${o.networking === false ? 'Disable' : 'Enable'}</Networking>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <PrinterRedirection>Disable</PrinterRedirection>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <ProtectedClient>Enable</ProtectedClient>
  ${folder ? `<MappedFolders><MappedFolder><HostFolder>${esc(folder)}</HostFolder><SandboxFolder>C:\\Users\\WDAGUtilityAccount\\Desktop\\Shared</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder></MappedFolders>` : ''}
  ${url ? `<LogonCommand><Command>cmd.exe /c start "" "${esc(url)}"</Command></LogonCommand>` : ''}
</Configuration>
`;
  const dir = join(workDir, 'sandbox');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `fbrx-${Date.now()}.wsb`);
  await writeFile(file, xml, 'utf8');
  const r = await exec('where.exe', ['WindowsSandbox.exe']);
  if (r.code !== 0) throw new CoreError('UNAVAILABLE', 'Windows Sandbox is not enabled. Turn it on in Virtual lab (needs Windows Pro or Enterprise).');
  spawn('explorer.exe', [file], { detached: true, stdio: 'ignore' }).unref();
}

const SECURITY_PAGES: Record<string, string> = {
  home: 'windowsdefender:',
  virus: 'windowsdefender://threat',
  firewall: 'windowsdefender://network',
  apps: 'windowsdefender://appbrowser',
  device: 'windowsdefender://devicesecurity',
  history: 'windowsdefender://history',
};

export function openSecurityPage(page: string): void {
  requireWindows('Windows Security');
  const uri = SECURITY_PAGES[page];
  if (!uri) throw new CoreError('INVALID_ARGUMENT', 'Unknown page');
  spawn('explorer.exe', [uri], { detached: true, stdio: 'ignore' }).unref();
}
