import { request } from 'node:http';
import { Readable } from 'node:stream';

/**
 * fetch() for the AI runtime on this computer (plain http to 127.0.0.1), without fetch's five-minute limits: a model
 * on a processor may read a long request for longer than that before it answers. Stop (the abort signal) still ends it.
 */
export function localFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const u = new URL(url);
  if (u.protocol !== 'http:') return fetch(url, init);
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const body = typeof init.body === 'string' ? init.body : null;
    if (body !== null) headers['content-length'] = String(Buffer.byteLength(body));
    const req = request({ hostname: u.hostname, port: u.port || 80, path: `${u.pathname}${u.search}`, method: init.method ?? 'GET', headers }, (res) => {
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : String(v));
      const status = res.statusCode ?? 0;
      const empty = status === 204 || status === 304 || init.method === 'HEAD';
      if (empty) res.resume();
      resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream), { status, statusText: res.statusMessage, headers: h }));
    });
    const signal = init.signal;
    const abort = () => req.destroy(signal?.reason instanceof Error ? signal.reason : new DOMException('This operation was aborted', 'AbortError'));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    req.once('close', () => signal?.removeEventListener('abort', abort));
    req.once('error', reject);
    req.end(body ?? undefined);
  });
}
