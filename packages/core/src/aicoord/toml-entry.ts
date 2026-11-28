/**
 * The one change FBRX makes to an AI app's TOML config (OpenAI Codex CLI's ~/.codex/config.toml): its own table
 * `[<key>.<name>]` (and any sub-tables under it), added, replaced or removed, with every other line left exactly as it
 * was, comments included. FBRX writes plain `key = value` lines whose values are JSON strings and arrays (valid TOML)
 * and an inline table for env, so it needs no TOML library, and reads back only its own table.
 */

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The header of `[key.name]` or one of its sub-tables (`[key.name.env]`), quoted or not. */
const headerOf = (key: string, name: string) => new RegExp(`^\\s*\\[\\s*${esc(key)}\\s*\\.\\s*(["']?)${esc(name)}\\1\\s*(\\.[^\\]]*)?\\]\\s*(#.*)?$`);

/** The lines of FBRX's table: from its header to the line before the next other table (blank lines at its end left). */
function range(lines: string[], key: string, name: string): [number, number] | null {
  const head = headerOf(key, name);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !(/^\s*\[/.test(lines[end]!) && !head.test(lines[end]!))) end++;
  while (end > start + 1 && !lines[end - 1]!.trim()) end--;
  return [start, end];
}

/** FBRX's entry written another way (`name = {…}` inside `[key]`, or `key.name = …`): left alone, said in words. */
function writtenOtherwise(lines: string[], key: string, name: string): boolean {
  let inKey = false;
  for (const l of lines) {
    if (/^\s*\[/.test(l)) inKey = new RegExp(`^\\s*\\[\\s*${esc(key)}\\s*\\]`).test(l);
    else if (inKey && new RegExp(`^\\s*(["']?)${esc(name)}\\1\\s*=`).test(l)) return true;
    else if (!inKey && new RegExp(`^\\s*${esc(key)}\\s*\\.\\s*(["']?)${esc(name)}\\1\\s*[.=]`).test(l)) return true;
  }
  return false;
}

export interface TomlServer {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** FBRX's table as lines. */
function tableOf(key: string, name: string, e: TomlServer): string[] {
  const env = e.env && Object.keys(e.env).length ? `env = { ${Object.entries(e.env).map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`).join(', ')} }` : null;
  return [`[${key}.${name}]`, `command = ${JSON.stringify(e.command)}`, `args = ${JSON.stringify(e.args)}`, ...(env ? [env] : [])];
}

/** The text with FBRX's table set to `entry` (or taken out with null). */
export function setTomlEntry(text: string, key: string, name: string, entry: TomlServer | null): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (writtenOtherwise(lines, key, name)) throw new Error(`the ${name} server is written in a form FBRX does not change: take it out, then connect again`);
  const r = range(lines, key, name);
  if (r) lines.splice(r[0], r[1] - r[0], ...(entry ? tableOf(key, name, entry) : []));
  else if (entry) lines.push(...(lines.length && lines[lines.length - 1]!.trim() ? [''] : []), ...tableOf(key, name, entry));
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  // No run of blank lines where the table was.
  const out = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  return out ? `${out}\n` : '';
}

/** FBRX's table read back (command, args, env), or null when there is none. */
export function readTomlEntry(text: string, key: string, name: string): TomlServer | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const r = range(lines, key, name);
  if (!r) return null;
  const out: TomlServer = { command: '', args: [] };
  for (const l of lines.slice(r[0] + 1, r[1])) {
    const m = /^\s*([A-Za-z_]+)\s*=\s*(.+?)\s*$/.exec(l);
    if (!m) continue;
    try {
      if (m[1] === 'command') out.command = JSON.parse(m[2]!) as string;
      else if (m[1] === 'args') out.args = JSON.parse(m[2]!) as string[];
      else if (m[1] === 'env') {
        const env: Record<string, string> = {};
        for (const p of m[2]!.matchAll(/"((?:[^"\\]|\\.)*)"\s*=\s*("(?:[^"\\]|\\.)*")/g)) env[JSON.parse(`"${p[1]}"`) as string] = JSON.parse(p[2]!) as string;
        out.env = env;
      }
    } catch {
      /* a value FBRX did not write */
    }
  }
  return out.command ? out : null;
}
