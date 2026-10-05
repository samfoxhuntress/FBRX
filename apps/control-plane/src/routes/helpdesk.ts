import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  OPEN_TICKET_STATUSES,
  TICKET_STATUSES,
  TICKET_STATUS_NAMES,
  TicketCreateSchema,
  TicketReplySchema,
  TicketUpdateSchema,
  type HelpdeskStatus,
  type TicketDetail,
  type TicketMessage,
  type TicketStatus,
  type TicketSummary,
} from '@fbrx/shared';
import type { AppContext } from '../context';
import { ids } from '../context';
import { actorOf, adminAuth, assertTenantAccess, deviceAuth, requirePerm, tenantScope } from '../auth';
import { HttpError, badRequest, forbidden, notFound } from '../errors';
import { parseJson } from './util';

/**
 * The help desk. Computers in an organization send tickets from their Help desk tab; FBRX Command keeps each ticket
 * and its conversation, and pushes every change at once to the computer that asked and to the computers chosen as
 * receivers (Devices → a device → Receives help desk tickets), over the live connection each one already keeps open.
 * Admins answer from FBRX Command too. Tickets wait here while a receiver is switched off, so nothing is lost.
 */
export async function helpdeskRoutes(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  const summary = (t: any): TicketSummary => ({
    id: t.id,
    number: Number(t.number),
    subject: t.subject,
    category: t.category,
    priority: t.priority,
    status: t.status,
    requesterName: t.requester_name,
    deviceId: t.device_id,
    deviceName: t.device_id ? (db.get<{ name: string }>('SELECT name FROM devices WHERE id = ?', t.device_id)?.name ?? null) : null,
    assigneeName: t.assignee_name,
    messageCount: Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ticket_messages WHERE ticket_id = ?', t.id)?.n ?? 0),
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    resolvedAt: t.resolved_at,
  });
  const detail = (t: any): TicketDetail => ({
    ...summary(t),
    diagnostics: parseJson<Record<string, unknown> | null>(t.diagnostics, null),
    thread: db
      .all<any>('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at, rowid', t.id)
      .map((m): TicketMessage => ({ id: m.id, authorKind: m.author_kind, authorName: m.author_name, body: m.body, createdAt: m.created_at })),
  });

  const receivers = (tenantId: string) => db.all<{ id: string }>("SELECT id FROM devices WHERE tenant_id = ? AND helpdesk_receiver = 1 AND status = 'active'", tenantId);
  const helpdeskOn = (tenantId: string) => Number(db.get<{ v: number }>('SELECT helpdesk_enabled AS v FROM tenants WHERE id = ?', tenantId)?.v ?? 1) === 1;

  /** Tells the asker, every receiver and the open consoles that a ticket changed. */
  const announce = (t: any, reason: 'created' | 'message' | 'updated') => {
    const targets = new Set<string>(receivers(t.tenant_id).map((r) => r.id));
    if (t.device_id) targets.add(t.device_id);
    for (const id of targets) ctx.realtime.sendToDevice(id, { type: 'helpdesk.changed', ticketId: t.id, number: Number(t.number), reason, subject: t.subject });
    const view = summary(t);
    ctx.realtime.emitAdmin({ type: 'ticket.updated', tenantId: t.tenant_id, ticket: view });
    ctx.webhooks.emit(t.tenant_id, reason === 'created' ? 'ticket.created' : 'ticket.updated', { ticket: view, reason });
  };

  const addMessage = (t: any, kind: TicketMessage['authorKind'], name: string, body: string, who: { deviceId?: string | null; userId?: string | null } = {}) => {
    const now = new Date().toISOString();
    db.run(
      'INSERT INTO ticket_messages (id, ticket_id, tenant_id, author_kind, author_name, author_device_id, author_user_id, body, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      ids.ticketMessage(),
      t.id,
      t.tenant_id,
      kind,
      name.slice(0, 100) || 'Someone',
      who.deviceId ?? null,
      who.userId ?? null,
      body,
      now,
    );
    db.run('UPDATE tickets SET updated_at = ? WHERE id = ?', now, t.id);
  };

  /** Applies a status, priority or assignment change, noting it in the conversation. */
  const update = (t: any, change: z.infer<typeof TicketUpdateSchema>, by: { name: string; deviceId?: string | null; userId?: string | null }) => {
    const now = new Date().toISOString();
    const notes: string[] = [];
    let status: TicketStatus = t.status;
    let taken = false;
    if (change.assignToMe) {
      db.run('UPDATE tickets SET assignee_device_id = ?, assignee_name = ? WHERE id = ?', by.deviceId ?? null, by.name, t.id);
      taken = true;
      if (status === 'open') status = 'in_progress';
    }
    if (change.status && change.status !== t.status) status = change.status;
    if (taken) notes.push(`${by.name} took this ticket${status !== t.status ? ` (${TICKET_STATUS_NAMES[status].toLowerCase()})` : ''}`);
    else if (status !== t.status) notes.push(`${by.name}: ${TICKET_STATUS_NAMES[status]}`);
    if (status !== t.status) {
      db.run('UPDATE tickets SET status = ?, resolved_at = ? WHERE id = ?', status, status === 'resolved' || status === 'closed' ? now : null, t.id);
    }
    if (change.priority && change.priority !== t.priority) {
      notes.push(`${by.name} set the priority to ${change.priority}`);
      db.run('UPDATE tickets SET priority = ? WHERE id = ?', change.priority, t.id);
    }
    for (const n of notes) addMessage(t, 'system', 'FBRX Command', n);
    db.run('UPDATE tickets SET updated_at = ? WHERE id = ?', now, t.id);
    return db.get<any>('SELECT * FROM tickets WHERE id = ?', t.id);
  };

  const listQuery = z.object({ state: z.enum(['open', 'closed', 'all']).default('open'), scope: z.enum(['mine', 'queue']).default('mine'), limit: z.coerce.number().int().min(1).max(500).default(200) });
  const stateWhere = (state: 'open' | 'closed' | 'all') =>
    state === 'all' ? '' : state === 'open' ? `AND status IN (${OPEN_TICKET_STATUSES.map((s) => `'${s}'`).join(',')})` : "AND status IN ('resolved','closed')";

  // ------------------------------------------------------------------------------- computers
  await app.register(async (dev) => {
    dev.addHook('preHandler', deviceAuth(ctx));
    const me = (req: FastifyRequest) => req.device!;
    const isReceiver = (req: FastifyRequest) => Number((db.get<{ r: number }>('SELECT helpdesk_receiver AS r FROM devices WHERE id = ?', me(req).id)?.r ?? 0)) === 1;
    const ticketFor = (req: FastifyRequest, id: string) => {
      const t = db.get<any>('SELECT * FROM tickets WHERE id = ? AND tenant_id = ?', id, me(req).tenant_id);
      if (!t) throw notFound('Unknown ticket');
      if (t.device_id !== me(req).id && !isReceiver(req)) throw forbidden('This ticket belongs to another computer');
      return t;
    };

    dev.get('/v1/device/helpdesk', async (req): Promise<HelpdeskStatus> => {
      const d = me(req);
      const tenant = db.get<{ name: string }>('SELECT name FROM tenants WHERE id = ?', d.tenant_id);
      const on = helpdeskOn(d.tenant_id);
      return { available: on, message: on ? null : 'Your organization does not use the FBRX help desk', receiver: on && isReceiver(req), receivers: receivers(d.tenant_id).length, organization: tenant?.name ?? null };
    });

    dev.get('/v1/device/helpdesk/tickets', async (req) => {
      const d = me(req);
      const q = listQuery.parse(req.query);
      if (q.scope === 'queue' && !isReceiver(req)) throw forbidden('This computer does not receive help desk tickets');
      const rows =
        q.scope === 'queue'
          ? db.all<any>(`SELECT * FROM tickets WHERE tenant_id = ? ${stateWhere(q.state)} ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, updated_at DESC LIMIT ?`, d.tenant_id, q.limit)
          : db.all<any>(`SELECT * FROM tickets WHERE tenant_id = ? AND device_id = ? ${stateWhere(q.state)} ORDER BY updated_at DESC LIMIT ?`, d.tenant_id, d.id, q.limit);
      return rows.map(summary);
    });

    dev.post('/v1/device/helpdesk/tickets', async (req) => {
      const d = me(req);
      if (!helpdeskOn(d.tenant_id)) throw forbidden('Your organization does not use the FBRX help desk');
      // A stuck script or a curious student should not flood IT.
      const lastHour = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tickets WHERE device_id = ? AND created_at > ?', d.id, new Date(Date.now() - 3600_000).toISOString())?.n ?? 0);
      if (lastHour >= 20) throw new HttpError(429, 'This computer sent a lot of tickets in the last hour. Please wait a little, or add to an open ticket.', 'RATE_LIMITED');
      const body = TicketCreateSchema.parse(req.body);
      const id = ids.ticket();
      const now = new Date().toISOString();
      const t = db.tx(() => {
        const number = Number(db.get<{ n: number }>('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tickets WHERE tenant_id = ?', d.tenant_id)?.n ?? 1);
        db.run(
          'INSERT INTO tickets (id, tenant_id, number, device_id, requester_name, subject, category, priority, status, diagnostics, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          id,
          d.tenant_id,
          number,
          d.id,
          body.requesterName || d.name,
          body.subject,
          body.category,
          body.priority,
          'open',
          body.diagnostics ? JSON.stringify(body.diagnostics).slice(0, 50_000) : null,
          now,
          now,
        );
        const row = db.get<any>('SELECT * FROM tickets WHERE id = ?', id);
        addMessage(row, 'requester', body.requesterName || d.name, body.body, { deviceId: d.id });
        return row;
      });
      ctx.audit.record(actorOf(req), 'ticket.created', { type: 'ticket', id, tenantId: d.tenant_id }, { number: t.number, subject: body.subject, category: body.category, priority: body.priority });
      announce(t, 'created');
      return detail(db.get<any>('SELECT * FROM tickets WHERE id = ?', id));
    });

    dev.get('/v1/device/helpdesk/tickets/:id', async (req) => detail(ticketFor(req, (req.params as { id: string }).id)));

    dev.post('/v1/device/helpdesk/tickets/:id/messages', async (req) => {
      const t = ticketFor(req, (req.params as { id: string }).id);
      const body = TicketReplySchema.extend({ authorName: z.string().max(100).optional() }).parse(req.body);
      const d = me(req);
      const asker = t.device_id === d.id;
      addMessage(t, asker ? 'requester' : 'helpdesk', body.authorName || (asker ? t.requester_name : d.name), body.body, { deviceId: d.id });
      // The asker answering a question puts it back in the queue; a closed ticket that gets a reply opens again.
      if (asker && ['waiting', 'resolved', 'closed'].includes(t.status)) db.run("UPDATE tickets SET status = 'open', resolved_at = NULL WHERE id = ?", t.id);
      const row = db.get<any>('SELECT * FROM tickets WHERE id = ?', t.id);
      announce(row, 'message');
      return detail(row);
    });

    dev.patch('/v1/device/helpdesk/tickets/:id', async (req) => {
      const t = ticketFor(req, (req.params as { id: string }).id);
      const body = TicketUpdateSchema.extend({ authorName: z.string().max(100).optional() }).parse(req.body);
      const d = me(req);
      const receiver = isReceiver(req);
      // The person who asked can say it is fixed (or not); receivers run the ticket.
      if (!receiver && (body.assignToMe || body.priority || (body.status && !['resolved', 'closed', 'open'].includes(body.status)))) throw forbidden('Only the help desk can do that');
      const row = update(t, body, { name: body.authorName || (t.device_id === d.id ? t.requester_name : d.name), deviceId: d.id });
      ctx.audit.record(actorOf(req), 'ticket.updated', { type: 'ticket', id: t.id, tenantId: t.tenant_id }, body);
      announce(row, 'updated');
      return detail(row);
    });
  });

  // ------------------------------------------------------------------------------- FBRX Command
  await app.register(async (admin) => {
    admin.addHook('preHandler', adminAuth(ctx));
    const own = (req: FastifyRequest, id: string) => {
      const t = db.get<any>('SELECT * FROM tickets WHERE id = ?', id);
      if (!t) throw notFound('Unknown ticket');
      assertTenantAccess(req, t.tenant_id);
      return t;
    };

    admin.get('/v1/admin/helpdesk/tickets', async (req) => {
      requirePerm(req, 'helpdesk.read');
      const tenant = tenantScope(req);
      const q = listQuery.omit({ scope: true }).extend({ status: z.enum(TICKET_STATUSES).optional() }).parse(req.query);
      const where = q.status ? `AND status = '${q.status}'` : stateWhere(q.state);
      const rows = tenant
        ? db.all<any>(`SELECT * FROM tickets WHERE tenant_id = ? ${where} ORDER BY updated_at DESC LIMIT ?`, tenant, q.limit)
        : db.all<any>(`SELECT * FROM tickets WHERE 1=1 ${where} ORDER BY updated_at DESC LIMIT ?`, q.limit);
      return rows.map(summary);
    });

    admin.get('/v1/admin/helpdesk/tickets/:id', async (req) => {
      requirePerm(req, 'helpdesk.read');
      return detail(own(req, (req.params as { id: string }).id));
    });

    admin.post('/v1/admin/helpdesk/tickets/:id/messages', async (req) => {
      const p = requirePerm(req, 'helpdesk.manage');
      const t = own(req, (req.params as { id: string }).id);
      const body = TicketReplySchema.parse(req.body);
      addMessage(t, 'helpdesk', p.label, body.body, { userId: p.id });
      const row = db.get<any>('SELECT * FROM tickets WHERE id = ?', t.id);
      announce(row, 'message');
      return detail(row);
    });

    admin.patch('/v1/admin/helpdesk/tickets/:id', async (req) => {
      const p = requirePerm(req, 'helpdesk.manage');
      const t = own(req, (req.params as { id: string }).id);
      const body = TicketUpdateSchema.parse(req.body);
      const row = update(t, body, { name: p.label, userId: p.id });
      ctx.audit.record(actorOf(req), 'ticket.updated', { type: 'ticket', id: t.id, tenantId: t.tenant_id }, body);
      announce(row, 'updated');
      return detail(row);
    });

    /** Which computers receive tickets, and whether the help desk is on. */
    admin.get('/v1/admin/helpdesk', async (req) => {
      requirePerm(req, 'helpdesk.read');
      const tenant = tenantScope(req);
      if (!tenant) throw badRequest('Select an organization');
      const devices = db.all<any>("SELECT id, name, hostname, platform FROM devices WHERE tenant_id = ? AND helpdesk_receiver = 1 AND status = 'active' ORDER BY name", tenant);
      const counts = db.get<{ open: number; total: number }>(
        `SELECT SUM(CASE WHEN status IN (${OPEN_TICKET_STATUSES.map((s) => `'${s}'`).join(',')}) THEN 1 ELSE 0 END) AS open, COUNT(*) AS total FROM tickets WHERE tenant_id = ?`,
        tenant,
      );
      return { enabled: helpdeskOn(tenant), receivers: devices.map((d) => ({ ...d, online: ctx.realtime.isOnline(d.id) })), open: Number(counts?.open ?? 0), total: Number(counts?.total ?? 0) };
    });
  });
}
