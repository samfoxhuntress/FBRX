/**
 * The Markdown the agent writes, as blocks the document writers (HTML, PDF, .docx) lay out: headings, paragraphs,
 * lists (nested by indentation), code, quotes, tables and rules; inside them bold, italic, code and links.
 */

export type Inline = { t: 'text'; v: string } | { t: 'bold'; c: Inline[] } | { t: 'italic'; c: Inline[] } | { t: 'code'; v: string } | { t: 'link'; href: string; c: Inline[] };

export type Align = 'left' | 'center' | 'right' | null;

export type Block =
  | { t: 'heading'; level: number; c: Inline[] }
  | { t: 'para'; c: Inline[] }
  | { t: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'quote'; c: Block[] }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][]; align: Align[] }
  | { t: 'hr' };

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));

/** Whether a line starts a block other than a paragraph (so a paragraph ends before it). */
function startsBlock(line: string, next: string | undefined): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || ITEM.test(line) || QUOTE.test(line) || (line.includes('|') && !!next && TABLE_RULE.test(next));
}

export function parseMarkdown(src: string): Block[] {
  return parseLines(src.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
}

function parseLines(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const close = new RegExp(`^\\s{0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      const body: string[] = [];
      for (i++; i < lines.length && !close.test(lines[i]); i++) body.push(lines[i]);
      i++;
      out.push({ t: 'code', lang: fence[2], v: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ t: 'heading', level: heading[1].length, c: parseInline(heading[2]) });
      i++;
      continue;
    }
    // "---" and "* * *" are rules even though they look like list items.
    if (RULE.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && lines[i].trim() && (QUOTE.test(lines[i]) || !startsBlock(lines[i], lines[i + 1])); i++) body.push(lines[i].replace(QUOTE, ''));
      out.push({ t: 'quote', c: parseLines(body) });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      const align = cells(lines[i + 1]).map((c): Align => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
      const head = cells(line).map(parseInline);
      const rows: Inline[][][] = [];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]).map(parseInline));
      out.push({ t: 'table', head, rows, align });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      i = parseList(lines, i, out);
      continue;
    }
    const para: string[] = [];
    for (; i < lines.length && lines[i].trim() && (!para.length || !startsBlock(lines[i], lines[i + 1])); i++) para.push(lines[i]);
    // A line ending in two spaces or a backslash breaks the line; otherwise lines run on.
    out.push({ t: 'para', c: parseInline(para.map((l, n) => (n < para.length - 1 && /( {2,}|\\)$/.test(l) ? `${l.replace(/( {2,}|\\)$/, '').trim()}\n` : `${l.trim()} `)).join('').trim()) });
  }
  return out;
}

/** A list from line i: its items, each with the lines indented under it (nested lists among them). Returns the next line. */
function parseList(lines: string[], i: number, out: Block[]): number {
  const first = ITEM.exec(lines[i])!;
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: Block[][] = [];
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]);
    if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
    const body = [m[3]];
    const inner = indent + m[2].length + 1;
    for (i++; i < lines.length; i++) {
      const l = lines[i];
      const sub = ITEM.exec(l);
      if (!l.trim()) {
        // A blank line inside an item only if what follows is still indented under it.
        const next = lines[i + 1];
        if (next && next.search(/\S/) >= inner) {
          body.push('');
          continue;
        }
        break;
      }
      if (sub && sub[1].length <= indent) break;
      const lead = l.search(/\S/);
      if (lead >= inner || (sub && sub[1].length > indent)) body.push(l.slice(Math.min(lead, inner)));
      else if (!startsBlock(l, lines[i + 1])) body.push(l.trim());
      else break;
    }
    items.push(parseLines(body));
  }
  out.push({ t: 'list', ordered, start: ordered ? parseInt(first[2], 10) : 1, items });
  return i;
}

/** Inline Markdown: `code`, **bold**, *italic*, [links](url) and <https://autolinks>, with \ escapes. */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const push = (x: Inline) => {
    if (text) out.push({ t: 'text', v: text });
    text = '';
    out.push(x);
  };
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    let m: RegExpExecArray | null;
    if (rest[0] === '\\' && /^[\\`*_{}[\]()#+\-.!|>~]/.test(rest.slice(1))) {
      text += rest[1];
      i += 2;
    } else if ((m = /^(`+)([\s\S]+?)\1(?!`)/.exec(rest))) {
      push({ t: 'code', v: m[2].trim() });
      i += m[0].length;
    } else if ((m = /^(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\1/.exec(rest))) {
      push({ t: 'bold', c: parseInline(m[2]) });
      i += m[0].length;
    } else if ((m = /^\*(?=\S)((?:\*\*[\s\S]+?\*\*|[^*])+?)(?<=\S)\*(?!\*)/.exec(rest)) || (!/\w/.test(s[i - 1] ?? '') && (m = /^_(?=\S)([^_]+?)(?<=\S)_(?!\w)/.exec(rest)))) {
      push({ t: 'italic', c: parseInline(m[1]) });
      i += m[0].length;
    } else if ((m = /^!?\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest))) {
      push({ t: 'link', href: m[2], c: parseInline(m[1] || m[2]) });
      i += m[0].length;
    } else if ((m = /^<(https?:\/\/[^>\s]+)>/.exec(rest))) {
      push({ t: 'link', href: m[1], c: [{ t: 'text', v: m[1] }] });
      i += m[0].length;
    } else if ((m = /^~~([\s\S]+?)~~/.exec(rest))) {
      text += m[1];
      i += m[0].length;
    } else {
      text += rest[0];
      i++;
    }
  }
  if (text) out.push({ t: 'text', v: text });
  return out;
}

/** The plain text of inline content. */
export function inlineText(c: Inline[]): string {
  return c.map((x) => (x.t === 'text' || x.t === 'code' ? x.v : inlineText(x.c))).join('');
}

/** Whether a link may be followed from a document: web and mail links only. */
export function safeHref(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href.trim());
}
