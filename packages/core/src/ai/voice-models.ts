import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { VOICE_MODELS, type VoiceModelId, type VoiceModelStatus } from '@fbrx/shared';
import { CoreError, errorMessage } from '../errors';
import type { EventBus } from '../events';
import type { Logger } from '../logger';

/**
 * Speech recognition models for voice input (Whisper, quantized, run by the desktop app on this computer). They are
 * downloaded once from Hugging Face into `<data>/voice/<repo>/…` and read from there; nothing you say leaves the
 * computer. `FBRX_VOICE_MODEL_BASE` points downloads at a mirror (an internal server, or tests).
 */

export const VOICE_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
] as const;

const MARKER = '.fbrx-complete.json';

export interface VoiceModelsDeps {
  dir: string;
  events: EventBus;
  log: Logger;
  internet: () => boolean;
}

export class VoiceModels {
  private job: { model: VoiceModelId; controller: AbortController } | null = null;

  constructor(private readonly d: VoiceModelsDeps) {}

  get dir(): string {
    return this.d.dir;
  }

  private spec(id: VoiceModelId) {
    const m = VOICE_MODELS.find((x) => x.id === id);
    if (!m) throw new CoreError('INVALID_ARGUMENT', `Unknown voice model ${id}`);
    return m;
  }

  private folder(id: VoiceModelId): string {
    return join(this.d.dir, ...this.spec(id).repo.split('/'));
  }

  installed(id: VoiceModelId): boolean {
    const f = this.folder(id);
    return existsSync(join(f, MARKER)) && VOICE_FILES.every((x) => existsSync(join(f, x)));
  }

  list(): VoiceModelStatus[] {
    return VOICE_MODELS.map((m) => ({ id: m.id, name: m.name, note: m.note, sizeMB: m.sizeMB, english: m.english, installed: this.installed(m.id), downloading: this.job?.model === m.id }));
  }

  /** A file inside the voice folder for the app's model protocol, or null for anything outside it. */
  resolveFile(relative: string): string | null {
    const root = resolve(this.d.dir);
    const full = resolve(root, ...decodeURIComponent(relative).split('/').filter(Boolean));
    return full.startsWith(root + sep) && existsSync(full) ? full : null;
  }

  /** Starts a download in the background; progress and the outcome arrive as voice.download events. */
  install(id: VoiceModelId): void {
    const m = this.spec(id);
    if (this.installed(id)) return;
    if (this.job) throw new CoreError('CONFLICT', 'Another voice model is downloading. Wait for it to finish or cancel it.');
    if (!this.d.internet()) throw new CoreError('POLICY_DENIED', 'Your organization blocks internet access from FBRX OS, so the voice model cannot be downloaded');
    const controller = new AbortController();
    this.job = { model: id, controller };
    const total = m.sizeMB * 1_000_000;
    const emit = (received: number, done: boolean, error: string | null) => this.d.events.emit('voice.download', { model: id, received, total, done, error });
    void (async () => {
      const folder = this.folder(id);
      let received = 0;
      let last = 0;
      try {
        mkdirSync(folder, { recursive: true });
        const base = (process.env.FBRX_VOICE_MODEL_BASE || 'https://huggingface.co').replace(/\/+$/, '');
        for (const file of VOICE_FILES) {
          const target = join(folder, ...file.split('/'));
          if (existsSync(target)) continue;
          mkdirSync(dirname(target), { recursive: true });
          const res = await fetch(`${base}/${m.repo}/resolve/main/${file}`, { signal: controller.signal, redirect: 'follow' });
          if (!res.ok || !res.body) throw new Error(`${file}: HTTP ${res.status}`);
          const part = `${target}.part`;
          const counter = Readable.fromWeb(res.body as never);
          counter.on('data', (c: Buffer) => {
            received += c.length;
            if (Date.now() - last > 250) {
              last = Date.now();
              emit(received, false, null);
            }
          });
          await pipeline(counter, createWriteStream(part), { signal: controller.signal });
          renameSync(part, target);
        }
        writeFileSync(join(folder, MARKER), JSON.stringify({ model: id, repo: m.repo, files: VOICE_FILES, at: new Date().toISOString() }));
        this.d.log.info('Voice model installed', { model: id });
        emit(received || total, true, null);
      } catch (err) {
        const msg = controller.signal.aborted ? 'Download canceled' : `Download failed: ${errorMessage(err)}`;
        this.d.log.warn('Voice model download failed', { model: id, error: errorMessage(err) });
        emit(received, true, msg);
      } finally {
        this.job = null;
      }
    })();
  }

  cancel(): void {
    this.job?.controller.abort();
  }

  remove(id: VoiceModelId): void {
    if (this.job?.model === id) this.job.controller.abort();
    rmSync(this.folder(id), { recursive: true, force: true });
  }

  /** For tests: the marker written after a complete download. */
  static readMarker(folder: string): unknown {
    return JSON.parse(readFileSync(join(folder, MARKER), 'utf8'));
  }
}
