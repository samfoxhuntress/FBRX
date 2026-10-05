import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AUDIENCES, AUTO_UPDATE_MODES, KIND_GROUPS, parseVertical, type Audience, CommandPayloadSchemas, DEFAULT_SETTINGS, PolicySchema, SettingsSchema, TIERS, UPDATE_CHANNELS, deepMerge, isCommandType, isValidSemver, leafPaths, type ProvisioningFile } from '@fbrx/shared';
import { randomToken, sha256Hex } from '@fbrx/shared/node';
import type { AppContext } from '../context';
import { ids } from '../context';
import { actorOf, adminAuth, assertTenantAccess, requirePerm, requireTenant, tenantScope } from '../auth';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { PRIVILEGED_COMMANDS, can } from '../rbac';
import { commandView, deviceView } from '../services/devices';
import { parseJson } from './util';
import { createHmac } from 'node:crypto';

const KNOWN_SETTINGS = new Set(leafPaths(DEFAULT_SETTINGS));

/** Validates a partial settings object: every path must exist and the merged result must satisfy the schema. */
export function validateSettingsPatch(settings: unknown, locked: string[] = []) {
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) throw badRequest('settings must be an object');
  for (const p of leafPaths(settings)) if (!KNOWN_SETTINGS.has(p)) throw badRequest(`Unknown setting "${p}"`);
  const merged = SettingsSchema.safeParse(deepMerge(structuredClone(DEFAULT_SETTINGS), settings));
  if (!merged.success) throw badRequest(`Invalid settings: ${merged.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  for (const l of locked) {
    if (![...KNOWN_SETTINGS].some((k) => k === l || k.startsWith(`${l}.`))) throw badRequest(`Unknown locked setting "${l}"`);
  }
}

export function signTemplateUrl(ctx: AppContext, snapshotId: string, expiresAt: number): string {
  const sig = createHmac('sha256', ctx.keys.jwt).update(`template:${snapshotId}:${expiresAt}`).digest('base64url');
  return `${ctx.config.publicUrl}/v1/templates/${snapshotId}?exp=${expiresAt}&sig=${sig}`;
}

export async function adminFleetRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', adminAuth(ctx));

  const own = (req: any, table: string, id: string) => {
    const row = ctx.db.get<any>(`SELECT * FROM ${table} WHERE id = ?`, id);
    if (!row) throw notFound();
    assertTenantAccess(req, row.tenant_id);
    return row;
  };

  // ---------------------------------------------------------------------------------- profiles
  const profileView = (p: any) => ({
    id: p.id,
    tenantId: p.tenant_id,
    name: p.name,
    description: p.description,
    settings: parseJson(p.settings, {}),
    locked: parseJson(p.locked, []),
    policy: parseJson(p.policy, null),
    version: Number(p.version),
    updatedAt: p.updated_at,
  });
  const ProfileInput = z.object({
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    locked: z.array(z.string().max(120)).max(200).optional(),
    policy: z.unknown().nullable().optional(),
  });

  app.get('/v1/admin/profiles', async (req) => {
    requirePerm(req, 'devices.read');
    return ctx.db.all<any>('SELECT * FROM profiles WHERE tenant_id = ? ORDER BY name', requireTenant(req)).map(profileView);
  });

  const saveProfile = async (req: any, id: string | null) => {
    requirePerm(req, 'config.manage');
    const tenantId = requireTenant(req);
    const body = (id ? ProfileInput.partial() : ProfileInput).parse(req.body);
    if (body.settings || body.locked) validateSettingsPatch(body.settings ?? {}, body.locked ?? []);
    const policy = body.policy === undefined ? undefined : body.policy === null ? null : PolicySchema.parse(body.policy);
    const now = new Date().toISOString();
    if (!id) {
      id = ids.profile();
      if (ctx.db.get('SELECT 1 FROM profiles WHERE tenant_id = ? AND name = ?', tenantId, body.name!)) throw conflict('A profile with that name exists');
      ctx.db.run(
        'INSERT INTO profiles (id, tenant_id, name, description, settings, locked, policy, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        id,
        tenantId,
        body.name!,
        body.description ?? '',
        JSON.stringify(body.settings ?? {}),
        JSON.stringify(body.locked ?? []),
        policy ? JSON.stringify(policy) : null,
        now,
        now,
      );
      ctx.audit.record(actorOf(req), 'profile.created', { type: 'profile', id, tenantId }, { name: body.name });
    } else {
      const cur = own(req, 'profiles', id);
      ctx.db.run(
        'UPDATE profiles SET name = ?, description = ?, settings = ?, locked = ?, policy = ?, version = version + 1, updated_at = ? WHERE id = ?',
        body.name ?? cur.name,
        body.description ?? cur.description,
        body.settings ? JSON.stringify(body.settings) : cur.settings,
        body.locked ? JSON.stringify(body.locked) : cur.locked,
        policy === undefined ? cur.policy : policy ? JSON.stringify(policy) : null,
        now,
        id,
      );
      ctx.audit.record(actorOf(req), 'profile.updated', { type: 'profile', id, tenantId }, { fields: Object.keys(body) });
    }
    ctx.bumpConfig(tenantId);
    return profileView(ctx.db.get('SELECT * FROM profiles WHERE id = ?', id));
  };
  app.post('/v1/admin/profiles', (req) => saveProfile(req, null));
  app.patch('/v1/admin/profiles/:id', (req) => saveProfile(req, (req.params as { id: string }).id));
  app.delete('/v1/admin/profiles/:id', async (req) => {
    requirePerm(req, 'config.manage');
    const p = own(req, 'profiles', (req.params as { id: string }).id);
    ctx.db.run('UPDATE tenants SET default_profile_id = NULL WHERE default_profile_id = ?', p.id);
    ctx.db.run('DELETE FROM profiles WHERE id = ?', p.id);
    ctx.bumpConfig(p.tenant_id);
    ctx.audit.record(actorOf(req), 'profile.deleted', { type: 'profile', id: p.id, tenantId: p.tenant_id });
    return { ok: true };
  });

  // ------------------------------------------------------------------------------------ groups
  const groupView = (g: any) => ({
    id: g.id,
    tenantId: g.tenant_id,
    name: g.name,
    description: g.description,
    profileId: g.profile_id,
    updateChannel: g.update_channel,
    pinnedVersion: g.pinned_version,
    audience: g.audience ?? null,
    tier: g.tier ?? null,
    autoUpdate: g.auto_update ?? null,
    deviceCount: Number(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM devices WHERE group_id = ? AND status = 'active'", g.id)?.n ?? 0),
  });
  const GroupInput = z.object({
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    profileId: z.string().nullable().optional(),
    updateChannel: z.enum(UPDATE_CHANNELS).nullable().optional(),
    pinnedVersion: z.string().refine(isValidSemver, 'Invalid version').nullable().optional(),
    /** Who uses the group's computers (Education: staff or student). */
    audience: z.enum(AUDIENCES).nullable().optional(),
    /** Hold the group to Endpoint Basic, or null for what the license gives. */
    tier: z.enum(TIERS).nullable().optional(),
    autoUpdate: z.enum(AUTO_UPDATE_MODES).nullable().optional(),
  });
  app.get('/v1/admin/groups', async (req) => {
    requirePerm(req, 'devices.read');
    return ctx.db.all<any>('SELECT * FROM groups WHERE tenant_id = ? ORDER BY name', requireTenant(req)).map(groupView);
  });
  const saveGroup = async (req: any, id: string | null) => {
    requirePerm(req, 'config.manage');
    const tenantId = requireTenant(req);
    const body = (id ? GroupInput.partial() : GroupInput).parse(req.body);
    if (body.profileId && !ctx.db.get('SELECT 1 FROM profiles WHERE id = ? AND tenant_id = ?', body.profileId, tenantId)) throw badRequest('Unknown profile');
    const now = new Date().toISOString();
    if (!id) {
      id = ids.group();
      if (ctx.db.get('SELECT 1 FROM groups WHERE tenant_id = ? AND name = ?', tenantId, body.name!)) throw conflict('A group with that name exists');
      ctx.db.run(
        'INSERT INTO groups (id, tenant_id, name, description, profile_id, update_channel, pinned_version, audience, tier, auto_update, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        id,
        tenantId,
        body.name!,
        body.description ?? '',
        body.profileId ?? null,
        body.updateChannel ?? null,
        body.pinnedVersion ?? null,
        body.audience ?? null,
        body.tier ?? null,
        body.autoUpdate ?? null,
        now,
        now,
      );
    } else {
      const g = own(req, 'groups', id);
      ctx.db.run(
        'UPDATE groups SET name = ?, description = ?, profile_id = ?, update_channel = ?, pinned_version = ?, audience = ?, tier = ?, auto_update = ?, updated_at = ? WHERE id = ?',
        body.name ?? g.name,
        body.description ?? g.description,
        body.profileId !== undefined ? body.profileId : g.profile_id,
        body.updateChannel !== undefined ? body.updateChannel : g.update_channel,
        body.pinnedVersion !== undefined ? body.pinnedVersion : g.pinned_version,
        body.audience !== undefined ? body.audience : g.audience,
        body.tier !== undefined ? body.tier : g.tier,
        body.autoUpdate !== undefined ? body.autoUpdate : g.auto_update,
        now,
        id,
      );
    }
    ctx.bumpConfig(tenantId);
    ctx.audit.record(actorOf(req), 'group.saved', { type: 'group', id, tenantId }, body);
    return groupView(ctx.db.get('SELECT * FROM groups WHERE id = ?', id));
  };
  app.post('/v1/admin/groups', (req) => saveGroup(req, null));
  app.patch('/v1/admin/groups/:id', (req) => saveGroup(req, (req.params as { id: string }).id));
  app.delete('/v1/admin/groups/:id', async (req) => {
    requirePerm(req, 'config.manage');
    const g = own(req, 'groups', (req.params as { id: string }).id);
    ctx.db.run('DELETE FROM groups WHERE id = ?', g.id);
    ctx.bumpConfig(g.tenant_id);
    ctx.audit.record(actorOf(req), 'group.deleted', { type: 'group', id: g.id, tenantId: g.tenant_id });
    return { ok: true };
  });

  // ----------------------------------------------------------------------- enrollment tokens
  const tokenView = (t: any) => ({
    id: t.id,
    tenantId: t.tenant_id,
    groupId: t.group_id,
    label: t.label,
    prefix: t.prefix,
    maxUses: t.max_uses,
    uses: Number(t.uses),
    templateSnapshotId: t.template_snapshot_id,
    audience: t.audience ?? null,
    expiresAt: t.expires_at,
    createdAt: t.created_at,
    revokedAt: t.revoked_at,
  });
  /** A new enrollment token and the provisioning file that goes with it (the token is only ever returned here). */
  const createToken = (
    tenantId: string,
    body: { label: string; groupId?: string | null; maxUses?: number | null; expiresInDays?: number | null; templateSnapshotId?: string | null; templatePassphrase?: string; deviceName?: string; audience?: Audience | null },
    createdBy: string,
  ) => {
    const token = randomToken('fbrx_enr');
    const id = ids.enrollment();
    const expiresAt = body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86400_000).toISOString() : null;
    ctx.db.run(
      'INSERT INTO enrollment_tokens (id, tenant_id, group_id, label, prefix, token_hash, max_uses, template_snapshot_id, expires_at, created_by, created_at, audience) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      id,
      tenantId,
      body.groupId ?? null,
      body.label,
      token.slice(0, 15),
      sha256Hex(token),
      body.maxUses ?? null,
      body.templateSnapshotId ?? null,
      expiresAt,
      createdBy,
      new Date().toISOString(),
      body.audience ?? null,
    );
    if (body.templateSnapshotId) ctx.db.run('UPDATE snapshots SET is_template = 1 WHERE id = ?', body.templateSnapshotId);
    const provisioning: ProvisioningFile = {
      fbrxProvisioning: 1,
      serverUrl: ctx.config.publicUrl,
      enrollmentToken: token,
      ...(body.deviceName ? { deviceName: body.deviceName } : {}),
      ...(body.audience ? { audience: body.audience } : {}),
      ...(body.templateSnapshotId
        ? {
            templateSnapshotUrl: signTemplateUrl(ctx, body.templateSnapshotId, expiresAt ? new Date(expiresAt).getTime() : Date.now() + 365 * 86400_000),
            templateSnapshotPassphrase: body.templatePassphrase,
          }
        : {}),
    };
    return { id, token, provisioning };
  };

  /**
   * Quick setup for the tenant's kind (Work, School or Home): its usual groups (Staff and IT; Teachers, IT and
   * Students; Parents and Children), each with a fresh enrollment token. Groups that already exist are reused.
   */
  app.post('/v1/admin/tenants/:id/quick-setup', async (req) => {
    const p = requirePerm(req, 'config.manage');
    requirePerm(req, 'enrollment.manage');
    const tenantId = (req.params as { id: string }).id;
    assertTenantAccess(req, tenantId);
    const t = ctx.db.get<{ vertical: string | null; name: string }>('SELECT vertical, name FROM tenants WHERE id = ?', tenantId);
    if (!t) throw notFound('Unknown organization');
    const vertical = parseVertical(t.vertical) ?? 'business';
    const now = new Date().toISOString();
    const made = ctx.db.tx(() =>
      KIND_GROUPS[vertical].map((g) => {
        let group = ctx.db.get<any>('SELECT * FROM groups WHERE tenant_id = ? AND name = ?', tenantId, g.name);
        if (!group) {
          const gid = ids.group();
          ctx.db.run(
            'INSERT INTO groups (id, tenant_id, name, description, audience, tier, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
            gid,
            tenantId,
            g.name,
            g.description,
            g.audience,
            g.tier,
            now,
            now,
          );
          group = ctx.db.get<any>('SELECT * FROM groups WHERE id = ?', gid);
        }
        const tok = createToken(tenantId, { label: `${g.name} computers`, groupId: group.id, audience: g.audience }, p.id);
        return { group: groupView(group), audience: g.audience, token: tok.token, provisioning: tok.provisioning };
      }),
    );
    ctx.bumpConfig(tenantId);
    ctx.audit.record(actorOf(req), 'tenant.quick-setup', { type: 'tenant', id: tenantId, tenantId }, { kind: vertical, groups: made.map((m) => m.group.name) });
    return { kind: vertical, groups: made };
  });

  app.get('/v1/admin/enrollment-tokens', async (req) => {
    requirePerm(req, 'enrollment.manage');
    return ctx.db.all<any>('SELECT * FROM enrollment_tokens WHERE tenant_id = ? ORDER BY created_at DESC', requireTenant(req)).map(tokenView);
  });
  app.post('/v1/admin/enrollment-tokens', async (req) => {
    const p = requirePerm(req, 'enrollment.manage');
    const tenantId = requireTenant(req);
    const body = z
      .object({
        label: z.string().min(1).max(120),
        groupId: z.string().nullable().optional(),
        maxUses: z.number().int().min(1).max(100000).nullable().optional(),
        expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
        templateSnapshotId: z.string().nullable().optional(),
        templatePassphrase: z.string().optional(),
        deviceName: z.string().max(120).optional(),
        /** Computers that join with this token are used by… (Education: "student" makes FBRX OS Education). */
        audience: z.enum(AUDIENCES).nullable().optional(),
      })
      .parse(req.body);
    if (body.groupId && !ctx.db.get('SELECT 1 FROM groups WHERE id = ? AND tenant_id = ?', body.groupId, tenantId)) throw badRequest('Unknown group');
    if (body.templateSnapshotId && !ctx.db.get('SELECT 1 FROM snapshots WHERE id = ? AND tenant_id = ?', body.templateSnapshotId, tenantId)) throw badRequest('Unknown snapshot');
    if (body.templateSnapshotId && !body.templatePassphrase) throw badRequest('A template snapshot needs its passphrase so new machines can decrypt it');
    const { id, token, provisioning } = createToken(tenantId, body, p.id);
    ctx.audit.record(actorOf(req), 'enrollment.created', { type: 'enrollment', id, tenantId }, { label: body.label, maxUses: body.maxUses, group: body.groupId, template: body.templateSnapshotId });
    return { ...tokenView(ctx.db.get('SELECT * FROM enrollment_tokens WHERE id = ?', id)), token, provisioning };
  });
  app.delete('/v1/admin/enrollment-tokens/:id', async (req) => {
    requirePerm(req, 'enrollment.manage');
    const t = own(req, 'enrollment_tokens', (req.params as { id: string }).id);
    ctx.db.run('UPDATE enrollment_tokens SET revoked_at = ? WHERE id = ?', new Date().toISOString(), t.id);
    ctx.audit.record(actorOf(req), 'enrollment.revoked', { type: 'enrollment', id: t.id, tenantId: t.tenant_id });
    return { ok: true };
  });

  // ----------------------------------------------------------------------------------- devices
  app.get('/v1/admin/devices', async (req) => {
    requirePerm(req, 'devices.read');
    const q = z.object({ status: z.string().optional(), groupId: z.string().optional(), search: z.string().optional(), tenantId: z.string().optional() }).parse(req.query);
    const tenant = tenantScope(req);
    const where: string[] = [];
    const args: string[] = [];
    if (tenant) {
      where.push('tenant_id = ?');
      args.push(tenant);
    }
    if (q.status) {
      where.push('status = ?');
      args.push(q.status);
    } else where.push("status != 'retired'");
    if (q.groupId) {
      where.push('group_id = ?');
      args.push(q.groupId);
    }
    if (q.search) {
      where.push('(name LIKE ? OR hostname LIKE ? OR id LIKE ? OR tags LIKE ?)');
      args.push(...Array(4).fill(`%${q.search}%`));
    }
    return ctx.db.all<any>(`SELECT * FROM devices ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name COLLATE NOCASE LIMIT 5000`, ...args).map((d) => deviceView(ctx, d));
  });

  app.get('/v1/admin/devices/:id', async (req) => {
    requirePerm(req, 'devices.read');
    const d = own(req, 'devices', (req.params as { id: string }).id);
    const group = d.group_id ? ctx.db.get<any>('SELECT id, name FROM groups WHERE id = ?', d.group_id) : null;
    const events = ctx.db.all<any>('SELECT * FROM device_events WHERE device_id = ? ORDER BY ts DESC LIMIT 50', d.id).map((e) => ({ ...e, data: parseJson(e.data, null) }));
    const commands = ctx.db.all<any>('SELECT * FROM commands WHERE device_id = ? ORDER BY created_at DESC LIMIT 50', d.id).map(commandView);
    const snapshots = ctx.db.all<any>('SELECT id, name, label, size, created_at FROM snapshots WHERE device_id = ? ORDER BY created_at DESC', d.id);
    return { ...deviceView(ctx, d), group, events, commands, snapshots, auditHead: { seq: d.audit_head_seq, hash: d.audit_head_hash } };
  });

  app.get('/v1/admin/devices/:id/metrics', async (req) => {
    requirePerm(req, 'devices.read');
    const d = own(req, 'devices', (req.params as { id: string }).id);
    const hours = Math.min(Number((req.query as { hours?: string }).hours ?? 24), 24 * 30);
    return ctx.db.all<any>(
      'SELECT ts, cpu, mem, disk_free AS diskFree, agent_runs AS agentRuns, tool_calls AS toolCalls, denials, errors FROM device_metrics WHERE device_id = ? AND ts >= ? ORDER BY ts',
      d.id,
      new Date(Date.now() - hours * 3600_000).toISOString(),
    );
  });

  app.patch('/v1/admin/devices/:id', async (req) => {
    requirePerm(req, 'devices.manage');
    const d = own(req, 'devices', (req.params as { id: string }).id);
    const body = z
      .object({
        name: z.string().min(1).max(120).optional(),
        groupId: z.string().nullable().optional(),
        tags: z.array(z.string().max(40)).max(30).optional(),
        notes: z.string().max(5000).optional(),
        status: z.enum(['active', 'disabled']).optional(),
        settingsOverride: z.record(z.string(), z.unknown()).optional(),
        lockedOverride: z.array(z.string()).optional(),
        policyOverride: z.unknown().nullable().optional(),
        updateChannel: z.enum(UPDATE_CHANNELS).nullable().optional(),
        pinnedVersion: z.string().refine(isValidSemver, 'Invalid version').nullable().optional(),
        /** Who uses this computer (null = its group's or the organization's default). */
        audience: z.enum(AUDIENCES).nullable().optional(),
        /** This computer receives the organization's help desk tickets. */
        helpdeskReceiver: z.boolean().optional(),
      })
      .parse(req.body);
    const configFields = ['groupId', 'settingsOverride', 'lockedOverride', 'policyOverride', 'updateChannel', 'pinnedVersion', 'audience', 'helpdeskReceiver'];
    if (configFields.some((f) => f in body) && !can(req.principal!.role, 'config.manage')) throw forbidden('Changing device configuration requires an admin');
    if (body.groupId && !ctx.db.get('SELECT 1 FROM groups WHERE id = ? AND tenant_id = ?', body.groupId, d.tenant_id)) throw badRequest('Unknown group');
    if (body.settingsOverride || body.lockedOverride) validateSettingsPatch(body.settingsOverride ?? {}, body.lockedOverride ?? []);
    const policy = body.policyOverride === undefined ? undefined : body.policyOverride === null ? null : PolicySchema.parse(body.policyOverride);
    ctx.db.run(
      `UPDATE devices SET name = ?, group_id = ?, tags = ?, notes = ?, status = ?, settings_override = ?, locked_override = ?, policy_override = ?,
         update_channel = ?, pinned_version = ?, audience = ?, helpdesk_receiver = ?, updated_at = ? WHERE id = ?`,
      body.name ?? d.name,
      body.groupId !== undefined ? body.groupId : d.group_id,
      body.tags ? JSON.stringify(body.tags) : d.tags,
      body.notes ?? d.notes,
      body.status ?? d.status,
      body.settingsOverride ? JSON.stringify(body.settingsOverride) : d.settings_override,
      body.lockedOverride ? JSON.stringify(body.lockedOverride) : d.locked_override,
      policy === undefined ? d.policy_override : policy ? JSON.stringify(policy) : null,
      body.updateChannel !== undefined ? body.updateChannel : d.update_channel,
      body.pinnedVersion !== undefined ? body.pinnedVersion : d.pinned_version,
      body.audience !== undefined ? body.audience : (d.audience ?? null),
      body.helpdeskReceiver !== undefined ? (body.helpdeskReceiver ? 1 : 0) : Number(d.helpdesk_receiver ?? 0),
      new Date().toISOString(),
      d.id,
    );
    if (body.status === 'disabled') ctx.realtime.disconnectDevice(d.id, 'disabled by administrator');
    if (configFields.some((f) => f in body)) ctx.bumpConfig(d.tenant_id);
    ctx.audit.record(actorOf(req), 'device.updated', { type: 'device', id: d.id, tenantId: d.tenant_id }, { fields: Object.keys(body) });
    return deviceView(ctx, ctx.db.get('SELECT * FROM devices WHERE id = ?', d.id));
  });

  app.delete('/v1/admin/devices/:id', async (req) => {
    requirePerm(req, 'devices.manage');
    const d = own(req, 'devices', (req.params as { id: string }).id);
    ctx.db.run("UPDATE devices SET status = 'retired', token_hash = ?, updated_at = ? WHERE id = ?", `retired:${ids.device()}`, new Date().toISOString(), d.id);
    ctx.realtime.disconnectDevice(d.id, 'retired by administrator');
    ctx.audit.record(actorOf(req), 'device.retired', { type: 'device', id: d.id, tenantId: d.tenant_id });
    ctx.webhooks.emit(d.tenant_id, 'device.retired', { deviceId: d.id, name: d.name, by: req.principal!.label });
    return { ok: true };
  });

  // ---------------------------------------------------------------------------------- commands
  const CommandInput = z.object({ type: z.string(), payload: z.unknown().optional(), expiresInMinutes: z.number().int().min(1).max(60 * 24 * 30).optional() });

  const queueCommand = (req: any, device: any, type: string, payload: unknown, expiresInMinutes?: number) => {
    if (!isCommandType(type)) throw badRequest(`Unknown command ${type}`);
    if (PRIVILEGED_COMMANDS.has(type)) requirePerm(req, 'commands.privileged');
    if (device.status !== 'active') throw badRequest(`Device ${device.name} is ${device.status}`);
    const parsed = CommandPayloadSchemas[type].parse(payload ?? {});
    const id = ids.command();
    const now = new Date();
    ctx.db.run(
      'INSERT INTO commands (id, tenant_id, device_id, type, payload, status, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id,
      device.tenant_id,
      device.id,
      type,
      JSON.stringify(parsed),
      'queued',
      req.principal!.label,
      now.toISOString(),
      new Date(now.getTime() + (expiresInMinutes ?? 60 * 24) * 60_000).toISOString(),
    );
    ctx.audit.record(actorOf(req), `command.${type}`, { type: 'device', id: device.id, tenantId: device.tenant_id }, { commandId: id, payload: type === 'agent.run' ? { prompt: String((parsed as any).prompt).slice(0, 200) } : parsed });
    ctx.dispatch(id);
    return commandView(ctx.db.get('SELECT * FROM commands WHERE id = ?', id));
  };

  app.post('/v1/admin/devices/:id/commands', async (req) => {
    requirePerm(req, 'commands.send');
    const d = own(req, 'devices', (req.params as { id: string }).id);
    const body = CommandInput.parse(req.body);
    return queueCommand(req, d, body.type, body.payload, body.expiresInMinutes);
  });

  app.post('/v1/admin/commands/bulk', async (req) => {
    requirePerm(req, 'commands.send');
    const tenantId = requireTenant(req);
    const body = CommandInput.extend({ deviceIds: z.array(z.string()).optional(), groupId: z.string().optional(), all: z.boolean().optional() }).parse(req.body);
    let devices: any[];
    if (body.deviceIds?.length) devices = body.deviceIds.map((id) => own(req, 'devices', id));
    else if (body.groupId) devices = ctx.db.all("SELECT * FROM devices WHERE tenant_id = ? AND group_id = ? AND status = 'active'", tenantId, body.groupId);
    else if (body.all) devices = ctx.db.all("SELECT * FROM devices WHERE tenant_id = ? AND status = 'active'", tenantId);
    else throw badRequest('Choose deviceIds, groupId or all');
    const results = devices.filter((d) => d.status === 'active').map((d) => queueCommand(req, d, body.type, body.payload, body.expiresInMinutes));
    return { queued: results.length, commands: results };
  });

  app.get('/v1/admin/commands', async (req) => {
    requirePerm(req, 'devices.read');
    const tenant = tenantScope(req);
    const q = req.query as { status?: string; limit?: string };
    const rows = ctx.db.all<any>(
      `SELECT c.*, d.name AS device_name FROM commands c JOIN devices d ON d.id = c.device_id WHERE 1=1 ${tenant ? 'AND c.tenant_id = ?' : ''} ${q.status ? 'AND c.status = ?' : ''} ORDER BY c.created_at DESC LIMIT ?`,
      ...([tenant, q.status].filter(Boolean) as string[]),
      Math.min(Number(q.limit ?? 100), 500),
    );
    return rows.map((r) => ({ ...commandView(r), deviceName: r.device_name }));
  });

  app.get('/v1/admin/commands/:id', async (req) => {
    requirePerm(req, 'devices.read');
    return commandView(own(req, 'commands', (req.params as { id: string }).id));
  });

  app.post('/v1/admin/commands/:id/cancel', async (req) => {
    requirePerm(req, 'commands.send');
    const c = own(req, 'commands', (req.params as { id: string }).id);
    if (!['queued', 'sent'].includes(c.status)) throw badRequest(`Command is already ${c.status}`);
    ctx.db.run("UPDATE commands SET status = 'cancelled', completed_at = ? WHERE id = ?", new Date().toISOString(), c.id);
    ctx.audit.record(actorOf(req), 'command.cancelled', { type: 'command', id: c.id, tenantId: c.tenant_id });
    const view = commandView(ctx.db.get('SELECT * FROM commands WHERE id = ?', c.id));
    ctx.realtime.emitAdmin({ type: 'command.updated', tenantId: c.tenant_id, command: view });
    return view;
  });

  // ------------------------------------------------------------------------------------ events
  app.get('/v1/admin/events', async (req) => {
    requirePerm(req, 'devices.read');
    const tenant = tenantScope(req);
    const q = req.query as { severity?: string; limit?: string };
    return ctx.db
      .all<any>(
        `SELECT e.*, d.name AS device_name FROM device_events e JOIN devices d ON d.id = e.device_id WHERE 1=1 ${tenant ? 'AND e.tenant_id = ?' : ''} ${q.severity ? 'AND e.severity = ?' : ''} ORDER BY e.ts DESC LIMIT ?`,
        ...([tenant, q.severity].filter(Boolean) as string[]),
        Math.min(Number(q.limit ?? 200), 1000),
      )
      .map((e) => ({ id: e.id, tenantId: e.tenant_id, deviceId: e.device_id, deviceName: e.device_name, ts: e.ts, kind: e.kind, severity: e.severity, message: e.message, data: parseJson(e.data, null), acknowledgedAt: e.acknowledged_at }));
  });

  app.post('/v1/admin/events/:id/ack', async (req) => {
    requirePerm(req, 'devices.manage');
    const e = own(req, 'device_events', (req.params as { id: string }).id);
    ctx.db.run('UPDATE device_events SET acknowledged_at = ? WHERE id = ?', new Date().toISOString(), e.id);
    return { ok: true };
  });
}
