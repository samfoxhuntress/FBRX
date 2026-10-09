import { useEffect } from 'react';
import type { Settings, Texture, ThemePreset, Tier } from '@fbrx/shared';

/** Swatch colors for the preset picker: [page, sidebar, accent, glow] for light and dark. */
export const PRESETS: Array<{ id: ThemePreset; name: string; light: [string, string, string, string?]; dark: [string, string, string, string?]; texture: Exclude<Texture, 'theme'> }> = [
  { id: 'fabrics', name: 'Fabrics', light: ['#f6f2ea', '#fbf7f0', '#a35f08', '#c7c7c4'], dark: ['#100e0b', '#1a1714', '#f0a530', '#b4b4b0'], texture: 'weave' },
  { id: 'tropical', name: 'Tropical', light: ['#fff6ec', '#fff3e4', '#e8590c', '#ff9f6b'], dark: ['#150b07', '#180d08', '#ffa23a', '#ff4f81'], texture: 'palms' },
  { id: 'neon', name: 'Neon Grid', light: ['#eef6fa', '#f3f9fc', '#0090b8', '#5ccfff'], dark: ['#03060c', '#050a12', '#00e5ff', '#0066ff'], texture: 'grid' },
  { id: 'ember', name: 'Ember', light: ['#f7f1ee', '#fcf7f4', '#c2410c', '#ef9a7a'], dark: ['#110c0a', '#1b1412', '#ff6b3d', '#7c2410'], texture: 'grain' },
  { id: 'midnight', name: 'Midnight', light: ['#eef0f8', '#f6f7fd', '#4f46e5', '#a5b0f5'], dark: ['#0a0d1a', '#121730', '#8b93ff', '#2b2f8f'], texture: 'dots' },
  { id: 'graphite', name: 'Graphite', light: ['#f4f4f1', '#fbfbf9', '#2a78d6', '#b9c2cf'], dark: ['#0d0d0d', '#1a1a19', '#3987e5', '#344055'], texture: 'carbon' },
  { id: 'ocean', name: 'Ocean', light: ['#edf5f6', '#f5fafb', '#0e7c86', '#8fd3d8'], dark: ['#071417', '#0e1f23', '#2cc4c4', '#0d5263'], texture: 'waves' },
  { id: 'forest', name: 'Forest', light: ['#eff4ee', '#f6faf5', '#15803d', '#9fd6ae'], dark: ['#0b120d', '#131d15', '#4cc77a', '#164a2c'], texture: 'linen' },
  { id: 'orchid', name: 'Orchid', light: ['#f6f0f8', '#fbf7fc', '#9333ea', '#e2b3f2'], dark: ['#120c16', '#1c1422', '#d07af0', '#5a1f7a'], texture: 'grain' },
  { id: 'paper', name: 'Paper', light: ['#f1eadb', '#f7f0e1', '#8a5a2b', '#d9b98c'], dark: ['#1a1611', '#231e17', '#d9a066', '#5c3e1f'], texture: 'grain' },
  { id: 'contrast', name: 'High contrast', light: ['#ffffff', '#ffffff', '#0040c0'], dark: ['#000000', '#0a0a0a', '#ffd400'], texture: 'none' },
];

export const TEXTURE_NAMES: Record<Exclude<Texture, 'theme'>, string> = {
  none: 'None',
  weave: 'Weave',
  linen: 'Linen',
  grain: 'Grain',
  grid: 'Grid',
  dots: 'Dots',
  carbon: 'Carbon fiber',
  waves: 'Waves',
  palms: 'Palms',
};

/** Palm fronds: leaflets along two curved stems (one tile). */
function palmsPath(): string {
  const frond = (x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, len: number) => {
    let d = `M${x0} ${y0}Q${cx} ${cy} ${x1} ${y1}`;
    for (let i = 1; i < 14; i++) {
      const t = i / 14;
      const x = (1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t * t * x1;
      const y = (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t * t * y1;
      const dx = 2 * (1 - t) * (cx - x0) + 2 * t * (x1 - cx);
      const dy = 2 * (1 - t) * (cy - y0) + 2 * t * (y1 - cy);
      const n = Math.hypot(dx, dy);
      const l = len * Math.sin(Math.PI * Math.min(1, t * 1.15));
      for (const side of [1, -1]) {
        // Leaflets sweep back toward the stem's base.
        const ex = x + (-dy / n) * l * side - (dx / n) * l * 0.55;
        const ey = y + (dx / n) * l * side - (dy / n) * l * 0.55;
        d += `M${x.toFixed(1)} ${y.toFixed(1)}L${ex.toFixed(1)} ${ey.toFixed(1)}`;
      }
    }
    return d;
  };
  return frond(10, 150, 40, 70, 120, 40, 22) + frond(170, 170, 150, 110, 90, 100, 16);
}

/**
 * The background texture as a CSS image, drawn in the theme's ink at the chosen strength (null for none). SVG tiles,
 * so they stay sharp at any zoom.
 */
/** The strongest a texture gets (100 %): well short of the old "bold", so a texture never shouts. */
const MAX_TEXTURE = 1.2;

export function textureImage(t: Exclude<Texture, 'theme'>, mode: 'light' | 'dark', strength: number = 50, accent = '#00e5ff', scale = 1): string | null {
  if (t === 'none' || strength <= 0) return null;
  const k = (Math.min(100, strength) / 100) * MAX_TEXTURE * scale;
  const ink = (a: number) => (mode === 'dark' ? `rgba(255,255,255,${(a * k).toFixed(3)})` : `rgba(60,40,20,${(a * k * 1.15).toFixed(3)})`);
  const neon = (a: number) => {
    const [r, g, b] = hexToRgb(/^#[0-9a-f]{6}$/i.test(accent) ? accent : '#00e5ff');
    return `rgba(${r},${g},${b},${Math.min(1, a * k * (mode === 'dark' ? 1 : 0.8)).toFixed(3)})`;
  };
  let svg: string;
  switch (t) {
    case 'weave': {
      // A small basket weave in 10 px blocks: two threads across, then two down, each with a soft shadow edge.
      const B = 10;
      let d = '';
      let e = '';
      for (const [bx, by, across] of [
        [0, 0, true],
        [B, 0, false],
        [0, B, false],
        [B, B, true],
      ] as const) {
        for (let i = 0; i < 2; i++) {
          const o = 1 + i * 5;
          if (across) {
            d += `M${bx} ${by + o}h${B}v3h-${B}z`;
            e += `M${bx} ${by + o + 2.6}h${B}`;
          } else {
            d += `M${bx + o} ${by}h3v${B}h-3z`;
            e += `M${bx + o + 2.6} ${by}v${B}`;
          }
        }
      }
      svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${B * 2}" height="${B * 2}"><path d="${d}" fill="${ink(0.055)}"/><path d="${e}" stroke="${ink(0.045)}" stroke-width=".8"/></svg>`;
      break;
    }
    case 'linen':
      svg = `<svg xmlns="http://www.w3.org/2000/svg" width="6" height="6"><path d="M0 .5H6M0 3.5H6" stroke="${ink(0.05)}" stroke-width=".7"/><path d="M.5 0V6M3.5 0V6" stroke="${ink(0.035)}" stroke-width=".6"/></svg>`;
      break;
    case 'grain':
      svg = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 ${mode === 'dark' ? 1 : 0.2} 0 0 0 0 ${mode === 'dark' ? 1 : 0.15} 0 0 0 0 ${mode === 'dark' ? 1 : 0.1} 0 0 0 ${(0.11 * k).toFixed(3)} 0"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>`;
      break;
    case 'grid': {
      // A neon grid in the accent color: fine lines every 24 px, a glowing major line every 96 px.
      let minor = '';
      for (let i = 24; i < 96; i += 24) minor += `M0 ${i + 0.5}H96M${i + 0.5} 0V96`;
      svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><defs><filter id="g" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.6"/></filter></defs><path d="${minor}" stroke="${neon(0.075)}" stroke-width="1"/><path d="M0 1H96M1 0V96" stroke="${neon(0.32)}" stroke-width="2.4" filter="url(#g)"/><path d="M0 1H96M1 0V96" stroke="${neon(0.2)}" stroke-width="1"/><circle cx="1" cy="1" r="1.6" fill="${neon(0.45)}"/></svg>`;
      break;
    }
    case 'dots':
      svg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14"><circle cx="7" cy="7" r="1.1" fill="${ink(0.09)}"/></svg>`;
      break;
    case 'carbon':
      svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path d="M0 0h5v5H0zM5 5h5v5H5z" fill="${ink(0.05)}"/><path d="M0 0h5L0 5zM5 5h5L5 10z" fill="${ink(0.035)}"/></svg>`;
      break;
    case 'waves':
      svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="20"><path d="M0 10Q12 1 24 10T48 10" fill="none" stroke="${ink(0.07)}" stroke-width="1.3"/></svg>`;
      break;
    case 'palms':
      svg = `<svg xmlns="http://www.w3.org/2000/svg" width="190" height="190"><path d="${palmsPath()}" fill="none" stroke="${ink(0.06)}" stroke-width="1.6" stroke-linecap="round"/></svg>`;
      break;
  }
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** The accent in use (a custom one, or the theme's), for textures drawn in the accent color. */
export function themeAccent(a: Pick<Settings['appearance'], 'accent' | 'preset'> | undefined, mode: 'light' | 'dark'): string {
  if (a?.accent && /^#[0-9a-f]{6}$/i.test(a.accent)) return a.accent;
  const p = PRESETS.find((x) => x.id === (a?.preset ?? 'fabrics')) ?? PRESETS[0];
  return (mode === 'dark' ? p.dark : p.light)[2];
}

/** The texture in use: the theme's own unless one is picked. */
export function resolvedTexture(a: Pick<Settings['appearance'], 'texture' | 'preset'> | undefined): Exclude<Texture, 'theme'> {
  const t = a?.texture ?? 'theme';
  return t === 'theme' ? (PRESETS.find((p) => p.id === (a?.preset ?? 'fabrics'))?.texture ?? 'none') : t;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Relative luminance (WCAG). */
function luminance([r, g, b]: [number, number, number]) {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function shade(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const t = amount < 0 ? 0 : 255;
  const p = Math.abs(amount);
  const mix = (c: number) => Math.round((t - c) * p + c);
  return `#${[mix(r), mix(g), mix(b)].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Lite effects (no frosted glass, glows or decorative animation) on request, and automatically on computers with
 * four or fewer processor threads or 4 GB of memory or less, where blurring big panels costs real time.
 */
export function resolvedEffects(effects: Settings['appearance']['effects']): 'full' | 'light' {
  if (effects !== 'auto') return effects;
  const memGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  return (navigator.hardwareConcurrency || 8) <= 4 || memGB <= 4 ? 'light' : 'full';
}

export function resolvedMode(theme: Settings['general']['theme']): 'light' | 'dark' {
  if (theme === 'system') return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return theme;
}

/**
 * Applies appearance settings to <html> (presets live in theme.css). Endpoint Basic gets the plain look: light or
 * dark, no theme colors, gradients or textures (those come with Ultra). `tier` is undefined while the license loads.
 */
export function useAppearance(settings: Settings | undefined, tier: Tier | undefined) {
  const theme = settings?.general.theme ?? 'dark';
  const basic = tier === 'basic';
  const a = settings && basic ? { ...settings.appearance, preset: 'graphite' as const, texture: 'none' as const, accent: '' } : settings?.appearance;
  useEffect(() => {
    // Wait for the license, so Basic never flashes the Ultra look (or the other way round).
    if (!tier) return;
    const root = document.documentElement;
    const apply = () => {
      const mode = resolvedMode(theme);
      root.dataset.theme = mode;
      root.dataset.edition = basic ? 'basic' : 'ultra';
      root.dataset.preset = a?.preset ?? 'fabrics';
      root.dataset.density = a?.density ?? 'comfortable';
      root.dataset.radius = a?.radius ?? 'rounded';
      const texture = resolvedTexture(a);
      root.dataset.texture = texture;
      const img = textureImage(texture, mode, a?.textureStrength, themeAccent(a, mode));
      // The sidebar and top bar get a much fainter copy, so the pattern frames the page without crowding the menu.
      const nav = textureImage(texture, mode, a?.textureStrength, themeAccent(a, mode), 0.35);
      if (img) root.style.setProperty('--texture', img);
      else root.style.removeProperty('--texture');
      if (nav) root.style.setProperty('--texture-nav', nav);
      else root.style.removeProperty('--texture-nav');
      root.dataset.effects = resolvedEffects(a?.effects ?? 'auto');
      root.dataset.motion = a?.reduceMotion ? 'reduce' : 'full';
      root.style.zoom = String(a?.fontScale ?? 1);
      const accent = a?.accent;
      if (accent && /^#[0-9a-f]{6}$/i.test(accent)) {
        const rgb = hexToRgb(accent);
        const light = luminance(rgb) > 0.4;
        root.style.setProperty('--accent', accent);
        root.style.setProperty('--accent-hover', shade(accent, mode === 'dark' ? 0.15 : -0.15));
        root.style.setProperty('--accent-ink', light ? '#111111' : '#ffffff');
        root.style.setProperty('--accent-wash', `rgba(${rgb.join(',')}, ${mode === 'dark' ? 0.16 : 0.11})`);
        root.style.setProperty('--focus', `rgba(${rgb.join(',')}, 0.45)`);
      } else {
        for (const p of ['--accent', '--accent-hover', '--accent-ink', '--accent-wash', '--focus']) root.style.removeProperty(p);
      }
    };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme, tier, a?.preset, a?.density, a?.radius, a?.texture, a?.textureStrength, a?.reduceMotion, a?.fontScale, a?.accent, a?.effects]);
}

const STARTUP_VOLUME = 0.85;
/** The start-up sound eases in over its first half second instead of starting at full volume. */
const STARTUP_FADE_IN_SECONDS = 0.5;

/** The FBRX start-up sound (from the FBRX intro), like a computer's chime when it boots. */
export function playStartupSound(): void {
  let audio: HTMLAudioElement;
  try {
    audio = new Audio('./sounds/startup.ogg');
  } catch {
    return; // audio unavailable
  }
  try {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    ctx.createMediaElementSource(audio).connect(gain).connect(ctx.destination);
    // Slow at first, then quicker (a squared curve), so the start sounds gentle rather than clipped.
    const curve = Float32Array.from({ length: 32 }, (_, i) => STARTUP_VOLUME * (i / 31) ** 2);
    audio.addEventListener('playing', () => gain.gain.setValueCurveAtTime(curve, ctx.currentTime, STARTUP_FADE_IN_SECONDS), { once: true });
    const close = () => void ctx.close().catch(() => undefined);
    audio.addEventListener('ended', close, { once: true });
    audio.addEventListener('error', close, { once: true });
    void ctx
      .resume()
      .then(() => audio.play())
      .catch(close);
  } catch {
    // No Web Audio: play it as before, without the fade.
    audio.volume = STARTUP_VOLUME;
    void audio.play().catch(() => undefined);
  }
}
