import { useEffect, useRef, useState } from 'react';

/**
 * A split-flap (Solari) board, like a railway departures board: every cell flips through the alphabet until it
 * reaches its letter, column by column, and the board rotates through its messages. Run the mouse across the
 * flaps and they riffle. Each message is a list of rows; rows are padded or cut to the board's width.
 */

const CHARSET = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:;-+%/°#!?&@()↑↓·';
const STEP_MS = 42;

function fit(rows: string[], cols: number, lines: number): string[] {
  const out: string[] = [];
  for (let r = 0; r < lines; r++) {
    const t = (rows[r] ?? '').toUpperCase().replace(/[^\x20-\x7e↑↓°·]/g, ' ').slice(0, cols);
    const pad = Math.floor((cols - t.length) / 2);
    out.push((' '.repeat(pad) + t).padEnd(cols, ' '));
  }
  return out;
}

const next = (c: string) => {
  const i = CHARSET.indexOf(c);
  return CHARSET[(i + 1) % CHARSET.length];
};

let audio: AudioContext | null = null;
/** A faint mechanical clack (a short burst of filtered noise). */
function clack(volume = 0.035) {
  try {
    audio ??= new AudioContext();
    const ctx = audio;
    const len = Math.floor(ctx.sampleRate * 0.018);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 2400;
    const g = ctx.createGain();
    g.gain.value = volume;
    src.connect(f).connect(g).connect(ctx.destination);
    src.start();
  } catch {
    /* no audio */
  }
}

export function SplitFlapBoard({ messages, cols = 24, lines = 2, intervalMs = 7000, sound = true, onHoverCount }: { messages: string[][]; cols?: number; lines?: number; intervalMs?: number; sound?: boolean; onHoverCount?: (distinctFlapsTouched: number) => void }) {
  const [index, setIndex] = useState(0);
  const cells = cols * lines;
  const [shown, setShown] = useState<string[]>(() => Array(cells).fill(' '));
  const [flipVer, setFlipVer] = useState<number[]>(() => Array(cells).fill(0));
  const prev = useRef<string[]>(Array(cells).fill(' '));
  const shownRef = useRef<string[]>(Array(cells).fill(' '));
  const st = useRef({ target: Array(cells).fill(' ') as string[], riffle: Array(cells).fill(0) as number[], startAt: [] as number[], tick: 0, touched: new Set<number>() });
  const msgs = messages.length ? messages : [['']];
  const current = msgs[index % msgs.length];
  const key = JSON.stringify(current);

  // The stepper only runs while letters are moving; an idle board costs nothing.
  const stepper = useRef<ReturnType<typeof setInterval> | null>(null);
  const step = () => {
    const s = st.current;
    s.tick++;
    const cur = shownRef.current;
    const out = cur.slice();
    const flipped: number[] = [];
    let waiting = false;
    for (let i = 0; i < out.length; i++) {
      if (s.riffle[i] > 0) {
        s.riffle[i]--;
        out[i] = s.riffle[i] === 0 ? (s.target[i] ?? ' ') : CHARSET[1 + Math.floor(Math.random() * (CHARSET.length - 1))];
      } else if (out[i] !== s.target[i]) {
        if (s.tick < (s.startAt[i] ?? 0)) {
          waiting = true;
          continue;
        }
        out[i] = next(out[i]);
      } else continue;
      flipped.push(i);
    }
    if (!flipped.length) {
      if (!waiting && stepper.current) {
        clearInterval(stepper.current);
        stepper.current = null;
      }
      return;
    }
    prev.current = cur;
    shownRef.current = out;
    setShown(out);
    setFlipVer((v) => {
      const n = v.slice();
      for (const i of flipped) n[i]++;
      return n;
    });
  };
  const kick = () => {
    if (!stepper.current) stepper.current = setInterval(step, STEP_MS);
  };
  useEffect(
    () => () => {
      if (stepper.current) clearInterval(stepper.current);
    },
    [],
  );

  // New message: set the targets; each column starts a moment after the one to its left.
  useEffect(() => {
    const s = st.current;
    s.target = fit(current, cols, lines).join('').split('');
    s.tick = 0;
    s.startAt = s.target.map((_, i) => (i % cols) * 0.6 + Math.floor(i / cols) * 2);
    kick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, cols, lines]);

  // Rotate messages, but not while the window is hidden.
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === 'visible' && setIndex((i) => i + 1), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);

  const touch = (i: number) => {
    const s = st.current;
    if (s.riffle[i] > 0) return;
    s.riffle[i] = 3 + Math.floor(Math.random() * 4);
    kick();
    if (sound) clack();
    if (!s.touched.has(i)) {
      s.touched.add(i);
      onHoverCount?.(s.touched.size);
    }
  };

  return (
    <div className="flapboard" role="marquee" aria-label={current.join(' ')} style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {shown.map((ch, i) => (
        <span key={i} className={`flap${ch === ' ' ? ' blank' : ''}`} onMouseEnter={() => touch(i)} aria-hidden>
          <span className="flap-half flap-top">
            <span>{ch}</span>
          </span>
          <span className="flap-half flap-bottom">
            <span>{ch}</span>
          </span>
          {flipVer[i] > 0 && (
            <span key={flipVer[i]} className="flap-half flap-top flap-leaf">
              <span>{prev.current[i] ?? ' '}</span>
            </span>
          )}
        </span>
      ))}
    </div>
  );
}
