/** Deterministic JSON serialization (sorted keys) used for hashing and signing. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

/** Deep merge where arrays and scalars from `patch` replace those in `base`. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return (patch === undefined ? base : (patch as T));
  if (!isPlainObject(base)) return structuredClone(patch) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : structuredClone(v);
  }
  return out as T;
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Flattens an object into dot-paths of its leaves (arrays are leaves). */
export function leafPaths(obj: unknown, prefix = ''): string[] {
  if (!isPlainObject(obj)) return prefix ? [prefix] : [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v) && Object.keys(v).length) out.push(...leafPaths(v, p));
    else out.push(p);
  }
  return out;
}

/** True if `path` equals or is nested under any of the `locked` paths (or vice versa). */
export function isPathLocked(path: string, locked: readonly string[]): boolean {
  return locked.some((l) => path === l || path.startsWith(`${l}.`) || l.startsWith(`${path}.`));
}
