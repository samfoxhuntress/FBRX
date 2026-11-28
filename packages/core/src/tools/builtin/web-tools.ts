import type { Settings } from '@fbrx/shared';
import type { ToolSpec } from '../types';
import type { UrlCheck } from '../../governance/network-guard';
import { decodeEntities, htmlLinks, htmlTitle, htmlToText } from '../../docs/html-text';
import { extractText } from '../../docs/extract';
import { truncate } from '../../util/misc';
import { guardedFetch } from './net-tools';

export interface WebToolDeps {
  checkUrl: (url: string) => Promise<UrlCheck>;
  search: () => Settings['ai']['webSearch'];
  appVersion: string;
}

/** The public search page the agent uses unless an organization runs its own search (SearXNG). */
const PUBLIC_SEARCH = 'https://html.duckduckgo.com/html/';
/** Delayed quotes, as CSV, from a free public source. */
const QUOTES = 'https://stooq.com/q/l/';

/** Currency codes that make a pair such as EURUSD. */
const CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'CNY', 'HKD', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'ZAR', 'SGD', 'KRW', 'TRY', 'BTC', 'ETH']);

/** A ticker as the quote source names it: US stocks get .us (BRK.B → brk-b.us), indexes and currency pairs stay. */
export function quoteSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  if (s.startsWith('^')) return s.toLowerCase();
  if (/^[A-Z]{6}$/.test(s) && CURRENCIES.has(s.slice(0, 3)) && CURRENCIES.has(s.slice(3))) return s.toLowerCase();
  if (/^[A-Z]{1,6}\.[A-Z]$/.test(s)) return `${s.replace('.', '-').toLowerCase()}.us`;
  return (s.includes('.') ? s : `${s}.US`).toLowerCase();
}

/** Search results from the public search page's HTML: title, address and snippet (ads left out). */
export function publicResults(html: string): Array<{ title: string; url: string; snippet: string }> {
  const out: Array<{ title: string; url: string; snippet: string }> = [];
  const anchors = [...html.matchAll(/<a\b([^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/g)];
  anchors.forEach((a, n) => {
    const href = decodeEntities(/\bhref="([^"]+)"/.exec(a[1])?.[1] ?? '');
    const target = /[?&]uddg=([^&]+)/.exec(href);
    const url = target ? decodeURIComponent(target[1]) : href.startsWith('//') ? `https:${href}` : href;
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) return;
    const until = anchors[n + 1]?.index ?? html.length;
    const snippet = /class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/.exec(html.slice(a.index!, until))?.[1] ?? '';
    out.push({ title: htmlToText(a[2]).replace(/\s+/g, ' ').trim(), url, snippet: htmlToText(snippet).replace(/\s+/g, ' ').trim() });
  });
  return out;
}

export function webTools(d: WebToolDeps): ToolSpec[] {
  const headers = { 'user-agent': `Mozilla/5.0 (compatible; FBRX/${d.appVersion})`, accept: 'text/html,application/xhtml+xml,application/json,application/pdf;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.8' };
  const searchUrl = () => {
    const s = d.search();
    return s.engine === 'searxng' && s.url ? `${s.url.replace(/\/+$/, '')}/search` : PUBLIC_SEARCH;
  };
  return [
    {
      name: 'web.read',
      title: 'Read web page',
      description:
        'Open a web page and read it: its title, its text, and its links (numbered, with their addresses) to follow them or to list what the page offers, such as classified ads, products or articles. PDFs on the web are read too. ' +
        'For something that changes (prices, listings), read the page itself rather than guessing.',
      risk: 'network',
      source: 'builtin',
      sourceId: null,
      timeoutMs: 60_000,
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          links: { type: 'boolean', default: true, description: 'List the page’s links' },
          maxChars: { type: 'integer', minimum: 2000, maximum: 60000, default: 20000 },
        },
        required: ['url'],
      },
      resources: (i) => ({ urls: [i.url] }),
      async run(i, ctx) {
        const r = await guardedFetch(i.url, { headers, signal: ctx.signal, maxBytes: 15_000_000 }, d.checkUrl);
        if (r.status >= 400) throw new Error(`The page answered ${r.status}${r.status === 403 || r.status === 429 ? ' (the site turns automated visitors away)' : ''}`);
        const type = r.headers['content-type'] ?? '';
        const max = i.maxChars ?? 20_000;
        if (type.includes('pdf') || /\.pdf($|\?)/i.test(r.finalUrl)) {
          const pdf = await extractText('page.pdf', 'document', r.bytes);
          return { output: `${r.finalUrl} (PDF${pdf.pages ? `, ${pdf.pages} pages` : ''})\n\n${truncate(pdf.text ?? pdf.note ?? '', max)}`, data: { url: r.finalUrl } };
        }
        if (type.includes('json')) {
          let text = r.body;
          try {
            text = JSON.stringify(JSON.parse(r.body), null, 2);
          } catch {
            /* not JSON after all: as it came */
          }
          return { output: `${r.finalUrl}\n\n${truncate(text, max)}`, data: { url: r.finalUrl } };
        }
        if (!type.includes('html')) return { output: `${r.finalUrl}\n\n${truncate(r.body, max)}`, data: { url: r.finalUrl } };
        const title = htmlTitle(r.body);
        const links = i.links === false ? [] : htmlLinks(r.body, r.finalUrl).slice(0, 120);
        const listed = links.length ? `\n\nLinks:\n${links.map((l, n) => `[${n + 1}] ${l.text} — ${l.url}`).join('\n')}` : '';
        const text = htmlToText(r.body);
        return {
          output: `${title ? `${title}\n` : ''}${r.finalUrl}\n\n${truncate(text, Math.max(1000, max - listed.length))}${truncate(listed, Math.floor(max / 2))}${r.truncated ? '\n[the page was cut off at 15 MB]' : ''}`,
          data: { url: r.finalUrl, title, links: links.length },
        };
      },
    },
    {
      name: 'web.search',
      title: 'Search the web',
      description: 'Search the web and get the top results: title, address and a snippet of each. Open a result with web.read for the details.',
      risk: 'network',
      source: 'builtin',
      sourceId: null,
      timeoutMs: 45_000,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 400 },
          max: { type: 'integer', minimum: 1, maximum: 15, default: 8 },
        },
        required: ['query'],
      },
      // A SearXNG server is set up by the person or their organization, like an AI provider, so it may be on the local
      // network; the public search page is checked against the network policy like any address.
      resources: () => (d.search().engine === 'searxng' && d.search().url ? {} : { urls: [PUBLIC_SEARCH] }),
      async run(i, ctx) {
        const searxng = d.search().engine === 'searxng' && !!d.search().url;
        const url = `${searchUrl()}?q=${encodeURIComponent(i.query)}${searxng ? '&format=json' : ''}`;
        const r = await guardedFetch(url, { headers, signal: ctx.signal }, searxng ? async () => ({ ok: true }) : d.checkUrl);
        if (r.status >= 400) throw new Error(`The search answered ${r.status}${searxng && r.status === 403 ? ' (turn on the json format in the SearXNG server’s settings)' : ''}`);
        const results = searxng
          ? ((JSON.parse(r.body) as { results?: Array<{ title?: string; url?: string; content?: string }> }).results ?? []).map((x) => ({ title: x.title ?? '', url: x.url ?? '', snippet: x.content ?? '' }))
          : publicResults(r.body);
        const top = results.filter((x) => x.url).slice(0, i.max ?? 8);
        if (!top.length) return { output: `No results for “${i.query}”.`, data: { results: [] } };
        return { output: top.map((x, n) => `${n + 1}. ${x.title}\n   ${x.url}${x.snippet ? `\n   ${x.snippet}` : ''}`).join('\n'), data: { results: top } };
      },
    },
    {
      name: 'finance.quote',
      title: 'Stock quotes',
      description:
        'Latest prices for stocks, funds, indexes and currency pairs by ticker (AAPL, MSFT, ^SPX, EURUSD; other markets with their suffix, such as VOD.UK or 7203.JP). Quotes are delayed. ' +
        'When you report them, say they are delayed and are not investment advice.',
      risk: 'network',
      source: 'builtin',
      sourceId: null,
      timeoutMs: 30_000,
      inputSchema: {
        type: 'object',
        properties: { symbols: { type: 'array', items: { type: 'string', maxLength: 20 }, minItems: 1, maxItems: 20 } },
        required: ['symbols'],
      },
      resources: () => ({ urls: [QUOTES] }),
      async run(i, ctx) {
        const symbols = (i.symbols as string[]).map(quoteSymbol);
        const r = await guardedFetch(`${QUOTES}?s=${symbols.map(encodeURIComponent).join(',')}&f=sd2t2ohlcvn&h&e=csv`, { headers, signal: ctx.signal }, d.checkUrl);
        if (r.status >= 400) throw new Error(`The quote source answered ${r.status}`);
        const rows = r.body
          .trim()
          .split(/\r?\n/)
          .slice(1)
          .map((line) => line.split(','));
        const quotes = rows.map(([symbol, date, time, open, high, low, close, volume, ...name], n) => {
          const asked = (i.symbols as string[])[n] ?? symbol;
          if (!close || close === 'N/D') return { symbol: asked, found: false as const };
          const change = Number(open) ? ((Number(close) - Number(open)) / Number(open)) * 100 : null;
          return { symbol: asked, found: true as const, name: name.join(',').trim(), price: Number(close), open: Number(open), high: Number(high), low: Number(low), volume: Number(volume) || null, changeSinceOpen: change, at: `${date} ${time}` };
        });
        const lines = quotes.map((q) =>
          q.found
            ? `${q.symbol.toUpperCase()}${q.name ? ` (${q.name})` : ''}: ${q.price}${q.changeSinceOpen === null ? '' : ` (${q.changeSinceOpen >= 0 ? '+' : ''}${q.changeSinceOpen.toFixed(2)}% since the open at ${q.open})`}, day range ${q.low}–${q.high}, as of ${q.at}`
            : `${q.symbol.toUpperCase()}: no quote found (check the ticker and its market suffix)`,
        );
        return { output: `Delayed quotes, not investment advice:\n${lines.join('\n')}`, data: { quotes } };
      },
    },
  ];
}
