import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AGENT_SCOPE_METHODS, PRODUCT_NAME, type CoreMethod, type LocalApiInfo } from '@fbrx/shared';
import { safeEqual } from '@fbrx/shared/node';
import { CoreError, toCoreError } from '../errors';
import type { EventBus } from '../events';
import type { Logger } from '../logger';
import type { SettingsService } from '../settings/settings-service';
import type { CallContext } from '../api/core-api';

export interface LocalApiDeps {
  call: (method: string, params: unknown, ctx: CallContext) => Promise<unknown>;
  events: EventBus;
  tokens: () => { full: string; agent: string } | null;
  settings: SettingsService;
  log: Logger;
  appVersion: string;
}

type Scope = 'full' | 'agent';

const STATUS: Record<string, number> = {
  INVALID_ARGUMENT: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  POLICY_DENIED: 403,
  MANAGED: 403,
  FEATURE_UNAVAILABLE: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  ALREADY_EXISTS: 409,
  LOCKED: 423,
  UNAVAILABLE: 503,
  TIMEOUT: 504,
  CANCELLED: 499,
};

/**
 * Local automation API. Lets scripts, other desktop apps and peer FBRX instances drive the governed core:
 *   POST /v1/rpc            { method, params }  → any core method (scope permitting)
 *   POST /v1/agent/run      { prompt, … }       → run the agent to completion
 *   POST /v1/tools/:name    { input }           → invoke a tool through the governance gate
 *   GET  /v1/events                             → server-sent events stream
 *   GET  /v1/health                             → liveness (no auth)
 * Bound to 127.0.0.1 unless remote access is enabled; every request needs a bearer token.
 */
export class LocalApiServer {
  private server: Server | null = null;
  private port = 0;
  private sseClients = new Set<ServerResponse>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly d: LocalApiDeps) {}

  get running() {
    return !!this.server?.listening;
  }

  info(reveal: boolean): LocalApiInfo {
    const cfg = this.d.settings.get().localApi;
    const tokens = reveal ? this.d.tokens() : null;
    return {
      enabled: cfg.enabled,
      running: this.running,
      port: cfg.port,
      url: `http://127.0.0.1:${cfg.port}`,
      token: tokens?.full ?? null,
    };
  }

  async start(): Promise<void> {
    if (this.server) await this.stop();
    const cfg = this.d.settings.get().localApi;
    this.port = cfg.port;
    const server = createServer((req, res) => void this.handle(req, res));
    server.requestTimeout = 0;
    server.headersTimeout = 30_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, cfg.allowRemote ? '0.0.0.0' : '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.unsubscribe = this.d.events.onAny((event, payload) => this.broadcast(event, payload));
    this.d.log.info('Local API listening', { port: cfg.port, remote: cfg.allowRemote });
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const c of this.sseClients) c.end();
    this.sseClients.clear();
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  private broadcast(event: string, payload: unknown) {
    if (!this.sseClients.size) return;
    const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const c of this.sseClients) {
      if ((c as ServerResponse & { fbrxScope?: Scope }).fbrxScope === 'agent' && !['agent', 'approval.requested', 'approval.resolved'].includes(event)) continue;
      c.write(data);
    }
  }

  private authenticate(req: IncomingMessage, url: URL): Scope | null {
    const tokens = this.d.tokens();
    if (!tokens) return null;
    const header = req.headers.authorization ?? '';
    let presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!presented && url.pathname === '/v1/events') presented = url.searchParams.get('token') ?? '';
    if (!presented) return null;
    if (safeEqual(presented, tokens.full)) return 'full';
    if (safeEqual(presented, tokens.agent)) return 'agent';
    return null;
  }

  private hostAllowed(req: IncomingMessage): boolean {
    if (this.d.settings.get().localApi.allowRemote) return true;
    const host = (req.headers.host ?? '').toLowerCase();
    return [`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`].includes(host);
  }

  private cors(req: IncomingMessage, res: ServerResponse) {
    const devOrigin = process.env.FBRX_DEV_UI_ORIGIN;
    if (devOrigin && req.headers.origin === devOrigin) {
      res.setHeader('access-control-allow-origin', devOrigin);
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    }
  }

  private json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(body));
  }

  private async body(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 2 * 1024 * 1024) throw new CoreError('INVALID_ARGUMENT', 'Request body too large');
      chunks.push(chunk as Buffer);
    }
    if (!size) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new CoreError('INVALID_ARGUMENT', 'Body must be JSON');
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    this.cors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    if (!this.hostAllowed(req)) return this.json(res, 403, { error: { code: 'FORBIDDEN', message: 'Host not allowed' } });
    if (req.method === 'GET' && url.pathname === '/v1/health') {
      return this.json(res, 200, { ok: true, product: PRODUCT_NAME, version: this.d.appVersion });
    }
    const scope = this.authenticate(req, url);
    if (!scope) return this.json(res, 401, { error: { code: 'UNAUTHENTICATED', message: 'Missing or invalid token' } });
    const ctx: CallContext = { origin: 'api', actor: `localapi:${scope}` };
    try {
      if (req.method === 'GET' && url.pathname === '/v1/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`event: hello\ndata: ${JSON.stringify({ version: this.d.appVersion, scope })}\n\n`);
        (res as ServerResponse & { fbrxScope?: Scope }).fbrxScope = scope;
        this.sseClients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => {
          clearInterval(ping);
          this.sseClients.delete(res);
        });
        return;
      }
      if (req.method !== 'POST') return this.json(res, 405, { error: { code: 'INVALID_ARGUMENT', message: 'Method not allowed' } });
      const body = await this.body(req);
      if (url.pathname === '/v1/rpc') {
        const method = String(body.method ?? '') as CoreMethod;
        if (scope === 'agent' && !AGENT_SCOPE_METHODS.includes(method)) throw new CoreError('FORBIDDEN', `Token scope does not allow ${method}`);
        const result = await this.d.call(method, body.params ?? {}, ctx);
        return this.json(res, 200, { result });
      }
      if (url.pathname === '/v1/agent/run') {
        const result = await this.d.call(
          'agent.runToCompletion',
          { message: String(body.prompt ?? body.message ?? ''), providerId: body.providerId, model: body.model, conversationId: body.conversationId },
          ctx,
        );
        return this.json(res, 200, result);
      }
      const tool = /^\/v1\/tools\/([A-Za-z0-9_.-]+)$/.exec(url.pathname);
      if (tool) {
        const result = await this.d.call('tools.invoke', { name: tool[1], input: body.input ?? {} }, ctx);
        return this.json(res, 200, result);
      }
      return this.json(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown endpoint' } });
    } catch (err) {
      const e = toCoreError(err);
      return this.json(res, STATUS[e.code] ?? 500, { error: { code: e.code, message: e.message } });
    }
  }
}
