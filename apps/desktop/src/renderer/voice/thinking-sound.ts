/**
 * A soft "thinking" sound while the agent works on something you said: a low, slowly breathing hum with quiet,
 * random data blips on top, made with the Web Audio API (no sound files). Fades in and out.
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let hum: OscillatorNode[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;

const NOTES = [880, 987.77, 1174.66, 1318.51, 1567.98, 1760]; // A minor pentatonic, up high and gentle

function blip() {
  if (!ctx || !master || !running) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  const pan = ctx.createStereoPanner();
  osc.type = Math.random() < 0.7 ? 'sine' : 'triangle';
  osc.frequency.value = NOTES[Math.floor(Math.random() * NOTES.length)] * (Math.random() < 0.15 ? 0.5 : 1);
  pan.pan.value = Math.random() * 1.2 - 0.6;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.35, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.09 + Math.random() * 0.08);
  osc.connect(g).connect(pan).connect(master);
  osc.start(t);
  osc.stop(t + 0.2);
  // Mostly single blips, now and then a quick pair, like data going by.
  const next = Math.random() < 0.2 ? 70 : 180 + Math.random() * 320;
  timer = setTimeout(blip, next);
}

export function startThinkingSound(volume = 0.06): void {
  if (running) return;
  running = true;
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  const t = ctx.currentTime;
  master = ctx.createGain();
  master.gain.setValueAtTime(0, t);
  master.gain.linearRampToValueAtTime(volume, t + 0.8);
  master.connect(ctx.destination);
  // The hum: two quiet, slightly detuned low tones through a soft filter, breathing slowly.
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 700;
  const humGain = ctx.createGain();
  humGain.gain.value = 0.22;
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  lfo.frequency.value = 0.35;
  lfoGain.gain.value = 0.08;
  lfo.connect(lfoGain).connect(humGain.gain);
  hum = [110, 164.81, 110.6].map((f) => {
    const o = ctx!.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    o.connect(filter);
    o.start(t);
    return o;
  });
  filter.connect(humGain).connect(master);
  lfo.start(t);
  hum.push(lfo);
  timer = setTimeout(blip, 450);
}

export function stopThinkingSound(): void {
  if (!running || !ctx || !master) return;
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  const t = ctx.currentTime;
  const m = master;
  m.gain.cancelScheduledValues(t);
  m.gain.setValueAtTime(m.gain.value, t);
  m.gain.linearRampToValueAtTime(0, t + 0.35);
  const oscs = hum;
  hum = [];
  setTimeout(() => {
    oscs.forEach((o) => {
      try {
        o.stop();
      } catch {
        /* already stopped */
      }
    });
    m.disconnect();
  }, 450);
  master = null;
}

export function thinkingSoundPlaying(): boolean {
  return running;
}
