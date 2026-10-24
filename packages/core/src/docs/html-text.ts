const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥' };

/** Decodes the HTML entities text commonly carries (named ones above, and numeric ones). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** A web page's readable text: scripts, styles and markup gone, block elements on their own lines. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(br|p|div|li|h[1-6]|tr|section|article|header|footer|table|ul|ol|blockquote|pre)[^>]*>/gi, '\n')
      .replace(/<(td|th)[^>]*>/gi, '\t')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t ]+\n/g, '\n')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** A page's title, when it has one. */
export function htmlTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() || null : null;
}

/** A page's links with their text, made absolute against the page's address; duplicates and page anchors left out. */
export function htmlLinks(html: string, base: string): Array<{ text: string; url: string }> {
  const out: Array<{ text: string; url: string }> = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) continue;
    let url: string;
    try {
      url = new URL(decodeEntities(href), base).toString();
    } catch {
      continue;
    }
    const text = htmlToText(m[4]).replace(/\s+/g, ' ').trim();
    if (!text || seen.has(url)) continue;
    seen.add(url);
    out.push({ text: text.slice(0, 200), url });
  }
  return out;
}
