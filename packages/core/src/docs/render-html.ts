import { inlineText, safeHref, type Block, type Inline } from './markdown';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(c: Inline[]): string {
  return c
    .map((x) => {
      switch (x.t) {
        case 'text':
          return esc(x.v).replace(/\n/g, '<br>');
        case 'code':
          return `<code>${esc(x.v)}</code>`;
        case 'bold':
          return `<strong>${inline(x.c)}</strong>`;
        case 'italic':
          return `<em>${inline(x.c)}</em>`;
        case 'link':
          return safeHref(x.href) ? `<a href="${esc(x.href)}">${inline(x.c)}</a>` : inline(x.c);
      }
    })
    .join('');
}

function blocks(list: Block[]): string {
  return list
    .map((b) => {
      switch (b.t) {
        case 'heading':
          return `<h${b.level}>${inline(b.c)}</h${b.level}>`;
        case 'para':
          return `<p>${inline(b.c)}</p>`;
        case 'list': {
          const tag = b.ordered ? 'ol' : 'ul';
          const start = b.ordered && b.start !== 1 ? ` start="${b.start}"` : '';
          // An item's first paragraph is written without the <p>, so lists stay tight.
          const item = (c: Block[]) => (c[0]?.t === 'para' ? inline(c[0].c) + blocks(c.slice(1)) : blocks(c));
          return `<${tag}${start}>${b.items.map((c) => `<li>${item(c)}</li>`).join('')}</${tag}>`;
        }
        case 'code':
          return `<pre><code>${esc(b.v)}</code></pre>`;
        case 'quote':
          return `<blockquote>${blocks(b.c)}</blockquote>`;
        case 'table': {
          const cell = (tag: 'th' | 'td', c: Inline[], n: number) => `<${tag}${b.align[n] ? ` style="text-align:${b.align[n]}"` : ''}>${inline(c)}</${tag}>`;
          const head = `<thead><tr>${b.head.map((c, n) => cell('th', c, n)).join('')}</tr></thead>`;
          return `<table>${head}<tbody>${b.rows.map((r) => `<tr>${r.map((c, n) => cell('td', c, n)).join('')}</tr>`).join('')}</tbody></table>`;
        }
        case 'hr':
          return '<hr>';
      }
    })
    .join('\n');
}

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; background: #fff; color: #1b1a17; font: 15px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; }
article { max-width: 760px; margin: 0 auto; padding: 48px 32px 64px; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.6em 0 0.5em; font-weight: 700; }
h1 { font-size: 2em; margin-top: 0; letter-spacing: -0.01em; }
h2 { font-size: 1.45em; padding-bottom: 0.2em; border-bottom: 1px solid #e7e2d9; }
h3 { font-size: 1.2em; }
h4, h5, h6 { font-size: 1em; }
p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
ul, ol { padding-left: 1.6em; }
li { margin: 0.2em 0; }
li > ul, li > ol { margin: 0.2em 0; }
a { color: #a5630c; }
code { font: 0.9em ui-monospace, "SF Mono", Menlo, Consolas, monospace; background: #f4f0e8; padding: 0.1em 0.35em; border-radius: 4px; }
pre { background: #f6f3ee; border: 1px solid #e7e2d9; border-radius: 8px; padding: 12px 14px; overflow-x: auto; }
pre code { background: none; padding: 0; font-size: 0.85em; line-height: 1.5; }
blockquote { margin-left: 0; padding: 0.6em 1em; border-left: 4px solid #e2b04a; color: #554f45; background: #fbf8f2; }
blockquote > :last-child, li > :last-child { margin-bottom: 0; }
table { border-collapse: collapse; width: 100%; font-size: 0.95em; }
th, td { border: 1px solid #ddd6ca; padding: 6px 10px; vertical-align: top; text-align: left; }
th { background: #f4f0e8; font-weight: 650; }
tr:nth-child(even) td { background: #fcfaf6; }
hr { border: 0; border-top: 1px solid #e7e2d9; margin: 2em 0; }
@page { margin: 18mm 16mm; }
@media print { article { padding: 0; max-width: none; } a { color: inherit; } pre, table, blockquote { break-inside: avoid; } h1, h2, h3 { break-after: avoid; } }
`;

/** Whether the document starts with its own title (a level-1 heading), so none is added above it. */
export function hasOwnTitle(list: Block[]): boolean {
  return list[0]?.t === 'heading' && list[0].level === 1;
}

/** A complete, self-contained web page for a Markdown document (no scripts, nothing loaded from elsewhere). */
export function renderHtml(title: string, list: Block[]): string {
  const top = hasOwnTitle(list) ? '' : `<h1>${esc(title)}</h1>\n`;
  const name = hasOwnTitle(list) ? inlineText((list[0] as Extract<Block, { t: 'heading' }>).c) : title;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="FBRX">
<title>${esc(name)}</title>
<style>${STYLE}</style>
</head>
<body>
<article>
${top}${blocks(list)}
</article>
</body>
</html>
`;
}
