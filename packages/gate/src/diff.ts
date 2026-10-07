/** One difference between two configurations, for "what will change" before a commit. */
export interface GateChange {
  path: string;
  kind: 'added' | 'removed' | 'changed';
  from?: unknown;
  to?: unknown;
}

/** Items in these lists are matched by their name or id, not their position. */
const keyOf = (v: unknown): string | null => {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  for (const k of ['id', 'name', 'mac', 'publicKey']) if (typeof o[k] === 'string') return o[k] as string;
  return null;
};

/** The differences between two configurations (or any two JSON values), deepest first. */
export function diffConfig(a: unknown, b: unknown, path = ''): GateChange[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (Array.isArray(a) && Array.isArray(b) && [...a, ...b].every((x) => keyOf(x) !== null)) {
    const out: GateChange[] = [];
    const am = new Map(a.map((x) => [keyOf(x)!, x]));
    const bm = new Map(b.map((x) => [keyOf(x)!, x]));
    for (const [k, v] of am) if (!bm.has(k)) out.push({ path: `${path}.${k}`, kind: 'removed', from: v });
    for (const [k, v] of bm) out.push(...(am.has(k) ? diffConfig(am.get(k), v, `${path}.${k}`) : [{ path: `${path}.${k}`, kind: 'added' as const, to: v }]));
    if (!out.length) out.push({ path, kind: 'changed', from: a.map(keyOf), to: b.map(keyOf) }); // reordered
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out: GateChange[] = [];
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const p = path ? `${path}.${k}` : k;
      const x = (a as Record<string, unknown>)[k];
      const y = (b as Record<string, unknown>)[k];
      if (x === undefined) out.push({ path: p, kind: 'added', to: y });
      else if (y === undefined) out.push({ path: p, kind: 'removed', from: x });
      else out.push(...diffConfig(x, y, p));
    }
    return out;
  }
  return [{ path: path || 'config', kind: 'changed', from: a, to: b }];
}
