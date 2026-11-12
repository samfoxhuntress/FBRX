import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DEFAULT_HIVE, type Heartbeat, type HivePolicy, type OrgMeshPeer, type OrgMeshRoster } from '@fbrx/shared';
import type { AppContext } from '../context';
import { actorOf, adminAuth, deviceAuth, requirePerm, requireTenant } from '../auth';
import { badRequest, notFound } from '../errors';

/** Computers that have not reported for this long are left out of the roster. */
const STALE_DAYS = 30;

interface Member {
  id: string;
  name: string;
  groupId: string | null;
  lastSeenAt: string | null;
  mesh: NonNullable<Heartbeat['status']['mesh']>;
}

export function meshAutoOf(t: { mesh_auto?: number | null } | undefined): boolean {
  return Number(t?.mesh_auto ?? 1) === 1;
}

export function hiveOf(t: { hive?: string | null } | undefined): HivePolicy {
  try {
    const h = t?.hive ? (JSON.parse(t.hive) as HivePolicy) : null;
    return h && (h.groups === 'all' || Array.isArray(h.groups)) ? h : DEFAULT_HIVE;
  } catch {
    return DEFAULT_HIVE;
  }
}

/** The organization's computers that report a mesh identity. */
function members(ctx: AppContext, tenantId: string): Member[] {
  const since = new Date(Date.now() - STALE_DAYS * 86400_000).toISOString();
  return ctx.db
    .all<{ id: string; name: string; group_id: string | null; last_seen_at: string | null; heartbeat: string | null }>(
      "SELECT id, name, group_id, last_seen_at, heartbeat FROM devices WHERE tenant_id = ? AND status = 'active' AND (last_seen_at IS NULL OR last_seen_at >= ?) ORDER BY name COLLATE NOCASE",
      tenantId,
      since,
    )
    .flatMap((d) => {
      let mesh: Member['mesh'] | null | undefined = null;
      try {
        mesh = d.heartbeat ? (JSON.parse(d.heartbeat) as Heartbeat).status.mesh : null;
      } catch {
        mesh = null;
      }
      return mesh?.publicKey ? [{ id: d.id, name: d.name, groupId: d.group_id, lastSeenAt: d.last_seen_at, mesh }] : [];
    });
}

/**
 * What `peer` may do on `me`, decided by the organization: see each other and exchange messages; a server's AI is
 * lent to the groups the hive allows (Mesh Assist, under that server's own settings); a server's MiniDome may warn a
 * computer about threats it sees. Nothing else (the agent, approvals, tasks, control stay with each computer).
 */
function grants(me: Member, peer: Member, hive: HivePolicy, chat: boolean): OrgMeshPeer['permissions'] {
  const inHive = hive.groups === 'all' || (peer.groupId !== null && hive.groups.includes(peer.groupId));
  return {
    status: true,
    chat,
    assist: me.mesh.roles.includes('ai') && inHive,
    network: peer.mesh.roles.includes('minidome'),
    ask: false,
    approve: false,
    workspace: false,
    alerts: false,
    control: false,
    command: false,
  };
}

/**
 * The organization's FBRX Mesh: every computer in an organization meets the others without pairing codes, because
 * FBRX Command vouches for their keys (each one reports its own in its heartbeat, over the enrolled connection). The
 * organization chooses whether its computers mesh, and which groups may use its servers' AI (the hive).
 */
export async function meshRoutes(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const tenantRow = (id: string) => db.get<{ id: string; name: string; mesh_auto: number; hive: string | null; chat_enabled: number }>('SELECT id, name, mesh_auto, hive, chat_enabled FROM tenants WHERE id = ?', id);

  await app.register(async (dev) => {
    dev.addHook('preHandler', deviceAuth(ctx));
    dev.get('/v1/device/mesh/roster', async (req): Promise<OrgMeshRoster> => {
      const d = req.device!;
      const t = tenantRow(d.tenant_id);
      if (!t) throw notFound();
      const enabled = meshAutoOf(t);
      const all = enabled ? members(ctx, t.id) : [];
      const me = all.find((m) => m.id === d.id);
      const hive = hiveOf(t);
      const chat = Number(t.chat_enabled ?? 1) === 1;
      const peers = me
        ? all
            .filter((p) => p.id !== d.id && p.mesh.fingerprint !== me.mesh.fingerprint)
            .map((p) => ({ deviceId: p.id, name: p.name, publicKey: p.mesh.publicKey, fingerprint: p.mesh.fingerprint, port: p.mesh.port, addresses: p.mesh.addresses, roles: p.mesh.roles, permissions: grants(me, p, hive, chat) }))
        : [];
      return { enabled, tenantId: t.id, tenantName: t.name, peers };
    });
  });

  await app.register(async (admin) => {
    admin.addHook('preHandler', adminAuth(ctx));
    const view = (tenantId: string) => {
      const t = tenantRow(tenantId);
      if (!t) throw notFound();
      const groups = db.all<{ id: string; name: string }>('SELECT id, name FROM groups WHERE tenant_id = ? ORDER BY name COLLATE NOCASE', tenantId);
      const groupName = new Map(groups.map((g) => [g.id, g.name]));
      const computers = members(ctx, tenantId).map((m) => ({
        deviceId: m.id,
        name: m.name,
        group: m.groupId ? (groupName.get(m.groupId) ?? null) : null,
        online: ctx.realtime.isOnline(m.id),
        meshOn: m.mesh.enabled && m.mesh.running,
        roles: m.mesh.roles,
        addresses: m.mesh.addresses,
        lastSeenAt: m.lastSeenAt,
      }));
      return { meshAuto: meshAutoOf(t), hive: hiveOf(t), groups, computers, servers: computers.filter((c) => c.roles.includes('ai')) };
    };

    admin.get('/v1/admin/mesh', async (req) => {
      requirePerm(req, 'devices.read');
      return view(requireTenant(req));
    });

    admin.put('/v1/admin/mesh', async (req: FastifyRequest) => {
      requirePerm(req, 'config.manage');
      const tenantId = requireTenant(req);
      const body = z
        .object({ meshAuto: z.boolean().optional(), hive: z.object({ groups: z.union([z.literal('all'), z.array(z.string().max(64)).max(200)]) }).optional() })
        .strict()
        .parse(req.body);
      const t = tenantRow(tenantId);
      if (!t) throw notFound();
      if (body.hive && body.hive.groups !== 'all') {
        const known = new Set(db.all<{ id: string }>('SELECT id FROM groups WHERE tenant_id = ?', tenantId).map((g) => g.id));
        const unknown = body.hive.groups.filter((g) => !known.has(g));
        if (unknown.length) throw badRequest(`Unknown group ${unknown[0]}`);
      }
      db.run(
        'UPDATE tenants SET mesh_auto = ?, hive = ?, updated_at = ? WHERE id = ?',
        body.meshAuto === undefined ? Number(t.mesh_auto ?? 1) : body.meshAuto ? 1 : 0,
        body.hive ? JSON.stringify(body.hive) : t.hive,
        new Date().toISOString(),
        tenantId,
      );
      ctx.audit.record(actorOf(req), 'mesh.updated', { type: 'tenant', id: tenantId, tenantId }, body);
      // Every computer fetches its roster again, so a change takes effect at once.
      ctx.realtime.broadcastToTenantDevices(tenantId, { type: 'mesh.roster' });
      return view(tenantId);
    });
  });
}

/** A computer's mesh identity changed (first report, a new key, new addresses or roles): the others look again. */
export function meshIdentityChanged(prev: Heartbeat | null, next: Heartbeat): boolean {
  const a = prev?.status.mesh ?? null;
  const b = next.status.mesh ?? null;
  if (!a || !b) return !!a !== !!b;
  return a.publicKey !== b.publicKey || a.port !== b.port || a.enabled !== b.enabled || a.addresses.join() !== b.addresses.join() || a.roles.join() !== b.roles.join();
}
