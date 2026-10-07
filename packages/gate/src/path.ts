/**
 * Addressing parts of a configuration the way a router's command line does: words, not JSON paths. Items in lists
 * are found by their name (or id, MAC address, public key), so "networks guest dhcp end" and "interfaces eno2.30 mtu"
 * work; a number picks by position.
 */

const KEYS = ['name', 'id', 'mac', 'publicKey'] as const;

function itemIndex(list: unknown[], word: string): number {
  const i = list.findIndex((x) => x && typeof x === 'object' && KEYS.some((k) => (x as Record<string, unknown>)[k] === word));
  if (i >= 0) return i;
  if (/^\d+$/.test(word) && Number(word) < list.length) return Number(word);
  return -1;
}

/** The part at a path, or undefined. */
export function getPath(root: unknown, path: string[]): unknown {
  let cur: unknown = root;
  for (const w of path) {
    if (Array.isArray(cur)) {
      const i = itemIndex(cur, w);
      if (i < 0) return undefined;
      cur = cur[i];
    } else if (cur && typeof cur === 'object') cur = (cur as Record<string, unknown>)[w];
    else return undefined;
  }
  return cur;
}

/** Reads a word typed on the command line as what the setting holds (a number, true/false, a list, text). */
export function parseValue(raw: string, current: unknown): unknown {
  const t = raw.trim();
  if (t.startsWith('{') || t.startsWith('[')) return JSON.parse(t);
  if (typeof current === 'number' || (current === undefined && /^-?\d+(\.\d+)?$/.test(t) && !t.includes('.'))) {
    const n = Number(t);
    if (Number.isNaN(n)) throw new Error(`${raw} is not a number`);
    return n;
  }
  if (typeof current === 'boolean' || t === 'true' || t === 'false') {
    if (['true', 'yes', 'on'].includes(t)) return true;
    if (['false', 'no', 'off'].includes(t)) return false;
    throw new Error(`${raw} is not true or false`);
  }
  if (Array.isArray(current)) return t.split(',').map((x) => x.trim()).filter(Boolean);
  return t;
}

/** A copy with the value at the path replaced (the parent must exist). */
export function setPath<T>(root: T, path: string[], value: unknown): T {
  if (!path.length) return value as T;
  const copy = structuredClone(root) as unknown;
  const parent = getPath(copy, path.slice(0, -1));
  const last = path[path.length - 1];
  if (Array.isArray(parent)) {
    const i = itemIndex(parent, last);
    if (i < 0) throw new Error(`There is no ${last} in ${path.slice(0, -1).join(' ') || 'the configuration'} (add it first)`);
    parent[i] = value;
  } else if (parent && typeof parent === 'object') (parent as Record<string, unknown>)[last] = value;
  else throw new Error(`There is no ${path.slice(0, -1).join(' ')}`);
  return copy as T;
}

/** A copy with an item added to the list at the path. */
export function addPath<T>(root: T, path: string[], item: unknown): T {
  const copy = structuredClone(root) as unknown;
  const list = getPath(copy, path);
  if (!Array.isArray(list)) throw new Error(`${path.join(' ')} is not a list`);
  list.push(item);
  return copy as T;
}

/** A copy without the part at the path (a list item, or an optional setting). */
export function deletePath<T>(root: T, path: string[]): T {
  if (!path.length) throw new Error('Say what to delete');
  const copy = structuredClone(root) as unknown;
  const parent = getPath(copy, path.slice(0, -1));
  const last = path[path.length - 1];
  if (Array.isArray(parent)) {
    const i = itemIndex(parent, last);
    if (i < 0) throw new Error(`There is no ${last} in ${path.slice(0, -1).join(' ')}`);
    parent.splice(i, 1);
  } else if (parent && typeof parent === 'object' && last in (parent as object)) delete (parent as Record<string, unknown>)[last];
  else throw new Error(`There is no ${path.join(' ')}`);
  return copy as T;
}
