import { describe, expect, it } from 'vitest';
import { keyFor, keysFor, typeKeys } from '../src/type-text';

describe('pasting into a virtual machine', () => {
  it('finds each character’s key on a US keyboard, with Shift where it needs it', () => {
    expect(keyFor('a')).toEqual({ keysym: 0x61, code: 'KeyA', shift: false });
    expect(keyFor('Q')).toEqual({ keysym: 0x51, code: 'KeyQ', shift: true });
    expect(keyFor('7')).toEqual({ keysym: 0x37, code: 'Digit7', shift: false });
    expect(keyFor('@')).toEqual({ keysym: 0x40, code: 'Digit2', shift: true });
    expect(keyFor(')')).toEqual({ keysym: 0x29, code: 'Digit0', shift: true });
    expect(keyFor('|')).toEqual({ keysym: 0x7c, code: 'Backslash', shift: true });
    expect(keyFor('/')).toEqual({ keysym: 0x2f, code: 'Slash', shift: false });
    expect(keyFor('\n')).toEqual({ keysym: 0xff0d, code: 'Enter', shift: false });
    expect(keyFor('é')).toBeNull();
  });

  it('types every printable ASCII character, and counts what it cannot type', () => {
    const ascii = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');
    expect(keysFor(ascii)).toMatchObject({ skipped: 0 });
    expect(keysFor(ascii).keys).toHaveLength(95);
    const { keys, skipped } = keysFor('café 🙂\r\nok');
    expect(skipped).toBe(2);
    expect(keys.map((k) => k.code)).toEqual(['KeyC', 'KeyA', 'KeyF', 'Space', 'Enter', 'KeyO', 'KeyK']);
  });

  it('presses and releases each key, holding Shift around shifted ones, and stops when asked', async () => {
    const sent: string[] = [];
    const rfb = { sendKey: (_: number, code: string | null, down?: boolean) => void sent.push(`${code}${down ? '↓' : '↑'}`) };
    const now = { keyMs: 0, pauseMs: 0, lineMs: 0 };
    expect(await typeKeys(rfb, keysFor('aB').keys, { pace: now })).toBe(2);
    expect(sent).toEqual(['KeyA↓', 'KeyA↑', 'ShiftLeft↓', 'KeyB↓', 'KeyB↑', 'ShiftLeft↑']);

    // Shift is held over a run that needs it, let go before a key that does not, and never left down.
    sent.length = 0;
    await typeKeys(rfb, keysFor('HI there!').keys, { pace: now });
    expect(sent.filter((x) => x.startsWith('Shift'))).toEqual(['ShiftLeft↓', 'ShiftLeft↑', 'ShiftLeft↓', 'ShiftLeft↑']);
    expect(sent.slice(0, 6)).toEqual(['ShiftLeft↓', 'KeyH↓', 'KeyH↑', 'KeyI↓', 'KeyI↑', 'ShiftLeft↑']);
    expect(sent.at(-1)).toBe('ShiftLeft↑');

    const stop = new AbortController();
    stop.abort();
    expect(await typeKeys(rfb, keysFor('abc').keys, { pace: now, signal: stop.signal })).toBe(0);
    // Stopped halfway through capitals: Shift is let go.
    sent.length = 0;
    const half = new AbortController();
    await typeKeys({ sendKey: (s, c, d) => (rfb.sendKey(s, c, d), sent.length === 4 && half.abort()) }, keysFor('ABCDEF').keys, { pace: now, signal: half.signal });
    expect(sent.at(-1)).toBe('ShiftLeft↑');
  });

  it('types at a pace the machine can take: a breath every few dozen keys and after each line', async () => {
    const at: number[] = [];
    const t0 = Date.now();
    const rfb = { sendKey: (_: number, code: string | null, down?: boolean) => void (down && code !== 'ShiftLeft' && at.push(Date.now() - t0)) };
    await typeKeys(rfb, keysFor('abcd\nef').keys, { pace: { keyMs: 5, everyKeys: 3, pauseMs: 60, lineMs: 40 } });
    const gaps = at.slice(1).map((t, i) => t - at[i]!);
    // a→b, b→c: one key apart; c→d: the breath after three keys; Enter→e: the line's pause.
    expect(gaps[0]).toBeLessThan(40);
    expect(gaps[2]).toBeGreaterThanOrEqual(60);
    expect(gaps[4]).toBeGreaterThanOrEqual(38);
  });
});
