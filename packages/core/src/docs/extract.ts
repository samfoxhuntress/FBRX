import { fileExtension, type AttachmentKind } from '@fbrx/shared';
import { zipEntries } from '@fbrx/shared/node';
import { decodeEntities } from './html-text';

/** The most text kept from one file; the AI reads from the start, and the whole file stays where it is. */
export const MAX_EXTRACTED_CHARS = 400_000;
/** Spreadsheets: rows read per sheet. */
const MAX_SHEET_ROWS = 2000;

export interface Extracted {
  text: string | null;
  /** Pages, slides or sheets. */
  pages: number | null;
  /** Why there is no text, or that it was cut short. */
  note: string | null;
}

const none = (note: string | null): Extracted => ({ text: null, pages: null, note });

/** Reads the text out of an attached file: plain text as it is, and the words of PDF and office documents. */
export async function extractText(name: string, kind: AttachmentKind, data: Buffer): Promise<Extracted> {
  if (kind === 'image' || kind === 'file') return none(null);
  try {
    const r = kind === 'text' ? plainText(data) : await documentText(fileExtension(name), data);
    if (r.text && r.text.length > MAX_EXTRACTED_CHARS) {
      return { ...r, text: r.text.slice(0, MAX_EXTRACTED_CHARS), note: `Only the first ${MAX_EXTRACTED_CHARS.toLocaleString('en-US')} characters were read.` };
    }
    return r;
  } catch (err) {
    const msg = (err as Error).message ?? '';
    return none(/password/i.test(msg) ? 'This document is protected with a password, so its text could not be read.' : `Its text could not be read (${msg.slice(0, 160)}).`);
  }
}

function plainText(data: Buffer): Extracted {
  if (data.subarray(0, 8192).includes(0)) return none('This file is not text.');
  return { text: data.toString('utf8').replace(/^﻿/, ''), pages: null, note: null };
}

async function documentText(ext: string, data: Buffer): Promise<Extracted> {
  switch (ext) {
    case 'pdf':
      return pdfText(data);
    case 'docx':
      return { text: docxText(entry(data, 'word/document.xml')), pages: null, note: null };
    case 'pptx':
      return pptxText(data);
    case 'xlsx':
      return xlsxText(data);
    case 'odt':
    case 'odp':
    case 'ods':
      return odfText(entry(data, 'content.xml'));
    default:
      return none(null);
  }
}

/** One file inside an office document (a ZIP archive), as text. */
function entry(data: Buffer, name: string): string {
  const e = zipEntries(data).find((x) => x.name === name);
  if (!e) throw new Error(`${name} is missing`);
  return e.data().toString('utf8');
}

async function pdfText(data: Buffer): Promise<Extracted> {
  const { extractText: pdfPages, getDocumentProxy } = await import('unpdf');
  const doc = await getDocumentProxy(new Uint8Array(data));
  const { totalPages, text } = await pdfPages(doc, { mergePages: false });
  const pages = (text as string[]).map((t) => t.replace(/[ \t]+\n/g, '\n').trim());
  if (!pages.some(Boolean)) return { text: null, pages: totalPages, note: 'No text in this PDF: its pages may be scans (pictures of text).' };
  return { text: pages.map((t, i) => `--- Page ${i + 1} ---\n${t}`).join('\n\n'), pages: totalPages, note: null };
}

/** The text of a run of WordprocessingML (tabs and line breaks kept). */
function wordRuns(xml: string): string {
  const runs = xml.replace(/<w:tab\/>/g, '<w:t>\t</w:t>').replace(/<w:(?:br|cr)\/>/g, '<w:t>\n</w:t>');
  return decodeEntities([...runs.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(''));
}

/** A .docx document's text: headings marked with #, list items with -, table rows as | cells |. */
export function docxText(xml: string): string {
  const body = xml.replace(/<w:tr[\s>][\s\S]*?<\/w:tr>/g, (row) => {
    const cells = [...row.matchAll(/<w:tc[\s>][\s\S]*?<\/w:tc>/g)].map((c) => wordRuns(c[0]).replace(/\s+/g, ' ').trim());
    return `<w:p><w:r><w:t>| ${cells.join(' | ')} |</w:t></w:r></w:p>`;
  });
  const lines: string[] = [];
  for (const p of body.split(/<\/w:p>/)) {
    const text = wordRuns(p).trimEnd();
    if (!text.trim()) {
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
      continue;
    }
    const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? '';
    const level = /^Title$/i.test(style) ? 1 : Number(/^heading ?(\d)$/i.exec(style)?.[1] ?? 0);
    if (level) lines.push(`${'#'.repeat(Math.min(level, 6))} ${text.trim()}`);
    else if (/<w:numPr>/.test(p)) lines.push(`- ${text.trim()}`);
    else lines.push(text);
  }
  return lines.join('\n').trim();
}

function pptxText(data: Buffer): Extracted {
  const slides = zipEntries(data)
    .map((e) => ({ e, n: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(e.name)?.[1] ?? 0) }))
    .filter((s) => s.n > 0)
    .sort((a, b) => a.n - b.n);
  const text = slides
    .map(({ e, n }) => {
      const xml = e.data().toString('utf8');
      const paras = xml
        .split(/<\/a:p>/)
        .map((p) => decodeEntities([...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join('')).trim())
        .filter(Boolean);
      return `## Slide ${n}\n${paras.join('\n')}`;
    })
    .join('\n\n');
  return { text, pages: slides.length, note: null };
}

/** A spreadsheet column ("B", "AA") as a number from 0. */
function columnIndex(ref: string): number {
  let n = 0;
  for (const c of /^[A-Z]+/.exec(ref)?.[0] ?? 'A') n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function xlsxText(data: Buffer): Extracted {
  const files = new Map(zipEntries(data).map((e) => [e.name, e]));
  const read = (name: string) => files.get(name)?.data().toString('utf8') ?? '';
  const shared = [...read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => decodeEntities([...m[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join('')));
  const targets = new Map([...read('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)].map((m) => [m[1], m[2].replace(/^\/?(xl\/)?/, 'xl/')]));
  const sheets = [...read('xl/workbook.xml').matchAll(/<sheet\b[^>]*\bname="([^"]*)"[^>]*\br:id="([^"]+)"/g)].map((m) => ({ name: decodeEntities(m[1]), file: targets.get(m[2]) ?? '' }));
  let cut = false;
  const text = sheets
    .map((s) => {
      const rows: string[] = [];
      for (const row of read(s.file).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
        if (rows.length >= MAX_SHEET_ROWS) {
          cut = true;
          break;
        }
        const cells: string[] = [];
        for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = c[1];
          const body = c[2] ?? '';
          const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
          const v = /<v>([^<]*)<\/v>/.exec(body)?.[1] ?? '';
          const value = type === 's' ? (shared[Number(v)] ?? '') : type === 'inlineStr' ? decodeEntities([...body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join('')) : type === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : decodeEntities(v);
          const col = columnIndex(/\br="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? String.fromCharCode(65 + cells.length));
          while (cells.length < col) cells.push('');
          cells[col] = csvCell(value);
        }
        rows.push(cells.join(','));
      }
      return `## Sheet: ${s.name}\n${rows.join('\n')}`;
    })
    .join('\n\n');
  return { text, pages: sheets.length, note: cut ? `Only the first ${MAX_SHEET_ROWS} rows of each sheet were read.` : null };
}

/** OpenDocument text, presentations and spreadsheets (content.xml). */
function odfText(xml: string): Extracted {
  const sheets = [...xml.matchAll(/<table:table\b[^>]*table:name="([^"]*)"/g)].length;
  const text = decodeEntities(
    xml
      .replace(/<table:table\b[^>]*table:name="([^"]*)"[^>]*>/g, '\n## $1\n')
      .replace(/<text:tab\/>/g, '\t')
      .replace(/<text:line-break\/>/g, '\n')
      .replace(/<text:s(?:\s[^>]*)?\/>/g, ' ')
      .replace(/<\/table:table-cell>/g, '\t')
      .replace(/<\/(text:p|text:h|table:table-row)>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\t+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, pages: sheets || null, note: null };
}
