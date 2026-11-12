import { useEffect, useRef, useState } from 'react';
import { call } from './client';

/**
 * Easter eggs and Bruce the Goose: a goose in aviator goggles who lives inside the FBRX window and plays hide-and-seek
 * behind its cards and buttons (see bruce.tsx). Everything here is switched off by Settings → Appearance → Fun extras
 * (and an organization can lock that off).
 */

/** The window event that asks Bruce to peek out. */
export const BRUCE_EVENT = 'fbrx:bruce';
export interface BrucePeek {
  /** With a honk (called from Spotlight, the Terminal or Settings). */
  honk?: boolean;
}

/** Asks Bruce to peek out from behind something in this window (he lives in the main window only). */
export function peekBruce(o: BrucePeek = { honk: true }): void {
  window.dispatchEvent(new CustomEvent<BrucePeek>(BRUCE_EVENT, { detail: o }));
}

/** Luke 1:37: typed into Spotlight or the Library search, it answers with the verse (a quiet easter egg). */
export const NOTHING_IS_IMPOSSIBLE = /^\s*nothing\s+is\s+impossible[.!]*\s*$/i;
export const LUKE_1_37 = '“For with God nothing shall be impossible.” Luke 1:37 (King James Version).';

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
  if (now.getMonth() === 3 && now.getDate() === 1) return 'Honk. (Happy April Fools\' Day. Bruce is hiding somewhere.)';
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

// ------------------------------------------------------------------------------------------ Bruce

const GOOSE_W = 120;
const GOOSE_H = 110;

export type Season = 'winter' | 'spring' | 'summer' | 'fall';

/**
 * The season where you are: from the month, flipped for the southern hemisphere (guessed from the time zone, so a
 * goose in Sydney wears his scarf in July).
 */
export function seasonNow(d = new Date(), tz = Intl.DateTimeFormat().resolvedOptions().timeZone): Season {
  const m = d.getMonth();
  const north: Season = m === 11 || m <= 1 ? 'winter' : m <= 4 ? 'spring' : m <= 7 ? 'summer' : 'fall';
  const south = /^(Australia|Antarctica|Pacific\/(Auckland|Chatham|Fiji|Noumea|Tongatapu|Apia)|America\/(Argentina|Santiago|Sao_Paulo|Montevideo|Asuncion|Punta_Arenas)|Africa\/(Johannesburg|Maputo|Harare|Windhoek|Gaborone|Maseru|Mbabane|Lusaka))/.test(tz);
  return south ? ({ winter: 'summer', summer: 'winter', spring: 'fall', fall: 'spring' } as const)[north] : north;
}

/** A knitted scarf around the bottom of the neck, its two ends trailing behind. */
function Scarf({ season }: { season: 'winter' | 'fall' }) {
  const [main, stripe] = season === 'winter' ? ['#c62828', '#f5f5f5'] : ['#d9822b', '#7a4a1e'];
  return (
    <g className="goose-scarf">
      <g className="goose-scarf-tails">
        <path d="M33 41 L42 52 L38.5 54.5 L30.5 43 Z" fill={main} />
        <path d="M34.8 43.5 L37.5 47 M37.2 46.6 L40 50.2" stroke={stripe} strokeWidth="1.6" />
        <path d="M38.5 54.5 l-0.6 2.2 M40 53.4 l0.4 2.3 M41.4 52.2 l1.2 1.9" stroke={main} strokeWidth="0.9" strokeLinecap="round" />
        <path d="M32 42 L45 46 L44 49.6 L30.8 45 Z" fill={main} opacity="0.92" />
      </g>
      <path d="M23.5 38.5 Q30 43.5 36.2 38.6" stroke={main} strokeWidth="5.6" strokeLinecap="round" fill="none" />
      <path d="M25.2 38.8 l1.6 2.4 M29 40.4 l0.9 2.3 M32.8 40.2 l0.4 2.4" stroke={stripe} strokeWidth="1.3" strokeLinecap="round" />
    </g>
  );
}

/** Little snow boots with a fluffy cuff, drawn over a foot. */
function Boot({ x, dark }: { x: number; dark?: boolean }) {
  return (
    <g>
      <path d={`M${x - 3.2} 69 h6.8 v6.6 q0 3.2 -3 3.2 h-8.6 q-2.4 0 -2.4 -2.2 q0 -2.3 3 -2.6 h4.2 z`} fill={dark ? '#24493f' : '#2f5d50'} />
      <rect x={x - 3.8} y={67.2} width={8} height={3.4} rx={1.7} fill="#efe7d4" />
    </g>
  );
}

/** A small leaf that blew onto his back. */
function Leaf() {
  return (
    <g transform="translate(62 35) rotate(24)">
      <path d="M0 0 q4 -6 8 0 q-4 6 -8 0 z" fill="#c8551d" />
      <path d="M-1.5 0 h9" stroke="#8a3a12" strokeWidth="0.6" />
    </g>
  );
}

/**
 * A blink every two to six seconds, now and then a double one; none when the person asked for less motion.
 */
function useBlink(): boolean {
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    if (document.documentElement.dataset.motion === 'reduce') return;
    let t = 0;
    const shut = (ms: number, then: () => void) => {
      setClosed(true);
      t = window.setTimeout(() => {
        setClosed(false);
        then();
      }, ms);
    };
    const next = () => {
      t = window.setTimeout(() => shut(130, () => (Math.random() < 0.22 ? (t = window.setTimeout(() => shut(110, next), 170)) : next())), 2000 + Math.random() * 4000);
    };
    next();
    return () => clearTimeout(t);
  }, []);
  return closed;
}

/** Bruce, his body drawn facing left; his head turned to look at you (`look` front) or in profile (side). Aviator goggles pushed up on his head, dressed for the season; once every trophy is
 * found he carries a golden egg with a #1 ribbon on his back. `flipped` keeps the ribbon's text readable. */
export function GooseSvg({ walking, honking, golden = false, flipped = false, fast = false, season = null, look = 'front' }: { walking: boolean; honking: boolean; golden?: boolean; flipped?: boolean; fast?: boolean; season?: Season | null; look?: 'front' | 'side' }) {
  const winter = season === 'winter';
  const front = look === 'front';
  const blinking = useBlink();
  return (
    <svg width={GOOSE_W} height={GOOSE_H} viewBox="0 0 92 84" overflow="visible" className={`goose-svg${walking ? ' walking' : ''}${fast ? ' fast' : ''}`} aria-hidden>
      <defs>
        <radialGradient id="goose-gold" cx="35%" cy="30%" r="75%">
          <stop offset="0" stopColor="#fff3b0" />
          <stop offset="0.45" stopColor="#ffd34d" />
          <stop offset="1" stopColor="#b8860b" />
        </radialGradient>
        <radialGradient id="goose-lens" cx="35%" cy="30%" r="80%">
          <stop offset="0" stopColor="#e6f7ff" />
          <stop offset="0.6" stopColor="#8fcbe8" />
          <stop offset="1" stopColor="#4a86a8" />
        </radialGradient>
      </defs>
      <g className="goose-leg goose-leg-a">
        <path d="M44 62 L44 76" stroke="#f08c00" strokeWidth="3.5" strokeLinecap="round" />
        {winter ? <Boot x={44} /> : <path d="M44 76 L36 79 L46 80 Z" fill="#f08c00" />}
      </g>
      <g className="goose-leg goose-leg-b">
        <path d="M54 62 L54 76" stroke="#e07b00" strokeWidth="3.5" strokeLinecap="round" />
        {winter ? <Boot x={54} dark /> : <path d="M54 76 L46 79 L56 80 Z" fill="#e07b00" />}
      </g>
      <ellipse cx="50" cy="50" rx="27" ry="16" fill="#f7f7f2" stroke="#cfcfc6" strokeWidth="1.5" />
      <path d="M72 44 Q84 40 80 52 Q76 50 72 52 Z" fill="#ececE4" stroke="#cfcfc6" strokeWidth="1.2" />
      <path d="M44 48 Q52 40 62 46" stroke="#d9d9d0" strokeWidth="2" fill="none" />
      {season === 'fall' && <Leaf />}
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
        <path d="M30 46 Q23 33 27 21" stroke="#f7f7f2" strokeWidth="10" strokeLinecap="round" fill="none" />
        <path d="M30 46 Q23 33 27 21" stroke="#cfcfc6" strokeWidth="11.5" strokeLinecap="round" fill="none" opacity="0.35" />
        {(season === 'winter' || season === 'fall') && <Scarf season={season} />}
        {front ? (
          <g key="front" className="goose-head front">
            {/* His head, turned to look straight at you: round, a little big for him, on purpose. */}
            <circle cx="27" cy="13.6" r="10.2" fill="#f7f7f2" stroke="#cfcfc6" strokeWidth="1.2" />
            {/* Flight goggles pushed up on his forehead: the leather strap round his head, two brass-rimmed lenses. */}
            <path d="M17 10.2 Q27 1.6 37 10.2" stroke="#6b4a1f" strokeWidth="2.6" strokeLinecap="round" fill="none" />
            <path d="M17.8 9.4 Q27 1.6 36.2 9.4" stroke="#8a6230" strokeWidth="0.7" strokeLinecap="round" fill="none" />
            <path d="M26 5.4 h2" stroke="#6b4a1f" strokeWidth="1.3" strokeLinecap="round" />
            <circle cx="23" cy="5.4" r="3.1" fill="url(#goose-lens)" stroke="#c9952f" strokeWidth="1.4" />
            <circle cx="31" cy="5.4" r="3.1" fill="url(#goose-lens)" stroke="#b8862b" strokeWidth="1.4" />
            <path d="M21.5 4 l1.1 -0.7 M29.5 4 l1.1 -0.7" stroke="#ffffff" strokeWidth="0.9" strokeLinecap="round" />
            {/* Rosy cheeks. */}
            <ellipse cx="19.9" cy="17" rx="2.1" ry="1.25" fill="#ff8fa3" opacity="0.42" />
            <ellipse cx="34.1" cy="17" rx="2.1" ry="1.25" fill="#ff8fa3" opacity="0.42" />
            {/* His eyes, looking right at you; now and then a blink (two little arcs). */}
            {blinking ? (
              <g className="goose-eyes closed">
                <path d="M21.3 12.9 Q23.2 14.4 25.1 12.9 M28.9 12.9 Q30.8 14.4 32.7 12.9" stroke="#1b1b1b" strokeWidth="0.95" strokeLinecap="round" fill="none" />
              </g>
            ) : (
              <g className="goose-eyes">
                <ellipse cx="23.2" cy="12.5" rx="1.95" ry="2.45" fill="#1b1b1b" />
                <ellipse cx="30.8" cy="12.5" rx="1.95" ry="2.45" fill="#1b1b1b" />
                <circle cx="22.55" cy="11.5" r="0.78" fill="#ffffff" />
                <circle cx="30.15" cy="11.5" r="0.78" fill="#ffffff" />
                <circle cx="23.75" cy="13.5" r="0.36" fill="#ffffff" />
                <circle cx="31.35" cy="13.5" r="0.36" fill="#ffffff" />
              </g>
            )}
            {/* His beak, seen from the front; a honk opens it. */}
            <g className={honking ? 'goose-beak front open' : 'goose-beak front'}>
              <ellipse className="goose-mouth" cx="27" cy="20.4" rx="2.9" ry="1.5" fill="#6b2412" />
              <path className="goose-jaw" d="M23.7 19.2 Q27 22.2 30.3 19.2 Q29.9 22 27 23 Q24.1 22 23.7 19.2 Z" fill="#d97800" />
              <path d="M22.4 17.2 Q27 15.3 31.6 17.2 Q31.2 19.9 27 20.9 Q22.8 19.9 22.4 17.2 Z" fill="#f08c00" />
              <circle cx="25.7" cy="17.5" r="0.42" fill="#a85a00" />
              <circle cx="28.3" cy="17.5" r="0.42" fill="#a85a00" />
            </g>
          </g>
        ) : (
          <g key="side" className="goose-head side">
            {/* His head in profile, looking off to the side: drawn like his face (the same head, eyes, cheeks, goggles and
                beak), just turned. */}
            <circle cx="27" cy="13.6" r="10.2" fill="#f7f7f2" stroke="#cfcfc6" strokeWidth="1.2" />
            {/* The goggles from the side: the strap round his head, the far lens peeking out behind the near one. */}
            <path d="M18.2 9.6 Q26 1.4 37 10.6" stroke="#6b4a1f" strokeWidth="2.6" strokeLinecap="round" fill="none" />
            <path d="M19 8.9 Q26 1.6 36.2 9.8" stroke="#8a6230" strokeWidth="0.7" strokeLinecap="round" fill="none" />
            <circle cx="19.6" cy="6.3" r="2.5" fill="url(#goose-lens)" stroke="#b8862b" strokeWidth="1.2" />
            <circle cx="23.6" cy="5" r="3.1" fill="url(#goose-lens)" stroke="#c9952f" strokeWidth="1.4" />
            <path d="M22.1 3.6 l1.1 -0.7" stroke="#ffffff" strokeWidth="0.9" strokeLinecap="round" />
            {/* His rosy cheek. */}
            <ellipse cx="23.4" cy="17.2" rx="2.1" ry="1.25" fill="#ff8fa3" opacity="0.42" />
            {/* His eye, the same as when he looks at you; a blink is the same little arc. */}
            {blinking ? (
              <path className="goose-eyes closed" d="M19.6 12.9 Q21.5 14.4 23.4 12.9" stroke="#1b1b1b" strokeWidth="0.95" strokeLinecap="round" fill="none" />
            ) : (
              <g className="goose-eyes">
                <ellipse cx="21.5" cy="12.5" rx="1.95" ry="2.45" fill="#1b1b1b" />
                <circle cx="20.85" cy="11.5" r="0.78" fill="#ffffff" />
                <circle cx="22.05" cy="13.5" r="0.36" fill="#ffffff" />
              </g>
            )}
            {/* His beak from the side: short and round like the front one; a honk drops the lower half. */}
            <g className={honking ? 'goose-beak side open' : 'goose-beak side'}>
              <path className="goose-mouth" d="M17.6 17.6 L11.2 18.2 L17.6 19.4 Z" fill="#6b2412" />
              <path className="goose-jaw" d="M17.8 17.7 C15.2 18.3 12.9 18.5 11 18.3 C12.6 19.9 15.3 20.3 17.8 19.7 Z" fill="#d97800" />
              <path d="M17.8 14.9 C14.7 14.5 11.7 15.3 10.2 17.2 C12.2 18.3 15 18.5 17.9 18.1 Z" fill="#f08c00" />
              <circle cx="15.3" cy="16" r="0.42" fill="#a85a00" />
            </g>
          </g>
        )}
      </g>
    </svg>
  );
}

/** A butterfly that keeps Bruce company in spring. */
export function Butterfly() {
  return (
    <svg className="goose-butterfly" width="22" height="18" viewBox="0 0 22 18" aria-hidden>
      <g className="goose-butterfly-wings">
        <path d="M11 9 Q4 0 1.5 4 Q0 9 11 9 Z M11 9 Q3 16 5 16.5 Q9 17 11 9 Z" fill="#f6a5c0" stroke="#b3416b" strokeWidth="0.7" />
        <path d="M11 9 Q18 0 20.5 4 Q22 9 11 9 Z M11 9 Q19 16 17 16.5 Q13 17 11 9 Z" fill="#f9c74f" stroke="#b07d12" strokeWidth="0.7" />
      </g>
      <path d="M11 4.5 v9" stroke="#3b2a1a" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/** A beach umbrella for the summer wardrobe. */
function BeachUmbrella() {
  return (
    <svg className="goose-umbrella" width="96" height="104" viewBox="0 0 96 104" aria-hidden>
      <path d="M50 30 L44 100" stroke="#8a6a46" strokeWidth="3" strokeLinecap="round" />
      <path d="M6 34 Q48 -10 92 34 Z" fill="#ffffff" />
      <path d="M6 34 Q14 14 30 7 Q30 22 22 34 Z M49 2 Q58 6 64 12 Q60 26 62 34 L44 34 Q46 16 49 2 Z M78 16 Q88 24 92 34 L76 34 Q80 24 78 16 Z" fill="#e63946" />
      <path d="M6 34 Q48 -10 92 34" stroke="#c22f3a" strokeWidth="1.5" fill="none" />
      <ellipse cx="44" cy="101" rx="16" ry="3" fill="#000" opacity="0.15" />
    </svg>
  );
}

/** Bruce as he is dressed right now, for the Fun extras settings. */
export function BrucePreview({ season, golden = false }: { season: Season; golden?: boolean }) {
  // He looks at you, then off to the side now and then, so both of his looks show.
  const [look, setLook] = useState<'front' | 'side'>('front');
  useEffect(() => {
    const t = window.setInterval(() => setLook((l) => (l === 'front' ? 'side' : 'front')), 3200);
    return () => clearInterval(t);
  }, []);
  return (
    <div className={`goose-preview season-${season}`}>
      <div className="goose-preview-stage">
        {season === 'summer' && <BeachUmbrella />}
        {season === 'spring' && <Butterfly />}
        <GooseSvg walking={false} honking={false} golden={golden} season={season} look={look} />
      </div>
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
