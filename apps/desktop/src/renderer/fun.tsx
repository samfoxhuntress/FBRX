import { useEffect, useRef, useState } from 'react';
import { bridge, call } from './client';

/**
 * Easter eggs and the Silly Goose (a tribute to Desktop Goose by samperson): a goose that waddles across the screen,
 * tracks mud, honks, steals the mouse pointer for a moment and drags in notes. It lives in a transparent,
 * click-through window over the desktop (see the main process) and leaves on its own after a minute and a half.
 * Everything here is switched off by Settings → Appearance → Fun extras (and an organization can lock that off).
 */

export function summonGoose(): void {
  bridge.goose?.('summon');
}

/** Luke 1:37: typed into Spotlight or the Library search, it turns on Advanced mode (a quiet easter egg). */
export const NOTHING_IS_IMPOSSIBLE = /^\s*nothing\s+is\s+impossible[.!]*\s*$/i;
export const LUKE_1_37 = '“For nothing will be impossible with God.” Luke 1:37. Advanced mode is on.';

/** Records a found easter egg for the trophy case. Quiet when Fun extras are off or it was already found. */
export function unlockTrophy(id: string): void {
  void call('fun.unlock', { id }).catch(() => undefined);
}

const KONAMI = ['arrowup', 'arrowup', 'arrowdown', 'arrowdown', 'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a'];
/** The last keys pressed, kept across re-renders so a re-subscription never loses progress. */
const recentKeys: string[] = [];

/** Normalizes a key press: arrows by name (also the old "Up"/"Down" names), letters by key or physical key. */
function keyName(e: KeyboardEvent): string {
  const k = e.key.toLowerCase();
  if (k === 'up' || k === 'down' || k === 'left' || k === 'right') return `arrow${k}`;
  if (k.startsWith('arrow')) return k;
  if (e.code === 'KeyB' || e.code === 'KeyA') return e.code.slice(3).toLowerCase();
  return k;
}

/** Calls `onUnlock` when someone types ↑ ↑ ↓ ↓ ← → ← → B A (anywhere in the window, even in a text box). */
export function useKonami(enabled: boolean, onUnlock: () => void) {
  const cb = useRef(onUnlock);
  cb.current = onUnlock;
  useEffect(() => {
    if (!enabled) return;
    const on = (e: KeyboardEvent) => {
      if (e.repeat) return;
      recentKeys.push(keyName(e));
      if (recentKeys.length > KONAMI.length) recentKeys.shift();
      if (recentKeys.length === KONAMI.length && recentKeys.every((k, i) => k === KONAMI[i])) {
        recentKeys.length = 0;
        cb.current();
      }
    };
    // Capture phase: pages that handle arrow keys themselves (lists, terminals) cannot hide them.
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, [enabled]);
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

/** The goose, drawn facing left. It wears safety goggles (a visual upgrade on the classic), and once every trophy is
 * found it carries a golden egg with a #1 ribbon on its back. `flipped` keeps the ribbon's text readable. */
function GooseSvg({ walking, honking, golden = false, flipped = false, fast = false }: { walking: boolean; honking: boolean; golden?: boolean; flipped?: boolean; fast?: boolean }) {
  return (
    <svg width={GOOSE_W} height={GOOSE_H} viewBox="0 0 92 84" className={`goose-svg${walking ? ' walking' : ''}${fast ? ' fast' : ''}`} aria-hidden>
      <defs>
        <radialGradient id="goose-gold" cx="35%" cy="30%" r="75%">
          <stop offset="0" stopColor="#fff3b0" />
          <stop offset="0.45" stopColor="#ffd34d" />
          <stop offset="1" stopColor="#b8860b" />
        </radialGradient>
      </defs>
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
      {golden && (
        <g className="goose-golden">
          <ellipse cx="57" cy="27.5" rx="6.8" ry="8.6" fill="url(#goose-gold)" stroke="#a87a00" strokeWidth="1" transform="rotate(12 57 27.5)" />
          <path d="M53.5 22.5 q1.5 -2.5 4 -2.5" stroke="#fffbe0" strokeWidth="1.4" strokeLinecap="round" fill="none" />
          <path d="M66 32 l-2.6 9 3-1.8 2.2 2.8 0.6-9.6 z M70 32 l1 9.4 1.6-3 3.2 1.2 -2.6-8.8 z" fill="#c8102e" />
          <circle cx="69" cy="28.5" r="5.6" fill="#ffd34d" stroke="#a87a00" strokeWidth="1" />
          <circle cx="69" cy="28.5" r="4.2" fill="none" stroke="#c8102e" strokeWidth="0.9" strokeDasharray="1.2 0.9" />
          <text x="69" y="30.6" textAnchor="middle" fontSize="5.4" fontWeight="900" fill="#7a5600" fontFamily="system-ui, sans-serif" transform={flipped ? 'translate(138 0) scale(-1 1)' : undefined}>
            #1
          </text>
        </g>
      )}
      <g className="goose-neck">
        <path d="M30 46 Q22 30 26 14" stroke="#f7f7f2" strokeWidth="10" strokeLinecap="round" fill="none" />
        <path d="M30 46 Q22 30 26 14" stroke="#cfcfc6" strokeWidth="11.5" strokeLinecap="round" fill="none" opacity="0.35" />
        <circle cx="27" cy="13" r="8.5" fill="#f7f7f2" stroke="#cfcfc6" strokeWidth="1.2" />
        {/* Safety goggles, seen from the side: one lens over the eye and a strap around the back of the head. */}
        <path d="M26.5 9.6 Q31.5 8.2 35.3 11.6" stroke="#6b4a1f" strokeWidth="2.4" strokeLinecap="round" fill="none" />
        <circle cx="23.6" cy="11" r="3.7" fill="#bfe8ff" fillOpacity="0.85" stroke="#2f2f2f" strokeWidth="1.6" />
        <circle cx="23.4" cy="11.2" r="1.5" fill="#1b1b1b" />
        <path d="M21.6 9.4 l1.4 -1" stroke="#ffffff" strokeWidth="1" strokeLinecap="round" />
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
    /** Velocity in px/ms; the goose eases into and out of every walk instead of snapping to full speed. */
    vx: 0,
    vy: 0,
    facing: 1,
    mode: 'enter' as Mode,
    until: 0,
    walking: false,
    fast: false,
    honking: false,
    bubble: '' as string,
    cursor: { x: -1000, y: -1000 },
    carrying: null as Note | null,
    stolen: null as { x: number; y: number } | null,
    /** The real pointer is being dragged (Windows); otherwise a drawn pointer rides in the beak. */
    realPointer: false,
    lastDrag: 0,
    prints: [] as Print[],
    notes: [] as Note[],
    muddy: true,
    lastPrint: 0,
    printSide: 1,
    clicks: 0,
    started: Date.now(),
    interactive: false,
    leaving: false,
    golden: false,
  });
  const ids = useRef(1);

  useEffect(() => {
    document.documentElement.classList.add('goose-mode');
    const W = () => window.innerWidth;
    const H = () => window.innerHeight;
    const s = st.current;
    // A visit earns the first badge; a goose that found them all wears its golden egg.
    unlockTrophy('goose');
    void call('fun.trophies')
      .then((t) => (s.golden = !!t.unlocked.golden))
      .catch(() => undefined);
    // Enter from a random side.
    const fromLeft = Math.random() < 0.5;
    s.x = fromLeft ? -GOOSE_W : W();
    s.y = H() * (0.35 + Math.random() * 0.4);
    s.tx = W() * (0.25 + Math.random() * 0.5);
    s.ty = s.y + GOOSE_H / 2;
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
    const wander = () => {
      s.mode = 'walk';
      s.tx = 100 + Math.random() * (W() - 200);
      s.ty = 110 + Math.random() * (H() - 220);
    };
    const release = () => {
      if (!s.stolen) return;
      s.stolen = null;
      s.realPointer = false;
      bridge.goose?.('capture', false);
    };
    const pick = () => {
      if (Date.now() - s.started > VISIT_MS || s.leaving) {
        s.mode = 'leave';
        s.tx = s.x < W() / 2 ? -GOOSE_W * 1.5 : W() + GOOSE_W * 1.5;
        s.ty = s.y + GOOSE_H / 2;
        return;
      }
      const r = Math.random();
      if (r < 0.32) wander();
      else if (r < 0.55) s.mode = 'chase';
      else if (r < 0.78 && s.notes.length < 4) {
        s.mode = 'fetch-out';
        s.tx = s.x < W() / 2 ? -GOOSE_W * 1.2 : W() + GOOSE_W * 1.2;
        s.ty = 140 + Math.random() * (H() - 300);
      } else {
        s.mode = 'pause';
        s.until = Date.now() + 1400;
        say(Math.random() < 0.7 ? 'HONK!' : 'honk.');
      }
    };
    /** Where the tip of the beak is, in window coordinates. */
    const beak = () => ({ x: s.facing > 0 ? s.x + GOOSE_W - 7.8 : s.x + 7.8, y: s.y + 18.5 });
    let last = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const dt = Math.min(40, now - last);
      last = now;
      const maxSpeed = s.mode === 'chase' ? 0.34 : s.mode === 'carry' && s.stolen ? 0.3 : s.mode === 'leave' ? 0.22 : 0.15;
      if (s.mode === 'chase') {
        // The pointer is on another screen (or hasn't moved yet): wander instead.
        if (s.cursor.x < 0 || s.cursor.y < 0 || s.cursor.x > W() || s.cursor.y > H()) wander();
        else {
          // Aim so the beak, not the middle of the goose, ends up on the pointer.
          const side = s.cursor.x > s.x + GOOSE_W / 2 ? 1 : -1;
          s.tx = s.cursor.x - side * (GOOSE_W / 2 - 8);
          s.ty = s.cursor.y + GOOSE_H / 2 - 18;
        }
      }
      const cx = s.x + GOOSE_W / 2;
      const cy = s.y + GOOSE_H / 2;
      const dx = s.tx - cx;
      const dy = s.ty - cy;
      const dist = Math.hypot(dx, dy);
      // Steering: ease toward the wanted velocity (about a seventh of a second to change pace), slowing down over
      // the last stretch so it settles instead of stopping dead. Chasing is a lunge: no slowing down.
      let wantX = 0;
      let wantY = 0;
      if (s.mode !== 'pause' && dist > 0.5) {
        const pace = maxSpeed * (s.mode === 'chase' ? 1 : Math.max(0.3, Math.min(1, dist / 80)));
        wantX = (dx / dist) * pace;
        wantY = (dy / dist) * pace;
      }
      const k = 1 - Math.exp(-dt / (s.mode === 'pause' ? 90 : 150));
      s.vx += (wantX - s.vx) * k;
      s.vy += (wantY - s.vy) * k;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      const speed = Math.hypot(s.vx, s.vy);
      s.walking = speed > 0.025;
      s.fast = speed > 0.24;
      // Turn around only when clearly heading the other way, so it doesn't flicker on vertical walks.
      if (s.vx > 0.04) s.facing = 1;
      else if (s.vx < -0.04) s.facing = -1;
      // Muddy footprints for the first part of the visit, spaced by distance walked.
      if (s.muddy && s.walking && now - s.lastPrint > 120 / Math.max(0.6, speed * 6)) {
        s.lastPrint = now;
        s.printSide *= -1;
        const a = Math.atan2(s.vy, s.vx);
        s.prints.push({ id: ids.current++, x: cx + Math.sin(a) * 4 * s.printSide, y: s.y + GOOSE_H - 4 - Math.cos(a) * 3 * s.printSide, a: a * (180 / Math.PI) + 90 });
        if (s.prints.length > 140) s.prints.shift();
      }
      // Holding the pointer: drag the real one along with the beak (about 60 times a second).
      if (s.stolen && s.realPointer && now - s.lastDrag > 15) {
        s.lastDrag = now;
        const b = beak();
        bridge.gooseDrag?.(b.x, b.y);
      }
      if (s.mode === 'pause') {
        if (Date.now() > s.until) pick();
      } else if (dist < (s.mode === 'chase' ? 14 : 6)) {
        if (s.mode === 'chase') {
          // Caught the pointer: take it for a short walk.
          s.mode = 'carry';
          s.stolen = { x: s.cursor.x, y: s.cursor.y };
          s.realPointer = false;
          void Promise.resolve(bridge.goose?.('capture', true)).then((r) => {
            if (s.stolen) s.realPointer = !!(r as { realPointer?: boolean } | undefined)?.realPointer;
          });
          say('MINE.', 1500);
          const dir = Math.random() < 0.5 ? -1 : 1;
          s.tx = Math.max(90, Math.min(W() - 90, cx + dir * (260 + Math.random() * 260)));
          s.ty = Math.max(110, Math.min(H() - 110, cy + (Math.random() - 0.5) * 300));
          setTimeout(() => {
            if (s.stolen) {
              release();
              s.mode = 'pause';
              s.until = Date.now() + 900;
            }
          }, 2200);
        } else if (s.mode === 'carry') {
          if (s.carrying) {
            s.notes.push({ ...s.carrying, x: s.x + (s.facing > 0 ? GOOSE_W - 10 : -150), y: s.y - 20 });
            s.carrying = null;
            say('honk', 900);
          }
          release();
          s.mode = 'pause';
          s.until = Date.now() + 1200;
        } else if (s.mode === 'fetch-out') {
          // Off screen: come back with a note or a portrait.
          const portrait = Math.random() < 0.3;
          s.carrying = { id: ids.current++, x: 0, y: 0, text: portrait ? '' : NOTES[Math.floor(Math.random() * NOTES.length)], kind: portrait ? 'portrait' : 'note' };
          s.mode = 'carry';
          s.tx = W() * (0.2 + Math.random() * 0.6);
          s.ty = H() * (0.25 + Math.random() * 0.5);
        } else if (s.mode === 'leave') {
          cancelAnimationFrame(raf);
          release();
          // Notes it brought stay a little longer so you can read them.
          setTimeout(() => bridge.goose?.('leave'), s.notes.length ? 20_000 : 300);
          return;
        } else {
          if (s.mode === 'enter') say(s.golden ? 'HONK! (#1)' : 'HONK!', 1300);
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
        release();
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
      unlockTrophy('shoo');
    }
    s.mode = 'walk';
    s.tx = s.x < window.innerWidth / 2 ? s.x + 380 : s.x - 260;
    s.ty = s.y + GOOSE_H / 2 + (Math.random() - 0.5) * 200;
  };
  const flipped = s.facing > 0;
  return (
    <div className={`goose-stage${s.stolen && !s.realPointer ? ' stolen' : ''}`}>
      {s.prints.map((p) => (
        <span key={p.id} className="goose-print" style={{ left: p.x, top: p.y, transform: `rotate(${p.a}deg)` }} />
      ))}
      {s.notes.map((n) => (
        <button key={n.id} className={n.kind === 'portrait' ? 'goose-portrait' : 'goose-note'} style={{ left: n.x, top: n.y }} onClick={() => (s.notes = s.notes.filter((x) => x.id !== n.id))} title="Click to put it away">
          {n.kind === 'portrait' ? (
            <>
              <span className="goose-portrait-art">
                <GooseSvg walking={false} honking={false} golden={s.golden} />
              </span>
              <span className="goose-portrait-label">{s.golden ? 'Portrait of the #1 Goose · gold leaf on canvas' : 'Portrait of a Goose · oil on canvas'}</span>
            </>
          ) : (
            n.text
          )}
        </button>
      ))}
      <div className="goose" style={{ transform: `translate3d(${s.x}px, ${s.y}px, 0)` }} onClick={clickGoose}>
        <div className="goose-flip" style={{ transform: `scaleX(${-s.facing})` }}>
          <GooseSvg walking={s.walking} honking={s.honking} golden={s.golden} flipped={flipped} fast={s.fast} />
          {s.carrying && <span className={s.carrying.kind === 'portrait' ? 'goose-carry portrait' : 'goose-carry'}>{s.carrying.kind === 'note' ? '✉' : '🖼'}</span>}
          {s.stolen && !s.realPointer && <span className="goose-stolen-cursor" />}
        </div>
      </div>
      {s.bubble && (
        <div className="goose-bubble" style={{ left: s.x + (s.facing > 0 ? GOOSE_W - 10 : -40), top: s.y - 34 }}>
          {s.bubble}
        </div>
      )}
    </div>
  );
}

/** A chicken: four quick clucks and a big "bagawk" (a nasal square wave through a throat-like filter). */
export function cluck(volume = 0.2): void {
  try {
    audio ??= new AudioContext();
    const ctx = audio;
    const t0 = ctx.currentTime;
    const notes: Array<[number, number, number, number]> = [
      [0, 0.07, 620, 480],
      [0.12, 0.07, 640, 500],
      [0.24, 0.07, 600, 470],
      [0.42, 0.3, 520, 880],
    ];
    for (const [start, dur, f0, f1] of notes) {
      const osc = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(f0, t0 + start);
      osc.frequency.exponentialRampToValueAtTime(f1, t0 + start + dur * 0.6);
      osc.frequency.exponentialRampToValueAtTime(f0 * 0.8, t0 + start + dur);
      filter.type = 'bandpass';
      filter.frequency.value = 1600;
      filter.Q.value = 2.2;
      gain.gain.setValueAtTime(0, t0 + start);
      gain.gain.linearRampToValueAtTime(volume, t0 + start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + start + dur);
      osc.connect(filter).connect(gain).connect(ctx.destination);
      osc.start(t0 + start);
      osc.stop(t0 + start + dur + 0.02);
    }
  } catch {
    /* no audio */
  }
}
