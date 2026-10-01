import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import * as tar from 'tar';
import {
  PLUGIN_MANIFEST_FILE,
  TOOL_NAME_RE,
  validateManifest,
  type HostToWorker,
  type PluginManifest,
  type ToolDefinition,
  type WorkerToHost,
} from '@fbrx/plugin-sdk';
import { RISK_LEVELS, satisfies, type PluginInfo, type RiskLevel } from '@fbrx/shared';
import { CoreError, errorMessage } from '../errors';
import type { AuditLog } from '../audit/audit-log';
import type { Db } from '../storage/db';
import type { EventBus } from '../events';
import type { Logger } from '../logger';
import type { ToolRegistry } from '../tools/registry';
import type { ToolSpec } from '../tools/types';
import type { Vault } from '../vault/vault';
import type { UrlCheck } from '../governance/network-guard';
import { guardedFetch } from '../tools/builtin/net-tools';
import { Deferred, sleep } from '../util/misc';

interface PluginRow {
  id: string;
  name: string;
  version: string;
  enabled: number;
  dir: string;
  manifest: string;
  installed_at: string;
}

export interface PluginHostDeps {
  db: Db;
  pluginsDir: string;
  pluginDataDir: string;
  tmpDir: string;
  workerPath: string;
  sandbox: boolean;
  appVersion: string;
  registry: ToolRegistry;
  vault: Vault;
  audit: AuditLog;
  checkUrl: (url: string) => Promise<UrlCheck>;
  notify: (title: string, body: string, source: string) => void;
  log: Logger;
  events?: EventBus;
}

type ToolMeta = Omit<ToolDefinition, 'run'>;

/** One running plugin worker process. */
class PluginProcess {
  child: ChildProcess | null = null;
  tools: ToolMeta[] = [];
  state: PluginInfo['state'] = 'stopped';
  error: string | null = null;
  private seq = 0;
  private calls = new Map<string, Deferred<{ output: string; data?: unknown }>>();
  private crashes: number[] = [];
  private stopping = false;

  constructor(
    readonly manifest: PluginManifest,
    readonly root: string,
    private readonly host: PluginHost,
    private readonly d: PluginHostDeps,
  ) {}

  get dataDir() {
    return join(this.d.pluginDataDir, this.manifest.id);
  }

  async start(): Promise<void> {
    mkdirSync(this.dataDir, { recursive: true });
    this.stopping = false;
    // Work with real paths only. The permission model matches paths literally, and Node's module loader walks every
    // component of a path, so a symlink anywhere above the plugin (macOS /var → /private/var, a redirected home folder,
    // FBRX_HOME on a linked volume) would otherwise be refused.
    const real = (p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    };
    const root = real(this.root);
    const dataDir = real(this.dataDir);
    const workerPath = real(this.d.workerPath);
    const execArgv = this.d.sandbox
      ? ['--permission', `--allow-fs-read=${root}`, `--allow-fs-read=${dirname(workerPath)}`, `--allow-fs-read=${dataDir}`, `--allow-fs-write=${dataDir}`]
      : [];
    const child = fork(workerPath, [], {
      execArgv,
      cwd: dataDir,
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        NODE_ENV: 'production',
        PATH: process.env.PATH ?? '',
        FBRX_PLUGIN_ID: this.manifest.id,
      },
      serialization: 'json',
      // No stdio pipes: a pipe would hand the plugin a net.Socket it could reuse for raw network access.
      // The worker forwards console output and errors over IPC instead.
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    this.child = child;
    const ready = new Deferred<void>();
    child.on('message', (m: WorkerToHost) => this.onMessage(m, ready));
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      for (const [, call] of this.calls) call.reject(new Error('Plugin process exited'));
      this.calls.clear();
      this.d.registry.unregisterSource('plugin', this.manifest.id);
      if (this.stopping) {
        this.state = 'stopped';
      } else {
        this.state = 'failed';
        this.error = `Plugin process exited (${code ?? signal})`;
        ready.reject(new Error(this.error));
        this.d.log.error('Plugin crashed', { plugin: this.manifest.id, code, signal });
        void this.maybeRestart();
      }
      this.host.changed();
    });
    this.send({ kind: 'init', manifest: this.manifest, root, dataDir });
    const timeout = setTimeout(() => ready.reject(new Error('Plugin did not become ready within 15s')), 15_000);
    try {
      await ready.promise;
      this.state = 'running';
      this.error = null;
      this.registerTools();
    } catch (err) {
      this.state = 'failed';
      this.error = errorMessage(err);
      await this.stop();
      this.state = 'failed';
      throw err;
    } finally {
      clearTimeout(timeout);
      this.host.changed();
    }
  }

  private async maybeRestart() {
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < 300_000);
    this.crashes.push(now);
    if (this.crashes.length > 3) {
      this.error = 'Plugin crashed repeatedly and was stopped';
      this.d.audit.append({ category: 'plugin', action: 'crash-loop', actor: 'system', target: this.manifest.id, outcome: 'failure' });
      return;
    }
    await sleep(1000 * 2 ** this.crashes.length);
    if (this.state === 'failed' && !this.stopping) {
      try {
        await this.start();
      } catch {
        /* recorded in state */
      }
    }
  }

  private registerTools() {
    this.d.registry.unregisterSource('plugin', this.manifest.id);
    const specs: ToolSpec[] = [];
    for (const t of this.tools) {
      if (!TOOL_NAME_RE.test(t.name)) {
        this.d.log.warn('Skipping plugin tool with invalid name', { plugin: this.manifest.id, tool: t.name });
        continue;
      }
      const risk: RiskLevel = (RISK_LEVELS as readonly string[]).includes(t.risk) ? t.risk : 'sensitive';
      specs.push({
        name: `${this.manifest.namespace}.${t.name}`,
        title: t.title || t.name,
        description: t.description || '',
        risk,
        source: 'plugin',
        sourceId: this.manifest.id,
        feature: 'plugins',
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
        run: (input, ctx) => this.invoke(t.name, input, ctx.callId, ctx.origin, ctx.signal),
      });
    }
    try {
      this.d.registry.registerMany(specs);
    } catch (err) {
      this.error = errorMessage(err);
      this.d.log.error('Plugin tool registration failed', { plugin: this.manifest.id, error: this.error });
    }
  }

  invoke(tool: string, input: unknown, callId: string, origin: string, signal: AbortSignal): Promise<{ output: string; data?: unknown }> {
    if (!this.child || this.state !== 'running') return Promise.reject(new Error('Plugin is not running'));
    const id = `i${++this.seq}`;
    const d = new Deferred<{ output: string; data?: unknown }>();
    this.calls.set(id, d);
    const onAbort = () => this.send({ kind: 'cancel', id });
    signal.addEventListener('abort', onAbort, { once: true });
    this.send({ kind: 'invoke', id, tool, input, callId, origin });
    return d.promise.finally(() => {
      signal.removeEventListener('abort', onAbort);
      this.calls.delete(id);
    });
  }

  private send(m: HostToWorker) {
    if (this.child?.connected) this.child.send(m);
  }

  private onMessage(m: WorkerToHost, ready: Deferred<void>) {
    switch (m.kind) {
      case 'ready':
        this.tools = m.tools;
        ready.resolve();
        break;
      case 'init-failed':
        ready.reject(new Error(m.error));
        break;
      case 'result': {
        const call = this.calls.get(m.id);
        if (!call) break;
        if (m.ok) call.resolve({ output: m.result?.output ?? '', data: m.result?.data });
        else call.reject(new Error(m.error ?? 'Plugin tool failed'));
        break;
      }
      case 'log':
        this.d.log[m.level === 'debug' ? 'debug' : m.level === 'warn' ? 'warn' : m.level === 'error' ? 'error' : 'info'](
          `[${this.manifest.id}] ${m.message}`,
          m.data,
        );
        break;
      case 'request':
        this.host
          .handleRequest(this, m.method, m.params)
          .then((result) => this.send({ kind: 'response', id: m.id, ok: true, result }))
          .catch((err) => this.send({ kind: 'response', id: m.id, ok: false, error: errorMessage(err) }));
        break;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.d.registry.unregisterSource('plugin', this.manifest.id);
    if (!child) {
      this.state = 'stopped';
      return;
    }
    this.send({ kind: 'shutdown' });
    const exited = await Promise.race([new Promise<boolean>((r) => child.once('exit', () => r(true))), sleep(3000).then(() => false)]);
    if (!exited) child.kill('SIGKILL');
    this.child = null;
    this.state = 'stopped';
  }

  has(permission: string): boolean {
    return (this.manifest.permissions ?? []).includes(permission);
  }

  allowsHost(host: string): boolean {
    return (this.manifest.permissions ?? []).some((p) => {
      if (!p.startsWith('network:')) return false;
      const pat = p.slice(8).replace(/:\d+$/, '');
      if (pat === '*') return true;
      if (pat.startsWith('*.')) return host === pat.slice(2) || host.endsWith(pat.slice(1));
      return host === pat;
    });
  }
}

/**
 * Installs, sandboxes and supervises plugins. Each plugin runs in its own worker process; tools it exposes
 * are registered with the ToolRegistry and therefore governed like every other tool.
 */
export class PluginHost {
  private readonly procs = new Map<string, PluginProcess>();

  constructor(private readonly d: PluginHostDeps) {}

  private rows(): PluginRow[] {
    return this.d.db.all<PluginRow>('SELECT * FROM plugins ORDER BY name COLLATE NOCASE');
  }

  async startAll(): Promise<void> {
    for (const row of this.rows()) {
      if (!row.enabled) continue;
      try {
        await this.startOne(row);
      } catch (err) {
        this.d.log.error('Plugin failed to start', { plugin: row.id, error: errorMessage(err) });
      }
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.procs.values()].map((p) => p.stop()));
    this.procs.clear();
  }

  private async startOne(row: PluginRow): Promise<void> {
    const manifest = JSON.parse(row.manifest) as PluginManifest;
    const range = manifest.engines?.fbrx;
    let proc = this.procs.get(row.id);
    if (!proc) {
      proc = new PluginProcess(manifest, row.dir, this, this.d);
      this.procs.set(row.id, proc);
    }
    if (range && !satisfies(this.d.appVersion, range)) {
      proc.state = 'incompatible';
      proc.error = `Requires FBRX OS ${range} (this is ${this.d.appVersion})`;
      this.changed();
      return;
    }
    await proc.start();
  }

  list(): PluginInfo[] {
    return this.rows().map((r) => {
      const manifest = JSON.parse(r.manifest) as PluginManifest;
      const proc = this.procs.get(r.id);
      return {
        id: r.id,
        name: r.name,
        version: r.version,
        description: manifest.description ?? '',
        author: manifest.author ?? '',
        enabled: !!r.enabled,
        state: proc?.state ?? 'stopped',
        error: proc?.error ?? null,
        permissions: manifest.permissions ?? [],
        tools: (proc?.tools ?? []).map((t) => `${manifest.namespace}.${t.name}`),
        path: r.dir,
        installedAt: r.installed_at,
      };
    });
  }

  get(id: string): PluginInfo {
    const p = this.list().find((x) => x.id === id);
    if (!p) throw new CoreError('NOT_FOUND', `Plugin ${id} is not installed`);
    return p;
  }

  /** Installs (or upgrades) a plugin from a folder or a .tgz/.tar.gz package. */
  async install(source: string, actor: string): Promise<PluginInfo> {
    const src = resolve(source);
    if (!existsSync(src)) throw new CoreError('NOT_FOUND', `Not found: ${src}`);
    let staging: string | null = null;
    let root = src;
    try {
      if (statSync(src).isFile()) {
        if (!/\.(tgz|tar\.gz)$/i.test(src)) throw new CoreError('INVALID_ARGUMENT', 'Plugin packages must be folders or .tgz files');
        staging = await mkdtemp(join(this.d.tmpDir, 'plugin-'));
        await tar.x({ file: src, cwd: staging, strict: true, filter: (p) => !p.split(/[\\/]/).includes('..') });
        root = existsSync(join(staging, PLUGIN_MANIFEST_FILE)) ? staging : findManifestDir(staging) ?? staging;
      }
      const manifestPath = join(root, PLUGIN_MANIFEST_FILE);
      if (!existsSync(manifestPath)) throw new CoreError('INVALID_ARGUMENT', `${PLUGIN_MANIFEST_FILE} not found`);
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
      } catch {
        throw new CoreError('INVALID_ARGUMENT', `${PLUGIN_MANIFEST_FILE} is not valid JSON`);
      }
      const v = validateManifest(raw);
      if (!v.ok) throw new CoreError('INVALID_ARGUMENT', `Invalid plugin manifest: ${v.errors.join('; ')}`);
      const m = v.manifest;
      if (!existsSync(join(root, m.main))) throw new CoreError('INVALID_ARGUMENT', `Entry file ${m.main} not found`);
      const clash = this.rows().find((r) => r.id !== m.id && (JSON.parse(r.manifest) as PluginManifest).namespace === m.namespace);
      if (clash) throw new CoreError('ALREADY_EXISTS', `Namespace "${m.namespace}" is already used by ${clash.id}`);

      const existing = this.procs.get(m.id);
      if (existing) {
        await existing.stop();
        this.procs.delete(m.id);
      }
      const dest = join(this.d.pluginsDir, m.id);
      await rm(dest, { recursive: true, force: true });
      await cp(root, dest, { recursive: true });
      const now = new Date().toISOString();
      this.d.db.run(
        `INSERT INTO plugins (id, name, version, enabled, dir, manifest, installed_at, updated_at) VALUES (?,?,?,1,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, version = excluded.version, dir = excluded.dir, manifest = excluded.manifest, updated_at = excluded.updated_at`,
        m.id,
        m.name,
        m.version,
        dest,
        JSON.stringify(m),
        now,
        now,
      );
      this.d.audit.append({
        category: 'plugin',
        action: 'installed',
        actor,
        target: m.id,
        outcome: 'success',
        details: { version: m.version, permissions: m.permissions ?? [] },
      });
      const row = this.rows().find((r) => r.id === m.id)!;
      if (row.enabled) {
        try {
          await this.startOne(row);
        } catch (err) {
          this.d.log.error('Installed plugin failed to start', { plugin: m.id, error: errorMessage(err) });
        }
      }
      this.changed();
      return this.get(m.id);
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true });
    }
  }

  async uninstall(id: string, actor: string): Promise<boolean> {
    const row = this.rows().find((r) => r.id === id);
    if (!row) return false;
    await this.procs.get(id)?.stop();
    this.procs.delete(id);
    await rm(row.dir, { recursive: true, force: true });
    await rm(join(this.d.pluginDataDir, id), { recursive: true, force: true });
    this.d.db.run('DELETE FROM plugins WHERE id = ?', id);
    this.d.db.run('DELETE FROM plugin_storage WHERE plugin_id = ?', id);
    this.d.audit.append({ category: 'plugin', action: 'uninstalled', actor, target: id, outcome: 'success' });
    this.changed();
    return true;
  }

  async setEnabled(id: string, enabled: boolean, actor: string): Promise<PluginInfo> {
    const row = this.rows().find((r) => r.id === id);
    if (!row) throw new CoreError('NOT_FOUND', `Plugin ${id} is not installed`);
    this.d.db.run('UPDATE plugins SET enabled = ? WHERE id = ?', enabled ? 1 : 0, id);
    if (enabled) {
      try {
        await this.startOne({ ...row, enabled: 1 });
      } catch (err) {
        this.d.log.error('Plugin failed to start', { plugin: id, error: errorMessage(err) });
      }
    } else {
      await this.procs.get(id)?.stop();
    }
    this.d.audit.append({ category: 'plugin', action: enabled ? 'enabled' : 'disabled', actor, target: id, outcome: 'success' });
    this.changed();
    return this.get(id);
  }

  async reload(id: string): Promise<PluginInfo> {
    const row = this.rows().find((r) => r.id === id);
    if (!row) throw new CoreError('NOT_FOUND', `Plugin ${id} is not installed`);
    await this.procs.get(id)?.stop();
    this.procs.delete(id);
    if (row.enabled) await this.startOne(row).catch(() => undefined);
    this.changed();
    return this.get(id);
  }

  changed() {
    this.d.events?.emit('plugins.changed', this.list());
  }

  /** Brokered capabilities requested by a plugin worker. */
  async handleRequest(proc: PluginProcess, method: string, params: any): Promise<unknown> {
    const id = proc.manifest.id;
    switch (method) {
      case 'storage.get':
      case 'storage.set':
      case 'storage.delete':
      case 'storage.keys': {
        if (!proc.has('storage')) throw new Error('Plugin lacks the "storage" permission');
        if (method === 'storage.keys') {
          return this.d.db.all<{ key: string }>('SELECT key FROM plugin_storage WHERE plugin_id = ? ORDER BY key', id).map((r) => r.key);
        }
        const key = String(params?.key ?? '');
        if (!key || key.length > 256) throw new Error('Invalid storage key');
        if (method === 'storage.get') {
          const row = this.d.db.get<{ value: string }>('SELECT value FROM plugin_storage WHERE plugin_id = ? AND key = ?', id, key);
          return row ? JSON.parse(row.value) : undefined;
        }
        if (method === 'storage.delete') {
          this.d.db.run('DELETE FROM plugin_storage WHERE plugin_id = ? AND key = ?', id, key);
          return null;
        }
        const value = JSON.stringify(params?.value ?? null);
        if (value.length > 1_000_000) throw new Error('Stored values are limited to 1 MB');
        this.d.db.run(
          'INSERT INTO plugin_storage (plugin_id, key, value) VALUES (?,?,?) ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value',
          id,
          key,
          value,
        );
        return null;
      }
      case 'secrets.get': {
        const name = String(params?.name ?? '');
        if (!proc.has(`secrets:${name}`)) throw new Error(`Plugin lacks the "secrets:${name}" permission`);
        const value = this.d.vault.get(name);
        this.d.audit.append({ category: 'plugin', action: 'secret.read', actor: `plugin:${id}`, target: name, outcome: value === undefined ? 'failure' : 'success' });
        return value;
      }
      case 'http.fetch': {
        const url = String(params?.url ?? '');
        let host = '';
        try {
          host = new URL(url).hostname.toLowerCase();
        } catch {
          throw new Error(`Invalid URL ${url}`);
        }
        if (!proc.allowsHost(host)) {
          this.d.audit.append({ category: 'plugin', action: 'http', actor: `plugin:${id}`, target: host, outcome: 'denied', details: { reason: 'permission' } });
          throw new Error(`Plugin lacks the "network:${host}" permission`);
        }
        const init = params?.init ?? {};
        const timeout = AbortSignal.timeout(Math.min(Number(init.timeoutMs) || 30_000, 120_000));
        try {
          const r = await guardedFetch(url, { method: init.method, headers: init.headers, body: init.body, signal: timeout }, this.d.checkUrl);
          this.d.audit.append({ category: 'plugin', action: 'http', actor: `plugin:${id}`, target: host, outcome: 'success', details: { status: r.status, method: init.method ?? 'GET' } });
          return { status: r.status, headers: r.headers, body: r.body };
        } catch (err) {
          this.d.audit.append({ category: 'plugin', action: 'http', actor: `plugin:${id}`, target: host, outcome: 'denied', details: { reason: errorMessage(err) } });
          throw err;
        }
      }
      case 'notify': {
        if (!proc.has('notifications')) throw new Error('Plugin lacks the "notifications" permission');
        this.d.notify(String(params?.title ?? '').slice(0, 200), String(params?.body ?? '').slice(0, 2000), id);
        return null;
      }
      default:
        throw new Error(`Unknown host method ${method}`);
    }
  }
}

function findManifestDir(dir: string, depth = 2): string | null {
  if (existsSync(join(dir, PLUGIN_MANIFEST_FILE))) return dir;
  if (depth === 0) return null;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      const hit = findManifestDir(join(dir, e.name), depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}
