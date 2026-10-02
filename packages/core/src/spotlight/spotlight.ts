import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { SYSTEM_COMMANDS, type SpotlightAction, type SpotlightItem, type SystemCommand } from '@fbrx/shared';
import { CoreError } from '../errors';
import type { MetaStore } from '../storage/meta';
import type { WorkspaceStore } from '../workspace/workspace-store';
import { encodeCommand, exec, IS_WIN, ps } from '../windows/ps';

// ------------------------------------------------------------------------------ calculator (no eval)

const FUNCS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  log: Math.log10,
  ln: Math.log,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  exp: Math.exp,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

/** Evaluates an arithmetic expression with a small recursive-descent parser. Returns null when it is not one. */
export function calc(expr: string): number | null {
  const src = expr.replace(/×/g, '*').replace(/÷/g, '/').replace(/,/g, '').replace(/\s+/g, '').toLowerCase();
  if (!/^[\d.+\-*/^%()a-z]+$/.test(src) || !/\d|pi|tau/.test(src) || !/[+\-*/^%(]|sqrt|sin|cos|tan|log|ln|abs/.test(src)) return null;
  let i = 0;
  const fail = (): never => {
    throw new Error('parse');
  };
  const num = () => {
    const m = src.slice(i).match(/^\d*\.?\d+(e[+-]?\d+)?/);
    if (!m) fail();
    i += m![0].length;
    return parseFloat(m![0]);
  };
  const primary = (): number => {
    if (src[i] === '(') {
      i++;
      const v = add();
      if (src[i++] !== ')') fail();
      return v;
    }
    if (src[i] === '-') {
      i++;
      return -power();
    }
    if (src[i] === '+') {
      i++;
      return power();
    }
    const id = src.slice(i).match(/^[a-z]+/);
    if (id) {
      i += id[0].length;
      if (id[0] in CONSTS) return CONSTS[id[0]];
      if (id[0] in FUNCS) {
        if (src[i] !== '(') fail();
        i++;
        const v = add();
        if (src[i++] !== ')') fail();
        return FUNCS[id[0]](v);
      }
      fail();
    }
    let v = num();
    if (src[i] === '%') {
      i++;
      v /= 100;
    }
    return v;
  };
  const power = (): number => {
    const b = primary();
    if (src[i] === '^') {
      i++;
      return Math.pow(b, power());
    }
    return b;
  };
  const mul = (): number => {
    let v = power();
    while (src[i] === '*' || src[i] === '/' || src[i] === '(') {
      const op = src[i] === '(' ? '*' : src[i++];
      const r = power();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const add = (): number => {
    let v = mul();
    while (src[i] === '+' || src[i] === '-') {
      const op = src[i++];
      const r = mul();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  try {
    const v = add();
    return i === src.length && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

export const fmtNum = (v: number): string =>
  Math.abs(v) >= 1e15 || (Math.abs(v) < 1e-6 && v !== 0) ? v.toExponential(6) : (+v.toPrecision(12)).toLocaleString('en-US', { maximumFractionDigits: 10 });

// ---------------------------------------------------------------------------------- unit conversion

const UNITS: Record<string, Record<string, number>> = {
  length: { m: 1, meter: 1, meters: 1, km: 1000, cm: 0.01, mm: 0.001, mi: 1609.344, mile: 1609.344, miles: 1609.344, yd: 0.9144, ft: 0.3048, feet: 0.3048, foot: 0.3048, in: 0.0254, inch: 0.0254, inches: 0.0254, nmi: 1852 },
  mass: { kg: 1, g: 0.001, mg: 1e-6, lb: 0.45359237, lbs: 0.45359237, oz: 0.028349523125, t: 1000, ton: 907.18474, st: 6.35029318 },
  volume: { l: 1, liter: 1, liters: 1, ml: 0.001, gal: 3.785411784, gallon: 3.785411784, qt: 0.946352946, pt: 0.473176473, cup: 0.2365882365, cups: 0.2365882365, floz: 0.0295735295625, tbsp: 0.01478676478125, tsp: 0.00492892159375 },
  data: { b: 1, byte: 1, bytes: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, bit: 0.125, bits: 0.125, kbit: 125, mbit: 125000, gbit: 1.25e8 },
  speed: { mps: 1, 'm/s': 1, kph: 1 / 3.6, 'km/h': 1 / 3.6, kmh: 1 / 3.6, mph: 0.44704, knot: 0.514444, knots: 0.514444 },
  time: { s: 1, sec: 1, second: 1, seconds: 1, min: 60, minute: 60, minutes: 60, h: 3600, hr: 3600, hour: 3600, hours: 3600, day: 86400, days: 86400, week: 604800, weeks: 604800, year: 31557600, years: 31557600 },
  area: { m2: 1, sqm: 1, km2: 1e6, ft2: 0.09290304, sqft: 0.09290304, acre: 4046.8564224, acres: 4046.8564224, ha: 10000, hectare: 10000 },
};

export function convert(q: string): { value: number; text: string } | null {
  const m = q.trim().toLowerCase().match(/^(-?[\d.,]+)\s*([a-z°/0-9]+)\s+(?:to|in|as|=)\s+([a-z°/0-9]+)$/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(v)) return null;
  const a = m[2].replace('°', '');
  const b = m[3].replace('°', '');
  const T: Record<string, 'c' | 'f' | 'k'> = { c: 'c', celsius: 'c', f: 'f', fahrenheit: 'f', k: 'k', kelvin: 'k' };
  if (T[a] && T[b]) {
    const c = T[a] === 'c' ? v : T[a] === 'f' ? ((v - 32) * 5) / 9 : v - 273.15;
    const out = T[b] === 'c' ? c : T[b] === 'f' ? (c * 9) / 5 + 32 : c + 273.15;
    return { value: out, text: `${fmtNum(v)} °${T[a].toUpperCase()} = ${fmtNum(out)} °${T[b].toUpperCase()}` };
  }
  for (const table of Object.values(UNITS)) {
    if (a in table && b in table) {
      const out = (v * table[a]) / table[b];
      return { value: out, text: `${fmtNum(v)} ${m[2]} = ${fmtNum(out)} ${m[3]}` };
    }
  }
  return null;
}

// --------------------------------------------------------------------------------------- catalogs

const WIN_SETTINGS: Array<[string, string, string]> = [
  ['Wi-Fi', 'ms-settings:network-wifi', 'wifi wireless internet'],
  ['Bluetooth & devices', 'ms-settings:bluetooth', 'bluetooth pair headphones mouse'],
  ['Printers & scanners', 'ms-settings:printers', 'printer scanner print'],
  ['Display', 'ms-settings:display', 'screen resolution monitor brightness scale'],
  ['Sound', 'ms-settings:sound', 'audio volume speaker microphone'],
  ['Notifications', 'ms-settings:notifications', 'alerts focus'],
  ['Power & battery', 'ms-settings:powersleep', 'sleep battery power energy'],
  ['Storage settings', 'ms-settings:storagesense', 'disk space cleanup'],
  ['Windows Update', 'ms-settings:windowsupdate', 'update patch'],
  ['Installed apps', 'ms-settings:appsfeatures', 'apps uninstall programs'],
  ['Default apps', 'ms-settings:defaultapps', 'default browser'],
  ['Startup apps', 'ms-settings:startupapps', 'startup boot'],
  ['Network & internet', 'ms-settings:network', 'network ethernet status'],
  ['VPN', 'ms-settings:network-vpn', 'vpn'],
  ['Proxy', 'ms-settings:network-proxy', 'proxy'],
  ['Mobile hotspot', 'ms-settings:network-mobilehotspot', 'hotspot tether'],
  ['Mouse', 'ms-settings:mousetouchpad', 'mouse cursor'],
  ['Keyboard', 'ms-settings:keyboard', 'keyboard typing'],
  ['Date & time', 'ms-settings:dateandtime', 'clock time zone'],
  ['Language & region', 'ms-settings:regionlanguage', 'language region'],
  ['Personalization', 'ms-settings:personalization', 'wallpaper theme colors background'],
  ['Accounts', 'ms-settings:yourinfo', 'account user profile'],
  ['Sign-in options', 'ms-settings:signinoptions', 'password pin windows hello'],
  ['Privacy & security', 'ms-settings:privacy', 'privacy permissions camera microphone location'],
  ['Windows Security', 'windowsdefender:', 'antivirus defender firewall'],
  ['About this PC', 'ms-settings:about', 'about specs pc name system info'],
  ['Recovery', 'ms-settings:recovery', 'reset recovery restore'],
  ['Troubleshoot', 'ms-settings:troubleshoot', 'troubleshoot fix'],
  ['Night light', 'ms-settings:nightlight', 'night light blue'],
  ['Clipboard', 'ms-settings:clipboard', 'clipboard history'],
];

/** Built-in Windows tools; only these names can be launched as `tool:` apps. */
export const WIN_TOOLS: Record<string, { title: string; cmd: string; args: string[]; keywords: string }> = {
  taskmgr: { title: 'Task Manager', cmd: 'taskmgr.exe', args: [], keywords: 'processes performance' },
  control: { title: 'Control Panel', cmd: 'control.exe', args: [], keywords: 'control panel' },
  devmgmt: { title: 'Device Manager', cmd: 'mmc.exe', args: ['devmgmt.msc'], keywords: 'drivers devices hardware' },
  services: { title: 'Services', cmd: 'mmc.exe', args: ['services.msc'], keywords: 'services' },
  eventvwr: { title: 'Event Viewer', cmd: 'mmc.exe', args: ['eventvwr.msc'], keywords: 'logs events' },
  diskmgmt: { title: 'Disk Management', cmd: 'mmc.exe', args: ['diskmgmt.msc'], keywords: 'partition disk drive' },
  cmd: { title: 'Command Prompt', cmd: 'cmd.exe', args: [], keywords: 'cmd terminal shell' },
  powershell: { title: 'PowerShell', cmd: 'powershell.exe', args: [], keywords: 'terminal shell' },
  regedit: { title: 'Registry Editor', cmd: 'regedit.exe', args: [], keywords: 'registry' },
  msinfo32: { title: 'System Information', cmd: 'msinfo32.exe', args: [], keywords: 'msinfo specs' },
  resmon: { title: 'Resource Monitor', cmd: 'resmon.exe', args: [], keywords: 'resource monitor' },
  explorer: { title: 'File Explorer', cmd: 'explorer.exe', args: [], keywords: 'explorer files folders' },
  ncpa: { title: 'Network Connections', cmd: 'control.exe', args: ['ncpa.cpl'], keywords: 'adapters ncpa' },
  calc: { title: 'Calculator', cmd: 'calc.exe', args: [], keywords: 'calculator' },
  notepad: { title: 'Notepad', cmd: 'notepad.exe', args: [], keywords: 'text editor' },
  mstsc: { title: 'Remote Desktop', cmd: 'mstsc.exe', args: [], keywords: 'rdp remote' },
};

const SYSTEM: Array<[string, SystemCommand, string, boolean]> = [
  ['Lock screen', 'lock', 'lock computer', false],
  ['Sleep', 'sleep', 'suspend', false],
  ['Restart', 'restart', 'reboot', true],
  ['Shut down', 'shutdown', 'power off turn off', true],
  ['Sign out', 'signout', 'log off logout', true],
  ['Empty Recycle Bin', 'emptybin', 'trash recycle', true],
  ['Flush DNS cache', 'flushdns', 'dns network fix', false],
];

/** FBRX pages (route, title, keywords). */
export const PAGES: Array<[string, string, string]> = [
  ['dashboard', 'Dashboard', 'home overview system health'],
  ['agent', 'Fabrix agent', 'ai chat assistant ask'],
  ['tasks', 'Tasks', 'todo board kanban'],
  ['notes', 'Notes', 'notes notebook'],
  ['projects', 'Projects', 'project milestones'],
  ['snippets', 'Snippets', 'code snippets clipboard'],
  ['files', 'Files', 'file browser explorer'],
  ['processes', 'Processes', 'task manager kill'],
  ['terminal', 'Terminal', 'powershell command shell'],
  ['terminal/fbrx1', 'FBRX/1 console', 'fbrx1 cli junos cisco show configure commit management console'],
  ['settings/trophies', 'Trophy case', 'trophies badges achievements easter eggs'],
  ['network/speed', 'Speed test', 'speedometer internet speed bandwidth mbps'],
  ['toolbox', 'Toolbox', 'json base64 hash uuid password regex'],
  ['library', 'Library', 'help guides articles'],
  ['alerts', 'Alerts', 'notifications inbox'],
  ['storage', 'Storage', 'disk space cleanup drives'],
  ['network', 'Network Center', 'traceroute speed test wifi bluetooth printers lan scan ping dns'],
  ['security', 'Security', 'defender antivirus firewall ports startup'],
  ['updates', 'Updates', 'winget windows update drivers'],
  ['bugs', 'Bug catcher', 'crashes errors event log fix troubleshoot'],
  ['lab', 'Virtual lab', 'hyper-v sandbox vm virtual machine'],
  ['mesh', 'Mesh & phone', 'devices pair phone mobile'],
  ['aicoord', 'AI coordination', 'claude cursor mcp ai apps'],
  ['governance', 'Governance', 'policy approvals rules'],
  ['vault', 'Credentials', 'vault secrets passwords keys'],
  ['audit', 'Audit log', 'security log history'],
  ['settings', 'Settings', 'preferences theme appearance'],
];

const WEB: Record<string, string> = {
  google: 'https://www.google.com/search?q=',
  bing: 'https://www.bing.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
};

export function score(text: string, q: string, extra = ''): number {
  const t = text.toLowerCase();
  if (!q) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 90 - Math.min(t.length - q.length, 20) * 0.3;
  if (t.split(/[\s\-_.()]+/).some((w) => w.startsWith(q))) return 75;
  if (t.includes(q)) return 60;
  if (extra && extra.toLowerCase().split(' ').some((w) => w.startsWith(q))) return 50;
  const acr = t
    .split(/[\s\-_.]+/)
    .map((w) => w[0])
    .join('');
  if (q.length >= 2 && acr.startsWith(q)) return 55;
  let j = 0;
  for (const ch of t) if (ch === q[j]) j++;
  return j === q.length && q.length >= 3 ? 30 : 0;
}

interface AppEntry {
  name: string;
  appId: string | null;
  lnk: string | null;
}

interface HistoryEntry {
  count: number;
  last: number;
  item: SpotlightItem;
}

const HISTORY_KEY = 'spotlight.history';

/**
 * Spotlight: one search box for apps, files, FBRX pages, workspace items, Windows settings, system commands,
 * calculator, unit conversion, the web and Fabrix.
 */
export class Spotlight {
  private apps: AppEntry[] = [];
  private appsAt = 0;
  private worker: ChildProcessWithoutNullStreams | null = null;
  private workerFailed = !IS_WIN;
  private pending = new Map<number, (r: { error?: string; results?: any[] }) => void>();
  private reqId = 0;
  private fileIndex: Array<{ name: string; path: string; dir: boolean }> | null = null;
  private indexing: Promise<Array<{ name: string; path: string; dir: boolean }>> | null = null;

  constructor(
    private readonly d: {
      meta: MetaStore;
      workspace: WorkspaceStore;
      webSearch: () => string;
      fileSearch: () => boolean;
      /** Fun extras on (Settings → Appearance): a few easter-egg answers. */
      easterEggs?: () => boolean;
    },
  ) {}

  dispose(): void {
    try {
      this.worker?.kill();
    } catch {
      /* ignore */
    }
    this.worker = null;
  }

  // ------------------------------------------------------------------------------------------- apps

  async loadApps(force = false): Promise<AppEntry[]> {
    if (!force && this.apps.length && Date.now() - this.appsAt < 10 * 60_000) return this.apps;
    const links = new Map<string, string>();
    const roots = IS_WIN
      ? [join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'), join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs')]
      : ['/usr/share/applications', join(homedir(), '.local/share/applications'), '/Applications'];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 4) return;
      let ents;
      try {
        ents = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        const f = join(dir, e.name);
        if (e.isDirectory() && !e.name.endsWith('.app')) await walk(f, depth + 1);
        else if (/\.(lnk|url|desktop|app)$/i.test(e.name)) links.set(e.name.replace(/\.(lnk|url|desktop|app)$/i, '').toLowerCase(), f);
      }
    };
    await Promise.all(roots.map((r) => walk(r, 0)));
    let list: AppEntry[] = [];
    if (IS_WIN) {
      const r = await ps('Get-StartApps | ConvertTo-Json -Compress', 20_000);
      try {
        const j = JSON.parse(r.out.trim() || '[]');
        list = (Array.isArray(j) ? j : [j])
          .filter((a: any) => a?.Name && !/^(uninstall|readme|help|website|documentation)/i.test(a.Name))
          .map((a: any) => ({ name: String(a.Name), appId: String(a.AppID), lnk: links.get(String(a.Name).toLowerCase()) ?? null }));
      } catch {
        /* fall back to shortcuts */
      }
    }
    if (!list.length) {
      for (const [k, f] of links) {
        let name = k;
        if (f.endsWith('.desktop')) {
          try {
            const t = readFileSync(f, 'utf8');
            if (/NoDisplay=true/.test(t)) continue;
            name = t.match(/^Name=(.*)$/m)?.[1] ?? k;
          } catch {
            /* ignore */
          }
        } else if (f.endsWith('.app')) name = f.split('/').pop()!.replace(/\.app$/, '');
        list.push({ name, appId: null, lnk: f });
      }
    }
    const seen = new Set<string>();
    this.apps = list.filter((a) => {
      const k = a.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    this.appsAt = Date.now();
    return this.apps;
  }

  // ------------------------------------------------------------------------------------------ files

  private ensureWorker(): void {
    if (this.worker || this.workerFailed) return;
    // Windows Search index over ADODB; queries arrive as JSON lines on stdin.
    const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8
$ErrorActionPreference='Stop'
$conn = New-Object -ComObject ADODB.Connection
$conn.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  try {
    $req = $line | ConvertFrom-Json
    $rows = New-Object System.Collections.ArrayList
    $rs = $conn.Execute("SELECT TOP 12 System.ItemPathDisplay, System.ItemNameDisplay, System.ItemTypeText, System.DateModified FROM SystemIndex WHERE SCOPE='file:$($req.scope)' AND CONTAINS(System.FileName, '$($req.cond)') ORDER BY System.DateModified DESC")
    while (-not $rs.EOF) {
      $m = $rs.Fields.Item('System.DateModified').Value
      [void]$rows.Add(@{ path=[string]$rs.Fields.Item('System.ItemPathDisplay').Value; name=[string]$rs.Fields.Item('System.ItemNameDisplay').Value; type=[string]$rs.Fields.Item('System.ItemTypeText').Value; modified=$(if ($m -is [datetime]) { $m.ToString('o') } else { $null }) })
      $rs.MoveNext()
    }
    $rs.Close()
    $out = @{ id=$req.id; results=@($rows) }
  } catch { $out = @{ id=$req.id; error=$_.Exception.Message; results=@() } }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $out -Compress -Depth 4))
  [Console]::Out.Flush()
}`;
    try {
      this.worker = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(script)], { windowsHide: true });
    } catch {
      this.workerFailed = true;
      return;
    }
    let buf = '';
    this.worker.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        try {
          const j = JSON.parse(line);
          const cb = this.pending.get(j.id);
          if (cb) {
            this.pending.delete(j.id);
            cb(j);
          }
        } catch {
          /* not a response */
        }
      }
    });
    this.worker.on('close', () => {
      this.worker = null;
      for (const cb of this.pending.values()) cb({ error: 'worker exited', results: [] });
      this.pending.clear();
    });
    this.worker.on('error', () => {
      this.workerFailed = true;
      this.worker = null;
    });
  }

  private async buildIndex() {
    if (this.fileIndex) return this.fileIndex;
    if (this.indexing) return this.indexing;
    this.indexing = (async () => {
      const out: Array<{ name: string; path: string; dir: boolean }> = [];
      const skip = new Set(['node_modules', '.git', 'AppData', '$Recycle.Bin', '.cache', '.npm', 'Library']);
      const rec = async (dir: string, depth: number): Promise<void> => {
        if (depth > 6 || out.length > 40_000) return;
        let ents;
        try {
          ents = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of ents) {
          if (e.name.startsWith('.') || skip.has(e.name)) continue;
          const f = join(dir, e.name);
          out.push({ name: e.name, path: f, dir: e.isDirectory() });
          if (e.isDirectory()) await rec(f, depth + 1);
        }
      };
      for (const sub of ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos', 'OneDrive', 'source', 'repos', 'Projects']) {
        await rec(join(homedir(), sub), 0);
      }
      this.fileIndex = out;
      this.indexing = null;
      setTimeout(() => (this.fileIndex = null), 10 * 60_000).unref?.();
      return out;
    })();
    return this.indexing;
  }

  async files(qRaw: string): Promise<SpotlightItem[]> {
    const q = qRaw.trim();
    if (q.length < 2 || !this.d.fileSearch()) return [];
    const item = (path: string, name: string, type: string, s: number): SpotlightItem => ({
      id: `file:${path}`,
      kind: 'file',
      title: name,
      subtitle: `${type} · ${path}`,
      action: { type: 'open', path },
      score: s,
    });
    if (!this.workerFailed) {
      this.ensureWorker();
      if (this.worker) {
        const words = q
          .replace(/["'*%\\]/g, '')
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 5);
        if (words.length) {
          const cond = words.map((w) => `"${w}*"`).join(' AND ');
          const id = ++this.reqId;
          const r = await Promise.race([
            new Promise<{ error?: string; results?: any[] }>((resolve) => {
              this.pending.set(id, resolve);
              this.worker!.stdin.write(`${JSON.stringify({ id, cond, scope: homedir().replace(/\\/g, '/').replace(/'/g, "''") })}\n`);
            }),
            new Promise<{ error: string }>((resolve) => setTimeout(() => resolve({ error: 'timeout' }), 4000)),
          ]);
          this.pending.delete(id);
          if (!r.error) return (r as { results?: any[] }).results!.map((x, i) => item(x.path, x.name, x.type || 'File', 70 - i));
          if (/provider|class not registered|cannot find|ADODB|0x80/i.test(r.error)) this.workerFailed = true;
        }
      }
    }
    const idx = await this.buildIndex();
    const ql = q.toLowerCase();
    return idx
      .map((f) => ({ f, s: score(f.name, ql) }))
      .filter((x) => x.s >= 50)
      .sort((a, b) => b.s - a.s)
      .slice(0, 12)
      .map(({ f, s }) => item(f.path, f.name, f.dir ? 'Folder' : `${extname(f.name).slice(1).toUpperCase() || 'File'} file`, s));
  }

  // ------------------------------------------------------------------------------------------ query

  private history(): Record<string, HistoryEntry> {
    return this.d.meta.get<Record<string, HistoryEntry>>(HISTORY_KEY) ?? {};
  }

  async query(qRaw: string): Promise<SpotlightItem[]> {
    const q = qRaw.trim().slice(0, 300);
    const ql = q.toLowerCase();
    const hist = this.history();
    const boost = (id: string) => {
      const h = hist[id];
      return h ? Math.min(h.count * 4, 25) + (Date.now() - h.last < 86400_000 ? 8 : 0) : 0;
    };
    if (!q) {
      const recent = Object.values(hist)
        .sort((a, b) => b.last - a.last)
        .slice(0, 8)
        .map((h) => ({ ...h.item, kind: 'recent' as const }));
      return [
        ...recent,
        { id: 'page:agent', kind: 'page', title: 'Ask Fabrix anything', subtitle: 'Open the agent', action: { type: 'nav', route: 'agent' }, score: 0 },
        { id: 'page:network', kind: 'page', title: 'Network Center', subtitle: 'Trace route, speed test, devices, printers', action: { type: 'nav', route: 'network' }, score: 0 },
        { id: 'page:tasks', kind: 'page', title: 'Tasks', subtitle: 'What is on your plate', action: { type: 'nav', route: 'tasks' }, score: 0 },
      ];
    }
    const out: SpotlightItem[] = [];
    if (this.d.easterEggs?.() && /^(honk|goose|silly goose|release the goose|untitled goose)$/i.test(q)) {
      out.push({ id: 'egg:goose', kind: 'command', title: 'Release the goose', subtitle: 'You were warned. Honk.', action: { type: 'nav', route: 'goose' }, score: 500 });
    }
    const c = calc(q.replace(/^=/, ''));
    if (c != null) out.push({ id: 'calc', kind: 'calc', title: `= ${fmtNum(c)}`, subtitle: `${q} · Enter to copy`, action: { type: 'copy', text: String(+c.toPrecision(12)) }, score: 200 });
    const conv = convert(q);
    if (conv) out.push({ id: 'convert', kind: 'convert', title: conv.text, subtitle: 'Unit conversion · Enter to copy', action: { type: 'copy', text: String(+conv.value.toPrecision(10)) }, score: 200 });
    if (/^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(q) && !/^\d+(\.\d+)+$/.test(q)) {
      out.push({ id: `url:${q}`, kind: 'web', title: `Open ${q}`, subtitle: 'Website', action: { type: 'url', url: /^https?:/i.test(q) ? q : `https://${q}` }, score: 150 });
    }

    for (const a of await this.loadApps()) {
      const s = score(a.name, ql);
      if (s > 0) {
        const action: SpotlightAction = a.appId ? { type: 'app', appId: a.appId } : { type: 'open', path: a.lnk ?? '' };
        out.push({ id: `app:${a.name}`, kind: 'app', title: a.name, subtitle: 'Application', action, score: s + boost(`app:${a.name}`) });
      }
    }
    for (const [route, title, kw] of PAGES) {
      const s = score(title, ql, kw);
      if (s > 0) out.push({ id: `page:${route}`, kind: 'page', title, subtitle: 'FBRX OS', action: { type: 'nav', route }, score: s + boost(`page:${route}`) });
    }
    if (ql.length >= 2) {
      for (const n of this.d.workspace.listNotes({ query: q }).slice(0, 4)) {
        out.push({ id: `note:${n.id}`, kind: 'note', title: n.title, subtitle: `Note · ${n.content.replace(/\s+/g, ' ').slice(0, 70)}`, action: { type: 'nav', route: `notes/${n.id}` }, score: Math.max(score(n.title, ql), 45) });
      }
      for (const t of this.d.workspace.listTasks().filter((t) => t.status !== 'done' && t.title.toLowerCase().includes(ql)).slice(0, 4)) {
        out.push({ id: `task:${t.id}`, kind: 'task', title: t.title, subtitle: `Task · ${t.priority}${t.due ? ` · due ${t.due.slice(0, 10)}` : ''}`, action: { type: 'nav', route: 'tasks' }, score: Math.max(score(t.title, ql), 45) });
      }
      for (const s of this.d.workspace.listSnippets({ query: q }).slice(0, 4)) {
        out.push({ id: `snippet:${s.id}`, kind: 'snippet', title: s.title, subtitle: `Snippet${s.language ? ` · ${s.language}` : ''} · Enter to copy`, action: { type: 'copy', text: s.content }, score: Math.max(score(s.title, ql), 45) });
      }
    }
    if (IS_WIN) {
      for (const [title, uri, kw] of WIN_SETTINGS) {
        const s = score(title, ql, kw);
        if (s > 0) out.push({ id: `set:${uri}`, kind: 'command', title, subtitle: 'Windows Settings', action: { type: 'url', url: uri }, score: s + boost(`set:${uri}`) - 5 });
      }
      for (const [key, t] of Object.entries(WIN_TOOLS)) {
        const s = score(t.title, ql, t.keywords);
        if (s > 0) out.push({ id: `tool:${key}`, kind: 'app', title: t.title, subtitle: 'Windows tool', action: { type: 'app', appId: `tool:${key}` }, score: s + boost(`tool:${key}`) - 5 });
      }
    }
    for (const [title, name, kw, confirm] of SYSTEM) {
      const s = score(title, ql, kw);
      if (s >= 50) out.push({ id: `sys:${name}`, kind: 'command', title, subtitle: confirm ? 'System command · asks to confirm' : 'System command', action: { type: 'system', name, confirm }, score: s - 10 });
    }
    out.sort((a, b) => b.score - a.score);
    const engine = this.d.webSearch();
    out.push(
      { id: 'ask', kind: 'ask', title: `Ask Fabrix: “${q}”`, subtitle: 'Tab for a quick answer · Enter to open the agent', action: { type: 'ask', prompt: q }, score: 1 },
      { id: 'web', kind: 'web', title: `Search the web for “${q}”`, subtitle: engine[0].toUpperCase() + engine.slice(1), action: { type: 'url', url: (WEB[engine] ?? WEB.google) + encodeURIComponent(q) }, score: 0 },
    );
    return out.slice(0, 40);
  }

  remember(item: SpotlightItem): void {
    if (['calc', 'convert', 'ask', 'web'].includes(item.id)) return;
    const hist = this.history();
    const h = hist[item.id];
    hist[item.id] = { count: (h?.count ?? 0) + 1, last: Date.now(), item: { ...item, score: 0 } };
    const keys = Object.keys(hist);
    if (keys.length > 300) for (const k of keys.sort((a, b) => hist[a].last - hist[b].last).slice(0, keys.length - 300)) delete hist[k];
    this.d.meta.set(HISTORY_KEY, hist);
  }

  // ------------------------------------------------------------------------------------------- run

  /** Executes the side effect of an item (the renderer handles nav, copy and ask). Validates everything. */
  async launch(action: SpotlightAction): Promise<string | undefined> {
    switch (action.type) {
      case 'app': {
        if (action.appId.startsWith('tool:')) {
          const t = WIN_TOOLS[action.appId.slice(5)];
          if (!t || !IS_WIN) throw new CoreError('NOT_FOUND', 'Unknown tool');
          spawn(t.cmd, t.args, { detached: true, stdio: 'ignore' }).unref();
          return;
        }
        const apps = await this.loadApps();
        if (!apps.some((a) => a.appId === action.appId)) throw new CoreError('NOT_FOUND', 'Application not found');
        if (!IS_WIN) throw new CoreError('UNAVAILABLE', 'Launching Start menu apps is available on Windows');
        spawn('explorer.exe', [`shell:AppsFolder\\${action.appId}`], { detached: true, stdio: 'ignore' }).unref();
        return;
      }
      case 'url': {
        const u = action.url;
        if (!/^(https?:\/\/|ms-settings:|windowsdefender:)/i.test(u)) throw new CoreError('INVALID_ARGUMENT', 'Unsupported link');
        if (IS_WIN) spawn('explorer.exe', [u], { detached: true, stdio: 'ignore' }).unref();
        else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [u], { detached: true, stdio: 'ignore' }).unref();
        return;
      }
      case 'open': {
        if (!action.path || !existsSync(action.path)) throw new CoreError('NOT_FOUND', 'File not found');
        if (IS_WIN) spawn('explorer.exe', [action.path], { detached: true, stdio: 'ignore' }).unref();
        else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [action.path], { detached: true, stdio: 'ignore' }).unref();
        return;
      }
      case 'system':
        return this.system(action.name);
      default:
        return;
    }
  }

  async system(name: SystemCommand): Promise<string> {
    if (!SYSTEM_COMMANDS.includes(name)) throw new CoreError('INVALID_ARGUMENT', 'Unknown command');
    if (!IS_WIN) throw new CoreError('UNAVAILABLE', 'System commands are available on Windows');
    switch (name) {
      case 'lock':
        await exec('rundll32.exe', ['user32.dll,LockWorkStation']);
        return 'Locked';
      case 'sleep':
        await ps("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false) | Out-Null");
        return 'Sleeping';
      case 'restart':
        await exec('shutdown.exe', ['/r', '/t', '5']);
        return 'Restarting in 5 seconds';
      case 'shutdown':
        await exec('shutdown.exe', ['/s', '/t', '5']);
        return 'Shutting down in 5 seconds';
      case 'signout':
        await exec('shutdown.exe', ['/l']);
        return 'Signing out';
      case 'emptybin':
        await ps('Clear-RecycleBin -Force -ErrorAction SilentlyContinue', 120_000);
        return 'Recycle Bin emptied';
      case 'flushdns':
        await exec('ipconfig.exe', ['/flushdns']);
        return 'DNS cache flushed';
    }
  }
}
