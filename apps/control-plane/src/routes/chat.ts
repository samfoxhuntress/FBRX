import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MESSAGE_MAX_CHARS, OrgChatSendSchema, type OrgChatMessage, type OrgChatState } from '@fbrx/shared';
import type { AppContext } from '../context';
import { ids } from '../context';
import { actorOf, adminAuth, assertTenantAccess, deviceAuth, requirePerm, tenantScope } from '../auth';
import { HttpError, badRequest, forbidden, notFound } from '../errors';

/** Organization messages are kept this long, then dropped. */
const KEEP_DAYS = 180;
/** Messages one computer may send in a minute (a stuck script should not flood everyone). */
const PER_MINUTE = 30;

/**
 * Messages between an organization's computers (the Messages page on each one). FBRX Command keeps each conversation
 * and pushes every new message at once over the live connection the computers already keep open, so a computer that
 * was off finds its messages when it comes back. Conversations are "all" (everyone in the organization, where
 * FBRX Command's own people can post too) and one computer to another.
 */
export async function chatRoutes(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const chatOn = (tenantId: string) => Number(db.get<{ v: number }>('SELECT chat_enabled AS v FROM tenants WHERE id = ?', tenantId)?.v ?? 1) === 1;
  const dmKey = (a: string, b: string) => (a < b ? `dm:${a}:${b}` : `dm:${b}:${a}`);
  /** The conversation as `me` sees it: "all" or the other computer's id. */
  const withOf = (conversation: string, me: string) => (conversation === 'all' ? 'all' : (conversation.split(':').slice(1).find((x) => x !== me) ?? me));
  const keyFor = (me: string, to: string) => (to === 'all' ? 'all' : dmKey(me, to));
  const view = (m: any, me: string): OrgChatMessage => ({
    id: m.id,
    with: withOf(m.conversation, me),
    fromDeviceId: m.from_device_id,
    fromName: m.from_name,
    fromKind: m.from_kind,
    text: m.text,
    at: m.created_at,
  });
  const readAt = (deviceId: string, conversation: string) => db.get<{ read_at: string }>('SELECT read_at FROM chat_reads WHERE device_id = ? AND conversation = ?', deviceId, conversation)?.read_at ?? '';
  const markRead = (deviceId: string, conversation: string, at = new Date().toISOString()) =>
    db.run('INSERT INTO chat_reads (device_id, conversation, read_at) VALUES (?, ?, ?) ON CONFLICT (device_id, conversation) DO UPDATE SET read_at = excluded.read_at', deviceId, conversation, at);

  /** Stores a message and hands it to every computer in the conversation that is online (the rest fetch it later). */
  const post = (tenantId: string, conversation: string, from: { deviceId?: string; userId?: string; name: string; kind: 'device' | 'admin' }, text: string) => {
    const now = new Date().toISOString();
    const row = { id: ids.chatMessage(), tenant_id: tenantId, conversation, from_device_id: from.deviceId ?? null, from_user_id: from.userId ?? null, from_name: from.name.slice(0, 100) || 'Someone', from_kind: from.kind, text, created_at: now };
    db.run(
      'INSERT INTO chat_messages (id, tenant_id, conversation, from_device_id, from_user_id, from_name, from_kind, text, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      row.id,
      row.tenant_id,
      row.conversation,
      row.from_device_id,
      row.from_user_id,
      row.from_name,
      row.from_kind,
      row.text,
      row.created_at,
    );
    db.run('DELETE FROM chat_messages WHERE tenant_id = ? AND created_at < ?', tenantId, new Date(Date.now() - KEEP_DAYS * 86400_000).toISOString());
    if (from.deviceId) markRead(from.deviceId, conversation, now);
    const targets =
      conversation === 'all'
        ? db.all<{ id: string }>("SELECT id FROM devices WHERE tenant_id = ? AND status = 'active'", tenantId).map((d) => d.id)
        : conversation.split(':').slice(1);
    for (const id of targets) if (id !== from.deviceId) ctx.realtime.sendToDevice(id, { type: 'chat.message', message: view(row, id) });
    if (conversation === 'all') ctx.realtime.emitAdmin({ type: 'chat.message', tenantId, message: view(row, '') });
    return row;
  };

  // ------------------------------------------------------------------------------- computers
  await app.register(async (dev) => {
    dev.addHook('preHandler', deviceAuth(ctx));
    const me = (req: FastifyRequest) => req.device!;
    const peer = (tenantId: string, id: string) => db.get<{ id: string }>("SELECT id FROM devices WHERE id = ? AND tenant_id = ? AND status = 'active'", id, tenantId);

    dev.get('/v1/device/chat', async (req): Promise<OrgChatState> => {
      const d = me(req);
      const tenant = db.get<{ name: string }>('SELECT name FROM tenants WHERE id = ?', d.tenant_id);
      const on = chatOn(d.tenant_id);
      const base = { available: on, message: on ? null : 'Your organization has turned off messages between computers', organization: tenant?.name ?? null, me: d.id };
      if (!on) return { ...base, peers: [], conversations: [] };
      const peers = db
        .all<any>("SELECT id, name, platform FROM devices WHERE tenant_id = ? AND status = 'active' AND id != ? ORDER BY name COLLATE NOCASE", d.tenant_id, d.id)
        .map((p) => ({ deviceId: p.id, name: p.name, platform: p.platform, online: ctx.realtime.isOnline(p.id) }));
      const keys = db.all<{ conversation: string }>(
        "SELECT DISTINCT conversation FROM chat_messages WHERE tenant_id = ? AND (conversation = 'all' OR conversation LIKE ? OR conversation LIKE ?)",
        d.tenant_id,
        `dm:${d.id}:%`,
        `dm:%:${d.id}`,
      );
      const conversations = keys.map(({ conversation }) => {
        const last = db.get<any>('SELECT * FROM chat_messages WHERE tenant_id = ? AND conversation = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', d.tenant_id, conversation);
        const unread = Number(
          db.get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM chat_messages WHERE tenant_id = ? AND conversation = ? AND created_at > ? AND (from_device_id IS NULL OR from_device_id != ?)',
            d.tenant_id,
            conversation,
            readAt(d.id, conversation),
            d.id,
          )?.n ?? 0,
        );
        return { with: withOf(conversation, d.id), last: last ? view(last, d.id) : null, unread };
      });
      return { ...base, peers, conversations };
    });

    dev.get('/v1/device/chat/messages', async (req) => {
      const d = me(req);
      const q = z.object({ with: z.string().min(1).max(80), before: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(req.query);
      if (!chatOn(d.tenant_id)) throw forbidden('Your organization has turned off messages between computers');
      const conversation = keyFor(d.id, q.with);
      const rows = db.all<any>(
        `SELECT * FROM chat_messages WHERE tenant_id = ? AND conversation = ? ${q.before ? 'AND created_at < ?' : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        ...[d.tenant_id, conversation, ...(q.before ? [q.before] : []), q.limit],
      );
      return rows.reverse().map((m) => view(m, d.id));
    });

    dev.post('/v1/device/chat/messages', async (req): Promise<OrgChatMessage> => {
      const d = me(req);
      if (!chatOn(d.tenant_id)) throw forbidden('Your organization has turned off messages between computers');
      const body = OrgChatSendSchema.parse(req.body);
      if (body.to !== 'all' && (body.to === d.id || !peer(d.tenant_id, body.to))) throw notFound('That computer is not in your organization');
      const lastMinute = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_messages WHERE from_device_id = ? AND created_at > ?', d.id, new Date(Date.now() - 60_000).toISOString())?.n ?? 0);
      if (lastMinute >= PER_MINUTE) throw new HttpError(429, 'That is a lot of messages in a minute. Please wait a moment.', 'RATE_LIMITED');
      const row = post(d.tenant_id, keyFor(d.id, body.to), { deviceId: d.id, name: body.fromName?.trim() || d.name, kind: 'device' }, body.text);
      return view(row, d.id);
    });

    dev.post('/v1/device/chat/read', async (req) => {
      const d = me(req);
      const body = z.object({ with: z.string().min(1).max(80) }).parse(req.body);
      markRead(d.id, keyFor(d.id, body.with));
      return { ok: true };
    });
  });

  // ------------------------------------------------------------------------------- FBRX Command
  await app.register(async (admin) => {
    admin.addHook('preHandler', adminAuth(ctx));
    const tenantOf = (req: FastifyRequest) => {
      const t = tenantScope(req);
      if (!t) throw badRequest('Select an organization');
      assertTenantAccess(req, t);
      return t;
    };

    /** The organization-wide conversation (one computer to another stays between those two). */
    admin.get('/v1/admin/chat/messages', async (req) => {
      requirePerm(req, 'messages.read');
      const tenant = tenantOf(req);
      const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(req.query);
      return {
        enabled: chatOn(tenant),
        messages: db
          .all<any>("SELECT * FROM chat_messages WHERE tenant_id = ? AND conversation = 'all' ORDER BY created_at DESC, rowid DESC LIMIT ?", tenant, q.limit)
          .reverse()
          .map((m) => view(m, '')),
      };
    });

    admin.post('/v1/admin/chat/messages', async (req) => {
      const p = requirePerm(req, 'messages.manage');
      const tenant = tenantOf(req);
      if (!chatOn(tenant)) throw forbidden('Messages are turned off for this organization');
      const body = z.object({ text: z.string().trim().min(1).max(MESSAGE_MAX_CHARS) }).parse(req.body);
      const name = (p.kind === 'user' ? db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', p.id)?.name : null) || p.label;
      const row = post(tenant, 'all', { userId: p.id, name, kind: 'admin' }, body.text);
      ctx.audit.record(actorOf(req), 'chat.posted', { type: 'chat', id: row.id, tenantId: tenant }, { length: body.text.length });
      return view(row, '');
    });

    admin.delete('/v1/admin/chat/messages/:id', async (req) => {
      requirePerm(req, 'messages.manage');
      const tenant = tenantOf(req);
      const { id } = req.params as { id: string };
      const m = db.get<any>("SELECT * FROM chat_messages WHERE id = ? AND tenant_id = ? AND conversation = 'all'", id, tenant);
      if (!m) throw notFound('Unknown message');
      db.run('DELETE FROM chat_messages WHERE id = ?', id);
      ctx.audit.record(actorOf(req), 'chat.removed', { type: 'chat', id, tenantId: tenant }, { from: m.from_name });
      return { ok: true };
    });
  });
}
