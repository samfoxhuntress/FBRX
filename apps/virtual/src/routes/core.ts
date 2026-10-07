import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ASSIST_MODES, ASSIST_PRIORITIES, ASSIST_TOOLS, isCidr, MESH_TRAFFIC_CLASSES, type ApprovalRequest, type MeshNetworkStatus, type MeshTrafficClass, type EffectiveSettings, type MeshStatus, type SecretMeta, type SystemStatus, type VirtualRole } from '@fbrx/shared';
import { allows } from '../auth';
import { audited, need, type VirtualContext } from '../context';
import { badRequest, forbidden } from '../errors';

/**
 * The server's own FBRX core, through FBRX Virtual: its AI provider, FBRX Mesh and Mesh Assist. The core trusts this
 * console as the person at the computer, so every method is listed here with the role it needs, and the arguments
 * of the ones that change things are narrowed to what the Mesh & AI page does.
 */
interface Rule {
  role: VirtualRole;
  /** Checks or narrows the arguments (throws to refuse). */
  params?: (params: unknown, run: Runner, role: VirtualRole) => unknown | Promise<unknown>;
  /** Trims the answer to what this console shows. */
  result?: (result: unknown, role: VirtualRole) => unknown;
}

type Runner = <T>(method: string, params?: unknown) => Promise<T>;

const ROLE_NAME = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const AssistPatch = z
  .object({
    request: z.enum(ASSIST_MODES),
    onStepLimit: z.boolean(),
    onProviderError: z.boolean(),
    agentMayConsult: z.boolean(),
    offer: z.enum(ASSIST_MODES),
    tools: z.enum(ASSIST_TOOLS),
    maxConcurrent: z.number().int().min(1).max(8),
    maxSteps: z.number().int().min(1).max(100),
    priority: z.enum(ASSIST_PRIORITIES),
    allowPreempt: z.boolean(),
    roles: z.array(ROLE_NAME).max(16),
    controller: z.boolean(),
  })
  .partial()
  .strict();
const Provider = z
  .object({
    id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-_]*$/),
    type: z.enum(['local-runtime', 'ollama', 'openai-compatible', 'openai', 'anthropic']),
    name: z.string().min(1).max(120),
    enabled: z.boolean(),
    baseUrl: z.string().url().optional(),
    apiKeySecret: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/).optional(),
    defaultModel: z.string().max(200).optional(),
    cloud: z.boolean(),
  })
  .strict();
const NetworkPatch = z
  .object({
    preferMesh: z.boolean(),
    subnets: z.array(z.string().refine(isCidr, 'Enter a network like 10.20.0.0/24')).max(8),
    trafficClass: z.enum(MESH_TRAFFIC_CLASSES),
    jumbo: z.boolean(),
  })
  .partial()
  .strict();
const SettingsPatch = z
  .object({
    ai: z.object({ defaultProvider: z.string().max(64), defaultModel: z.string().max(200), agentName: z.string().min(1).max(40), providers: z.array(Provider).max(32) }).partial().strict(),
    mesh: z.object({ incoming: z.enum(['ask', 'allow', 'deny']), assist: AssistPatch, network: NetworkPatch }).partial().strict(),
  })
  .partial()
  .strict();

function settingsView(r: unknown) {
  const e = r as EffectiveSettings;
  const s = e.settings;
  return {
    settings: {
      general: { deviceName: s.general.deviceName },
      ai: { defaultProvider: s.ai.defaultProvider, defaultModel: s.ai.defaultModel, agentName: s.ai.agentName, providers: s.ai.providers },
      mesh: s.mesh,
    },
    locked: e.locked,
  };
}

function statusView(r: unknown) {
  const s = r as SystemStatus;
  return { product: s.product, version: s.version, hostname: s.hostname, deviceName: s.deviceName, startedAt: s.startedAt, pendingApprovals: s.pendingApprovals, activeRuns: s.activeRuns, aiHalt: s.aiHalt ?? null, vault: { state: s.vault.state } };
}

const RULES: Record<string, Rule> = {
  'system.status': { role: 'viewer', result: statusView },
  'settings.get': { role: 'viewer', result: settingsView },
  'ai.providers': { role: 'viewer' },
  // Pairing codes let a computer join: administrators only.
  'mesh.status': { role: 'viewer', result: (r, role) => (allows(role, 'admin') ? r : { ...(r as MeshStatus), pairing: null }) },
  'mesh.assist.helpers': { role: 'viewer' },
  'mesh.network.test': { role: 'operator', params: (p) => z.object({ peerId: z.string().max(80).optional() }).strict().parse(p) },
  'mesh.assist.sessions': { role: 'viewer' },
  'approvals.list': { role: 'viewer' },

  'mesh.assist.send': {
    role: 'operator',
    params: (p) =>
      z
        .object({ peerIds: z.union([z.literal('any'), z.array(z.string().max(80)).min(1).max(32)]), goal: z.string().min(1).max(20000), priority: z.enum(ASSIST_PRIORITIES).optional(), tools: z.enum(ASSIST_TOOLS).optional() })
        .strict()
        .parse(p),
  },
  'mesh.assist.followUp': { role: 'operator', params: (p) => z.object({ sessionId: z.string().max(80), text: z.string().min(1).max(20000) }).strict().parse(p) },
  'mesh.assist.cancel': { role: 'operator', params: (p) => z.object({ sessionId: z.string().max(80) }).strict().parse(p) },
  // Operators answer Mesh Assist's own questions ("Help <computer>?"); everything else waits for an administrator.
  'approvals.resolve': {
    role: 'operator',
    params: async (p, run, role) => {
      const a = z.object({ id: z.string().max(80), decision: z.enum(['approve', 'deny']), remember: z.boolean().optional() }).strict().parse(p);
      if (!allows(role, 'admin')) {
        const pending = (await run<ApprovalRequest[]>('approvals.list')).find((x) => x.id === a.id);
        if (pending && pending.tool !== 'mesh.assist') throw forbidden('Only administrators answer this one');
        if (a.remember) throw forbidden('Only administrators make a standing rule');
      }
      return a;
    },
  },

  'ai.models': { role: 'admin', params: (p) => z.object({ providerId: z.string().max(64) }).strict().parse(p) },
  'settings.update': { role: 'admin', params: (p) => ({ patch: z.object({ patch: SettingsPatch }).strict().parse(p).patch }), result: settingsView },
  // Which provider keys are saved (names and dates, never values).
  'vault.list': {
    role: 'admin',
    result: (r) => (r as SecretMeta[]).filter((s) => s.kind === 'api-key').map((s) => ({ name: s.name, kind: s.kind, updatedAt: s.updatedAt })),
  },
  // Only an AI provider's key, under the name that provider is set to read.
  'vault.set': {
    role: 'admin',
    params: async (p, run) => {
      const a = z.object({ name: z.string().max(80), value: z.string().min(1).max(4000) }).strict().parse(p);
      const s = (await run<EffectiveSettings>('settings.get')).settings;
      if (!s.ai.providers.some((x) => x.apiKeySecret === a.name)) throw badRequest(`${a.name} is not an AI provider's key`);
      return { name: a.name, value: a.value, kind: 'api-key', description: 'AI provider key (set from FBRX Virtual)' };
    },
  },
  'mesh.setEnabled': { role: 'admin', params: (p) => z.object({ enabled: z.boolean() }).strict().parse(p) },
  'mesh.rename': { role: 'admin', params: (p) => z.object({ name: z.string().min(1).max(120) }).strict().parse(p) },
  'mesh.startPairing': { role: 'admin' },
  'mesh.cancelPairing': { role: 'admin' },
  'mesh.pair': { role: 'admin', params: (p) => z.object({ code: z.string().min(1).max(40), host: z.string().min(1).max(260) }).strict().parse(p) },
  'mesh.removeDevice': { role: 'admin', params: (p) => z.object({ id: z.string().max(80) }).strict().parse(p) },
  'mesh.setPermissions': {
    role: 'admin',
    params: (p) => z.object({ id: z.string().max(80), permissions: z.partialRecord(z.enum(['status', 'chat', 'ask', 'approve', 'workspace', 'alerts', 'control', 'assist', 'command']), z.boolean()) }).strict().parse(p),
  },
};

const READS = new Set(['system.status', 'settings.get', 'ai.providers', 'mesh.status', 'mesh.assist.helpers', 'mesh.assist.sessions', 'approvals.list', 'vault.list', 'ai.models', 'mesh.network.test']);

function target(method: string, p: Record<string, unknown>): string | null {
  if (method === 'vault.set') return String(p.name);
  if (method === 'mesh.assist.send') return Array.isArray(p.peerIds) ? p.peerIds.join(', ') : 'best helper';
  if (method === 'settings.update') return Object.keys((p.patch as object) ?? {}).join(', ');
  for (const k of ['sessionId', 'id', 'host', 'name']) if (typeof p[k] === 'string') return p[k] as string;
  return null;
}

/** What the audit log keeps of the arguments (never a key). */
function details(method: string, p: Record<string, unknown>): unknown {
  if (method === 'vault.set') return { name: p.name };
  if (method === 'mesh.assist.send' || method === 'mesh.assist.followUp') return { ...p, goal: undefined, text: undefined, length: String(p.goal ?? p.text ?? '').length };
  return p;
}

export async function coreRoutes(app: FastifyInstance, ctx: VirtualContext) {
  const actor = (req: FastifyRequest) => req.user?.username ?? 'admin';

  app.get('/v1/core', async (req) => {
    const user = need(req, 'viewer');
    return { ...(await ctx.core.state()), role: user.role };
  });

  app.post('/v1/core/call', async (req) => {
    const user = need(req, 'viewer');
    const { method, params } = z.object({ method: z.string().max(80), params: z.unknown().optional() }).parse(req.body);
    const rule = RULES[method];
    if (!rule) throw forbidden(`This console does not call ${method}`);
    need(req, rule.role);
    const run: Runner = (m, p) => ctx.core.call(m, p ?? {}, actor(req));
    const args = rule.params ? await rule.params(params ?? {}, run, user.role) : {};
    const call = async () => {
      const out = await ctx.core.call(method, args, actor(req), method === 'mesh.pair' ? 90_000 : 60_000);
      return rule.result ? rule.result(out, user.role) : out;
    };
    const result = READS.has(method) ? await call() : await audited(ctx, req, `core.${method}`, target(method, args as Record<string, unknown>), call, details(method, args as Record<string, unknown>));
    // A new priority class for mesh traffic: the server's own marking follows it.
    const cls = (args as { patch?: { mesh?: { network?: { trafficClass?: MeshTrafficClass } } } }).patch?.mesh?.network?.trafficClass;
    const mark = ctx.meshMark.wanted();
    if (method === 'settings.update' && cls && mark && cls !== mark.trafficClass) await ctx.meshMark.apply(mark.port, cls).catch((e) => req.log.warn(`Mesh marking not updated: ${(e as Error).message}`));
    return { result };
  });

  /** Prefer Mesh on this server: the core's view, with the marking FBRX Virtual does as root. */
  app.get('/v1/core/network', async (req) => {
    need(req, 'viewer');
    const st = await ctx.core.call<MeshNetworkStatus>('mesh.network.status', {}, actor(req));
    const applied = await ctx.meshMark.applied();
    return {
      ...st,
      qos: { method: 'nftables', applied, canApply: true, detail: 'FBRX Virtual marks this server’s mesh traffic (nftables) and puts the marking back after every restart.', script: null },
      warnings: st.warnings.filter((w) => !/not marked/.test(w)).concat(st.preferMesh && applied === false ? ['This server does not mark its mesh traffic yet.'] : []),
    };
  });

  app.post('/v1/core/network/mark', async (req) => {
    need(req, 'admin');
    const { remove } = z.object({ remove: z.boolean().default(false) }).parse(req.body ?? {});
    const s = (await ctx.core.call<EffectiveSettings>('settings.get', {}, actor(req))).settings.mesh;
    await audited(ctx, req, remove ? 'mesh.mark.remove' : 'mesh.mark', remove ? null : `TCP ${s.port} → ${s.network.trafficClass}`, () => (remove ? ctx.meshMark.remove() : ctx.meshMark.apply(s.port, s.network.trafficClass)));
    return { applied: await ctx.meshMark.applied() };
  });
}
