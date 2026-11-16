import { describe, expect, it } from 'vitest';
import { macLines, windowsLines, winVk, xdotoolRuns, xKey } from '../src/main/remote-input';

const screen = { x: 0, y: 0, width: 1920, height: 1080 };

describe('remote mouse and keyboard on each system', () => {
  it('Windows: absolute virtual-desktop positions, buttons, wheel, Unicode text and shortcuts', () => {
    const lines = windowsLines(
      [
        { t: 'move', x: 1, y: 1 },
        { t: 'down', x: 0, y: 0, button: 'right' },
        { t: 'scroll', x: 0.5, y: 0.5, dy: 2 },
        { t: 'text', text: 'é' },
        { t: 'key', key: 'c', mods: ['ctrl'] },
      ],
      screen,
      screen,
    );
    expect(lines[0]).toBe(`m 65535 65535 ${0x0001 | 0x4000 | 0x8000} 0`);
    expect(lines[2]).toBe('m 0 0 8 0');
    expect(lines[4]).toBe('m 0 0 2048 -240');
    expect(lines.slice(5, 7)).toEqual(['k 0 233 4', 'k 0 233 6']);
    expect(lines.slice(7)).toEqual(['k 17 0 0', `k ${'C'.charCodeAt(0)} 0 0`, `k ${'C'.charCodeAt(0)} 0 2`, 'k 17 0 2']);
    expect(winVk('F5')).toBe(0x74);
  });

  it('macOS: points on the screen, drags while a button is held, key codes with modifier flags', () => {
    const held = new Set<string>();
    const out = macLines([{ t: 'down', x: 0.5, y: 0.5, button: 'left' }, { t: 'move', x: 0.6, y: 0.5 }, { t: 'up', x: 0.6, y: 0.5, button: 'left' }, { t: 'key', key: 'v', mods: ['meta'] }], { x: 0, y: 0, width: 1000, height: 800 }, held).map((l) => JSON.parse(l));
    expect(out[0]).toEqual({ t: 'mouse', type: 1, x: 499.5, y: 399.5, button: 0 });
    expect(out[1].type).toBe(6);
    expect(out[2].type).toBe(2);
    expect(out[3]).toEqual({ t: 'key', code: 9, flags: 0x100000 });
    expect(held.size).toBe(0);
  });

  it('Linux: one xdotool run for mouse and keys, typed text in its own (after --)', () => {
    const runs = xdotoolRuns([{ t: 'move', x: 0.5, y: 0.5 }, { t: 'key', key: 'Enter', mods: ['ctrl', 'shift'] }, { t: 'text', text: '--help; rm -rf ~' }, { t: 'scroll', x: 0, y: 0, dy: -3 }], { ...screen, scale: 2 });
    expect(runs[0]).toEqual(['mousemove', '1919', '1079', 'key', '--clearmodifiers', 'ctrl+shift+Return']);
    expect(runs[1]).toEqual(['type', '--clearmodifiers', '--delay', '2', '--', '--help; rm -rf ~']);
    expect(runs[2]).toEqual(['mousemove', '0', '0', 'click', '--repeat', '3', '4']);
    expect(xKey('ArrowLeft', ['meta'])).toBe('super+Left');
  });
});
