/**
 * FBRX's notification sound: a short, soft bell made with the Web Audio API (no sound files). Its first two notes, a
 * rising fifth, are FBRX's; warnings fall instead of rising, errors knock twice, and good news finishes the chord.
 */

type Level = 'info' | 'success' | 'warning' | 'error';
/** [frequency (Hz), start (s), length (s), loudness 0–1] */
type Note = [number, number, number, number];

const D6 = 1174.66;
const E6 = 1318.51;
const FS6 = 1479.98;
const A6 = 1760;
const B5 = 987.77;

export const CHIMES: Record<Level, Note[]> = {
  info: [
    [D6, 0, 0.55, 0.8],
    [A6, 0.09, 0.8, 0.7],
  ],
  success: [
    [D6, 0, 0.45, 0.7],
    [FS6, 0.08, 0.45, 0.65],
    [A6, 0.16, 0.9, 0.7],
  ],
  warning: [
    [A6, 0, 0.5, 0.8],
    [E6, 0.11, 0.8, 0.8],
  ],
  error: [
    [E6, 0, 0.28, 0.9],
    [E6, 0.13, 0.28, 0.9],
    [B5, 0.27, 0.9, 0.9],
  ],
};

let ctx: AudioContext | null = null;

/** Plays the chime for a notification's level; volume 0–1. */
export function playChime(level: Level = 'info', volume = 0.7): void {
  if (volume <= 0) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    return; // no audio here
  }
  const t0 = ctx.currentTime + 0.02;
  const master = ctx.createGain();
  master.gain.value = Math.min(1, volume) * 0.5;
  // Rounded off at the top, so it rings rather than beeps.
  const soften = ctx.createBiquadFilter();
  soften.type = 'lowpass';
  soften.frequency.value = 5200;
  master.connect(soften).connect(ctx.destination);
  for (const [f, at, len, loud] of CHIMES[level] ?? CHIMES.info) {
    // A bell: the note, and a quieter, quicker overtone a little above two octaves up.
    for (const [mult, part, decay] of [
      [1, 1, len],
      [2.76, 0.18, len * 0.35],
    ] as const) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f * mult;
      const t = t0 + at;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(loud * part, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0008, t + decay);
      osc.connect(g).connect(master);
      osc.start(t);
      osc.stop(t + decay + 0.05);
    }
  }
}
