import type { RiskLevel } from '@fbrx/shared';
import type { ToolSpec } from '../tools/types';
import { truncate } from '../util/misc';
import { asToolSlug, authHeaders, type ConnectorDriver, type DriverContext } from './types';

interface Operation {
  name: string;
  method: string;
  path: string;
  description?: string;
}

/** Connects the agent to a REST/JSON API: generic GET/send tools plus named operations. */
export class RestConnector implements ConnectorDriver {
  constructor(private readonly c: DriverContext) {}

  private get cfg() {
    return this.c.record.config;
  }

  private base(): URL {
    return new URL(String(this.cfg.baseUrl));
  }

  async connect() {
    this.base();
  }
  async disconnect() {}

  private buildUrl(path: string, query?: Record<string, unknown>): string {
    const base = this.base();
    const rel = String(path ?? '').replace(/^\/+/, '');
    if (/^[a-z]+:/i.test(rel) || rel.startsWith('//')) throw new Error('Path must be relative to the connector base URL');
    const url = new URL(rel, base.href.endsWith('/') ? base.href : `${base.href}/`);
    if (url.origin !== base.origin) throw new Error('Request would leave the connector base URL');
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    return url.toString();
  }

  private async request(method: string, path: string, query: Record<string, unknown> | undefined, body: unknown, headers: Record<string, string> | undefined, signal: AbortSignal) {
    const url = this.buildUrl(path, query);
    const defaults = (this.cfg.defaultHeaders as Record<string, string>) ?? {};
    const timeout = AbortSignal.timeout(Number(this.cfg.timeoutSeconds ?? 30) * 1000);
    const res = await fetch(url, {
      method,
      headers: {
        accept: 'application/json, text/plain;q=0.9, */*;q=0.5',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...defaults,
        ...(headers ?? {}),
        ...authHeaders(this.cfg, this.c.secret),
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.any([signal, timeout]),
      redirect: 'manual',
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* not json */
    }
    return {
      output: `HTTP ${res.status} ${method} ${url}\n\n${truncate(typeof data === 'string' ? data : JSON.stringify(data, null, 2), 20_000)}`,
      data: { status: res.status, body: data },
    };
  }

  tools(): ToolSpec[] {
    const slug = this.c.record.slug;
    const name = this.c.record.name;
    const allowWrite = !!this.cfg.allowWrite;
    const common = { source: 'connector' as const, sourceId: this.c.record.id, feature: 'connectors' as const, timeoutMs: 120_000 };
    const specs: ToolSpec[] = [
      {
        ...common,
        name: `${slug}.get`,
        title: `${name}: GET`,
        description: `Read data from the ${name} API (base ${String(this.cfg.baseUrl)}). Path is relative to the base URL.`,
        risk: 'network',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, query: { type: 'object' } },
          required: ['path'],
        },
        run: (i, ctx) => this.request('GET', i.path, i.query, undefined, undefined, ctx.signal),
      },
    ];
    if (allowWrite) {
      specs.push({
        ...common,
        name: `${slug}.send`,
        title: `${name}: write request`,
        description: `Create, update or delete data in the ${name} API with POST/PUT/PATCH/DELETE.`,
        risk: 'write',
        inputSchema: {
          type: 'object',
          properties: {
            method: { type: 'string', enum: ['POST', 'PUT', 'PATCH', 'DELETE'] },
            path: { type: 'string' },
            query: { type: 'object' },
            body: { description: 'JSON body' },
          },
          required: ['method', 'path'],
        },
        run: (i, ctx) => this.request(i.method, i.path, i.query, i.body, undefined, ctx.signal),
      });
    }
    for (const op of (this.cfg.operations as Operation[] | undefined) ?? []) {
      const method = String(op.method ?? 'GET').toUpperCase();
      const risk: RiskLevel = method === 'GET' || method === 'HEAD' ? 'network' : 'write';
      if (risk === 'write' && !allowWrite) continue;
      specs.push({
        ...common,
        name: `${slug}.${asToolSlug(op.name)}`,
        title: `${name}: ${op.name}`,
        description: op.description || `${method} ${op.path}`,
        risk,
        inputSchema: {
          type: 'object',
          properties: {
            params: { type: 'object', description: `Values for {placeholders} in ${op.path}` },
            query: { type: 'object' },
            ...(risk === 'write' ? { body: { description: 'JSON body' } } : {}),
          },
        },
        run: (i, ctx) => {
          const path = String(op.path).replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(String(i.params?.[k] ?? '')));
          return this.request(method, path, i.query, i.body, undefined, ctx.signal);
        },
      });
    }
    return specs;
  }

  async test() {
    const r = await this.request('GET', String(this.cfg.healthPath ?? ''), undefined, undefined, undefined, AbortSignal.timeout(10_000));
    const status = (r.data as { status: number }).status;
    return { ok: status < 400, message: `HTTP ${status}` };
  }
}
