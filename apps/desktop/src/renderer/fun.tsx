import { useEffect, useRef, useState } from 'react';
import { bridge } from './client';

/**
 * Easter eggs and the Silly Goose (a tribute to Desktop Goose by samperson): a goose that waddles across the screen,
 * tracks mud, honks, steals the mouse pointer for a moment and drags in notes. It lives in a transparent,
 * click-through window over the desktop (see the main process) and leaves on its own after a minute and a half.
 * Everything here is switched off by Settings → Appearance → Fun extras (and an organization can lock that off).
 */

export function summonGoose(): void {
  bridge.goose?.('summon');
}

const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];

/** Calls `onUnlock` when someone types ↑ ↑ ↓ ↓ ← → ← → B A. */
export function useKonami(enabled: boolean, onUnlock: () => void) {
  useEffect(() => {
    if (!enabled) return;
    let i = 0;
    const on = (e: KeyboardEvent) => {
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      i = k === KONAMI[i] ? i + 1 : k === KONAMI[0] ? 1 : 0;
      if (i === KONAMI.length) {
        i = 0;
        onUnlock();
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [enabled, onUnlock]);
}

/** A little line under the dashboard greeting for special moments (null most of the time). */
export function dashboardQuip(o: { uptimeSeconds: number; battery: { percent: number; charging: boolean } | null; now?: Date }): string | null {
  const now = o.now ?? new Date();
  const h = now.getHours();
  if (now.getMonth() === 3 && now.getDate() === 1) return 'Honk. (Happy April Fools\' Day. The goose may drop by.)';
  if (now.getMonth() === 9 && now.getDate() === 31) return 'Spooky reminder: unpatched software is scarier than ghosts.';
  if (o.uptimeSeconds > 14 * 86400) return `Up ${Math.floor(o.uptimeSeconds / 86400)} days. Have you tried turning it off and on again?`;
  if (o.battery && !o.battery.charging && o.battery.percent <= 15) return 'Battery is getting peckish. Snack time (find the charger).';
  if (h < 5) return 'Burning the midnight oil? Fabrix is up too.';
  if (now.getDay() === 5 && h >= 15) return 'It\'s Friday afternoon. Maybe don\'t deploy anything.';
  return null;
}

// ------------------------------------------------------------------------------------------- honk

let audio: AudioContext | null = null;
/** Two short honks, synthesized (a nasal sawtooth through a resonant filter). */
export function honk(volume = 0.22): void {
  try {
    audio ??= new AudioContext();
    const ctx = audio;
    const t0 = ctx.currentTime;
    for (const [start, dur] of [
      [0, 0.16],
      [0.22, 0.24],
    ] as const) {
      const osc = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc2.type = 'square';
      osc.frequency.setValueAtTime(420, t0 + start);
      osc.frequency.exponentialRampToValueAtTime(300, t0 + start + dur);
      osc2.frequency.setValueAtTime(212, t0 + start);
      osc2.frequency.exponentialRampToValueAtTime(150, t0 + start + dur);
      filter.type = 'bandpass';
      filter.frequency.value = 1150;
      filter.Q.value = 3.5;
      gain.gain.setValueAtTime(0, t0 + start);
      gain.gain.linearRampToValueAtTime(volume, t0 + start + 0.02);
      gain.gain.setValueAtTime(volume, t0 + start + dur - 0.05);
      gain.gain.linearRampToValueAtTime(0, t0 + start + dur);
      osc.connect(filter);
      osc2.connect(filter);
      filter.connect(gain).connect(ctx.destination);
      for (const o of [osc, osc2]) {
        o.start(t0 + start);
        o.stop(t0 + start + dur + 0.02);
      }
    }
  } catch {
    /* no audio */
  }
}

// ------------------------------------------------------------------------------------------ goose

const NOTES = [
  'I am a goose. Honk.',
  'Have you backed up today?\n— G',
  'Your files are fine.\nProbably.',
  'Fabrix said I could come in.',
  'This note is legally binding.',
  'Drink some water.\nThen update your drivers.',
  'I ate your Wi-Fi password.\nIt was delicious.',
  'Ctrl+K opens Spotlight.\nYou\'re welcome.',
  'Restart once in a while.\nI do. (It\'s called a nap.)',
  'Honk if you love FBRX.',
  'Peace was never an option.',
  'Strong passwords only.\n"password123" is not one.',
];

const GOOSE_W = 120;
const GOOSE_H = 110;
const VISIT_MS = 95_000;

type Mode = 'enter' | 'walk' | 'chase' | 'carry' | 'fetch-out' | 'fetch-in' | 'pause' | 'leave';
interface Print {
  id: number;
  x: number;
  y: number;
  a: number;
}
interface Note {
  id: number;
  x: number;
  y: number;
  text: string;
  kind: 'note' | 'portrait';
}

function GooseSvg({ walking, honking }: { walking: boolean; honking: boolean }) {
  return (
    <svg width={GOOSE_W} height={GOOSE_H} viewBox="0 0 92 84" className={`goose-svg${walking ? ' walking' : ''}`} aria-hidden>
      <g className="goose-leg goose-leg-a">
        <path d="M44 62 L44 76" stroke="#f08c00" strokeWidth="3.5" strokeLinecap="round" />
        <path d="M44 76 L36 79 L46 80 Z" fill="#f08c00" />
      </g>
      <g className="goose-leg goose-leg-b">
        <path d="M54 62 L54 76" stroke="#e07b00" strokeWidth="3.5" strokeLinecap="round" />
        <path d="M54 76 L46 79 L56 80 Z" fill="#e07b00" />
      </g>
      <ellipse cx="50" cy="50" rx="27" ry="16" fill="#f7f7f2" stroke="#cfcfc6" strokeWidth="1.5" />
      <path d="M72 44 Q84 40 80 52 Q76 50 72 52 Z" fill="#ececE4" stroke="#cfcfc6" strokeWidth="1.2" />
      <path d="M44 48 Q52 40 62 46" stroke="#d9d9d0" strokeWidth="2" fill="none" />
      <g className="goose-neck">
        <path d="M30 46 Q22 30 26 14" stroke="#f7f7f2" strokeWidth="10" strokeLinecap="round" fill="none" />
        <path d="M30 46 Q22 30 26 14" stroke="#cfcfc6" strokeWidth="11.5" strokeLinecap="round" fill="none" opacity="0.35" />
        <circle cx="27" cy="13" r="8.5" fill="#f7f7f2" stroke="#cfcfc6" strokeWidth="1.2" />
        <circle cx="24" cy="11" r="1.7" fill="#1b1b1b" />
        <g className={honking ? 'goose-beak open' : 'goose-beak'}>
          <path d="M19 12 L6 14 L19 16 Z" fill="#f08c00" />
          <path className="goose-jaw" d="M19 15 L8 16.5 L19 18 Z" fill="#d97800" />
        </g>
      </g>
    </svg>
  );
}

/** The goose's own window (route goose-overlay): transparent and click-through except over the goose and notes. */
export function GooseOverlay() {
  const [, force] = useState(0);
  const st = useRef({
    x: -GOOSE_W,
    y: 300,
    tx: 200,
    ty: 300,
    facing: 1,
    mode: 'enter' as Mode,
    until: 0,
    walking: false,
    honking: false,
    bubble: '' as string,
    cursor: { x: -1000, y: -1000 },
    carrying: null as Note | null,
    stolen: null as { x: number; y: number } | null,
    prints: [] as Print[],
    notes: [] as Note[],
    muddy: true,
    lastPrint: 0,
    printSide: 1,
    clicks: 0,
    started: Date.now(),
    interactive: false,
    leaving: false,
  });
  const ids = useRef(1);

  useEffect(() => {
    document.documentElement.classList.add('goose-mode');
    const W = () => window.innerWidth;
    const H = () => window.innerHeight;
    const s = st.current;
    // Enter from a random side.
    const fromLeft = Math.random() < 0.5;
    s.x = fromLeft ? -GOOSE_W : W();
    s.y = H() * (0.35 + Math.random() * 0.4);
    s.tx = W() * (0.25 + Math.random() * 0.5);
    s.ty = s.y;
    s.facing = fromLeft ? 1 : -1;
    const say = (text: string, ms = 1200) => {
      s.bubble = text;
      s.honking = true;
      honk();
      setTimeout(() => {
        s.honking = false;
        s.bubble = '';
      }, ms);
    };
    const pick = () => {
      if (Date.now() - s.started > VISIT_MS || s.leaving) {
        s.mode = 'leave';
        s.tx = s.x < W() / 2 ? -GOOSE_W * 1.5 : W() + GOOSE_W;
        s.ty = s.y;
        return;
      }
      const r = Math.random();
      if (r < 0.32) {
        s.mode = 'walk';
        s.tx = 40 + Math.random() * (W() - 140);
        s.ty = 60 + Math.random() * (H() - 160);
      } else if (r < 0.55) {
        s.mode = 'chase';
      } else if (r < 0.78 && s.notes.length < 4) {
        s.mode = 'fetch-out';
        s.tx = s.x < W() / 2 ? -GOOSE_W * 1.2 : W() + GOOSE_W * 0.2;
        s.ty = 80 + Math.random() * (H() - 260);
      } else {
        s.mode = 'pause';
        s.until = Date.now() + 1400;
        say(Math.random() < 0.7 ? 'HONK!' : 'honk.');
      }
    };
    let last = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const dt = Math.min(50, now - last);
      last = now;
      const speed = s.mode === 'chase' ? 0.32 : s.mode === 'carry' && s.stolen ? 0.36 : 0.17;
      if (s.mode === 'chase') {
        // The pointer is on another screen (or hasn't moved yet): wander instead.
        if (s.cursor.x < 0 || s.cursor.y < 0 || s.cursor.x > W() || s.cursor.y > H()) {
          s.mode = 'walk';
          s.tx = 40 + Math.random() * (W() - 140);
          s.ty = 60 + Math.random() * (H() - 160);
        } else {
          s.tx = s.cursor.x + 6 * s.facing;
          s.ty = s.cursor.y - 18;
        }
      }
      if (s.mode === 'pause') {
        s.walking = false;
        if (Date.now() > s.until) pick();
      } else {
        const dx = s.tx - s.x - GOOSE_W / 2;
        const dy = s.ty - s.y - GOOSE_H / 2;
        const dist = Math.hypot(dx, dy);
        s.walking = dist > 4;
        if (dist > 4) {
          const v = Math.min(dist, speed * dt);
          s.x += (dx / dist) * v;
          s.y += (dy / dist) * v;
          if (Math.abs(dx) > 2) s.facing = dx > 0 ? 1 : -1;
          // Muddy footprints for the first part of the visit.
          if (s.muddy && Date.now() - s.lastPrint > 260) {
            s.lastPrint = Date.now();
            s.printSide *= -1;
            s.prints.push({ id: ids.current++, x: s.x + GOOSE_W / 2 + s.printSide * 4, y: s.y + GOOSE_H - 4, a: Math.atan2(dy, dx) * (180 / Math.PI) + 90 });
            if (s.prints.length > 140) s.prints.shift();
          }
        } else if (s.mode === 'chase') {
          // Caught the pointer: take it for a short walk.
          s.mode = 'carry';
          s.stolen = { x: s.cursor.x, y: s.cursor.y };
          bridge.goose?.('capture', true);
          say('MINE.', 1500);
          s.tx = Math.max(60, Math.min(W() - 60, s.x + (Math.random() < 0.5 ? -1 : 1) * (240 + Math.random() * 260)));
          s.ty = Math.max(60, Math.min(H() - 100, s.y + (Math.random() - 0.5) * 300));
          setTimeout(() => {
            if (s.stolen) {
              s.stolen = null;
              bridge.goose?.('capture', false);
              s.mode = 'pause';
              s.until = Date.now() + 900;
            }
          }, 1900);
        } else if (s.mode === 'carry') {
          if (s.carrying) {
            s.notes.push({ ...s.carrying, x: s.x + (s.facing > 0 ? GOOSE_W - 10 : -150), y: s.y - 20 });
            s.carrying = null;
            say('honk', 900);
          }
          if (s.stolen) {
            s.stolen = null;
            bridge.goose?.('capture', false);
          }
          s.mode = 'pause';
          s.until = Date.now() + 1200;
        } else if (s.mode === 'fetch-out') {
          // Off screen: come back with a note or a portrait.
          const portrait = Math.random() < 0.3;
          s.carrying = { id: ids.current++, x: 0, y: 0, text: portrait ? '' : NOTES[Math.floor(Math.random() * NOTES.length)], kind: portrait ? 'portrait' : 'note' };
          s.mode = 'carry';
          s.tx = W() * (0.2 + Math.random() * 0.6);
          s.ty = H() * (0.2 + Math.random() * 0.55);
        } else if (s.mode === 'leave') {
          cancelAnimationFrame(raf);
          bridge.goose?.('capture', false);
          // Notes it brought stay a little longer so you can read them.
          setTimeout(() => bridge.goose?.('leave'), s.notes.length ? 20_000 : 300);
          return;
        } else {
          if (s.mode === 'enter') say('HONK!', 1300);
          s.mode = 'pause';
          s.until = Date.now() + 700 + Math.random() * 1600;
        }
      }
      if (Date.now() - s.started > 35_000) s.muddy = false;
      force((n) => (n + 1) % 1_000_000);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);

    const hit = (x: number, y: number) => {
      if (x >= s.x && x <= s.x + GOOSE_W && y >= s.y && y <= s.y + GOOSE_H) return true;
      return s.notes.some((n) => x >= n.x && x <= n.x + (n.kind === 'portrait' ? 150 : 170) && y >= n.y && y <= n.y + (n.kind === 'portrait' ? 170 : 140));
    };
    const off = bridge.onGoose?.((e) => {
      if (e.type === 'cursor') {
        s.cursor = { x: e.x, y: e.y };
        const over = hit(e.x, e.y);
        if (over !== s.interactive && !s.stolen) {
          s.interactive = over;
          bridge.goose?.('interactive', over);
        }
      } else if (e.type === 'honk') say('HONK!');
      else if (e.type === 'shoo') {
        s.leaving = true;
        s.notes = [];
        pick();
      }
    });
    return () => {
      cancelAnimationFrame(raf);
      off?.();
    };
  }, []);

  const s = st.current;
  const clickGoose = () => {
    s.clicks++;
    s.bubble = s.clicks >= 3 ? 'Fine. FINE.' : 'HONK?!';
    honk(0.3);
    setTimeout(() => (s.bubble = ''), 1100);
    if (s.clicks >= 3) {
      s.leaving = true;
      s.notes = [];
    }
    s.mode = 'walk';
    s.tx = s.x < window.innerWidth / 2 ? s.x + 320 : s.x - 320;
    s.ty = s.y + (Math.random() - 0.5) * 200;
  };
  return (
    <div className={`goose-stage${s.stolen ? ' stolen' : ''}`}>
      {s.prints.map((p) => (
        <span key={p.id} className="goose-print" style={{ left: p.x, top: p.y, transform: `rotate(${p.a}deg)` }} />
      ))}
      {s.notes.map((n) => (
        <button key={n.id} className={n.kind === 'portrait' ? 'goose-portrait' : 'goose-note'} style={{ left: n.x, top: n.y }} onClick={() => (s.notes = s.notes.filter((x) => x.id !== n.id))} title="Click to put it away">
          {n.kind === 'portrait' ? (
            <>
              <span className="goose-portrait-art">
                <GooseSvg walking={false} honking={false} />
              </span>
              <span className="goose-portrait-label">Portrait of a Goose · oil on canvas</span>
            </>
          ) : (
            n.text
          )}
        </button>
      ))}
      <div className="goose" style={{ left: s.x, top: s.y, transform: `scaleX(${-s.facing})` }} onClick={clickGoose}>
        <GooseSvg walking={s.walking} honking={s.honking} />
        {s.carrying && <span className={s.carrying.kind === 'portrait' ? 'goose-carry portrait' : 'goose-carry'}>{s.carrying.kind === 'note' ? '✉' : '🖼'}</span>}
        {s.stolen && <span className="goose-stolen-cursor" />}
      </div>
      {s.bubble && (
        <div className="goose-bubble" style={{ left: s.x + (s.facing > 0 ? GOOSE_W - 10 : -40), top: s.y - 34 }}>
          {s.bubble}
        </div>
      )}
    </div>
  );
}
