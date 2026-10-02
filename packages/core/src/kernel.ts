import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, freemem, hostname, loadavg, userInfo, platform as osPlatform, arch as osArch, totalmem, uptime as osUptime } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  LICENSE_FILE_NAME,
  PRODUCT_NAME,
  ProvisioningFileSchema,
  type DeviceCommand,
  type Heartbeat,
  type NotificationEvent,
  type SystemStatus,
  type UpdateStatus,
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
import { Guardian } from './governance/guardian';
import { ApprovalQueue } from './governance/approvals';
import { Redactor } from './governance/redactor';
import { RateLimiter } from './governance/rate-limiter';
import { ToolGate } from './governance/tool-gate';
import { checkUrl } from './governance/network-guard';
import { LicenseService } from './license/license-service';
import { ToolRegistry } from './tools/registry';
import { fbrxTools, fsTools, memoryTools, netTools, shellTools, systemTools, diskFreeGb } from './tools/builtin';
import { pcTools, workspaceTools } from './tools/builtin/command-center-tools';
import { WorkspaceStore } from './workspace/workspace-store';
import { SystemMonitor } from './system/system-monitor';
import { FileBrowser, TerminalSessions } from './system/files';
import { Spotlight } from './spotlight/spotlight';
import { AlertEngine } from './alerts/alert-engine';
import { NetDiag } from './network/netdiag';
import { Trophies } from './fun/trophies';
import { Fbrx1Cli } from './cli/fbrx1';
import { VendorDb } from './network/vendors';
import { DeviceConsoles } from './network/device-console';
import { deviceConsoleTools } from './tools/builtin/device-console-tools';
import { MeshService } from './mesh/mesh-service';
import { generateKeyPair, type KeyPair } from './mesh/mesh-crypto';
import { AiCoordination } from './aicoord/aicoord';
import { ConversationStore } from './ai/conversations';
import { ModelManager } from './ai/runtime/model-manager';
import { LocalRuntime } from './ai/runtime/local-runtime';
import { ProviderManager } from './ai/provider-manager';
import { AgentRuntime } from './ai/agent';
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
  readonly redactor = new Redactor();
  readonly limiter: RateLimiter;
  readonly license: LicenseService;
  readonly registry: ToolRegistry;
  readonly gate: ToolGate;
  readonly conversations: ConversationStore;
  readonly models: ModelManager;
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
  readonly vendors: VendorDb;
  readonly consoles: DeviceConsoles;
  readonly trophies: Trophies;
  readonly cli: Fbrx1Cli;
  readonly mesh: MeshService;
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
    this.vault = new Vault(this.db, this.platform.keychain, L('vault'), this.events);
    this.policy = new PolicyEngine(
      this.db,
      () => ({ ...this.platform.specialDirs(), workspace: this.paths.workspace, data: this.paths.root }),
      this.events,
    );
    this.approvals = new ApprovalQueue(this.events);
    this.limiter = new RateLimiter(() => this.policy.policy.rateLimits.toolCallsPerMinute);
    this.license = new LicenseService(this.meta, this.platform.licensePublicKeys, this.platform.appVersion, this.platform.devMode, this.events);
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
      fun: {
        enabled: () => this.settings.get().appearance.easterEggs,
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
      easterEggs: () => this.settings.get().appearance.easterEggs,
    });
    this.vendors = new VendorDb({
      builtinFile: this.platform.vendorDbFile ?? null,
      userFile: join(this.paths.root, 'oui-vendors.tsv.gz'),
      legacyFile: join(this.paths.root, 'oui-vendors.txt'),
      internet: () => this.internetAllowed(),
    });
    this.net = new NetDiag({ db: this.db, events: this.events, vendors: this.vendors, internet: () => this.internetAllowed() });
    this.trophies = new Trophies({ meta: this.meta, events: this.events, enabled: () => this.settings.get().appearance.easterEggs });
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
    });
    this.alerts = new AlertEngine({
      db: this.db,
      events: this.events,
      log: L('alerts'),
      settings: () => this.settings.get(),
      monitor: this.monitor,
      workspace: this.workspace,
      notify: (title, body, level) => this.notify({ title, body, level, source: 'alerts' }),
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
    return new Kernel(opts);
  }

  deviceName(): string {
    return this.settings.get().general.deviceName || hostname();
  }

  private notify(n: NotificationEvent) {
    this.events.emit('notification', n);
  }

  private wire() {
    this.disposers.push(
      this.events.on('notification', (n) => {
        try {
          this.platform.notify(n);
        } catch {
          /* headless */
        }
      }),
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
      health: async () => (this.vault.isUnlocked ? { state: 'running' } : { state: 'degraded', message: 'Locked: enter the recovery passphrase to unlock' }),
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
          ...memoryTools(this.db),
          ...fbrxTools({ status: () => this.status(), recentAudit: (n) => this.audit.query({ limit: n }) }),
          ...workspaceTools(this.workspace),
          ...deviceConsoleTools(this.consoles),
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
        if (this.settings.get().runtime.autoStart && st.state === 'stopped') {
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

  async start(): Promise<void> {
    await this.services.startAll();
    this.services.startWatchdog();
    this.started = true;
    this.log.info(`${PRODUCT_NAME} ${this.platform.appVersion} started`, { dataDir: this.paths.root, shell: this.platform.shell });
    this.applyLicenseFile();
    void this.applyProvisioning().catch((err) => this.log.error('Provisioning failed', { error: errorMessage(err) }));
    this.audit.prune(365);
  }

  async stop(): Promise<void> {
    if (!this.started) {
      this.db.close();
      return;
    }
    this.started = false;
    this.terminal.killAll();
    this.consoles.closeAll();
    this.spotlight.dispose();
    await this.services.stopAll();
    for (const d of this.disposers) d();
    this.disposers = [];
    this.events.removeAll();
    this.log.info('Stopped cleanly');
    this.db.close();
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
  }

  // ----------------------------------------------------------------------------------- core API

  /** Dispatches a core API call with origin checks and auditing. */
  async call(method: string, params: unknown, ctx: CallContext): Promise<unknown> {
    const handler = this.api[method];
    if (!handler) throw new CoreError('NOT_FOUND', `Unknown method ${method}`);
    if (ctx.origin !== 'user' && isUserOnly(method)) {
      throw new CoreError('FORBIDDEN', `${method} can only be performed by a person at this workstation`);
    }
    const audited = !isReadOnly(method) && method !== 'ai.chat' && method !== 'agent.runToCompletion' && method !== 'tools.invoke';
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
    const rt = this.settings.get().runtime;
    if (rt.enabled && rt.autoStart) void this.runtime.start().catch((err) => this.log.warn('Local runtime did not start', { error: errorMessage(err) }));
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
    };
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
        if (!this.platform.updates) throw new Error('This installation cannot self-update');
        return this.platform.updates.install({ restartNow: !!p.restartNow });
      case 'backup.create': {
        const info = await this.backup.create({ label: p.label, actor: 'control-plane' });
        let uploaded: string | null = null;
        if (p.upload) uploaded = (await this.fleet.uploadSnapshot(info.file, p.label ?? null)).snapshotId;
        return { file: info.name, sizeBytes: info.sizeBytes, snapshotId: info.header?.snapshotId, uploadedSnapshotId: uploaded };
      }
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

  /** False when the organization's network policy blocks every internet host. */
  internetAllowed(): boolean {
    return this.policy.policy.network.allowedDomains.length > 0;
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
      const res = await fetch(prov.templateSnapshotUrl, { signal: AbortSignal.timeout(30 * 60_000) });
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
    await this.fleet.enroll(prov.serverUrl, prov.enrollmentToken, prov.deviceName, 'provisioning');
    try {
      renameSync(file, `${file}.applied`);
    } catch {
      /* read-only location (e.g. next to the installer) */
    }
    this.audit.append({ category: 'provisioning', action: 'enrolled', actor: 'provisioning', outcome: 'success', details: { server: prov.serverUrl } });
  }
}
