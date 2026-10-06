import { z } from 'zod';
import { AUDIENCES, EXT_USER_ONLY, SECRET_KINDS, type CoreMethod, type ExtMethods, type InvocationOrigin } from '@fbrx/shared';
import { CoreError } from '../errors';
import type { Kernel } from '../kernel';
import { validatePassphrase } from '../vault/vault';

export interface CallContext {
  origin: InvocationOrigin;
  actor: string;
}

type Handler = (params: any, ctx: CallContext) => unknown | Promise<unknown>;

/** Methods that only a person at the workstation may call (never the Local API or a remote command). */
const USER_ONLY = new Set<string>([
  'vault.reveal',
  'vault.initialize',
  'vault.changeRecovery',
  'vault.unlock',
  'vault.importMoved',
  'vault.passwordOnStart',
  'vault.reset',
  'backup.restore',
  'ai.conversations.deleteMany',
  'ai.conversations.cleanup',
  'fleet.enroll',
  'fleet.unenroll',
  'governance.updatePolicy',
  'governance.removeRememberedRule',
  'license.activate',
  'license.remove',
  'localapi.info',
  'localapi.rotateToken',
  'plugins.install',
  'connectors.create',
  'connectors.update',
  'settings.update',
  'approvals.resolve',
  'updates.install',
  'release.skip',
  'release.install',
  ...EXT_USER_ONLY,
]);

/** Read-only methods are not audited (they would drown the log). */
const READ_ONLY = /\.(status|list|get|types|catalog|installed|policy|query|stats|verify|models|providers|inspect|info)$|^logs\.tail$|^ai\.conversations\.(list|get)$/;
/** Command-center reads (dashboards poll these). */
const EXT_READ_ONLY =
  /^(sysinfo\.\w+|files\.(home|read|search)|spotlight\.(query|files)|alerts\.(rules|inbox|counts)|storage\.(drives|disks|cleanupInfo|analyze)|security\.(defender|defenderPrefs|threats|firewall|ports|processAudit|startup|fileReport|linkCheck)|bugs\.(scan|fixes|events)|winupdates\.(apps|windows|drivers|hotfixes)|lab\.vms|net\.(context|publicIp|ping|traceroute|scans|scanGet|compare|speedHistory|wifi|bluetooth|printers|dns|port|adapters)|mesh\.(messages|peerInfo)|aicoord\.(detect|bridge)|events\.logs|codelab\.(read|folder|editors)|voice\.models)$/;

const SENSITIVE_KEYS = new Set(['value', 'passphrase', 'recoveryPassphrase', 'current', 'next', 'key', 'token', 'password']);

function scrub(params: unknown): unknown {
  if (!params || typeof params !== 'object') return params;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(k)) out[k] = '[redacted]';
    else if (k === 'message' || k === 'prompt') out[k] = typeof v === 'string' ? `${v.slice(0, 120)}${v.length > 120 ? '…' : ''}` : v;
    else if (k === 'patch' || k === 'policy' || k === 'config') out[k] = '[object]';
    else out[k] = v;
  }
  return out;
}

const NameSchema = z.object({ name: z.string().min(1) });
const IdSchema = z.object({ id: z.string().min(1) });

export function buildCoreApi(k: Kernel): Record<string, Handler> {
  const h: Record<Exclude<CoreMethod, keyof ExtMethods> | 'agent.runToCompletion', Handler> = {
    'system.status': () => k.status(),
    'system.restartService': (p) => k.services.restart(NameSchema.parse(p).name),
    'logs.tail': (p) => k.logSink.tail(Math.min(Number(p?.lines ?? 200), 2000), p?.level),

    'settings.get': () => k.settings.effective(),
    'settings.update': (p) => k.settings.update(z.object({ patch: z.record(z.string(), z.unknown()) }).parse(p).patch as never),

    'vault.status': () => k.vault.status(),
    'vault.initialize': async (p) => {
      const { recoveryPassphrase } = z.object({ recoveryPassphrase: z.string() }).parse(p);
      await k.vault.setRecoveryPassphrase(recoveryPassphrase);
      return k.vault.status();
    },
    'vault.unlock': async (p) => {
      await k.vault.unlockWithRecovery(z.object({ recoveryPassphrase: z.string() }).parse(p).recoveryPassphrase);
      await k.onVaultUnlocked();
      return k.vault.status();
    },
    'vault.lock': () => {
      k.vault.lock();
      return k.vault.status();
    },
    'vault.list': () => k.vault.list(),
    'vault.set': (p) =>
      k.vault.set(
        z
          .object({
            name: z.string(),
            value: z.string(),
            kind: z.enum(SECRET_KINDS).optional(),
            description: z.string().max(500).optional(),
            tags: z.array(z.string().max(40)).max(20).optional(),
          })
          .parse(p),
      ),
    'vault.reveal': (p) => {
      const { name } = NameSchema.parse(p);
      const value = k.vault.get(name);
      if (value === undefined) throw new CoreError('NOT_FOUND', `No secret named ${name}`);
      return { name, value };
    },
    'vault.delete': (p) => ({ deleted: k.vault.delete(NameSchema.parse(p).name) }),
    'vault.changeRecovery': async (p) => {
      const { current, next } = z.object({ current: z.string(), next: z.string() }).parse(p);
      if (k.vault.status().hasRecovery && !(await k.vault.verifyRecoveryPassphrase(current))) {
        throw new CoreError('UNAUTHENTICATED', 'Current recovery passphrase is incorrect');
      }
      validatePassphrase(next);
      await k.vault.setRecoveryPassphrase(next);
      return k.vault.status();
    },
    'vault.importMoved': async () => {
      await k.vault.importMoved();
      await k.onVaultUnlocked();
      return k.vault.status();
    },
    'vault.passwordOnStart': async (p) => {
      const { enabled, passphrase } = z.object({ enabled: z.boolean(), passphrase: z.string() }).parse(p);
      await k.vault.setPasswordOnStart(enabled, passphrase);
      return k.vault.status();
    },
    'vault.reset': async (p) => {
      z.object({ confirm: z.literal('DELETE') }).parse(p);
      await k.vault.reset();
      // FBRX's own keys (Local API, mesh) were deleted with everything else; a restart recreates them cleanly.
      k.platform.requestRestart('vault-reset');
      return k.vault.status();
    },

    'ai.providers': () => k.providers.status(),
    'ai.models': (p) => k.providers.models(z.object({ providerId: z.string() }).parse(p).providerId),
    'ai.chat': (p, ctx) => {
      const q = z.object({ conversationId: z.string().optional(), message: z.string(), providerId: z.string().optional(), model: z.string().optional(), offline: z.boolean().optional() }).parse(p);
      const { runId, conversationId } = k.agent.start({ ...q, origin: ctx.origin, actor: ctx.actor });
      return { runId, conversationId };
    },
    'agent.runToCompletion': async (p, ctx) => {
      const q = z.object({ conversationId: z.string().optional(), message: z.string(), providerId: z.string().optional(), model: z.string().optional() }).parse(p);
      return k.agent.runToCompletion({ ...q, origin: ctx.origin, actor: ctx.actor });
    },
    'ai.cancel': (p) => ({ cancelled: k.agent.cancel(z.object({ runId: z.string() }).parse(p).runId) }),
    'ai.conversations.list': (p) => k.conversations.list(z.object({ projectId: z.string().max(64).optional() }).parse(p ?? {})),
    'ai.conversations.get': (p) => k.conversations.get(IdSchema.parse(p).id),
    'ai.conversations.rename': (p) => {
      const q = z.object({ id: z.string(), title: z.string() }).parse(p);
      return k.conversations.rename(q.id, q.title);
    },
    'ai.conversations.delete': (p) => ({ deleted: k.conversations.delete(IdSchema.parse(p).id) }),
    'ai.conversations.deleteMany': (p) => k.conversations.deleteMany(z.object({ ids: z.array(z.string().max(64)).max(5000) }).parse(p).ids, k.agent.busyConversations()),
    'ai.conversations.cleanup': (p) => {
      const q = z.object({ olderThanDays: z.number().int().min(0).max(36500), includeProjects: z.boolean().optional(), dryRun: z.boolean().optional() }).parse(p);
      const ids = k.conversations.stale(q.olderThanDays, !!q.includeProjects);
      const busy = k.agent.busyConversations();
      if (q.dryRun) return { deleted: ids.filter((id) => !busy.has(id)).length };
      return { deleted: k.conversations.deleteMany(ids, busy).deleted };
    },
    'ai.conversations.setProject': (p) => {
      const q = z.object({ id: z.string(), projectId: z.string().max(64).nullable() }).parse(p);
      const s = k.conversations.setProject(q.id, q.projectId);
      k.events.emit('workspace.changed', { kind: 'projects' });
      return s;
    },
    'ai.conversations.setOffline': (p) => {
      const q = z.object({ id: z.string(), offline: z.boolean() }).parse(p);
      return k.agent.setOffline(q.id, q.offline);
    },

    'runtime.status': () => k.runtime.status(),
    'runtime.start': () => k.runtime.start(),
    'runtime.stop': () => k.runtime.stop(),
    'runtime.catalog': () => k.models.catalog(),
    'runtime.installRuntime': () => {
      k.runtime.install();
      return { started: true };
    },
    'runtime.installed': () => k.models.installed(),
    'runtime.download': (p) => {
      k.models.download(z.object({ modelId: z.string() }).parse(p).modelId);
      return { started: true };
    },
    'runtime.cancelDownload': (p) => {
      const { modelId } = z.object({ modelId: z.string() }).parse(p);
      return { cancelled: modelId === 'llama-runtime' ? k.runtime.cancelInstall() : k.models.cancel(modelId) };
    },
    'runtime.importModel': (p) => {
      const q = z.object({ path: z.string(), name: z.string().optional() }).parse(p);
      return k.models.import(q.path, q.name);
    },
    'runtime.deleteModel': async (p) => ({ deleted: await k.models.remove(z.object({ modelId: z.string() }).parse(p).modelId) }),
    'runtime.selectModel': async (p) => {
      const { modelId } = z.object({ modelId: z.string() }).parse(p);
      if (!k.models.get(modelId)) throw new CoreError('NOT_FOUND', 'Model is not installed');
      k.settings.update({ runtime: { modelId } });
      if (k.runtime.isRunning) {
        await k.runtime.stop();
        await k.runtime.start();
      }
      return k.runtime.status();
    },

    'tools.list': () => k.registry.list().map((t) => k.gate.describe(t)),
    'tools.setEnabled': (p) => {
      const q = z.object({ name: z.string(), enabled: z.boolean() }).parse(p);
      k.registry.setEnabled(q.name, q.enabled);
      return k.gate.describe(k.registry.get(q.name)!);
    },
    'tools.invoke': async (p, ctx) => {
      const q = z.object({ name: z.string(), input: z.unknown() }).parse(p);
      // The emergency stop also stops other AI apps (MCP bridge, Local API automation) from using tools.
      if (ctx.origin !== 'user' && k.aiHalt()) throw new CoreError('UNAVAILABLE', 'The AI is on emergency stop on this computer');
      const r = await k.gate.invoke(q.name, q.input ?? {}, { origin: ctx.origin, actor: ctx.actor });
      return { ok: r.ok, output: r.output, data: r.data, error: r.error, durationMs: r.durationMs };
    },

    'governance.policy': () => k.policy.effective(),
    'governance.updatePolicy': (p) => k.policy.updateLocal(z.object({ policy: z.unknown() }).parse(p).policy as never),
    'governance.removeRememberedRule': (p) => k.policy.removeRemembered(IdSchema.parse(p).id),
    'approvals.list': () => k.approvals.list(),
    'approvals.resolve': (p, ctx) => {
      const q = z.object({ id: z.string(), decision: z.enum(['approve', 'deny']), remember: z.boolean().optional() }).parse(p);
      return { resolved: k.approvals.resolve(q.id, q.decision, ctx.actor, q.remember) };
    },

    'audit.query': (p) =>
      k.audit.query(
        z
          .object({
            limit: z.number().int().optional(),
            beforeSeq: z.number().int().optional(),
            category: z.string().optional(),
            outcome: z.enum(['success', 'failure', 'denied', 'info']).optional(),
            search: z.string().optional(),
          })
          .parse(p ?? {}),
      ),
    'audit.verify': () => k.audit.verify(),
    'audit.stats': () => k.audit.stats(),

    'plugins.list': () => k.plugins.list(),
    'plugins.install': (p, ctx) => {
      k.license.require('plugins');
      return k.plugins.install(z.object({ path: z.string() }).parse(p).path, ctx.actor);
    },
    'plugins.uninstall': async (p, ctx) => ({ uninstalled: await k.plugins.uninstall(IdSchema.parse(p).id, ctx.actor) }),
    'plugins.setEnabled': (p, ctx) => {
      const q = z.object({ id: z.string(), enabled: z.boolean() }).parse(p);
      return k.plugins.setEnabled(q.id, q.enabled, ctx.actor);
    },
    'plugins.reload': (p) => k.plugins.reload(IdSchema.parse(p).id),

    'connectors.types': () => k.connectors.types(),
    'connectors.list': () => k.connectors.list(),
    'connectors.create': (p, ctx) => k.connectors.create(p, ctx.actor),
    'connectors.update': (p, ctx) => {
      const q = z.object({ id: z.string(), patch: z.record(z.string(), z.unknown()) }).parse(p);
      return k.connectors.update(q.id, q.patch, ctx.actor);
    },
    'connectors.delete': async (p, ctx) => ({ deleted: await k.connectors.delete(IdSchema.parse(p).id, ctx.actor) }),
    'connectors.test': (p) => k.connectors.test(IdSchema.parse(p).id),

    'backup.list': () => k.backup.list(),
    'backup.create': (p, ctx) => {
      const q = z.object({ passphrase: z.string().optional(), label: z.string().max(120).optional(), includeModels: z.boolean().optional() }).parse(p ?? {});
      return k.backup.create({ ...q, actor: ctx.actor });
    },
    'backup.inspect': (p) => k.backup.inspect(z.object({ file: z.string() }).parse(p).file),
    'backup.restore': (p, ctx) =>
      k.backup.restore(z.object({ file: z.string(), passphrase: z.string(), mode: z.enum(['migrate', 'clone']) }).parse(p), ctx.actor),
    'backup.delete': (p, ctx) => ({ deleted: k.backup.delete(z.object({ file: z.string() }).parse(p).file, ctx.actor) }),

    'fleet.status': () => k.fleet.status(),
    'fleet.enroll': (p, ctx) => {
      const q = z.object({ serverUrl: z.string(), token: z.string(), deviceName: z.string().optional(), audience: z.enum(AUDIENCES).optional(), fingerprint: z.string().optional() }).parse(p);
      return k.fleet.enroll(q.serverUrl, q.token, q.deviceName, ctx.actor, q.audience, q.fingerprint);
    },
    'fleet.probe': (p) => k.fleet.probe(z.object({ serverUrl: z.string().min(1) }).parse(p).serverUrl),
    'fleet.unenroll': (_p, ctx) => k.fleet.unenroll(ctx.actor),
    'fleet.sync': async () => {
      if (!k.fleet.enrolled) throw new CoreError('UNAVAILABLE', 'This device is not enrolled');
      await k.fleet.sync();
      return k.fleet.status();
    },

    'license.status': () => k.license.status(),
    'license.activate': async (p, ctx) => {
      const status = k.license.activate(z.object({ key: z.string() }).parse(p).key);
      // A key from an FBRX Command tenant joins this computer to it.
      const join = await k.joinLicenseTenant(ctx.actor);
      return join.message ? { ...k.license.status(), message: join.message } : status;
    },
    'license.remove': () => k.license.remove(),

    'updates.status': () => k.updateStatus(),
    'updates.check': async () => (k.platform.updates ? k.platform.updates.check() : k.updateStatus()),
    'updates.install': async () => (k.platform.updates ? k.platform.updates.install({ restartNow: true }) : k.updateStatus()),
    'release.status': () => k.release.status(),
    'release.check': () => k.release.check(),
    'release.skip': (p) => k.release.skip(z.object({ version: z.string().max(40) }).parse(p).version),
    'release.install': () => k.release.install(),

    'localapi.info': (p) => k.localApi.info(!!p?.revealToken),
    'localapi.rotateToken': async () => {
      k.rotateLocalApiTokens();
      return k.localApi.info(true);
    },
  };
  return h;
}

export function isUserOnly(method: string) {
  return USER_ONLY.has(method);
}

export function isReadOnly(method: string) {
  return READ_ONLY.test(method) || EXT_READ_ONLY.test(method);
}

export { scrub as scrubParams };
