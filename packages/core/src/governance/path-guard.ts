import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path';
import type { SpecialDirs } from '../platform';
import { globToRegExp } from '../util/misc';

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

export function expandPathVars(p: string, dirs: SpecialDirs & { workspace: string; data: string }): string {
  let out = p.trim();
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) out = dirs.home + out.slice(1);
  out = out
    .replace(/\$\{HOME\}/g, dirs.home)
    .replace(/\$\{DOCUMENTS\}/g, dirs.documents)
    .replace(/\$\{DESKTOP\}/g, dirs.desktop)
    .replace(/\$\{DOWNLOADS\}/g, dirs.downloads)
    .replace(/\$\{WORKSPACE\}/g, dirs.workspace)
    .replace(/\$\{DATA\}/g, dirs.data);
  return normalize(out);
}

/** Resolves symlinks for the longest existing prefix so `allowed/link -> /etc` cannot escape a root. */
export function canonicalPath(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    tail.unshift(cur.slice(parent.length).replace(/^[\\/]/, ''));
    cur = parent;
  }
  let real = cur;
  try {
    real = realpathSync.native(cur);
  } catch {
    /* keep lexical */
  }
  return tail.length ? resolve(real, ...tail) : real;
}

function toCmp(p: string) {
  const n = p.replace(/[\\/]+/g, '/');
  return CASE_INSENSITIVE ? n.toLowerCase() : n;
}

export function isWithin(child: string, root: string): boolean {
  const c = toCmp(child);
  const r = toCmp(root).replace(/\/$/, '');
  return c === r || c.startsWith(`${r}/`);
}

export interface PathCheck {
  ok: boolean;
  resolved: string;
  reason?: string;
}

export function checkPath(
  path: string,
  access: 'read' | 'write',
  opts: { roots: string[]; denyPatterns: string[]; readOnly: boolean; dataDir: string },
): PathCheck {
  if (!isAbsolute(path)) return { ok: false, resolved: path, reason: `Path must be absolute: ${path}` };
  const resolved = canonicalPath(path);
  if (access === 'write' && opts.readOnly) {
    return { ok: false, resolved, reason: 'Filesystem is read-only by policy' };
  }
  // The FBRX data directory (vault database, keys, plugins) is never reachable through tools.
  if (isWithin(resolved, canonicalPath(opts.dataDir)) && !isWithin(resolved, canonicalPath(`${opts.dataDir}${sep}workspace`))) {
    return { ok: false, resolved, reason: 'FBRX OS internal data is not accessible to tools' };
  }
  const roots = opts.roots.map((r) => canonicalPath(r));
  if (!roots.some((r) => isWithin(resolved, r))) {
    return { ok: false, resolved, reason: `Path is outside the allowed folders: ${resolved}` };
  }
  const cmp = resolved.replace(/\\/g, '/');
  for (const pat of opts.denyPatterns) {
    if (globToRegExp(pat.replace(/\\/g, '/'), CASE_INSENSITIVE).test(cmp)) {
      return { ok: false, resolved, reason: `Path matches protected pattern "${pat}"` };
    }
  }
  return { ok: true, resolved };
}
