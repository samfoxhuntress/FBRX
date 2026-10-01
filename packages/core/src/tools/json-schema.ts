/**
 * Minimal JSON-Schema validation for tool inputs (type, required, enum, bounds, nested objects/arrays).
 * Models occasionally send "5" for 5 or "true" for true, so scalars are coerced when unambiguous.
 */
export function validateInput(schema: Record<string, unknown>, input: unknown): { ok: true; value: unknown } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const value = walk(schema, input ?? (schema.type === 'object' ? {} : input), '$', errors);
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function walk(schema: Record<string, any>, v: unknown, path: string, errors: string[]): unknown {
  if (!schema || typeof schema !== 'object') return v;
  const types: string[] | undefined = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : undefined;
  let val = v;
  if (types && val !== undefined) {
    const actual = typeOf(val);
    const matches = types.some((t) => t === actual || (t === 'number' && actual === 'integer'));
    if (!matches) {
      const coerced = coerce(val, types);
      if (coerced.ok) val = coerced.value;
      else {
        errors.push(`${path}: expected ${types.join('|')}, got ${actual}`);
        return val;
      }
    }
  }
  if (schema.enum && !schema.enum.some((e: unknown) => e === val)) {
    errors.push(`${path}: must be one of ${schema.enum.map((e: unknown) => JSON.stringify(e)).join(', ')}`);
  }
  if (typeof val === 'string') {
    if (schema.minLength !== undefined && val.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && val.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
  }
  if (typeof val === 'number') {
    if (schema.minimum !== undefined && val < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && val > schema.maximum) errors.push(`${path}: above maximum ${schema.maximum}`);
  }
  if (typeOf(val) === 'object' && schema.properties) {
    const obj = { ...(val as Record<string, unknown>) };
    for (const req of schema.required ?? []) {
      if (obj[req] === undefined || obj[req] === null) errors.push(`${path}.${req}: is required`);
    }
    for (const [k, sub] of Object.entries(schema.properties as Record<string, any>)) {
      if (obj[k] === undefined && sub?.default !== undefined) obj[k] = structuredClone(sub.default);
      if (obj[k] !== undefined) obj[k] = walk(sub, obj[k], `${path}.${k}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(obj)) if (!(k in schema.properties)) errors.push(`${path}.${k}: unexpected property`);
    }
    return obj;
  }
  if (Array.isArray(val) && schema.items) {
    return val.map((item, i) => walk(schema.items, item, `${path}[${i}]`, errors));
  }
  return val;
}

function coerce(v: unknown, types: string[]): { ok: true; value: unknown } | { ok: false } {
  if (typeof v === 'string') {
    if ((types.includes('number') || types.includes('integer')) && v.trim() !== '' && !Number.isNaN(Number(v))) {
      const n = Number(v);
      if (types.includes('number') || Number.isInteger(n)) return { ok: true, value: n };
    }
    if (types.includes('boolean') && (v === 'true' || v === 'false')) return { ok: true, value: v === 'true' };
    if ((types.includes('object') || types.includes('array')) && /^[[{]/.test(v.trim())) {
      try {
        const parsed = JSON.parse(v);
        if (types.includes(typeOf(parsed))) return { ok: true, value: parsed };
      } catch {
        /* fallthrough */
      }
    }
  }
  if (typeof v === 'number' && types.includes('string')) return { ok: true, value: String(v) };
  return { ok: false };
}
