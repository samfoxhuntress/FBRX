import { spawn } from 'node:child_process';
import type { DriverInfo, HotfixInfo, WindowsUpdateItem, WingetUpgrade } from '@fbrx/shared';
import { CoreError } from '../errors';
import { exec, psJson, requireWindows } from './ps';

/** Parses the fixed-width table printed by `winget upgrade`. */
export function parseWingetTable(out: string): WingetUpgrade[] {
  const lines = out
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/^[\s\-\\|/]*(?=Name)/, ''));
  const hi = lines.findIndex((l) => /^Name\s+Id\s+Version/.test(l));
  if (hi < 0) return [];
  const head = lines[hi];
  const cols = ['Name', 'Id', 'Version', 'Available', 'Source'].map((c) => head.indexOf(c));
  const rows: WingetUpgrade[] = [];
  for (const l of lines.slice(hi + 2)) {
    if (!l.trim() || /upgrades? available|^\d+ package/i.test(l) || /^-+$/.test(l.trim())) continue;
    const get = (i: number) => l.slice(cols[i], cols[i + 1] > 0 ? cols[i + 1] : undefined).trim();
    const r = { name: get(0), id: get(1), current: get(2), available: get(3), source: cols[4] > 0 ? l.slice(cols[4]).trim() : '' };
    if (r.id && r.available) rows.push(r);
  }
  return rows;
}

const WINGET_ID = /^[\w.+-]{2,128}$/;

export async function appUpgrades(): Promise<WingetUpgrade[]> {
  requireWindows('App updates');
  const r = await exec('winget', ['upgrade', '--include-unknown', '--accept-source-agreements', '--disable-interactivity'], { timeoutMs: 120_000 });
  if (r.code === -1 || /not recognized|ENOENT/i.test(r.err)) {
    throw new CoreError('UNAVAILABLE', 'winget (App Installer) is not available on this PC. Install "App Installer" from the Microsoft Store.');
  }
  return parseWingetTable(r.out);
}

/** Upgrades one app (or `--all`), streaming winget's output lines. */
export async function upgradeApp(id: string, onLine: (line: string) => void): Promise<{ ok: boolean; output: string }> {
  requireWindows('App updates');
  if (id !== '--all' && !WINGET_ID.test(id)) throw new CoreError('INVALID_ARGUMENT', 'Invalid package id');
  const args =
    id === '--all'
      ? ['upgrade', '--all', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity']
      : ['upgrade', '--id', id, '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'];
  const r = await exec('winget', args, {
    timeoutMs: 3600_000,
    onLine: (l) => {
      const t = l.trim();
      if (t && !/^[\s\-\\|/█▒]+$/.test(t)) onLine(t);
    },
  });
  const output = (r.out + r.err)
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => l.trim() && !/^[\s\-\\|/█▒]+$/.test(l))
    .slice(-40)
    .join('\n');
  return { ok: r.code === 0, output };
}

export async function windowsUpdates(): Promise<WindowsUpdateItem[]> {
  requireWindows('Windows Update');
  const list = await psJson(
    "$s=New-Object -ComObject Microsoft.Update.Session; $r=$s.CreateUpdateSearcher().Search(\"IsInstalled=0 and IsHidden=0 and Type='Software'\"); $r.Updates | ForEach-Object { [pscustomobject]@{ Title=$_.Title; KB=($_.KBArticleIDs -join ','); Severity=[string]$_.MsrcSeverity; Downloaded=$_.IsDownloaded; SizeMB=[math]::Round($_.MaxDownloadSize/1MB,1) } }",
    180_000,
  );
  return list.map((u) => ({ title: u.Title, kb: u.KB ? `KB${u.KB}` : '', severity: u.Severity || 'Unrated', sizeMB: typeof u.SizeMB === 'number' ? u.SizeMB : null, downloaded: !!u.Downloaded }));
}

export async function drivers(): Promise<DriverInfo[]> {
  requireWindows('Drivers');
  const d = await psJson(
    "Get-CimInstance Win32_PnPSignedDriver | Where-Object { $_.DeviceName -and $_.DriverProviderName -ne 'Microsoft' } | Select-Object DeviceName,DriverVersion,DriverProviderName,DeviceClass,@{n='Date';e={ if ($_.DriverDate) { $_.DriverDate.ToString('yyyy-MM-dd') } }}",
    90_000,
  );
  return d
    .map((x) => ({ device: x.DeviceName, provider: x.DriverProviderName ?? '', version: x.DriverVersion ?? '', date: x.Date ?? '', className: x.DeviceClass ?? '' }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function hotfixes(): Promise<HotfixInfo[]> {
  requireWindows('Installed updates');
  const h = await psJson("Get-HotFix | Select-Object HotFixID,Description,@{n='InstalledOn';e={ if ($_.InstalledOn) { $_.InstalledOn.ToString('yyyy-MM-dd') } }}", 60_000);
  return h.map((x) => ({ id: x.HotFixID, description: x.Description ?? '', installedOn: x.InstalledOn ?? null })).sort((a, b) => String(b.installedOn).localeCompare(String(a.installedOn)));
}

const UPDATE_PAGES = {
  check: 'ms-settings:windowsupdate-action',
  history: 'ms-settings:windowsupdate-history',
  advanced: 'ms-settings:windowsupdate-options',
  optional: 'ms-settings:windowsupdate-optionalupdates',
  store: 'ms-windows-store://downloadsandupdates',
} as const;

export function openUpdatePage(page: keyof typeof UPDATE_PAGES): void {
  requireWindows('Windows Update');
  const uri = UPDATE_PAGES[page];
  if (!uri) throw new CoreError('INVALID_ARGUMENT', 'Unknown page');
  spawn('explorer.exe', [uri], { detached: true, stdio: 'ignore' }).unref();
}
