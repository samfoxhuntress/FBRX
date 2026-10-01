export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(v: string): SemVer | null {
  const m = SEMVER_RE.exec(v.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

export function isValidSemver(v: string): boolean {
  return parseSemver(v) !== null;
}

/** Returns -1, 0, 1. Invalid versions sort lowest. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (pa[k] !== pb[k]) return pa[k] > pb[k] ? 1 : -1;
  }
  // A version without prerelease is higher than one with.
  if (!pa.prerelease.length && pb.prerelease.length) return 1;
  if (pa.prerelease.length && !pb.prerelease.length) return -1;
  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i++) {
    const x = pa.prerelease[i];
    const y = pb.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx > ny ? 1 : -1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

/**
 * Minimal range support: space-separated comparators (`>=1.2.0 <2.0.0`), `^x.y.z`, `~x.y.z`, `*`, exact.
 * Sufficient for plugin `engines.fbrx` constraints.
 */
export function satisfies(version: string, range: string): boolean {
  const r = range.trim();
  if (r === '' || r === '*' || r === 'x') return true;
  return r.split('||').some((alt) => alt.trim().split(/\s+/).every((c) => satisfiesOne(version, c)));
}

function satisfiesOne(version: string, comp: string): boolean {
  const v = parseSemver(version);
  if (!v) return false;
  if (comp.startsWith('^')) {
    const base = parseSemver(comp.slice(1));
    if (!base) return false;
    if (compareSemver(version, comp.slice(1)) < 0) return false;
    if (base.major > 0) return v.major === base.major;
    if (base.minor > 0) return v.major === 0 && v.minor === base.minor;
    return v.major === 0 && v.minor === 0 && v.patch === base.patch;
  }
  if (comp.startsWith('~')) {
    const base = parseSemver(comp.slice(1));
    if (!base) return false;
    return compareSemver(version, comp.slice(1)) >= 0 && v.major === base.major && v.minor === base.minor;
  }
  const m = /^(>=|<=|>|<|=)?(.+)$/.exec(comp);
  if (!m) return false;
  const op = m[1] ?? '=';
  const cmp = compareSemver(version, m[2]);
  switch (op) {
    case '>=':
      return cmp >= 0;
    case '<=':
      return cmp <= 0;
    case '>':
      return cmp > 0;
    case '<':
      return cmp < 0;
    default:
      return cmp === 0;
  }
}
