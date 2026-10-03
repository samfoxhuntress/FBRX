import { useEffect, useState } from 'react';
import { NATURAL_PREFIX, VOICE_MODELS, type Settings, type VoiceModelId } from '@fbrx/shared';
import { bridge } from '../client';

/**
 * Voice: listening (the microphone → Whisper on this computer → text) and speaking (the system's voices, or the
 * natural voices made on this computer by Kokoro, at the chosen words per minute). Nothing is sent anywhere.
 */

// ------------------------------------------------------------------------------------------------ listening

let worker: Worker | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let seq = 1;
const pending = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>();
const loadListeners = new Set<(p: { file?: string; progress: number }) => void>();

function getWorker(): Worker {
  if (idleTimer) clearTimeout(idleTimer);
  // The model takes a couple of hundred MB while loaded: let it go after ten quiet minutes.
  idleTimer = setTimeout(() => {
    worker?.terminate();
    worker = null;
  }, 10 * 60_000);
  if (worker) return worker;
  worker = new Worker(new URL('./stt-worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent) => {
    const m = e.data as { type: string; id?: number; text?: string; message?: string; file?: string; progress?: number };
    if (m.type === 'loading') loadListeners.forEach((l) => l({ file: m.file, progress: m.progress ?? 0 }));
    if ((m.type === 'result' || m.type === 'error') && m.id !== undefined) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.type === 'result') p?.resolve(m.text ?? '');
      else p?.reject(new Error(m.message || 'Speech recognition failed'));
    }
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'The speech engine stopped'));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

function modelSpec(id: VoiceModelId) {
  return VOICE_MODELS.find((m) => m.id === id) ?? VOICE_MODELS[1];
}

/** Loads the model ahead of time, so the first transcription doesn't wait for it. */
export function warmUp(model: VoiceModelId): void {
  getWorker().postMessage({ type: 'load', repo: modelSpec(model).repo });
}

export function onModelLoading(cb: (p: { file?: string; progress: number }) => void): () => void {
  loadListeners.add(cb);
  return () => loadListeners.delete(cb);
}

/** Turns 16 kHz mono audio into text. */
export function transcribe(audio: Float32Array, model: VoiceModelId): Promise<string> {
  const spec = modelSpec(model);
  const id = seq++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ type: 'transcribe', id, repo: spec.repo, english: spec.english, audio }, [audio.buffer]);
  });
}

/** Whisper writes these for silence or noise; they are not something you said. */
export function isNoise(text: string): boolean {
  const t = text.trim().toLowerCase();
  return !t || /^[\s.,!?…-]*$/.test(t) || /^[([*]+\s*(blank_audio|silence|music|noise|inaudible|no speech|static)\s*[)\]*]+$/.test(t);
}

export interface Recording {
  /** Stops and returns 16 kHz mono audio (empty when nothing was said). */
  stop(): Promise<Float32Array>;
  cancel(): void;
}

export interface RecordOptions {
  deviceId?: string;
  /** Input level, 0–1, about 20 times a second. */
  onLevel?: (level: number) => void;
  /** Stop by itself after this much silence once speech started (hands-free); 0 = only when told. */
  silenceMs?: number;
  /** Give up if nothing is said for this long. */
  noSpeechMs?: number;
  /** Called when it stopped by itself (silence or the time limit). */
  onAutoStop?: () => void;
  maxMs?: number;
}

export async function micPermission(): Promise<{ granted: boolean; status: string }> {
  const fn = (window.fbrx as unknown as { micAccess?: () => Promise<{ granted: boolean; status: string }> } | undefined)?.micAccess;
  return fn ? fn() : { granted: true, status: 'granted' };
}

export async function record(o: RecordOptions = {}): Promise<Recording> {
  const perm = await micPermission();
  if (!perm.granted) {
    throw new Error(
      bridge.platform === 'darwin'
        ? 'FBRX may not use the microphone. Allow it in System Settings → Privacy & Security → Microphone, then try again.'
        : 'FBRX may not use the microphone. Turn on "Let desktop apps access your microphone" in Windows Settings → Privacy & security → Microphone.',
    );
  }
  const stream = await navigator.mediaDevices
    .getUserMedia({ audio: { deviceId: o.deviceId ? { exact: o.deviceId } : undefined, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    .catch((e: Error) => {
      if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') throw new Error('No microphone was found. Plug one in, or pick another in Settings → Voice.');
      if (e.name === 'NotAllowedError') throw new Error('The microphone is blocked. Check your privacy settings for microphone access.');
      throw e;
    });
  const ctx = new AudioContext();
  await ctx.resume();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  // ScriptProcessor is old but simple and everywhere; 4096 samples is under 0.1 s at 48 kHz.
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  source.connect(analyser);
  source.connect(proc);
  proc.connect(ctx.destination);

  let heard = false;
  let lastVoice = performance.now();
  const started = performance.now();
  let noise = 0.008;
  let finished = false;
  let auto: (() => void) | null = null;
  const buf = new Float32Array(analyser.fftSize);

  proc.onaudioprocess = (e) => {
    if (finished) return;
    const data = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(data));
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    const now = performance.now();
    // A slowly adapting noise floor; speech is well above it.
    if (rms < noise * 2) noise = noise * 0.95 + rms * 0.05;
    if (rms > Math.max(0.015, noise * 3)) {
      heard = true;
      lastVoice = now;
    }
    if (o.silenceMs && heard && now - lastVoice > o.silenceMs) auto?.();
    else if (o.noSpeechMs && !heard && now - started > o.noSpeechMs) auto?.();
    else if (now - started > (o.maxMs ?? 120_000)) auto?.();
  };
  const levelTimer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
    o.onLevel?.(Math.min(1, peak * 2.5));
  }, 50);

  const close = () => {
    finished = true;
    clearInterval(levelTimer);
    proc.onaudioprocess = null;
    try {
      source.disconnect();
      proc.disconnect();
    } catch {
      /* already disconnected */
    }
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };

  const stop = async (): Promise<Float32Array> => {
    if (finished) return new Float32Array(0);
    const rate = ctx.sampleRate;
    close();
    if (!heard) return new Float32Array(0);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const all = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      all.set(c, off);
      off += c.length;
    }
    return resample(all, rate, 16000);
  };
  auto = () => {
    auto = null;
    o.onAutoStop?.();
  };
  return { stop, cancel: close };
}

async function resample(input: Float32Array<ArrayBuffer>, from: number, to: number): Promise<Float32Array> {
  if (from === to) return input;
  const off = new OfflineAudioContext(1, Math.ceil((input.length * to) / from), to);
  const buffer = off.createBuffer(1, input.length, from);
  buffer.copyToChannel(input, 0);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return out.getChannelData(0).slice();
}

// ------------------------------------------------------------------------------------------------- speaking

/** About how many words a minute a system voice says at rate 1. */
const BASE_WPM = 180;

export function speechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => (speechSupported() ? speechSynthesis.getVoices() : []));
  useEffect(() => {
    if (!speechSupported()) return;
    const on = () => setVoices(speechSynthesis.getVoices());
    speechSynthesis.addEventListener('voiceschanged', on);
    on();
    return () => speechSynthesis.removeEventListener('voiceschanged', on);
  }, []);
  return voices;
}

/** The voice to use: the chosen one, else the system's default for your language, else any English voice. */
export function pickVoice(name: string): SpeechSynthesisVoice | null {
  if (!speechSupported()) return null;
  const all = speechSynthesis.getVoices();
  return all.find((v) => v.name === name) ?? all.find((v) => v.default && v.lang.startsWith(navigator.language.slice(0, 2))) ?? all.find((v) => v.lang.startsWith('en')) ?? all[0] ?? null;
}

/**
 * Markdown as it should sound: no code (just a mention that it is on screen), no table pipes, links read by
 * their text, emphasis and headings without their marks.
 */
export function speakable(md: string): string {
  let t = md.replace(/\r\n/g, '\n');
  // Code blocks, including one still being written at the end.
  t = t.replace(/```[\s\S]*?(```|$)/g, (m) => (m.endsWith('```') && m.length > 6 ? ' (The code is on screen.) ' : ' '));
  t = t.replace(/`([^`\n]+)`/g, '$1');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  t = t.replace(/^\s*\|.*\|\s*$/gm, '');
  t = t.replace(/^#{1,6}\s+/gm, '');
  t = t.replace(/^\s*[-*+]\s+/gm, '');
  t = t.replace(/(\*\*|__|\*|_|~~)/g, '');
  t = t.replace(/https?:\/\/\S+/g, 'a link');
  t = t.replace(/\p{Extended_Pictographic}\uFE0F?/gu, '');
  t = t.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n');
  return t.trim();
}

/** Splits text into sentences, so speech starts quickly and long answers don't hit voice engine limits. */
export function sentences(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/(?<=[.!?…:;])\s+|\n+/)) {
    const s = part.trim();
    if (!s) continue;
    // Very long sentences are split at commas.
    if (s.length > 260) out.push(...s.split(/(?<=,)\s+/));
    else out.push(s);
  }
  return out.filter((s) => /[\p{L}\p{N}]/u.test(s));
}

type VoiceSettings = Pick<Settings['voice'], 'voiceName' | 'wpm' | 'pitch'>;

let queue: SpeechSynthesisUtterance[] = [];
const speakingListeners = new Set<(on: boolean) => void>();
let speakingNow = false;
function setSpeaking(on: boolean) {
  if (on === speakingNow) return;
  speakingNow = on;
  speakingListeners.forEach((l) => l(on));
}

export function onSpeaking(cb: (on: boolean) => void): () => void {
  speakingListeners.add(cb);
  return () => speakingListeners.delete(cb);
}

export function isSpeaking(): boolean {
  return speakingNow;
}

/** Adds sentences to what is being said (they are spoken in order). */
export function say(text: string, s: VoiceSettings): void {
  if (s.voiceName.startsWith(NATURAL_PREFIX)) {
    natural.say(text, s.voiceName.slice(NATURAL_PREFIX.length), naturalSpeed(s.wpm), s);
    return;
  }
  systemSay(text, s);
}

function systemSay(text: string, s: VoiceSettings): void {
  if (!speechSupported()) return;
  const voice = pickVoice(s.voiceName.startsWith(NATURAL_PREFIX) ? '' : s.voiceName);
  for (const line of sentences(text)) {
    const u = new SpeechSynthesisUtterance(line);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    u.rate = Math.max(0.5, Math.min(3, s.wpm / BASE_WPM));
    u.pitch = s.pitch;
    const done = () => {
      queue = queue.filter((x) => x !== u);
      if (!queue.length) setSpeaking(false);
    };
    u.onend = done;
    u.onerror = done;
    queue.push(u);
    setSpeaking(true);
    speechSynthesis.speak(u);
  }
}

export function stopSpeaking(): void {
  natural.stop();
  if (speechSupported()) {
    queue = [];
    speechSynthesis.cancel();
  }
  setSpeaking(false);
}

// ------------------------------------------------------------------------------------------- natural voices

/** About how many words a minute the natural voices say at speed 1. */
const NATURAL_WPM = 138;
const naturalSpeed = (wpm: number) => Math.max(0.6, Math.min(2, wpm / NATURAL_WPM));

/**
 * Speaks with the natural voices: sentences are made into audio in the TTS worker one ahead of the one playing, so
 * there is no gap between them. If the voices are not downloaded (or anything fails), the system voice takes over.
 */
class NaturalVoice {
  private worker: Worker | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private seq = 1;
  private waiting = new Map<number, { resolve: (a: { audio: Float32Array; sampleRate: number }) => void; reject: (e: Error) => void }>();
  private lines: string[] = [];
  private gen = 0;
  private running = false;
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private fallback: VoiceSettings | null = null;
  /** For tests and the settings page: the last sentence's synthesis time. */
  lastMs = 0;

  private getWorker(): Worker {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.worker?.terminate();
      this.worker = null;
    }, 10 * 60_000);
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./tts-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; id?: number; audio?: Float32Array; sampleRate?: number; message?: string; ms?: number };
      if (m.id === undefined) return;
      const p = this.waiting.get(m.id);
      this.waiting.delete(m.id);
      if (m.type === 'audio') {
        this.lastMs = m.ms ?? 0;
        p?.resolve({ audio: m.audio!, sampleRate: m.sampleRate! });
      } else p?.reject(new Error(m.message || 'The natural voice failed'));
    };
    w.onerror = (e) => {
      for (const p of this.waiting.values()) p.reject(new Error(e.message || 'The natural voice stopped'));
      this.waiting.clear();
      w.terminate();
      if (this.worker === w) this.worker = null;
    };
    this.worker = w;
    return w;
  }

  /** Loads the model ahead of time. */
  warm(): void {
    this.getWorker().postMessage({ type: 'load' });
  }

  /** Sentences made ahead of time (see prefetch), by voice, speed and text. */
  private ready = new Map<string, Promise<{ audio: Float32Array; sampleRate: number }>>();

  /** Makes a sentence now so it can be said without waiting later (the "I heard you" while you are still talking). */
  prefetch(text: string, voice: string, speed: number): void {
    for (const line of sentences(text)) {
      const key = `${voice}|${speed}|${line}`;
      if (this.ready.has(key)) continue;
      const p = this.synth(line, voice, speed, false);
      p.catch(() => this.ready.delete(key));
      this.ready.set(key, p);
      while (this.ready.size > 6) this.ready.delete(this.ready.keys().next().value!);
    }
  }

  synth(text: string, voice: string, speed: number, useReady = true): Promise<{ audio: Float32Array; sampleRate: number }> {
    const key = `${voice}|${speed}|${text}`;
    const made = useReady ? this.ready.get(key) : undefined;
    if (made) {
      this.ready.delete(key);
      return made;
    }
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.getWorker().postMessage({ type: 'speak', id, text, voice, speed });
    });
  }

  say(text: string, voice: string, speed: number, s: VoiceSettings): void {
    const add = sentences(text);
    if (!add.length) return;
    this.fallback = s;
    this.lines.push(...add);
    setSpeaking(true);
    if (!this.running) void this.pump(voice, speed);
  }

  private async pump(voice: string, speed: number): Promise<void> {
    this.running = true;
    const gen = this.gen;
    try {
      let next = this.lines.length ? this.synth(this.lines.shift()!, voice, speed) : null;
      while (next && gen === this.gen) {
        const clip = await next;
        if (gen !== this.gen) break;
        // Make the following sentence while this one plays.
        next = this.lines.length ? this.synth(this.lines.shift()!, voice, speed) : null;
        await this.play(clip);
        // Sentences that arrived while this one played.
        if (!next && this.lines.length && gen === this.gen) next = this.synth(this.lines.shift()!, voice, speed);
      }
    } catch (err) {
      console.warn('Natural voice failed; using the system voice', err);
      const rest = this.lines.splice(0);
      if (gen === this.gen && this.fallback && rest.length) systemSay(rest.join(' '), { ...this.fallback, voiceName: '' });
    } finally {
      this.running = false;
      if (gen === this.gen && !this.lines.length && !queue.length) setSpeaking(false);
    }
  }

  private play(clip: { audio: Float32Array; sampleRate: number }): Promise<void> {
    this.ctx ??= new AudioContext();
    const ctx = this.ctx;
    if (ctx.state === 'suspended') void ctx.resume();
    const buf = ctx.createBuffer(1, clip.audio.length, clip.sampleRate);
    buf.copyToChannel(clip.audio as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    this.source = src;
    return new Promise((resolve) => {
      src.onended = () => {
        if (this.source === src) this.source = null;
        resolve();
      };
      src.start();
    });
  }

  stop(): void {
    this.gen++;
    this.lines = [];
    try {
      this.source?.stop();
    } catch {
      /* already ended */
    }
    this.source = null;
  }
}

const natural = new NaturalVoice();

/** Prepares what will be said next with a natural voice, so it starts without a pause (system voices need nothing). */
export function prefetchSpeech(text: string, s: VoiceSettings): void {
  if (s.voiceName.startsWith(NATURAL_PREFIX)) natural.prefetch(text, s.voiceName.slice(NATURAL_PREFIX.length), naturalSpeed(s.wpm));
}

/** Loads the natural voice model ahead of time (when one is chosen), so the first reply doesn't wait. */
export function warmNaturalVoice(): void {
  natural.warm();
}

/** Makes one sentence with a natural voice and says how long that took (for the settings page). */
export function naturalSample(text: string, voice: string, wpm: number) {
  return natural.synth(text, voice, naturalSpeed(wpm));
}

/**
 * Reads a reply aloud while it streams in: complete sentences are spoken as soon as they arrive, the rest when the
 * message is finished.
 */
export class StreamReader {
  private spoken = 0;

  constructor(private readonly settings: () => VoiceSettings) {}

  /** The message so far. */
  update(markdown: string): void {
    const text = speakable(markdown);
    const rest = text.slice(this.spoken);
    const end = Math.max(rest.lastIndexOf('. '), rest.lastIndexOf('! '), rest.lastIndexOf('? '), rest.lastIndexOf('\n'));
    if (end < 0) return;
    say(rest.slice(0, end + 1), this.settings());
    this.spoken += end + 1;
  }

  /** The finished message. */
  finish(markdown: string): void {
    const text = speakable(markdown);
    if (text.length > this.spoken) say(text.slice(this.spoken), this.settings());
    this.spoken = 0;
  }

  reset(): void {
    this.spoken = 0;
  }
}

// For FBRX's end-to-end tests: make a sentence with a natural voice and write it down again with Whisper.
(globalThis as { __fbrxVoiceCheck?: unknown }).__fbrxVoiceCheck = async (text: string, voice: string, wpm: number, model: VoiceModelId) => {
  const started = performance.now();
  const clip = await naturalSample(text, voice, wpm);
  const ms = performance.now() - started;
  const heard = await transcribe(await resample(clip.audio as Float32Array<ArrayBuffer>, clip.sampleRate, 16_000), model);
  return { heard, seconds: clip.audio.length / clip.sampleRate, ms };
};
