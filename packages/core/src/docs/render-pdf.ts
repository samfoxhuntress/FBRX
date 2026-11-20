import { deflateSync } from 'node:zlib';
import { inlineText, safeHref, type Block, type Inline } from './markdown';
import { hasOwnTitle } from './render-html';

/**
 * A PDF from Markdown blocks with PDF's standard fonts (Helvetica and Courier), for when no browser engine is at hand
 * (FBRX on a server). The desktop app prints the HTML version instead, which also covers every script and emoji;
 * here text outside Western European characters is simplified or left out.
 */

type FontKey = 'R' | 'B' | 'I' | 'BI' | 'M';
const FONT_NAMES: Record<FontKey, string> = { R: 'Helvetica', B: 'Helvetica-Bold', I: 'Helvetica-Oblique', BI: 'Helvetica-BoldOblique', M: 'Courier' };
const FONT_IDS: Record<FontKey, string> = { R: 'F1', B: 'F2', I: 'F3', BI: 'F4', M: 'F5' };

/** Advance widths of ASCII 32–126 in thousandths of an em (Adobe's metrics for Helvetica and Helvetica-Bold). */
const HELVETICA = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELVETICA_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
/** Widths of the WinAnsi characters past ASCII that documents use most. */
const EXTRA: Record<number, number> = { 0x80: 556, 0x85: 1000, 0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333, 0x95: 350, 0x96: 556, 0x97: 1000, 0x99: 1000, 0xa0: 278, 0xa9: 737, 0xae: 737, 0xb0: 400, 0xd7: 584, 0xf7: 584 };

/** Unicode characters that have a WinAnsi code of their own (the rest of Latin-1 keeps its code). */
const WIN_ANSI: Record<string, number> = { '€': 0x80, '‚': 0x82, ƒ: 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, ˆ: 0x88, '‰': 0x89, Š: 0x8a, '‹': 0x8b, Œ: 0x8c, Ž: 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, š: 0x9a, '›': 0x9b, œ: 0x9c, ž: 0x9e, Ÿ: 0x9f };
/** Symbols the standard fonts lack, written another way. */
const SUBSTITUTES: Record<string, string> = { '→': '->', '←': '<-', '⇒': '=>', '≤': '<=', '≥': '>=', '≠': '!=', '−': '-', '✓': 'v', '✔': 'v', '✗': 'x', '✘': 'x', '★': '*', '☆': '*', ' ': ' ', ' ': ' ', '​': '' };

function encode(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if ((c >= 32 && c <= 126) || (c >= 0xa0 && c <= 0xff)) out.push(c);
    else if (WIN_ANSI[ch]) out.push(WIN_ANSI[ch]);
    else if (SUBSTITUTES[ch] !== undefined) out.push(...encode(SUBSTITUTES[ch]));
    else {
      // Accented letters lose their accents (ł stays as ?); emoji and pictographs are left out.
      const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
      if (base && base !== ch && [...base].every((b) => b.codePointAt(0)! < 0x100)) out.push(...encode(base));
      else if (c < 0x2000) out.push(63);
    }
  }
  return out;
}

function width(codes: number[], font: FontKey, size: number): number {
  if (font === 'M') return codes.length * 0.6 * size;
  const table = font === 'B' || font === 'BI' ? HELVETICA_BOLD : HELVETICA;
  return (codes.reduce((n, c) => n + (c >= 32 && c <= 126 ? table[c - 32] : (EXTRA[c] ?? 556)), 0) / 1000) * size;
}

const hex = (codes: number[]) => `<${codes.map((c) => c.toString(16).padStart(2, '0')).join('')}>`;
const PAGE = { w: 612, h: 792, margin: 72 };
const CONTENT = PAGE.w - PAGE.margin * 2;
const INK = '0.106 0.102 0.09';
const MUTED = '0.33 0.31 0.27';
const LINK = '0.65 0.39 0.05';

interface Word {
  codes: number[];
  font: FontKey;
  /** A space comes before it (on the same line). */
  space: boolean;
  /** A line break comes before it. */
  breakBefore: boolean;
  href: string | null;
}

/** Inline content as words, each with its font, and where spaces and line breaks were. */
function words(c: Inline[], base: FontKey = 'R'): Word[] {
  const out: Word[] = [];
  let pendingSpace = false;
  let pendingBreak = false;
  const walk = (list: Inline[], bold: boolean, italic: boolean, href: string | null) => {
    for (const i of list) {
      if (i.t === 'bold') walk(i.c, true, italic, href);
      else if (i.t === 'italic') walk(i.c, bold, true, href);
      else if (i.t === 'link') walk(i.c, bold, italic, safeHref(i.href) ? i.href : null);
      else {
        const font: FontKey = i.t === 'code' || base === 'M' ? 'M' : bold || base === 'B' ? (italic ? 'BI' : 'B') : italic || base === 'I' ? 'I' : 'R';
        for (const part of i.v.split(/(\n|\s+)/)) {
          if (part === '\n') pendingBreak = true;
          else if (/^\s+$/.test(part)) pendingSpace = true;
          else if (part) {
            out.push({ codes: encode(part), font, space: pendingSpace && out.length > 0, breakBefore: pendingBreak, href });
            pendingSpace = false;
            pendingBreak = false;
          }
        }
      }
    }
  };
  walk(c, false, false, null);
  return out;
}

/** Words broken into lines no wider than `max`; a word wider than a line is cut. */
function lines(list: Word[], size: number, max: number): Word[][] {
  const out: Word[][] = [[]];
  let used = 0;
  for (const w of list) {
    let ww = width(w.codes, w.font, size);
    const sp = w.space ? width([32], w.font, size) : 0;
    let cur = out[out.length - 1];
    if (w.breakBefore || (cur.length && used + sp + ww > max)) {
      out.push((cur = []));
      used = 0;
    }
    let word = { ...w, space: cur.length > 0 && w.space };
    while (ww > max && word.codes.length > 1) {
      // Cut a long word (a web address) where it fills the line.
      let n = word.codes.length;
      while (n > 1 && width(word.codes.slice(0, n), word.font, size) > max - used) n--;
      cur.push({ ...word, codes: word.codes.slice(0, n) });
      out.push((cur = []));
      used = 0;
      word = { ...word, codes: word.codes.slice(n), space: false };
      ww = width(word.codes, word.font, size);
    }
    cur.push(word);
    used += (word.space ? sp : 0) + ww;
  }
  return out.filter((l, i) => l.length || i === 0);
}

class PdfLayout {
  readonly pages: Array<{ ops: string[]; links: Array<{ rect: number[]; href: string }> }> = [];
  private y = 0;

  constructor() {
    this.newPage();
  }

  private get page() {
    return this.pages[this.pages.length - 1];
  }

  private newPage() {
    this.pages.push({ ops: [], links: [] });
    this.y = PAGE.h - PAGE.margin;
  }

  /** Makes room for `h` points, starting a new page when this one is full. */
  private room(h: number) {
    if (this.y - h < PAGE.margin) this.newPage();
  }

  gap(h: number) {
    this.y -= h;
  }

  rect(x: number, y: number, w: number, h: number, fill: string) {
    this.page.ops.push(`${fill} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
  }

  /** How wide a laid-out line is. */
  private lineWidth(l: Word[], size: number): number {
    return l.reduce((n, w) => n + (w.space ? width([32], w.font, size) : 0) + width(w.codes, w.font, size), 0);
  }

  private line(l: Word[], x: number, size: number, color: string) {
    let cx = x;
    for (const w of l) {
      if (w.space) cx += width([32], w.font, size);
      const ww = width(w.codes, w.font, size);
      this.page.ops.push(`BT ${w.href ? LINK : color} rg /${FONT_IDS[w.font]} ${size} Tf ${cx.toFixed(2)} ${this.y.toFixed(2)} Td ${hex(w.codes)} Tj ET`);
      if (w.href) this.page.links.push({ rect: [cx, this.y - 2, cx + ww, this.y + size * 0.8], href: w.href });
      cx += ww;
    }
  }

  /** Wrapped text at an indent; `bar` draws a quote's bar beside each line. */
  text(c: Inline[], o: { size: number; lead: number; indent?: number; font?: FontKey; color?: string; marker?: string; bar?: boolean; keep?: number }) {
    const indent = o.indent ?? 0;
    const all = lines(words(c, o.font), o.size, CONTENT - indent);
    this.room(o.lead * Math.min(all.length, o.keep ?? 1));
    all.forEach((l, n) => {
      this.room(o.lead);
      this.y -= o.lead;
      if (o.bar) this.rect(PAGE.margin + indent - 12, this.y - 4, 3, o.lead, '0.886 0.69 0.29');
      if (n === 0 && o.marker) {
        const codes = encode(o.marker);
        this.page.ops.push(`BT ${INK} rg /F1 ${o.size} Tf ${(PAGE.margin + indent - 4 - width(codes, 'R', o.size)).toFixed(2)} ${this.y.toFixed(2)} Td ${hex(codes)} Tj ET`);
      }
      this.line(l, PAGE.margin + indent, o.size, o.color ?? INK);
    });
  }

  code(v: string, indent: number) {
    const size = 9;
    const lead = 12;
    const per = Math.max(10, Math.floor((CONTENT - indent - 16) / (size * 0.6)));
    const rows = v.split('\n').flatMap((l) => (l.length ? (l.match(new RegExp(`.{1,${per}}`, 'g')) ?? ['']) : ['']));
    this.gap(4);
    for (const row of rows) {
      this.room(lead);
      this.y -= lead;
      this.rect(PAGE.margin + indent, this.y - 3.5, CONTENT - indent, lead, '0.965 0.953 0.933');
      this.page.ops.push(`BT ${INK} rg /F5 ${size} Tf ${(PAGE.margin + indent + 8).toFixed(2)} ${this.y.toFixed(2)} Td ${hex(encode(row))} Tj ET`);
    }
    this.gap(8);
  }

  rule() {
    this.room(14);
    this.y -= 10;
    this.page.ops.push(`0.851 0.824 0.773 RG 0.75 w ${PAGE.margin} ${this.y.toFixed(2)} m ${PAGE.w - PAGE.margin} ${this.y.toFixed(2)} l S`);
    this.y -= 10;
  }

  table(b: Extract<Block, { t: 'table' }>) {
    const cols = Math.max(b.head.length, ...b.rows.map((r) => r.length), 1);
    const cw = CONTENT / cols;
    const size = 9.5;
    const lead = 12.5;
    const row = (cells: Inline[][], head: boolean) => {
      const wrapped = Array.from({ length: cols }, (_, n) => lines(words(cells[n] ?? [], head ? 'B' : 'R'), size, cw - 10));
      const h = Math.max(...wrapped.map((l) => l.length)) * lead + 8;
      this.room(h);
      const top = this.y;
      if (head) this.rect(PAGE.margin, top - h, CONTENT, h, '0.957 0.941 0.91');
      wrapped.forEach((ls, n) => {
        this.y = top - 4;
        const align = b.align[n];
        for (const l of ls) {
          this.y -= lead;
          const free = cw - 10 - this.lineWidth(l, size);
          this.line(l, PAGE.margin + n * cw + 5 + (align === 'right' ? free : align === 'center' ? free / 2 : 0), size, INK);
        }
        this.page.ops.push(`0.867 0.839 0.792 RG 0.5 w ${(PAGE.margin + n * cw).toFixed(2)} ${(top - h).toFixed(2)} ${cw.toFixed(2)} ${h.toFixed(2)} re S`);
      });
      this.y = top - h;
    };
    this.gap(4);
    row(b.head, true);
    for (const r of b.rows) row(r, false);
    this.gap(10);
  }

  blocks(list: Block[], indent = 0, quote = false) {
    for (const b of list) {
      const body = { size: 11, lead: 15.5, indent: indent + (quote ? 16 : 0), color: quote ? MUTED : INK, bar: quote };
      switch (b.t) {
        case 'heading': {
          const size = [20, 16, 13.5, 12, 11, 11][b.level - 1];
          this.gap(b.level <= 2 ? 14 : 10);
          this.text(b.c, { size, lead: size * 1.3, indent, font: 'B', keep: 3 });
          this.gap(4);
          break;
        }
        case 'para':
          this.text(b.c, body);
          this.gap(7);
          break;
        case 'code':
          this.code(b.v, indent);
          break;
        case 'quote':
          this.blocks(b.c, indent, true);
          break;
        case 'hr':
          this.rule();
          break;
        case 'table':
          this.table(b);
          break;
        case 'list':
          b.items.forEach((item, n) => {
            const marker = b.ordered ? `${b.start + n}.` : indent ? '–' : '•';
            const [first, ...rest] = item;
            const inner = indent + 18;
            if (first?.t === 'para') this.text(first.c, { ...body, indent: inner + (quote ? 16 : 0), marker });
            this.blocks(first?.t === 'para' ? rest : item, inner, quote);
            this.gap(2);
          });
          // A nested list runs straight on into its parent's next item.
          if (!indent) this.gap(5);
          break;
      }
    }
  }
}

/** PDF text for metadata: plain when it can be, UTF-16 otherwise. */
function pdfString(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;
  return `<FEFF${[...s].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('')}>`;
}

/** A PDF document from Markdown blocks, with its title (added at the top unless the document starts with one). */
export function renderPdf(title: string, list: Block[]): Buffer {
  const layout = new PdfLayout();
  if (!hasOwnTitle(list)) {
    layout.text([{ t: 'text', v: title }], { size: 24, lead: 30, font: 'B' });
    layout.gap(10);
  }
  layout.blocks(list);
  const name = hasOwnTitle(list) ? inlineText((list[0] as Extract<Block, { t: 'heading' }>).c) : title;

  const objects: Array<string | Buffer> = [];
  const add = (o: string | Buffer) => objects.push(o) as number;
  const fontRefs = (Object.keys(FONT_NAMES) as FontKey[]).map((k) => `/${FONT_IDS[k]} ${add(`<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_NAMES[k]} /Encoding /WinAnsiEncoding >>`)} 0 R`).join(' ');
  const pagesId = add('');
  const total = layout.pages.length;
  const kids = layout.pages.map((p, n) => {
    const footer = encode(`${n + 1} / ${total}`);
    const ops = [...p.ops, `BT ${MUTED} rg /F1 8.5 Tf ${((PAGE.w - width(footer, 'R', 8.5)) / 2).toFixed(2)} 40 Td ${hex(footer)} Tj ET`].join('\n');
    const packed = deflateSync(Buffer.from(ops, 'latin1'));
    const content = add(Buffer.concat([Buffer.from(`<< /Length ${packed.length} /Filter /FlateDecode >>\nstream\n`), packed, Buffer.from('\nendstream')]));
    const annots = p.links.map((l) => add(`<< /Type /Annot /Subtype /Link /Rect [${l.rect.map((v) => v.toFixed(2)).join(' ')}] /Border [0 0 0] /A << /S /URI /URI ${pdfString(l.href)} >> >>`));
    return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] /Resources << /Font << ${fontRefs} >> >> /Contents ${content} 0 R${annots.length ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(' ')}]` : ''} >>`);
  });
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const info = add(`<< /Title ${pdfString(name)} /Producer (FBRX) /CreationDate (D:${stamp}Z) >>`);

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = parts[0].length;
  const offsets: number[] = [];
  objects.forEach((o, n) => {
    offsets.push(offset);
    const chunk = Buffer.concat([Buffer.from(`${n + 1} 0 obj\n`), Buffer.isBuffer(o) ? o : Buffer.from(o, 'latin1'), Buffer.from('\nendobj\n')]);
    parts.push(chunk);
    offset += chunk.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}
