import { useCallback, useEffect, useRef, useState } from 'react';
import { BRUCE_EVENT, Butterfly, GooseSvg, honk, unlockTrophy, type BrucePeek, type Season } from './fun';

/**
 * Bruce the Goose plays hide-and-seek inside the FBRX window. Now and then he peeks out from behind a card or a button
 * (over its top edge, or leaning out at its side, as if he were standing behind it), looks around and ducks back. Click
 * him and he ducks and pops up behind something else; catch him three times and he gives up. He never leaves the
 * window, only peeks into empty space (never over what you are reading), ducks the moment you scroll, and stays hidden
 * while you present.
 */

/** GooseSvg's size, and how its 92×84 drawing maps onto it. */
const W = 120;
const H = 110;
const K = W / 92;
/** Over a top edge: how much of him shows (in the drawing's units), his goggles, head, neck and the top of his back. */
const PEEK = 42;
/** Round a side: his beak, head and the front of his neck and chest. */
const LEAN = 40;
/** Room above his goggles (or past his beak), so nothing of him is clipped. */
const PAD = 4;
const TOP_H = PEEK * K + PAD;
const SIDE_W = LEAN * K + PAD;

/**
 * Where he hides: behind a card (Home's and Dash's tiles too), a button, or anything marked data-bruce, in the page (not
 * the sidebar or top bar).
 */
const HIDING_PLACES = ['.fx-card', '.home-note', '.glass-tile', '.glass-hero', '.fx-btn:not(.icon)', '[data-bruce]'].map((x) => `.fx-content ${x}`).join(', ');

type Side = 'top' | 'left' | 'right';
interface Spot {
  side: Side;
  /** The hole he peeks out of, in the window. Its edge on the card's side is the card's edge. */
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
  /** Facing right instead of left (round a right edge he always faces right). */
  flip: boolean;
  el: Element | null;
}

const shuffle = <T,>(xs: T[]): T[] => {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
  return xs;
};

/** Whether the hole is empty space: the background of something that holds the element he hides behind. */
function clear(x: number, y: number, w: number, h: number, el: Element): boolean {
  for (const fx of [0.1, 0.5, 0.9])
    for (const fy of [0.1, 0.5, 0.92]) {
      const hit = document.elementFromPoint(x + w * fx, y + h * fy);
      if (!hit || !hit.contains(el)) return false;
    }
  return true;
}

/** Whether the element's edge at a point is what you see there, not covered or scrolled away. */
const showing = (el: Element, x: number, y: number) => {
  const hit = document.elementFromPoint(x, y);
  return !!hit && el.contains(hit);
};

/** Over the top edge of a card or button, somewhere along it. */
function topSpot(el: Element, r: DOMRect, area: DOMRect, button: boolean): Spot | null {
  const scale = button ? 0.6 : r.width < 280 ? 0.8 : 1;
  const w = W * scale;
  const h = TOP_H * scale;
  const margin = button ? 6 : 22;
  const minX = r.left + margin;
  const maxX = r.right - margin - w;
  if (maxX < minX || r.top - h < area.top + 6 || r.top + 12 > Math.min(area.bottom, window.innerHeight)) return null;
  const x = minX + Math.random() * (maxX - minX);
  const y = r.top - h;
  if (!showing(el, x + w / 2, r.top + 3) || !clear(x, y, w, h, el)) return null;
  return { side: 'top', x, y, w, h, scale, flip: Math.random() < 0.5, el };
}

/** Round the left or right edge of a card, standing on the same floor as its bottom edge. */
function sideSpot(el: Element, r: DOMRect, area: DOMRect, side: 'left' | 'right'): Spot | null {
  const scale = 0.92;
  const w = SIDE_W * scale;
  const h = H * scale;
  if (r.height < h + 8) return null;
  const x = side === 'left' ? r.left - w : r.right;
  const y = r.bottom - h - 6;
  if (x < area.left + 4 || x + w > Math.min(area.right, window.innerWidth) - 4 || y < area.top + 4 || r.bottom > Math.min(area.bottom, window.innerHeight)) return null;
  if (!showing(el, side === 'left' ? r.left + 3 : r.right - 3, y + h / 2) || !clear(x, y, w, h, el)) return null;
  return { side, x, y, w, h, scale, flip: side === 'right', el };
}

/** A place to peek from: a card most of the time (over it or round its side), a button now and then. Null when none fits. */
function findSpot(avoid: Element | null): Spot | null {
  const content = document.querySelector('.fx-content');
  if (!content) return null;
  const area = content.getBoundingClientRect();
  const all = [...document.querySelectorAll(HIDING_PLACES)].filter((e) => e !== avoid);
  const cards = shuffle(all.filter((e) => !e.classList.contains('fx-btn')));
  const buttons = shuffle(all.filter((e) => e.classList.contains('fx-btn')));
  const order = Math.random() < 0.75 ? [...cards, ...buttons] : [...buttons, ...cards];
  for (const el of order.slice(0, 60)) {
    const r = el.getBoundingClientRect();
    const button = el.classList.contains('fx-btn');
    const tries = button ? [() => topSpot(el, r, area, true)] : shuffle([() => topSpot(el, r, area, false), () => sideSpot(el, r, area, 'left'), () => sideSpot(el, r, area, 'right')]);
    for (const t of tries) {
      const s = t();
      if (s) return s;
    }
  }
  return null;
}

/** When called and nothing fits: over the bottom edge of the window, at the left of the page (toasts are on the right). */
function fallbackSpot(): Spot {
  const area = document.querySelector('.fx-content')?.getBoundingClientRect();
  const scale = 1;
  return { side: 'top', x: (area?.left ?? 0) + 40, y: window.innerHeight - TOP_H * scale, w: W * scale, h: TOP_H * scale, scale, flip: true, el: null };
}

const SPONTANEOUS = ['…', 'peekaboo.', 'honk?', 'just looking.', 'carry on.', 'nice tabs.', 'you didn\'t see me.'];

export function Bruce({ route, visits, golden, season }: { route: string; visits: boolean; golden: boolean; season: Season }) {
  const [spot, setSpot] = useState<Spot | null>(null);
  const [out, setOut] = useState(false);
  const [bubble, setBubble] = useState<string | null>(null);
  /** He looks at you, and now and then turns his head to look off to the side. */
  const [look, setLook] = useState<'front' | 'side'>('front');
  const [feather, setFeather] = useState<{ id: number; x: number; y: number } | null>(null);
  const timers = useRef<number[]>([]);
  const state = useRef({ spot: null as Spot | null, catches: 0, last: null as Element | null, active: Date.now() });
  state.current.spot = spot;

  const later = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  };
  const clearTimers = () => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
  };

  /** Gone at once: no ducking (scrolling, another page, the window resized). */
  const vanish = useCallback(() => {
    clearTimers();
    state.current.catches = 0;
    setOut(false);
    setBubble(null);
    setSpot(null);
  }, []);

  /** Ducks behind his edge, then `then`. */
  const duck = useCallback((then?: () => void) => {
    clearTimers();
    setBubble(null);
    setOut(false);
    later(() => {
      setSpot(null);
      then?.();
    }, 420);
  }, []);

  const peek = useCallback(
    (o: { called: boolean; honk?: boolean; say?: string }) => {
      const s = state.current;
      if (s.spot) {
        // Already out: a honk to say where he is.
        if (o.honk) {
          honk(0.18);
          setBubble('HONK!');
          later(() => setBubble(null), 1200);
        }
        return;
      }
      const found = findSpot(s.last) ?? (o.called ? fallbackSpot() : null);
      if (!found) return;
      s.last = found.el;
      setSpot(found);
      setOut(false);
      setLook(Math.random() < 0.3 ? 'side' : 'front');
      // A look around while he is out: off to the side, then back at you (or the other way round).
      later(() => setLook((l) => (l === 'front' ? 'side' : 'front')), 1700 + Math.random() * 900);
      later(() => setLook('front'), 3600 + Math.random() * 900);
      // Out on the next frames, so the rise is animated.
      requestAnimationFrame(() => requestAnimationFrame(() => setOut(true)));
      const line = o.say ?? (o.honk ? (golden ? 'HONK! (#1)' : 'HONK!') : Math.random() < 0.5 ? SPONTANEOUS[Math.floor(Math.random() * SPONTANEOUS.length)] : null);
      if (line)
        later(() => {
          if (o.honk) honk(0.18);
          setBubble(line);
          later(() => setBubble(null), 1600);
        }, 650);
      // Nobody caught him: he ducks, and the game starts over.
      later(() => duck(() => (s.catches = 0)), o.called ? 8000 : 6500);
    },
    [duck, golden],
  );

  const caught = () => {
    const s = state.current;
    s.catches++;
    clearTimers();
    // Caught: he looks right at you.
    setLook('front');
    honk(0.26);
    if (s.catches === 1) unlockTrophy('goose');
    if (s.catches >= 3) {
      unlockTrophy('shoo');
      setBubble('Fine. FINE. You win.');
      later(() => {
        const sp = state.current.spot;
        if (sp) setFeather({ id: Date.now(), x: sp.x + sp.w / 2, y: sp.y + 10 });
        s.catches = 0;
        duck();
      }, 1300);
      return;
    }
    setBubble(s.catches === 1 ? 'HONK?!' : 'Hey!');
    later(() => duck(() => later(() => peek({ called: true, say: s.catches === 1 ? 'missed me.' : 'over here.' }), 700)), 550);
  };

  // Another page: whatever he hid behind is gone.
  useEffect(() => vanish(), [route, vanish]);

  // Called from Spotlight, the Terminal, Settings or the trophy case.
  useEffect(() => {
    const on = (e: Event) => peek({ called: true, honk: (e as CustomEvent<BrucePeek>).detail?.honk ?? true });
    window.addEventListener(BRUCE_EVENT, on);
    return () => window.removeEventListener(BRUCE_EVENT, on);
  }, [peek]);

  // Anything that moves the page under him: he is gone at once.
  useEffect(() => {
    const gone = () => state.current.spot && vanish();
    window.addEventListener('scroll', gone, true);
    window.addEventListener('resize', gone);
    window.addEventListener('popstate', gone);
    window.addEventListener('hashchange', gone);
    return () => {
      window.removeEventListener('scroll', gone, true);
      window.removeEventListener('resize', gone);
      window.removeEventListener('popstate', gone);
      window.removeEventListener('hashchange', gone);
      clearTimers();
    };
  }, [vanish]);

  // Now and then, on his own: while someone is using FBRX, with nothing open over the page (about every 15 minutes).
  useEffect(() => {
    const s = state.current;
    const busy = () => (s.active = Date.now());
    window.addEventListener('pointermove', busy, { passive: true });
    window.addEventListener('keydown', busy);
    const t = window.setInterval(() => {
      if (!visits || s.spot || document.visibilityState !== 'visible' || !document.hasFocus()) return;
      if (Date.now() - s.active > 60_000 || document.querySelector('.fx-overlay, [role="dialog"]')) return;
      if (Math.random() < 1 / 10) peek({ called: false });
    }, 90_000);
    // April Fools' Day: once, soon after FBRX opens.
    const d = new Date();
    if (d.getMonth() === 3 && d.getDate() === 1) later(() => peek({ called: true, say: 'honk. (happy April 1st.)' }), 20_000);
    return () => {
      clearInterval(t);
      window.removeEventListener('pointermove', busy);
      window.removeEventListener('keydown', busy);
    };
  }, [visits, peek]);

  // Where his head is, for the speech bubble and the butterfly.
  const head = spot
    ? spot.side === 'top'
      ? { x: spot.x + (spot.flip ? W - 27 * K : 27 * K) * spot.scale, y: spot.y }
      : { x: spot.side === 'left' ? spot.x + (27 * K + PAD) * spot.scale : spot.x + spot.w - (27 * K + PAD) * spot.scale, y: spot.y }
    : null;
  // Out of sight: under the hole's bottom edge, or behind the card at its side.
  const hide = spot ? (spot.side === 'top' ? `0px, ${spot.h + 2}px` : spot.side === 'left' ? `${spot.w + 2}px, 0px` : `${-(spot.w + 2)}px, 0px`) : '0px, 0px';
  return (
    <div className="bruce-layer" aria-hidden>
      {spot && (
        <div className="bruce-hole" style={{ left: spot.x, top: spot.y, width: spot.w, height: spot.h }}>
          <div
            className={`bruce side-${spot.side}${out ? ' out' : ''}`}
            style={{ top: spot.side === 'top' ? PAD * spot.scale : 0, left: spot.side === 'right' ? spot.w - W * spot.scale - PAD * spot.scale : spot.side === 'left' ? PAD * spot.scale : 0, width: W * spot.scale, height: H * spot.scale, ['--hide' as string]: hide }}
            onClick={caught}
            title="Bruce"
          >
            <div className="bruce-flip" style={{ transform: spot.flip ? 'scaleX(-1)' : undefined }}>
              <div className="bruce-scale" style={{ transform: `scale(${spot.scale})` }}>
                <GooseSvg walking={false} honking={!!bubble} golden={golden} flipped={spot.flip} season={season} look={look} />
              </div>
            </div>
          </div>
        </div>
      )}
      {head && out && season === 'spring' && (
        <div className="bruce-butterfly" style={{ left: head.x - 6, top: head.y - 12 }}>
          <Butterfly />
        </div>
      )}
      {head && spot && bubble && (
        <div className={`bruce-bubble${spot.flip ? ' right' : ''}`} style={{ left: Math.min(window.innerWidth - 220, Math.max(8, head.x - (spot.flip ? 6 : 18))), top: Math.max(8, head.y - 6) }}>
          {bubble}
        </div>
      )}
      {feather && (
        <svg key={feather.id} className="goose-feather" style={{ left: feather.x, top: feather.y }} width="16" height="28" viewBox="0 0 16 28" onAnimationEnd={() => setFeather(null)}>
          <path d="M8 1 Q15 9 10 20 Q8 24 8 27 Q8 24 6 20 Q1 9 8 1 Z" fill="#fbfbf7" stroke="#cfcfc6" strokeWidth="0.8" />
          <path d="M8 4 V27" stroke="#d9d9d0" strokeWidth="0.7" />
        </svg>
      )}
    </div>
  );
}
