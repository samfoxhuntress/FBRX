import type { RemoteInput, RemoteKey, RemoteModifier } from '@fbrx/shared';

/**
 * Remote control's mouse and keyboard, turned into what each system's helper takes: Windows SendInput lines, macOS
 * Quartz event commands, and xdotool runs on Linux (X11). No Electron here, so it can be tested anywhere.
 */

// ------------------------------------------------------------------------------------------------- the keys

export const WIN_VK: Record<string, number> = {
  Enter: 0x0d, Tab: 0x09, Backspace: 0x08, Escape: 0x1b, Delete: 0x2e, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28, Space: 0x20, ctrl: 0x11, alt: 0x12, shift: 0x10, meta: 0x5b,
};
const MAC_CODE: Record<string, number> = {
  Enter: 36, Tab: 48, Backspace: 51, Escape: 53, Delete: 117, Home: 115, End: 119, PageUp: 116, PageDown: 121, ArrowLeft: 123, ArrowRight: 124,
  ArrowDown: 125, ArrowUp: 126, Space: 49, F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17, '1': 18, '2': 19, '3': 20, '4': 21, '6': 22,
  '5': 23, '9': 25, '7': 26, '8': 28, '0': 29, o: 31, u: 32, i: 34, p: 35, l: 37, j: 38, k: 40, n: 45, m: 46,
};
const MAC_FLAG: Record<RemoteModifier, number> = { shift: 0x20000, ctrl: 0x40000, alt: 0x80000, meta: 0x100000 };
const X_KEY: Record<string, string> = {
  Enter: 'Return', Tab: 'Tab', Backspace: 'BackSpace', Escape: 'Escape', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'Prior', PageDown: 'Next',
  ArrowLeft: 'Left', ArrowUp: 'Up', ArrowRight: 'Right', ArrowDown: 'Down', Space: 'space',
};
const X_MOD: Record<RemoteModifier, string> = { ctrl: 'ctrl', alt: 'alt', shift: 'shift', meta: 'super' };

export function winVk(key: RemoteKey): number {
  if (WIN_VK[key]) return WIN_VK[key];
  if (/^F([1-9]|1[0-2])$/.test(key)) return 0x6f + Number(key.slice(1));
  return key.toUpperCase().charCodeAt(0);
}

export function xKey(key: RemoteKey, mods: RemoteModifier[]): string {
  return [...mods.map((m) => X_MOD[m]), X_KEY[key] ?? key].join('+');
}

// ------------------------------------------------------------------------------------------------- Windows



/** The Windows lines for these events ("m x y flags data", "k vk scan flags"), in absolute virtual-desktop units. */
export function windowsLines(events: RemoteInput[], d: { x: number; y: number; width: number; height: number }, desk: { x: number; y: number; width: number; height: number }): string[] {
  const out: string[] = [];
  const abs = (x: number, y: number) => {
    // 1 is the last pixel, not the one past it.
    const px = d.x + x * (d.width - 1);
    const py = d.y + y * (d.height - 1);
    return [Math.round(((px - desk.x) * 65535) / Math.max(1, desk.width - 1)), Math.round(((py - desk.y) * 65535) / Math.max(1, desk.height - 1))];
  };
  const MOVE = 0x0001 | 0x4000 | 0x8000;
  const BTN: Record<string, [number, number]> = { left: [0x0002, 0x0004], right: [0x0008, 0x0010], middle: [0x0020, 0x0040] };
  for (const e of events) {
    if (e.t === 'move') out.push(`m ${abs(e.x, e.y).join(' ')} ${MOVE} 0`);
    else if (e.t === 'down' || e.t === 'up') out.push(`m ${abs(e.x, e.y).join(' ')} ${MOVE} 0`, `m 0 0 ${BTN[e.button][e.t === 'down' ? 0 : 1]} 0`);
    else if (e.t === 'scroll') out.push(`m ${abs(e.x, e.y).join(' ')} ${MOVE} 0`, `m 0 0 ${0x0800} ${Math.round(-e.dy * 120)}`);
    else if (e.t === 'text') for (const unit of e.text.replace(/\r?\n/g, '\r')) out.push(`k 0 ${unit.charCodeAt(0)} 4`, `k 0 ${unit.charCodeAt(0)} 6`);
    else if (e.t === 'key') {
      const vk = winVk(e.key);
      out.push(...e.mods.map((m) => `k ${WIN_VK[m]} 0 0`), `k ${vk} 0 0`, `k ${vk} 0 2`, ...[...e.mods].reverse().map((m) => `k ${WIN_VK[m]} 0 2`));
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------- macOS



/** The macOS commands for these events (global points; drags while a button is held). */
export function macLines(events: RemoteInput[], d: { x: number; y: number; width: number; height: number }, held: Set<string>): string[] {
  const out: object[] = [];
  const at = (x: number, y: number) => ({ x: d.x + x * (d.width - 1), y: d.y + y * (d.height - 1) });
  const DOWN: Record<string, [number, number, number]> = { left: [1, 2, 0], right: [3, 4, 1], middle: [25, 26, 2] };
  for (const e of events) {
    if (e.t === 'move') {
      const drag = held.has('left') ? 6 : held.has('right') ? 7 : held.has('middle') ? 27 : 5;
      out.push({ t: 'mouse', type: drag, ...at(e.x, e.y), button: held.has('right') ? 1 : held.has('middle') ? 2 : 0 });
    } else if (e.t === 'down' || e.t === 'up') {
      const [down, up, button] = DOWN[e.button];
      if (e.t === 'down') held.add(e.button);
      else held.delete(e.button);
      out.push({ t: 'mouse', type: e.t === 'down' ? down : up, ...at(e.x, e.y), button });
    } else if (e.t === 'scroll') out.push({ t: 'scroll', dy: Math.round(-e.dy) });
    else if (e.t === 'text') out.push({ t: 'text', text: e.text });
    else if (e.t === 'key' && MAC_CODE[e.key] !== undefined) out.push({ t: 'key', code: MAC_CODE[e.key], flags: e.mods.reduce((f, m) => f | MAC_FLAG[m], 0) });
  }
  return out.map((o) => JSON.stringify(o));
}

// ------------------------------------------------------------------------------------------------- Linux (X11)

/** xdotool runs, in order: mouse and keys chained in one run, each typed text in its own. */
export function xdotoolRuns(events: RemoteInput[], d: { x: number; y: number; width: number; height: number; scale: number }): string[][] {
  const runs: string[][] = [];
  let chain: string[] = [];
  const flush = () => {
    if (chain.length) runs.push(chain);
    chain = [];
  };
  const at = (x: number, y: number) => [String(Math.round((d.x + x * (d.width - 1)) * d.scale)), String(Math.round((d.y + y * (d.height - 1)) * d.scale))];
  const BTN: Record<string, string> = { left: '1', middle: '2', right: '3' };
  for (const e of events) {
    if (e.t === 'move') chain.push('mousemove', ...at(e.x, e.y));
    else if (e.t === 'down' || e.t === 'up') chain.push('mousemove', ...at(e.x, e.y), e.t === 'down' ? 'mousedown' : 'mouseup', BTN[e.button]);
    else if (e.t === 'scroll' && Math.round(e.dy)) chain.push('mousemove', ...at(e.x, e.y), 'click', '--repeat', String(Math.min(Math.abs(Math.round(e.dy)), 50)), e.dy > 0 ? '5' : '4');
    else if (e.t === 'key') chain.push('key', '--clearmodifiers', xKey(e.key, e.mods));
    else if (e.t === 'text') {
      flush();
      runs.push(['type', '--clearmodifiers', '--delay', '2', '--', e.text]);
    }
  }
  flush();
  return runs;
}
