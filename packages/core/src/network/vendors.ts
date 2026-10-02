import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { MacLookup, VendorDbInfo } from '@fbrx/shared';
import { CoreError } from '../errors';

/**
 * The IEEE registry of MAC address blocks, used to name the maker of each device on the network. A copy ships with
 * FBRX OS (built from the IEEE lists at release time); "Update" downloads the current lists from the IEEE. Blocks
 * come in three sizes: MA-L (first 6 hex digits), MA-M (7) and MA-S / IAB (9); the longest match wins.
 *
 * File format: gzip of UTF-8 lines `PREFIX<TAB>Organization`, after a `# date` header line.
 */

const IEEE_LISTS = [
  'https://standards-oui.ieee.org/oui/oui.csv',
  'https://standards-oui.ieee.org/oui28/mam.csv',
  'https://standards-oui.ieee.org/oui36/oui36.csv',
  'https://standards-oui.ieee.org/iab/iab.csv',
];
/** The same registry as JSON, published from the IEEE lists daily (used when the IEEE site refuses the download). */
const MIRROR = 'https://cdn.jsdelivr.net/npm/oui-data@latest/index.json';
/** The IEEE site turns away requests that do not look like a browser. */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 FBRX-OS';

/** "XEROX CORPORATION" → "Xerox Corporation"; short all-caps words (HP, LG, IBM) stay as they are. */
export function tidyVendor(name: string): string {
  const n = name.replace(/\s+/g, ' ').trim();
  if (/[a-z]/.test(n)) return n;
  return n.replace(/[A-Z][A-Z0-9&'.-]*/g, (w) => (w.length <= 3 ? w : w[0] + w.slice(1).toLowerCase()));
}

/** Splits one CSV line, honoring quoted fields. */
function csvRow(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Entries from an IEEE registry CSV (Registry, Assignment, Organization Name, Organization Address). */
export function parseIeeeCsv(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const [, assignment, org] = csvRow(line);
    if (assignment && /^[0-9A-F]{6,9}$/i.test(assignment) && org) out.push([assignment.toUpperCase(), tidyVendor(org)]);
  }
  return out;
}

/** Entries from the oui-data JSON ({ "PREFIX": "Organization\nAddress…" }). */
export function parseOuiJson(json: Record<string, string>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [prefix, value] of Object.entries(json)) {
    const org = String(value).split('\n')[0];
    if (/^[0-9A-F]{6,9}$/i.test(prefix) && org) out.push([prefix.toUpperCase(), tidyVendor(org)]);
  }
  return out;
}

export function encodeVendorDb(entries: Iterable<[string, string]>, date: string): Buffer {
  const lines = [`# ${date}`];
  for (const [p, v] of entries) lines.push(`${p}\t${v.replace(/[\t\n]/g, ' ')}`);
  return gzipSync(lines.join('\n'), { level: 9 });
}

function decode(file: string): { date: string | null; map: Map<string, string> } | null {
  try {
    const text = gunzipSync(readFileSync(file)).toString('utf8');
    const map = new Map<string, string>();
    let date: string | null = null;
    for (const line of text.split('\n')) {
      if (line.startsWith('#')) {
        date ??= line.slice(1).trim() || null;
        continue;
      }
      const tab = line.indexOf('\t');
      if (tab > 0) map.set(line.slice(0, tab), line.slice(tab + 1));
    }
    return map.size ? { date, map } : null;
  } catch {
    return null;
  }
}

export class VendorDb {
  private map: Map<string, string> | null = null;
  private meta: VendorDbInfo = { entries: 0, source: 'none', updatedAt: null };

  constructor(
    private readonly d: {
      /** The copy shipped with FBRX OS (null in development without a build). */
      builtinFile: string | null;
      /** Where downloaded updates are kept. */
      userFile: string;
      internet: () => boolean;
      /** Older versions kept a Wireshark list here; it is removed. */
      legacyFile?: string;
    },
  ) {}

  private load(): Map<string, string> {
    if (this.map) return this.map;
    if (this.d.legacyFile && existsSync(this.d.legacyFile)) rmSync(this.d.legacyFile, { force: true });
    const user = existsSync(this.d.userFile) ? decode(this.d.userFile) : null;
    const builtin = this.d.builtinFile && existsSync(this.d.builtinFile) ? decode(this.d.builtinFile) : null;
    // A download made before this version shipped is older than the built-in copy: use whichever is newer.
    const pick = user && (!builtin || (user.date ?? '') >= (builtin.date ?? '')) ? { ...user, source: 'downloaded' as const } : builtin ? { ...builtin, source: 'built-in' as const } : null;
    this.map = pick?.map ?? new Map();
    this.meta = { entries: this.map.size, source: pick?.source ?? 'none', updatedAt: pick?.date ?? null };
    return this.map;
  }

  info(): VendorDbInfo {
    this.load();
    return { ...this.meta };
  }

  lookup(mac: string): MacLookup {
    const hex = mac.replace(/[^0-9a-f]/gi, '').toUpperCase();
    const pretty = hex.length === 12 ? hex.match(/../g)!.join(':') : mac.trim();
    if (hex.length !== 12) return { mac: pretty, vendor: null, kind: 'invalid', block: null, prefix: null };
    const first = parseInt(hex.slice(0, 2), 16);
    if (first & 1) return { mac: pretty, vendor: null, kind: 'multicast', block: null, prefix: null };
    if (first & 2) return { mac: pretty, vendor: 'Private (randomized) address', kind: 'private', block: null, prefix: null };
    const map = this.load();
    for (const [len, block] of [
      [9, 'MA-S'],
      [7, 'MA-M'],
      [6, 'MA-L'],
    ] as const) {
      const v = map.get(hex.slice(0, len));
      if (v) return { mac: pretty, vendor: v, kind: 'global', block, prefix: hex.slice(0, len) };
    }
    return { mac: pretty, vendor: null, kind: 'global', block: null, prefix: null };
  }

  /** The maker's name for a MAC address, or null. */
  vendorOf(mac: string | null): string | null {
    return mac ? this.lookup(mac).vendor : null;
  }

  /** Downloads the current registry from the IEEE (or its daily JSON mirror). */
  async update(): Promise<VendorDbInfo> {
    if (!this.d.internet()) throw new CoreError('FORBIDDEN', 'Your organization does not allow FBRX OS to use the internet');
    const get = async (url: string) => {
      const r = await fetch(url, { headers: { 'user-agent': BROWSER_UA, accept: 'text/csv,application/json,*/*' }, signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
      return r.text();
    };
    let entries: Array<[string, string]> = [];
    let problem = '';
    try {
      entries = parseIeeeCsv(await get(IEEE_LISTS[0]));
      // The smaller blocks are a bonus: a failure there keeps the main list.
      for (const url of IEEE_LISTS.slice(1)) entries.push(...(await get(url).then(parseIeeeCsv, () => [])));
    } catch (err) {
      problem = (err as Error).message;
    }
    if (entries.length < 10_000) {
      try {
        entries = parseOuiJson(JSON.parse(await get(MIRROR)));
      } catch (err) {
        throw new CoreError('UNAVAILABLE', `Could not download the vendor list (${problem || (err as Error).message})`);
      }
    }
    if (entries.length < 10_000) throw new CoreError('UNAVAILABLE', 'The downloaded vendor list looks incomplete; kept the current one');
    writeFileSync(this.d.userFile, encodeVendorDb(entries, new Date().toISOString().slice(0, 10)));
    this.map = null;
    return this.info();
  }
}
