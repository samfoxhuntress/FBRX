/**
 * Scenes for image.compose: a backdrop and pieces of FBRX's own art (characters, what they wear and hold, scenery),
 * placed by name and position and drawn here as SVG. A model on a laptop cannot draw a knight or a castle freehand, but
 * it can say where they go; the drawing is FBRX's, in one storybook style: outlined, shaded, with soft shadows.
 *
 * Every piece is drawn in a 100-unit box standing on its bottom edge, facing right. Characters say where their hands
 * and the top of their head are, so what they hold and wear lands there and scales with them.
 */

export const SCENE_BACKDROPS = ['day', 'sunset', 'night', 'forest', 'sea', 'desert', 'snow', 'space', 'hall', 'plain'] as const;
export type SceneBackdrop = (typeof SCENE_BACKDROPS)[number];
export const SCENE_SHAPES = { wide: [1600, 1000], square: [1200, 1200], tall: [1000, 1400] } as const;
export type SceneShape = keyof typeof SCENE_SHAPES;

export interface SceneItem {
  /** A character (CHARACTERS) or a piece of scenery (SCENERY). */
  part: string;
  /** Where it stands, in percent: across from the left, and down from the top (its feet; the sky is near 0). */
  x: number;
  y?: number;
  /** Its height, in percent of the picture's height. */
  size?: number;
  /** Face left instead of right. */
  flip?: boolean;
  /** Its main color (a name such as brown, or #rrggbb), and a second one for trim, hats and what it holds. */
  color?: string;
  accent?: string;
  /** A character's hat or hood, and what it holds (front hand first). */
  wear?: string;
  hold?: string[];
  /** A name shown under it. */
  label?: string;
}

export interface Scene {
  backdrop: SceneBackdrop;
  shape?: SceneShape;
  title?: string;
  caption?: string;
  items: SceneItem[];
}

// ------------------------------------------------------------------------------------------------------------ colors

const NAMED: Record<string, string> = {
  red: '#d9534f', crimson: '#b8323a', orange: '#f08a3c', yellow: '#f2c84b', gold: '#e3b23c', green: '#4caf6a', olive: '#7d8f3a', teal: '#2fa3a0',
  blue: '#4a7fd4', navy: '#2c3e7a', sky: '#7cc6f2', purple: '#8a5cc7', violet: '#a77be0', pink: '#ec8fb3', brown: '#8a5a3b', mud: '#6e5435',
  tan: '#c9a27a', beige: '#e6d3b3', gray: '#8f969e', grey: '#8f969e', silver: '#c4ccd4', black: '#3a3d42', white: '#f4f4f2',
};

function hex(c: string | undefined, fallback: string): string {
  const v = (c ?? '').trim().toLowerCase();
  if (NAMED[v]) return NAMED[v];
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${[...v.slice(1)].map((ch) => ch + ch).join('')}`;
  return fallback;
}

function mix(a: string, b: string, t: number): string {
  const p = (s: string) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}
const shade = (c: string, t: number) => mix(c, '#000000', t);
const tint = (c: string, t: number) => mix(c, '#ffffff', t);

/** The colors one piece is drawn with. */
interface Kit {
  main: string;
  accent: string;
  line: string;
}
const kit = (main: string, accent: string): Kit => ({ main, accent, line: shade(main, 0.55) });

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A limb: a round-capped stroke with an outline. */
const limb = (d: string, color: string, w: number) =>
  `<path d="${d}" fill="none" stroke="${shade(color, 0.55)}" stroke-width="${w + 2.6}" stroke-linecap="round"/><path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`;
const eye = (x: number, y: number, r = 1.9) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#26282c" stroke="none"/><circle cx="${x + r * 0.35}" cy="${y - r * 0.35}" r="${r * 0.35}" fill="#fff" stroke="none"/>`;

// -------------------------------------------------------------------------------------------------------- characters

interface Character {
  title: string;
  color: string;
  accent: string;
  /** Front hand, back hand. */
  hands: [[number, number], [number, number]];
  /** The top of the head, and its radius (what a hat is sized to). */
  head: { x: number; y: number; r: number };
  back: (k: Kit) => string;
  body: (k: Kit) => string;
  front: (k: Kit) => string;
}

const SKIN = '#f1c7a1';

const CHARACTERS: Record<string, Character> = {
  person: {
    title: 'a person',
    color: '#4a7fd4',
    accent: '#d9534f',
    hands: [
      [70, 67],
      [31, 67],
    ],
    head: { x: 50, y: 14, r: 14 },
    back: (k) => limb('M41 48 Q34 56 31 66', shade(k.main, 0.18), 7) + `<circle cx="31" cy="67" r="3.8" fill="${SKIN}" stroke="${shade(SKIN, 0.5)}" stroke-width="1.2"/>`,
    body: (k) =>
      `<g stroke="${k.line}" stroke-width="1.3" stroke-linejoin="round">` +
      `<rect x="39" y="72" width="9" height="25" rx="4" fill="${shade(k.main, 0.45)}"/><rect x="52" y="72" width="9" height="25" rx="4" fill="${shade(k.main, 0.5)}"/>` +
      `<ellipse cx="44" cy="97.5" rx="7" ry="2.8" fill="#4a3426"/><ellipse cx="58" cy="97.5" rx="7" ry="2.8" fill="#4a3426"/>` +
      `<path d="M36 52 Q36 42 45 42 L55 42 Q64 42 64 52 L65 77 L35 77 Z" fill="${k.main}"/>` +
      `<path d="M37 70 L63 70" stroke="${shade(k.main, 0.35)}" stroke-width="3"/>` +
      `<circle cx="50" cy="28" r="14" fill="${SKIN}" stroke="${shade(SKIN, 0.5)}"/>` +
      `<path d="M36 27 Q36 13 50 13 Q63 13 64 24 Q57 19 51 21 Q42 18 36 27 Z" fill="#6b4a2e"/>` +
      `</g>${eye(55, 27)}${eye(61, 27)}<path d="M55 34 Q58.5 37 62 34" fill="none" stroke="#26282c" stroke-width="1.2" stroke-linecap="round"/><circle cx="62" cy="31" r="2.6" fill="#f08a8a" opacity=".5"/>`,
    front: (k) => limb('M59 48 Q67 56 70 66', k.main, 7) + `<circle cx="70" cy="67" r="3.8" fill="${SKIN}" stroke="${shade(SKIN, 0.5)}" stroke-width="1.2"/>`,
  },
  giant: {
    title: 'a giant',
    color: '#6e5435',
    accent: '#8a8f5a',
    hands: [
      [84, 70],
      [16, 70],
    ],
    head: { x: 50, y: 4, r: 12 },
    back: (k) => limb('M31 38 Q22 52 17 68', shade(k.main, 0.2), 11) + `<circle cx="16" cy="70" r="6" fill="#9bb07f" stroke="${shade('#9bb07f', 0.5)}" stroke-width="1.3"/>`,
    body: (k) =>
      `<g stroke="${k.line}" stroke-width="1.4" stroke-linejoin="round">` +
      `<rect x="33" y="74" width="14" height="23" rx="5" fill="${shade(k.main, 0.35)}"/><rect x="53" y="74" width="14" height="23" rx="5" fill="${shade(k.main, 0.42)}"/>` +
      `<ellipse cx="40" cy="97.5" rx="10" ry="3" fill="#3d2c20"/><ellipse cx="61" cy="97.5" rx="10" ry="3" fill="#3d2c20"/>` +
      `<path d="M25 46 Q25 30 40 29 L60 29 Q75 30 75 46 L73 80 L27 80 Z" fill="${k.main}"/>` +
      `<path d="M28 60 Q50 66 72 60 M30 74 Q50 79 70 74" fill="none" stroke="${shade(k.main, 0.3)}" stroke-width="1.6"/>` +
      `<rect x="27" y="64" width="46" height="5" rx="2" fill="${shade(k.main, 0.45)}"/>` +
      `<circle cx="50" cy="16" r="12" fill="#9bb07f" stroke="${shade('#9bb07f', 0.5)}"/>` +
      `<path d="M41 13 Q50 8 60 12" fill="none" stroke="#3d4a2a" stroke-width="2.6" stroke-linecap="round"/>` +
      `</g>${eye(52, 16, 1.6)}${eye(58, 16, 1.6)}<path d="M51 23 Q55 21 59 23" fill="none" stroke="#26282c" stroke-width="1.3" stroke-linecap="round"/>`,
    front: (k) => limb('M69 38 Q78 52 83 68', k.main, 11) + `<circle cx="84" cy="70" r="6" fill="#9bb07f" stroke="${shade('#9bb07f', 0.5)}" stroke-width="1.3"/>`,
  },
  mouse: {
    title: 'a mouse',
    color: '#9aa3ad',
    accent: '#d9534f',
    hands: [
      [71, 72],
      [33, 72],
    ],
    head: { x: 53, y: 22, r: 13 },
    back: (k) =>
      `<path d="M36 90 C18 94 9 78 17 67 C23 59 15 51 9 53" fill="none" stroke="${shade('#e9a1b0', 0.15)}" stroke-width="3" stroke-linecap="round"/>` +
      limb('M41 63 Q36 68 33 72', shade(k.main, 0.15), 5.5),
    body: (k) =>
      `<g stroke="${k.line}" stroke-width="1.3">` +
      `<ellipse cx="44" cy="97" rx="7" ry="2.8" fill="#e9a1b0"/><ellipse cx="58" cy="97" rx="7" ry="2.8" fill="#e9a1b0"/>` +
      `<ellipse cx="50" cy="75" rx="17" ry="21" fill="${k.main}"/><ellipse cx="54" cy="78" rx="9" ry="14" fill="${tint(k.main, 0.5)}" stroke="none"/>` +
      `<circle cx="41" cy="24" r="10" fill="${k.main}"/><circle cx="41" cy="24" r="6" fill="#efb3c0" stroke="none"/>` +
      `<circle cx="63" cy="20" r="10" fill="${k.main}"/><circle cx="63" cy="20" r="6" fill="#efb3c0" stroke="none"/>` +
      `<path d="M39 40 Q38 26 53 25 Q66 25 69 34 Q78 39 72 44 Q64 50 52 50 Q40 49 39 40 Z" fill="${k.main}"/>` +
      `</g><circle cx="73" cy="41" r="2.6" fill="#e07d95"/>${eye(61, 35, 2.1)}` +
      `<path d="M68 44 L81 41 M68 45 L81 47" stroke="${shade(k.main, 0.45)}" stroke-width=".8"/>`,
    front: (k) => limb('M60 63 Q66 67 70 71', k.main, 5.5) + `<circle cx="71" cy="72" r="3" fill="#e9a1b0" stroke="${k.line}" stroke-width="1"/>`,
  },
  cat: {
    title: 'a cat',
    color: '#f0a050',
    accent: '#4a7fd4',
    hands: [
      [64, 95],
      [50, 95],
    ],
    head: { x: 60, y: 30, r: 14 },
    back: (k) => `<path d="M38 92 Q14 88 18 64 Q20 54 28 56" fill="none" stroke="${k.line}" stroke-width="9.6" stroke-linecap="round"/><path d="M38 92 Q14 88 18 64 Q20 54 28 56" fill="none" stroke="${k.main}" stroke-width="7" stroke-linecap="round"/>`,
    body: (k) =>
      `<g stroke="${k.line}" stroke-width="1.3" stroke-linejoin="round">` +
      `<path d="M36 98 Q28 72 44 60 Q58 52 66 62 Q76 80 72 98 Z" fill="${k.main}"/><path d="M54 98 Q50 76 60 66 Q68 76 66 98 Z" fill="${tint(k.main, 0.55)}" stroke="none"/>` +
      `<path d="M47 37 L49 21 L58 31 Z" fill="${k.main}"/><path d="M62 30 L71 18 L73 36 Z" fill="${k.main}"/>` +
      `<circle cx="61" cy="44" r="14" fill="${k.main}"/>` +
      `<ellipse cx="52" cy="97" rx="6" ry="2.6" fill="${tint(k.main, 0.4)}"/><ellipse cx="64" cy="97" rx="6" ry="2.6" fill="${tint(k.main, 0.4)}"/>` +
      `</g><path d="M50 33 L51 25 L55 31 Z M64 30 L70 23 L71 33 Z" fill="#efb3c0"/>${eye(60, 42)}${eye(68, 42)}` +
      `<path d="M70 47 l-2 2.4 l-2 -2.4 Z" fill="#e07d95"/><path d="M71 49 L82 47 M71 50 L82 52" stroke="${shade(k.main, 0.5)}" stroke-width=".8"/>`,
    front: () => '',
  },
  dog: {
    title: 'a dog',
    color: '#c9a27a',
    accent: '#d9534f',
    hands: [
      [64, 95],
      [50, 95],
    ],
    head: { x: 62, y: 26, r: 14 },
    back: (k) => limb('M36 84 Q24 76 26 62', k.main, 6),
    body: (k) =>
      `<g stroke="${k.line}" stroke-width="1.3" stroke-linejoin="round">` +
      `<path d="M34 98 Q28 70 46 60 Q60 54 68 64 Q76 80 72 98 Z" fill="${k.main}"/><path d="M54 98 Q52 78 62 68 Q70 78 67 98 Z" fill="${tint(k.main, 0.5)}" stroke="none"/>` +
      `<circle cx="62" cy="42" r="15" fill="${k.main}"/><path d="M72 42 Q86 40 86 48 Q86 56 72 54 Z" fill="${tint(k.main, 0.35)}"/>` +
      `<path d="M50 32 Q42 40 46 56 Q54 50 55 36 Z" fill="${shade(k.main, 0.35)}"/>` +
      `<ellipse cx="52" cy="97" rx="6" ry="2.6" fill="${tint(k.main, 0.3)}"/><ellipse cx="64" cy="97" rx="6" ry="2.6" fill="${tint(k.main, 0.3)}"/>` +
      `</g><circle cx="85" cy="44.5" r="2.6" fill="#26282c"/>${eye(66, 38)}<path d="M78 53 Q80 60 83 55" fill="#e07d95" stroke="#b85a70" stroke-width=".8"/>`,
    front: () => '',
  },
  bird: {
    title: 'a bird',
    color: '#4a7fd4',
    accent: '#f2c84b',
    hands: [
      [62, 78],
      [44, 78],
    ],
    head: { x: 60, y: 44, r: 10 },
    back: (k) => `<path d="M34 70 L18 64 L22 74 L16 80 L34 78 Z" fill="${shade(k.main, 0.2)}" stroke="${k.line}" stroke-width="1.2" stroke-linejoin="round"/>`,
    body: (k) =>
      `<path d="M46 86 L44 99 M56 86 L57 99" stroke="#e09a3c" stroke-width="2"/>` +
      `<g stroke="${k.line}" stroke-width="1.3" stroke-linejoin="round"><ellipse cx="48" cy="72" rx="17" ry="15" fill="${k.main}"/><circle cx="60" cy="56" r="11" fill="${k.main}"/>` +
      `<path d="M70 54 L80 57 L70 60 Z" fill="${k.accent}"/><ellipse cx="46" cy="72" rx="10" ry="7" fill="${shade(k.main, 0.2)}" transform="rotate(-15 46 72)"/></g>` +
      `<ellipse cx="54" cy="78" rx="8" ry="6" fill="${tint(k.main, 0.55)}"/>${eye(63, 54, 1.8)}`,
    front: () => '',
  },
  dragon: {
    title: 'a dragon',
    color: '#4caf6a',
    accent: '#f2c84b',
    hands: [
      [70, 84],
      [46, 86],
    ],
    head: { x: 82, y: 18, r: 10 },
    back: (k) =>
      `<path d="M44 58 L28 12 L38 26 L44 12 L52 28 L60 18 L60 56 Z" fill="${shade(k.main, 0.3)}" stroke="${k.line}" stroke-width="1.3" stroke-linejoin="round"/>` +
      limb('M32 80 Q12 86 8 72 Q6 62 14 60', k.main, 7) +
      `<path d="M14 60 L6 54 L16 54 Z" fill="${k.accent}" stroke="${k.line}" stroke-width="1"/>`,
    body: (k) =>
      `<g stroke="${k.line}" stroke-width="1.3" stroke-linejoin="round">` +
      `<rect x="35" y="84" width="10" height="14" rx="4" fill="${shade(k.main, 0.15)}"/><rect x="56" y="84" width="10" height="14" rx="4" fill="${shade(k.main, 0.2)}"/>` +
      `<ellipse cx="50" cy="76" rx="25" ry="17" fill="${k.main}"/><ellipse cx="54" cy="82" rx="15" ry="8" fill="${tint(k.accent, 0.4)}" stroke="none"/>` +
      `<path d="M60 68 Q72 52 74 36 L86 34 Q88 58 70 78 Z" fill="${k.main}"/>` +
      `<path d="M78 28 L76 16 L83 24 Z M86 26 L88 14 L91 26 Z" fill="${tint(k.accent, 0.2)}"/>` +
      `<ellipse cx="83" cy="30" rx="12" ry="9" fill="${k.main}"/><ellipse cx="94" cy="33" rx="7" ry="5" fill="${k.main}"/>` +
      `<path d="M30 64 L34 58 L37 64 M40 60 L44 54 L47 60 M50 59 L54 53 L57 59" fill="${k.accent}"/>` +
      `</g>${eye(85, 28, 2)}<circle cx="98" cy="31.5" r="1" fill="#26282c"/>`,
    front: (k) => `<path d="M48 60 L40 22 L50 34 L58 22 L64 36 L72 30 L64 60 Z" fill="${shade(k.main, 0.12)}" stroke="${k.line}" stroke-width="1.3" stroke-linejoin="round" opacity=".95"/>`,
  },
};

// ------------------------------------------------------------------------------------- what characters wear and hold

/** Hats and hoods, drawn on a head of radius 14 whose top is at 0,0. */
const WEAR: Record<string, (k: Kit) => string> = {
  helmet: (k) =>
    `<path d="M-5 -2 Q-13 -15 -3 -21 Q1 -11 3 -3 Z" fill="${k.accent}" stroke="${shade(k.accent, 0.5)}" stroke-width="1.2"/>` +
    `<path d="M-15.5 9.5 Q-15.5 -3.5 0 -3.5 Q15.5 -3.5 15.5 9.5 Z" fill="#c4ccd4" stroke="#5c6670" stroke-width="1.3"/>` +
    `<rect x="-15.5" y="5.5" width="31" height="4.5" rx="1.5" fill="#9aa5b0" stroke="#5c6670" stroke-width="1.1"/><path d="M-6 1.5 Q0 -2 8 0.5" fill="none" stroke="#fff" stroke-width="1.6" opacity=".7"/>`,
  crown: () =>
    `<path d="M-11 4 L-12 -9 L-6 -2 L0 -11 L6 -2 L12 -9 L11 4 Z" fill="#e3b23c" stroke="#8a6512" stroke-width="1.2" stroke-linejoin="round"/>` +
    `<circle cx="0" cy="-1" r="1.8" fill="#d9534f"/><circle cx="-7" cy="1" r="1.3" fill="#4a7fd4"/><circle cx="7" cy="1" r="1.3" fill="#4caf6a"/>`,
  'wizard hat': (k) =>
    `<path d="M-12 4 Q-3 -14 9 -32 Q6 -12 12 4 Z" fill="${k.accent}" stroke="${shade(k.accent, 0.5)}" stroke-width="1.3" stroke-linejoin="round"/>` +
    `<ellipse cx="0" cy="4" rx="19" ry="4.5" fill="${shade(k.accent, 0.15)}" stroke="${shade(k.accent, 0.5)}" stroke-width="1.3"/>` +
    `<path d="M2 -12 l1.2 2.6 l2.8 .3 l-2.1 1.9 l.6 2.8 l-2.5 -1.4 l-2.5 1.4 l.6 -2.8 l-2.1 -1.9 l2.8 -.3 Z" fill="#f2c84b"/>`,
  cap: (k) => `<path d="M-14 9 Q-14 -2 0 -2 Q14 -2 14 9 Z" fill="${k.accent}" stroke="${shade(k.accent, 0.5)}" stroke-width="1.3"/><path d="M10 7 L27 9 Q22 13 12 11 Z" fill="${shade(k.accent, 0.2)}" stroke="${shade(k.accent, 0.5)}" stroke-width="1.2"/>`,
  hood: (k) =>
    `<path d="M-18 30 Q-20 -5 0 -5 Q20 -5 18 30 Q14 14 9 6 Q0 1 -9 6 Q-14 14 -18 30 Z" fill="${k.main}" stroke="${shade(k.main, 0.55)}" stroke-width="1.3" stroke-linejoin="round"/>` +
    `<path d="M-9 6 Q0 1 9 6" fill="none" stroke="${shade(k.main, 0.4)}" stroke-width="2"/>`,
};

/** What a hand holds, drawn with the grip at 0,0. */
const HOLD: Record<string, (k: Kit) => string> = {
  sword: () =>
    `<path d="M-2.4 -4 L-2.4 -40 L0 -46 L2.4 -40 L2.4 -4 Z" fill="#dfe6ee" stroke="#5c6670" stroke-width="1.1" stroke-linejoin="round"/><path d="M0 -6 L0 -40" stroke="#9aa5b0" stroke-width=".9"/>` +
    `<rect x="-8.5" y="-5" width="17" height="3.4" rx="1.4" fill="#e3b23c" stroke="#8a6512" stroke-width="1"/><rect x="-1.9" y="-1.8" width="3.8" height="8" rx="1.5" fill="#6b4a2e"/><circle cx="0" cy="7.2" r="2.4" fill="#e3b23c" stroke="#8a6512" stroke-width=".9"/>`,
  shield: (k) =>
    `<path d="M0 -15 Q11 -15 14 -11 Q14 7 0 17 Q-14 7 -14 -11 Q-11 -15 0 -15 Z" fill="${k.accent}" stroke="${shade(k.accent, 0.55)}" stroke-width="1.4" stroke-linejoin="round"/>` +
    `<path d="M0 -10 Q8 -10 10 -7.5 Q10 5 0 12 Q-10 5 -10 -7.5 Q-8 -10 0 -10 Z" fill="none" stroke="#e3b23c" stroke-width="1.6"/><path d="M0 -6 L0 7 M-6 -1 L6 -1" stroke="#e3b23c" stroke-width="2.4" stroke-linecap="round"/>`,
  staff: () =>
    `<rect x="-1.7" y="-40" width="3.4" height="70" rx="1.6" fill="#8a5a3b" stroke="#4a3020" stroke-width="1"/>` +
    `<circle cx="0" cy="-44" r="9" fill="#9fe7ff" opacity=".35"/><circle cx="0" cy="-44" r="5" fill="#bff0ff" stroke="#3a9ec2" stroke-width="1.1"/>`,
  club: () => `<path d="M-2.6 8 L-4 -10 Q-8 -32 0 -36 Q8 -32 4 -10 L2.6 8 Z" fill="#8a5a3b" stroke="#4a3020" stroke-width="1.2" stroke-linejoin="round"/><circle cx="-1.5" cy="-22" r="1.6" fill="#5e3d27"/><circle cx="2" cy="-14" r="1.3" fill="#5e3d27"/>`,
  flag: (k) => `<rect x="-1.2" y="-52" width="2.4" height="60" rx="1" fill="#6b4a2e"/><path d="M1 -51 Q14 -55 27 -46 Q14 -43 1 -37 Z" fill="${k.accent}" stroke="${shade(k.accent, 0.5)}" stroke-width="1.1"/>`,
  lantern: () =>
    `<path d="M0 0 L0 6" stroke="#4a3020" stroke-width="1.4"/><circle cx="0" cy="14" r="10" fill="#ffd27a" opacity=".35"/>` +
    `<rect x="-5" y="6" width="10" height="13" rx="2" fill="#ffe7a8" stroke="#6b4a2e" stroke-width="1.3"/><path d="M-6 6 L6 6 M-6 19 L6 19" stroke="#6b4a2e" stroke-width="2.2"/>`,
  torch: () =>
    `<rect x="-1.8" y="-22" width="3.6" height="30" rx="1.5" fill="#8a5a3b" stroke="#4a3020" stroke-width="1"/><circle cx="0" cy="-30" r="9" fill="#ffb347" opacity=".3"/>` +
    `<path d="M0 -38 Q7 -30 3 -23 L-3 -23 Q-7 -30 0 -38 Z" fill="#f08a3c"/><path d="M0 -33 Q3 -28 1.5 -24 L-1.5 -24 Q-3 -28 0 -33 Z" fill="#ffe07a"/>`,
};

// --------------------------------------------------------------------------------------------------------- scenery

interface Scenery {
  title: string;
  color: string;
  accent: string;
  /** Hangs in the sky: no shadow, and it stands high when no y is given. */
  sky?: boolean;
  size: number;
  draw: (k: Kit) => string;
}

const SCENERY: Record<string, Scenery> = {
  tree: {
    title: 'a leafy tree',
    color: '#4caf6a',
    accent: '#8a5a3b',
    size: 46,
    draw: (k) =>
      `<path d="M44 100 L46 60 L54 60 L56 100 Z" fill="${k.accent}" stroke="${shade(k.accent, 0.5)}" stroke-width="1.3"/>` +
      `<g stroke="${k.line}" stroke-width="1.3"><circle cx="33" cy="52" r="16" fill="${shade(k.main, 0.1)}"/><circle cx="67" cy="52" r="16" fill="${shade(k.main, 0.1)}"/><circle cx="50" cy="36" r="24" fill="${k.main}"/></g>` +
      `<circle cx="42" cy="28" r="7" fill="${tint(k.main, 0.3)}" opacity=".7"/>`,
  },
  pine: {
    title: 'a pine tree',
    color: '#2f8a5a',
    accent: '#7a4f33',
    size: 48,
    draw: (k) =>
      `<rect x="46" y="86" width="8" height="14" fill="${k.accent}" stroke="${shade(k.accent, 0.5)}" stroke-width="1.2"/>` +
      `<g stroke="${k.line}" stroke-width="1.3" stroke-linejoin="round"><path d="M50 40 L82 88 L18 88 Z" fill="${shade(k.main, 0.12)}"/><path d="M50 20 L76 62 L24 62 Z" fill="${k.main}"/><path d="M50 4 L68 36 L32 36 Z" fill="${tint(k.main, 0.1)}"/></g>`,
  },
  mountain: {
    title: 'a mountain',
    color: '#7f8fb0',
    accent: '#ffffff',
    size: 60,
    draw: (k) =>
      `<path d="M0 100 L40 16 L56 40 L64 30 L100 100 Z" fill="${k.main}" stroke="${k.line}" stroke-width="1.2" stroke-linejoin="round"/><path d="M40 16 L56 40 L48 100 L0 100 Z" fill="${tint(k.main, 0.15)}"/>` +
      `<path d="M40 16 L31 34 L39 30 L45 36 L50 28 Z" fill="${k.accent}"/><path d="M64 30 L58 38 L64 36 L70 40 Z" fill="${k.accent}"/>`,
  },
  rock: {
    title: 'a rock',
    color: '#8f969e',
    accent: '#c4ccd4',
    size: 16,
    draw: (k) => `<path d="M14 100 Q10 78 28 70 Q46 58 66 66 Q88 74 86 100 Z" fill="${k.main}" stroke="${k.line}" stroke-width="1.4"/><path d="M30 76 Q44 66 58 70" fill="none" stroke="${tint(k.main, 0.4)}" stroke-width="3" stroke-linecap="round"/>`,
  },
  bush: {
    title: 'a bush',
    color: '#5aa860',
    accent: '#d9534f',
    size: 16,
    draw: (k) =>
      `<g stroke="${k.line}" stroke-width="1.3"><circle cx="30" cy="80" r="18" fill="${shade(k.main, 0.1)}"/><circle cx="70" cy="80" r="18" fill="${shade(k.main, 0.1)}"/><circle cx="50" cy="70" r="24" fill="${k.main}"/></g>` +
      `<circle cx="40" cy="62" r="3" fill="${k.accent}"/><circle cx="60" cy="74" r="3" fill="${k.accent}"/><circle cx="28" cy="80" r="3" fill="${k.accent}"/>`,
  },
  flower: {
    title: 'a flower',
    color: '#ec8fb3',
    accent: '#f2c84b',
    size: 12,
    draw: (k) =>
      `<path d="M50 100 Q48 70 50 44" fill="none" stroke="#3f8f4f" stroke-width="3"/><path d="M50 78 Q36 68 34 76 Q42 84 50 80 Z" fill="#4caf6a"/>` +
      [0, 72, 144, 216, 288].map((a) => `<ellipse cx="50" cy="28" rx="7" ry="11" fill="${k.main}" stroke="${k.line}" stroke-width="1" transform="rotate(${a} 50 38)"/>`).join('') +
      `<circle cx="50" cy="38" r="7" fill="${k.accent}" stroke="${shade(k.accent, 0.5)}" stroke-width="1"/>`,
  },
  house: {
    title: 'a house',
    color: '#ead7b5',
    accent: '#c4553f',
    size: 40,
    draw: (k) =>
      `<g stroke="${k.line}" stroke-width="1.3" stroke-linejoin="round"><rect x="66" y="22" width="9" height="20" fill="${shade(k.accent, 0.2)}"/>` +
      `<rect x="20" y="50" width="60" height="50" fill="${k.main}"/><path d="M12 52 L50 20 L88 52 Z" fill="${k.accent}"/>` +
      `<rect x="43" y="70" width="14" height="30" rx="2" fill="#8a5a3b"/><rect x="26" y="62" width="12" height="12" fill="#bfe3f5"/><rect x="62" y="62" width="12" height="12" fill="#bfe3f5"/></g>` +
      `<path d="M32 62 L32 74 M26 68 L38 68 M68 62 L68 74 M62 68 L74 68" stroke="${k.line}" stroke-width="1"/><circle cx="54" cy="86" r="1.3" fill="#e3b23c"/>`,
  },
  castle: {
    title: 'a castle',
    color: '#b9b2a6',
    accent: '#4a7fd4',
    size: 58,
    draw: (k) => {
      const merlons = (x0: number, x1: number, y: number) =>
        Array.from({ length: Math.floor((x1 - x0) / 6) }, (_, i) => (i % 2 ? '' : `<rect x="${x0 + i * 6}" y="${y - 5}" width="6" height="5" fill="${k.main}"/>`)).join('');
      return (
        `<g stroke="${k.line}" stroke-width="1.2" stroke-linejoin="round">` +
        `<rect x="24" y="44" width="52" height="56" fill="${k.main}"/>${merlons(24, 78, 44)}` +
        `<rect x="6" y="30" width="20" height="70" fill="${shade(k.main, 0.08)}"/><rect x="74" y="30" width="20" height="70" fill="${shade(k.main, 0.08)}"/>` +
        `<path d="M4 31 L16 6 L28 31 Z M72 31 L84 6 L96 31 Z" fill="${k.accent}"/>` +
        `<path d="M40 100 L40 80 Q50 68 60 80 L60 100 Z" fill="#5a4031"/><rect x="12" y="44" width="6" height="10" rx="3" fill="#3a3d42"/><rect x="82" y="44" width="6" height="10" rx="3" fill="#3a3d42"/>` +
        `<rect x="46" y="54" width="8" height="10" rx="4" fill="#3a3d42"/></g>` +
        `<path d="M16 6 L16 -6" stroke="#5a4031" stroke-width="1.2"/><path d="M16 -6 L26 -3 L16 0 Z" fill="${tint(k.accent, 0.1)}"/>` +
        `<path d="M84 6 L84 -6" stroke="#5a4031" stroke-width="1.2"/><path d="M84 -6 L94 -3 L84 0 Z" fill="${tint(k.accent, 0.1)}"/>` +
        `<path d="M24 60 L76 60 M24 76 L40 76 M60 76 L76 76" stroke="${shade(k.main, 0.2)}" stroke-width=".8"/>`
      );
    },
  },
  tower: {
    title: 'a tower',
    color: '#b9b2a6',
    accent: '#8a5cc7',
    size: 50,
    draw: (k) =>
      `<g stroke="${k.line}" stroke-width="1.2" stroke-linejoin="round"><rect x="34" y="30" width="32" height="70" fill="${k.main}"/><path d="M30 32 L50 2 L70 32 Z" fill="${k.accent}"/>` +
      `<rect x="45" y="44" width="10" height="14" rx="5" fill="#3a3d42"/><path d="M42 100 L42 84 Q50 76 58 84 L58 100 Z" fill="#5a4031"/></g>` +
      `<path d="M34 64 L66 64 M34 80 L42 80 M58 80 L66 80" stroke="${shade(k.main, 0.2)}" stroke-width=".8"/>`,
  },
  tent: {
    title: 'a tent',
    color: '#e3b23c',
    accent: '#d9534f',
    size: 28,
    draw: (k) => `<path d="M6 100 L50 30 L94 100 Z" fill="${k.main}" stroke="${k.line}" stroke-width="1.4" stroke-linejoin="round"/><path d="M38 100 L50 62 L62 100 Z" fill="${shade(k.main, 0.45)}"/><path d="M50 30 L50 18 M50 18 L62 22 L50 26" stroke="${k.accent}" stroke-width="2" fill="${k.accent}"/>`,
  },
  campfire: {
    title: 'a campfire',
    color: '#f08a3c',
    accent: '#8a5a3b',
    size: 18,
    draw: (k) =>
      [40, 30, 20].map((r) => `<circle cx="50" cy="72" r="${r}" fill="#ff9a3c" opacity=".1"/>`).join('') +
      `<path d="M22 96 L78 84 M24 84 L78 98" stroke="${shade(k.accent, 0.35)}" stroke-width="9.5" stroke-linecap="round"/><path d="M22 96 L78 84 M24 84 L78 98" stroke="${k.accent}" stroke-width="7" stroke-linecap="round"/>` +
      `<path d="M50 30 Q70 56 62 82 L38 82 Q30 56 50 30 Z" fill="${k.main}"/><path d="M50 50 Q60 66 56 82 L44 82 Q40 66 50 50 Z" fill="#ffe07a"/>`,
  },
  chest: {
    title: 'a treasure chest',
    color: '#8a5a3b',
    accent: '#e3b23c',
    size: 16,
    draw: (k) =>
      `<g stroke="${k.line}" stroke-width="1.4" stroke-linejoin="round"><path d="M14 56 Q14 34 50 34 Q86 34 86 56 Z" fill="${tint(k.main, 0.08)}"/><rect x="14" y="56" width="72" height="44" rx="3" fill="${k.main}"/></g>` +
      `<path d="M14 56 L86 56 M26 40 L26 100 M74 40 L74 100" stroke="${k.accent}" stroke-width="4"/><rect x="45" y="52" width="10" height="13" rx="2" fill="${k.accent}" stroke="${shade(k.accent, 0.5)}" stroke-width="1"/>` +
      `<circle cx="36" cy="34" r="4" fill="${k.accent}"/><circle cx="46" cy="31" r="4" fill="${k.accent}"/><circle cx="58" cy="32" r="4" fill="${k.accent}"/>`,
  },
  boat: {
    title: 'a sailboat',
    color: '#8a5a3b',
    accent: '#f4f4f2',
    size: 34,
    draw: (k) =>
      `<path d="M50 74 L50 8" stroke="#5a4031" stroke-width="2.4"/><path d="M52 10 Q82 40 78 70 L52 70 Z" fill="${k.accent}" stroke="${shade(k.accent, 0.4)}" stroke-width="1.2"/><path d="M48 18 Q28 46 30 70 L48 70 Z" fill="${tint(k.accent, 0.1)}" stroke="${shade(k.accent, 0.4)}" stroke-width="1.2"/>` +
      `<path d="M8 74 L92 74 Q84 100 50 100 Q16 100 8 74 Z" fill="${k.main}" stroke="${k.line}" stroke-width="1.4"/><path d="M14 84 L86 84" stroke="${tint(k.main, 0.3)}" stroke-width="2"/>`,
  },
  car: {
    title: 'a car',
    color: '#d9534f',
    accent: '#bfe3f5',
    size: 22,
    draw: (k) =>
      `<g stroke="${k.line}" stroke-width="1.4" stroke-linejoin="round"><path d="M6 86 L8 66 Q10 60 20 60 L30 60 L40 44 Q44 40 52 40 L68 40 Q76 40 80 48 L86 60 Q94 62 94 70 L94 86 Z" fill="${k.main}"/>` +
      `<path d="M36 60 L44 47 Q46 45 50 45 L60 45 L60 60 Z M64 45 L68 45 Q74 45 77 50 L81 60 L64 60 Z" fill="${k.accent}"/></g>` +
      `<circle cx="26" cy="88" r="10" fill="#3a3d42"/><circle cx="26" cy="88" r="4" fill="#c4ccd4"/><circle cx="76" cy="88" r="10" fill="#3a3d42"/><circle cx="76" cy="88" r="4" fill="#c4ccd4"/>`,
  },
  rocket: {
    title: 'a rocket',
    color: '#f4f4f2',
    accent: '#d9534f',
    size: 40,
    draw: (k) =>
      `<path d="M42 84 Q50 104 58 84 Z" fill="#f08a3c"/><path d="M45 84 Q50 96 55 84 Z" fill="#ffe07a"/>` +
      `<g stroke="${k.line}" stroke-width="1.3" stroke-linejoin="round"><path d="M36 70 L24 86 L36 82 Z M64 70 L76 86 L64 82 Z" fill="${k.accent}"/>` +
      `<path d="M50 4 Q68 22 64 84 L36 84 Q32 22 50 4 Z" fill="${k.main}"/><path d="M50 4 Q58 12 61 22 L39 22 Q42 12 50 4 Z" fill="${k.accent}"/>` +
      `<circle cx="50" cy="44" r="8" fill="#9fd3f5" stroke="${shade(k.accent, 0.3)}" stroke-width="2"/></g>`,
  },
  cloud: {
    title: 'a cloud',
    color: '#ffffff',
    accent: '#dfe9f3',
    sky: true,
    size: 12,
    draw: (k) => `<g fill="${k.main}" stroke="${k.accent}" stroke-width="1.5"><circle cx="30" cy="68" r="18"/><circle cx="52" cy="56" r="24"/><circle cx="74" cy="70" r="16"/><rect x="28" y="70" width="48" height="16" rx="8" stroke="none"/></g>`,
  },
  sun: {
    title: 'the sun',
    color: '#f9c74f',
    accent: '#ffe7a3',
    sky: true,
    size: 14,
    draw: (k) =>
      `<circle cx="50" cy="50" r="48" fill="${k.accent}" opacity=".35"/>` +
      Array.from({ length: 12 }, (_, i) => `<path d="M50 6 L50 18" stroke="${k.main}" stroke-width="4" stroke-linecap="round" transform="rotate(${i * 30} 50 50)"/>`).join('') +
      `<circle cx="50" cy="50" r="24" fill="${k.main}" stroke="${shade(k.main, 0.2)}" stroke-width="1.5"/>`,
  },
  moon: {
    title: 'the moon',
    color: '#f4efd8',
    accent: '#fff8d6',
    sky: true,
    size: 12,
    draw: (k) => `<circle cx="50" cy="50" r="46" fill="${k.accent}" opacity=".18"/><path d="M62 14 A36 36 0 1 0 86 64 A28 28 0 1 1 62 14 Z" fill="${k.main}" stroke="${shade(k.main, 0.25)}" stroke-width="1.5"/>`,
  },
  star: {
    title: 'a star',
    color: '#f9d65c',
    accent: '#fff3b0',
    sky: true,
    size: 6,
    draw: (k) => `<path d="M50 6 L61 38 L95 38 L67 58 L78 92 L50 72 L22 92 L33 58 L5 38 L39 38 Z" fill="${k.main}" stroke="${shade(k.main, 0.35)}" stroke-width="2" stroke-linejoin="round"/>`,
  },
};

export const SCENE_CHARACTERS = Object.keys(CHARACTERS);
export const SCENE_SCENERY = Object.keys(SCENERY);
export const SCENE_PARTS = [...SCENE_CHARACTERS, ...SCENE_SCENERY];
export const SCENE_WEAR = Object.keys(WEAR);
export const SCENE_HOLD = Object.keys(HOLD);

// --------------------------------------------------------------------------------------------------------- backdrops

/** The same scatter every time (stars, snow): a scene drawn twice is the same picture. */
function scatter(n: number, seed: number, w: number, h: number): Array<[number, number, number]> {
  let s = seed;
  const r = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  return Array.from({ length: n }, () => [r() * w, r() * h, r()]);
}

const gradient = (id: string, stops: string[]) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${stops.map((c, i) => `<stop offset="${i / (stops.length - 1)}" stop-color="${c}"/>`).join('')}</linearGradient>`;

/** Rolling hills across the picture, from `y` down. */
const hills = (w: number, h: number, y: number, amp: number, phase: number, color: string) => {
  const pts = Array.from({ length: 9 }, (_, i) => {
    const x = (i / 8) * w;
    return `${x.toFixed(0)} ${(y - amp * (0.5 + 0.5 * Math.sin(i * 1.3 + phase))).toFixed(0)}`;
  });
  return `<path d="M0 ${h} L${pts.map((p) => p).join(' L')} L${w} ${h} Z" fill="${color}"/>`;
};

const pines = (w: number, y: number, size: number, color: string, seed: number) =>
  scatter(Math.ceil(w / (size * 0.55)), seed, w, 1)
    .map(([x, , r]) => {
      const s = size * (0.7 + r * 0.5);
      return `<path d="M${x.toFixed(0)} ${(y - s).toFixed(0)} L${(x + s * 0.32).toFixed(0)} ${y} L${(x - s * 0.32).toFixed(0)} ${y} Z" fill="${color}"/>`;
    })
    .join('');

/** The backdrop; `moon: false` when the scene has a moon of its own. */
function backdrop(name: SceneBackdrop, w: number, h: number, o: { moon: boolean }): string {
  const g = h * 0.8;
  const ground = (top: string, bottom: string) => `${gradient('bd-ground', [top, bottom])}<rect x="0" y="${g}" width="${w}" height="${h - g}" fill="url(#bd-ground)"/>`;
  const sky = (stops: string[]) => `${gradient('bd-sky', stops)}<rect width="${w}" height="${h}" fill="url(#bd-sky)"/>`;
  const stars = (n: number, top: number) => scatter(n, 7, w, top).map(([x, y, r]) => `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${(0.8 + r * 1.8).toFixed(1)}" fill="#fff" opacity="${(0.4 + r * 0.6).toFixed(2)}"/>`).join('');
  switch (name) {
    case 'day':
      return sky(['#78c2f0', '#d6f0ff']) + hills(w, h, g - h * 0.1, h * 0.08, 0.4, '#b4dca6') + hills(w, h, g - h * 0.03, h * 0.06, 2.1, '#94cc86') + ground('#82c473', '#5ea552');
    case 'sunset':
      return sky(['#2d1b4e', '#a8456b', '#ff9e5e', '#ffd28a']) + `<circle cx="${w * 0.7}" cy="${g - h * 0.08}" r="${h * 0.12}" fill="#ffd77a" opacity=".9"/>` + hills(w, h, g - h * 0.08, h * 0.08, 1, '#5b3463') + hills(w, h, g - h * 0.02, h * 0.05, 3, '#3e2550') + ground('#3b2a47', '#271c31');
    case 'night':
      return (
        sky(['#08142e', '#1c3566']) +
        stars(140, g * 0.75) +
        (o.moon ? `<circle cx="${w * 0.82}" cy="${h * 0.16}" r="${h * 0.11}" fill="#fff6d0" opacity=".12"/><circle cx="${w * 0.82}" cy="${h * 0.16}" r="${h * 0.05}" fill="#f6f0d6"/>` : '') +
        hills(w, h, g - h * 0.05, h * 0.06, 0.8, '#142a4c') +
        ground('#18324e', '#0e2135')
      );
    case 'forest':
      return sky(['#86c8ee', '#e2f4ff']) + pines(w, g - h * 0.02, h * 0.28, '#7fb38a', 3) + pines(w, g + h * 0.01, h * 0.22, '#4f8f62', 11) + ground('#5aa35c', '#3f8448');
    case 'sea':
      return (
        sky(['#7cc6f2', '#e3f5ff']) +
        `${gradient('bd-sea', ['#58b4e4', '#1f6fa8'])}<rect x="0" y="${h * 0.55}" width="${w}" height="${g - h * 0.55 + 2}" fill="url(#bd-sea)"/>` +
        scatter(24, 5, w, g - h * 0.58).map(([x, y]) => `<path d="M${x.toFixed(0)} ${(h * 0.58 + y).toFixed(0)} q12 -6 24 0 q12 6 24 0" fill="none" stroke="#ffffff" stroke-width="2.4" opacity=".45"/>`).join('') +
        ground('#efd7a2', '#d9b877')
      );
    case 'desert':
      return sky(['#8fd0f6', '#fde9c4']) + hills(w, h, g - h * 0.09, h * 0.07, 1.6, '#eac58a') + hills(w, h, g - h * 0.03, h * 0.05, 0.2, '#ddb06d') + ground('#e6bd78', '#d2a35d');
    case 'snow':
      return sky(['#b9d3ea', '#eef5fb']) + hills(w, h, g - h * 0.08, h * 0.07, 2.4, '#e4eef7') + ground('#f6f9fc', '#dbe6f0') + scatter(110, 9, w, h).map(([x, y, r]) => `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${(1.5 + r * 2.5).toFixed(1)}" fill="#fff" opacity=".85"/>`).join('');
    case 'space':
      return (
        `<radialGradient id="bd-space" cx=".3" cy=".3" r=".9"><stop offset="0" stop-color="#2a1d5e"/><stop offset="1" stop-color="#060a18"/></radialGradient><rect width="${w}" height="${h}" fill="url(#bd-space)"/>` +
        stars(220, h) +
        `<circle cx="${w * 0.15}" cy="${h * 0.22}" r="${h * 0.09}" fill="#e2885a"/><ellipse cx="${w * 0.15}" cy="${h * 0.22}" rx="${h * 0.16}" ry="${h * 0.03}" fill="none" stroke="#f2c38f" stroke-width="5" opacity=".8"/>` +
        ground('#8a8f9c', '#5d6270') +
        scatter(9, 4, w, h - g).map(([x, y, r]) => `<ellipse cx="${x.toFixed(0)}" cy="${(g + 10 + y * 0.8).toFixed(0)}" rx="${(18 + r * 30).toFixed(0)}" ry="${(5 + r * 8).toFixed(0)}" fill="#4f5461" opacity=".55"/>`).join('')
      );
    case 'hall':
      return (
        `${gradient('bd-wall', ['#7d7062', '#5d5246'])}<rect width="${w}" height="${g}" fill="url(#bd-wall)"/>` +
        Array.from({ length: Math.ceil(g / 50) }, (_, row) =>
          Array.from({ length: Math.ceil(w / 110) + 1 }, (_, col) => `<rect x="${col * 110 - (row % 2) * 55}" y="${row * 50}" width="110" height="50" fill="none" stroke="#4d443a" stroke-width="2" opacity=".5"/>`).join(''),
        ).join('') +
        [0.22, 0.78].map((f) => `<path d="M${w * f - 50} ${h * 0.06} L${w * f + 50} ${h * 0.06} L${w * f + 50} ${h * 0.42} L${w * f} ${h * 0.36} L${w * f - 50} ${h * 0.42} Z" fill="#a8323a" stroke="#6e1f25" stroke-width="3"/><circle cx="${w * f}" cy="${h * 0.2}" r="18" fill="#e3b23c"/>`).join('') +
        ground('#6b5644', '#4a3b2f')
      );
    case 'plain':
      return sky(['#f7f5f0', '#e8e4da']) + `<rect x="0" y="${g}" width="${w}" height="${h - g}" fill="#ddd7ca"/>`;
  }
}

// ------------------------------------------------------------------------------------------------------------ scene

/** The parts a scene can use, for the tool's description and its errors. */
export function sceneCatalog(): string {
  return [
    `Characters: ${SCENE_CHARACTERS.join(', ')}.`,
    `They wear: ${SCENE_WEAR.join(', ')}. They hold (up to two): ${SCENE_HOLD.join(', ')}.`,
    `Scenery: ${SCENE_SCENERY.join(', ')}.`,
    `Backdrops: ${SCENE_BACKDROPS.join(', ')}.`,
  ].join(' ');
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Draws a scene as one self-contained SVG. Unknown parts are an error that lists the ones there are. */
export function renderScene(scene: Scene): string {
  const [w, h] = SCENE_SHAPES[scene.shape ?? 'wide'];
  if (!SCENE_BACKDROPS.includes(scene.backdrop)) throw new Error(`No backdrop is called "${scene.backdrop}". ${sceneCatalog()}`);
  const placed = scene.items.map((it, i) => {
    const ch = CHARACTERS[it.part];
    const sc = SCENERY[it.part];
    if (!ch && !sc) throw new Error(`No part is called "${it.part}". ${sceneCatalog()}`);
    if (it.wear && !WEAR[it.wear]) throw new Error(`Nothing to wear is called "${it.wear}": ${SCENE_WEAR.join(', ')}.`);
    for (const held of it.hold ?? []) if (!HOLD[held]) throw new Error(`Nothing to hold is called "${held}": ${SCENE_HOLD.join(', ')}.`);
    const sky = !!sc?.sky;
    const y = clamp(it.y ?? (sky ? 22 : 86), 0, 100);
    return { it, ch, sc, sky, y, i };
  });
  // Far things first: what stands lower in the picture is nearer, and drawn over what is behind it.
  placed.sort((a, b) => (a.sky === b.sky ? a.y - b.y || a.i - b.i : a.sky ? -1 : 1));
  // Names stay clear of the caption's band.
  const floor = scene.caption?.trim() ? h * 0.92 : h;

  const parts = placed.map(({ it, ch, sc, sky, y }) => {
    const def = ch ?? sc!;
    const k = kit(hex(it.color, def.color), hex(it.accent, def.accent));
    const size = (clamp(it.size ?? (ch ? 34 : sc!.size), 2, 100) / 100) * h;
    const px = (clamp(it.x, 0, 100) / 100) * w;
    const py = (y / 100) * h;
    const s = size / 100;
    const at = it.flip ? `translate(${(px + size / 2).toFixed(1)} ${(py - size).toFixed(1)}) scale(${-s} ${s})` : `translate(${(px - size / 2).toFixed(1)} ${(py - size).toFixed(1)}) scale(${s})`;
    let art: string;
    if (ch) {
      const hand = (n: 0 | 1) => {
        const held = it.hold?.[n];
        return held ? `<g transform="translate(${ch.hands[n][0]} ${ch.hands[n][1]})">${HOLD[held](k)}</g>` : '';
      };
      const hat = it.wear ? `<g transform="translate(${ch.head.x} ${ch.head.y}) scale(${ch.head.r / 14})">${WEAR[it.wear](k)}</g>` : '';
      art = hand(1) + ch.back(k) + ch.body(k) + hat + hand(0) + ch.front(k);
    } else art = sc!.draw(k);
    const shadow = sky ? '' : `<ellipse cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" rx="${(size * 0.3).toFixed(1)}" ry="${(size * 0.045).toFixed(1)}" fill="#000" opacity=".16"/>`;
    const label = it.label?.trim()
      ? (() => {
          const text = esc(it.label.trim().slice(0, 40));
          const fs = Math.round(h * 0.026);
          const lw = text.length * fs * 0.56 + fs * 1.4;
          const ly = clamp(py + fs * 0.6, 0, floor - fs * 1.7);
          return `<g><rect x="${(px - lw / 2).toFixed(1)}" y="${ly.toFixed(1)}" width="${lw.toFixed(1)}" height="${(fs * 1.55).toFixed(1)}" rx="${(fs * 0.78).toFixed(1)}" fill="#ffffff" opacity=".9"/><text x="${px.toFixed(1)}" y="${(ly + fs * 1.1).toFixed(1)}" text-anchor="middle" font-size="${fs}" font-weight="600" fill="#2b2d31">${text}</text></g>`;
        })()
      : '';
    return `${shadow}<g transform="${at}">${art}</g>${label}`;
  });

  const font = `font-family="'Segoe UI', 'Helvetica Neue', Arial, sans-serif"`;
  const title = scene.title?.trim()
    ? `<text x="${w / 2}" y="${(h * 0.09).toFixed(0)}" text-anchor="middle" font-size="${(h * 0.06).toFixed(0)}" font-weight="700" fill="#ffffff" stroke="#1d1f24" stroke-opacity=".55" stroke-width="${(h * 0.008).toFixed(1)}" paint-order="stroke" stroke-linejoin="round">${esc(scene.title.trim().slice(0, 80))}</text>`
    : '';
  const caption = scene.caption?.trim()
    ? `<rect x="0" y="${(h * 0.92).toFixed(0)}" width="${w}" height="${(h * 0.08).toFixed(0)}" fill="#000" opacity=".35"/><text x="${w / 2}" y="${(h * 0.97).toFixed(0)}" text-anchor="middle" font-size="${(h * 0.03).toFixed(0)}" fill="#ffffff">${esc(scene.caption.trim().slice(0, 160))}</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" ${font}><defs/>${backdrop(scene.backdrop, w, h, { moon: !scene.items.some((it) => it.part === 'moon') })}${parts.join('')}${title}${caption}</svg>`;
}
