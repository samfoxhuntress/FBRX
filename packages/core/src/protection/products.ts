import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { AvProduct } from '@fbrx/shared';
import { exec, IS_WIN, psJson } from '../windows/ps';

/**
 * Antivirus products FBRX recognizes. On Windows they register with Windows Security Center, which says whether each
 * one is on and up to date; on macOS and Linux FBRX recognizes them by where they are installed. A product gets a
 * Scan button only where FBRX knows its command-line scanner for sure; otherwise FBRX shows its status and its own
 * app does the scanning.
 */

interface ScanCommand {
  /** Candidate executables (environment variables like %ProgramFiles% are expanded). */
  exe: string[];
  args: (target: string) => string[];
  /** Exit codes that mean "threats found". */
  foundCodes: number[];
  /** Exit codes that mean "finished, nothing found". */
  cleanCodes: number[];
}

interface CatalogEntry {
  id: string;
  name: string;
  /** Matches the name Windows Security Center reports. */
  match: RegExp;
  /** Files or folders that show it is installed (macOS, Linux). */
  installed?: { darwin?: string[]; linux?: string[] };
  scan?: { win32?: ScanCommand; darwin?: ScanCommand; linux?: ScanCommand };
}

const MDATP: ScanCommand = { exe: ['/usr/local/bin/mdatp', '/usr/bin/mdatp'], args: (t) => ['scan', 'custom', '--path', t], foundCodes: [], cleanCodes: [0] };
const CLAMSCAN: ScanCommand = {
  exe: ['clamscan', '%ProgramFiles%\\ClamAV\\clamscan.exe', '/opt/homebrew/bin/clamscan', '/usr/local/bin/clamscan', '/usr/bin/clamscan'],
  args: (t) => ['--no-summary', '--infected', '--recursive', t],
  foundCodes: [1],
  cleanCodes: [0],
};

export const AV_CATALOG: CatalogEntry[] = [
  { id: 'defender', name: 'Microsoft Defender', match: /windows defender|microsoft defender/i, installed: { darwin: ['/Applications/Microsoft Defender.app'], linux: ['/opt/microsoft/mdatp'] }, scan: { darwin: MDATP, linux: MDATP } },
  {
    id: 'sophos',
    name: 'Sophos',
    match: /sophos/i,
    installed: { darwin: ['/Applications/Sophos/Sophos Endpoint.app', '/Library/Sophos Anti-Virus'], linux: ['/opt/sophos-spl'] },
    scan: {
      win32: { exe: ['%ProgramFiles%\\Sophos\\Endpoint Defense\\SophosInterceptXCLI.exe'], args: (t) => ['scan', '--noui', t], foundCodes: [], cleanCodes: [0] },
      linux: { exe: ['/opt/sophos-spl/plugins/av/bin/avscanner'], args: (t) => [t], foundCodes: [], cleanCodes: [0] },
    },
  },
  { id: 'crowdstrike', name: 'CrowdStrike Falcon', match: /crowdstrike|falcon/i, installed: { darwin: ['/Applications/Falcon.app'], linux: ['/opt/CrowdStrike'] } },
  { id: 'sentinelone', name: 'SentinelOne', match: /sentinel\s*one|sentinel agent/i, installed: { darwin: ['/Applications/SentinelOne', '/Library/Sentinel'], linux: ['/opt/sentinelone'] } },
  { id: 'eset', name: 'ESET', match: /\beset\b/i, installed: { darwin: ['/Applications/ESET Endpoint Security.app', '/Applications/ESET Endpoint Antivirus.app', '/Applications/ESET Cyber Security.app'], linux: ['/opt/eset'] } },
  { id: 'bitdefender', name: 'Bitdefender', match: /bitdefender/i, installed: { darwin: ['/Applications/Bitdefender', '/Applications/Endpoint Security for Mac.app'], linux: ['/opt/bitdefender-security-tools'] } },
  { id: 'malwarebytes', name: 'Malwarebytes', match: /malwarebytes/i, installed: { darwin: ['/Applications/Malwarebytes.app'] } },
  { id: 'kaspersky', name: 'Kaspersky', match: /kaspersky/i, installed: { darwin: ['/Applications/Kaspersky Security.app', '/Applications/Kaspersky Internet Security.app'], linux: ['/opt/kaspersky'] } },
  { id: 'norton', name: 'Norton', match: /norton|symantec/i, installed: { darwin: ['/Applications/Norton 360.app', '/Applications/Norton Security.app'] } },
  { id: 'mcafee', name: 'McAfee', match: /mcafee|trellix/i, installed: { darwin: ['/Applications/McAfee LiveSafe.app', '/usr/local/McAfee'], linux: ['/opt/McAfee', '/opt/isec'] } },
  { id: 'trendmicro', name: 'Trend Micro', match: /trend\s*micro/i, installed: { darwin: ['/Applications/Trend Micro Antivirus.app'], linux: ['/opt/ds_agent'] } },
  { id: 'webroot', name: 'Webroot', match: /webroot/i, installed: { darwin: ['/Applications/Webroot SecureAnywhere.app'] } },
  { id: 'avast', name: 'Avast', match: /avast/i, installed: { darwin: ['/Applications/Avast.app'] } },
  { id: 'avg', name: 'AVG', match: /\bavg\b/i, installed: { darwin: ['/Applications/AVG AntiVirus.app'] } },
  { id: 'avira', name: 'Avira', match: /avira/i, installed: { darwin: ['/Applications/Avira Security.app'] } },
  { id: 'withsecure', name: 'WithSecure', match: /withsecure|f-secure/i, installed: { darwin: ['/Applications/WithSecure Elements Agent.app', '/Applications/F-Secure'], linux: ['/opt/f-secure'] } },
  { id: 'intego', name: 'Intego', match: /intego|virusbarrier/i, installed: { darwin: ['/Applications/VirusBarrier.app'] } },
  { id: 'cylance', name: 'Cylance', match: /cylance/i, installed: { darwin: ['/Applications/Cylance'], linux: ['/opt/cylance'] } },
  { id: 'clamav', name: 'ClamAV', match: /clam/i, scan: { win32: CLAMSCAN, darwin: CLAMSCAN, linux: CLAMSCAN } },
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'antivirus';
const expand = (p: string) => p.replace(/%([A-Za-z0-9_()]+)%/g, (_, v: string) => process.env[v] ?? process.env[v.toUpperCase()] ?? `%${v}%`);

/** The first candidate that exists (a bare name is looked up on PATH). */
export function findExecutable(candidates: string[]): string | null {
  for (const c of candidates) {
    const p = expand(c);
    if (/[\\/]/.test(p)) {
      if (existsSync(p)) return p;
      continue;
    }
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      for (const ext of IS_WIN ? ['.exe', '.cmd', ''] : ['']) {
        const full = join(dir, p + ext);
        if (dir && existsSync(full)) return full;
      }
    }
  }
  return null;
}

export function catalogEntry(id: string): CatalogEntry | undefined {
  return AV_CATALOG.find((c) => c.id === id);
}

/** The command-line scanner for a product on this computer, if FBRX knows one and it is installed. */
export function scanCommand(id: string): { exe: string; cmd: ScanCommand } | null {
  const cmd = catalogEntry(id)?.scan?.[process.platform as 'win32' | 'darwin' | 'linux'];
  if (!cmd) return null;
  const exe = findExecutable(cmd.exe);
  return exe ? { exe, cmd } : null;
}

/**
 * Windows Security Center's productState: the second byte says whether the scanner is on (0x10 or 0x11), the low
 * byte whether its definitions are up to date (0x00) or out of date (0x10).
 */
export function decodeProductState(state: number): { realtime: boolean; upToDate: boolean } {
  const scanner = (state >> 8) & 0xff;
  const defs = state & 0xff;
  return { realtime: scanner === 0x10 || scanner === 0x11, upToDate: defs === 0x00 };
}

/** Antivirus products found on this computer (Microsoft Defender included when Windows reports it). */
export async function detectProducts(): Promise<AvProduct[]> {
  const found = new Map<string, AvProduct>();
  if (IS_WIN) {
    const rows = await psJson('Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction SilentlyContinue | Select-Object displayName,productState', 30_000).catch(() => [] as any[]);
    for (const r of rows) {
      const name = String(r.displayName ?? '').trim();
      if (!name) continue;
      const entry = AV_CATALOG.find((c) => c.match.test(name));
      const id = entry?.id ?? slug(name);
      const st = decodeProductState(Number(r.productState) || 0);
      const prev = found.get(id);
      // Some products register twice (an old and a new name): keep the one that is on.
      if (prev && prev.realtime && !st.realtime) continue;
      found.set(id, { id, name: entry?.id === 'defender' ? 'Microsoft Defender' : name, realtime: st.realtime, upToDate: st.upToDate, canScan: id === 'defender' || !!scanCommand(id), source: 'security-center' });
    }
  } else {
    const platform = process.platform as 'darwin' | 'linux';
    for (const c of AV_CATALOG) {
      const paths = c.installed?.[platform] ?? [];
      const hit = paths.some((p) => existsSync(p)) || (c.id === 'clamav' && !!scanCommand('clamav'));
      if (!hit) continue;
      let realtime: boolean | null = null;
      let upToDate: boolean | null = null;
      if (c.id === 'defender') {
        const exe = findExecutable(MDATP.exe);
        if (exe) {
          const rt = await exec(exe, ['health', '--field', 'real_time_protection_enabled'], { timeoutMs: 15_000 });
          const defs = await exec(exe, ['health', '--field', 'definitions_status'], { timeoutMs: 15_000 });
          if (rt.code === 0) realtime = /true/i.test(rt.out);
          if (defs.code === 0) upToDate = /up_to_date/i.test(defs.out);
        }
      }
      // ClamAV only scans when asked: it is a scanner, not real-time protection.
      if (c.id === 'clamav') realtime = false;
      found.set(c.id, { id: c.id, name: c.name, realtime, upToDate, canScan: !!scanCommand(c.id), source: 'installed' });
    }
  }
  // ClamAV is often installed on Windows without registering with Security Center.
  if (IS_WIN && !found.has('clamav') && scanCommand('clamav')) found.set('clamav', { id: 'clamav', name: 'ClamAV', realtime: false, upToDate: null, canScan: true, source: 'installed' });
  return [...found.values()];
}
