import type { GgufInfo } from './gguf';

/**
 * How long a context window the built-in model gets on Auto: as much as this computer's memory holds after the model
 * itself and room for everything else, never more than the model was trained for. The context's memory (the KV cache)
 * is kept in 8 bits (llama.cpp's q8_0: 34 bytes for 32 values), about half of the 16 bits it would otherwise take.
 * When all of the model runs on the graphics card, so does its context: it gets what the card has left, because a
 * context that does not fit there pushes part of the model off the card, which is slower than a shorter context.
 */

export const AUTO_CONTEXT_MIN = 8192;
export const AUTO_CONTEXT_MAX = 65_536;
/** FBRX Server goes further: it has the memory, and long jobs from the whole mesh land on it. */
export const SERVER_CONTEXT_MAX = 131_072;
/** At most this much memory goes to the context, whatever the computer has. */
const KV_BUDGET_MAX = 8 * 1024 ** 3;
const SERVER_KV_BUDGET_MAX = 32 * 1024 ** 3;
/** Left for the system and the other apps. */
const HEADROOM = 2 * 1024 ** 3;
/** Graphics memory the runtime needs for its own work besides the model and the context. */
const CARD_OVERHEAD = 1024 ** 3;

/** Whether all of a model goes on a graphics card with this much memory (the model plus the runtime's own work). */
export const fitsOnCard = (modelBytes: number, cardBytes: number) => modelBytes * 1.05 + CARD_OVERHEAD <= cardBytes;

/** Bytes of memory one token of context takes, or null when the model file does not say enough to work it out. */
export function kvBytesPerToken(info: GgufInfo | null, compact: boolean): number | null {
  if (!info?.blockCount || !info.headCount) return null;
  const kvHeads = info.headCountKv ?? info.headCount;
  const head = info.embeddingLength ? info.embeddingLength / info.headCount : null;
  const k = info.keyLength ?? head;
  const v = info.valueLength ?? head;
  if (!k || !v) return null;
  return info.blockCount * kvHeads * (k + v) * (compact ? 34 / 32 : 2);
}

/**
 * The context window Auto picks, in tokens: a multiple of 2,048 between 8,192 and 65,536 (131,072 on FBRX Server), or
 * the model's own limit. `cardBytes` is the graphics memory when all of the model runs there, otherwise null.
 */
export function autoContextSize(o: { info: GgufInfo | null; modelBytes: number; totalMem: number; compact: boolean; server?: boolean; cardBytes?: number | null }): number {
  const trained = o.info?.contextLength && o.info.contextLength > 0 ? o.info.contextLength : AUTO_CONTEXT_MAX;
  const ceiling = Math.min(trained, o.server ? SERVER_CONTEXT_MAX : AUTO_CONTEXT_MAX);
  const perToken = kvBytesPerToken(o.info, o.compact);
  if (!perToken) return Math.min(ceiling, AUTO_CONTEXT_MIN);
  const room = o.cardBytes ? o.cardBytes - o.modelBytes * 1.05 - CARD_OVERHEAD : o.totalMem * 0.75 - o.modelBytes - HEADROOM;
  const budget = Math.min(o.server ? SERVER_KV_BUDGET_MAX : KV_BUDGET_MAX, room);
  const fits = Math.floor(budget / perToken / 2048) * 2048;
  return Math.max(Math.min(AUTO_CONTEXT_MIN, ceiling), Math.min(ceiling, fits));
}
