import { useEffect, useState } from 'react';
import { VOICE_MODELS, type Settings, type VoiceModelId } from '@fbrx/shared';
import { bridge } from '../client';

/**
 * Voice: listening (the microphone → Whisper on this computer → text) and speaking (the system's voices, at the
 * chosen words per minute). Nothing is sent anywhere to be transcribed.
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
        ? 'FBRX OS may not use the microphone. Allow it in System Settings → Privacy & Security → Microphone, then try again.'
        : 'FBRX OS may not use the microphone. Turn on "Let desktop apps access your microphone" in Windows Settings → Privacy & security → Microphone.',
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
  if (!speechSupported()) return;
  const voice = pickVoice(s.voiceName);
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
  if (!speechSupported()) return;
  queue = [];
  speechSynthesis.cancel();
  setSpeaking(false);
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
