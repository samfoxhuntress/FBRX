import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, freemem, hostname, loadavg, userInfo, platform as osPlatform, arch as osArch, totalmem, uptime as osUptime } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  LICENSE_FILE_NAME,
  decodeLicenseUnverified,
  PRODUCT_NAME,
  ProvisioningFileSchema,
  addressAs,
  funEnabled,
  shouldNotify,
  essentialsNotifies,
  TIER_NAMES,
  type DeviceCommand,
  type Heartbeat,
  type NotificationEvent,
  type PresenterStatus,
  type RuntimeStatus,
  type Audience,
  type DeviceEdition,
  type EditionStatus,
  type Vertical,
  VERTICAL_AUDIENCES,
  isLearner,
  productNameFor,
  parseTier,
  type Tier,
  type SystemStatus,
  type UpdateStatus,
  type OrgMeshRoster,
} from '@fbrx/shared';
import { CoreError, errorMessage, toCoreError } from './errors';
import { EventBus } from './events';
import { LogSink, Logger } from './logger';
import { ensureDataDirs, resolveDataPaths, type DataPaths } from './paths';
import type { PlatformAdapter } from './platform';
import { Db } from './storage/db';
import { MIGRATIONS } from './storage/migrations';
import { MetaStore } from './storage/meta';
import { SettingsService } from './settings/settings-service';
import { Vault } from './vault/vault';
import { AuditLog } from './audit/audit-log';
import { PolicyEngine } from './governance/policy-engine';
import { FolderAccess } from './governance/folder-access';
import { KnowledgeBase } from './knowledge/knowledge-base';
import { MemoryService } from './ai/memory';
import { runDoctor, type DoctorFinding } from './knowledge/doctor';
import { fbrx1Commands } from './cli/fbrx1';
import { expandPathVars } from './governance/path-guard';
import { Guardian } from './governance/guardian';
import { ApprovalQueue } from './governance/approvals';
import { Redactor } from './governance/redactor';
import { RateLimiter } from './governance/rate-limiter';
import { ToolGate } from './governance/tool-gate';
import { checkUrl } from './governance/network-guard';
import { LicenseService } from './license/license-service';
import { ToolRegistry } from './tools/registry';
import { fbrxTools, folderTools, fsTools, knowledgeTools, memoryTools, netTools, shellTools, systemTools, diskFreeGb } from './tools/builtin';
import { pcTools, workspaceTools } from './tools/builtin/command-center-tools';
import { WorkspaceStore } from './workspace/workspace-store';
import { SystemMonitor } from './system/system-monitor';
import { Migrator } from './system/migrate';
import { CodeLab } from './system/codelab';
import { VoiceModels } from './ai/voice-models';
import { FileBrowser, TerminalSessions } from './system/files';
import { Spotlight } from './spotlight/spotlight';
import { AlertEngine } from './alerts/alert-engine';
import { NetDiag } from './network/netdiag';
import { Trophies } from './fun/trophies';
import { Fbrx1Cli } from './cli/fbrx1';
import { VendorDb } from './network/vendors';
import { DeviceConsoles } from './network/device-console';
import { deviceConsoleTools } from './tools/builtin/device-console-tools';
import { netEnvTools } from './tools/builtin/netenv-tools';
import { calendarTools } from './tools/builtin/calendar-tools';
import { CalendarService } from './calendar/calendar-service';
import { Shield } from './protection/shield';
import { ProtectionService } from './protection/protection-service';
import { ImageBackupService } from './time/image-backup';
import { elevated as runElevated, ps as runPs } from './windows/ps';
import { shieldTools } from './tools/builtin/shield-tools';
import { helpdeskTools } from './tools/builtin/helpdesk-tools';
import { NetEnvironments } from './network/environments';
import { Helpdesk } from './fleet/helpdesk';
import { HelpdeskAssistHost } from './fleet/helpdesk-assist';
import { Messages } from './messages/messages';
import { sleep } from './util/misc';
import { MeshService } from './mesh/mesh-service';
import { generateKeyPair, type KeyPair } from './mesh/mesh-crypto';
import { MeshAssist, runsElevated } from './mesh/mesh-assist';
import { MeshNetwork } from './mesh/mesh-network';
import { ServerResources } from './system/server-resources';
import { SavedServers } from './system/saved-servers';
import { OrgMesh } from './mesh/org-mesh';
import { meshTools } from './tools/builtin/mesh-tools';
import { AiCoordination } from './aicoord/aicoord';
import { ConversationStore } from './ai/conversations';
import { ModelManager } from './ai/runtime/model-manager';
import { StarterAi } from './ai/runtime/starter';
import { LocalRuntime } from './ai/runtime/local-runtime';
import { ProviderManager } from './ai/provider-manager';
import { AgentRuntime } from './ai/agent';
import type { ProviderMessage } from './ai/providers/types';
import { installModelReviewer } from './ai/guardian-reviewer';
import { PluginHost } from './plugins/plugin-host';
import { ConnectorHub } from './connectors/hub';
import { BackupService } from './backup/backup-service';
import { applyStagedRestore, stageRestore } from './backup/snapshot';
import { FleetAgent } from './fleet/fleet-agent';
import { deviceFacts } from './fleet/machine';
import { LocalApiServer } from './localapi/local-api';
import { ServiceManager } from './services/service-manager';
import { buildCoreApi, isReadOnly, isUserOnly, scrubParams, type CallContext } from './api/core-api';
import { buildExtApi } from './api/ext-api';
import { installConsoleGuard } from './windows/hide-consoles';
import { INSTALL_SOURCE_FILE, ReleaseChecker } from './updates/release-check';
import { pinnedAgent, pinnedFetch } from './util/pinned-tls';

export interface KernelOptions {
  dataDir: string;
  platform: PlatformAdapter;
  logToConsole?: boolean;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  /** Extra locations to look for an fbrx-provision.json (e.g. next to the installer). */
  provisioningFiles?: string[];
}

const LOCAL_API_TOKEN = 'fbrx.localapi.token';
const LOCAL_API_AGENT_TOKEN = 'fbrx.localapi.agentToken';
const MESH_KEY = 'fbrx.mesh.key';
/** Where the MCP bridge finds the Local API address and agent token (readable by this user only). */
const AGENT_TOKEN_FILE = 'localapi-agent.json';

/**
 * The FBRX OS kernel: owns storage and every service, exposes the single core API surface used by the
 * desktop UI (IPC), the Local API, and the fleet agent. Shell-agnostic: the Electron app and the headless
 * runner both host the same kernel.
 */
export class Kernel {
  readonly events = new EventBus();
  readonly logSink: LogSink;
  readonly log: Logger;
  readonly paths: DataPaths;
  readonly platform: PlatformAdapter;
  readonly startedAt = new Date();

  readonly db: Db;
  readonly meta: MetaStore;
  readonly settings: SettingsService;
  readonly audit: AuditLog;
  readonly vault: Vault;
  readonly policy: PolicyEngine;
  readonly guardian = new Guardian();
  readonly approvals: ApprovalQueue;
  /** The folders the AI may use, and its requests for more (Governance → Folders). */
  readonly folders: FolderAccess;
  /** FBRX's own guides, playbooks and commands, in a local search database (fbrx.help). */
  readonly knowledge: KnowledgeBase;
  /** What the AI remembers about the person, on this computer only (Settings → Memory). */
  readonly memory: MemoryService;
  readonly redactor = new Redactor();
  readonly limiter: RateLimiter;
  readonly license: LicenseService;
  readonly registry: ToolRegistry;
  readonly gate: ToolGate;
  readonly conversations: ConversationStore;
  readonly models: ModelManager;
  readonly starter: StarterAi;
  readonly runtime: LocalRuntime;
  readonly providers: ProviderManager;
  readonly agent: AgentRuntime;
  readonly plugins: PluginHost;
  readonly connectors: ConnectorHub;
  readonly backup: BackupService;
  readonly fleet: FleetAgent;
  readonly localApi: LocalApiServer;
  readonly services: ServiceManager;
  readonly workspace: WorkspaceStore;
  readonly monitor: SystemMonitor;
  readonly files: FileBrowser;
  readonly terminal: TerminalSessions;
  readonly spotlight: Spotlight;
  readonly alerts: AlertEngine;
  readonly net: NetDiag;
  readonly netenv: NetEnvironments;
  readonly calendar: CalendarService;
  readonly shield: Shield;
  readonly protection: ProtectionService;
  /** FBRX Time on this computer: whole-computer images (Windows). */
  readonly imageBackup: ImageBackupService;
  readonly helpdesk: Helpdesk;
  /** The help desk working on this computer from a ticket it sent. */
  readonly helpdeskAssist: HelpdeskAssistHost;
  readonly messages: Messages;
  readonly vendors: VendorDb;
  readonly consoles: DeviceConsoles;
  readonly trophies: Trophies;
  readonly migrator: Migrator;
  readonly codelab: CodeLab;
  readonly voice: VoiceModels;
  readonly release: ReleaseChecker;
  readonly cli: Fbrx1Cli;
  readonly mesh: MeshService;
  readonly orgMesh: OrgMesh;
  readonly assist: MeshAssist;
  /** Prefer Mesh: mesh networks, priority marking and path tests. */
  readonly meshNetwork: MeshNetwork;
  /** FBRX Server resources (installer ISO, bundle, guides) shipped inside the app. */
  readonly serverResources: ServerResources;
  readonly servers: SavedServers;
  readonly aicoord: AiCoordination;
  private readonly api: Record<string, (p: any, ctx: CallContext) => unknown>;
  private disposers: Array<() => void> = [];
  private started = false;
  private restoredThisBoot = false;
  private provisioningFiles: string[];

  constructor(opts: KernelOptions) {
    this.platform = opts.platform;
    this.paths = resolveDataPaths(opts.dataDir);
    ensureDataDirs(this.paths);
    this.logSink = new LogSink({ dir: this.paths.logs, console: opts.logToConsole, level: opts.logLevel ?? (opts.platform.devMode ? 'debug' : 'info') });
    this.log = new Logger(this.logSink, 'core');
    this.provisioningFiles = [join(this.paths.root, 'fbrx-provision.json'), ...(opts.provisioningFiles ?? [])];
    if (process.env.FBRX_PROVISION_FILE) this.provisioningFiles.push(process.env.FBRX_PROVISION_FILE);

    // A restore staged before the last restart is swapped in before the database is opened.
    try {
      this.restoredThisBoot = applyStagedRestore(this.paths, (m, d) => this.log.warn(m, d));
    } catch (err) {
      this.log.error('Failed to apply staged restore; continuing with existing data', err);
    }

    this.db = new Db(this.paths.db);
    const mig = this.db.migrate(MIGRATIONS);
    if (mig.from !== mig.to) this.log.info('Database migrated', mig);
    this.meta = new MetaStore(this.db);
    if (!this.meta.get('install.id')) {
      this.meta.set('install.id', randomBytes(8).toString('hex'));
      this.meta.set('install.createdAt', new Date().toISOString());
    }

    const L = (s: string) => this.log.child(s);
    this.settings = new SettingsService(this.db, this.events);
    this.audit = new AuditLog(this.db, this.meta, this.events);
    this.vault = new Vault(this.db, this.platform.keychain, L('vault'), this.events, this.platform.movedKeychain ?? null);
    this.policy = new PolicyEngine(
      this.db,
      () => ({ ...this.platform.specialDirs(), workspace: this.paths.workspace, data: this.paths.root }),
      this.events,
    );
    this.approvals = new ApprovalQueue(this.events);
    this.folders = new FolderAccess({
      policy: this.policy,
      events: this.events,
      audit: this.audit,
      expand: (entry) => expandPathVars(entry, { ...this.platform.specialDirs(), workspace: this.paths.workspace, data: this.paths.root }),
      agentName: () => this.settings.get().ai.agentName,
      notify: (title, body) => this.notify({ title, body, level: 'warning', source: 'governance', open: 'governance' }),
      timeoutSeconds: () => this.policy.policy.approvals.timeoutSeconds,
    });
    this.memory = new MemoryService({ db: this.db, settings: () => this.settings.get().memory, learner: () => this.edition().learner, events: this.events });
    this.guardian.setPrivateValues(() => this.memory.privateValues());
    this.knowledge = new KnowledgeBase({ file: join(this.paths.root, 'knowledge.db'), appVersion: this.platform.appVersion, commands: fbrx1Commands, log: L('knowledge') });
    this.limiter = new RateLimiter(() => this.policy.policy.rateLimits.toolCallsPerMinute);
    this.license = new LicenseService(this.meta, this.platform.licensePublicKeys, this.platform.appVersion, this.platform.devMode, this.events);
    // The edition a computer starts in: a new one opens in Essentials (with its walkthrough); one set up before
    // Essentials existed keeps what it had (up to what it may run now).
    if (this.meta.get<Tier>('edition.chosen') == null) {
      const tried = this.platform.devMode ? parseTier(process.env.FBRX_EDITION) : null;
      this.meta.set('edition.chosen', this.platform.devMode ? (tried ?? 'ultra') : this.settings.get().general.onboardingComplete ? 'ultra' : 'essentials');
      if (this.settings.get().general.onboardingComplete) this.meta.set('edition.tourDone', true);
    }
    this.registry = new ToolRegistry(this.db);
    this.gate = new ToolGate({
      registry: this.registry,
      policy: this.policy,
      guardian: this.guardian,
      approvals: this.approvals,
      redactor: this.redactor,
      audit: this.audit,
      license: this.license,
      limiter: this.limiter,
      log: L('gate'),
      agentToolsBlocked: () => (this.edition().learner ? 'The learning helper on student computers does not use tools' : null),
    });
    this.conversations = new ConversationStore(this.db);
    this.models = new ModelManager(this.db, this.paths.models, () => this.settings.get().runtime.modelId, L('models'), this.events);
    this.runtime = new LocalRuntime({
      settings: this.settings,
      models: this.models,
      runtimeDir: this.paths.runtime,
      resourcesDir: this.platform.resourcesDir,
      log: L('runtime'),
      events: this.events,
    });
    this.starter = new StarterAi({ models: this.models, runtime: this.runtime, settings: () => this.settings.get(), meta: this.meta, events: this.events, log: L('starter-ai'), use: (id) => this.useLocalModel(id) });
    this.providers = new ProviderManager({ settings: this.settings, vault: this.vault, policy: this.policy, license: this.license, runtime: this.runtime });
    this.agent = new AgentRuntime({
      store: this.conversations,
      providers: this.providers,
      gate: this.gate,
      registry: this.registry,
      policy: this.policy,
      approvals: this.approvals,
      license: this.license,
      settings: this.settings,
      audit: this.audit,
      events: this.events,
      log: L('agent'),
      workspace: this.paths.workspace,
      allowedRoots: () => this.policy.allowedRoots(),
      halt: () => this.aiHalt(),
      learner: () => {
        const e = this.edition();
        return e.learner ? { vertical: e.vertical } : null;
      },
      onConcern: (category) => this.reportConcern(category),
      memory: { context: (o) => this.memory.context(o), learn: (text) => this.memory.learn(text) },
      assist: {
        canHandoff: (trigger) => this.assist.canHandoff(trigger),
        handoff: (h) => this.assist.handoff(h),
      },
      fun: {
        enabled: () => funEnabled(this.settings.get(), this.license.status().tier),
        trophy: (id) => void this.trophies.unlock(id),
        persona: {
          get: (c) => this.meta.get<string>(`agent.persona.${c}`),
          set: (c, v) => (v ? this.meta.set(`agent.persona.${c}`, v) : this.meta.delete(`agent.persona.${c}`)),
        },
      },
    });
    const urlCheck = (u: string) => checkUrl(u, this.policy.policy.network);
    this.plugins = new PluginHost({
      db: this.db,
      pluginsDir: this.paths.plugins,
      pluginDataDir: this.paths.pluginData,
      tmpDir: this.paths.tmp,
      workerPath: this.platform.pluginWorkerPath,
      sandbox: this.platform.sandboxPlugins,
      appVersion: this.platform.appVersion,
      registry: this.registry,
      vault: this.vault,
      audit: this.audit,
      checkUrl: urlCheck,
      notify: (title, body, source) => this.notify({ title, body, level: 'info', source }),
      log: L('plugins'),
      calendar: (from, to) =>
        this.calendar.events(from, to).map((e) => ({ title: e.title, start: e.start, end: e.end, allDay: e.allDay, location: e.location, showAs: e.showAs, cancelled: e.cancelled, calendar: e.calendarName })),
      events: this.events,
    });
    this.connectors = new ConnectorHub({
      db: this.db,
      registry: this.registry,
      vault: this.vault,
      audit: this.audit,
      license: this.license,
      log: L('connectors'),
      events: this.events,
      appVersion: this.platform.appVersion,
    });
    this.backup = new BackupService({
      db: this.db,
      meta: this.meta,
      paths: this.paths,
      vault: this.vault,
      keychain: this.platform.keychain,
      settings: this.settings,
      audit: this.audit,
      log: L('backup'),
      appVersion: this.platform.appVersion,
      device: () => ({ name: this.deviceName(), hostname: hostname(), platform: osPlatform(), deviceId: this.fleet?.deviceId ?? null }),
      notify: (title, body, level) => this.notify({ title, body, level, source: 'backup' }),
      requestRestart: (reason) => this.platform.requestRestart(reason),
      canSchedule: () => this.license.has('backup.scheduled'),
    });
    this.fleet = new FleetAgent({
      db: this.db,
      meta: this.meta,
      vault: this.vault,
      settings: this.settings,
      policy: this.policy,
      license: this.license,
      audit: this.audit,
      events: this.events,
      log: L('fleet'),
      tmpDir: this.paths.tmp,
      updates: this.platform.updates,
      facts: () => deviceFacts(this.platform.appVersion, this.deviceName()),
      heartbeatStatus: () => this.heartbeatStatus(),
      executeCommand: (cmd) => this.executeRemoteCommand(cmd),
      onMessage: (msg) => {
        this.helpdesk.onPush(msg);
        this.messages.onPush(msg);
        if (msg.type === 'mesh.roster') void this.orgMesh.sync();
      },
    });
    this.helpdesk = new Helpdesk({
      fleet: this.fleet,
      events: this.events,
      log: L('helpdesk'),
      requesterName: () => this.settings.get().profile.name || this.deviceName(),
      diagnostics: () => this.ticketDiagnostics(),
      notify: (title, body) => this.notify({ title, body, level: 'info', source: 'helpdesk' }),
    });
    this.helpdeskAssist = new HelpdeskAssistHost({
      mode: () => this.settings.get().helpdesk.assist,
      approvals: this.approvals,
      approvalSeconds: () => Math.max(this.policy.policy.approvals.timeoutSeconds, 180),
      diagnostics: async () => {
        // All at once: each one asks the system (PowerShell on Windows), which takes seconds.
        const [base, top, prot] = await Promise.all([
          this.ticketDiagnostics(),
          this.monitor.processes({ sort: 'cpu', limit: 8 }).catch(() => null),
          // Protection as it is now (a few seconds at most: the antivirus is asked again).
          Promise.race([this.protection.status().catch(() => null), sleep(5000).then(() => null)]),
        ]);
        return {
          ...base,
          busiestApps: top?.list.map((x) => ({ name: x.name, pid: x.pid, cpuPct: x.cpu, memoryMb: Math.round(x.memBytes / 1048576) })) ?? [],
          protection: prot ? { name: prot.active.name, state: prot.state, realtime: prot.realtime, threats: prot.threats } : this.protection.summary(),
          checkedAt: new Date().toISOString(),
        };
      },
      ask: async (prompt, actor) => {
        const r = await this.agent.runToCompletion({ message: prompt, origin: 'remote', actor });
        return { status: r.status, answer: r.answer, error: r.error };
      },
      run: async (command, actor, consent) => {
        const r = await this.gate.invoke('shell.run', { command }, { origin: consent === 'approved' ? 'user' : 'remote', actor });
        return { ok: r.ok, status: r.status, output: r.output, error: r.error };
      },
      notify: (title, body) => this.notify({ title, body, level: 'info', source: 'helpdesk', open: 'approvals' }),
      agentName: () => this.settings.get().ai.agentName,
    });
    this.localApi = new LocalApiServer({
      call: (m, p, ctx) => this.call(m, p, ctx),
      events: this.events,
      tokens: () => this.localApiTokens(),
      settings: this.settings,
      log: L('localapi'),
      appVersion: this.platform.appVersion,
    });
    this.services = new ServiceManager(L('services'), this.events, () => this.audit);

    // Command center
    this.workspace = new WorkspaceStore(this.db, this.events);
    this.monitor = new SystemMonitor(this.events, L('monitor'));
    this.files = new FileBrowser(() => this.platform.specialDirs());
    this.terminal = new TerminalSessions(this.events, () => this.platform.specialDirs().home);
    this.spotlight = new Spotlight({
      meta: this.meta,
      workspace: this.workspace,
      webSearch: () => this.settings.get().spotlight.webSearch,
      fileSearch: () => this.settings.get().spotlight.fileSearch,
      easterEggs: () => funEnabled(this.settings.get(), this.license.status().tier),
    });
    this.vendors = new VendorDb({
      builtinFile: this.platform.vendorDbFile ?? null,
      userFile: join(this.paths.root, 'oui-vendors.tsv.gz'),
      legacyFile: join(this.paths.root, 'oui-vendors.txt'),
      internet: () => this.internetAllowed(),
    });
    this.net = new NetDiag({ db: this.db, events: this.events, vendors: this.vendors, internet: () => this.internetAllowed() });
    this.netenv = new NetEnvironments({ meta: this.meta, vault: this.vault, events: this.events, log: L('netenv'), unavailable: () => this.ultraOnly('Network environments') });
    this.calendar = new CalendarService({
      db: this.db,
      vault: this.vault,
      events: this.events,
      log: L('calendar'),
      settings: () => this.settings.get().calendar,
      locked: () => this.settings.effective().locked,
      builtInClientId: this.platform.microsoftClientId ?? null,
      internet: () => this.internetAllowed(),
      notify: (title, body) => this.notify({ title, body, level: 'info', source: 'calendar' }),
    });
    this.shield = new Shield({
      db: this.db,
      meta: this.meta,
      dir: join(this.paths.root, 'shield', 'quarantine'),
      log: L('shield'),
      settings: () => this.settings.get().protection.shield,
      ultra: () => !this.ultraOnly('FBRX Shield extras'),
      internet: () => this.internetAllowed(),
      secret: (name) => {
        try {
          return this.vault.isUnlocked ? this.vault.get(name) : undefined;
        } catch {
          return undefined;
        }
      },
      // FBRX's own folders: its data, where it is installed and its update cache, and its whole-computer image files.
      skip: () => [this.paths.root, ...(this.platform.ownDirs?.() ?? []), ...(process.platform === 'win32' ? [join(process.env.ProgramData ?? 'C:\\ProgramData', 'FBRX')] : [])],
      landing: () => {
        const d = this.platform.specialDirs();
        // Never the home folder itself (some systems report it as Downloads).
        return [d.downloads, d.desktop].filter((x) => x && x !== d.home);
      },
      onDetection: (d) => this.protection.onDetection(d),
    });
    this.protection = new ProtectionService({
      shield: this.shield,
      meta: this.meta,
      events: this.events,
      log: L('protection'),
      settings: () => this.settings.get().protection,
      locked: () => this.settings.effective().locked,
      setProvider: (provider) => void this.settings.update({ protection: { provider } }),
      dirs: () => this.platform.specialDirs(),
      alert: (rule, title, body, key) => void this.alerts.fire(rule, title, body, { key }).catch((err) => this.log.debug('Alert failed', { rule, error: errorMessage(err) })),
      resolve: (ids) => ids.forEach((id) => this.alerts.resolve('shield_threat', id)),
      notify: (title, body) => this.notify({ title, body, level: 'info', source: 'alerts' }),
    });
    this.imageBackup = new ImageBackupService({
      platform: process.platform,
      dir: join(process.env.ProgramData ?? 'C:\\ProgramData', 'FBRX', 'Time'),
      ps: (script, timeoutMs) => runPs(script, timeoutMs),
      elevated: (script, o) => runElevated(script, { timeoutMs: o?.timeoutMs }),
      audit: (action, outcome, details) => this.audit.append({ category: 'system', action, actor: 'user', outcome, details }),
      log: L('time'),
    });
    this.trophies = new Trophies({ meta: this.meta, events: this.events, enabled: () => funEnabled(this.settings.get(), this.license.status().tier) });
    this.migrator = new Migrator({
      events: this.events,
      log: L('migrate'),
      audit: (action, outcome, details) => this.audit.append({ category: 'files', action, actor: 'user', outcome, details }),
    });
    this.codelab = new CodeLab(join(this.paths.root, 'codelab'));
    this.voice = new VoiceModels({ dir: join(this.paths.root, 'voice'), events: this.events, log: L('voice'), internet: () => this.internetAllowed() });
    this.release = new ReleaseChecker({
      appVersion: this.platform.appVersion,
      dataRoot: this.paths.root,
      settings: () => this.settings.get(),
      skip: (version) => this.settings.update({ updates: { skipVersion: version } }),
      events: this.events,
      log: L('release'),
      internet: () => this.internetAllowed(),
      notify: (title, body, version) => this.alerts.fire('update_available', title, body, { key: version }),
      quiet: () => !this.presenterStatus().active && this.agent.activeCount === 0 && this.idleSeconds() >= 300,
    });
    // FBRX/1 runs every command through the same API as the app, as the person at the computer (cli.exec is user-only).
    this.cli = new Fbrx1Cli({
      call: (method, params) => this.call(method, params ?? {}, { origin: 'user', actor: 'fbrx1' }),
      user: () => {
        try {
          return userInfo().username;
        } catch {
          return 'user';
        }
      },
      host: () => this.deviceName().replace(/\s+/g, '-'),
    });
    this.consoles = new DeviceConsoles({
      events: this.events,
      meta: this.meta,
      vault: this.vault,
      home: () => this.platform.specialDirs().home,
      audit: (action, outcome, details) => this.audit.append({ category: 'console', action, actor: 'user', outcome, details }),
    });
    this.mesh = new MeshService(this.db, this.events, L('mesh'), {
      appVersion: this.platform.appVersion,
      deviceName: () => this.deviceName(),
      settings: () => this.settings.get().mesh,
      keyPair: () => this.meshKeyPair(),
      mobileDir: this.platform.meshMobileDir ?? null,
      status: () => this.meshStatusSummary(),
      approvals: () => this.approvals.list(),
      resolveApproval: (id, decision, by) => this.approvals.resolve(id, decision, by),
      requestApproval: async (deviceName, prompt, deviceId) => {
        const r = await this.approvals.request(
          {
            runId: null,
            tool: 'mesh.ask',
            toolTitle: `Request from ${deviceName}`,
            risk: 'execute',
            input: { deviceId, prompt },
            reason: `${deviceName} asks ${this.settings.get().ai.agentName} to do something on this computer`,
            origin: 'remote',
            findings: [],
          },
          this.policy.policy.approvals.timeoutSeconds,
        );
        return r.decision === 'approve';
      },
      runAsk: async (prompt, deviceName, onTool) => {
        const off = this.events.on('agent', (e) => {
          if (e.type === 'tool.updated' && e.call.status === 'running') onTool(e.call.name);
        });
        try {
          const r = await this.agent.runToCompletion({ message: prompt, origin: 'remote', actor: `mesh:${deviceName}` });
          return { answer: r.answer, status: r.status, error: r.error };
        } finally {
          off();
        }
      },
      tasks: () => this.workspace.listTasks(),
      saveTask: (t) => this.workspace.saveTask(t),
      notes: () => this.workspace.listNotes(),
      saveNote: (n) => this.workspace.saveNote(n),
      alerts: () => this.alerts.inbox({ limit: 50 }),
      notify: (title, body) => this.notify({ title, body, level: 'info', source: 'mesh' }),
      system: (cmd) => this.spotlight.system(cmd),
      audit: (action, actor, outcome, details) => this.audit.append({ category: 'mesh', action, actor, outcome, details }),
      assist: (device, method, params) => this.assist.handle(device, method, params),
      // A gate's FBRX MiniDome saw something coming from this computer: an alert here (critical when it is serious).
      networkFinding: (device, f) =>
        void this.alerts
          .fire('network_threat', f.title, `${f.detail}${f.evidence.length ? `\n\n${f.evidence.slice(0, 3).join('\n')}` : ''}\n\nSeen by FBRX MiniDome on ${device.name}. A quick scan with your antivirus is a good next step.`, { key: `${f.kind}:${f.subject ?? ''}`, severity: f.severity === 'serious' || f.severity === 'critical' ? 'critical' : f.severity === 'info' ? 'info' : 'warning' })
          .catch(() => undefined),
      protection: () => this.protection.summary(),
      acceptMessages: () => this.settings.get().messages.enabled,
    });
    this.messages = new Messages({
      db: this.db,
      events: this.events,
      log: L('messages'),
      mesh: this.mesh,
      fleet: this.fleet,
      settings: () => this.settings.get().messages,
      meshOn: () => this.settings.get().mesh.enabled && this.mesh.running,
      myName: () => this.settings.get().profile.name || this.deviceName(),
      notify: (title, body, open) => this.notify({ title, body, level: 'info', source: 'messages', open }),
    });
    this.serverResources = new ServerResources(this.platform.resourcesDir, () => this.platform.specialDirs().downloads);
    this.orgMesh = new OrgMesh({
      enrolled: () => this.fleet.enrolled,
      roster: () => this.fleet.request<OrgMeshRoster>('GET', '/v1/device/mesh/roster'),
      syncPeers: (peers) => this.mesh.syncOrg(peers),
      meshEnabled: () => this.settings.get().mesh.enabled,
      enableMesh: () => {
        try {
          this.settings.update({ mesh: { enabled: true } });
          this.audit.append({ category: 'mesh', action: 'org.enabled', actor: 'fleet', outcome: 'success', details: {} });
          return true;
        } catch {
          return false;
        }
      },
      log: L('org-mesh'),
    });
    // Joining or leaving an organization, or reconnecting to it: look at its mesh again.
    this.events.on('fleet.changed', (f) => {
      if (f.state === 'online' || f.state === 'unenrolled') void this.orgMesh.sync();
    });
    this.servers = new SavedServers({
      meta: this.meta,
      audit: (action, details) => this.audit.append({ category: 'server', action, actor: 'user', outcome: 'success', details }),
      meshServers: () =>
        this.mesh
          .devices()
          .filter((d) => d.kind === 'desktop')
          .map((d) => ({ name: d.name, host: this.mesh.addressFor(d.id) ?? '', roles: this.mesh.rolesOf(d.id) }))
          .filter((d) => d.host && d.roles.length),
    });
    this.meshNetwork = new MeshNetwork({
      settings: () => this.settings.get().mesh.network,
      port: () => this.settings.get().mesh.port,
      peers: () => this.mesh.devices().filter((d) => d.kind === 'desktop').map((d) => ({ id: d.id, name: d.name, address: this.mesh.addressFor(d.id) })),
      hello: (id) => this.mesh.hello(id),
      elevated: () => runsElevated(),
    });
    this.assist = new MeshAssist({
      settings: () => this.settings.get().mesh.assist,
      meshRunning: () => this.mesh.running,
      agentName: () => this.settings.get().ai.agentName,
      devices: () => this.mesh.devices(),
      call: (peerId, method, params, timeoutMs) => this.mesh.call(peerId, method, params, timeoutMs),
      agentReady: () => this.assistReady(),
      load: () => {
        const live = this.monitor.current;
        return { cpu: live?.cpu ?? null, memUsedPct: live ? Math.round((live.memUsed / live.memTotal) * 100) : null };
      },
      runHelp: (p) =>
        this.agent.start({
          message: p.message,
          conversationId: p.conversationId ?? undefined,
          title: p.title,
          origin: 'remote',
          actor: `mesh-assist:${p.peerName}`,
          limits: { maxSteps: p.maxSteps, tools: p.tools, assist: false },
        }),
      onTool: (runId, cb) =>
        this.events.on('agent', (e) => {
          if (e.type === 'tool.updated' && e.runId === runId && e.call.status === 'running') cb(e.call.name);
        }),
      cancelRun: (runId) => void this.agent.cancel(runId),
      approve: async (p) => {
        const r = await this.approvals.request(
          { runId: null, tool: 'mesh.assist', toolTitle: p.title, risk: 'execute', input: p.input, reason: p.reason, origin: 'remote', findings: [] },
          this.policy.policy.approvals.timeoutSeconds,
          p.signal,
        );
        return r.decision === 'approve';
      },
      audit: (action, actor, outcome, details) => this.audit.append({ category: 'mesh', action, actor, outcome, details }),
      emit: (session) => this.events.emit('mesh.assist', session),
      log: L('mesh'),
    });
    this.alerts = new AlertEngine({
      db: this.db,
      events: this.events,
      log: L('alerts'),
      settings: () => this.settings.get(),
      monitor: this.monitor,
      workspace: this.workspace,
      notify: (title, body, level, ruleId) => this.notify({ title, body, level, source: ruleId === 'update_available' ? 'updates' : 'alerts', open: ruleId === 'update_available' ? 'settings/updates' : 'alerts' }),
      toMobile: (a) => this.mesh.pushAlert(a),
      toOrganisation: (a) => {
        if (!this.fleet.enrolled) return false;
        this.fleet.reportEvent({ kind: 'alert', severity: a.severity, message: `${a.title}: ${a.body}`.slice(0, 2000), data: { ruleId: a.ruleId }, at: a.createdAt });
        return true;
      },
      secret: (name) => (this.vault.isUnlocked ? this.vault.get(name) : undefined),
      meshPeers: () => (this.mesh.running ? this.mesh.peers() : []),
    });
    this.aicoord = new AiCoordination({
      shim: () => {
        const s = this.platform.mcpShim;
        return s ? { command: s.command, args: s.args, env: { ...(s.env ?? {}), FBRX_DATA_DIR: this.paths.root } } : null;
      },
      localApiRunning: () => this.localApi.running,
    });

    this.api = { ...buildCoreApi(this), ...buildExtApi(this) };
    this.registerServices();
    this.wire();
  }

  static async create(opts: KernelOptions): Promise<Kernel> {
    // Before anything starts a process: no console windows flashing up on Windows.
    installConsoleGuard();
    return new Kernel(opts);
  }

  deviceName(): string {
    return this.settings.get().general.deviceName || hostname();
  }

  private notify(n: NotificationEvent) {
    this.events.emit('notification', n);
  }

  // ------------------------------------------------------------------------------- presenter-safe mode

  private externalDisplay = false;
  /** Turned off by hand while the automatic switch had it on; cleared when the extra screen goes away. */
  private presenterSnoozed = false;
  private lastPresenter = '';

  presenterStatus(): PresenterStatus {
    const p = this.settings.get().presenter;
    const auto = p.auto && this.externalDisplay && !this.presenterSnoozed;
    const active = p.enabled || auto;
    return { active, reason: p.enabled ? 'manual' : auto ? 'display' : null, externalDisplay: this.externalDisplay, hideNotifications: p.hideNotifications, maskClipboard: p.maskClipboard, blurPrivate: p.blurPrivate };
  }

  /** Emits presenter.changed when what presenter-safe mode does has changed. */
  private presenterChanged() {
    const st = this.presenterStatus();
    const key = JSON.stringify(st);
    if (key === this.lastPresenter) return;
    this.lastPresenter = key;
    this.events.emit('presenter.changed', st);
  }

  /** The desktop shell reports whether a second screen or projector is connected. */
  setExternalDisplay(on: boolean): void {
    if (on === this.externalDisplay) return;
    this.externalDisplay = on;
    if (!on) this.presenterSnoozed = false;
    this.presenterChanged();
  }

  async setPresenting(on: boolean, actor: string): Promise<PresenterStatus> {
    const was = this.presenterStatus();
    if (on) {
      this.presenterSnoozed = false;
      if (!was.active) await this.settings.update({ presenter: { enabled: true } });
    } else {
      if (this.settings.get().presenter.enabled) await this.settings.update({ presenter: { enabled: false } });
      if (was.reason === 'display' || (this.settings.get().presenter.auto && this.externalDisplay)) this.presenterSnoozed = true;
    }
    this.audit.append({ category: 'settings', action: on ? 'presenter.on' : 'presenter.off', actor, outcome: 'success' });
    this.presenterChanged();
    return this.presenterStatus();
  }

  private wire() {
    this.disposers.push(
      this.events.on('notification', (n) => {
        try {
          // Notifications switched off, all of them or this kind (Alerts → Notifications).
          if (!shouldNotify(this.settings.get().notifications, n.source)) return;
          // Endpoint Essentials (the AI on its own): nothing about pages it does not have.
          const e = this.edition();
          if (e.tier === 'essentials' && !e.learner && !essentialsNotifies(n.source)) return;
          // Presenting: nothing private pops up on the projector. Urgent ones still say that something needs a look.
          const p = this.presenterStatus();
          if (p.active && p.hideNotifications) {
            if (n.level === 'error') this.platform.notify({ ...n, title: 'FBRX needs your attention', body: 'Open FBRX when you have finished presenting.' });
            return;
          }
          this.platform.notify(n);
        } catch {
          /* headless */
        }
      }),
      this.events.on('settings.changed', () => this.presenterChanged()),
      this.events.on('settings.changed', () => this.calendar.schedule()),
      this.events.on('settings.changed', () => this.protection.applyWatch()),
    );
    this.disposers.push(this.vault.onChange(() => this.redactor.setSecrets(this.vault.valuesForRedaction())));
    // Licensed features (plugins, connectors, …) start or stop as soon as a license is activated, pushed or revoked.
    this.disposers.push(
      this.events.on('license.changed', () => {
        if (this.started) void this.services.reconcile();
      }),
    );
    this.disposers.push(
      this.registry.onChange(() => {
        this.events.emit('tools.changed', this.registry.list().map((t) => this.gate.describe(t)));
      }),
    );
    this.disposers.push(
      this.settings.onChange((next, prev) => {
        if (!prev || !this.started) return;
        const rt = JSON.stringify(next.settings.runtime) !== JSON.stringify(prev.runtime);
        if (rt && this.runtime.isRunning) void this.services.restart('runtime');
        if (JSON.stringify(next.settings.localApi) !== JSON.stringify(prev.localApi)) void this.services.restart('localapi');
      }),
    );
    this.platform.updates?.onStatus((s) => this.events.emit('updates.changed', s));
    this.disposers.push(
      this.settings.onChange((next, prev) => {
        if (!prev || !this.started) return;
        const m = next.settings.mesh;
        if (m.enabled !== prev.mesh.enabled) void this.services.reconcile();
        else if (m.enabled && m.port !== prev.mesh.port) void this.services.restart('mesh');
      }),
    );
    this.disposers.push(
      this.events.on('approval.requested', (a) => {
        if (a.tool !== 'mesh.ask') void this.alerts.fire('approval_waiting', `${a.toolTitle} is waiting for approval`, a.reason.slice(0, 300), { key: a.id });
      }),
    );
    installModelReviewer(this);
  }

  private registerServices() {
    const s = this.services;
    s.register({
      name: 'storage',
      title: 'Storage',
      description: 'SQLite database (WAL) holding local state; secrets inside it are vault-encrypted',
      critical: true,
      start: () => undefined,
      stop: () => undefined,
      health: async () => {
        this.db.get('SELECT 1');
        return { state: 'running' };
      },
    });
    s.register({
      name: 'audit',
      title: 'Audit log',
      description: 'Tamper-evident, hash-chained record of every action',
      critical: true,
      dependsOn: ['storage'],
      start: () => {
        this.audit.append({ category: 'system', action: 'started', actor: 'system', outcome: 'info', details: { version: this.platform.appVersion, shell: this.platform.shell } });
        if (this.restoredThisBoot) {
          this.restoredThisBoot = false;
          this.audit.append({ category: 'backup', action: 'restored', actor: 'system', outcome: 'success', details: { ...(this.meta.get<object>('restore.last') ?? {}), hostname: hostname() } });
        }
      },
      stop: () => {
        this.audit.append({ category: 'system', action: 'stopped', actor: 'system', outcome: 'info' });
      },
    });
    s.register({
      name: 'vault',
      title: 'Credential vault',
      description: 'AES-256-GCM envelope-encrypted secrets bound to the OS keychain',
      critical: true,
      dependsOn: ['storage', 'audit'],
      start: async () => {
        await this.vault.open();
        this.redactor.setSecrets(this.vault.valuesForRedaction());
      },
      stop: () => undefined,
      health: async () => {
        if (this.vault.isUnlocked) return { state: 'running' };
        const v = this.vault.status();
        // Locked on purpose until the person enters the vault password: not a problem worth an alert.
        if (v.lockReason === 'password' || v.lockReason === 'manual') return { state: 'running', message: 'Locked until you enter the vault password' };
        return { state: 'degraded', message: v.lockReason === 'moved' ? `Saved credentials are still in ${v.movedFrom}: open the Vault page to bring them over` : 'Locked: enter the recovery passphrase on the Vault page' };
      },
    });
    s.register({
      name: 'governance',
      title: 'Governance',
      description: 'Policy engine, guardian reviewer, approvals and rate limits for every tool call',
      critical: true,
      dependsOn: ['storage', 'audit'],
      start: () => {
        this.policy.effective();
      },
      stop: () => this.approvals.denyAll('shutdown'),
      health: async () => ({ state: 'running', message: `${this.policy.effective().source} policy, ${this.policy.policy.mode} mode` }),
    });
    s.register({
      name: 'tools',
      title: 'Tool registry',
      description: 'Built-in, plugin and connector tools available to the agent',
      dependsOn: ['governance'],
      start: () => {
        const ws = this.paths.workspace;
        this.registry.registerMany([
          ...fsTools({ workspace: ws, maxFileBytes: () => this.policy.policy.filesystem.maxFileBytes }),
          ...shellTools({ workspace: ws, timeoutSeconds: () => this.policy.policy.shell.timeoutSeconds }),
          ...netTools({ checkUrl: (u) => checkUrl(u, this.policy.policy.network) }),
          ...systemTools({ workspace: ws, notify: (title, body) => this.notify({ title, body, level: 'info', source: 'agent' }) }),
          ...memoryTools(this.memory),
          ...folderTools(this.folders),
          ...knowledgeTools({ kb: this.knowledge, doctor: () => this.doctor(), fix: (id) => this.applyFix(id) }),
          ...fbrxTools({ status: () => this.status(), recentAudit: (n) => this.audit.query({ limit: n }) }),
          ...workspaceTools(this.workspace),
          ...deviceConsoleTools(this.consoles),
          ...netEnvTools(this.netenv, () => this.ultraOnly('Network environments')),
          ...calendarTools(this.calendar),
          ...shieldTools(this.protection, this.shield),
          ...meshTools(this.assist, () => {
            const a = this.settings.get().mesh.assist;
            if (!this.mesh.running) return 'The mesh is off';
            return a.agentMayConsult && a.request !== 'off' ? null : 'Mesh Assist does not let the agent consult other computers';
          }),
          ...helpdeskTools(this.helpdesk, () => (this.fleet.enrolled ? null : 'This computer is not part of an organization, so there is no help desk to send to')),
          ...pcTools({ monitor: this.monitor, net: this.net, alerts: this.alerts, virustotalKey: () => (this.vault.isUnlocked ? this.vault.get('VIRUSTOTAL_API_KEY') : undefined) }),
        ]);
      },
      stop: () => undefined,
    });
    s.register({
      name: 'plugins',
      title: 'Plugin host',
      description: 'Sandboxed worker processes running third-party plugins',
      dependsOn: ['tools', 'vault'],
      enabled: () => this.license.has('plugins'),
      start: () => this.plugins.startAll(),
      stop: () => this.plugins.stopAll(),
      health: async () => {
        const failed = this.plugins.list().filter((p) => p.enabled && p.state === 'failed');
        return failed.length ? { state: 'degraded', message: `${failed.length} plugin(s) failed: ${failed.map((p) => p.name).join(', ')}` } : { state: 'running' };
      },
    });
    s.register({
      name: 'connectors',
      title: 'Connector hub',
      description: 'Connections to other applications (REST, MCP, webhooks, FBRX peers)',
      dependsOn: ['tools', 'vault'],
      start: () => this.connectors.startAll(),
      stop: () => this.connectors.stopAll(),
      health: async () => {
        const bad = this.connectors.list().filter((c) => c.enabled && c.state === 'error');
        return bad.length ? { state: 'degraded', message: `${bad.length} connection(s) failing` } : { state: 'running' };
      },
    });
    s.register({
      name: 'runtime',
      title: 'Local AI runtime',
      description: 'Built-in llama.cpp model server (127.0.0.1 only)',
      dependsOn: ['storage'],
      enabled: () => this.settings.get().runtime.enabled,
      start: async () => {
        const st = this.runtime.status();
        if (this.runtimeWanted() && st.state === 'stopped') {
          // Model loading can take minutes; don't block boot on it.
          void this.runtime.start().catch((err) => this.log.warn('Local runtime did not start', { error: errorMessage(err) }));
        }
      },
      stop: () => this.runtime.stop().then(() => undefined),
      health: async () => {
        const st = this.runtime.status();
        if (st.state === 'failed') return { state: 'failed', message: st.message };
        if (st.state === 'running') {
          const h = await this.runtime.health();
          return h.ok ? { state: 'running', message: st.modelId } : { state: 'failed', message: h.message };
        }
        return { state: 'degraded', message: st.message ?? st.state };
      },
    });
    s.register({
      name: 'agent',
      title: 'AI agent',
      description: 'Governed agent loop with streaming, tool use and conversation memory',
      dependsOn: ['tools', 'governance'],
      start: () => undefined,
      stop: () => void this.agent.cancelAll(),
    });
    s.register({
      name: 'backup',
      title: 'Backup',
      description: 'Encrypted snapshots, scheduled backups and restore',
      dependsOn: ['storage', 'vault'],
      start: () => this.backup.start(),
      stop: () => this.backup.stop(),
    });
    s.register({
      name: 'fleet',
      title: 'Fleet agent',
      description: 'Real-time link to the FBRX control plane',
      dependsOn: ['vault', 'governance'],
      start: () => this.fleet.start(),
      stop: () => this.fleet.stop(),
      health: async () => {
        const f = this.fleet.status();
        if (f.state === 'unenrolled') return { state: 'running', message: 'Not enrolled' };
        if (f.state === 'online') return { state: 'running', message: f.tenantName };
        return { state: 'degraded', message: f.message ?? f.state };
      },
    });
    s.register({
      name: 'monitor',
      title: 'System monitor & alerts',
      description: 'Live performance metrics and background alert rules',
      dependsOn: ['storage'],
      start: () => {
        this.monitor.start();
        this.alerts.start();
      },
      stop: () => {
        this.alerts.stop();
        this.monitor.stop();
      },
    });
    s.register({
      name: 'protection',
      title: 'Antivirus',
      description: 'FBRX Shield download checks, threat database updates, scheduled scans and the antivirus status',
      dependsOn: ['storage'],
      start: () => this.protection.start(),
      stop: () => this.protection.stop(),
    });
    s.register({
      name: 'calendar',
      title: 'Calendar',
      description: 'Outlook / Microsoft 365 and calendar links: syncing and meeting reminders',
      dependsOn: ['storage'],
      // An account that cannot be updated says so on the Calendar page; it is not a problem with this computer.
      start: () => this.calendar.start(),
      stop: () => this.calendar.stop(),
    });
    s.register({
      name: 'mesh',
      title: 'Mesh',
      description: 'Encrypted link to your other FBRX computers and your phone',
      dependsOn: ['vault', 'tools'],
      enabled: () => this.settings.get().mesh.enabled,
      start: async () => {
        if (!this.vault.isUnlocked) throw new CoreError('LOCKED', 'Vault is locked');
        await this.mesh.start();
      },
      stop: () => this.mesh.stop(),
      health: async () => (this.mesh.running ? { state: 'running', message: `${this.mesh.devices().length} paired device(s)` } : { state: 'failed', message: 'Not listening' }),
    });
    s.register({
      name: 'localapi',
      title: 'Local API',
      description: 'Authenticated automation API for scripts, apps and FBRX peers',
      dependsOn: ['vault'],
      enabled: () => this.settings.get().localApi.enabled && this.license.has('localapi'),
      start: async () => {
        if (!this.vault.isUnlocked) throw new CoreError('LOCKED', 'Vault is locked');
        this.ensureLocalApiTokens();
        await this.localApi.start();
        this.writeAgentTokenFile();
      },
      stop: async () => {
        rmSync(join(this.paths.root, AGENT_TOKEN_FILE), { force: true });
        await this.localApi.stop();
      },
      health: async () => (this.localApi.running ? { state: 'running' } : { state: 'failed', message: 'Not listening' }),
    });
  }

  /** "Install FBRX OS --no-ai" (its own test runs, for one) leaves the AI to whoever opens the app. */
  private starterAiWanted(): boolean {
    try {
      return (JSON.parse(readFileSync(join(this.paths.root, INSTALL_SOURCE_FILE), 'utf8')) as { starterAi?: boolean }).starterAi !== false;
    } catch {
      return true;
    }
  }

  async start(): Promise<void> {
    await this.services.startAll();
    this.services.startWatchdog();
    this.started = true;
    this.log.info(`${PRODUCT_NAME} ${this.platform.appVersion} started`, { dataDir: this.paths.root, shell: this.platform.shell });
    this.applyLicenseFile();
    // Look for new versions in the FBRX repository (the desktop app only; servers and tests don't).
    if (this.platform.shell === 'desktop') this.release.start();
    // A new computer's AI, ready before the first question (the starter model, picked up or downloaded once).
    if (this.platform.shell === 'desktop' && this.starterAiWanted()) void this.starter.prepare({ auto: true });
    this.messages.start();
    this.orgMesh.start();
    // A provisioning file (IT deployment) goes first; a license that names an FBRX Command tenant joins after it.
    void this.applyProvisioning()
      .catch((err) => this.log.error('Provisioning failed', { error: errorMessage(err) }))
      .then(() => this.joinLicenseTenant('license'));
    this.audit.prune(365);
  }

  /** FBRX's check-up of itself (fbrx.doctor). */
  doctor(): Promise<DoctorFinding[]> {
    const s = this.settings.get();
    const rt = this.runtime.status();
    const p = this.presenterStatus();
    const rel = this.release.status();
    const size = (f: string) => {
      try {
        return statSync(f).size;
      } catch {
        return 0;
      }
    };
    return runDoctor({
      services: () => this.services.list(),
      logs: () => this.logSink.tail(400, 'warn'),
      runtime: () => rt,
      modelBytes: () => (rt.modelId ? (this.models.get(rt.modelId)?.sizeBytes ?? null) : s.runtime.modelId ? (this.models.get(s.runtime.modelId)?.sizeBytes ?? null) : null),
      settings: () => s,
      scanRunning: () => this.protection.job()?.state === 'running',
      shieldWaiting: () => this.shield.status(null).open,
      databaseBytes: () => size(this.paths.db) + size(`${this.paths.db}-wal`),
      diskFreeGb: () => diskFreeGb(this.paths.root),
      halted: () => !!this.aiHalt(),
      vaultLocked: () => !this.vault.isUnlocked,
      presenting: () => p.active,
      updateAvailable: () => (rel.state === 'available' && rel.latest ? rel.latest.version : null),
      appVersion: this.platform.appVersion,
    });
  }

  /** Applies a fix fbrx.doctor offers (fbrx.fix, after the person agrees). Returns what happened. */
  async applyFix(id: string): Promise<string> {
    const svc = /^restart-service:([a-z0-9-]{1,40})$/.exec(id);
    if (svc) {
      if (!this.services.get(svc[1])) throw new CoreError('NOT_FOUND', `There is no service called ${svc[1]}`);
      const st = await this.services.restart(svc[1]);
      return `Restarted ${st.title}: it is ${st.state}${st.message ? ` (${st.message})` : ''}.`;
    }
    switch (id) {
      case 'cancel-scan':
        if (this.protection.job()?.state !== 'running') return 'No scan is running.';
        this.protection.cancel();
        return 'Stopped the scan. What it found so far is still in FBRX Shield.';
      case 'recheck-shield': {
        const r = await this.protection.recheck();
        return `Cleared ${r.cleared} finding${r.cleared === 1 ? '' : 's'} FBRX Shield no longer flags, and ${r.gone} whose file is gone.`;
      }
      case 'unload-model':
        await this.runtime.stop();
        return 'Unloaded the local AI model; its memory is free. It loads again the next time the AI is asked something.';
      case 'lower-context': {
        const ai = this.settings.get().ai;
        await this.settings.update({ runtime: { contextSize: 8192 }, ...(ai.ollamaContext > 8192 ? { ai: { ollamaContext: 8192 } } : {}) });
        return 'Set the local model’s context window to 8,192 tokens. It takes effect the next time the model loads.';
      }
      case 'compact-database': {
        const before = statSync(this.paths.db).size;
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
        const after = statSync(this.paths.db).size;
        return `Tidied FBRX’s database: ${(before / 1024 ** 2).toFixed(0)} MB → ${(after / 1024 ** 2).toFixed(0)} MB.`;
      }
      default:
        throw new CoreError('INVALID_ARGUMENT', `FBRX has no fix called ${id}`);
    }
  }

  async stop(): Promise<void> {
    this.knowledge.close();
    if (!this.started) {
      this.db.close();
      this.logSink.flush();
      return;
    }
    this.started = false;
    this.release.stop();
    this.messages.stop();
    this.orgMesh.stop();
    this.terminal.killAll();
    this.consoles.closeAll();
    this.migrator.cancelAll();
    this.spotlight.dispose();
    await this.services.stopAll();
    for (const d of this.disposers) d();
    this.disposers = [];
    this.events.removeAll();
    this.log.info('Stopped cleanly');
    this.db.close();
    this.logSink.flush();
  }

  async onVaultUnlocked(): Promise<void> {
    this.redactor.setSecrets(this.vault.valuesForRedaction());
    for (const name of ['localapi', 'plugins', 'connectors', 'mesh']) {
      const st = this.services.get(name);
      if (st && st.state !== 'disabled') await this.services.restart(name);
    }
    if (this.fleet.enrolled) {
      await this.fleet.stop();
      this.fleet.start();
    }
    // A license that names an FBRX Command tenant waits for the vault before it can join.
    void this.joinLicenseTenant('license');
  }

  /**
   * A license key that names an FBRX Command tenant joins this computer to it: once per license, and never while it
   * already belongs to a tenant. Leaving the tenant afterwards is respected (it does not join again by itself).
   */
  joinLicenseTenant(actor: string): Promise<{ joined: boolean; message: string | null }> {
    // One attempt at a time: start-up, a vault unlock and an activation can all ask at once.
    this.joining ??= this.joinLicenseTenantOnce(actor).finally(() => (this.joining = null));
    return this.joining;
  }

  private joining: Promise<{ joined: boolean; message: string | null }> | null = null;

  private async joinLicenseTenantOnce(actor: string): Promise<{ joined: boolean; message: string | null }> {
    const st = this.license.status();
    const key = this.meta.get<string>('license.local');
    const claims = st.state === 'valid' && st.source === 'local' && key ? decodeLicenseUnverified(key) : null;
    const command = claims?.command;
    if (!claims || !command) return { joined: false, message: null };
    if (this.fleet.enrolled) return { joined: false, message: null };
    if (this.meta.get<string>('license.joinedTenantFor') === claims.lid) return { joined: false, message: null };
    if (!this.vault.isUnlocked) return { joined: false, message: 'This computer joins your organization (FBRX Command) as soon as the vault is unlocked.' };
    try {
      const f = await this.fleet.enroll(command.url, command.enrollmentToken, undefined, actor, undefined, command.fingerprint);
      this.meta.set('license.joinedTenantFor', claims.lid);
      this.audit.append({ category: 'license', action: 'tenant.joined', actor, target: command.url, outcome: 'success', details: { licenseId: claims.lid, tenant: f.tenantName } });
      return { joined: true, message: `Joined ${f.tenantName ?? 'your organization'} on FBRX Command.` };
    } catch (err) {
      this.log.warn('Could not join the FBRX Command tenant from the license', { error: errorMessage(err) });
      return { joined: false, message: `The license is active, but joining FBRX Command failed: ${errorMessage(err)}. It tries again at the next start.` };
    }
  }

  // ----------------------------------------------------------------------------------- core API

  /** Dispatches a core API call with origin checks and auditing. */
  async call(method: string, params: unknown, ctx: CallContext): Promise<unknown> {
    const handler = this.api[method];
    if (!handler) throw new CoreError('NOT_FOUND', `Unknown method ${method}`);
    if (ctx.origin !== 'user' && isUserOnly(method)) {
      throw new CoreError('FORBIDDEN', `${method} can only be performed by a person at this workstation`);
    }
    const audited = !isReadOnly(method) && method !== 'ai.chat' && method !== 'ai.quick' && method !== 'agent.runToCompletion' && method !== 'tools.invoke';
    try {
      const result = await handler(params ?? {}, ctx);
      if (audited) this.audit.append({ category: 'api', action: method, actor: ctx.actor, outcome: 'success', details: { origin: ctx.origin, params: scrubParams(params) } });
      return result;
    } catch (err) {
      const e = toCoreError(err);
      if (audited) this.audit.append({ category: 'api', action: method, actor: ctx.actor, outcome: e.code === 'FORBIDDEN' || e.code === 'POLICY_DENIED' || e.code === 'MANAGED' ? 'denied' : 'failure', details: { origin: ctx.origin, error: e.message } });
      throw e;
    }
  }

  updateStatus(): UpdateStatus {
    return (
      this.platform.updates?.status() ?? {
        state: 'unsupported',
        currentVersion: this.platform.appVersion,
        availableVersion: null,
        progressPct: null,
        channel: this.settings.get().updates.channel,
        feedUrl: null,
        message: this.platform.shell === 'headless' ? 'Headless installs are updated by redeploying the package' : 'Updates are not available in development builds',
      }
    );
  }

  // ------------------------------------------------------------------------------------ emergency stop

  /** The emergency stop in force, if any. It survives restarts until someone resumes the AI. */
  aiHalt(): { at: string; by: string } | null {
    return this.meta.get<{ at: string; by: string }>('ai.halt');
  }

  /**
   * Emergency stop: cancels every agent run, denies every pending approval, stops the local model, and refuses new
   * agent runs and tool calls from other AI apps (MCP / Local API) until resumed. The person at the workstation keeps
   * every non-AI feature.
   */
  async hardStop(by: string): Promise<{ cancelledRuns: number; deniedApprovals: number }> {
    const at = new Date().toISOString();
    this.meta.set('ai.halt', { at, by });
    const cancelledRuns = this.agent.cancelAll('Emergency stop');
    const deniedApprovals = this.approvals.size;
    this.approvals.denyAll('emergency-stop');
    await this.runtime.stop().catch((err) => this.log.warn('Could not stop the local runtime', { error: errorMessage(err) }));
    this.audit.append({ category: 'agent', action: 'emergency-stop', actor: by, outcome: 'info', details: { cancelledRuns, deniedApprovals } });
    this.log.warn('AI emergency stop', { by, cancelledRuns, deniedApprovals });
    this.events.emit('ai.halted', { halted: true, at, by });
    return { cancelledRuns, deniedApprovals };
  }

  async resumeAi(by: string): Promise<void> {
    if (!this.aiHalt()) return;
    this.meta.delete('ai.halt');
    this.audit.append({ category: 'agent', action: 'emergency-stop.resumed', actor: by, outcome: 'info' });
    this.events.emit('ai.halted', { halted: false, at: null, by });
    if (this.runtimeWanted()) void this.runtime.start().catch((err) => this.log.warn('Local runtime did not start', { error: errorMessage(err) }));
  }

  /**
   * Whether to load the local model ahead of time: only when it is set to start automatically and the agent uses it.
   * Otherwise it would sit in memory next to Ollama or a cloud model; it still loads on demand when a chat picks it.
   */
  private runtimeWanted(): boolean {
    const s = this.settings.get();
    if (!s.runtime.enabled || !s.runtime.autoStart) return false;
    return s.ai.providers.find((p) => p.id === s.ai.defaultProvider)?.type === 'local-runtime';
  }

  async status(): Promise<SystemStatus> {
    const since = new Date(Date.now() - 86400_000).toISOString();
    const stats = this.audit.stats();
    return {
      product: PRODUCT_NAME,
      version: this.platform.appVersion,
      platform: osPlatform(),
      arch: osArch(),
      hostname: hostname(),
      deviceName: this.deviceName(),
      dataDir: this.paths.root,
      startedAt: this.startedAt.toISOString(),
      uptimeSeconds: Math.round((Date.now() - this.startedAt.getTime()) / 1000),
      devMode: this.platform.devMode,
      shell: this.platform.shell,
      services: this.services.list(),
      vault: this.vault.status(),
      license: this.license.status(),
      edition: this.edition(),
      fleet: this.fleet.status(),
      runtime: this.runtime.status(),
      pendingApprovals: this.approvals.size,
      activeRuns: this.agent.activeCount,
      aiHalt: this.aiHalt(),
      stats: {
        agentRuns24h: this.audit.count('agent', 'run.completed', since),
        toolCalls24h: this.audit.count('tool', null, since),
        policyDenials24h: stats.denied24h,
        errors24h: stats.failures24h,
        lastBackupAt: this.backup.lastBackupAt(),
      },
    };
  }

  private async heartbeatStatus(): Promise<Heartbeat['status']> {
    const since = new Date(Date.now() - 86400_000).toISOString();
    const stats = this.audit.stats();
    const lic = this.license.status();
    return {
      uptimeSeconds: Math.round(osUptime()),
      cpuLoad: Math.round((loadavg()[0] / Math.max(1, cpus().length)) * 1000) / 10,
      memUsedPct: Math.round(((totalmem() - freemem()) / totalmem()) * 1000) / 10,
      memTotalMb: Math.round(totalmem() / 1024 / 1024),
      diskFreeGb: await diskFreeGb(this.paths.root),
      services: this.services.list().map((x) => ({ name: x.name, state: x.state, message: x.message })),
      vaultState: this.vault.status().state,
      licenseEdition: lic.edition,
      licenseState: lic.state,
      activeAgentRuns: this.agent.activeCount,
      pendingApprovals: this.approvals.size,
      agentRuns24h: this.audit.count('agent', 'run.completed', since),
      toolCalls24h: this.audit.count('tool', null, since),
      policyDenials24h: stats.denied24h,
      errors24h: stats.failures24h,
      lastBackupAt: this.backup.lastBackupAt(),
      plugins: this.plugins.list().map((p) => ({ id: p.id, version: p.version, enabled: p.enabled })),
      runtimeModel: this.runtime.status().modelId,
      auditHead: this.audit.headInfo(),
      protection: this.protection.summary(),
      imageBackup: this.imageBackup.summary(),
      mesh: this.meshIdentityForCommand(),
      editionTier: lic.tier,
    };
  }

  /** This computer's mesh identity for FBRX Command; none while its key is out of reach (a locked vault). */
  private meshIdentityForCommand(): { enabled: boolean; running: boolean; publicKey: string; fingerprint: string; port: number; addresses: string[]; roles: string[] } | null {
    try {
      return { enabled: this.settings.get().mesh.enabled, running: this.mesh.running, ...this.mesh.identity() };
    } catch {
      return null;
    }
  }

  /** Executes a command sent by an administrator from the control plane. */
  private async executeRemoteCommand(cmd: DeviceCommand): Promise<unknown> {
    const p = cmd.payload as any;
    switch (cmd.type) {
      case 'ping':
        return { pong: true, at: new Date().toISOString(), version: this.platform.appVersion };
      case 'config.sync':
        await this.fleet.sync();
        return { configVersion: this.fleet.status().configVersion };
      case 'update.check':
        return this.platform.updates ? this.platform.updates.check() : this.updateStatus();
      case 'update.install':
        return this.installUpdate({ restartNow: !!p.restartNow, source: p.source ?? 'auto' });
      case 'backup.create': {
        // One that goes to FBRX Command leaves out the AI's memory of the person (it never leaves the computer).
        const info = await this.backup.create({ label: p.label, actor: 'control-plane', withoutMemory: !!p.upload });
        let uploaded: string | null = null;
        if (p.upload) uploaded = (await this.fleet.uploadSnapshot(info.file, p.label ?? null)).snapshotId;
        return { file: info.name, sizeBytes: info.sizeBytes, snapshotId: info.header?.snapshotId, uploadedSnapshotId: uploaded };
      }
      case 'backup.image':
        return this.imageBackup.run('control-plane');
      case 'plugin.install': {
        this.license.require('plugins');
        const file = await this.fleet.download(p.url, p.sha256, `${p.packageId}.tgz`);
        try {
          const info = await this.plugins.install(file, 'control-plane');
          return { id: info.id, version: info.version, state: info.state };
        } finally {
          rmSync(file, { force: true });
        }
      }
      case 'plugin.setEnabled': {
        const info = await this.plugins.setEnabled(p.id, p.enabled, 'control-plane');
        return { id: info.id, enabled: info.enabled, state: info.state };
      }
      case 'plugin.uninstall':
        return { uninstalled: await this.plugins.uninstall(p.id, 'control-plane') };
      case 'service.restart':
        return this.services.restart(p.name);
      case 'diagnostics.collect':
        return {
          status: await this.status(),
          auditVerify: this.audit.verify(),
          audit: this.audit.query({ limit: p.auditEntries }),
          logs: this.logSink.tail(300),
          runtimeLogs: this.runtime.recentLogs().slice(-50),
        };
      case 'notify':
        this.notify({ title: p.title, body: p.body, level: 'info', source: 'administrator' });
        return { shown: true };
      case 'agent.run': {
        const r = await this.agent.runToCompletion({ message: p.prompt, providerId: p.providerId, model: p.model, origin: 'remote', actor: 'control-plane' });
        return { status: r.status, answer: r.answer, conversationId: r.conversationId, steps: r.steps, usage: r.usage, error: r.error };
      }
      case 'vault.lock':
        this.vault.lock();
        return this.vault.status();
      case 'app.restart':
        setTimeout(() => this.platform.requestRestart('remote'), 500);
        return { restarting: true };
      case 'helpdesk.assist':
        return this.helpdeskAssist.handle(p);
    }
  }

  // ---------------------------------------------------------------------------------- local API

  private ensureLocalApiTokens() {
    if (!this.vault.has(LOCAL_API_TOKEN)) this.rotateLocalApiTokens(false);
  }

  rotateLocalApiTokens(audit = true) {
    this.vault.set({ name: LOCAL_API_TOKEN, value: `fbrx_lapi_${randomBytes(32).toString('base64url')}`, kind: 'token' }, { internal: true });
    this.vault.set({ name: LOCAL_API_AGENT_TOKEN, value: `fbrx_lapi_${randomBytes(32).toString('base64url')}`, kind: 'token' }, { internal: true });
    if (audit) this.audit.append({ category: 'localapi', action: 'tokens.rotated', actor: 'user', outcome: 'success' });
    if (this.localApi.running) this.writeAgentTokenFile();
  }

  /** The MCP bridge reads the Local API address and the agent-scoped token from the data folder. */
  private writeAgentTokenFile() {
    const t = this.localApiTokens();
    if (!t) return;
    const file = join(this.paths.root, AGENT_TOKEN_FILE);
    writeFileSync(file, JSON.stringify({ url: `http://127.0.0.1:${this.settings.get().localApi.port}`, token: t.agent }), { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      /* windows: the data folder is already per-user */
    }
  }

  // ------------------------------------------------------------------------------- command center

  /** What this computer is: Endpoint Essentials, Standard or Ultra, or FBRX OS Education on a student computer. */
  /** Makes an installed model the one the agent uses, with the built-in runtime as the default AI, and starts it. */
  async useLocalModel(modelId: string): Promise<RuntimeStatus> {
    if (!this.models.get(modelId)) throw new CoreError('NOT_FOUND', 'Model is not installed');
    const ai = this.settings.get().ai;
    const local = ai.providers.find((x) => x.type === 'local-runtime');
    if (!local) throw new CoreError('UNAVAILABLE', 'This computer has no built-in runtime provider');
    this.settings.update({ runtime: { enabled: true, modelId }, ai: { providers: ai.providers.map((x) => (x.id === local.id ? { ...x, enabled: true } : x)), defaultProvider: local.id, defaultModel: '' } });
    if (this.runtime.isRunning) await this.runtime.stop();
    // Starts now when the runtime is there (otherwise at the first question, once it is installed).
    if (this.runtime.status().state === 'stopped') await this.runtime.start().catch(() => undefined);
    return this.runtime.status();
  }

  edition(): EditionStatus {
    const lic = this.license.status();
    const ed = this.meta.get<DeviceEdition>('fleet.edition');
    const vertical: Vertical = ed?.vertical ?? lic.vertical ?? 'business';
    const audience: Audience = ed?.audience ?? VERTICAL_AUDIENCES[vertical][0];
    return {
      tier: lic.tier,
      chosen: lic.chosen ?? lic.tier,
      ceiling: lic.ceiling ?? lic.tier,
      ceilingReason: lic.ceilingReason ?? 'standalone',
      enrolled: this.fleet.enrolled,
      tourDone: !!this.meta.get<boolean>('edition.tourDone'),
      vertical,
      audience,
      learner: isLearner(audience),
      productName: productNameFor(lic.tier, vertical, audience),
    };
  }

  /** The person's choice in Settings → Edition (Essentials or Standard any time; Ultra when FBRX Command allows it). */
  chooseEdition(tier: Tier, actor: string): EditionStatus {
    const before = this.license.status().tier;
    this.license.choose(tier);
    this.audit.append({ category: 'user', action: 'edition.chosen', actor, target: tier, outcome: 'success', details: { from: before } });
    return this.edition();
  }

  /** The Essentials walkthrough was finished or skipped (or is to be shown again). */
  setTourDone(done: boolean): EditionStatus {
    this.meta.set('edition.tourDone', done);
    this.events.emit('license.changed', this.license.status());
    return this.edition();
  }

  /**
   * A message on a student's or child's computer sounded like they may be in danger. The school (or family) is told
   * which computer, when and what kind of concern, so a caring adult can check in; the message stays on the computer.
   */
  private reportConcern(category: 'self-harm' | 'harmed') {
    const what = category === 'self-harm' ? 'may be thinking about hurting themselves' : 'may be being hurt by someone';
    const who = this.edition().vertical === 'home' ? 'child' : 'student';
    this.audit.append({ category: 'agent', action: 'learner.concern', actor: 'learning-helper', outcome: 'info', details: { category } });
    if (this.fleet.enrolled) {
      this.fleet.reportEvent({ kind: 'alert', severity: 'critical', message: `${who === 'child' ? 'Child' : 'Student'} safety: the ${who} using ${this.deviceName()} ${what}. Please have a caring adult check in.`, data: { concern: category, device: this.deviceName() }, at: new Date().toISOString() });
    }
  }

  /** What IT sees about this computer on a help desk ticket (only when the person leaves "attach details" on). */
  private async ticketDiagnostics(): Promise<Record<string, unknown>> {
    const s = await this.status();
    const hb = await this.heartbeatStatus();
    // The network lookup can take a while on Windows; a ticket never waits more than a few seconds for it.
    let net: { ip: string | null; gateway: string | null; dns: string[] } | null = null;
    let timer: NodeJS.Timeout | undefined;
    try {
      const c = await Promise.race([this.net.context(), new Promise<null>((r) => (timer = setTimeout(() => r(null), 3000)))]);
      net = c ? { ip: c.ip, gateway: c.gateway, dns: c.dns.slice(0, 3) } : null;
    } catch {
      net = null;
    } finally {
      clearTimeout(timer);
    }
    return {
      computer: s.deviceName,
      system: `${osPlatform()} ${osArch()}`,
      appVersion: s.version,
      edition: this.edition().productName,
      uptimeHours: Math.round(hb.uptimeSeconds / 360) / 10,
      cpuLoadPct: hb.cpuLoad,
      memoryUsedPct: hb.memUsedPct,
      memoryGb: Math.round(hb.memTotalMb / 102.4) / 10,
      diskFreeGb: hb.diskFreeGb,
      network: net,
      problems: hb.services.filter((x) => x.state === 'failed' || x.state === 'degraded').map((x) => `${x.name}: ${x.state}`),
      errors24h: hb.errors24h,
    };
  }

  private idleProbe: (() => number) | null = null;

  /** The desktop shell says how long nobody has touched the computer (seconds). */
  setIdleProbe(probe: () => number): void {
    this.idleProbe = probe;
  }

  idleSeconds(): number {
    try {
      return this.idleProbe ? this.idleProbe() : Number.POSITIVE_INFINITY;
    } catch {
      return 0;
    }
  }

  /**
   * "Update now" from FBRX Command: installs the newest version from wherever this computer gets them. Computers with a
   * release feed from FBRX Command use it; computers installed from the GitHub repository download and run the installer.
   */
  private async installUpdate(p: { restartNow: boolean; source: 'auto' | 'command' | 'repository' }): Promise<unknown> {
    const feed = this.platform.updates;
    if (p.source !== 'repository' && feed && feed.status().feedUrl) {
      const st = await feed.check();
      if (p.source === 'command' || ['available', 'downloading', 'downloaded'].includes(st.state)) return feed.install({ restartNow: p.restartNow });
    }
    if (p.source !== 'command' && this.release.installRoot()) {
      const st = await this.release.check();
      if (st.state === 'current') return { state: 'current', message: `Already on the newest version (${st.currentVersion})` };
      if (st.state !== 'available') throw new Error(st.message ?? 'Could not read the release list in the repository');
      this.audit.append({ category: 'updates', action: 'repository.install', actor: 'control-plane', target: st.latest?.version ?? null, outcome: 'info' });
      return this.release.install();
    }
    if (feed) return feed.install({ restartNow: p.restartNow });
    throw new Error('This computer has no way to update itself: it was not installed from the repository and has no update feed');
  }

  /** Why an Endpoint Ultra feature cannot be used on this computer (it runs Essentials or Standard), or null. */
  ultraOnly(what: string): string | null {
    return this.license.status().tier === 'ultra' ? null : `${what} come with ${TIER_NAMES.ultra}`;
  }

  /** False when the organization's network policy blocks every internet host. */
  internetAllowed(): boolean {
    return this.policy.policy.network.allowedDomains.length > 0;
  }

  /** Whether this computer's AI could take on help for another computer, and which AI it is. */
  private assistReady(): { ready: boolean; provider: string | null; model: string | null; local: boolean } {
    if (this.aiHalt() || this.edition().learner) return { ready: false, provider: null, model: null, local: false };
    try {
      const { config, model } = this.providers.resolve();
      return { ready: true, provider: config.name, model, local: config.type === 'local-runtime' || !config.cloud };
    } catch {
      return { ready: false, provider: null, model: null, local: false };
    }
  }

  private meshKeyPair(): KeyPair {
    const raw = this.vault.get(MESH_KEY, { allowInternal: true });
    if (raw) return JSON.parse(raw) as KeyPair;
    const kp = generateKeyPair();
    this.vault.set({ name: MESH_KEY, value: JSON.stringify(kp), kind: 'token' }, { internal: true });
    return kp;
  }

  private async meshStatusSummary() {
    const st = await this.status();
    const live = this.monitor.current;
    return {
      name: this.deviceName(),
      platform: st.platform,
      version: st.version,
      uptimeSeconds: live?.uptime ?? null,
      cpu: live?.cpu ?? null,
      memUsedPct: live ? Math.round((live.memUsed / live.memTotal) * 100) : null,
      battery: live?.battery ?? null,
      tempC: live?.tempC ?? null,
      services: st.services.map((x) => ({ name: x.title, state: x.state })),
      vault: st.vault.state,
      pendingApprovals: st.pendingApprovals,
      alerts: this.alerts.counts(),
      openTasks: this.workspace.listTasks().filter((t) => t.status !== 'done').length,
    };
  }

  /** Asks a configured AI provider for a second opinion, without tools. */
  async consult(providerId: string, prompt: string, model?: string): Promise<{ answer: string; providerId: string; model: string }> {
    if (this.aiHalt()) throw new CoreError('UNAVAILABLE', 'The AI is on emergency stop on this computer');
    const { provider, config, model: m } = this.providers.resolve(providerId, model);
    let answer = '';
    for await (const chunk of provider.chat({ model: m, messages: [{ role: 'user', content: prompt }], tools: [], temperature: 0.4, signal: AbortSignal.timeout(300_000) })) {
      if (chunk.type === 'text') answer += chunk.delta;
    }
    this.audit.append({ category: 'agent', action: 'consult', actor: 'user', outcome: 'success', details: { provider: config.id, model: m } });
    return { answer, providerId: config.id, model: m };
  }

  private readonly quickRuns = new Map<string, AbortController>();

  /**
   * A quick answer for a side panel (code lab, event viewer, task manager): the default model, no tools, streamed as
   * `ai.quick` events. The context (code, log lines, process details) has known secrets masked before it leaves.
   */
  async quick(p: { reqId: string; prompt: string; context?: string; history?: Array<{ role: 'user' | 'assistant'; content: string }> }): Promise<{ answer: string; model: string }> {
    if (this.aiHalt()) throw new CoreError('UNAVAILABLE', 'The AI is on emergency stop on this computer');
    const { provider, config, model } = this.providers.resolve();
    const ctrl = new AbortController();
    this.quickRuns.get(p.reqId)?.abort();
    this.quickRuns.set(p.reqId, ctrl);
    const s = this.settings.get();
    const who = addressAs(s);
    const system = [
      `You are ${s.ai.agentName || 'Fabrix'}, the assistant built into FBRX OS, answering in a side panel next to the person's work.`,
      'Be direct and practical. Use short paragraphs or bullets and Markdown code blocks with a language tag for any code.',
      'You cannot run anything yourself here; when something should be run, say exactly what and where.',
      ...(who ? [`You are helping ${who}.`] : []),
    ].join(' ');
    const context = p.context ? this.redactor.redact(p.context).text : '';
    // Turns alternate and start with a question (some providers insist); back-to-back turns of one side are merged.
    const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const h of [...(p.history ?? []).slice(-8), { role: 'user' as const, content: context ? `${p.prompt}\n\n---\n${context}` : p.prompt }]) {
      if (!h.content.trim() || (!turns.length && h.role === 'assistant')) continue;
      const last = turns[turns.length - 1];
      if (last?.role === h.role) last.content += `\n\n${h.content}`;
      else turns.push({ role: h.role, content: h.content });
    }
    const messages: ProviderMessage[] = [{ role: 'system', content: system }, ...turns];
    let answer = '';
    let pending = '';
    let last = 0;
    const flush = () => {
      if (!pending) return;
      this.events.emit('ai.quick', { reqId: p.reqId, delta: pending });
      pending = '';
      last = Date.now();
    };
    const timeout = setTimeout(() => ctrl.abort(), 300_000);
    try {
      for await (const chunk of provider.chat({ model, messages, tools: [], temperature: 0.3, signal: ctrl.signal })) {
        if (chunk.type === 'text') {
          answer += chunk.delta;
          pending += chunk.delta;
          if (Date.now() - last > 66) flush();
        } else if (chunk.type === 'done' && chunk.finishReason === 'error' && !answer) throw new CoreError('UNAVAILABLE', chunk.message || 'The model did not answer');
        if (this.aiHalt()) ctrl.abort();
      }
      flush();
    } catch (e) {
      flush();
      if (!ctrl.signal.aborted) throw toCoreError(e);
    } finally {
      clearTimeout(timeout);
      if (this.quickRuns.get(p.reqId) === ctrl) this.quickRuns.delete(p.reqId);
    }
    this.audit.append({ category: 'agent', action: 'quick', actor: 'user', outcome: 'success', details: { provider: config.id, model, chars: answer.length } });
    return { answer, model };
  }

  cancelQuick(reqId: string): void {
    this.quickRuns.get(reqId)?.abort();
  }

  private localApiTokens(): { full: string; agent: string } | null {
    if (!this.vault.isUnlocked) return null;
    const full = this.vault.get(LOCAL_API_TOKEN, { allowInternal: true });
    const agent = this.vault.get(LOCAL_API_AGENT_TOKEN, { allowInternal: true });
    return full && agent ? { full, agent } : null;
  }

  // ------------------------------------------------------------------------------- provisioning

  /**
   * A license key saved as `fbrx-license.key` in the data folder (by the setup wizard or IT tooling) is activated on
   * start and the file removed. A key that does not verify is kept as `fbrx-license.key.rejected` for inspection.
   */
  private applyLicenseFile(): void {
    const file = join(this.paths.root, LICENSE_FILE_NAME);
    if (!existsSync(file)) return;
    try {
      const status = this.license.activate(readFileSync(file, 'utf8').trim());
      rmSync(file, { force: true });
      this.audit.append({ category: 'license', action: 'activated', actor: 'license-file', outcome: 'success', details: { edition: status.edition, customer: status.customer } });
      this.log.info('License activated from file', { edition: status.edition, customer: status.customer });
    } catch (err) {
      renameSync(file, `${file}.rejected`);
      this.audit.append({ category: 'license', action: 'activated', actor: 'license-file', outcome: 'failure', details: { reason: errorMessage(err) } });
      this.log.warn('License file rejected', { error: errorMessage(err) });
    }
  }

  /**
   * Zero-touch deployment: an `fbrx-provision.json` (from the admin console) placed in the data folder or
   * next to the installer enrolls this workstation, optionally after restoring a golden template snapshot.
   */
  private async applyProvisioning(): Promise<void> {
    if (this.fleet.enrolled) return;
    const file = this.provisioningFiles.find((f) => existsSync(f));
    if (!file) return;
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const prov = ProvisioningFileSchema.parse(raw);
    this.log.info('Provisioning file found', { file, server: prov.serverUrl });
    const stateKey = `provisioning.${prov.enrollmentToken.slice(-8)}`;
    if (prov.templateSnapshotUrl && !this.meta.get(`${stateKey}.templateApplied`)) {
      const init = { signal: AbortSignal.timeout(30 * 60_000) };
      const pinned = prov.serverFingerprint && new URL(prov.templateSnapshotUrl).origin === new URL(prov.serverUrl).origin;
      const res = pinned ? await pinnedFetch(prov.templateSnapshotUrl, init, pinnedAgent(prov.serverFingerprint!)) : await fetch(prov.templateSnapshotUrl, init);
      if (!res.ok) throw new Error(`Template snapshot download failed: HTTP ${res.status}`);
      const tmp = join(this.paths.tmp, `template-${Date.now()}.fbrxsnap`);
      writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
      await stageRestore({ file: tmp, passphrase: prov.templateSnapshotPassphrase ?? '', mode: 'clone', paths: this.paths, keychain: this.platform.keychain });
      rmSync(tmp, { force: true });
      // Record in the staged database's successor: the marker lives in the provisioning file itself.
      writeFileSync(file, JSON.stringify({ ...raw, templateApplied: true }, null, 2));
      this.audit.append({ category: 'provisioning', action: 'template.staged', actor: 'provisioning', outcome: 'success', details: { url: prov.templateSnapshotUrl } });
      this.platform.requestRestart('provisioning');
      return;
    }
    await this.fleet.enroll(prov.serverUrl, prov.enrollmentToken, prov.deviceName, 'provisioning', prov.audience, prov.serverFingerprint);
    try {
      renameSync(file, `${file}.applied`);
    } catch {
      /* read-only location (e.g. next to the installer) */
    }
    this.audit.append({ category: 'provisioning', action: 'enrolled', actor: 'provisioning', outcome: 'success', details: { server: prov.serverUrl } });
  }
}
