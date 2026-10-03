/// <reference lib="webworker" />
import { AutoTokenizer, StyleTextToSpeech2Model, Tensor, env } from '@huggingface/transformers';
import { Language } from './kokoro/language-en-us.mjs';
import { britishPhonemes, normalizeForSpeech } from './kokoro-text';

/**
 * The natural voices: Kokoro (82M, quantized) turns text into speech in this background worker, on this computer.
 * Text → tidied words → phonemes (CMU dictionary and letter-to-sound rules, via the vendored HeadTTS module) →
 * Kokoro tokens → audio at 24 kHz. Model and voices come from fbrx-voice://models/ (downloaded once by FBRX), the
 * dictionary from the app itself.
 */

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = 'fbrx-voice://models/';
env.useBrowserCache = false;
env.useWasmCache = false;
const wasm = env.backends.onnx.wasm;
if (wasm) {
  wasm.wasmPaths = { mjs: 'fbrx-voice://ort/ort-wasm-simd-threaded.asyncify.mjs', wasm: 'fbrx-voice://ort/ort-wasm-simd-threaded.asyncify.wasm' };
  // A few threads when the app allows shared memory (main/index.ts), leaving a core free for everything else.
  wasm.numThreads = typeof SharedArrayBuffer !== 'undefined' ? Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1)) : 1;
}

const REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const SAMPLE_RATE = 24_000;

type Tokenizer = (text: string, o: { truncation: boolean }) => { input_ids: Tensor };
type Model = (inputs: Record<string, Tensor>) => Promise<{ waveform: Tensor }>;
let loading: Promise<{ model: Model; tokenizer: Tokenizer; lang: Language }> | null = null;

function load() {
  loading ??= (async () => {
    const [model, tokenizer, lang] = await Promise.all([
      StyleTextToSpeech2Model.from_pretrained(REPO, { dtype: 'q8', device: 'wasm' }) as unknown as Promise<Model>,
      AutoTokenizer.from_pretrained(REPO) as unknown as Promise<Tokenizer>,
      loadLanguage(),
    ]);
    return { model, tokenizer, lang };
  })();
  loading.catch(() => (loading = null));
  return loading;
}

async function loadLanguage(): Promise<Language> {
  const res = await fetch('fbrx-voice://assets/en-us.txt.gz');
  if (!res.ok || !res.body) throw new Error('The pronunciation dictionary is missing');
  const text = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text();
  const lang = new Language();
  lang.dictionary = {};
  for (const line of text.split(/\r?\n/)) lang.addToDictionary(line);
  return lang;
}

const styles = new Map<string, Float32Array>();
async function voiceStyle(voice: string): Promise<Float32Array> {
  const hit = styles.get(voice);
  if (hit) return hit;
  if (!/^[a-z]{2}_[a-z]+$/.test(voice)) throw new Error(`Unknown voice ${voice}`);
  const res = await fetch(`fbrx-voice://models/${REPO}/voices/${voice}.bin`);
  if (!res.ok) throw new Error(`The voice ${voice} is not downloaded`);
  const data = new Float32Array(await res.arrayBuffer());
  styles.set(voice, data);
  return data;
}

/** Text to phonemes the way the chosen voice speaks (British voices get British vowels). */
async function phonemes(text: string, voice: string): Promise<string> {
  const { lang } = await load();
  const p = lang.generate(normalizeForSpeech(text)).phonemes.join('');
  return voice.startsWith('b') ? britishPhonemes(p) : p;
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data as { type: 'load' } | { type: 'speak'; id: number; text: string; voice: string; speed: number };
  try {
    if (m.type === 'load') {
      await load();
      postMessage({ type: 'ready' });
      return;
    }
    const { model, tokenizer } = await load();
    const ph = await phonemes(m.text, m.voice);
    const { input_ids } = tokenizer(ph, { truncation: true });
    const tokens = input_ids.dims.at(-1) ?? 2;
    // Each voice holds one style per length of input; pick the one for this sentence.
    const style = await voiceStyle(m.voice);
    const at = 256 * Math.min(Math.max(tokens - 2, 0), 509);
    const started = performance.now();
    const { waveform } = await model({
      input_ids,
      style: new Tensor('float32', style.slice(at, at + 256), [1, 256]),
      speed: new Tensor('float32', [m.speed], [1]),
    });
    const audio = new Float32Array(waveform.data as Float32Array);
    postMessage({ type: 'audio', id: m.id, audio, sampleRate: SAMPLE_RATE, ms: Math.round(performance.now() - started), phonemes: ph }, { transfer: [audio.buffer] });
  } catch (err) {
    postMessage({ type: 'error', id: 'id' in m ? m.id : -1, message: (err as Error)?.message ?? String(err) });
  }
};
