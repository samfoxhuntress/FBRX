import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { LAB_FEATURES, VM_ACTIONS, type ElevatedResult, type LabStatus, type VmInfo, type VmSpec } from '@fbrx/shared';
import { CoreError } from '../errors';
import { elevated, ps, psObject, psq, requireWindows } from './ps';

type FeatureState = LabStatus['hyperv'];

export async function labStatus(): Promise<LabStatus> {
  requireWindows('The virtual lab');
  const j = await psObject<any>(
    `$os=Get-CimInstance Win32_OperatingSystem; $cpu=Get-CimInstance Win32_Processor | Select-Object -First 1
$f=@{}; Get-CimInstance Win32_OptionalFeature -Filter "Name='Microsoft-Hyper-V-All' OR Name='Containers-DisposableClientVM' OR Name='VirtualMachinePlatform' OR Name='Microsoft-Windows-Subsystem-Linux'" | ForEach-Object { $f[$_.Name]=[int]$_.InstallState }
$adm=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
[pscustomobject]@{ edition=$os.Caption; vt=$cpu.VirtualizationFirmwareEnabled; features=$f; admin=$adm } | ConvertTo-Json -Compress`,
    60_000,
    'Could not read virtualization status',
  );
  const st = (n: string): FeatureState => ({ 1: 'enabled', 2: 'disabled' } as Record<number, FeatureState>)[j.features?.[n]] ?? 'unavailable';
  return {
    edition: j.edition ?? '',
    admin: !!j.admin,
    hyperv: st('Microsoft-Hyper-V-All'),
    sandbox: st('Containers-DisposableClientVM'),
    vmPlatform: st('VirtualMachinePlatform'),
    wsl: st('Microsoft-Windows-Subsystem-Linux'),
    virtualizationFirmware: typeof j.vt === 'boolean' ? j.vt : null,
  };
}

export function enableFeature(feature: string): Promise<ElevatedResult> {
  requireWindows('The virtual lab');
  if (!(LAB_FEATURES as readonly string[]).includes(feature)) throw new CoreError('INVALID_ARGUMENT', 'Unknown feature');
  return elevated(`Enable-WindowsOptionalFeature -Online -FeatureName ${feature} -All -NoRestart | Format-List RestartNeeded; 'Restart Windows to finish enabling the feature.'`);
}

const VM_SELECT =
  "Select-Object Name,@{n='State';e={[string]$_.State}},CPUUsage,@{n='MemoryMB';e={[math]::Round($_.MemoryAssigned/1MB)}},@{n='Uptime';e={[int]$_.Uptime.TotalSeconds}},Generation,@{n='Switch';e={ ($_.NetworkAdapters | Select-Object -First 1).SwitchName }},@{n='Checkpoints';e={ @(Get-VMSnapshot -VMName $_.Name -ErrorAction SilentlyContinue).Count }},@{n='Cpus';e={$_.ProcessorCount}}";

const toVm = (v: any): VmInfo => ({
  name: v.Name,
  state: v.State,
  cpuUsage: v.CPUUsage ?? 0,
  memoryMB: v.MemoryMB ?? 0,
  uptimeSeconds: v.Uptime ?? 0,
  generation: v.Generation ?? 2,
  network: v.Switch || 'Not connected',
  checkpoints: v.Checkpoints ?? 0,
  cpus: v.Cpus ?? 1,
});

/** Lists Hyper-V virtual machines. Reading VMs needs Hyper-V Administrators membership or elevation. */
export async function vmList(asAdmin = false): Promise<{ vms: VmInfo[]; error: string | null }> {
  requireWindows('The virtual lab');
  const parse = (text: string) => {
    const t = text.trim();
    const j = t ? JSON.parse(t) : [];
    return (Array.isArray(j) ? j : [j]).map(toVm);
  };
  if (asAdmin) {
    const r = await elevated(`Get-VM | ${VM_SELECT} | ConvertTo-Json -Compress`);
    try {
      return { vms: parse(r.output || '[]'), error: null };
    } catch {
      return { vms: [], error: r.output.slice(0, 300) };
    }
  }
  const r = await ps(`Get-VM -ErrorAction Stop | ${VM_SELECT} | ConvertTo-Json -Compress`, 40_000);
  if (/permission|not have the required|access is denied/i.test(r.err)) return { vms: [], error: 'needs-admin' };
  if (/not recognized|Get-VM/i.test(r.err) && !r.out.trim()) return { vms: [], error: 'not-installed' };
  try {
    return { vms: parse(r.out), error: null };
  } catch {
    return { vms: [], error: r.err.slice(0, 300) };
  }
}

export function vmCreateScript(spec: VmSpec): string {
  const name = String(spec.name ?? '').replace(/[^\w .-]/g, '').trim().slice(0, 60) || 'FBRX-Lab';
  const mem = Math.max(1, Math.min(64, Math.round(Number(spec.memoryGB) || 4)));
  const disk = Math.max(10, Math.min(2000, Math.round(Number(spec.diskGB) || 60)));
  const cpus = Math.max(1, Math.min(32, Math.round(Number(spec.cpus) || 2)));
  const net = spec.network === 'isolated' ? 'FBRX-Isolated' : spec.network === 'internet' ? 'Default Switch' : '';
  if (spec.iso && (!/\.iso$/i.test(spec.iso) || !existsSync(spec.iso))) throw new CoreError('INVALID_ARGUMENT', 'Choose an existing .iso file');
  const linux = spec.os === 'linux';
  return [
    "$ErrorActionPreference='Stop'",
    `$name=${psq(name)}`,
    "$vhdDir=Join-Path (Get-VMHost).VirtualHardDiskPath 'FBRX'; New-Item -ItemType Directory -Force -Path $vhdDir | Out-Null",
    net === 'FBRX-Isolated'
      ? "if (-not (Get-VMSwitch -Name 'FBRX-Isolated' -ErrorAction SilentlyContinue)) { New-VMSwitch -Name 'FBRX-Isolated' -SwitchType Private | Out-Null; 'Created isolated switch FBRX-Isolated (no host or internet access).' }"
      : '',
    `$vm=New-VM -Name $name -Generation 2 -MemoryStartupBytes ${mem}GB -NewVHDPath (Join-Path $vhdDir "$name.vhdx") -NewVHDSizeBytes ${disk}GB ${net ? `-SwitchName ${psq(net)}` : ''}`,
    `Set-VMProcessor -VMName $name -Count ${cpus}`,
    `Set-VMMemory -VMName $name -DynamicMemoryEnabled $true -MinimumBytes 1GB -MaximumBytes ${mem}GB`,
    spec.iso ? `$dvd=Add-VMDvdDrive -VMName $name -Path ${psq(spec.iso)} -Passthru; Set-VMFirmware -VMName $name -FirstBootDevice $dvd` : '',
    linux ? "Set-VMFirmware -VMName $name -EnableSecureBoot On -SecureBootTemplate 'MicrosoftUEFICertificateAuthority'" : 'Set-VMKeyProtector -VMName $name -NewLocalKeyProtector; Enable-VMTPM -VMName $name',
    spec.hardened
      ? "Disable-VMIntegrationService -VMName $name -Name 'Guest Service Interface' -ErrorAction SilentlyContinue; Set-VM -VMName $name -EnhancedSessionTransportType HvSocket -AutomaticCheckpointsEnabled $false; 'Hardened: guest file copy disabled; use Basic session to avoid shared clipboard and drives.'"
      : 'Set-VM -VMName $name -AutomaticCheckpointsEnabled $false',
    "Checkpoint-VM -Name $name -SnapshotName 'FBRX: created (empty)'",
    `"VM '$name' created: ${cpus} vCPU, ${mem} GB memory, ${disk} GB disk, network: ${net || 'none'}."`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function createVm(spec: VmSpec): Promise<ElevatedResult> {
  requireWindows('The virtual lab');
  return elevated(vmCreateScript(spec));
}

export function vmAction(name: string, action: string, arg?: string): Promise<ElevatedResult> {
  requireWindows('The virtual lab');
  if (!(VM_ACTIONS as readonly string[]).includes(action)) throw new CoreError('INVALID_ARGUMENT', 'Unknown VM action');
  if (!name.trim()) throw new CoreError('INVALID_ARGUMENT', 'Choose a VM');
  const n = psq(name);
  const scripts: Record<string, string> = {
    start: `Start-VM -Name ${n}; 'Started'`,
    stop: `Stop-VM -Name ${n} -Force; 'Shut down'`,
    off: `Stop-VM -Name ${n} -TurnOff -Force; 'Powered off'`,
    save: `Save-VM -Name ${n}; 'Saved'`,
    checkpoint: `Checkpoint-VM -Name ${n} -SnapshotName ${psq((arg ?? '').slice(0, 100) || `FBRX checkpoint ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`)}; 'Checkpoint created'`,
    revert: `$s=Get-VMSnapshot -VMName ${n} | Sort-Object CreationTime | Select-Object -Last 1; Restore-VMSnapshot -VMSnapshot $s -Confirm:$false; "Reverted to $($s.Name)"`,
    isolate: `if (-not (Get-VMSwitch -Name 'FBRX-Isolated' -ErrorAction SilentlyContinue)) { New-VMSwitch -Name 'FBRX-Isolated' -SwitchType Private | Out-Null }; Get-VMNetworkAdapter -VMName ${n} | Connect-VMNetworkAdapter -SwitchName 'FBRX-Isolated'; 'Network isolated'`,
    internet: `Get-VMNetworkAdapter -VMName ${n} | Connect-VMNetworkAdapter -SwitchName 'Default Switch'; 'Connected to the Default Switch (internet through NAT)'`,
    disconnect: `Get-VMNetworkAdapter -VMName ${n} | Disconnect-VMNetworkAdapter; 'Network unplugged'`,
    delete: `$v=Get-VM -Name ${n}; Stop-VM -VM $v -TurnOff -Force -ErrorAction SilentlyContinue; $d=($v | Get-VMHardDiskDrive).Path; Get-VMSnapshot -VM $v | Remove-VMSnapshot -ErrorAction SilentlyContinue; Remove-VM -VM $v -Force; ${arg === 'disks' ? '$d | ForEach-Object { Remove-Item $_ -Force -ErrorAction SilentlyContinue };' : ''} 'Deleted'`,
  };
  return elevated(scripts[action]);
}

export function openManager(): void {
  requireWindows('Hyper-V Manager');
  spawn('mmc.exe', ['virtmgmt.msc'], { detached: true, stdio: 'ignore' }).unref();
}

/** Opens Virtual Machine Connection for a VM (Windows asks for administrator rights if the account needs them). */
export function openConsole(name: string): void {
  requireWindows('The VM console');
  const n = name.replace(/["\r\n]/g, '').trim();
  if (!n) throw new CoreError('INVALID_ARGUMENT', 'Choose a VM');
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process vmconnect.exe -ArgumentList @('localhost', '"' + ${psq(n)} + '"')`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
