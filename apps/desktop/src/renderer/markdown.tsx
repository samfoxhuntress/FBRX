import { memo, type ReactNode } from 'react';
import { openExternal } from './client';

/**
 * Minimal, safe Markdown → React (no HTML injection): code fences, headings, nested lists, tables, quotes, rules,
 * emphasis, links. Memoized: chat threads re-render while text streams in, and parsing every earlier message again
 * would be wasted work.
 */
export const Markdown = memo(function Markdown({ text, codeActions }: { text: string; codeActions?: (code: string, lang: string) => ReactNode }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      const code = (
        <pre key={key++} className="md-code" data-lang={fence[1] || undefined}>
          <code>{body.join('\n')}</code>
        </pre>
      );
      blocks.push(
        codeActions ? (
          <div key={key++} className="md-code-wrap">
            {code}
            <div className="md-code-actions">{codeActions(body.join('\n'), fence[1] ?? '')}</div>
          </div>
        ) : (
          code
        ),
      );
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const Tag = (`h${Math.min(h[1].length + 2, 6)}`) as 'h3';
      blocks.push(<Tag key={key++} className="md-h">{inline(h[2])}</Tag>);
      i++;
      continue;
    }
    if (LIST.test(line)) {
      const [list, next] = parseList(lines, i, key++);
      blocks.push(list);
      i = next;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="md-hr" />);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push(
        <blockquote key={key++} className="md-quote">
          {inline(quote.join('\n'))}
        </blockquote>,
      );
      continue;
    }
    if (isTableStart(lines, i)) {
      const rows: string[][] = [];
      const head = cells(lines[i]);
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      blocks.push(
        <div key={key++} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {head.map((c, n) => (
                  <th key={n}>{inline(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, rn) => (
                <tr key={rn}>
                  {head.map((_h, n) => (
                    <td key={n}>{inline(r[n] ?? '')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^```|^#{1,4}\s|^\s*>/.test(lines[i]) && !LIST.test(lines[i]) && !isTableStart(lines, i)) para.push(lines[i++]);
    blocks.push(<p key={key++}>{inline(para.join('\n'))}</p>);
  }
  return <div className="md">{blocks}</div>;
});

const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;

function indent(line: string): number {
  return /^\s*/.exec(line.replace(/\t/g, '    '))![0].length;
}

/**
 * A list and the lists inside it. Items indented two or more spaces further than the list nest under the item above;
 * blank lines between items keep the list going, so "1. … (blank) 2. …" stays one list; an ordered list keeps the
 * number it starts with.
 */
function parseList(lines: string[], start: number, key: number): [ReactNode, number] {
  const first = LIST.exec(lines[start])!;
  const base = indent(lines[start]);
  const ordered = /\d/.test(first[2]);
  const items: Array<{ text: string; children: ReactNode[] }> = [];
  let i = start;
  let nested = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const m = j < lines.length ? LIST.exec(lines[j]) : null;
      const ind = j < lines.length ? indent(lines[j]) : 0;
      if (m ? ind >= base + 2 || (ind >= base && /\d/.test(m[2]) === ordered) : ind >= base + 2 && items.length > 0) {
        i = j;
        continue;
      }
      break;
    }
    const m = LIST.exec(line);
    const ind = indent(line);
    if (m) {
      if (ind < base) break;
      if (ind >= base + 2 && items.length) {
        const [node, next] = parseList(lines, i, nested++);
        items[items.length - 1].children.push(node);
        i = next;
        continue;
      }
      if (/\d/.test(m[2]) !== ordered) break;
      items.push({ text: m[3], children: [] });
      i++;
      continue;
    }
    // Text under an item: indented, or straight after it with no blank line in between.
    if (items.length && (ind >= base + 2 || (lines[i - 1]?.trim() && !/^```|^#{1,4}\s|^\s*>/.test(line)))) {
      const last = items[items.length - 1];
      if (last.children.length) last.children.push(<p key={`p${nested++}`}>{inline(line.trim())}</p>);
      else last.text += `\n${line.trim()}`;
      i++;
      continue;
    }
    break;
  }
  const lis = items.map((it, n) => (
    <li key={n}>
      {inline(it.text)}
      {it.children}
    </li>
  ));
  const num = ordered ? parseInt(first[2], 10) : 1;
  return [
    ordered ? (
      <ol key={key} start={num !== 1 ? num : undefined}>
        {lis}
      </ol>
    ) : (
      <ul key={key}>{lis}</ul>
    ),
    i,
  ];
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function isTableStart(lines: string[], i: number): boolean {
  return lines[i].includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1]);
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    if (m[1]) out.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else if (m[3]) out.push(<em key={k++}>{t.slice(1, -1)}</em>);
    else if (m[4]) {
      const label = /^\[([^\]]+)\]/.exec(t)![1];
      const url = m[5];
      out.push(
        <a key={k++} href={url} onClick={(e) => (e.preventDefault(), openExternal(url))}>
          {label}
        </a>,
      );
    }
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
