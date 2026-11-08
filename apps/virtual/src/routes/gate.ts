import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import QRCode from 'qrcode';
import { hostRange, intToIPv4, ipv4ToInt } from '@fbrx/shared';
import { randomUUID } from 'node:crypto';
import { checkConfig, DEFAULT_PATHS, peerConfig, render, whatIf, type GateChange, type GateConfig, type WhatIfReport } from '@fbrx/gate';
import { GateError, wgKeyPair } from '@fbrx/gate/node';
import { audited, need, type VirtualContext } from '../context';
import { conflict } from '../errors';

/** The address a request came from, as IPv4 ("::ffff:192.168.1.5" is 192.168.1.5). */
const clientIp = (ip: string) => ip.replace(/^::ffff:/, '');

const verdictWords = (v: { verdict: string; because: string }) => `${v.verdict} (${v.because})`;

/** What the server's AI is asked about a change: the differences and what What If found, short. */
function whatIfPrompt(changes: GateChange[], r: WhatIfReport): string {
  const moved = r.matrix.filter((m) => (m.before.verdict === 'allowed') !== (m.after.verdict === 'allowed'));
  return [
    'You help someone who looks after a home or small-office network decide whether to commit a change to FBRX Gate, the firewall and router on their FBRX Server.',
    'FBRX worked out exactly what the change does to traffic (below). Explain in plain words: what the change does, what could go wrong (who loses access to what, whether they could lock themselves out), and whether to commit it on trial (it undoes itself unless kept) or change something first. Keep it short; no headings.',
    '',
    `The change (${changes.length} difference${changes.length === 1 ? '' : 's'}):`,
    ...changes.slice(0, 30).map((c) => `- ${c.kind} ${c.path.replace(/^\./, '')}${c.kind !== 'added' ? ` (was ${JSON.stringify(c.from)?.slice(0, 120)})` : ''}${c.kind !== 'removed' ? ` (becomes ${JSON.stringify(c.to)?.slice(0, 120)})` : ''}`),
    '',
    r.you ? `The person is at ${r.you.address} (${r.you.from}). Their access to this console: now ${verdictWords(r.you.before)}, after ${verdictWords(r.you.after)}.` : '',
    moved.length ? 'Kinds of connection that change:' : 'No kind of connection between the networks changes.',
    ...moved.map((m) => `- ${m.from} → ${m.what}: now ${verdictWords(m.before)}, after ${verdictWords(m.after)}`),
    r.flowsChecked ? `Of ${r.flowsChecked} connections the gate saw in the last hour, ${r.summary.flowsCutOff} would be cut off and ${r.summary.flowsOpened} newly allowed.` : 'No recent connections were available to replay.',
    ...r.flows.slice(0, 10).map((f) => `- ${f.src} → ${f.dst} ${f.proto}/${f.port} (${f.count}×): now ${f.before.verdict}, after ${verdictWords(f.after)}`),
  ].join('\n');
}

const STATUS: Record<GateError['code'], number> = { INVALID: 400, CONFLICT: 409, APPLY: 502, NOT_FOUND: 404 };

/** FBRX Gate (the gate role): the configuration, commits, live status and VPN devices. */
export async function gateRoutes(app: FastifyInstance, ctx: VirtualContext) {
  const gate = () => {
    if (!ctx.gate) throw conflict('This server is not a gate (install.sh --roles gate,… adds FBRX Gate)');
    return ctx.gate;
  };
  /** Gate refusals keep the problems they found, for the console to show next to the fields. */
  const guarded = async <T>(reply: FastifyReply, fn: () => Promise<T> | T): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof GateError) {
        void reply.status(STATUS[e.code]).send({ error: { code: e.code, message: e.message, issues: e.issues } });
        return undefined;
      }
      throw e;
    }
  };

  app.get('/v1/gate', async (req) => {
    need(req, 'viewer');
    const g = gate();
    return { mode: g.applier.kind, state: g.engine.state(), notes: g.engine.lastNotes() };
  });

  app.get('/v1/gate/live', async (req) => {
    need(req, 'viewer');
    return gate().engine.live();
  });

  app.get('/v1/gate/interfaces', async (req) => {
    need(req, 'viewer');
    return { interfaces: await gate().applier.systemInterfaces() };
  });

  /** Replaces what is being edited (nothing changes on the network until a commit). */
  app.put('/v1/gate/candidate', async (req, reply) => {
    const user = need(req, 'admin');
    const { config } = z.object({ config: z.unknown() }).parse(req.body);
    return guarded(reply, () => {
      const check = gate().engine.setCandidate(config, user.username);
      return { check: { ok: check.ok, errors: check.errors, warnings: check.warnings }, state: gate().engine.state() };
    });
  });

  app.post('/v1/gate/candidate/reset', async (req) => {
    const user = need(req, 'admin');
    return { state: gate().engine.reset(user.username) };
  });

  /** What the candidate turns into (the firewall table, dnsmasq, systemd-networkd files). */
  app.get('/v1/gate/preview', async (req, reply) => {
    need(req, 'admin');
    const check = checkConfig(gate().engine.candidate());
    if (!check.config) return reply.status(400).send({ error: { code: 'INVALID', message: 'The candidate has the wrong shape', issues: check.errors } });
    const r = render(check.config, DEFAULT_PATHS);
    return { nftables: r.nftables, dnsmasq: r.dnsmasq, networkd: r.networkd, qos: r.qos };
  });

  /**
   * What If: what the change being edited would do to traffic, before it is committed (see @fbrx/gate whatif.ts): the
   * kinds of connection between the zones, whether the person asking keeps this console, and the connections MiniDome
   * saw in the last hour, now and after.
   */
  const report = async (ip: string) => {
    const g = gate();
    const st = g.engine.state();
    const live = await g.engine.live().catch(() => null);
    // From the server itself (or a reverse proxy on it), the console is not reached through the gate.
    const you = /^(127\.|::1$)/.test(clientIp(ip)) ? null : clientIp(ip);
    return { state: st, report: whatIf(st.running, st.candidate, { you, wanAddress: live?.wan.address ?? null, flows: ctx.dome?.recentFlows() ?? [] }) };
  };

  app.get('/v1/gate/whatif', async (req) => {
    need(req, 'viewer');
    return (await report(req.ip)).report;
  });

  /** This server's AI (the ai role) reads What If and explains the change, its risks and whether to commit it. */
  app.post('/v1/gate/whatif/explain', async (req) => {
    const user = need(req, 'operator');
    const { state, report: r } = await report(req.ip);
    const answer = await ctx.core.call<{ answer: string; model: string }>('ai.quick', { reqId: randomUUID(), prompt: whatIfPrompt(state.changes, r) }, user.username, 120_000);
    return { answer: answer.answer, model: answer.model };
  });

  app.post('/v1/gate/commit', async (req, reply) => {
    const user = need(req, 'admin');
    const b = z.object({ comment: z.string().max(200).default(''), confirmMinutes: z.number().min(0).max(60).default(0) }).parse(req.body ?? {});
    return guarded(reply, () =>
      audited(ctx, req, 'gate.commit', b.comment || null, async () => {
        const commit = await gate().engine.commit({ by: user.username, comment: b.comment, confirmMinutes: b.confirmMinutes });
        return { commit, state: gate().engine.state(), notes: gate().engine.lastNotes() };
      }, { confirmMinutes: b.confirmMinutes }),
    );
  });

  app.post('/v1/gate/confirm', async (req, reply) => {
    const user = need(req, 'admin');
    return guarded(reply, () => audited(ctx, req, 'gate.confirm', null, () => ({ commit: gate().engine.confirm(user.username), state: gate().engine.state() })));
  });

  /** Undoes the commit on trial now, instead of waiting for its deadline (the candidate keeps it, to fix). */
  app.post('/v1/gate/confirm/undo', async (req, reply) => {
    const user = need(req, 'admin');
    return guarded(reply, () =>
      audited(ctx, req, 'gate.undo', null, async () => {
        const commit = await gate().engine.rollbackPending(`Rolled back by ${user.username}`);
        if (!commit) throw new GateError('No commit is waiting to be confirmed', 'CONFLICT');
        return { commit, state: gate().engine.state(), notes: gate().engine.lastNotes() };
      }),
    );
  });

  app.post('/v1/gate/rollback', async (req, reply) => {
    const user = need(req, 'admin');
    const b = z.object({ to: z.number().int().positive(), confirmMinutes: z.number().min(0).max(60).default(0) }).parse(req.body);
    return guarded(reply, () =>
      audited(ctx, req, 'gate.rollback', `commit ${b.to}`, async () => ({ commit: await gate().engine.rollback({ to: b.to, by: user.username, confirmMinutes: b.confirmMinutes }), state: gate().engine.state(), notes: gate().engine.lastNotes() })),
    );
  });

  app.get('/v1/gate/history', async (req) => {
    need(req, 'viewer');
    return { commits: gate().engine.history(100) };
  });

  app.get<{ Params: { id: string } }>('/v1/gate/history/:id', async (req, reply) => {
    need(req, 'viewer');
    return guarded(reply, () => ({ config: gate().engine.commitConfig(Number(req.params.id)) }));
  });

  /**
   * A new VPN device: the gate makes its key pair, adds it to the candidate, and hands the settings back once (text
   * and a QR code for the WireGuard app). Its private key is not kept anywhere.
   */
  app.post('/v1/gate/vpn/peers', async (req, reply) => {
    const user = need(req, 'admin');
    const b = z
      .object({ name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,39}$/), endpoint: z.string().max(260).optional(), fullTunnel: z.boolean().default(true) })
      .parse(req.body);
    const g = gate();
    const c: GateConfig = structuredClone(g.engine.candidate());
    if (c.vpn.peers.some((p) => p.name === b.name)) return reply.status(409).send({ error: { code: 'CONFLICT', message: `There is already a device called ${b.name}` } });
    const range = hostRange(c.vpn.address);
    const used = new Set([c.vpn.address.split('/')[0], ...c.vpn.peers.map((p) => p.address)]);
    let address: string | null = null;
    for (let n = ipv4ToInt(range.first); n <= ipv4ToInt(range.last); n++) {
      if (!used.has(intToIPv4(n))) {
        address = intToIPv4(n);
        break;
      }
    }
    if (!address) return reply.status(409).send({ error: { code: 'CONFLICT', message: 'The VPN network is full: make it bigger first' } });
    const keys = wgKeyPair();
    const peer = { name: b.name, publicKey: keys.publicKey, address, keepalive: 25 };
    c.vpn.enabled = true;
    c.vpn.peers.push(peer);
    const saved = await guarded(reply, () => g.engine.setCandidate(c, user.username));
    if (!saved) return;
    const gatePublicKey = (await g.applier.vpnKey()).publicKey;
    const live = await g.engine.live().catch(() => null);
    const endpoint = b.endpoint || live?.wan.address || 'YOUR-PUBLIC-ADDRESS';
    const text = peerConfig({ config: c, peer, privateKey: keys.privateKey, gatePublicKey, endpoint, fullTunnel: b.fullTunnel });
    ctx.audit.record(user.username, 'gate.vpn.peer', b.name, 'success', { address });
    return { peer, config: text, qr: await QRCode.toDataURL(text, { margin: 1, width: 320 }), state: g.engine.state() };
  });
}
