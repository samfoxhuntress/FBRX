/// <reference lib="webworker" />
import { env, pipeline } from '@huggingface/transformers';

/**
 * Speech to text in a background worker, so the app stays smooth while Whisper listens. Everything is local: the
 * engine comes from fbrx-voice://ort/ and the model from fbrx-voice://models/ (downloaded once by FBRX).
 */

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = 'fbrx-voice://models/';
env.useBrowserCache = false;
env.useWasmCache = false;
const wasm = env.backends.onnx.wasm;
if (wasm) {
  wasm.wasmPaths = { mjs: 'fbrx-voice://ort/ort-wasm-simd-threaded.asyncify.mjs', wasm: 'fbrx-voice://ort/ort-wasm-simd-threaded.asyncify.wasm' };
  // No shared memory without cross-origin isolation: one thread, which is plenty for short sentences.
  wasm.numThreads = 1;
}

type Asr = (audio: Float32Array, options?: Record<string, unknown>) => Promise<{ text: string } | Array<{ text: string }>>;
let loaded: { repo: string; asr: Promise<Asr> } | null = null;

function load(repo: string): Promise<Asr> {
  if (loaded?.repo === repo) return loaded.asr;
  const asr = pipeline('automatic-speech-recognition', repo, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: (p: { status: string; file?: string; progress?: number }) => {
      if (p.status === 'progress') postMessage({ type: 'loading', file: p.file, progress: p.progress ?? 0 });
    },
  }) as unknown as Promise<Asr>;
  loaded = { repo, asr };
  asr.catch(() => {
    if (loaded?.asr === asr) loaded = null;
  });
  return asr;
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data as { type: 'load'; repo: string } | { type: 'transcribe'; id: number; repo: string; english: boolean; audio: Float32Array };
  try {
    if (m.type === 'load') {
      await load(m.repo);
      postMessage({ type: 'ready', repo: m.repo });
      return;
    }
    const asr = await load(m.repo);
    // English-only models refuse a language or task; multilingual ones detect the language themselves.
    const opts: Record<string, unknown> = m.english ? {} : { task: 'transcribe' };
    if (m.audio.length > 30 * 16000) Object.assign(opts, { chunk_length_s: 30, stride_length_s: 5 });
    const r = await asr(m.audio, opts);
    const text = (Array.isArray(r) ? r.map((x) => x.text).join(' ') : r.text).trim();
    postMessage({ type: 'result', id: m.id, text });
  } catch (err) {
    postMessage({ type: 'error', id: 'id' in m ? m.id : -1, message: (err as Error)?.message ?? String(err) });
  }
};
