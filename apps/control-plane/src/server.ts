import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
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
import { createMailer } from './mail';
import { HttpError } from './errors';
import { authRoutes } from './routes/auth';
import { deviceRoutes } from './routes/device';
import { updateRoutes } from './routes/updates';
import { adminOrgRoutes } from './routes/admin-org';
import { adminFleetRoutes } from './routes/admin-fleet';
import { adminAssetRoutes } from './routes/admin-assets';
import { ssoRoutes } from './routes/sso';
import { helpdeskRoutes } from './routes/helpdesk';
import { chatRoutes } from './routes/chat';
import { meshRoutes } from './routes/mesh';
import { commandRoutes } from './routes/command';
import { accountRoutes } from './routes/accounts';
import { billingAdminRoutes } from './routes/billing-admin';
import { stripeOf } from './billing/stripe';
import { scheduleSeatSync, syncSeats, syncTenantLicense } from './billing/tenant-billing';
import { tenantScope } from './auth';
import { CommandUpdater } from './services/command-update';
import { slugify } from './routes/util';
import { loadTls } from './tls';

/** The FBRX release FBRX Command was built from (the same version as FBRX OS); from source, the FBRX folder's. */
function readVersion(): string {
  if (process.env.FBRX_CP_VERSION) return process.env.FBRX_CP_VERSION;
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 5; i++) {
      const fbrx = join(dir, 'apps', 'desktop', 'package.json');
      if (existsSync(fbrx)) return JSON.parse(readFileSync(fbrx, 'utf8')).version;
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
  /** Also answers on http://127.0.0.1:<port> (the console on this computer, no certificate warning). Resolves with the port. */
  listenLocal(port: number): Promise<number>;
  close(): Promise<void>;
}

/**
 * Idle connections stay open 72 seconds, as Fastify sets for servers it makes itself (with serverFactory it does not).
 * Node's own 5 seconds races computers that reuse a connection after a busy moment: the server closes it just as the
 * next request goes out, and that request fails ("fetch failed", ECONNRESET).
 */
function keepAlive(server: Server): Server {
  server.keepAliveTimeout = 72_000;
  return server;
}

export async function buildServer(config: Config): Promise<BuiltServer> {
  mkdirSync(config.dataDir, { recursive: true });
  const tls = loadTls(config);
  let handler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel, redact: ['req.headers.authorization', 'req.query.token', 'req.query.access_token', 'req.query.et'] },
    trustProxy: config.trustProxy,
    bodyLimit: 5 * 1024 * 1024,
    // One request handler for the main server (HTTPS when FBRX Command has a certificate) and the local listener.
    serverFactory: (h) => {
      handler = h;
      return keepAlive((tls ? createHttpsServer({ key: tls.key, cert: tls.cert }, h) : createHttpServer(h)) as Server);
    },
  }) as unknown as FastifyInstance;
  let local: Server | null = null;
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
    mail: createMailer(config.cloud.mail, app.log),
    version,
    log: app.log,
    tls: tls ? { fingerprint: tls.fingerprint, selfSigned: tls.selfSigned, notAfter: tls.notAfter } : null,
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

  // The website (its own origin) calls the account and billing API from the browser: CORS for those routes only.
  const websiteApi = /^\/v1\/(plans|accounts(\/|$)|billing\/(checkout|portal)$)/;
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (!origin || !config.cloud.websiteOrigins.includes(origin) || !websiteApi.test(req.url.split('?')[0]!)) return;
    reply.header('access-control-allow-origin', origin);
    reply.header('vary', 'Origin');
    reply.header('access-control-allow-headers', 'authorization, content-type');
    reply.header('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    reply.header('access-control-max-age', '600');
    if (req.method === 'OPTIONS') return reply.status(204).send();
  });
  // An organization's computers changed (their editions, their groups, members): its plan's seats follow.
  app.addHook('onResponse', async (req, reply) => {
    if (req.method === 'GET' || reply.statusCode >= 400 || !req.principal || !/^\/v1\/admin\/(devices|groups|members)\b/.test(req.url)) return;
    const tenantId = tenantScope(req);
    if (tenantId) scheduleSeatSync(ctx, stripeOf(config.cloud), tenantId);
  });
  app.get('/healthz', { logLevel: 'warn' }, async () => ({ ok: true, version }));
  await authRoutes(app, ctx);
  await ssoRoutes(app, ctx);
  await helpdeskRoutes(app, ctx);
  await chatRoutes(app, ctx);
  await meshRoutes(app, ctx);
  await deviceRoutes(app, ctx);
  await updateRoutes(app, ctx);
  await app.register(async (scoped) => adminOrgRoutes(scoped, ctx));
  await app.register(async (scoped) => adminFleetRoutes(scoped, ctx));
  await adminAssetRoutes(app, ctx);
  await accountRoutes(app, ctx);
  await app.register(async (scoped) => billingAdminRoutes(scoped, ctx));
  const updater = new CommandUpdater({
    version,
    db,
    dataDir: config.dataDir,
    log: (level, msg, data) => app.log[level](data ?? {}, msg),
  });
  await app.register(async (scoped) => commandRoutes(scoped, ctx, updater));
  if (!config.devMode) updater.start();

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
  const users = Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'superadmin'")?.n ?? 0);
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
  // Organizations in the cloud: their licenses follow their plans (renewals, ends), and the seats their computers.
  const reconcile = () => {
    for (const t of db.all<{ id: string }>("SELECT id FROM tenants WHERE billing = 'cloud' AND status = 'active'")) {
      try {
        syncTenantLicense(ctx, t.id);
      } catch (err) {
        app.log.warn({ err, tenant: t.id }, 'Could not bring the organization license up to date');
      }
      void syncSeats(ctx, stripeOf(config.cloud), t.id).catch((err) => app.log.warn({ err, tenant: t.id }, 'Could not update the plan with the computers'));
    }
  };
  const billingTimer = setInterval(reconcile, 15 * 60_000);
  billingTimer.unref();

  return {
    app,
    ctx,
    listenLocal(port: number) {
      return new Promise<number>((resolve, reject) => {
        const s = keepAlive(createHttpServer((req, res) => handler!(req, res)));
        // Live updates in the console: hand WebSocket upgrades to the main server's handler.
        s.on('upgrade', (req, socket, head) => app.server.emit('upgrade', req, socket, head));
        s.once('error', reject);
        s.listen(port, '127.0.0.1', () => {
          local = s;
          resolve((s.address() as { port: number }).port);
        });
      });
    },
    async close() {
      clearInterval(timer);
      clearInterval(billingTimer);
      updater.stop();
      ctx.realtime.closeAll();
      if (local) await new Promise<void>((r) => local!.close(() => r()));
      local?.closeAllConnections?.();
      await app.close();
      db.close();
    },
  };
}
