import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { Db } from '@fbrx/shared/node';
import type { VirtualConfig } from './config';
import { VIRTUAL_MIGRATIONS } from './migrations';
import { loadMasterKey } from './keys';
import { Audit } from './audit';
import { Auth } from './auth';
import { IsoLibrary } from './isos';
import { HardwareService } from './hardware/service';
import { BmcService } from './bmc/service';
import { ConsoleTickets } from './console-proxy';
import { CoreLink } from './core-link';
import { bearer, type VirtualContext } from './context';
import { VirtualError } from './errors';
import { loadTls } from './tls';
import type { Hypervisor } from './drivers/types';
import { ISOS_POOL } from './drivers/types';
import { LibvirtHypervisor } from './drivers/libvirt';
import { SimulatedHypervisor } from './drivers/simulated';
import { authRoutes } from './routes/auth';
import { vmRoutes } from './routes/vms';
import { storageRoutes } from './routes/storage';
import { hardwareRoutes } from './routes/hardware';
import { bmcRoutes } from './routes/bmc';
import { coreRoutes } from './routes/core';

function readVersion(): string {
  if (process.env.FBRX_V_VERSION) return process.env.FBRX_V_VERSION;
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
  return '0.0.0';
}

export interface BuiltVirtual {
  app: FastifyInstance;
  ctx: VirtualContext;
  close(): Promise<void>;
}

export interface BuildOptions {
  hypervisor?: Hypervisor;
  /** Talks to the management controller with this instead of HTTPS (tests). */
  bmcFetch?: typeof fetch;
  /** Talks to the server's FBRX core with this (tests). */
  coreFetch?: typeof fetch;
}

export function makeHypervisor(config: VirtualConfig): Hypervisor {
  return config.driver === 'libvirt'
    ? new LibvirtHypervisor({ uri: config.libvirtUri, imagesDir: config.imagesDir, isosDir: config.isosDir })
    : new SimulatedHypervisor({ dataDir: config.dataDir, isosDir: config.isosDir });
}

export async function buildServer(config: VirtualConfig, opts: BuildOptions = {}): Promise<BuiltVirtual> {
  mkdirSync(config.dataDir, { recursive: true });
  const tls = loadTls(config);
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel, redact: ['req.headers.authorization', 'req.query.ticket'] },
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
    serverFactory: (h) => (tls ? createHttpsServer({ key: tls.key, cert: tls.cert }, h) : createHttpServer(h)) as Server,
  }) as unknown as FastifyInstance;
  const db = new Db(join(config.dataDir, 'virtual.db'));
  db.migrate(VIRTUAL_MIGRATIONS);
  const key = loadMasterKey(config.dataDir);
  const hv = opts.hypervisor ?? makeHypervisor(config);
  const version = readVersion();
  const ctx: VirtualContext = {
    config,
    version,
    db,
    hv,
    auth: new Auth(db, config.sessionHours),
    audit: new Audit(db),
    isos: new IsoLibrary(config.isosDir, config.maxUploadBytes, () => hv.refreshPool(ISOS_POOL).catch(() => undefined)),
    hardware: new HardwareService(db, hv, config.sysRoot, (m) => app.log.warn(m)),
    bmc: new BmcService(db, key, opts.bmcFetch ?? null),
    tickets: new ConsoleTickets(),
    core: new CoreLink(config.core.url, config.core.tokenFile, opts.coreFetch),
    log: app.log,
    tls: tls ? { fingerprint: tls.fingerprint, selfSigned: tls.selfSigned, notAfter: tls.notAfter } : null,
  };

  try {
    await hv.prepare();
  } catch (e) {
    app.log.error(`The hypervisor is not ready: ${(e as Error).message}`);
  }
  await ctx.hardware.applyPinned().catch((e) => app.log.warn(`Interrupt placements not applied: ${(e as Error).message}`));

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(rateLimit, { max: 1200, timeWindow: '1 minute' });
  await app.register(websocket, { options: { maxPayload: 16 * 1024 * 1024 } });
  app.addContentTypeParser(['application/octet-stream', 'application/x-iso9660-image'], (_req, payload, done) => done(null, payload));

  app.decorateRequest('user', null);
  app.decorateRequest('token', null);
  app.addHook('onRequest', async (req) => {
    req.token = bearer(req);
    req.user = ctx.auth.session(req.token);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'INVALID_ARGUMENT', message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') } });
    if (err instanceof VirtualError) {
      if (err.status >= 500) req.log.warn({ err }, err.message);
      return reply.status(err.status).send({ error: { code: String(err.status), message: err.message } });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'Unhandled error');
    return reply.status(status).send({ error: { code: status === 429 ? 'RATE_LIMITED' : 'ERROR', message: status >= 500 ? 'Internal server error' : (err as Error).message } });
  });

  app.get('/healthz', { logLevel: 'warn' }, async () => ({ ok: true, version, driver: hv.kind }));
  await authRoutes(app, ctx);
  await vmRoutes(app, ctx);
  await storageRoutes(app, ctx);
  await hardwareRoutes(app, ctx);
  await bmcRoutes(app, ctx);
  await coreRoutes(app, ctx);

  if (config.consoleDir && existsSync(join(config.consoleDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: config.consoleDir, index: 'index.html' });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/v1/') && !req.url.includes('.')) return reply.sendFile('index.html');
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    });
  } else {
    app.get('/', async () => ({ product: 'FBRX Virtual', version, console: 'not bundled (build apps/virtual-console or set FBRX_V_CONSOLE_DIR)' }));
  }

  if (ctx.auth.userCount() === 0 && config.bootstrapAdmin) {
    const b = config.bootstrapAdmin;
    await ctx.auth.createUser({ username: b.username, name: b.name, password: b.password, role: 'admin' });
    ctx.audit.record('system', 'setup.bootstrap', b.username);
    app.log.info(`Created administrator ${b.username} from the environment`);
  } else if (ctx.auth.userCount() === 0) {
    config.setupToken ??= randomBytes(9).toString('base64url');
    app.log.warn(`First-time setup: open the FBRX Virtual console and enter setup code ${config.setupToken}`);
  }

  const timer = setInterval(() => {
    ctx.auth.sweep();
    ctx.audit.prune();
  }, 10 * 60_000);
  timer.unref();

  return {
    app,
    ctx,
    async close() {
      clearInterval(timer);
      ctx.isos.stop();
      await app.close();
      db.close();
    },
  };
}
