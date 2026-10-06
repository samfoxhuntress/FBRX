import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import * as tar from 'tar';
import { z } from 'zod';
import { ALL_FEATURES, EDITIONS, TIERS, UPDATE_CHANNELS, VERTICALS, compareSemver, decodeLicenseUnverified, isValidSemver, newId, tierFor, type Edition, type LicensePayload } from '@fbrx/shared';
import { openString, randomToken, sealString, sha256Hex, signLicense } from '@fbrx/shared/node';
import type { AppContext } from '../context';
import { ids } from '../context';
import { actorOf, adminAuth, assertTenantAccess, requirePerm, requireTenant, resolvePrincipal, tenantScope } from '../auth';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../errors';
import { can } from '../rbac';
import { storeStream } from '../services/storage';
import { CP_WEBHOOK_EVENTS } from '../services/webhooks';
import { inferFileKind } from './updates';
import { parseJson } from './util';

const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

function sendFile(reply: FastifyReply, path: string, name: string, type = 'application/octet-stream') {
  if (!existsSync(path)) throw notFound('File missing from storage');
  reply.header('content-type', type).header('content-length', statSync(path).size).header('content-disposition', `attachment; filename="${name.replace(/"/g, '')}"`);
  return reply.send(createReadStream(path));
}

export async function adminAssetRoutes(app: FastifyInstance, ctx: AppContext) {
  // Public, signature-protected route for template snapshots referenced by provisioning files.
  app.get('/v1/templates/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { exp, sig } = req.query as { exp?: string; sig?: string };
    if (!exp || !sig || Number(exp) < Date.now()) throw unauthorized('Link expired');
    const expected = createHmac('sha256', ctx.keys.jwt).update(`template:${id}:${exp}`).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw unauthorized('Invalid link');
    const s = ctx.db.get<any>('SELECT * FROM snapshots WHERE id = ?', id);
    if (!s) throw notFound();
    return sendFile(reply, s.storage_path, s.name);
  });

  await app.register(async (admin) => {
    admin.addHook('preHandler', adminAuth(ctx));
    const own = (req: any, table: string, id: string) => {
      const row = ctx.db.get<any>(`SELECT * FROM ${table} WHERE id = ?`, id);
      if (!row) throw notFound();
      assertTenantAccess(req, row.tenant_id);
      return row;
    };

    // ------------------------------------------------------------------------------ secrets
    admin.get('/v1/admin/secrets', async (req) => {
      requirePerm(req, 'secrets.manage');
      return ctx.db
        .all<any>('SELECT id, tenant_id, scope, scope_id, name, description, version, created_by, updated_at FROM secrets WHERE tenant_id = ? ORDER BY name', requireTenant(req))
        .map((s) => ({ id: s.id, scope: s.scope, scopeId: s.scope_id, name: s.name, description: s.description, version: Number(s.version), createdBy: s.created_by, updatedAt: s.updated_at }));
    });
    admin.post('/v1/admin/secrets', async (req) => {
      const p = requirePerm(req, 'secrets.manage');
      const tenantId = requireTenant(req);
      const body = z
        .object({ scope: z.enum(['tenant', 'group', 'device']), scopeId: z.string().optional(), name: z.string().regex(NAME_RE), value: z.string().min(1).max(65536), description: z.string().max(500).optional() })
        .parse(req.body);
      if (body.name.startsWith('fbrx.')) throw badRequest('Names starting with "fbrx." are reserved');
      const scopeId = body.scope === 'tenant' ? tenantId : body.scopeId ?? '';
      if (body.scope === 'group' && !ctx.db.get('SELECT 1 FROM groups WHERE id = ? AND tenant_id = ?', scopeId, tenantId)) throw badRequest('Unknown group');
      if (body.scope === 'device' && !ctx.db.get('SELECT 1 FROM devices WHERE id = ? AND tenant_id = ?', scopeId, tenantId)) throw badRequest('Unknown device');
      const existing = ctx.db.get<any>('SELECT * FROM secrets WHERE tenant_id = ? AND scope = ? AND scope_id = ? AND name = ?', tenantId, body.scope, scopeId, body.name);
      const id = existing?.id ?? ids.secret();
      const now = new Date().toISOString();
      const enc = sealString(ctx.keys.master, body.value, `secret:${id}`);
      if (existing) {
        ctx.db.run('UPDATE secrets SET value_enc = ?, description = ?, version = version + 1, updated_at = ? WHERE id = ?', enc, body.description ?? existing.description, now, id);
      } else {
        ctx.db.run(
          'INSERT INTO secrets (id, tenant_id, scope, scope_id, name, value_enc, description, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          id,
          tenantId,
          body.scope,
          scopeId,
          body.name,
          enc,
          body.description ?? '',
          p.label,
          now,
          now,
        );
      }
      ctx.bumpConfig(tenantId);
      ctx.audit.record(actorOf(req), existing ? 'secret.rotated' : 'secret.created', { type: 'secret', id, tenantId }, { name: body.name, scope: body.scope, scopeId });
      return { id, name: body.name, scope: body.scope, scopeId };
    });
    admin.delete('/v1/admin/secrets/:id', async (req) => {
      requirePerm(req, 'secrets.manage');
      const s = own(req, 'secrets', (req.params as { id: string }).id);
      ctx.db.run('DELETE FROM secrets WHERE id = ?', s.id);
      ctx.bumpConfig(s.tenant_id);
      ctx.audit.record(actorOf(req), 'secret.deleted', { type: 'secret', id: s.id, tenantId: s.tenant_id }, { name: s.name });
      return { ok: true };
    });

    // ----------------------------------------------------------------------------- releases
    const releaseView = (r: any) => ({
      id: r.id,
      version: r.version,
      channel: r.channel,
      notes: r.notes,
      published: !!r.published,
      rolloutPct: Number(r.rollout_pct),
      createdAt: r.created_at,
      publishedAt: r.published_at,
      files: ctx.db
        .all<any>('SELECT id, platform, arch, kind, file_name, size, sha256 FROM release_files WHERE release_id = ? ORDER BY platform, file_name', r.id)
        .map((f) => ({ id: f.id, platform: f.platform, arch: f.arch, kind: f.kind, fileName: f.file_name, size: Number(f.size), sha256: f.sha256 })),
    });
    admin.get('/v1/admin/releases', async (req) => {
      requirePerm(req, 'devices.read');
      return ctx.db
        .all<any>('SELECT * FROM releases')
        .sort((a, b) => compareSemver(b.version, a.version))
        .map(releaseView);
    });
    admin.post('/v1/admin/releases', async (req) => {
      const p = requirePerm(req, 'releases.manage');
      const body = z.object({ version: z.string().refine(isValidSemver, 'Version must be semver'), channel: z.enum(UPDATE_CHANNELS), notes: z.string().max(20000).optional() }).parse(req.body);
      if (ctx.db.get('SELECT 1 FROM releases WHERE version = ?', body.version)) throw conflict('That version already exists');
      const id = ids.release();
      ctx.db.run('INSERT INTO releases (id, version, channel, notes, created_by, created_at) VALUES (?,?,?,?,?,?)', id, body.version, body.channel, body.notes ?? '', p.label, new Date().toISOString());
      ctx.audit.record(actorOf(req), 'release.created', { type: 'release', id, tenantId: null }, body);
      return releaseView(ctx.db.get('SELECT * FROM releases WHERE id = ?', id));
    });
    admin.post('/v1/admin/releases/:id/files', { bodyLimit: ctx.config.maxUploadBytes }, async (req) => {
      requirePerm(req, 'releases.manage');
      const r = ctx.db.get<any>('SELECT * FROM releases WHERE id = ?', (req.params as { id: string }).id);
      if (!r) throw notFound();
      const q = z.object({ platform: z.enum(['darwin', 'win32', 'linux']), arch: z.enum(['x64', 'arm64', 'universal']).default('x64'), fileName: z.string().regex(/^[A-Za-z0-9 ._()+-]{1,200}$/) }).parse(req.query);
      const dest = join(ctx.config.dataDir, 'releases', r.id, q.fileName);
      const stored = await storeStream(req.body as Readable, dest, ctx.config.maxUploadBytes);
      const fileId = ids.file();
      ctx.db.run(
        `INSERT INTO release_files (id, release_id, platform, arch, kind, file_name, size, sha512, sha256, storage_path, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(release_id, file_name) DO UPDATE SET size = excluded.size, sha512 = excluded.sha512, sha256 = excluded.sha256, platform = excluded.platform, arch = excluded.arch, kind = excluded.kind`,
        fileId,
        r.id,
        q.platform,
        q.arch,
        inferFileKind(q.platform, q.fileName),
        q.fileName,
        stored.size,
        stored.sha512,
        stored.sha256,
        dest,
        new Date().toISOString(),
      );
      ctx.audit.record(actorOf(req), 'release.file.uploaded', { type: 'release', id: r.id, tenantId: null }, { fileName: q.fileName, size: stored.size, sha256: stored.sha256 });
      return releaseView(ctx.db.get('SELECT * FROM releases WHERE id = ?', r.id));
    });
    admin.patch('/v1/admin/releases/:id', async (req) => {
      requirePerm(req, 'releases.manage');
      const r = ctx.db.get<any>('SELECT * FROM releases WHERE id = ?', (req.params as { id: string }).id);
      if (!r) throw notFound();
      const body = z.object({ channel: z.enum(UPDATE_CHANNELS).optional(), notes: z.string().max(20000).optional(), published: z.boolean().optional(), rolloutPct: z.number().int().min(0).max(100).optional() }).parse(req.body);
      const publishing = body.published === true && !r.published;
      ctx.db.run(
        'UPDATE releases SET channel = ?, notes = ?, published = ?, rollout_pct = ?, published_at = ? WHERE id = ?',
        body.channel ?? r.channel,
        body.notes ?? r.notes,
        body.published === undefined ? r.published : body.published ? 1 : 0,
        body.rolloutPct ?? r.rollout_pct,
        publishing ? new Date().toISOString() : r.published_at,
        r.id,
      );
      if (publishing) ctx.webhooks.emit(null, 'release.published', { version: r.version, channel: body.channel ?? r.channel });
      ctx.audit.record(actorOf(req), 'release.updated', { type: 'release', id: r.id, tenantId: null }, body);
      return releaseView(ctx.db.get('SELECT * FROM releases WHERE id = ?', r.id));
    });
    admin.delete('/v1/admin/releases/:id', async (req) => {
      requirePerm(req, 'releases.manage');
      const r = ctx.db.get<any>('SELECT * FROM releases WHERE id = ?', (req.params as { id: string }).id);
      if (!r) throw notFound();
      rmSync(join(ctx.config.dataDir, 'releases', r.id), { recursive: true, force: true });
      ctx.db.run('DELETE FROM releases WHERE id = ?', r.id);
      ctx.audit.record(actorOf(req), 'release.deleted', { type: 'release', id: r.id, tenantId: null }, { version: r.version });
      return { ok: true };
    });

    // ----------------------------------------------------------------------------- licenses
    const licenseView = (l: any) => {
      const claims = decodeLicenseUnverified(l.key_text);
      return {
      id: l.id,
      tenantId: l.tenant_id,
      customer: l.customer,
      edition: l.edition,
      /** FBRX Endpoint Basic or Ultra on the devices that use it. */
      tier: tierFor(l.edition as Edition, claims?.tier),
      /** The FBRX Command address devices join when the key is pasted in. */
      commandUrl: claims?.command?.url ?? null,
      /** An Education (or Home) license. */
      vertical: claims?.vertical ?? 'business',
      seats: Number(l.seats),
      features: parseJson<string[]>(l.features, []),
      issuedAt: l.issued_at,
      expiresAt: l.expires_at,
      maxMajorVersion: l.max_major_version,
      revokedAt: l.revoked_at,
      key: l.key_text,
      };
    };
    admin.get('/v1/admin/licenses', async (req) => {
      requirePerm(req, 'licenses.read');
      const tenant = tenantScope(req);
      return (tenant ? ctx.db.all<any>('SELECT * FROM licenses WHERE tenant_id = ? ORDER BY issued_at DESC', tenant) : ctx.db.all<any>('SELECT * FROM licenses ORDER BY issued_at DESC')).map(licenseView);
    });
    admin.post('/v1/admin/licenses', async (req) => {
      const p = requirePerm(req, 'licenses.manage');
      const tenantId = requireTenant(req);
      const tenant = ctx.db.get<any>('SELECT * FROM tenants WHERE id = ?', tenantId);
      if (!tenant) throw notFound('Unknown tenant');
      const body = z
        .object({
          edition: z.enum(EDITIONS),
          seats: z.number().int().min(0).max(1_000_000),
          features: z.array(z.enum(ALL_FEATURES as [string, ...string[]])).optional(),
          expiresAt: z.string().datetime().nullable().optional(),
          maxMajorVersion: z.number().int().min(1).nullable().optional(),
          customer: z.string().max(200).optional(),
          /** Endpoint Basic or Ultra (otherwise Community runs Basic and Pro or Enterprise run Ultra). */
          tier: z.enum(TIERS).optional(),
          /** Computers that activate the key join this tenant on their own (FBRX Command). */
          joinTenant: z.boolean().optional(),
          groupId: z.string().nullable().optional(),
          /** An Education license makes the organization a school: staff computers start in classroom mode, student computers become possible. */
          vertical: z.enum(VERTICALS).optional(),
        })
        .parse(req.body);
      if (body.groupId && !ctx.db.get('SELECT 1 FROM groups WHERE id = ? AND tenant_id = ?', body.groupId, tenantId)) throw badRequest('Unknown group');
      const id = ids.license();
      // Joining the tenant needs an enrollment token, made here for this license: one use per seat.
      let command: LicensePayload['command'];
      if (body.joinTenant) {
        const token = randomToken('fbrx_enr');
        ctx.db.run(
          'INSERT INTO enrollment_tokens (id, tenant_id, group_id, label, prefix, token_hash, max_uses, template_snapshot_id, expires_at, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          ids.enrollment(),
          tenantId,
          body.groupId ?? null,
          `License ${id}`,
          token.slice(0, 15),
          sha256Hex(token),
          body.seats > 0 ? body.seats : null,
          null,
          body.expiresAt ?? null,
          p.id,
          new Date().toISOString(),
        );
        command = { url: ctx.config.publicUrl, enrollmentToken: token, ...(ctx.tls?.selfSigned ? { fingerprint: ctx.tls.fingerprint } : {}) };
      }
      const payload: LicensePayload = {
        v: 1,
        lid: id,
        tenantId,
        customer: body.customer ?? tenant.name,
        edition: body.edition,
        seats: body.seats,
        // A key that joins the tenant must let its computers enroll.
        features: [...new Set([...(body.features ?? []), ...(command ? ['fleet'] : [])])],
        issuedAt: new Date().toISOString(),
        expiresAt: body.expiresAt ?? null,
        maxMajorVersion: body.maxMajorVersion ?? null,
        ...(body.tier ? { tier: body.tier } : {}),
        ...(command ? { command } : {}),
        ...(body.vertical && body.vertical !== 'business' ? { vertical: body.vertical } : {}),
      };
      const key = signLicense(payload, ctx.keys.licensePrivatePem);
      ctx.db.run(
        'INSERT INTO licenses (id, tenant_id, customer, edition, seats, features, issued_at, expires_at, max_major_version, key_text, created_by, vertical) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        id,
        tenantId,
        payload.customer,
        payload.edition,
        payload.seats,
        JSON.stringify(payload.features),
        payload.issuedAt,
        payload.expiresAt,
        payload.maxMajorVersion,
        key,
        p.label,
        body.vertical ?? null,
      );
      // The license decides what kind of organization this is.
      if (body.vertical && body.vertical !== tenant.vertical) ctx.db.run('UPDATE tenants SET vertical = ?, updated_at = ? WHERE id = ?', body.vertical, new Date().toISOString(), tenantId);
      ctx.bumpConfig(tenantId);
      ctx.audit.record(actorOf(req), 'license.issued', { type: 'license', id, tenantId }, { edition: body.edition, seats: body.seats, expiresAt: body.expiresAt, tier: tierFor(body.edition, body.tier), joinsTenant: !!command });
      ctx.webhooks.emit(tenantId, 'license.issued', { licenseId: id, edition: body.edition, seats: body.seats, expiresAt: payload.expiresAt });
      return licenseView(ctx.db.get('SELECT * FROM licenses WHERE id = ?', id));
    });
    admin.post('/v1/admin/licenses/:id/revoke', async (req) => {
      requirePerm(req, 'licenses.manage');
      const l = ctx.db.get<any>('SELECT * FROM licenses WHERE id = ?', (req.params as { id: string }).id);
      if (!l) throw notFound();
      ctx.db.run('UPDATE licenses SET revoked_at = ? WHERE id = ?', new Date().toISOString(), l.id);
      ctx.bumpConfig(l.tenant_id);
      ctx.audit.record(actorOf(req), 'license.revoked', { type: 'license', id: l.id, tenantId: l.tenant_id });
      return { ok: true };
    });
    admin.get('/v1/admin/licensing/public-key', async (req) => {
      requirePerm(req, 'licenses.manage');
      return { publicKeyPem: ctx.keys.licensePublicPem };
    });

    // ----------------------------------------------------------------------------- packages
    const packageView = (p: any) => ({
      id: p.id,
      tenantId: p.tenant_id,
      pluginId: p.plugin_id,
      name: p.name,
      version: p.version,
      description: p.description,
      permissions: parseJson<string[]>(p.permissions, []),
      sha256: p.sha256,
      size: Number(p.size),
      createdAt: p.created_at,
    });
    admin.get('/v1/admin/packages', async (req) => {
      requirePerm(req, 'devices.read');
      const tenant = tenantScope(req);
      return ctx.db.all<any>('SELECT * FROM packages WHERE tenant_id IS NULL OR tenant_id = ? ORDER BY name, created_at DESC', tenant ?? '').map(packageView);
    });
    admin.post('/v1/admin/packages', { bodyLimit: 200 * 1024 * 1024 }, async (req) => {
      const p = requirePerm(req, 'packages.manage');
      const global = (req.query as { global?: string }).global === '1';
      if (global && p.role !== 'superadmin') throw forbidden('Only the platform operator can publish global packages');
      const tenantId = global ? null : requireTenant(req);
      const id = ids.pkg();
      const dest = join(ctx.config.dataDir, 'packages', `${id}.tgz`);
      const stored = await storeStream(req.body as Readable, dest, 200 * 1024 * 1024);
      const work = mkdtempSync(join(tmpdir(), 'fbrx-pkg-'));
      let manifest: any;
      try {
        await tar.x({ file: dest, cwd: work, strict: true, filter: (path) => /(^|\/)fbrx-plugin\.json$/.test(path) && !path.includes('..') });
        const found = [join(work, 'fbrx-plugin.json'), join(work, 'package', 'fbrx-plugin.json')].find(existsSync) ?? null;
        if (!found) {
          const { readdirSync } = await import('node:fs');
          const sub = readdirSync(work).map((d) => join(work, d, 'fbrx-plugin.json')).find(existsSync);
          if (!sub) throw badRequest('Package does not contain fbrx-plugin.json');
          manifest = JSON.parse(readFileSync(sub, 'utf8'));
        } else manifest = JSON.parse(readFileSync(found, 'utf8'));
      } catch (err) {
        rmSync(dest, { force: true });
        throw err instanceof Error && 'statusCode' in err ? err : badRequest('Package is not a valid .tgz plugin');
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
      if (!manifest?.id || !manifest?.version || !manifest?.namespace) {
        rmSync(dest, { force: true });
        throw badRequest('Plugin manifest is missing id, version or namespace');
      }
      ctx.db.run(
        'INSERT INTO packages (id, tenant_id, plugin_id, name, version, description, permissions, sha256, size, storage_path, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        id,
        tenantId,
        String(manifest.id),
        String(manifest.name ?? manifest.id),
        String(manifest.version),
        String(manifest.description ?? ''),
        JSON.stringify(manifest.permissions ?? []),
        stored.sha256,
        stored.size,
        dest,
        p.label,
        new Date().toISOString(),
      );
      ctx.audit.record(actorOf(req), 'package.uploaded', { type: 'package', id, tenantId }, { plugin: manifest.id, version: manifest.version, permissions: manifest.permissions ?? [] });
      return packageView(ctx.db.get('SELECT * FROM packages WHERE id = ?', id));
    });
    admin.post('/v1/admin/packages/:id/deploy', async (req) => {
      requirePerm(req, 'commands.privileged');
      const tenantId = requireTenant(req);
      const pkg = ctx.db.get<any>('SELECT * FROM packages WHERE id = ?', (req.params as { id: string }).id);
      if (!pkg || (pkg.tenant_id && pkg.tenant_id !== tenantId)) throw notFound();
      const body = z.object({ deviceIds: z.array(z.string()).optional(), groupId: z.string().optional(), all: z.boolean().optional() }).parse(req.body);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/admin/commands/bulk',
        headers: { authorization: req.headers.authorization ?? '', 'x-fbrx-tenant': tenantId },
        payload: { ...body, type: 'plugin.install', payload: { packageId: pkg.id, url: `/v1/device/packages/${pkg.id}`, sha256: pkg.sha256 } },
      });
      if (res.statusCode >= 400) throw badRequest(res.json().error?.message ?? 'Deploy failed');
      return res.json();
    });
    admin.delete('/v1/admin/packages/:id', async (req) => {
      const p = requirePerm(req, 'packages.manage');
      const pkg = ctx.db.get<any>('SELECT * FROM packages WHERE id = ?', (req.params as { id: string }).id);
      if (!pkg) throw notFound();
      if (pkg.tenant_id ? pkg.tenant_id !== tenantScope(req) && p.role !== 'superadmin' : p.role !== 'superadmin') throw forbidden();
      rmSync(pkg.storage_path, { force: true });
      ctx.db.run('DELETE FROM packages WHERE id = ?', pkg.id);
      ctx.audit.record(actorOf(req), 'package.deleted', { type: 'package', id: pkg.id, tenantId: pkg.tenant_id });
      return { ok: true };
    });

    // ---------------------------------------------------------------------------- snapshots
    admin.get('/v1/admin/snapshots', async (req) => {
      requirePerm(req, 'snapshots.manage');
      return ctx.db
        .all<any>('SELECT * FROM snapshots WHERE tenant_id = ? ORDER BY created_at DESC', requireTenant(req))
        .map((s) => ({ id: s.id, deviceId: s.device_id, deviceName: s.device_name, name: s.name, label: s.label, size: Number(s.size), sha256: s.sha256, header: parseJson(s.header, null), isTemplate: !!s.is_template, createdAt: s.created_at }));
    });
    admin.get('/v1/admin/snapshots/:id/download', async (req, reply) => {
      requirePerm(req, 'snapshots.manage');
      const s = own(req, 'snapshots', (req.params as { id: string }).id);
      ctx.audit.record(actorOf(req), 'snapshot.downloaded', { type: 'snapshot', id: s.id, tenantId: s.tenant_id });
      return sendFile(reply, s.storage_path, s.name);
    });
    admin.patch('/v1/admin/snapshots/:id', async (req) => {
      requirePerm(req, 'snapshots.manage');
      const s = own(req, 'snapshots', (req.params as { id: string }).id);
      const body = z.object({ label: z.string().max(120).nullable().optional(), isTemplate: z.boolean().optional() }).parse(req.body);
      ctx.db.run('UPDATE snapshots SET label = ?, is_template = ? WHERE id = ?', body.label !== undefined ? body.label : s.label, body.isTemplate === undefined ? s.is_template : body.isTemplate ? 1 : 0, s.id);
      return { ok: true };
    });
    admin.delete('/v1/admin/snapshots/:id', async (req) => {
      requirePerm(req, 'snapshots.manage');
      const s = own(req, 'snapshots', (req.params as { id: string }).id);
      rmSync(s.storage_path, { force: true });
      ctx.db.run('DELETE FROM snapshots WHERE id = ?', s.id);
      ctx.audit.record(actorOf(req), 'snapshot.deleted', { type: 'snapshot', id: s.id, tenantId: s.tenant_id });
      return { ok: true };
    });

    // ----------------------------------------------------------------------------- webhooks
    const hookView = (h: any) => ({ id: h.id, tenantId: h.tenant_id, name: h.name, url: h.url, events: parseJson<string[]>(h.events, []), enabled: !!h.enabled, lastStatus: h.last_status, lastDeliveryAt: h.last_delivery_at, lastError: h.last_error, createdAt: h.created_at });
    admin.get('/v1/admin/webhooks', async (req) => {
      requirePerm(req, 'webhooks.manage');
      const tenant = tenantScope(req);
      return (tenant ? ctx.db.all<any>('SELECT * FROM webhooks WHERE tenant_id = ?', tenant) : ctx.db.all<any>('SELECT * FROM webhooks WHERE tenant_id IS NULL')).map(hookView);
    });
    admin.post('/v1/admin/webhooks', async (req) => {
      const p = requirePerm(req, 'webhooks.manage');
      const tenantId = tenantScope(req);
      if (!tenantId && p.role !== 'superadmin') throw forbidden();
      const body = z.object({ name: z.string().min(1).max(120), url: z.string().url().refine((u) => /^https?:/.test(u)), events: z.array(z.enum([...CP_WEBHOOK_EVENTS, '*'] as [string, ...string[]])).min(1) }).parse(req.body);
      const id = ids.webhook();
      const secret = randomToken('whsec', 24);
      ctx.db.run(
        'INSERT INTO webhooks (id, tenant_id, name, url, secret_enc, events, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
        id,
        tenantId,
        body.name,
        body.url,
        sealString(ctx.keys.master, secret, `webhook:${id}`),
        JSON.stringify(body.events),
        p.label,
        new Date().toISOString(),
      );
      ctx.audit.record(actorOf(req), 'webhook.created', { type: 'webhook', id, tenantId }, { url: body.url, events: body.events });
      return { ...hookView(ctx.db.get('SELECT * FROM webhooks WHERE id = ?', id)), secret };
    });
    admin.patch('/v1/admin/webhooks/:id', async (req) => {
      requirePerm(req, 'webhooks.manage');
      const h = ctx.db.get<any>('SELECT * FROM webhooks WHERE id = ?', (req.params as { id: string }).id);
      if (!h) throw notFound();
      if (h.tenant_id) assertTenantAccess(req, h.tenant_id);
      else if (req.principal!.role !== 'superadmin') throw forbidden();
      const body = z.object({ enabled: z.boolean().optional(), events: z.array(z.string()).optional(), url: z.string().url().optional() }).parse(req.body);
      ctx.db.run('UPDATE webhooks SET enabled = ?, events = ?, url = ? WHERE id = ?', body.enabled === undefined ? h.enabled : body.enabled ? 1 : 0, body.events ? JSON.stringify(body.events) : h.events, body.url ?? h.url, h.id);
      return hookView(ctx.db.get('SELECT * FROM webhooks WHERE id = ?', h.id));
    });
    admin.post('/v1/admin/webhooks/:id/test', async (req) => {
      requirePerm(req, 'webhooks.manage');
      const h = ctx.db.get<any>('SELECT * FROM webhooks WHERE id = ?', (req.params as { id: string }).id);
      if (!h) throw notFound();
      if (h.tenant_id) assertTenantAccess(req, h.tenant_id);
      const status = await ctx.webhooks.deliver(h.id, h.url, openString(ctx.keys.master, h.secret_enc, `webhook:${h.id}`), 'test', h.tenant_id, { message: 'FBRX control plane webhook test' }, 3);
      return { status };
    });
    admin.delete('/v1/admin/webhooks/:id', async (req) => {
      requirePerm(req, 'webhooks.manage');
      const h = ctx.db.get<any>('SELECT * FROM webhooks WHERE id = ?', (req.params as { id: string }).id);
      if (!h) throw notFound();
      if (h.tenant_id) assertTenantAccess(req, h.tenant_id);
      else if (req.principal!.role !== 'superadmin') throw forbidden();
      ctx.db.run('DELETE FROM webhooks WHERE id = ?', h.id);
      ctx.audit.record(actorOf(req), 'webhook.deleted', { type: 'webhook', id: h.id, tenantId: h.tenant_id });
      return { ok: true };
    });

    // -------------------------------------------------------------------------------- audit
    admin.get('/v1/admin/audit', async (req) => {
      requirePerm(req, 'audit.read');
      const q = z.object({ limit: z.coerce.number().optional(), beforeSeq: z.coerce.number().optional(), action: z.string().optional(), search: z.string().optional() }).parse(req.query);
      const tenant = tenantScope(req);
      if (!tenant && req.principal!.role !== 'superadmin') throw forbidden();
      return ctx.audit.query({ ...q, tenantId: tenant });
    });
    admin.get('/v1/admin/audit/verify', async (req) => {
      if (req.principal!.role !== 'superadmin') throw forbidden();
      return ctx.audit.verify();
    });

    admin.get('/v1/admin/system', async (req) => {
      requirePerm(req, 'devices.read');
      return {
        version: ctx.version,
        publicUrl: ctx.config.publicUrl,
        // FBRX Command's own certificate: computers on the network trust it by this fingerprint.
        certificate: ctx.tls ? { fingerprint: ctx.tls.fingerprint, selfSigned: ctx.tls.selfSigned, notAfter: ctx.tls.notAfter } : null,
        heartbeatSeconds: ctx.config.heartbeatSeconds,
        onlineDevices: ctx.realtime.onlineCount(tenantScope(req)),
        features: { mfa: true, webhooks: true, templates: true, staged_rollouts: true },
        canManageReleases: can(req.principal!.role, 'releases.manage'),
      };
    });
  });

  // Admin live updates over WebSocket (token in the query string; browsers cannot set headers).
  app.get('/v1/admin/ws', { websocket: true }, async (socket, req) => {
    const token = (req.query as { token?: string }).token ?? '';
    const p = token ? await resolvePrincipal(ctx, token) : null;
    if (!p) {
      socket.close(4401, 'unauthorized');
      return;
    }
    const scope = p.role === 'superadmin' ? ((req.query as { tenantId?: string }).tenantId ?? null) : p.tenantId;
    const remove = ctx.realtime.addAdmin(socket, scope);
    socket.send(JSON.stringify({ type: 'hello', at: new Date().toISOString() }));
    socket.on('close', remove);
  });

  void newId;
}
