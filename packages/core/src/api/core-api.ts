import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_MESSAGE, AUDIENCES, LOGIN_LIMITS, AUTOMATION_INTERVAL, AUTOMATION_NOTIFY, EXT_USER_ONLY, IMAGE_MIME, MEMORY_CATEGORIES, PICTURE_EXTENSIONS, SCHEDULE_TIME_PATTERN, SECRET_KINDS, SNAPSHOT_MAX_BYTES, THINKING_LEVELS, VERTICALS, fileExtension, type CoreMethod, type ExtMethods, type InvocationOrigin } from '@fbrx/shared';
import { CoreError } from '../errors';
import type { Kernel } from '../kernel';
import { validatePassphrase } from '../vault/vault';
import { setThinkingLevel } from '../ai/thinking';

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
  'passwords.list',
  'passwords.query',
  'passwords.reveal',
  'passwords.save',
  'passwords.remove',
  'passwords.fill',
  'passwords.verify',
  'passwords.code',
  'passwords.import',
  'backup.restore',
  'ai.conversations.deleteMany',
  'ai.conversations.cleanup',
  'ai.attachments.add',
  'ai.attachments.remove',
  'ai.attachments.read',
  'ai.attachments.get',
  'ai.files.preview',
  'snapshots.list',
  'snapshots.read',
  'snapshots.save',
  'snapshots.remove',
  'automations.create',
  'automations.update',
  'automations.remove',
  'automations.run',
  'ai.setThinking',
  'fleet.enroll',
  'fleet.unenroll',
  'governance.updatePolicy',
  'governance.removeRememberedRule',
  'governance.addFolder',
  'memory.add',
  'memory.update',
  'memory.forget',
  'memory.forgetAll',
  'governance.removeFolder',
  'governance.answerFolder',
  'license.activate',
  'license.remove',
  'account.signIn',
  'account.signOut',
  'account.checkout',
  'account.portal',
  'account.join',
  'account.devices',
  'account.signOutDevice',
  'account.resendConfirmation',
  'account.forgotPassword',
  'account.startOrganization',
  'account.acceptInvitation',
  'localAccount.create',
  'localAccount.update',
  'localAccount.setPassword',
  'localAccount.clearPassword',
  'localAccount.unlock',
  'localAccount.remove',
  'support.activate',
  'support.end',
  'browser.bookmark',
  'browser.removeBookmark',
  'browser.clearHistory',
  'browser.setHomepage',
  'browser.addBlocked',
  'browser.removeBlocked',
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
  /^(sysinfo\.\w+|files\.(home|read|search)|spotlight\.(query|files)|alerts\.(rules|inbox|counts)|storage\.(drives|disks|cleanupInfo|analyze)|security\.(defender|defenderPrefs|threats|firewall|ports|processAudit|startup|fileReport|linkCheck)|bugs\.(scan|fixes|events)|winupdates\.(apps|windows|drivers|hotfixes)|lab\.vms|net\.(context|publicIp|ping|traceroute|scans|scanGet|compare|speedHistory|wifi|bluetooth|printers|dns|port|adapters)|mesh\.(messages|peerInfo)|aicoord\.(detect|bridge)|events\.logs|vpn\.(status|check)|codelab\.(read|folder|editors)|voice\.models|server\.(resources|readDoc)|mesh\.network\.(status|test|computers))$/;

const SENSITIVE_KEYS = new Set(['value', 'passphrase', 'recoveryPassphrase', 'current', 'next', 'key', 'token', 'password', 'totp', 'notes', 'csv']);

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
const LoginSchema = z
  .object({
    id: z.string().max(64),
    title: z.string().max(LOGIN_LIMITS.title),
    username: z.string().max(LOGIN_LIMITS.username),
    password: z.string().max(LOGIN_LIMITS.password),
    urls: z.array(z.string().max(LOGIN_LIMITS.url)).max(LOGIN_LIMITS.urls),
    notes: z.string().max(LOGIN_LIMITS.notes),
    totp: z.string().max(LOGIN_LIMITS.totp),
    favorite: z.boolean(),
  })
  .partial();
const IdSchema = z.object({ id: z.string().min(1) });

const AutomationInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(8000),
  schedule: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('interval'), minutes: z.number().int().min(AUTOMATION_INTERVAL.min).max(AUTOMATION_INTERVAL.max) }),
    z.object({ kind: z.literal('daily'), time: z.string().regex(SCHEDULE_TIME_PATTERN), days: z.array(z.number().int().min(0).max(6)).max(7) }),
    z.object({ kind: z.literal('start') }),
    z.object({ kind: z.literal('manual') }),
  ]),
  notify: z.enum(AUTOMATION_NOTIFY),
  online: z.boolean(),
  hotkey: z.string().max(60),
  enabled: z.boolean(),
});

export function buildCoreApi(k: Kernel): Record<string, Handler> {
  /** Sweeps the files of deleted chats' attachments once a delete is done, and passes its answer on. */
  const tidied = <T,>(result: T): T => {
    void k.attachments.sweep().catch(() => undefined);
    return result;
  };
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
    'passwords.list': () => k.passwords.list(),
    'passwords.query': (p) => k.passwords.query(z.object({ url: z.string().max(LOGIN_LIMITS.url) }).parse(p).url),
    'passwords.reveal': (p) => k.passwords.reveal(IdSchema.parse(p).id),
    'passwords.save': (p) => k.passwords.save(LoginSchema.parse(p)),
    'passwords.remove': (p) => ({ removed: k.passwords.remove(IdSchema.parse(p).id) }),
    'passwords.fill': (p) => {
      const { id, url } = z.object({ id: z.string().min(1), url: z.string().max(LOGIN_LIMITS.url) }).parse(p);
      return k.passwords.fill(id, url);
    },
    'passwords.verify': (p) => {
      const { url, username, password } = z.object({ url: z.string().max(LOGIN_LIMITS.url), username: z.string().max(LOGIN_LIMITS.username), password: z.string().max(LOGIN_LIMITS.password) }).parse(p);
      return k.passwords.verify(url, username, password);
    },
    'passwords.code': (p) => k.passwords.code(IdSchema.parse(p).id),
    'passwords.import': (p) => k.passwords.import(z.object({ csv: z.string().max(5 * 1024 * 1024) }).parse(p).csv),

    'ai.providers': () => k.providers.status(),
    'ai.models': (p) => k.providers.models(z.object({ providerId: z.string() }).parse(p).providerId),
    'ai.chat': (p, ctx) => {
      const q = z
        .object({ conversationId: z.string().optional(), message: z.string(), providerId: z.string().optional(), model: z.string().optional(), offline: z.boolean().optional(), attachments: z.array(z.string().max(64)).max(ATTACHMENTS_PER_MESSAGE).optional() })
        .parse(p);
      const { runId, conversationId } = k.agent.start({ ...q, origin: ctx.origin, actor: ctx.actor });
      return { runId, conversationId };
    },
    'ai.attachments.add': (p) => {
      // Base64 of the largest file allowed, plus a little room.
      const q = z.object({ name: z.string().min(1).max(260), data: z.string().max(Math.ceil((ATTACHMENT_MAX_BYTES * 4) / 3) + 16), mime: z.string().max(120).optional() }).parse(p);
      return k.attachments.add({ name: q.name, data: Buffer.from(q.data, 'base64'), mime: q.mime });
    },
    'ai.attachments.remove': async (p) => ({ removed: await k.attachments.remove(IdSchema.parse(p).id) }),
    'ai.attachments.read': (p) => k.attachments.read(IdSchema.parse(p).id),
    'ai.attachments.get': (p) => k.attachments.info(IdSchema.parse(p).id),
    'snapshots.list': () => k.snapshots.list(),
    'snapshots.read': (p) => {
      const q = z.object({ id: z.string().min(1).max(260), size: z.number().int().min(32).max(1024).optional() }).parse(p);
      return k.snapshots.read(q.id, q.size);
    },
    'snapshots.save': (p) => {
      const q = z.object({ data: z.string().min(1).max(Math.ceil((SNAPSHOT_MAX_BYTES * 4) / 3) + 16), id: z.string().min(1).max(260).optional() }).parse(p);
      return k.snapshots.save(Buffer.from(q.data, 'base64'), q.id);
    },
    'snapshots.remove': (p) => k.snapshots.remove(z.object({ id: z.string().min(1).max(260) }).parse(p).id),
    'snapshots.folder': () => ({ path: k.snapshots.folder() }),
    'ai.files.preview': async (p) => {
      const file = z.object({ path: z.string().min(1).max(1000) }).parse(p).path;
      const ext = fileExtension(file);
      if (!PICTURE_EXTENSIONS.has(ext) || !isAbsolute(file) || !k.output.holds(file)) throw new CoreError('FORBIDDEN', 'Only pictures in the FBRX folder or the workspace are shown here');
      const data = await readFile(file);
      if (data.length > 10 * 1024 * 1024) throw new CoreError('INVALID_ARGUMENT', 'That picture is too large to show here');
      return { mime: ext === 'svg' ? 'image/svg+xml' : (IMAGE_MIME[ext] ?? 'image/png'), data: data.toString('base64') };
    },
    'ai.files.folder': () => ({ path: k.output.path(), chosen: k.output.chosen(), allowed: k.output.allowed() }),

    'automations.list': () => k.automations.list(),
    'automations.create': (p, ctx) => k.automations.create(AutomationInputSchema.parse(p), ctx.actor),
    'automations.update': (p, ctx) => {
      const { id, ...patch } = AutomationInputSchema.partial().extend({ id: z.string().min(1).max(64) }).parse(p);
      return k.automations.update(id, patch, ctx.actor);
    },
    'automations.remove': (p, ctx) => k.automations.remove(IdSchema.parse(p).id, ctx.actor),
    'automations.run': (p) => {
      const q = z.object({ id: z.string().min(1).max(64), trigger: z.enum(['manual', 'hotkey']).optional() }).parse(p);
      return k.automations.runNow(q.id, q.trigger);
    },
    'automations.runs': (p) => {
      const q = z.object({ id: z.string().min(1).max(64), limit: z.number().int().min(1).max(50).optional() }).parse(p);
      return k.automations.runs(q.id, q.limit);
    },
    'agent.runToCompletion': async (p, ctx) => {
      const q = z.object({ conversationId: z.string().optional(), message: z.string(), providerId: z.string().optional(), model: z.string().optional() }).parse(p);
      return k.agent.runToCompletion({ ...q, origin: ctx.origin, actor: ctx.actor });
    },
    'ai.cancel': (p) => ({ cancelled: k.agent.cancel(z.object({ runId: z.string() }).parse(p).runId) }),
    'ai.runs': () => k.agent.activities(),
    'ai.setThinking': (p) => setThinkingLevel(z.object({ level: z.enum(THINKING_LEVELS) }).parse(p).level, { policy: k.policy, settings: k.settings }),
    'ai.conversations.list': (p) => k.conversations.list(z.object({ projectId: z.string().max(64).optional() }).parse(p ?? {})),
    // The messages and the run in progress together, so the chat can carry on from exactly here with the run's events.
    'ai.conversations.get': (p) => {
      const { id } = IdSchema.parse(p);
      return { ...k.conversations.get(id), run: k.agent.activityIn(id) };
    },
    'ai.conversations.rename': (p) => {
      const q = z.object({ id: z.string(), title: z.string() }).parse(p);
      return k.conversations.rename(q.id, q.title);
    },
    // Deleting chats deletes their attachments too (the rows go with the chat; the files are swept after).
    'ai.conversations.delete': (p) => tidied({ deleted: k.conversations.delete(IdSchema.parse(p).id) }),
    'ai.conversations.deleteMany': (p) => tidied(k.conversations.deleteMany(z.object({ ids: z.array(z.string().max(64)).max(5000) }).parse(p).ids, k.agent.busyConversations())),
    'ai.conversations.cleanup': (p) => {
      const q = z.object({ olderThanDays: z.number().int().min(0).max(36500), includeProjects: z.boolean().optional(), dryRun: z.boolean().optional() }).parse(p);
      const ids = k.conversations.stale(q.olderThanDays, !!q.includeProjects);
      const busy = k.agent.busyConversations();
      if (q.dryRun) return { deleted: ids.filter((id) => !busy.has(id)).length };
      return tidied({ deleted: k.conversations.deleteMany(ids, busy).deleted });
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
    'runtime.redownload': async (p) => {
      const { modelId } = z.object({ modelId: z.string() }).parse(p);
      if (k.runtime.status().modelId === modelId) await k.runtime.stop();
      await k.models.redownload(modelId);
      return { started: true };
    },
    'runtime.logs': () => k.runtime.recentLogs().slice(-80),
    'runtime.hardware': () => k.runtime.hardware(),
    'runtime.downloads': () => {
      const rt = k.runtime.installState();
      return [...k.models.recentDownloads(), ...(rt ? [rt] : [])];
    },
    'runtime.useModel': async (p) => k.useLocalModel(z.object({ modelId: z.string() }).parse(p).modelId),
    'ai.starter': () => k.starter.status(),
    'ai.prepareStarter': () => {
      void k.starter.prepare({ auto: false });
      return k.starter.status();
    },
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
    'memory.status': () => k.memory.status(),
    'memory.add': (p) => {
      const x = z.object({ content: z.string().min(3).max(1000), category: z.enum(MEMORY_CATEGORIES).optional() }).parse(p);
      return k.memory.remember({ content: x.content, category: x.category, source: 'person' });
    },
    'memory.update': (p) => {
      const x = z.object({ id: z.string().min(1).max(80), content: z.string().min(3).max(1000) }).parse(p);
      return k.memory.update(x.id, x.content);
    },
    'memory.forget': (p) => ({ ok: k.memory.forget(IdSchema.parse(p).id) }),
    'memory.forgetAll': () => ({ forgotten: k.memory.forgetAll() }),
    'governance.folders': () => k.folders.status(),
    'governance.addFolder': (p, ctx) => k.folders.add(z.object({ path: z.string().min(1).max(4096) }).parse(p).path, ctx.actor),
    'governance.removeFolder': (p, ctx) => k.folders.remove(z.object({ entry: z.string().min(1).max(4096) }).parse(p).entry, ctx.actor),
    'governance.answerFolder': (p, ctx) => {
      const x = z.object({ id: z.string().min(1).max(80), path: z.string().min(1).max(4096).nullable() }).parse(p);
      return k.folders.answer(x.id, x.path, ctx.actor);
    },
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

    'account.status': () => k.account.status(),
    'account.signIn': (p, ctx) =>
      k.account.signIn(
        z.object({ server: z.string().max(300).optional(), email: z.string().email().max(200), password: z.string().min(1).max(200), name: z.string().max(120).optional(), create: z.boolean().optional() }).parse(p),
        ctx.actor,
      ),
    'account.signOut': (_p, ctx) => k.account.signOut(ctx.actor),
    'account.refresh': () => k.account.refresh(),
    'account.checkout': (p) => k.account.checkout(z.object({ productId: z.string().max(80) }).parse(p).productId),
    'account.portal': () => k.account.portal(),
    'account.startOrganization': (p) => k.account.startOrganization(z.object({ name: z.string().trim().min(1).max(120), kind: z.enum(VERTICALS) }).parse(p)),
    'account.join': (p, ctx) => k.account.join(z.object({ tenantId: z.string().min(1).max(80) }).parse(p).tenantId, ctx.actor),
    'account.devices': () => k.account.devices(),
    'account.signOutDevice': (p, ctx) => k.account.signOutDevice(z.object({ id: z.string().min(1).max(80) }).parse(p).id, ctx.actor),
    'account.resendConfirmation': () => k.account.resendConfirmation(),
    'account.forgotPassword': (p) => k.account.forgotPassword(z.object({ email: z.string().email().max(200), server: z.string().max(300).optional() }).parse(p)),
    'account.previewInvitation': (p) => k.account.previewInvitation(z.object({ code: z.string().min(1).max(60), server: z.string().max(300).optional() }).parse(p)),
    'account.acceptInvitation': (p, ctx) =>
      k.account.acceptInvitation(
        z.object({ code: z.string().min(1).max(60), server: z.string().max(300).optional(), name: z.string().max(120).optional(), password: z.string().min(1).max(200) }).parse(p),
        ctx.actor,
      ),

    'localAccount.status': () => k.localAccount.status(),
    'localAccount.create': (p, ctx) => k.localAccount.create(z.object({ name: z.string().trim().min(1).max(120), email: z.string().max(200).optional(), password: z.string().max(200).optional() }).parse(p), ctx.actor),
    'localAccount.update': (p, ctx) => k.localAccount.update(z.object({ name: z.string().max(120).optional(), email: z.string().max(200).nullable().optional() }).parse(p), ctx.actor),
    'localAccount.setPassword': (p, ctx) => k.localAccount.setPassword(z.object({ password: z.string().min(1).max(200), current: z.string().max(200).optional() }).parse(p), ctx.actor),
    'localAccount.clearPassword': (p, ctx) => k.localAccount.clearPassword(z.object({ current: z.string().max(200) }).parse(p), ctx.actor),
    'localAccount.unlock': (p) => k.localAccount.unlock(z.object({ password: z.string().max(200) }).parse(p)),
    'localAccount.remove': (p, ctx) => k.localAccount.remove(z.object({ confirm: z.literal('DELETE') }).parse(p), ctx.actor),

    'support.status': () => k.support.status(),
    'support.activate': (p, ctx) => k.support.activate(z.object({ pass: z.string().min(1).max(4000) }).parse(p).pass, ctx.actor),
    'support.end': (_p, ctx) => k.support.end(ctx.actor, 'ended'),

    'browser.state': () => k.browser.state(),
    'browser.check': (p) => k.browser.check(z.object({ input: z.string().max(4000) }).parse(p).input),
    'browser.bookmark': (p) => k.browser.bookmark(z.object({ url: z.string().max(2000), title: z.string().max(300) }).parse(p).url, z.object({ title: z.string().max(300) }).parse(p).title),
    'browser.removeBookmark': (p) => k.browser.removeBookmark(z.object({ id: z.string().max(80) }).parse(p).id),
    'browser.history': (p) => k.browser.history(z.object({ limit: z.number().int().min(1).max(2000).optional(), query: z.string().max(200).optional() }).parse(p ?? {})),
    'browser.visited': (p) => k.browser.visited(z.object({ url: z.string().max(2000), title: z.string().max(300) }).parse(p).url, z.object({ title: z.string().max(300) }).parse(p).title),
    'browser.clearHistory': (p) => k.browser.clearHistory(z.object({ since: z.string().max(40).optional() }).parse(p ?? {}).since),
    'browser.setHomepage': (p) => {
      k.settings.update({ browser: { homepage: z.object({ url: z.string().max(2000) }).parse(p).url } });
      return k.browser.state();
    },
    'browser.addBlocked': (p) => k.browser.addBlocked(z.object({ host: z.string().max(300) }).parse(p).host),
    'browser.removeBlocked': (p) => k.browser.removeBlocked(z.object({ host: z.string().max(300) }).parse(p).host),

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
