import { hostname } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { need, type VirtualContext } from '../context';
import { conflict } from '../errors';
import { clampSize, HostTerminals } from '../host-terminal';

/** The ticket's key: a virtual machine's id (a UUID) never has a colon, so a screen ticket cannot open a shell. */
const TICKET = 'host:terminal';

/** Server → Terminal: the server's own shell, for administrators, with every session in the audit log. */
export async function terminalRoutes(app: FastifyInstance, ctx: VirtualContext): Promise<void> {
  const t = ctx.config.terminal;
  const terminals = new HostTerminals(t);
  app.addHook('onClose', async () => terminals.closeAll());

  const state = () => ({
    available: t.enabled,
    reason: t.enabled ? null : process.platform !== 'linux' ? 'The terminal needs a Linux server.' : 'The terminal is off on this server. It is on with FBRX Server (or set FBRX_V_TERMINAL=on).',
    hostname: hostname(),
    recorded: t.recordDir !== null,
    keepDays: t.keepDays,
    open: terminals.count,
  });

  app.get('/v1/host/terminal', async (req) => {
    need(req, 'admin');
    return state();
  });

  app.post('/v1/host/terminal', async (req) => {
    const user = need(req, 'admin');
    if (!t.enabled) throw conflict(state().reason!);
    if (terminals.full) throw conflict('Four terminals are open on this server already. Close one first.');
    return { ticket: ctx.tickets.issue(TICKET, user.username), path: '/v1/host/terminal/ws' };
  });

  app.get('/v1/host/terminal/ws', { websocket: true }, (socket, req) => {
    const q = req.query as { ticket?: string; cols?: string; rows?: string };
    const who = ctx.tickets.take(String(q.ticket ?? ''), TICKET);
    if (!who) return socket.close(4401, 'Ask for a new terminal ticket');
    if (!t.enabled) return socket.close(4409, 'The terminal is off on this server');
    if (terminals.full) return socket.close(4409, 'Too many terminals are open');
    const session = terminals.start(socket, who, clampSize({ cols: Number(q.cols), rows: Number(q.rows) }), (info) =>
      ctx.audit.record(who, 'host.terminal.close', hostname(), 'success', { session: info.id, seconds: info.seconds, reason: info.reason }),
    );
    ctx.audit.record(who, 'host.terminal', hostname(), 'success', { session: session.id, ...(session.recording ? { recording: session.recording } : {}) });
  });
}
