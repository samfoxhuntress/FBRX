import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DOME_STATUSES, normalizeName, type DomeFinding } from '@fbrx/dome';
import { GateError } from '@fbrx/gate/node';
import { audited, need, type VirtualContext } from '../context';
import { badRequest, conflict, notFound } from '../errors';

/** Findings about names: a domain the gate can block. */
const BLOCKABLE = new Set(['bad-domain', 'dns-tunnel']);

/** What the AI is asked when someone wants a finding explained. */
function explainPrompt(f: DomeFinding): string {
  return [
    'You help someone who looks after a home or small-office network understand a security finding from FBRX MiniDome, the threat detector on their FBRX Server gate (it watches the names devices ask for and the connections they make).',
    'Explain in plain words: what it most likely means, how worried to be (and what innocent explanations there are), and three to five concrete next steps, on the device and on the gate (FBRX Gate can block a domain, move a device to a network of its own, or cut it off). Keep it short; no headings.',
    '',
    `Finding: ${f.title}`,
    `Kind: ${f.kind} · severity ${f.severity} · seen ${f.count} time${f.count === 1 ? '' : 's'} since ${f.firstAt}`,
    `Device: ${[f.device.name, f.device.ip, f.device.mac, f.device.network && `network ${f.device.network}`].filter(Boolean).join(', ') || 'unknown'}`,
    `Detail: ${f.detail}`,
    f.evidence.length ? `Evidence:\n${f.evidence.slice(0, 6).join('\n')}` : '',
  ].join('\n');
}

/** FBRX MiniDome (the minidome role): what it saw, the devices, its settings, explanations and blocking. */
export async function domeRoutes(app: FastifyInstance, ctx: VirtualContext) {
  const dome = () => {
    if (!ctx.dome) throw conflict('FBRX MiniDome is not on this server (install.sh --roles …,gate,minidome adds it)');
    return ctx.dome;
  };
  const finding = (id: string) => {
    const f = dome().finding(Number(id));
    if (!f) throw notFound('There is no such finding');
    return f;
  };

  app.get('/v1/dome', async (req) => {
    need(req, 'viewer');
    return dome().state();
  });

  app.get<{ Querystring: { status?: string; limit?: string } }>('/v1/dome/findings', async (req) => {
    need(req, 'viewer');
    const q = z.object({ status: z.enum([...DOME_STATUSES, 'active']).optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) }).parse(req.query);
    return { findings: dome().findings(q.status, q.limit) };
  });

  app.post<{ Params: { id: string } }>('/v1/dome/findings/:id', async (req) => {
    need(req, 'operator');
    const { status } = z.object({ status: z.enum(DOME_STATUSES) }).parse(req.body);
    const f = finding(req.params.id);
    return audited(ctx, req, `dome.${status}`, f.title, () => ({ finding: dome().setStatus(f.id, status) }));
  });

  /** This server's AI (the ai role) explains a finding in plain words, with next steps. */
  app.post<{ Params: { id: string } }>('/v1/dome/findings/:id/explain', async (req) => {
    const user = need(req, 'operator');
    const f = finding(req.params.id);
    const r = await ctx.core.call<{ answer: string; model: string }>('ai.quick', { reqId: randomUUID(), prompt: explainPrompt(f) }, user.username, 120_000);
    return { answer: r.answer, model: r.model };
  });

  /** Blocks the finding's domain on the gate: added to what is being edited, for a commit. */
  app.post<{ Params: { id: string } }>('/v1/dome/findings/:id/block', async (req, reply) => {
    const user = need(req, 'admin');
    const f = finding(req.params.id);
    if (!BLOCKABLE.has(f.kind) || !f.subject) throw badRequest('Only findings about a domain can be blocked');
    if (!ctx.gate) throw conflict('Blocking needs FBRX Gate on this server');
    const domain = normalizeName(f.subject);
    const c = structuredClone(ctx.gate.engine.candidate());
    c.dns.block.enabled = true;
    if (!c.dns.block.domains.includes(domain)) c.dns.block.domains.push(domain);
    try {
      ctx.gate.engine.setCandidate(c, user.username);
    } catch (e) {
      if (e instanceof GateError) return reply.status(400).send({ error: { code: e.code, message: e.message, issues: e.issues } });
      throw e;
    }
    ctx.audit.record(user.username, 'dome.block', domain, 'success', { finding: f.id });
    return { domain, state: ctx.gate.engine.state() };
  });

  app.get('/v1/dome/devices', async (req) => {
    need(req, 'viewer');
    return { devices: await dome().devices() };
  });

  app.put('/v1/dome/settings', async (req) => {
    need(req, 'admin');
    const { settings } = z.object({ settings: z.unknown() }).parse(req.body);
    return audited(ctx, req, 'dome.settings', null, () => ({ settings: dome().setSettings(settings), state: dome().state() }));
  });

  app.post('/v1/dome/feeds/refresh', async (req) => {
    need(req, 'admin');
    return { ...(await dome().refreshFeeds()), state: dome().state() };
  });
}
