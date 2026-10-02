/**
 * Text tools shared by the clipboard processor and slash macros: placeholder expansion for macros, and the transform
 * steps a clipboard macro is built from. Pure functions, so they behave the same in the app, in FBRX/1 and in tests.
 */

// ------------------------------------------------------------------------------------------- slash macros

export interface MacroContext {
  name: string;
  callMe: string;
  host: string;
  clipboard?: string;
  now?: Date;
}

export const MACRO_PLACEHOLDERS: Array<[string, string]> = [
  ['{date}', "Today's date"],
  ['{time}', 'The time (hours and minutes)'],
  ['{datetime}', 'Date and time'],
  ['{isodate}', 'Date as 2026-10-02'],
  ['{name}', 'Your name (Settings → General)'],
  ['{callme}', 'What FBRX calls you'],
  ['{host}', "This computer's name"],
  ['{clipboard}', 'What is on the clipboard'],
  ['{cursor}', 'Where the cursor lands after expanding'],
];

const pad = (n: number) => String(n).padStart(2, '0');

/** Fills in a macro's placeholders. Returns the text and where the cursor goes ({cursor}, or the end). */
export function expandMacro(text: string, ctx: MacroContext): { text: string; cursor: number } {
  const now = ctx.now ?? new Date();
  const date = now.toLocaleDateString();
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const values: Record<string, string> = {
    date,
    time,
    datetime: `${date} ${time}`,
    isodate: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    name: ctx.name.trim() || ctx.callMe.trim(),
    callme: ctx.callMe.trim() || ctx.name.trim().split(/\s+/)[0] || '',
    host: ctx.host,
    clipboard: ctx.clipboard ?? '',
  };
  let cursor = -1;
  let out = '';
  let last = 0;
  for (const m of text.matchAll(/\{(date|time|datetime|isodate|name|callme|host|clipboard|cursor)\}/gi)) {
    out += text.slice(last, m.index);
    const key = m[1].toLowerCase();
    if (key === 'cursor') {
      if (cursor < 0) cursor = out.length;
    } else out += values[key];
    last = m.index! + m[0].length;
  }
  out += text.slice(last);
  return { text: out, cursor: cursor < 0 ? out.length : cursor };
}

/**
 * The slash command being typed just before the caret, if any: "/sig" → { word: "sig" }; "/snip dns" → { word: "snip",
 * arg: "dns" }. A slash only counts at the start of the text or after a space, so paths like C:/Users don't trigger it.
 */
export function slashAt(value: string, caret: number): { start: number; word: string; arg?: string } | null {
  const before = value.slice(0, caret);
  const snip = /(^|\s)\/snip(?:\s([^\n]*))?$/i.exec(before);
  if (snip) return { start: snip.index + snip[1].length, word: 'snip', arg: snip[2] ?? '' };
  const m = /(^|\s)\/([a-z0-9_-]{0,24})$/i.exec(before);
  return m ? { start: m.index + m[1].length, word: m[2].toLowerCase() } : null;
}

// ---------------------------------------------------------------------------------------- transform steps

export interface TextStep {
  op: string;
  a?: string;
  b?: string;
  flag?: boolean;
}

export interface TextOp {
  id: string;
  label: string;
  group: 'Clean up' | 'Lines' | 'Case' | 'Find and replace' | 'Extract' | 'Encode and format';
  a?: { label: string; placeholder?: string };
  b?: { label: string; placeholder?: string };
  flag?: string;
  run: (text: string, s: TextStep) => string;
}

/** "\n" and "\t" typed in a step's box mean a new line and a tab. */
export function unescapeArg(s: string | undefined): string {
  return (s ?? '').replace(/\\([nrt\\])/g, (_m, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : '\\'));
}

const lines = (t: string) => t.replace(/\r\n?/g, '\n').split('\n');
const words = (t: string) => t.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function base64ToUtf8(s: string): string {
  const bin = atob(s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function matcher(s: TextStep): (line: string) => boolean {
  const needle = s.a ?? '';
  if (s.flag) {
    const re = new RegExp(needle, 'i');
    return (l) => re.test(l);
  }
  const n = needle.toLowerCase();
  return (l) => l.toLowerCase().includes(n);
}

function parseCsv(text: string): string[][] {
  const delim = text.includes('\t') ? '\t' : text.split('\n')[0].split(';').length > text.split('\n')[0].split(',').length ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && !cell) quoted = true;
    else if (c === delim) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–' };

export const TEXT_OPS: TextOp[] = [
  // Clean up
  { id: 'trim', label: 'Trim the whole text', group: 'Clean up', run: (t) => t.trim() },
  { id: 'trimLines', label: 'Trim each line', group: 'Clean up', run: (t) => lines(t).map((l) => l.trim()).join('\n') },
  { id: 'collapseSpaces', label: 'Collapse repeated spaces', group: 'Clean up', run: (t) => t.replace(/[ \t\u00a0]{2,}/g, ' ') },
  { id: 'removeBlank', label: 'Remove blank lines', group: 'Clean up', run: (t) => lines(t).filter((l) => l.trim()).join('\n') },
  {
    id: 'straightQuotes',
    label: 'Straighten quotes and dashes',
    group: 'Clean up',
    run: (t) => t.replace(/[\u2018\u2019\u201a\u2032]/g, "'").replace(/[\u201c\u201d\u201e\u2033]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/\u2026/g, '...').replace(/\u00a0/g, ' '),
  },
  { id: 'invisible', label: 'Remove invisible characters', group: 'Clean up', run: (t) => t.replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, '').replace(/\u00a0/g, ' ') },
  {
    id: 'stripHtml',
    label: 'Strip HTML tags',
    group: 'Clean up',
    run: (t) =>
      t
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
        .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e.toLowerCase()] ?? m))),
  },
  { id: 'stripAnsi', label: 'Remove terminal colors', group: 'Clean up', run: (t) => t.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '') },
  { id: 'lineEndings', label: 'Use Windows line endings (CRLF)', group: 'Clean up', flag: 'Unix (LF) instead', run: (t, s) => (s.flag ? t.replace(/\r\n?/g, '\n') : lines(t).join('\r\n')) },

  // Lines
  {
    id: 'dedupe',
    label: 'Remove duplicate lines',
    group: 'Lines',
    flag: 'Ignore case',
    run: (t, s) => {
      const seen = new Set<string>();
      return lines(t)
        .filter((l) => {
          const k = s.flag ? l.toLowerCase() : l;
          return seen.has(k) ? false : (seen.add(k), true);
        })
        .join('\n');
    },
  },
  { id: 'sort', label: 'Sort lines', group: 'Lines', flag: 'Z to A', run: (t, s) => lines(t).sort((x, y) => (s.flag ? -1 : 1) * collator.compare(x, y)).join('\n') },
  { id: 'reverse', label: 'Reverse line order', group: 'Lines', run: (t) => lines(t).reverse().join('\n') },
  { id: 'numberLines', label: 'Number the lines', group: 'Lines', a: { label: 'After the number', placeholder: '. ' }, run: (t, s) => lines(t).map((l, i) => `${i + 1}${s.a === undefined ? '. ' : unescapeArg(s.a)}${l}`).join('\n') },
  { id: 'wrapLines', label: 'Add text around each line', group: 'Lines', a: { label: 'Before', placeholder: '"' }, b: { label: 'After', placeholder: '",' }, run: (t, s) => lines(t).map((l) => `${unescapeArg(s.a)}${l}${unescapeArg(s.b)}`).join('\n') },
  { id: 'join', label: 'Join lines into one', group: 'Lines', a: { label: 'Separator', placeholder: ', ' }, run: (t, s) => lines(t).join(s.a === undefined ? ', ' : unescapeArg(s.a)) },
  { id: 'split', label: 'Split into lines', group: 'Lines', a: { label: 'Split on', placeholder: ',' }, run: (t, s) => t.split(unescapeArg(s.a) || ',').map((x) => x.trim()).join('\n') },
  { id: 'keep', label: 'Keep lines containing', group: 'Lines', a: { label: 'Text', placeholder: 'error' }, flag: 'Regular expression', run: (t, s) => lines(t).filter(matcher(s)).join('\n') },
  { id: 'drop', label: 'Remove lines containing', group: 'Lines', a: { label: 'Text', placeholder: 'debug' }, flag: 'Regular expression', run: (t, s) => lines(t).filter((l) => !matcher(s)(l)).join('\n') },

  // Case
  { id: 'upper', label: 'UPPERCASE', group: 'Case', run: (t) => t.toUpperCase() },
  { id: 'lower', label: 'lowercase', group: 'Case', run: (t) => t.toLowerCase() },
  { id: 'title', label: 'Title Case', group: 'Case', run: (t) => t.toLowerCase().replace(/(^|[\s\-(["'])(\p{L})/gu, (_m, p: string, c: string) => p + c.toUpperCase()) },
  { id: 'sentence', label: 'Sentence case', group: 'Case', run: (t) => t.toLowerCase().replace(/(^\s*|[.!?]\s+)(\p{L})/gu, (_m, p: string, c: string) => p + c.toUpperCase()) },
  { id: 'camel', label: 'camelCase', group: 'Case', run: (t) => lines(t).map((l) => words(l).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('')).join('\n') },
  { id: 'snake', label: 'snake_case', group: 'Case', run: (t) => lines(t).map((l) => words(l).map((w) => w.toLowerCase()).join('_')).join('\n') },
  { id: 'kebab', label: 'kebab-case', group: 'Case', run: (t) => lines(t).map((l) => words(l).map((w) => w.toLowerCase()).join('-')).join('\n') },

  // Find and replace
  {
    id: 'replace',
    label: 'Find and replace',
    group: 'Find and replace',
    a: { label: 'Find', placeholder: 'old' },
    b: { label: 'Replace with', placeholder: 'new' },
    flag: 'Regular expression',
    run: (t, s) => {
      if (!s.a) return t;
      if (s.flag) return t.replace(new RegExp(s.a, 'g'), unescapeArg(s.b));
      return t.split(unescapeArg(s.a)).join(unescapeArg(s.b));
    },
  },
  { id: 'wrap', label: 'Add text before and after', group: 'Find and replace', a: { label: 'Before', placeholder: '@(' }, b: { label: 'After', placeholder: ')' }, run: (t, s) => `${unescapeArg(s.a)}${t}${unescapeArg(s.b)}` },

  // Extract
  { id: 'extract', label: 'Extract matches', group: 'Extract', a: { label: 'Regular expression', placeholder: '\\d+' }, run: (t, s) => (s.a ? [...t.matchAll(new RegExp(s.a, 'g'))].map((m) => m[0]).join('\n') : t) },
  { id: 'emails', label: 'Extract email addresses', group: 'Extract', run: (t) => [...new Set(t.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? [])].join('\n') },
  { id: 'urls', label: 'Extract web addresses', group: 'Extract', run: (t) => [...new Set((t.match(/\bhttps?:\/\/[^\s<>"')\]]+/gi) ?? []).map((u) => u.replace(/[.,;:]+$/, '')))].join('\n') },
  { id: 'ips', label: 'Extract IP addresses', group: 'Extract', run: (t) => [...new Set(t.match(/\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b|\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi) ?? [])].join('\n') },
  { id: 'macs', label: 'Extract MAC addresses', group: 'Extract', run: (t) => [...new Set(t.match(/\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b|\b[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}\b/gi) ?? [])].join('\n') },
  { id: 'numbers', label: 'Extract numbers', group: 'Extract', run: (t) => (t.match(/-?\d+(?:[.,]\d+)*/g) ?? []).join('\n') },

  // Encode and format
  { id: 'jsonPretty', label: 'Format JSON', group: 'Encode and format', run: (t) => JSON.stringify(JSON.parse(t), null, 2) },
  { id: 'jsonMinify', label: 'Minify JSON', group: 'Encode and format', run: (t) => JSON.stringify(JSON.parse(t)) },
  { id: 'jsonString', label: 'Turn into a quoted string', group: 'Encode and format', run: (t) => JSON.stringify(t) },
  { id: 'csvTable', label: 'CSV or Excel cells → Markdown table', group: 'Encode and format', run: (t) => {
    const rows = parseCsv(t.trim());
    if (!rows.length) return t;
    const w = Math.max(...rows.map((r) => r.length));
    const esc = (c: string) => c.trim().replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const line = (r: string[]) => `| ${Array.from({ length: w }, (_x, i) => esc(r[i] ?? '')).join(' | ')} |`;
    return [line(rows[0]), `| ${Array.from({ length: w }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
  } },
  { id: 'base64Encode', label: 'Base64 encode', group: 'Encode and format', run: (t) => utf8ToBase64(t) },
  { id: 'base64Decode', label: 'Base64 decode', group: 'Encode and format', run: (t) => base64ToUtf8(t) },
  { id: 'urlEncode', label: 'URL encode', group: 'Encode and format', run: (t) => encodeURIComponent(t) },
  { id: 'urlDecode', label: 'URL decode', group: 'Encode and format', run: (t) => decodeURIComponent(t.replace(/\+/g, ' ')) },
  { id: 'htmlEscape', label: 'Escape for HTML', group: 'Encode and format', run: (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;') },
];

const BY_ID = new Map(TEXT_OPS.map((o) => [o.id, o]));

export function textOp(id: string): TextOp | undefined {
  return BY_ID.get(id);
}

/**
 * Runs the steps in order. A step that fails (bad JSON, a broken regular expression) leaves the text as it was and
 * is reported, so one mistake doesn't wipe out the whole result.
 */
export function applySteps(text: string, steps: TextStep[]): { text: string; errors: Array<{ index: number; message: string }> } {
  const errors: Array<{ index: number; message: string }> = [];
  let out = text;
  steps.forEach((s, index) => {
    const op = BY_ID.get(s.op);
    if (!op) {
      errors.push({ index, message: `Unknown step "${s.op}"` });
      return;
    }
    try {
      out = op.run(out, s);
    } catch (e) {
      errors.push({ index, message: `${op.label}: ${(e as Error).message}` });
    }
  });
  return { text: out, errors };
}
