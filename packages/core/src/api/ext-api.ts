import { join } from 'node:path';
import { z } from 'zod';
import {
  ALERT_CHANNELS,
  LAB_FEATURES,
  MESH_ACTIONS,
  PRINTER_ACTIONS,
  STORAGE_ACTIONS,
  TASK_STATUSES,
  VM_ACTIONS,
  type ExtMethods,
  type SpotlightItem,
} from '@fbrx/shared';
import { CoreError } from '../errors';
import type { Kernel } from '../kernel';
import { checkLink } from '../security/linkcheck';
import { expandPath } from '../system/files';
import * as lab from '../windows/lab';
import * as sec from '../windows/security';
import * as storage from '../windows/storage';
import * as fixes from '../windows/troubleshoot';
import * as updates from '../windows/updates';
import type { CallContext } from './core-api';

type Handler = (params: any, ctx: CallContext) => unknown | Promise<unknown>;

const Id = z.object({ id: z.string().min(1) });
const Path = z.object({ path: z.string().min(1).max(4096) });
const ReqId = z.string().min(1).max(64);
const VIRUSTOTAL_SECRET = 'VIRUSTOTAL_API_KEY';

const SpotlightItemSchema = z.object({
  id: z.string().max(4200),
  kind: z.string().max(20),
  title: z.string().max(500),
  subtitle: z.string().max(5000).optional(),
  score: z.number(),
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('nav'), route: z.string().max(200) }),
    z.object({ type: z.literal('copy'), text: z.string().max(200_000) }),
    z.object({ type: z.literal('open'), path: z.string().max(4096) }),
    z.object({ type: z.literal('app'), appId: z.string().max(500) }),
    z.object({ type: z.literal('url'), url: z.string().max(4096) }),
    z.object({ type: z.literal('system'), name: z.string().max(20), confirm: z.boolean() }),
    z.object({ type: z.literal('ask'), prompt: z.string().max(10_000) }),
  ]),
});

/**
 * Handlers for the command-center modules. Requests that do not come from the person at the workstation (Local API,
 * remote commands) may only read files inside the folders governance allows.
 */
export function buildExtApi(k: Kernel): Record<keyof ExtMethods, Handler> {
  const vt = () => (k.vault.isUnlocked ? k.vault.get(VIRUSTOTAL_SECRET) : undefined);
  const guardPath = (p: string, ctx: CallContext) => {
    const full = expandPath(p);
    if (ctx.origin !== 'user' && !k.policy.allowedRoots().some((r) => full === r || full.startsWith(r.endsWith('\\') || r.endsWith('/') ? r : `${r}${process.platform === 'win32' ? '\\' : '/'}`))) {
      throw new CoreError('FORBIDDEN', 'That folder is outside the folders automation may read');
    }
    return full;
  };

  return {
    // ------------------------------------------------------------------------------------- workspace
    'notes.list': (p) => k.workspace.listNotes(z.object({ projectId: z.string().optional(), query: z.string().max(200).optional() }).parse(p ?? {})),
    'notes.save': (p) => k.workspace.saveNote(p),
    'notes.delete': (p) => ({ deleted: k.workspace.deleteNote(Id.parse(p).id) }),
    'tasks.list': (p) => k.workspace.listTasks(z.object({ projectId: z.string().optional(), status: z.enum(TASK_STATUSES).optional() }).parse(p ?? {})),
    'tasks.save': (p) => k.workspace.saveTask(p),
    'tasks.delete': (p) => ({ deleted: k.workspace.deleteTask(Id.parse(p).id) }),
    'projects.list': () => k.workspace.listProjects(),
    'projects.save': (p) => k.workspace.saveProject(p),
    'projects.delete': (p) => {
      const q = z.object({ id: z.string(), cascade: z.boolean().optional() }).parse(p);
      return { deleted: k.workspace.deleteProject(q.id, q.cascade) };
    },
    'snippets.list': (p) => k.workspace.listSnippets(z.object({ projectId: z.string().optional(), query: z.string().max(200).optional() }).parse(p ?? {})),
    'snippets.save': (p) => k.workspace.saveSnippet(p),
    'snippets.delete': (p) => ({ deleted: k.workspace.deleteSnippet(Id.parse(p).id) }),

    // ------------------------------------------------------------------------------- system & files
    'sysinfo.static': () => k.monitor.static(),
    'sysinfo.live': () => k.monitor.live(),
    'processes.list': (p) => k.monitor.processes(z.object({ sort: z.enum(['cpu', 'memory']).optional(), filter: z.string().max(100).optional(), limit: z.number().int().min(1).max(1000).optional() }).parse(p ?? {})),
    'processes.kill': async (p) => {
      const { pid } = z.object({ pid: z.number().int() }).parse(p);
      const name = (await k.monitor.processes({ filter: String(pid), limit: 5 })).list.find((x) => x.pid === pid)?.name;
      return { killed: k.monitor.kill(pid, name) };
    },
    'files.home': () => k.files.home(),
    'files.list': (p, ctx) => {
      const q = z.object({ path: z.string().min(1), hidden: z.boolean().optional() }).parse(p);
      return k.files.list(guardPath(q.path, ctx), q.hidden);
    },
    'files.read': (p, ctx) => k.files.read(guardPath(Path.parse(p).path, ctx)),
    'files.write': async (p) => {
      const q = z.object({ path: z.string().min(1), content: z.string() }).parse(p);
      await k.files.write(q.path, q.content);
      return { ok: true };
    },
    'files.open': (p) => {
      k.files.open(Path.parse(p).path);
      return { ok: true };
    },
    'files.search': async (p, ctx) => {
      const q = z.object({ root: z.string().min(1), pattern: z.string().min(1).max(200) }).parse(p);
      return { results: await k.files.search(guardPath(q.root, ctx), q.pattern) };
    },
    'terminal.run': (p) => {
      const q = z.object({ command: z.string().min(1).max(10_000), cwd: z.string().optional() }).parse(p);
      k.audit.append({ category: 'terminal', action: 'run', actor: 'user', outcome: 'info', details: { command: q.command.slice(0, 500) } });
      return k.terminal.run(q.command, q.cwd);
    },
    'terminal.kill': (p) => ({ killed: k.terminal.kill(z.object({ sessionId: z.string() }).parse(p).sessionId) }),

    // -------------------------------------------------------------------------------------- spotlight
    'spotlight.query': (p) => k.spotlight.query(z.object({ q: z.string().max(500) }).parse(p).q),
    'spotlight.files': (p) => k.spotlight.files(z.object({ q: z.string().max(500) }).parse(p).q),
    'spotlight.run': async (p) => {
      const q = z.object({ item: SpotlightItemSchema, modifier: z.enum(['reveal', 'copy']).optional() }).parse(p);
      const item = q.item as SpotlightItem;
      k.spotlight.remember(item);
      const a = item.action;
      if (a.type === 'nav') return { ok: true, navigate: a.route };
      if (a.type === 'ask') return { ok: true, ask: a.prompt };
      if (a.type === 'copy') return { ok: true };
      if (q.modifier === 'reveal' && a.type === 'open') {
        k.files.open(join(a.path, '..'));
        return { ok: true };
      }
      const message = await k.spotlight.launch(a);
      return { ok: true, message };
    },
    'spotlight.ask': async (p, ctx) => {
      const { q } = z.object({ q: z.string().min(1).max(4000) }).parse(p);
      const r = await k.agent.runToCompletion({ message: `${q}\n\n(Answer briefly: this question came from the Spotlight search bar.)`, origin: ctx.origin, actor: ctx.actor });
      return { answer: r.answer || r.error || 'No answer' };
    },

    // ----------------------------------------------------------------------------------------- alerts
    'alerts.rules': () => k.alerts.rules(),
    'alerts.inbox': (p) => k.alerts.inbox(z.object({ limit: z.number().int().optional(), unreadOnly: z.boolean().optional() }).parse(p ?? {})),
    'alerts.markRead': (p) => {
      k.alerts.markRead(Id.parse(p).id);
      return { ok: true };
    },
    'alerts.delete': (p) => {
      k.alerts.remove(Id.parse(p).id);
      return { ok: true };
    },
    'alerts.test': (p) => k.alerts.test(z.object({ channel: z.enum(ALERT_CHANNELS) }).parse(p).channel),
    'alerts.counts': () => k.alerts.counts(),

    // ---------------------------------------------------------------------------------------- storage
    'storage.drives': () => storage.drives(),
    'storage.disks': () => storage.physicalDisks(),
    'storage.cleanupInfo': () => storage.cleanupInfo(),
    'storage.cleanTemp': () => storage.cleanTemp(),
    'storage.emptyRecycleBin': async () => {
      await storage.emptyRecycleBin();
      return { ok: true };
    },
    'storage.analyze': (p, ctx) => storage.analyzeFolder(guardPath(Path.parse(p).path, ctx)),
    'storage.maintenance': (p) =>
      storage.maintenance(z.object({ action: z.enum(STORAGE_ACTIONS), letter: z.string().max(3).optional(), value: z.string().max(64).optional(), disk: z.number().int().optional(), partition: z.number().int().optional() }).parse(p)),

    // --------------------------------------------------------------------------------------- security
    'security.defender': () => sec.defenderStatus(),
    'security.defenderPrefs': () => sec.defenderPrefs(),
    'security.setDefenderPref': (p) => {
      const q = z.object({ name: z.string(), value: z.union([z.boolean(), z.number(), z.string().max(100)]) }).parse(p);
      return sec.setDefenderPref(q.name, q.value);
    },
    'security.exclusion': (p) => {
      const q = z.object({ kind: z.enum(['path', 'ext', 'process']), value: z.string().min(1).max(1024), remove: z.boolean().optional() }).parse(p);
      return sec.exclusion(q.kind, q.value, q.remove);
    },
    'security.threats': () => sec.threats(),
    'security.scan': (p) => {
      const q = z.object({ type: z.enum(['quick', 'full', 'custom']), path: z.string().optional() }).parse(p);
      return sec.scan(q.type, q.path);
    },
    'security.updateSignatures': () => sec.updateSignatures(),
    'security.removeThreats': () => sec.removeThreats(),
    'security.firewall': () => sec.firewall(),
    'security.setFirewall': (p) => {
      const q = z.object({ profile: z.enum(['Domain', 'Private', 'Public']), enabled: z.boolean() }).parse(p);
      return sec.setFirewall(q.profile, q.enabled);
    },
    'security.ports': () => sec.listeningPorts(),
    'security.processAudit': () => sec.processAudit(),
    'security.startup': () => sec.startupAudit(),
    'security.fileReport': (p, ctx) => sec.fileReport(guardPath(Path.parse(p).path, ctx), vt()),
    'security.linkCheck': (p) => {
      if (!k.internetAllowed()) throw new CoreError('POLICY_DENIED', 'Your organization blocks internet access from FBRX OS');
      return checkLink(z.object({ url: z.string().min(1).max(4096) }).parse(p).url, { virustotalKey: vt() });
    },
    'security.sandbox': async (p) => {
      await sec.openSandbox(z.object({ url: z.string().max(4096).optional(), folder: z.string().optional(), networking: z.boolean().optional() }).parse(p ?? {}), k.paths.tmp);
      return { ok: true };
    },
    'security.open': (p) => {
      sec.openSecurityPage(z.object({ page: z.string() }).parse(p).page);
      return { ok: true };
    },

    // ---------------------------------------------------------------------------------- troubleshoot
    'bugs.scan': (p) => fixes.bugScan(z.object({ days: z.number().int().min(1).max(30).optional() }).parse(p ?? {}).days),
    'bugs.fixes': () => fixes.fixes(),
    'bugs.events': (p) => {
      const q = z.object({ log: z.enum(['System', 'Application', 'Setup']), days: z.number().int().min(1).max(30).optional(), minLevel: z.enum(['error', 'warning', 'information']).optional(), limit: z.number().int().min(1).max(2000).optional() }).parse(p);
      return fixes.eventLog(q.log, q.days, q.minLevel, q.limit);
    },
    'bugs.fix': (p) => {
      const q = z.object({ id: z.string().max(40), target: z.string().max(512).optional() }).parse(p);
      return fixes.runFix(q.id, q.target);
    },

    // --------------------------------------------------------------------------------------- updates
    'winupdates.apps': () => updates.appUpgrades(),
    'winupdates.upgradeApp': (p) => {
      const q = z.object({ id: z.string().min(1).max(130), reqId: ReqId }).parse(p);
      return updates.upgradeApp(q.id, (line) => k.events.emit('winupdates.event', { reqId: q.reqId, line }));
    },
    'winupdates.windows': () => updates.windowsUpdates(),
    'winupdates.drivers': () => updates.drivers(),
    'winupdates.hotfixes': () => updates.hotfixes(),
    'winupdates.open': (p) => {
      updates.openUpdatePage(z.object({ page: z.enum(['check', 'history', 'advanced', 'optional', 'store']) }).parse(p).page);
      return { ok: true };
    },

    // ------------------------------------------------------------------------------------------- lab
    'lab.status': () => lab.labStatus(),
    'lab.enableFeature': (p) => lab.enableFeature(z.object({ feature: z.enum(LAB_FEATURES) }).parse(p).feature),
    'lab.vms': (p) => lab.vmList(!!z.object({ elevated: z.boolean().optional() }).parse(p ?? {}).elevated),
    'lab.createVm': (p) =>
      lab.createVm(
        z
          .object({
            name: z.string().min(1).max(60),
            os: z.enum(['windows', 'linux']),
            cpus: z.number().int().min(1).max(32),
            memoryGB: z.number().min(1).max(64),
            diskGB: z.number().int().min(10).max(2000),
            network: z.enum(['none', 'isolated', 'internet']),
            iso: z.string().max(1024).optional(),
            hardened: z.boolean().optional(),
          })
          .parse(p),
      ),
    'lab.vmAction': (p) => {
      const q = z.object({ name: z.string().min(1).max(100), action: z.enum(VM_ACTIONS), arg: z.string().max(100).optional() }).parse(p);
      return lab.vmAction(q.name, q.action, q.arg);
    },
    'lab.openManager': () => {
      lab.openManager();
      return { ok: true };
    },

    // --------------------------------------------------------------------------------------- network
    'net.context': () => k.net.context(),
    'net.publicIp': () => k.net.publicIp(),
    'net.ping': (p) => {
      const q = z.object({ host: z.string().min(1).max(253), count: z.number().int().min(1).max(50).optional() }).parse(p);
      return k.net.ping(q.host, q.count);
    },
    'net.traceroute': (p) => {
      const q = z.object({ host: z.string().min(1).max(253), reqId: ReqId }).parse(p);
      return k.net.traceroute(q.host, q.reqId);
    },
    'net.scan': async (p) => {
      const q = z.object({ reqId: ReqId, subnet: z.string().max(20).optional(), label: z.string().max(80).optional() }).parse(p);
      const scan = await k.net.scan(q.reqId, q.subnet, q.label);
      const known = k.net.knownMacs(scan.id);
      if (known.size) {
        for (const d of scan.devices) {
          if (d.mac && !d.isSelf && !known.has(d.mac.toLowerCase())) {
            void k.alerts.fire('new_device', 'New device on your network', `${d.name ?? 'Unknown device'} (${d.vendor ?? 'unknown maker'}) at ${d.ip}, MAC ${d.mac}.`, { key: d.mac });
          }
        }
      }
      return scan;
    },
    'net.scans': () => k.net.scans(),
    'net.scanGet': (p) => k.net.getScan(Id.parse(p).id),
    'net.scanDelete': (p) => ({ deleted: k.net.deleteScan(Id.parse(p).id) }),
    'net.compare': (p) => {
      const q = z.object({ a: z.string(), b: z.string() }).parse(p);
      return k.net.compare(q.a, q.b);
    },
    'net.exportCsv': (p) => {
      const q = z.object({ id: z.string(), path: z.string().min(1) }).parse(p);
      return k.net.exportCsv(q.id, expandPath(q.path));
    },
    'net.speedTest': (p) => k.net.speedTest(z.object({ reqId: ReqId }).parse(p).reqId),
    'net.speedHistory': () => k.net.speedHistory(),
    'net.wifi': () => k.net.wifi(),
    'net.bluetooth': () => k.net.bluetooth(),
    'net.printers': () => k.net.printers(),
    'net.printerAction': async (p) => {
      const q = z.object({ name: z.string().max(256), action: z.enum(PRINTER_ACTIONS) }).parse(p);
      await k.net.printerAction(q.name, q.action);
      return { ok: true };
    },
    'net.dns': (p) => k.net.dnsTest(z.object({ name: z.string().min(1).max(253) }).parse(p).name),
    'net.port': (p) => {
      const q = z.object({ host: z.string().min(1).max(253), port: z.number().int() }).parse(p);
      return k.net.port(q.host, q.port);
    },
    'net.adapters': () => k.net.adapters(),
    'net.setIp': (p) =>
      k.net.setIp(
        z
          .object({
            alias: z.string().min(1).max(256),
            mode: z.enum(['dhcp', 'static', 'secondary', 'removeSecondary']),
            ip: z.string().max(15).optional(),
            prefix: z.union([z.number(), z.string().max(15)]).optional(),
            gateway: z.string().max(15).optional(),
            dns: z.array(z.string().max(15)).max(4).optional(),
          })
          .parse(p),
      ),
    'net.ssh': (p) => {
      const q = z.object({ host: z.string().min(1).max(253), user: z.string().max(64).optional(), port: z.number().int().optional() }).parse(p);
      k.net.ssh(q.host, q.user, q.port);
      return { ok: true };
    },

    // ------------------------------------------------------------------------------------------ mesh
    'mesh.status': () => k.mesh.status(),
    'mesh.setEnabled': async (p) => {
      k.settings.update({ mesh: { enabled: z.object({ enabled: z.boolean() }).parse(p).enabled } });
      await k.services.reconcile();
      return k.mesh.status();
    },
    'mesh.startPairing': () => k.mesh.startPairing(),
    'mesh.cancelPairing': () => k.mesh.cancelPairing(),
    'mesh.pair': (p) => {
      const q = z.object({ code: z.string().min(10).max(60), host: z.string().min(1).max(260) }).parse(p);
      return k.mesh.pairWith(q.code, q.host);
    },
    'mesh.removeDevice': (p) => k.mesh.removeDevice(Id.parse(p).id),
    'mesh.setPermissions': (p) => {
      const q = z.object({ id: z.string(), permissions: z.record(z.string(), z.boolean()) }).parse(p);
      return k.mesh.setPermissions(q.id, q.permissions);
    },
    'mesh.rename': (p) => {
      k.settings.update({ general: { deviceName: z.object({ name: z.string().min(1).max(80) }).parse(p).name } });
      return k.mesh.status();
    },
    'mesh.peerInfo': (p) => k.mesh.peerInfo(Id.parse(p).id),
    'mesh.ask': (p) => {
      const q = z.object({ id: z.string(), prompt: z.string().min(1).max(8000), reqId: ReqId }).parse(p);
      return k.mesh.ask(q.id, q.prompt, q.reqId);
    },
    'mesh.message': (p) => k.mesh.message(z.object({ text: z.string().min(1).max(4000) }).parse(p).text),
    'mesh.messages': () => k.mesh.messages(),
    'mesh.action': async (p) => {
      const q = z.object({ id: z.string(), action: z.enum(MESH_ACTIONS), text: z.string().max(500).optional() }).parse(p);
      await k.mesh.action(q.id, q.action, q.text);
      return { ok: true };
    },

    // -------------------------------------------------------------------------------- AI coordination
    'aicoord.detect': () => k.aicoord.detect(),
    'aicoord.bridge': () => k.aicoord.bridge(),
    'aicoord.install': (p) => k.aicoord.install(z.object({ appId: z.string() }).parse(p).appId),
    'aicoord.remove': (p) => k.aicoord.remove(z.object({ appId: z.string() }).parse(p).appId),
    'aicoord.launch': (p) => k.aicoord.launch(z.object({ appId: z.string() }).parse(p).appId),
    'aicoord.consult': async (p) => {
      const q = z.object({ providerId: z.string(), prompt: z.string().min(1).max(50_000), model: z.string().optional() }).parse(p);
      return k.consult(q.providerId, q.prompt, q.model);
    },
  };
}
