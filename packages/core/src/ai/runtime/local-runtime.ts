import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, constants, existsSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, freemem, setPriority, totalmem } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { graphicsMemory, type DownloadProgress, type RuntimeClosing, type RuntimeHardware, type RuntimeStatus } from '@fbrx/shared';
import { CoreError } from '../../errors';
import type { EventBus } from '../../events';
import type { Logger } from '../../logger';
import type { SettingsService } from '../../settings/settings-service';
import type { ModelManager } from './model-manager';
import { sleep } from '../../util/misc';
import si from 'systeminformation';
import { installLlamaRuntime } from './runtime-installer';
import { resourcePlan } from '../resources';
import { AUTO_CONTEXT_MIN, autoContextSize, fitsOnCard } from './context-size';
import { readGgufInfo } from './gguf';
import { explainLoadFailure, type LoadFailure } from './load-failure';

/** "Every layer": llama.cpp puts as many as the model has on the graphics card. */
const ALL_LAYERS = 999;

const EXE = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

/** The model's process, written down while it runs, so one left behind (FBRX killed or crashed) is stopped next time. */
const PID_FILE = 'llama-server.pid';
/** How long a model is given to stop by itself, then to end once stopped by force, before it counts as stuck. */
export const CLOSE_GRACE_MS = 5000;
export const CLOSE_FORCE_MS = 10_000;

const exited = (c: ChildProcess) => c.exitCode !== null || c.signalCode !== null;

/** Whether a process is still there. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The program a process runs (its path or name), to be sure a written-down pid is still a model and not something else. */
function processProgram(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    // The program, and how it was started (a program run through an interpreter is named by its second word).
    const parts: string[] = [];
    try {
      parts.push(readlinkSync(`/proc/${pid}/exe`));
    } catch {
      /* not readable */
    }
    try {
      parts.push(...readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').slice(0, 2));
    } catch {
      /* gone */
    }
    return Promise.resolve(parts.filter(Boolean).join(' ') || null);
  }
  const [cmd, args] = process.platform === 'win32' ? ['tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']] : ['ps', ['-p', String(pid), '-o', 'command=']];
  return new Promise((resolve) => execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err, out) => resolve(err ? null : String(out).trim() || null)));
}

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
  /** Layers that fit on the graphics card, per model, learned at the last start (automatic layer count only). */
  private readonly gpuFit = new Map<string, number>();
  /** What went wrong at the last start, for the AI models page to offer the right fix. */
  private problem: LoadFailure['kind'] | null = null;
  /** The context window each model got on Auto, worked out from its file and this computer's memory. */
  private autoContext = new Map<string, number>();
  /** Models (or runtimes) that would not load with the compact 8-bit context: they get the full-size one. */
  private fullContext = new Set<string>();
  /** The graphics memory the runtime can use, 0 without a usable card; null until looked up (learnCard). */
  private cardBytes: number | null = null;
  private cardProbe: Promise<number> | null = null;
  /** The model in the process now (during a switch, not the one chosen). */
  private loaded: { id: string; name: string } | null = null;
  /** Closing a model: how far it got, and the close itself (one at a time). */
  private closing: RuntimeClosing | null = null;
  private closingTask: Promise<RuntimeStatus> | null = null;
  private closeTimers: NodeJS.Timeout[] = [];
  /** Ends a close that waits on a model that will not stop (Go on without waiting). */
  private giveUp: (() => void) | null = null;
  /** Every stop starts a new epoch: a load begun before it does not go on. */
  private epoch = 0;
  private startingEpoch = 0;
  /** How long a model is given to stop by itself, then to end once stopped by force (tests shorten them). */
  readonly timing = { graceMs: CLOSE_GRACE_MS, forceMs: CLOSE_FORCE_MS };

  constructor(
    private readonly d: {
      settings: SettingsService;
      models: ModelManager;
      runtimeDir: string;
      resourcesDir: string | null;
      log: Logger;
      events?: EventBus;
      /** FBRX Server's core: a longer context window on Auto. */
      server?: boolean;
    },
  ) {
    // With a model chosen, the graphics card is looked up early: the first question's context window depends on it.
    const s = d.settings.get().runtime;
    if (s.enabled && s.modelId) setTimeout(() => void this.learnCard(), 3000).unref?.();
  }

  /** Looks up the graphics memory the runtime can use, once. */
  private learnCard(): Promise<number> {
    this.cardProbe ??= this.hardware().then(
      (hw) => (this.cardBytes = graphicsMemory(hw)),
      () => (this.cardBytes = 0),
    );
    return this.cardProbe;
  }

  resolveBinary(): string | null {
    const cfg = this.d.settings.get().runtime.binaryPath;
    if (cfg && existsSync(cfg)) return cfg;
    const plat = `${process.platform}-${process.arch}`;
    // One downloaded here (Install or Update the runtime) is newer than the one that came with FBRX.
    const downloaded = findIn(join(this.d.runtimeDir, plat)) ?? findIn(this.d.runtimeDir);
    if (downloaded) return downloaded;
    if (this.d.resourcesDir) {
      const bundled = findIn(join(this.d.resourcesDir, 'runtime', plat)) ?? findIn(join(this.d.resourcesDir, 'runtime'));
      if (bundled) return bundled;
    }
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
      problem: state === 'failed' ? this.problem : null,
      contextSize: model ? this.contextTokens() : null,
      contextAuto: s.contextSize === 0,
      closing: this.closing ? { ...this.closing } : null,
    };
  }

  /** A model is in memory or on its way there (a load under way counts: a switch must stop it too). */
  get loadedOrLoading(): boolean {
    return !!this.child || !!this.starting;
  }

  /** The built-in model's context window in tokens: the setting, or on Auto what the current model gets here. */
  contextTokens(): number {
    const s = this.d.settings.get().runtime;
    if (s.contextSize > 0) return s.contextSize;
    const model = s.modelId ? this.d.models.get(s.modelId) : undefined;
    if (!model) return AUTO_CONTEXT_MIN;
    const known = this.autoContext.get(model.id);
    if (known) return known;
    let size = 0;
    try {
      size = statSync(model.file).size;
    } catch {
      /* not downloaded yet */
    }
    if (this.cardBytes === null) void this.learnCard();
    const auto = autoContextSize({ info: size ? readGgufInfo(model.file) : null, modelBytes: size, totalMem: totalmem(), compact: s.compactContext && !this.fullContext.has(model.id), server: this.d.server, cardBytes: this.card(size, s.gpuLayers < 0 ? (this.gpuFit.get(model.id) ?? ALL_LAYERS) : s.gpuLayers) });
    // Kept once the graphics card is known: until then the memory alone decided.
    if (this.cardBytes !== null) this.autoContext.set(model.id, auto);
    return auto;
  }

  /** The graphics memory the context can use: the card's when all of the model goes there with these layers, else null. */
  private card(modelBytes: number, layers: number): number | null {
    const card = this.cardBytes ?? 0;
    return layers >= ALL_LAYERS && card > 0 && modelBytes > 0 && fitsOnCard(modelBytes, card) ? card : null;
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
    const chosen = this.d.settings.get().runtime.modelId;
    if (this.state === 'running' && this.child && (!chosen || !this.loaded || this.loaded.id === chosen)) return;
    try {
      // Another model still in memory (a switch that did not get to stop it) goes first: one model at a time.
      if (this.child && this.loaded && chosen && this.loaded.id !== chosen) await this.stop();
      await this.start();
      if (this.state !== 'running') throw new CoreError('UNAVAILABLE', this.message ?? 'The local AI runtime did not start');
    } catch (err) {
      this.active = Math.max(0, this.active - 1);
      throw err;
    }
  }

  /** A chat is using the model now (the next one waits its turn). */
  get busy(): boolean {
    return this.active > 0;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    this.lastUsed = Date.now();
  }

  async start(): Promise<RuntimeStatus> {
    if (this.starting) {
      if (this.startingEpoch === this.epoch) return this.starting;
      // A load from before a stop (a switch): it ends, then what is chosen now loads.
      await this.starting.catch(() => undefined);
      return this.start();
    }
    if (this.child && this.state === 'running') return this.status();
    this.startingEpoch = this.epoch;
    this.starting = this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launch(): Promise<RuntimeStatus> {
    // A model still closing lets go of its memory and its port first.
    if (this.closingTask) await this.closingTask.catch(() => undefined);
    const epoch = this.epoch;
    const cancelled = () => new CoreError('CANCELLED', 'The local model was stopped while it was loading');
    const s = this.d.settings.get().runtime;
    if (!s.enabled) throw new CoreError('UNAVAILABLE', 'The local runtime is disabled in settings');
    const binary = this.resolveBinary();
    if (!binary) throw new CoreError('UNAVAILABLE', 'llama-server runtime not found');
    const model = s.modelId ? this.d.models.get(s.modelId) : undefined;
    if (!model) throw new CoreError('UNAVAILABLE', 'No model selected for the local runtime');
    this.problem = null;
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
    // Not a model at all (an error page saved instead, an empty file): say so before the runtime does, less clearly.
    const info = size > 0 ? readGgufInfo(model.file) : null;
    if (size > 0 && !info) return this.fail({ kind: 'damaged', message: `The ${model.name} file is not a usable model (incomplete or damaged). Download it again (AI models → Download again).`, detail: 'not a GGUF file' });
    const plan = resourcePlan(this.d.settings.get().ai.resources);
    const threads = s.threads > 0 ? s.threads : plan.threads;
    let compact = s.compactContext && !this.fullContext.has(model.id);
    await this.learnCard();
    // A model an earlier FBRX left running, or another program on the model's port, would take its place.
    await this.clearLeftover(s.port);
    if (epoch !== this.epoch) throw cancelled();
    const context = (layers: number) => {
      if (s.contextSize > 0) return s.contextSize;
      const auto = autoContextSize({ info, modelBytes: size, totalMem: totalmem(), compact, server: this.d.server, cardBytes: this.card(size, layers) });
      this.autoContext.set(model.id, auto);
      return auto;
    };

    // All of the model on the graphics card when it fits. When it does not, try half of it there, then none, and keep
    // what worked for next time (a manual layer count in Settings is used as it is).
    const auto = s.gpuLayers < 0;
    const first = auto ? (this.gpuFit.get(model.id) ?? ALL_LAYERS) : s.gpuLayers;
    const tries = [first];
    if (auto) {
      if (first >= ALL_LAYERS && info?.blockCount) tries.push(Math.floor(info.blockCount / 2));
      if (first !== 0) tries.push(0);
    }
    for (const [i, layers] of tries.entries()) {
      if (epoch !== this.epoch) throw cancelled();
      this.setState('starting', i === 0 ? `Loading ${model.name}…` : `Loading ${model.name} with ${layers ? 'part of it' : 'none of it'} on the graphics card…`);
      let r = await this.spawnOnce(binary, model, layers, threads, plan.priority, { context: context(layers), compact });
      // Some runtimes and models cannot keep the context in 8 bits: load again with the full-size one, and remember.
      if (compact && typeof r === 'object' && r.kind === 'other' && epoch === this.epoch) {
        this.d.log.warn('The compact context did not load; trying the full-size one', { model: model.id, detail: r.detail });
        compact = false;
        this.fullContext.add(model.id);
        r = await this.spawnOnce(binary, model, layers, threads, plan.priority, { context: context(layers), compact });
      }
      if (r === 'ready') {
        if (auto) this.gpuFit.set(model.id, layers);
        const note =
          auto && layers < ALL_LAYERS && first >= ALL_LAYERS
            ? layers > 0
              ? `${model.name} did not all fit in the graphics card's memory: ${info?.blockCount ? `${layers} of its ${info.blockCount} layers` : 'part of it'} run there and the rest on the processor. Answers come a little slower.`
              : `${model.name} did not fit in the graphics card's memory, so it runs on the processor. Answers come slower; a smaller model would fit on the card.`
            : null;
        this.setState('running', note);
        this.lastUsed = Date.now();
        this.watchIdle();
        this.d.log.info('Local runtime ready', { model: model.id, threads, gpuLayers: layers });
        return this.status();
      }
      if (r === 'stopped' || epoch !== this.epoch) throw cancelled();
      if (r === 'timeout') {
        await this.stop();
        return this.fail({ kind: 'other', message: `${model.name} did not finish loading within 3 minutes.`, detail: this.recentOutput.at(-1) ?? null });
      }
      this.d.log.warn('The local model did not load', { model: model.id, gpuLayers: layers, kind: r.kind, detail: r.detail });
      if (r.kind !== 'gpu-memory' || i === tries.length - 1) return this.fail(r);
    }
    return this.fail({ kind: 'other', message: `${model.name} could not be loaded.`, detail: null });
  }

  private fail(f: LoadFailure): never {
    this.problem = f.kind;
    this.setState('failed', f.detail && f.kind !== 'damaged' ? `${f.message} (${f.detail.slice(0, 200)})` : f.message);
    throw new CoreError('UNAVAILABLE', f.message);
  }

  /** Starts llama-server once and waits until it answers, gives up, or exits (and why). */
  private async spawnOnce(binary: string, model: { id: string; name: string; file: string }, gpuLayers: number, threads: number, priority: number, ctx: { context: number; compact: boolean }): Promise<'ready' | 'timeout' | 'stopped' | LoadFailure> {
    const s = this.d.settings.get().runtime;
    this.apiKeyValue = randomBytes(24).toString('base64url');
    const args = [
      '--model', model.file,
      '--host', '127.0.0.1',
      '--port', String(s.port),
      '--ctx-size', String(ctx.context),
      // The context's memory in 8 bits (flash attention is what lets the values be kept that way): about half the size.
      ...(ctx.compact ? ['--flash-attn', 'on', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0'] : []),
      '--n-gpu-layers', String(gpuLayers),
      '--jinja',
      '--alias', model.id,
      '--api-key', this.apiKeyValue,
      '--threads', String(threads),
      // One conversation at a time: the whole context goes to it and the memory for extra slots is not reserved.
      '--parallel', '1',
      // When the oldest messages drop out of a long chat, what follows them is moved up instead of read again.
      '--cache-reuse', '256',
    ];
    this.stopping = false;
    this.recentOutput = [];
    this.d.log.info('Starting local runtime', { binary, model: model.id, port: s.port, gpuLayers });
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    this.loaded = { id: model.id, name: model.name };
    if (child.pid) this.notePid(child.pid, binary, s.port, model.id);
    let spawnError: string | null = null;
    // Below-normal priority keeps the desktop responsive while the model thinks.
    if (child.pid) {
      try {
        setPriority(child.pid, priority);
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
      this.forgetPid(child.pid);
      if (this.child !== child) return;
      this.child = null;
      this.loaded = null;
      // A close in progress says when it is done.
      if (this.closingTask) return;
      if (this.stopping) this.setState('stopped');
      else if (this.state === 'running') {
        // It stopped on its own after loading: say why, from its last words.
        const tail = this.recentOutput.slice(-5).join(' | ');
        this.d.log.error('Local runtime exited unexpectedly', { code, signal, tail });
        this.setState('failed', `Runtime exited (${code ?? signal}). ${tail}`.slice(0, 500));
      }
    });
    child.on('error', (err) => {
      this.d.log.error('Local runtime failed to spawn', err);
      spawnError = err.message;
      if (this.child === child) {
        this.child = null;
        this.loaded = null;
      }
    });

    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (this.child !== child) {
        if (this.stopping) return 'stopped';
        if (spawnError) return { kind: 'other', message: `The runtime could not start: ${spawnError}`, detail: null };
        // Let the last lines of output arrive before reading them.
        await sleep(200);
        return explainLoadFailure(this.recentOutput, model.name, gpuLayers > 0);
      }
      try {
        const res = await fetch(`http://127.0.0.1:${s.port}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return 'ready';
      } catch {
        /* still loading */
      }
      await sleep(750);
    }
    return 'timeout';
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

  /**
   * Closes the model and waits until it is gone, its memory and its port free: it is asked to stop, and stopped by
   * force when it does not in time (timing.graceMs). A load under way is stopped too. force (Stop it now): no waiting
   * for it to finish what it was writing. A close already under way is the one waited for.
   */
  async stop(message: string | null = null, o: { force?: boolean; why?: 'quit' } = {}): Promise<RuntimeStatus> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    this.epoch++;
    if (this.closingTask) {
      if (o.why && this.closing) this.closing = { ...this.closing, why: o.why };
      if (o.force) this.forceStop();
      else if (o.why) this.emitChanged();
      return this.closingTask;
    }
    const child = this.child;
    if (!child || exited(child)) {
      // A load that has not started its process yet ends at its next step (the epoch moved on).
      this.child = null;
      this.loaded = null;
      if (this.state !== 'stopped') this.setState('stopped', message);
      return this.status();
    }
    this.closingTask = this.close(child, message, !!o.force, o.why ?? null).finally(() => {
      this.closingTask = null;
    });
    return this.closingTask;
  }

  private async close(child: ChildProcess, message: string | null, force: boolean, why: 'quit' | null): Promise<RuntimeStatus> {
    this.stopping = true;
    const at = new Date().toISOString();
    this.closing = { modelName: this.loaded?.name ?? 'The local model', pid: child.pid ?? null, startedAt: at, stage: 'stopping', stageAt: at, graceMs: this.timing.graceMs, forceMs: this.timing.forceMs, forced: false, why };
    this.d.log.info('Closing the local model', { model: this.loaded?.id ?? null, pid: child.pid, force });
    let gaveUp = false;
    const gone = new Promise<void>((resolve) => {
      if (exited(child)) return resolve();
      child.once('exit', () => resolve());
      this.giveUp = () => {
        gaveUp = true;
        resolve();
      };
    });
    if (force) {
      this.closing = { ...this.closing, forced: true };
      this.escalate(child);
    } else {
      this.emitChanged();
      child.kill('SIGTERM');
      this.closeTimers.push(setTimeout(() => this.escalate(child), this.timing.graceMs));
    }
    await gone;
    for (const t of this.closeTimers) clearTimeout(t);
    this.closeTimers = [];
    this.giveUp = null;
    if (gaveUp) {
      // Written down still: the next start stops it.
      this.d.log.warn('Went on without waiting for the local model to close', { pid: child.pid });
    } else this.forgetPid(child.pid);
    if (this.child === child) this.child = null;
    this.loaded = null;
    this.closing = null;
    this.setState('stopped', message);
    return this.status();
  }

  /** Stopped by force: it gets timing.forceMs to end, then counts as stuck (the app offers what else to try). */
  private escalate(child: ChildProcess): void {
    if (!this.closing || exited(child)) return;
    if (this.closing.stage === 'stopping') this.closing = { ...this.closing, stage: 'forcing', stageAt: new Date().toISOString() };
    this.d.log.warn('The local model did not stop in time; stopping it by force', { pid: child.pid });
    child.kill('SIGKILL');
    this.emitChanged();
    if (this.closeTimers.length < 2)
      this.closeTimers.push(
        setTimeout(() => {
          if (!this.closing || exited(child)) return;
          this.closing = { ...this.closing, stage: 'stuck', stageAt: new Date().toISOString() };
          this.d.log.error('The local model does not stop', { pid: child.pid });
          this.emitChanged();
        }, this.timing.forceMs),
      );
  }

  /** Stop it now: no more waiting for the model to finish; its memory is let go at once. Again when it is stuck. */
  forceStop(): RuntimeStatus {
    const child = this.child;
    if (!this.closingTask) {
      if (child && !exited(child)) void this.stop(null, { force: true }).catch(() => undefined);
      return this.status();
    }
    if (this.closing) this.closing = { ...this.closing, forced: true };
    if (child) this.escalate(child);
    return this.status();
  }

  /** Go on without waiting for a model that will not stop (it is stopped at the next start). */
  giveUpClosing(): boolean {
    if (!this.giveUp) return false;
    this.giveUp();
    return true;
  }

  private emitChanged(): void {
    this.d.events?.emit('runtime.changed', this.status());
  }

  private notePid(pid: number, binary: string, port: number, model: string): void {
    try {
      writeFileSync(join(this.d.runtimeDir, PID_FILE), JSON.stringify({ pid, binary, port, model, startedAt: new Date().toISOString() }));
    } catch {
      /* the runtime folder is not writable: nothing to clean up after a crash then */
    }
  }

  private forgetPid(pid: number | undefined): void {
    const file = join(this.d.runtimeDir, PID_FILE);
    try {
      if (pid === undefined || (JSON.parse(readFileSync(file, 'utf8')) as { pid?: number }).pid === pid) rmSync(file, { force: true });
    } catch {
      /* not there */
    }
  }

  /**
   * Before a model loads: one an earlier FBRX left running (FBRX killed or crashed, or a close it went on without) is
   * stopped, and another program answering on the model's port is named instead of being mistaken for the model.
   */
  private async clearLeftover(port: number): Promise<void> {
    const file = join(this.d.runtimeDir, PID_FILE);
    let pid = 0;
    try {
      pid = Number((JSON.parse(readFileSync(file, 'utf8')) as { pid?: number }).pid) || 0;
    } catch {
      /* none written down */
    }
    if (pid && pid !== process.pid && pid !== this.child?.pid && alive(pid)) {
      const program = (await processProgram(pid))?.toLowerCase() ?? '';
      if (program.includes('llama-server')) {
        this.d.log.warn('Stopping a local model an earlier FBRX left running', { pid });
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* gone already */
        }
        for (let i = 0; i < 40 && alive(pid); i++) await sleep(250);
        if (alive(pid)) {
          return this.fail({ kind: 'other', message: `A model an earlier FBRX left running (process ${pid}) does not stop. End "${EXE}" in your task manager, or restart the computer.`, detail: null });
        }
      }
    }
    rmSync(file, { force: true });
    let taken = false;
    try {
      await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      taken = true;
    } catch {
      /* nothing there: the port is free */
    }
    if (taken) {
      this.fail({ kind: 'other', message: `Another program is already using port ${port}, which the built-in model needs (a model started outside FBRX, perhaps). Stop it, or give the runtime another port in its settings.`, detail: null });
    }
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
  /** The runtime's own download, as the model downloads report theirs (kept a few minutes after it ends). */
  private installProgress: { progress: DownloadProgress; at: number } | null = null;

  installState(): DownloadProgress | null {
    const p = this.installProgress;
    if (!p) return null;
    const ended = p.progress.state !== 'downloading' && p.progress.state !== 'verifying';
    return ended && p.at < Date.now() - 10 * 60_000 ? null : p.progress;
  }

  /** Memory and graphics cards, for picking a model that fits. */
  async hardware(): Promise<RuntimeHardware> {
    const gpus = await si
      .graphics()
      .then((g) => g.controllers.filter((c) => (c.vram ?? 0) > 0 || /nvidia|radeon|amd|intel/i.test(`${c.vendor} ${c.model}`)).map((c) => ({ name: [c.vendor, c.model].filter(Boolean).join(' ').trim() || 'Graphics', vramBytes: (c.vram ?? 0) * 1024 * 1024 })))
      .catch(() => []);
    return { memoryBytes: totalmem(), freeMemoryBytes: freemem(), cpus: availableParallelism(), gpus, variant: process.platform === 'darwin' ? 'metal' : await gpuVariant() };
  }

  /** Downloads the official llama.cpp runtime into the data folder (for builds that did not bundle it). */
  install(): void {
    if (this.installing) throw new CoreError('CONFLICT', 'The runtime is already being installed');
    const controller = new AbortController();
    this.installing = controller;
    const emit = (p: { receivedBytes: number; totalBytes: number; state: 'downloading' | 'verifying' | 'completed' | 'failed' | 'cancelled'; error?: string }) => {
      this.installProgress = { progress: { modelId: 'llama-runtime', ...p }, at: Date.now() };
      this.d.events?.emit('runtime.download', { modelId: 'llama-runtime', ...p });
    };
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
