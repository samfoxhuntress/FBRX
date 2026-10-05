import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { Db, hashPassword } from '@fbrx/shared/node';
import type { Config } from './config';
import { CP_MIGRATIONS } from './migrations';
import { loadKeys } from './keys';
import { CpAudit } from './audit';
import { Realtime } from './realtime';
import { WebhookDispatcher } from './services/webhooks';
import { createContextHelpers, ids, type AppContext } from './context';
import { HttpError } from './errors';
import { authRoutes } from './routes/auth';
import { deviceRoutes } from './routes/device';
import { updateRoutes } from './routes/updates';
import { adminOrgRoutes } from './routes/admin-org';
import { adminFleetRoutes } from './routes/admin-fleet';
import { adminAssetRoutes } from './routes/admin-assets';
import { ssoRoutes } from './routes/sso';
import { helpdeskRoutes } from './routes/helpdesk';
import { slugify } from './routes/util';

function readVersion(): string {
  if (process.env.FBRX_CP_VERSION) return process.env.FBRX_CP_VERSION;
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 5; i++) {
      const pj = join(dir, 'package.json');
      if (existsSync(pj)) return JSON.parse(readFileSync(pj, 'utf8')).version;
      dir = dirname(dir);
    }
  } catch {
    /* bundled */
  }
  return '1.0.0';
}

export interface BuiltServer {
  app: FastifyInstance;
  ctx: AppContext;
  close(): Promise<void>;
}

export async function buildServer(config: Config): Promise<BuiltServer> {
  mkdirSync(config.dataDir, { recursive: true });
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel, redact: ['req.headers.authorization', 'req.query.token', 'req.query.access_token', 'req.query.et'] },
    trustProxy: config.trustProxy,
    bodyLimit: 5 * 1024 * 1024,
  });
  const db = new Db(join(config.dataDir, 'control-plane.db'));
  db.migrate(CP_MIGRATIONS);
  const keys = loadKeys(config.dataDir);
  const version = readVersion();
  const base = {
    config,
    db,
    keys,
    audit: new CpAudit(db),
    realtime: new Realtime(),
    webhooks: new WebhookDispatcher(db, keys.master, version, (m, d) => app.log.warn(d, m)),
    version,
    log: app.log,
  };
  const ctx: AppContext = { ...base, ...createContextHelpers(base) };
  ctx.audit.onAppend((entry) => ctx.realtime.emitAdmin({ type: 'audit', tenantId: entry.tenantId, entry }));

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(rateLimit, { max: 1200, timeWindow: '1 minute', allowList: (req) => req.url.startsWith('/v1/device/') });
  await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });

  // Raw binary uploads (snapshots, release artifacts, plugin packages) are streamed, never buffered.
  app.addContentTypeParser(['application/octet-stream', 'application/gzip', 'application/x-gzip'], (_req, payload, done) => done(null, payload));

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'INVALID_ARGUMENT', message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') } });
    }
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'Unhandled error');
    return reply.status(status).send({ error: { code: status === 429 ? 'RATE_LIMITED' : 'ERROR', message: status >= 500 ? 'Internal server error' : (err as Error).message } });
  });

  app.get('/healthz', { logLevel: 'warn' }, async () => ({ ok: true, version }));
  await authRoutes(app, ctx);
  await ssoRoutes(app, ctx);
  await helpdeskRoutes(app, ctx);
  await deviceRoutes(app, ctx);
  await updateRoutes(app, ctx);
  await app.register(async (scoped) => adminOrgRoutes(scoped, ctx));
  await app.register(async (scoped) => adminFleetRoutes(scoped, ctx));
  await adminAssetRoutes(app, ctx);

  if (config.adminConsoleDir && existsSync(join(config.adminConsoleDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: config.adminConsoleDir, index: 'index.html' });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/v1/') && !req.url.includes('.')) return reply.sendFile('index.html');
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    });
  } else {
    app.get('/', async () => ({ product: 'FBRX OS control plane', version, adminConsole: 'not bundled (build apps/admin-console or set FBRX_ADMIN_CONSOLE_DIR)' }));
  }

  // First-run: bootstrap from env, or require a setup token.
  const users = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0);
  if (users === 0 && config.bootstrapAdmin) {
    const b = config.bootstrapAdmin;
    const now = new Date().toISOString();
    const tenantId = ids.tenant();
    db.run('INSERT INTO tenants (id, name, slug, contact_email, vertical, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', tenantId, b.organization, slugify(b.organization), b.email, b.kind, now, now);
    db.run(
      'INSERT INTO users (id, tenant_id, email, name, password_hash, role, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      ids.user(),
      null,
      b.email,
      b.name,
      await hashPassword(b.password),
      'superadmin',
      now,
      now,
    );
    app.log.info({ email: b.email, kind: b.kind }, 'Bootstrapped platform administrator from environment');
  } else if (users === 0) {
    if (!config.setupToken) config.setupToken = randomBytes(12).toString('base64url');
    app.log.warn(`First-run setup required. Open the admin console and use setup token: ${config.setupToken}`);
  }

  // Housekeeping.
  const sweep = () => {
    const now = new Date().toISOString();
    db.run("UPDATE commands SET status = 'expired', completed_at = ? WHERE status IN ('queued','sent') AND expires_at IS NOT NULL AND expires_at < ?", now, now);
    db.run('DELETE FROM device_metrics WHERE ts < ?', new Date(Date.now() - 30 * 86400_000).toISOString());
    db.run('DELETE FROM sessions WHERE expires_at < ?', new Date(Date.now() - 7 * 86400_000).toISOString());
  };
  const timer = setInterval(sweep, 60_000);
  timer.unref();

  return {
    app,
    ctx,
    async close() {
      clearInterval(timer);
      ctx.realtime.closeAll();
      await app.close();
      db.close();
    },
  };
}
