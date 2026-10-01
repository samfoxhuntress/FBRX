import type { ToolSpec } from '../types';
import { truncate } from '../../util/misc';
import type { UrlCheck } from '../../governance/network-guard';

export interface NetDeps {
  checkUrl: (url: string) => Promise<UrlCheck>;
}

const MAX_BODY = 1_000_000;

/** fetch with manual redirects so every hop is re-checked against network policy. */
export async function guardedFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  checkUrl: (u: string) => Promise<UrlCheck>,
): Promise<{ status: number; headers: Record<string, string>; body: string; finalUrl: string; truncated: boolean }> {
  let current = url;
  let method = (init.method ?? 'GET').toUpperCase();
  let body = init.body;
  for (let hop = 0; hop < 6; hop++) {
    const check = await checkUrl(current);
    if (!check.ok) throw new Error(check.reason);
    const res = await fetch(current, { method, headers: init.headers, body: method === 'GET' || method === 'HEAD' ? undefined : body, redirect: 'manual', signal: init.signal });
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
      current = new URL(res.headers.get('location')!, current).toString();
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BODY) {
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
    }
    return { status: res.status, headers, body: Buffer.concat(chunks).toString('utf8'), finalUrl: current, truncated };
  }
  throw new Error('Too many redirects');
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<(br|p|div|li|h[1-6]|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

export function netTools(d: NetDeps): ToolSpec[] {
  return [
    {
      name: 'http.request',
      title: 'HTTP request',
      description: 'Make an HTTP(S) request and return status and body. HTML pages are converted to readable text.',
      risk: 'network',
      source: 'builtin',
      sourceId: null,
      timeoutMs: 60_000,
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], default: 'GET' },
          headers: { type: 'object', additionalProperties: { type: 'string' } },
          body: { type: 'string' },
        },
        required: ['url'],
      },
      resources: (i) => ({ urls: [i.url] }),
      async run(i, ctx) {
        const r = await guardedFetch(i.url, { method: i.method, headers: i.headers, body: i.body, signal: ctx.signal }, d.checkUrl);
        const ct = r.headers['content-type'] ?? '';
        const text = ct.includes('html') ? htmlToText(r.body) : r.body;
        return {
          output: `HTTP ${r.status} ${r.finalUrl}\ncontent-type: ${ct}\n\n${truncate(text, 20_000)}${r.truncated ? '\n[body truncated at 1 MB]' : ''}`,
          data: { status: r.status, headers: r.headers },
        };
      },
    },
  ];
}
