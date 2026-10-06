import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, watch, type FSWatcher } from 'node:fs';
import { chmod, lstat, open, opendir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { newId, type Settings, type ShieldAction, type ShieldDetection, type ShieldEngine as EngineName, type ShieldStatus, type ShieldVerdict } from '@fbrx/shared';
import { CoreError, errorMessage } from '../errors';
import type { Logger } from '../logger';
import type { MetaStore } from '../storage/meta';
import type { Db } from '../storage/db';
import { unzip } from '../util/unzip';
import { exec, IS_WIN } from '../windows/ps';
import { scanCommand } from './products';

/**
 * FBRX Shield, FBRX's own antivirus. Layers, in order:
 *
 * 1. The EICAR test file (so anyone can check that it works).
 * 2. A threat database of known-malware fingerprints (SHA-256), kept up to date from a public feed.
 * 3. FBRX's own rules for suspicious files: programs disguised as documents, hidden right-to-left names, scripts
 *    that delete backups, turn off antivirus or download and run code, miners, risky file types and macro documents
 *    from the internet, archives that hide a script.
 * 4. Endpoint Ultra: ClamAV (when installed) as a second engine, and VirusTotal for suspicious files.
 *
 * Malware goes into quarantine (encrypted, so it cannot run and other antivirus products do not trip over it);
 * suspicious files are reported for the person to decide. New files in Downloads and on the desktop are checked as
 * soon as they arrive. It does not (yet) block programs as they start: on Windows, Microsoft Defender keeps doing that.
 */

export const SHIELD_ENGINE_VERSION = '1.0';

const MAX_HASH_BYTES = 100 * 1024 * 1024;
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_FEED_BYTES = 300 * 1024 * 1024;
const EXEC_EXT = ['exe', 'scr', 'com', 'pif', 'bat', 'cmd', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'ps1', 'lnk', 'jar', 'msi', 'cpl'];
const DOC_EXT = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'csv', 'jpg', 'jpeg', 'png', 'gif', 'mp3', 'mp4', 'zip'];
const DOUBLE_EXT = new RegExp(`\\.(?:${DOC_EXT.join('|')})[\\s_]*\\.(?:${EXEC_EXT.join('|')})$`, 'i');
const BIDI = /[\u202A-\u202E\u2066-\u2069]/;
const SCRIPTS = ['ps1', 'psm1', 'bat', 'cmd', 'vbs', 'vbe', 'jse', 'wsf', 'wsh', 'hta'];
const TEXT_CONFIGS = ['sh', 'command', 'json', 'conf', 'cfg', 'txt'];
const RISKY_FROM_INTERNET = ['hta', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'scr', 'lnk', 'iso', 'img', 'vhd', 'vhdx', 'one', 'pif', 'cpl'];
const RISKY_IN_ARCHIVE = ['hta', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'scr', 'lnk', 'iso', 'img', 'vhd', 'bat', 'cmd', 'ps1', 'pif', 'cpl'];
const MACRO_OOXML = ['docm', 'xlsm', 'pptm', 'dotm', 'xltm', 'docx', 'xlsx', 'pptx'];
/** Photos, music and video: not where malware lives, and hashing them would make scans crawl. */
const NO_HASH = ['mp4', 'mov', 'mkv', 'avi', 'wmv', 'm4v', 'mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'jpg', 'jpeg', 'png', 'gif', 'heic', 'webp', 'bmp', 'tif', 'tiff', 'psd', 'raw', 'cr2', 'nef', 'arw'];
const PARTIAL_DOWNLOAD = /\.(?:crdownload|part|partial|download|opdownload|tmp)$|^\.com\.google\.chrome/i;

/** The standard antivirus test string, assembled so this file is not itself a test file. */
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join('');

export function isEicar(buf: Buffer): boolean {
  if (buf.length < EICAR.length || buf.length > 128) return false;
  const s = buf.toString('latin1');
  return s.startsWith(EICAR) && /^[\s\x1a]*$/.test(s.slice(EICAR.length));
}

interface ContentRule {
  name: string;
  reason: string;
  test: RegExp;
  /** Also look in plain-text and configuration files (not only scripts). */
  anyText?: boolean;
}

/** FBRX's rules for scripts. Each names a behavior that ordinary scripts almost never need. */
export const SCRIPT_RULES: ContentRule[] = [
  {
    name: 'Ransomware behavior',
    reason: 'It deletes backups or Windows recovery points, which ransomware does before it encrypts files.',
    test: /\b(?:vssadmin(?:\.exe)?\s+delete\s+shadows|wbadmin(?:\.exe)?\s+delete\s+(?:catalog|systemstatebackup)|wmic(?:\.exe)?\s+shadowcopy\s+delete|bcdedit(?:\.exe)?[^\r\n]*recoveryenabled\s+no)/i,
  },
  {
    name: 'Antivirus tampering',
    reason: 'It turns off Microsoft Defender or adds exclusions so files are not scanned.',
    test: /\bSet-MpPreference[^\r\n]*-Disable\w+\s+\$?(?:true|1)\b|\bAdd-MpPreference[^\r\n]*-Exclusion(?:Path|Process|Extension)\b/i,
  },
  {
    name: 'Download and run',
    reason: 'It downloads code from the internet and runs it straight away.',
    test: /(?:\bIEX\b|Invoke-Expression)[\s(]*New-Object\s+(?:System\.)?Net\.WebClient\)?\s*\.\s*Download(?:String|Data)|\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\r\n|]*\|\s*(?:iex|Invoke-Expression)\b/i,
  },
  { name: 'Hidden PowerShell', reason: 'It runs a PowerShell command hidden in Base64 so it cannot be read.', test: /powershell(?:\.exe)?[^\r\n]*\s-(?:e|ec|en|enc|enco|encod|encodedcommand)\s+[A-Za-z0-9+/=]{80,}/i },
  { name: 'Decode and run', reason: 'It decodes hidden code and runs it.', test: /FromBase64String\s*\([\s\S]{0,400}?(?:Invoke-Expression|\bIEX\b|\[Reflection\.Assembly\]::Load)/i },
  {
    name: 'Built-in tool abuse',
    reason: 'It uses a built-in Windows tool (certutil, bitsadmin, mshta or regsvr32) to fetch and run code from the internet, a common malware trick.',
    test: /\bcertutil(?:\.exe)?\s[^\r\n]*-urlcache[^\r\n]*https?:|\bbitsadmin(?:\.exe)?\s[^\r\n]*\/transfer[^\r\n]*https?:|\bmshta(?:\.exe)?\s+["']?(?:https?|vbscript|javascript):|\bregsvr32(?:\.exe)?\s[^\r\n]*\/i:\s*https?:/i,
  },
  { name: 'Cryptocurrency miner', reason: 'It holds settings for a cryptocurrency miner, which uses this computer to make money for someone else.', test: /stratum\+(?:tcp|ssl|tls):\/\/|\bxmrig\b[^\r\n]*--(?:url|donate-level)/i, anyText: true },
];

/** Names in a ZIP file (or a Word/Excel/PowerPoint document), read from its central directory only. */
export async function zipEntryNames(file: string, max = 2000): Promise<string[] | null> {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (size < 22) return null;
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return null;
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOff = tail.readUInt32LE(eocd + 16);
    if (cdOff + cdSize > size || cdSize > 16 * 1024 * 1024) return null;
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOff);
    const names: string[] = [];
    for (let n = 0, p = 0; n < count && n < max && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const nameLen = cd.readUInt16LE(p + 28);
      names.push(cd.subarray(p + 46, p + 46 + nameLen).toString('utf8'));
      p += 46 + nameLen + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32);
    }
    return names;
  } finally {
    await fh.close();
  }
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolvePromise(h.digest('hex')))
      .on('error', reject);
  });
}

const extOf = (name: string) => extname(name).slice(1).toLowerCase();
const norm = (p: string) => (IS_WIN || process.platform === 'darwin' ? resolve(p).toLowerCase() : resolve(p));
const under = (p: string, dir: string) => {
  const a = norm(p);
  const b = norm(dir);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
};

/** Windows marks files from the internet (Mark of the Web): zone 3 is the internet, 4 a blocked site. */
async function fromInternet(file: string): Promise<boolean> {
  if (!IS_WIN) return false;
  try {
    const z = await readFile(`${file}:Zone.Identifier`, 'utf8');
    return Number(/ZoneId\s*=\s*(\d)/i.exec(z)?.[1] ?? 0) >= 3;
  } catch {
    return false;
  }
}

interface DetectionRow {
  id: string;
  path: string;
  sha256: string | null;
  size: number | null;
  kind: ShieldVerdict['kind'];
  name: string;
  engine: EngineName;
  reason: string;
  source: ShieldDetection['source'];
  at: string;
  action: ShieldAction;
  action_at: string | null;
  qfile: string | null;
  qkey: string | null;
  mode: number | null;
}

const toDetection = (r: DetectionRow): ShieldDetection => ({
  id: r.id,
  path: r.path,
  sha256: r.sha256,
  size: r.size,
  kind: r.kind,
  name: r.name,
  engine: r.engine,
  reason: r.reason,
  source: r.source,
  at: r.at,
  action: r.action,
  actionAt: r.action_at,
});

export interface ShieldDeps {
  db: Db;
  meta: MetaStore;
  /** Where quarantined files are kept. */
  dir: string;
  log: Logger;
  settings: () => Settings['protection']['shield'];
  ultra: () => boolean;
  internet: () => boolean;
  /** Vault secrets: VIRUSTOTAL_API_KEY, ABUSECH_AUTH_KEY. */
  secret: (name: string) => string | undefined;
  /** Never scanned (FBRX's own data folder). */
  skip: () => string[];
  /** Downloads, desktop and the temp folder: files there count as downloaded. */
  landing: () => string[];
  onDetection: (d: ShieldDetection) => void;
}

export interface FileVerdict {
  verdict: ShieldVerdict | null;
  sha256: string | null;
  size: number | null;
}

export interface ScanProgress {
  files: number;
  skipped: number;
  found: number;
  current: string | null;
}

export class Shield {
  private watchers: FSWatcher[] = [];
  private watching: string[] = [];
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly seen = new Map<string, string>();
  private signatureCount: number | null = null;

  constructor(private readonly d: ShieldDeps) {
    mkdirSync(d.dir, { recursive: true });
  }

  // ------------------------------------------------------------------------------------------- verdicts

  private excluded(file: string): boolean {
    return [...this.d.skip(), ...this.d.settings().exclusions].some((x) => x && under(file, x));
  }

  private allowed(sha256: string): boolean {
    return !!this.d.db.get('SELECT 1 FROM shield_allow WHERE sha256 = ?', sha256);
  }

  /** What FBRX Shield thinks of one file. */
  async verdictFor(file: string, o: { downloaded?: boolean; signal?: AbortSignal } = {}): Promise<FileVerdict> {
    const st = await lstat(file);
    if (!st.isFile()) return { verdict: null, sha256: null, size: null };
    const name = basename(file);
    const ext = extOf(name);
    const v = (kind: ShieldVerdict['kind'], engine: EngineName, vName: string, reason: string): ShieldVerdict => ({ kind, engine, name: vName, reason });
    let sha256: string | null = null;
    const done = (verdict: ShieldVerdict | null): FileVerdict => ({ verdict, sha256, size: st.size });

    if (st.size <= 128) {
      const buf = await readFile(file);
      if (isEicar(buf)) return done(v('test', 'eicar', 'EICAR test file', 'This is the standard antivirus test file. It is harmless; antivirus products treat it as malware so you can check they work.'));
    }
    if (!NO_HASH.includes(ext) && st.size <= MAX_HASH_BYTES) {
      sha256 = await sha256File(file);
      if (this.allowed(sha256)) return done(null);
      const sig = this.d.db.get<{ name: string | null; source: string }>('SELECT name, source FROM shield_signatures WHERE sha256 = ?', sha256);
      if (sig) return done(v('malware', 'signature', sig.name || 'Known malware', `Its fingerprint is in FBRX Shield's threat database (${sig.source}).`));
    }
    if (!this.d.settings().heuristics) return done(null);
    const downloaded = !!o.downloaded || this.d.landing().some((dir) => under(file, dir)) || (await fromInternet(file));
    let found: ShieldVerdict | null = null;

    if (BIDI.test(name)) found = v('suspicious', 'heuristic', 'Disguised file name', 'Its name uses hidden right-to-left characters, a trick to make a program look like a document.');
    else if (DOUBLE_EXT.test(name)) found = v('suspicious', 'heuristic', 'Disguised program', `Its name ends in "${name.slice(name.lastIndexOf('.', name.lastIndexOf('.') - 1))}", so a program looks like a document or picture.`);
    if (!found && st.size <= MAX_SCRIPT_BYTES && (SCRIPTS.includes(ext) || (ext === 'js' && downloaded) || TEXT_CONFIGS.includes(ext))) {
      const text = await readFile(file, 'utf8');
      const script = SCRIPTS.includes(ext) || ext === 'js';
      const rule = SCRIPT_RULES.find((r) => (script || r.anyText) && r.test.test(text));
      if (rule) found = v('suspicious', 'heuristic', rule.name, rule.reason);
    }
    if (!found && downloaded && RISKY_FROM_INTERNET.includes(ext)) {
      found = v('suspicious', 'heuristic', 'Risky file from the internet', `A .${ext} file from the internet. Files like this are a common way malware gets in; open it only if you expected it.`);
    }
    if (!found && downloaded && MACRO_OOXML.includes(ext)) {
      const names = await zipEntryNames(file).catch(() => null);
      if (names?.some((n) => /vbaProject\.bin$/i.test(n))) found = v('suspicious', 'heuristic', 'Document with macros', 'An Office document with macros, from the internet. Macros in documents you did not expect are a common way malware gets in.');
    }
    if (!found && downloaded && ['doc', 'xls', 'ppt', 'dot', 'xlt'].includes(ext) && st.size <= 20 * 1024 * 1024) {
      const buf = await readFile(file);
      if (buf.includes(Buffer.from('_VBA_PROJECT', 'utf16le')) || buf.includes(Buffer.from('_VBA_PROJECT', 'latin1'))) {
        found = v('suspicious', 'heuristic', 'Document with macros', 'An Office document with macros, from the internet. Macros in documents you did not expect are a common way malware gets in.');
      }
    }
    if (!found && downloaded && ext === 'zip') {
      const names = (await zipEntryNames(file).catch(() => null))?.filter((n) => !n.endsWith('/')) ?? null;
      const hidden = names && names.length <= 10 ? names.find((n) => DOUBLE_EXT.test(n) || BIDI.test(n) || RISKY_IN_ARCHIVE.includes(extOf(n))) : undefined;
      if (hidden) found = v('suspicious', 'heuristic', 'Archive hides a script', `The archive holds "${hidden}", a script or disguised program. Malware often arrives this way.`);
    }
    if (found && sha256) found = (await this.askVirusTotal(sha256, o.signal)) ?? found;
    return done(found);
  }

  /** Endpoint Ultra: a suspicious file that many engines on VirusTotal call malicious becomes malware. */
  private async askVirusTotal(sha256: string, signal?: AbortSignal): Promise<ShieldVerdict | null> {
    const key = this.d.secret('VIRUSTOTAL_API_KEY');
    if (!this.d.ultra() || !this.d.settings().useVirusTotal || !key || !this.d.internet()) return null;
    try {
      const r = await fetch(`https://www.virustotal.com/api/v3/files/${sha256}`, { headers: { 'x-apikey': key }, signal: signal ?? AbortSignal.timeout(15_000) });
      if (!r.ok) return null;
      const stats = ((await r.json()) as any)?.data?.attributes?.last_analysis_stats;
      const bad = Number(stats?.malicious ?? 0);
      return bad >= 3 ? { kind: 'malware', engine: 'virustotal', name: `Malware (${bad} engines on VirusTotal)`, reason: `${bad} antivirus engines on VirusTotal call this file malicious.` } : null;
    } catch {
      return null;
    }
  }

  // ----------------------------------------------------------------------------------------- detections

  private row(id: string): DetectionRow {
    const r = this.d.db.get<DetectionRow>('SELECT * FROM shield_detections WHERE id = ?', id);
    if (!r) throw new CoreError('NOT_FOUND', 'That detection is gone.');
    return r;
  }

  /** Records a finding (once per file and fingerprint while it is waiting for a decision). */
  record(file: string, r: FileVerdict, source: ShieldDetection['source']): ShieldDetection {
    if (!r.verdict) throw new Error('Nothing to record');
    const open = this.d.db.get<DetectionRow>("SELECT * FROM shield_detections WHERE path = ? AND IFNULL(sha256, '') = IFNULL(?, '') AND action = 'open'", file, r.sha256);
    if (open) return toDetection(open);
    const id = newId('shd');
    this.d.db.run(
      'INSERT INTO shield_detections (id, path, sha256, size, kind, name, engine, reason, source, at, action) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      file,
      r.sha256,
      r.size,
      r.verdict.kind,
      r.verdict.name.slice(0, 200),
      r.verdict.engine,
      r.verdict.reason.slice(0, 1000),
      source,
      new Date().toISOString(),
      'open',
    );
    // Keep the history to the last 2000 findings.
    this.d.db.run("DELETE FROM shield_detections WHERE action != 'quarantined' AND id NOT IN (SELECT id FROM shield_detections ORDER BY at DESC LIMIT 2000)");
    return toDetection(this.row(id));
  }

  detections(limit = 200): ShieldDetection[] {
    return this.d.db.all<DetectionRow>('SELECT * FROM shield_detections ORDER BY at DESC LIMIT ?', Math.max(1, Math.min(2000, limit))).map(toDetection);
  }

  detection(id: string): ShieldDetection {
    return toDetection(this.row(id));
  }

  private setAction(id: string, action: ShieldAction, extra: { qfile?: string | null; qkey?: string | null; mode?: number | null } = {}) {
    this.d.db.run(
      'UPDATE shield_detections SET action = ?, action_at = ?, qfile = ?, qkey = ?, mode = ? WHERE id = ?',
      action,
      new Date().toISOString(),
      extra.qfile ?? null,
      extra.qkey ?? null,
      extra.mode ?? null,
      id,
    );
    return toDetection(this.row(id));
  }

  /** Moves the file into quarantine, encrypted so it cannot run. */
  async quarantine(id: string): Promise<ShieldDetection> {
    const r = this.row(id);
    if (r.action === 'quarantined') return toDetection(r);
    const st = await stat(r.path).catch(() => null);
    if (!st?.isFile()) return this.setAction(id, 'deleted');
    const key = randomBytes(32);
    const iv = randomBytes(16);
    const qfile = join(this.d.dir, `${id}.q`);
    await pipeline(createReadStream(r.path), createCipheriv('aes-256-ctr', key, iv), createWriteStream(qfile, { mode: 0o600 }));
    try {
      await unlink(r.path);
    } catch (err) {
      await rm(qfile, { force: true });
      throw new CoreError('UNAVAILABLE', `Could not move ${basename(r.path)} into quarantine: ${errorMessage(err)}. Close any program using it and try again.`);
    }
    return this.setAction(id, 'quarantined', { qfile, qkey: Buffer.concat([key, iv]).toString('base64'), mode: st.mode & 0o777 });
  }

  /** Puts a quarantined file back (next to the original name if something else is there now) and trusts it. */
  async restore(id: string): Promise<ShieldDetection> {
    const r = this.row(id);
    if (r.action !== 'quarantined' || !r.qfile || !r.qkey) throw new CoreError('CONFLICT', 'That file is not in quarantine.');
    const kv = Buffer.from(r.qkey, 'base64');
    let target = r.path;
    for (let n = 1; existsSync(target); n++) {
      const ext = extname(r.path);
      target = `${r.path.slice(0, r.path.length - ext.length)} (restored${n > 1 ? ` ${n}` : ''})${ext}`;
    }
    await pipeline(createReadStream(r.qfile), createDecipheriv('aes-256-ctr', kv.subarray(0, 32), kv.subarray(32)), createWriteStream(target));
    if (r.mode) await chmod(target, r.mode).catch(() => undefined);
    if (r.sha256 && (await sha256File(target)) !== r.sha256) {
      await rm(target, { force: true });
      throw new CoreError('INTERNAL', 'The quarantined copy is damaged; nothing was restored.');
    }
    await rm(r.qfile, { force: true });
    if (r.sha256) this.d.db.run('INSERT OR REPLACE INTO shield_allow (sha256, path, at) VALUES (?, ?, ?)', r.sha256, target, new Date().toISOString());
    return this.setAction(id, 'restored');
  }

  /** Deletes the file for good (from quarantine, or where it is). */
  async remove(id: string): Promise<ShieldDetection> {
    const r = this.row(id);
    if (r.action === 'quarantined' && r.qfile) await rm(r.qfile, { force: true });
    else if (r.action === 'open') {
      try {
        await rm(r.path, { force: true });
      } catch (err) {
        throw new CoreError('UNAVAILABLE', `Could not delete ${basename(r.path)}: ${errorMessage(err)}`);
      }
    } else throw new CoreError('CONFLICT', 'There is nothing left to delete.');
    return this.setAction(id, 'deleted');
  }

  /** Trusts this file from now on (by its fingerprint) and leaves it where it is. */
  allow(id: string): ShieldDetection {
    const r = this.row(id);
    if (r.action !== 'open') throw new CoreError('CONFLICT', 'Only a file still in its place can be allowed.');
    if (r.sha256) this.d.db.run('INSERT OR REPLACE INTO shield_allow (sha256, path, at) VALUES (?, ?, ?)', r.sha256, r.path, new Date().toISOString());
    return this.setAction(id, 'allowed');
  }

  /** A finding: recorded, quarantined when it is malware and that is wanted, and passed on. */
  async handle(file: string, r: FileVerdict, source: ShieldDetection['source'], quarantine: boolean): Promise<ShieldDetection> {
    let det = this.record(file, r, source);
    if (quarantine && det.action === 'open' && det.kind !== 'suspicious' && this.d.settings().autoQuarantine) {
      det = await this.quarantine(det.id).catch((err) => {
        this.d.log.warn('Quarantine failed', { path: file, error: errorMessage(err) });
        return det;
      });
    }
    this.d.onDetection(det);
    return det;
  }

  // ---------------------------------------------------------------------------------------------- scans

  /** Scans files and folders. */
  async scan(targets: string[], o: { signal: AbortSignal; quarantine: boolean; onProgress: (p: ScanProgress) => void }): Promise<{ files: number; skipped: number; detections: ShieldDetection[] }> {
    const p: ScanProgress = { files: 0, skipped: 0, found: 0, current: null };
    const detections: ShieldDetection[] = [];
    let last = 0;
    const tick = (force = false) => {
      if (force || Date.now() - last > 250) {
        last = Date.now();
        o.onProgress({ ...p });
      }
    };
    const visit = async (file: string) => {
      if (o.signal.aborted) return;
      p.current = file;
      try {
        const r = await this.verdictFor(file, { signal: o.signal });
        p.files++;
        if (r.verdict) {
          detections.push(await this.handle(file, r, 'scan', o.quarantine));
          p.found++;
        }
      } catch {
        p.skipped++;
      }
      tick();
    };
    const walk = async (dir: string): Promise<void> => {
      if (o.signal.aborted || this.excluded(dir)) return;
      let handle;
      try {
        handle = await opendir(dir);
      } catch {
        p.skipped++;
        return;
      }
      for await (const ent of handle) {
        if (o.signal.aborted) break;
        const full = join(dir, ent.name);
        if (ent.isSymbolicLink() || this.excluded(full)) continue;
        if (ent.isDirectory()) await walk(full);
        else if (ent.isFile()) await visit(full);
      }
    };
    for (const t of targets) {
      const st = await stat(t).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) await walk(t);
      else if (st.isFile() && !this.excluded(t)) await visit(t);
    }
    // Endpoint Ultra: ClamAV, when installed, looks at the same places.
    if (!o.signal.aborted && this.d.ultra() && this.d.settings().useClamAV) {
      for (const det of await this.clamav(targets, o)) {
        detections.push(det);
        p.found++;
      }
    }
    p.current = null;
    tick(true);
    return { files: p.files, skipped: p.skipped, detections };
  }

  private async clamav(targets: string[], o: { signal: AbortSignal; quarantine: boolean }): Promise<ShieldDetection[]> {
    const clam = scanCommand('clamav');
    if (!clam) return [];
    const out: ShieldDetection[] = [];
    for (const t of targets) {
      if (o.signal.aborted || !existsSync(t)) continue;
      const r = await exec(clam.exe, clam.cmd.args(t), { timeoutMs: 6 * 3600_000, signal: o.signal });
      for (const line of r.out.split(/\r?\n/)) {
        const m = /^(.*): (.+) FOUND$/.exec(line.trim());
        if (!m || this.excluded(m[1])) continue;
        const st = await stat(m[1]).catch(() => null);
        const sha256 = st?.isFile() && st.size <= MAX_HASH_BYTES ? await sha256File(m[1]).catch(() => null) : null;
        if (sha256 && this.allowed(sha256)) continue;
        out.push(await this.handle(m[1], { verdict: { kind: 'malware', engine: 'clamav', name: m[2], reason: `ClamAV recognizes it as ${m[2]}.` }, sha256, size: st?.size ?? null }, 'scan', o.quarantine));
      }
    }
    return out;
  }

  // ----------------------------------------------------------------------------------- threat database

  signatures(): number {
    if (this.signatureCount === null) this.signatureCount = this.d.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM shield_signatures')?.n ?? 0;
    return this.signatureCount;
  }

  /** Adds fingerprints from a list (one SHA-256 per line; anything after it on the line is its name). */
  importSignatures(text: string, source: string): { added: number; total: number } {
    const now = new Date().toISOString();
    let added = 0;
    this.d.db.tx(() => {
      for (const line of text.split(/\r?\n/)) {
        if (!line || line.startsWith('#')) continue;
        const m = /\b([a-fA-F0-9]{64})\b(?:[\s,;"]+([^"\r\n]{1,120}))?/.exec(line);
        if (!m) continue;
        const name = m[2]?.trim().replace(/^["']|["']$/g, '') || null;
        added += this.d.db.run('INSERT OR IGNORE INTO shield_signatures (sha256, name, source, added_at) VALUES (?, ?, ?, ?)', m[1].toLowerCase(), name && !/^[a-f0-9]{32,}$/i.test(name) ? name : null, source, now).changes;
      }
    });
    this.signatureCount = null;
    return { added, total: this.signatures() };
  }

  /** Brings the threat database up to date from the feed. */
  async updateSignatures(): Promise<{ added: number; total: number }> {
    const url = this.d.settings().feedUrl.trim();
    if (!url) throw new CoreError('INVALID_ARGUMENT', 'No threat feed is set.');
    if (!this.d.internet()) throw new CoreError('POLICY_DENIED', 'Internet access is blocked by policy.');
    const key = this.d.secret('ABUSECH_AUTH_KEY');
    try {
      const res = await fetch(url, { headers: { 'user-agent': `FBRX-Shield/${SHIELD_ENGINE_VERSION}`, ...(key ? { 'Auth-Key': key } : {}) }, signal: AbortSignal.timeout(120_000) });
      if (res.status === 401 || res.status === 403) throw new Error('The threat feed asked for a key. Add your free abuse.ch Auth-Key in Credentials as ABUSECH_AUTH_KEY.');
      if (!res.ok) throw new Error(`The threat feed answered HTTP ${res.status}.`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_FEED_BYTES) throw new Error('The threat feed is too large.');
      let text: string;
      if (buf.subarray(0, 2).toString('latin1') === 'PK') {
        // A zipped list (a full export): unpack it and read the text inside.
        const tmp = join(tmpdir(), `fbrx-feed-${randomBytes(6).toString('hex')}`);
        mkdirSync(tmp, { recursive: true });
        try {
          const zip = join(tmp, 'feed.zip');
          await writeFile(zip, buf);
          const files = unzip(zip, join(tmp, 'out'));
          text = (await Promise.all(files.filter((f) => /\.(txt|csv)$/i.test(f)).map((f) => readFile(f, 'utf8')))).join('\n');
        } finally {
          await rm(tmp, { recursive: true, force: true });
        }
      } else text = buf.toString('utf8');
      const host = (() => {
        try {
          return new URL(url).hostname;
        } catch {
          return 'feed';
        }
      })();
      const r = this.importSignatures(text, host);
      this.d.meta.set('shield.signatures', { at: new Date().toISOString(), error: null });
      return r;
    } catch (err) {
      this.d.meta.set('shield.signatures', { at: this.d.meta.get<{ at: string | null }>('shield.signatures')?.at ?? null, error: errorMessage(err) });
      throw err instanceof CoreError ? err : new CoreError('UNAVAILABLE', errorMessage(err));
    }
  }

  // -------------------------------------------------------------------------------- download checks

  /** Checks new files in these folders as soon as they arrive. */
  watch(dirs: string[]): void {
    this.unwatch();
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      try {
        const w = watch(dir, { persistent: false }, (_event, filename) => {
          if (filename) this.queue(join(dir, filename.toString()));
        });
        w.on('error', () => undefined);
        this.watchers.push(w);
        this.watching.push(dir);
      } catch (err) {
        this.d.log.debug('Cannot watch folder', { dir, error: errorMessage(err) });
      }
    }
  }

  unwatch(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    this.watching = [];
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  private queue(file: string) {
    if (PARTIAL_DOWNLOAD.test(basename(file)) || basename(file).startsWith('.')) return;
    clearTimeout(this.pending.get(file));
    const t = setTimeout(() => void this.checkNew(file).catch((err) => this.d.log.debug('Download check failed', { file, error: errorMessage(err) })), 1500);
    t.unref?.();
    this.pending.set(file, t);
  }

  /** Waits until a new file stops growing, then checks it. */
  private async checkNew(file: string): Promise<void> {
    this.pending.delete(file);
    let st = await stat(file).catch(() => null);
    for (let i = 0; st?.isFile() && i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const again = await stat(file).catch(() => null);
      if (again && again.size === st.size && again.mtimeMs === st.mtimeMs) break;
      st = again;
    }
    if (!st?.isFile() || this.excluded(file) || !this.watchers.length) return;
    const stamp = `${st.size}:${st.mtimeMs}`;
    if (this.seen.get(file) === stamp) return;
    this.seen.set(file, stamp);
    if (this.seen.size > 5000) this.seen.clear();
    const r = await this.verdictFor(file, { downloaded: true });
    if (r.verdict && this.watchers.length) await this.handle(file, r, 'download', true);
  }

  /** Checks one file on request (Security → Check a file, the agent). */
  async check(file: string): Promise<{ verdict: ShieldVerdict | null; sha256: string | null; detection: ShieldDetection | null }> {
    const r = await this.verdictFor(file);
    return { verdict: r.verdict, sha256: r.sha256, detection: r.verdict ? this.record(file, r, 'check') : null };
  }

  status(lastScan: ShieldStatus['lastScan']): ShieldStatus {
    const sig = this.d.meta.get<{ at: string | null; error: string | null }>('shield.signatures');
    const counts = this.d.db.get<{ q: number; o: number }>("SELECT SUM(action = 'quarantined') AS q, SUM(action = 'open') AS o FROM shield_detections");
    const ultra = this.d.ultra();
    const s = this.d.settings();
    return {
      engineVersion: SHIELD_ENGINE_VERSION,
      signatures: this.signatures(),
      signaturesUpdatedAt: sig?.at ?? null,
      signaturesError: sig?.error ?? null,
      watching: [...this.watching],
      quarantined: counts?.q ?? 0,
      open: counts?.o ?? 0,
      lastScan,
      full: ultra,
      engines: { clamav: ultra && s.useClamAV && !!scanCommand('clamav'), virustotal: ultra && s.useVirusTotal && !!this.d.secret('VIRUSTOTAL_API_KEY') },
    };
  }
}
