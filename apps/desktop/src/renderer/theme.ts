import { useEffect } from 'react';
import type { Settings, ThemePreset } from '@fbrx/shared';

/** Swatch colours for the preset picker: [page, sidebar, accent] for light and dark. */
export const PRESETS: Array<{ id: ThemePreset; name: string; light: [string, string, string]; dark: [string, string, string] }> = [
  { id: 'fabrics', name: 'Fabrics', light: ['#f6f2ea', '#fbf7f0', '#a35f08'], dark: ['#100e0b', '#1a1714', '#f0a530'] },
  { id: 'ember', name: 'Ember', light: ['#f7f1ee', '#fcf7f4', '#c2410c'], dark: ['#110c0a', '#1b1412', '#ff6b3d'] },
  { id: 'midnight', name: 'Midnight', light: ['#eef0f8', '#f6f7fd', '#4f46e5'], dark: ['#0a0d1a', '#121730', '#8b93ff'] },
  { id: 'graphite', name: 'Graphite', light: ['#f4f4f1', '#fbfbf9', '#2a78d6'], dark: ['#0d0d0d', '#1a1a19', '#3987e5'] },
  { id: 'ocean', name: 'Ocean', light: ['#edf5f6', '#f5fafb', '#0e7c86'], dark: ['#071417', '#0e1f23', '#2cc4c4'] },
  { id: 'forest', name: 'Forest', light: ['#eff4ee', '#f6faf5', '#15803d'], dark: ['#0b120d', '#131d15', '#4cc77a'] },
  { id: 'orchid', name: 'Orchid', light: ['#f6f0f8', '#fbf7fc', '#9333ea'], dark: ['#120c16', '#1c1422', '#d07af0'] },
  { id: 'paper', name: 'Paper', light: ['#f1eadb', '#f7f0e1', '#8a5a2b'], dark: ['#1a1611', '#231e17', '#d9a066'] },
  { id: 'contrast', name: 'High contrast', light: ['#ffffff', '#ffffff', '#0040c0'], dark: ['#000000', '#0a0a0a', '#ffd400'] },
];

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

export function resolvedMode(theme: Settings['general']['theme']): 'light' | 'dark' {
  if (theme === 'system') return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return theme;
}

/** Applies appearance settings to <html> (presets live in theme.css). */
export function useAppearance(settings: Settings | undefined) {
  const theme = settings?.general.theme ?? 'dark';
  const a = settings?.appearance;
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const mode = resolvedMode(theme);
      root.dataset.theme = mode;
      root.dataset.preset = a?.preset ?? 'fabrics';
      root.dataset.density = a?.density ?? 'comfortable';
      root.dataset.radius = a?.radius ?? 'rounded';
      root.dataset.texture = a?.texture ?? 'none';
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
  }, [theme, a?.preset, a?.density, a?.radius, a?.texture, a?.reduceMotion, a?.fontScale, a?.accent]);
}

/** A short two-note chime for the splash (Web Audio, no files). */
export function playChime() {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;
    [523.25, 783.99].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0, now + i * 0.12);
      g.gain.linearRampToValueAtTime(0.12, now + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.6);
      o.connect(g).connect(ctx.destination);
      o.start(now + i * 0.12);
      o.stop(now + i * 0.12 + 0.65);
    });
    setTimeout(() => void ctx.close(), 1200);
  } catch {
    /* audio unavailable */
  }
}
