import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import { freemem, setPriority, totalmem } from 'node:os';
import { delimiter, join } from 'node:path';
import type { RuntimeStatus } from '@fbrx/shared';
import { CoreError } from '../../errors';
import type { EventBus } from '../../events';
import type { Logger } from '../../logger';
import type { SettingsService } from '../../settings/settings-service';
import type { ModelManager } from './model-manager';
import { sleep } from '../../util/misc';
import si from 'systeminformation';
import { installLlamaRuntime } from './runtime-installer';
import { resourcePlan } from '../resources';

const EXE = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

function isExecutable(p: string): boolean {
  try {
    accessSync(p, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Finds `llama-server` inside a runtime folder (release archives nest it under build/bin or similar). */
function findIn(dir: string, depth = 3): string | null {
  if (!existsSync(dir)) return null;
  const direct = join(dir, EXE);
  if (existsSync(direct) && isExecutable(direct)) return direct;
  if (depth === 0) return null;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        const hit = findIn(join(dir, e.name), depth - 1);
        if (hit) return hit;
      }
    }
  } catch {
    /* unreadable */
  }
  return null;
}

/**
 * The built-in local AI runtime: supervises a llama.cpp `llama-server` process bound to 127.0.0.1 with a
 * per-launch random API key, so only FBRX OS can talk to it. Nothing leaves the machine.
 */
/**
 * The GPU build (Vulkan) when the computer has a graphics card that can run models, otherwise the portable CPU build.
 * The Vulkan build still runs on the CPU when no Vulkan driver is present.
 */
async function gpuVariant(): Promise<'cpu' | 'vulkan'> {
  if (process.platform === 'darwin') return 'cpu'; // macOS builds always use Metal
  try {
    const { controllers } = await si.graphics();
    const capable = controllers.some((c) => /nvidia|geforce|quadro|rtx|radeon|amd|advanced micro|intel.*arc/i.test(`${c.vendor} ${c.model}`) && (c.vram ?? 0) >= 2048);
    return capable ? 'vulkan' : 'cpu';
  } catch {
    return 'cpu';
  }
}

export class LocalRuntime {
  private child: ChildProcess | null = null;
  private state: RuntimeStatus['state'] = 'stopped';
  private message: string | null = null;
  private apiKeyValue = '';
  private recentOutput: string[] = [];
  private stopping = false;
  private starting: Promise<RuntimeStatus> | null = null;
  /** Requests using the model right now, and when it was last used (for unloading it when idle). */
  private active = 0;
  private lastUsed = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly d: {
      settings: SettingsService;
      models: ModelManager;
      runtimeDir: string;
      resourcesDir: string | null;
      log: Logger;
      events?: EventBus;
    },
  ) {}

  resolveBinary(): string | null {
    const cfg = this.d.settings.get().runtime.binaryPath;
    if (cfg && existsSync(cfg)) return cfg;
    const plat = `${process.platform}-${process.arch}`;
    if (this.d.resourcesDir) {
      const bundled = findIn(join(this.d.resourcesDir, 'runtime', plat)) ?? findIn(join(this.d.resourcesDir, 'runtime'));
      if (bundled) return bundled;
    }
    const downloaded = findIn(join(this.d.runtimeDir, plat)) ?? findIn(this.d.runtimeDir);
    if (downloaded) return downloaded;
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (dir && existsSync(join(dir, EXE)) && isExecutable(join(dir, EXE))) return join(dir, EXE);
    }
    return null;
  }

  get endpoint(): string {
    return `http://127.0.0.1:${this.d.settings.get().runtime.port}/v1`;
  }

  get apiKey(): string {
    return this.apiKeyValue;
  }

  status(): RuntimeStatus {
    const s = this.d.settings.get().runtime;
    const binary = this.resolveBinary();
    const model = s.modelId ? this.d.models.get(s.modelId) : undefined;
    let state = this.state;
    let message = this.message;
    if (!s.enabled) state = 'disabled';
    else if (state === 'stopped' || state === 'failed') {
      if (!binary) {
        state = 'not-installed';
        message = message ?? 'llama-server runtime not found. Install the bundled runtime or set its path in Settings.';
      } else if (!model) {
        state = 'no-model';
        message = 'Download or import a model to use the local AI runtime.';
      }
    }
    return {
      state,
      binaryPath: binary,
      modelId: model?.id ?? null,
      modelFile: model?.file ?? null,
      port: s.port,
      pid: this.child?.pid ?? null,
      endpoint: this.state === 'running' ? this.endpoint : null,
      message,
    };
  }

  private setState(state: RuntimeStatus['state'], message: string | null = null) {
    this.state = state;
    this.message = message;
    this.d.events?.emit('runtime.changed', this.status());
  }

  /** Whether a model is set up so the runtime could start on demand. */
  get canStart(): boolean {
    const s = this.d.settings.get().runtime;
    return s.enabled && !!s.modelId && !!this.d.models.get(s.modelId) && !!this.resolveBinary();
  }

  /** Marks the model in use, starting the runtime first if it is not running (it may have been unloaded when idle). */
  async acquire(): Promise<void> {
    this.active++;
    this.lastUsed = Date.now();
    if (this.state === 'running' && this.child) return;
    try {
      await this.start();
      if (this.state !== 'running') throw new CoreError('UNAVAILABLE', this.message ?? 'The local AI runtime did not start');
    } catch (err) {
      this.active = Math.max(0, this.active - 1);
      throw err;
    }
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    this.lastUsed = Date.now();
  }

  async start(): Promise<RuntimeStatus> {
    if (this.starting) return this.starting;
    if (this.child && this.state === 'running') return this.status();
    this.starting = this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launch(): Promise<RuntimeStatus> {
    const s = this.d.settings.get().runtime;
    if (!s.enabled) throw new CoreError('UNAVAILABLE', 'The local runtime is disabled in settings');
    const binary = this.resolveBinary();
    if (!binary) throw new CoreError('UNAVAILABLE', 'llama-server runtime not found');
    const model = s.modelId ? this.d.models.get(s.modelId) : undefined;
    if (!model) throw new CoreError('UNAVAILABLE', 'No model selected for the local runtime');
    // A model that does not fit in memory makes the whole computer swap until it freezes; refuse it up front.
    let size = 0;
    try {
      size = statSync(model.file).size;
    } catch {
      /* the runtime reports a missing file itself */
    }
    if (size > totalmem() * 0.8) {
      throw new CoreError('UNAVAILABLE', `${model.name} needs about ${Math.ceil(size / 1e9)} GB of memory, more than this computer can spare (${Math.round(totalmem() / 1e9)} GB in total). Choose a smaller model.`);
    }
    if (size + 1.5e9 > freemem()) this.d.log.warn('Little free memory for the local model; the computer may slow down while it loads', { modelGB: +(size / 1e9).toFixed(1), freeGB: +(freemem() / 1e9).toFixed(1) });
    const plan = resourcePlan(this.d.settings.get().ai.resources);

    this.apiKeyValue = randomBytes(24).toString('base64url');
    const args = [
      '--model', model.file,
      '--host', '127.0.0.1',
      '--port', String(s.port),
      '--ctx-size', String(s.contextSize),
      '--n-gpu-layers', String(s.gpuLayers < 0 ? 999 : s.gpuLayers),
      '--jinja',
      '--alias', model.id,
      '--api-key', this.apiKeyValue,
      '--threads', String(s.threads > 0 ? s.threads : plan.threads),
      // One conversation at a time: the whole context goes to it and the memory for extra slots is not reserved.
      '--parallel', '1',
    ];
    this.stopping = false;
    this.recentOutput = [];
    this.setState('starting', `Loading ${model.name}…`);
    this.d.log.info('Starting local runtime', { binary, model: model.id, port: s.port });
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    // Below-normal priority keeps the desktop responsive while the model thinks.
    if (child.pid) {
      try {
        setPriority(child.pid, plan.priority);
      } catch {
        /* not permitted here; runs at normal priority */
      }
    }
    const capture = (b: Buffer) => {
      for (const line of b.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.recentOutput.push(line.replace(this.apiKeyValue, '***'));
        if (this.recentOutput.length > 200) this.recentOutput.shift();
      }
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) this.setState('stopped');
      else {
        const tail = this.recentOutput.slice(-5).join(' | ');
        this.d.log.error('Local runtime exited unexpectedly', { code, signal, tail });
        this.setState('failed', `Runtime exited (${code ?? signal}). ${tail}`.slice(0, 500));
      }
    });
    child.on('error', (err) => {
      this.d.log.error('Local runtime failed to spawn', err);
      this.setState('failed', err.message);
    });

    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (!this.child) break;
      try {
        const res = await fetch(`http://127.0.0.1:${s.port}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          this.setState('running');
          this.lastUsed = Date.now();
          this.watchIdle();
          this.d.log.info('Local runtime ready', { model: model.id, threads: s.threads > 0 ? s.threads : plan.threads });
          return this.status();
        }
      } catch {
        /* still loading */
      }
      await sleep(750);
    }
    if (this.child) {
      await this.stop();
      this.setState('failed', 'Runtime did not become ready within 3 minutes');
    }
    throw new CoreError('UNAVAILABLE', this.message ?? 'Runtime failed to start');
  }

  /** Unloads the model after the configured idle time, so the memory goes back to the computer. */
  private watchIdle(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      const mins = this.d.settings.get().runtime.idleStopMinutes;
      if (this.state !== 'running' || this.active > 0 || mins <= 0) return;
      if (Date.now() - this.lastUsed < mins * 60_000) return;
      this.d.log.info('Unloading the idle local model', { idleMinutes: mins });
      void this.stop(`Unloaded after ${mins} idle minutes to free memory. It starts again with the next question.`);
    }, 60_000);
    this.idleTimer.unref?.();
  }

  async stop(message: string | null = null): Promise<RuntimeStatus> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    const child = this.child;
    if (!child) {
      if (this.state !== 'stopped') this.setState('stopped', message);
      return this.status();
    }
    this.stopping = true;
    child.kill('SIGTERM');
    const exited = await Promise.race([new Promise<boolean>((r) => child.once('exit', () => r(true))), sleep(5000).then(() => false)]);
    if (!exited) child.kill('SIGKILL');
    this.child = null;
    this.setState('stopped', message);
    return this.status();
  }

  async health(): Promise<{ ok: boolean; message: string | null }> {
    if (this.state !== 'running') return { ok: this.state !== 'failed', message: this.message };
    try {
      const res = await fetch(`http://127.0.0.1:${this.d.settings.get().runtime.port}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok ? { ok: true, message: null } : { ok: false, message: `Health check returned ${res.status}` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  private installing: AbortController | null = null;

  /** Downloads the official llama.cpp runtime into the data folder (for builds that did not bundle it). */
  install(): void {
    if (this.installing) throw new CoreError('CONFLICT', 'The runtime is already being installed');
    const controller = new AbortController();
    this.installing = controller;
    const emit = (p: { receivedBytes: number; totalBytes: number; state: 'downloading' | 'verifying' | 'completed' | 'failed' | 'cancelled'; error?: string }) =>
      this.d.events?.emit('runtime.download', { modelId: 'llama-runtime', ...p });
    emit({ receivedBytes: 0, totalBytes: 0, state: 'downloading' });
    void gpuVariant()
      .then((variant) => {
        this.d.log.info('Installing the local runtime', { variant });
        return installLlamaRuntime({
          destDir: this.d.runtimeDir,
          githubToken: process.env.GITHUB_TOKEN,
          variant,
      signal: controller.signal,
          onProgress: (received, total, phase) => emit({ receivedBytes: received, totalBytes: total, state: phase === 'extracting' ? 'verifying' : 'downloading' }),
        });
      })
      .then((r) => {
        this.d.log.info('Local runtime installed', r);
        emit({ receivedBytes: 1, totalBytes: 1, state: 'completed' });
        this.setState('stopped');
      })
      .catch((err: Error) => {
        this.d.log.error('Runtime install failed', { error: err.message });
        emit({ receivedBytes: 0, totalBytes: 0, state: controller.signal.aborted ? 'cancelled' : 'failed', error: err.message });
      })
      .finally(() => (this.installing = null));
  }

  cancelInstall(): boolean {
    this.installing?.abort();
    return !!this.installing;
  }

  get isRunning() {
    return this.state === 'running';
  }

  recentLogs(): string[] {
    return [...this.recentOutput];
  }
}
