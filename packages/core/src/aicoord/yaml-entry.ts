/**
 * The one change FBRX makes to an AI app's YAML config (Hermes Agent's ~/.hermes/config.yaml): its own entry under a
 * top-level mapping of servers, added, replaced or removed, with every other line left exactly as it was, comments
 * included. FBRX writes its entry on one line in YAML's JSON-compatible flow style, so it needs no YAML library to
 * write it, and reads back only that line.
 */

/** A value in YAML flow style that is also JSON: `{"command": "x", "args": ["y"]}`. */
const flow = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(flow).join(', ')}]`
    : v && typeof v === 'object'
      ? `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${flow(x)}`).join(', ')}}`
      : JSON.stringify(v);

const indentOf = (line: string) => /^[ \t]*/.exec(line)![0].length;
const blank = (line: string) => !line.trim() || /^\s*#/.test(line);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where the top-level `key` mapping is: its line, the lines of its block, and the indent of its entries. */
function locate(lines: string[], key: string): { at: number; inline: string; end: number; indent: string } | null {
  const at = lines.findIndex((l) => new RegExp(`^${esc(key)}\\s*:(\\s|$)`).test(l));
  if (at < 0) return null;
  const inline = lines[at]
    .slice(lines[at].indexOf(':') + 1)
    .replace(/\s+#.*$/, '')
    .trim();
  let end = at + 1;
  while (end < lines.length && (blank(lines[end]) || indentOf(lines[end]) > 0)) end++;
  // Blank lines and comments at the end belong to what follows.
  while (end > at + 1 && blank(lines[end - 1]) && indentOf(lines[end - 1]) === 0) end--;
  const first = lines.slice(at + 1, end).find((l) => !blank(l));
  return { at, inline, end, indent: first ? /^[ \t]*/.exec(first)![0] : '  ' };
}

/** The lines of `name`'s entry inside the block: from its own line to the last one indented under it. */
function entryRange(lines: string[], block: { at: number; end: number; indent: string }, name: string): [number, number] | null {
  const head = new RegExp(`^${esc(block.indent)}(["']?)${esc(name)}\\1\\s*:(\\s|$)`);
  const start = lines.findIndex((l, i) => i > block.at && i < block.end && head.test(l));
  if (start < 0) return null;
  let stop = start + 1;
  while (stop < block.end && (blank(lines[stop]) || indentOf(lines[stop]) > block.indent.length)) stop++;
  while (stop > start + 1 && blank(lines[stop - 1])) stop--;
  return [start, stop];
}

/** `name`'s entry under the top-level `key`: what FBRX wrote (parsed), {} for one written by hand, or null. */
export function readYamlEntry(text: string, key: string, name: string): Record<string, unknown> | null {
  const lines = text.split(/\r?\n/);
  const block = locate(lines, key);
  if (!block || block.inline) return null;
  const range = entryRange(lines, block, name);
  if (!range) return null;
  const value = lines[range[0]].slice(lines[range[0]].indexOf(':') + 1).trim();
  try {
    const v = JSON.parse(value);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Sets (or with null removes) `name`'s entry under the top-level `key`, keeping the rest of the file as it was. A
 * servers mapping written on one line (`key: {a: …}`) is left alone: the person is asked to split it first.
 */
export function setYamlEntry(text: string, key: string, name: string, value: object | null): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.length ? text.replace(/\r?\n$/, '').split(/\r?\n/) : [];
  const line = (indent: string) => `${indent}${name}: ${flow(value)}`;
  let block = locate(lines, key);
  if (block && block.inline && !/^(\{\s*\}|null|~)$/.test(block.inline)) {
    throw new Error(`"${key}" is written on one line: put each server on its own line, then connect again.`);
  }
  if (block?.inline) {
    lines[block.at] = `${key}:`;
    block = locate(lines, key);
  }
  if (!block) {
    if (!value) return text;
    if (lines.length && lines[lines.length - 1].trim()) lines.push('');
    lines.push(`${key}:`, line('  '));
    return `${lines.join(eol)}${eol}`;
  }
  const range = entryRange(lines, block, name);
  if (range) lines.splice(range[0], range[1] - range[0], ...(value ? [line(block.indent)] : []));
  else if (value) {
    let last = block.end;
    while (last > block.at + 1 && blank(lines[last - 1])) last--;
    lines.splice(last, 0, line(block.indent));
  }
  return `${lines.join(eol)}${eol}`;
}
