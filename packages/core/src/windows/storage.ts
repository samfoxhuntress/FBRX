import { existsSync } from 'node:fs';
import { lstat, readdir, rmdir, stat, unlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import si from 'systeminformation';
import type { CleanupInfo, DriveInfo, ElevatedResult, FolderUsage, PhysicalDiskInfo, STORAGE_ACTIONS } from '@fbrx/shared';
import { CoreError } from '../errors';
import { expandPath } from '../system/files';
import { arr, elevated, IS_WIN, ps, psJson, psq, requireWindows } from './ps';

const letterOf = (l: string | undefined): string => {
  const c = String(l ?? '').trim()[0]?.toUpperCase();
  if (!c || !/[A-Z]/.test(c)) throw new CoreError('INVALID_ARGUMENT', 'Choose a drive letter');
  return c;
};

export async function drives(): Promise<DriveInfo[]> {
  if (!IS_WIN) {
    const fsz = await si.fsSize().catch(() => []);
    return fsz
      .filter((d) => d.size > 0 && !/^\/(snap|boot\/efi|run|dev|sys|proc)/.test(d.mount))
      .map((d) => ({ letter: d.mount, label: d.fs, fs: d.type, type: 'Fixed', size: d.size, free: d.available, health: 'Healthy', bitlocker: null }));
  }
  const vols = await psJson('Get-Volume | Where-Object { $_.DriveLetter } | Select-Object DriveLetter,FileSystemLabel,FileSystem,@{n=\'DriveType\';e={[string]$_.DriveType}},@{n=\'HealthStatus\';e={[string]$_.HealthStatus}},Size,SizeRemaining');
  const bl: Record<string, number> = {};
  try {
    const b = await psJson(
      "$sh=New-Object -ComObject Shell.Application; Get-Volume | Where-Object { $_.DriveLetter } | ForEach-Object { [pscustomobject]@{ L=[string]$_.DriveLetter; P=$sh.NameSpace(\"$($_.DriveLetter):\").Self.ExtendedProperty('System.Volume.BitLockerProtection') } }",
      20_000,
    );
    for (const x of b) bl[x.L] = x.P;
  } catch {
    /* BitLocker status is optional */
  }
  const blText: Record<number, string> = { 1: 'On', 2: 'Off', 3: 'Encrypting', 4: 'Decrypting', 5: 'Suspended', 6: 'On (locked)' };
  return vols
    .map((v) => ({
      letter: `${v.DriveLetter}:`,
      label: v.FileSystemLabel || (v.DriveType === 'Removable' ? 'USB drive' : 'Local Disk'),
      fs: v.FileSystem ?? '',
      type: v.DriveType,
      size: v.Size ?? 0,
      free: v.SizeRemaining ?? 0,
      health: v.HealthStatus,
      bitlocker: blText[bl[v.DriveLetter]] ?? null,
    }))
    .sort((a, b) => a.letter.localeCompare(b.letter));
}

const GPT: Record<string, string> = {
  '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}': 'EFI System',
  '{e3c9e316-0b5c-4db8-817d-f92df00215ae}': 'Microsoft Reserved',
  '{de94bba4-06d1-4d40-a16a-bfd50179d6ac}': 'Recovery',
  '{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}': 'Basic data',
};
const BUS: Record<number, string> = { 17: 'NVMe', 11: 'SATA', 7: 'USB', 8: 'RAID', 10: 'SAS', 3: 'ATA', 12: 'SD', 6: 'Fibre', 15: 'Virtual' };

/** Physical disks with health, wear and temperature, and their partitions. */
export async function physicalDisks(): Promise<PhysicalDiskInfo[]> {
  requireWindows('Disk details');
  const r = await ps(
    `$pd = @(Get-PhysicalDisk | Select-Object DeviceId,FriendlyName,MediaType,BusType,Size,HealthStatus,SerialNumber)
$dk = @(Get-Disk | Select-Object Number,FriendlyName,PartitionStyle,IsBoot,IsSystem,Size)
$pt = @(Get-Partition | Select-Object DiskNumber,PartitionNumber,DriveLetter,Size,Offset,Type,GptType,IsBoot,IsSystem,IsHidden)
$vl = @(Get-Volume | Select-Object DriveLetter,FileSystemLabel,FileSystem,SizeRemaining)
$rc = @(Get-PhysicalDisk | ForEach-Object { $c = $_ | Get-StorageReliabilityCounter -ErrorAction SilentlyContinue; if ($c) { [pscustomobject]@{ DeviceId=$_.DeviceId; Temperature=$c.Temperature; Wear=$c.Wear } } })
[pscustomobject]@{ pd=$pd; dk=$dk; pt=$pt; vl=$vl; rc=$rc } | ConvertTo-Json -Depth 4 -Compress`,
    60_000,
  );
  let j: any;
  try {
    j = JSON.parse(r.out.trim());
  } catch {
    throw new CoreError('INTERNAL', (r.err || r.out).slice(0, 300) || 'Could not read disks');
  }
  const vols = arr<any>(j.vl);
  return arr<any>(j.dk).map((d) => {
    const p = arr<any>(j.pd).find((x) => String(x.DeviceId) === String(d.Number)) ?? {};
    const c = arr<any>(j.rc).find((x) => String(x.DeviceId) === String(d.Number)) ?? {};
    return {
      number: d.Number,
      model: d.FriendlyName ?? p.FriendlyName ?? 'Disk',
      media: p.MediaType === 4 ? 'SSD' : p.MediaType === 3 ? 'HDD' : p.MediaType === 5 ? 'SCM' : String(p.MediaType ?? 'Unspecified'),
      bus: BUS[p.BusType] ?? String(p.BusType ?? ''),
      size: d.Size ?? 0,
      health: ({ 0: 'Healthy', 1: 'Warning', 2: 'Unhealthy', 5: 'Unknown' } as Record<number, string>)[p.HealthStatus] ?? String(p.HealthStatus ?? ''),
      serial: String(p.SerialNumber ?? '').trim(),
      partitionStyle: d.PartitionStyle === 2 ? 'GPT' : d.PartitionStyle === 1 ? 'MBR' : d.PartitionStyle === 0 ? 'RAW' : String(d.PartitionStyle ?? ''),
      isBoot: !!d.IsBoot,
      temperatureC: c.Temperature || null,
      wearPercent: c.Wear ?? null,
      partitions: arr<any>(j.pt)
        .filter((x) => x.DiskNumber === d.Number)
        .sort((a, b) => a.Offset - b.Offset)
        .map((x) => {
          const v = vols.find((vv) => x.DriveLetter && vv.DriveLetter === x.DriveLetter) ?? {};
          return {
            number: x.PartitionNumber,
            letter: x.DriveLetter ? `${x.DriveLetter}:` : '',
            type: GPT[String(x.GptType ?? '').toLowerCase()] ?? String(x.Type ?? ''),
            size: x.Size ?? 0,
            fs: v.FileSystem ?? '',
            label: v.FileSystemLabel ?? '',
            free: v.SizeRemaining ?? null,
            isBoot: !!x.IsBoot,
            isSystem: !!x.IsSystem,
            hidden: !!x.IsHidden,
          };
        }),
    };
  });
}

/** Sizes of the immediate children of a folder plus its largest files, within a time budget. */
export async function analyzeFolder(path: string, budgetMs = 25_000): Promise<FolderUsage> {
  const root = expandPath(path);
  const t0 = Date.now();
  let files = 0;
  let partial = false;
  const largest: Array<{ path: string; size: number }> = [];
  const pushLarge = (p: string, size: number) => {
    if (largest.length < 30 || size > largest[largest.length - 1].size) {
      largest.push({ path: p, size });
      largest.sort((a, b) => b.size - a.size);
      if (largest.length > 30) largest.pop();
    }
  };
  const sizeOf = async (dir: string, depth: number): Promise<number> => {
    let total = 0;
    let ents;
    try {
      ents = await readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const e of ents) {
      if (Date.now() - t0 > budgetMs) {
        partial = true;
        break;
      }
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (depth < 40) total += await sizeOf(p, depth + 1);
      } else {
        try {
          const st = await stat(p);
          total += st.size;
          files++;
          pushLarge(p, st.size);
        } catch {
          /* no access */
        }
      }
    }
    return total;
  };
  let ents;
  try {
    ents = await readdir(root, { withFileTypes: true });
  } catch (e) {
    throw new CoreError('NOT_FOUND', `Cannot open ${root}: ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
  }
  const children: FolderUsage['children'] = [];
  for (const e of ents) {
    if (e.isSymbolicLink()) continue;
    const p = join(root, e.name);
    if (e.isDirectory()) children.push({ name: e.name, path: p, dir: true, size: await sizeOf(p, 1) });
    else {
      try {
        const st = await stat(p);
        children.push({ name: e.name, path: p, dir: false, size: st.size });
        files++;
        pushLarge(p, st.size);
      } catch {
        /* no access */
      }
    }
    if (Date.now() - t0 > budgetMs) {
      partial = true;
      break;
    }
  }
  children.sort((a, b) => b.size - a.size);
  return { path: root, total: children.reduce((a, c) => a + c.size, 0), files, children: children.slice(0, 60), largest, partial };
}

export async function cleanupInfo(): Promise<CleanupInfo> {
  const temps = [tmpdir()];
  if (IS_WIN && process.env.SystemRoot) temps.push(join(process.env.SystemRoot, 'Temp'));
  const dl = join(homedir(), 'Downloads');
  const size = (p: string) => analyzeFolder(p, 8000).then((r) => r.total, () => 0);
  const [temp, downloads] = await Promise.all([Promise.all(temps.filter(existsSync).map(async (p) => ({ path: p, size: await size(p) }))), existsSync(dl) ? size(dl) : 0]);
  let recycleBin: number | null = null;
  if (IS_WIN) {
    const r = await ps('$s=(New-Object -ComObject Shell.Application).NameSpace(10); ($s.Items() | Measure-Object -Property Size -Sum).Sum', 20_000);
    recycleBin = Number(r.out.trim()) || 0;
  }
  return { temp, downloads: { path: dl, size: downloads }, recycleBin };
}

/** Deletes files older than a day from the user's temp folder (files in use are skipped). */
export async function cleanTemp(): Promise<{ freed: number; skipped: number }> {
  const cutoff = Date.now() - 24 * 3600_000;
  let freed = 0;
  let skipped = 0;
  const walk = async (dir: string): Promise<void> => {
    let ents;
    try {
      ents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.name === 'fbrx-elevated') continue;
      try {
        const st = await lstat(p);
        if (st.mtimeMs > cutoff) {
          skipped++;
          continue;
        }
        if (st.isDirectory()) {
          await walk(p);
          await rmdir(p).catch(() => undefined);
        } else {
          await unlink(p);
          freed += st.size;
        }
      } catch {
        skipped++;
      }
    }
  };
  await walk(tmpdir());
  return { freed, skipped };
}

export async function emptyRecycleBin(): Promise<void> {
  requireWindows('Emptying the Recycle Bin');
  await ps('Clear-RecycleBin -Force -ErrorAction SilentlyContinue', 120_000);
}

/** Drive maintenance (needs administrator rights). */
export function maintenance(p: { action: (typeof STORAGE_ACTIONS)[number]; letter?: string; value?: string; disk?: number; partition?: number }): Promise<ElevatedResult> {
  requireWindows('Drive maintenance');
  switch (p.action) {
    case 'analyze':
      return elevated(`Optimize-Volume -DriveLetter ${letterOf(p.letter)} -Analyze -Verbose`);
    case 'optimize':
      return elevated(`Optimize-Volume -DriveLetter ${letterOf(p.letter)} -Verbose`);
    case 'chkdsk':
      return elevated(`chkdsk ${letterOf(p.letter)}: /scan`);
    case 'label': {
      const l = letterOf(p.letter);
      const label = String(p.value ?? '').slice(0, 32);
      return elevated(`Set-Volume -DriveLetter ${l} -NewFileSystemLabel ${psq(label)}; Get-Volume -DriveLetter ${l} | Format-List DriveLetter,FileSystemLabel`);
    }
    case 'letter': {
      const disk = Number(p.disk);
      const part = Number(p.partition);
      if (!Number.isInteger(disk) || !Number.isInteger(part)) throw new CoreError('INVALID_ARGUMENT', 'Choose a partition');
      return elevated(`Set-Partition -DiskNumber ${disk} -PartitionNumber ${part} -NewDriveLetter ${letterOf(p.value)}; 'Drive letter changed.'`);
    }
    case 'extend': {
      const l = letterOf(p.letter);
      return elevated(`$s = Get-PartitionSupportedSize -DriveLetter ${l}; Resize-Partition -DriveLetter ${l} -Size $s.SizeMax; "Extended to $([math]::Round($s.SizeMax/1GB,1)) GB"`);
    }
  }
  throw new CoreError('INVALID_ARGUMENT', 'Unknown action');
}
