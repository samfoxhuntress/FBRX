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
    expect(await typeKeys(rfb, keysFor('aB').keys, { delayMs: 0 })).toBe(2);
    expect(sent).toEqual(['KeyA↓', 'KeyA↑', 'ShiftLeft↓', 'KeyB↓', 'KeyB↑', 'ShiftLeft↑']);

    const stop = new AbortController();
    stop.abort();
    expect(await typeKeys(rfb, keysFor('abc').keys, { delayMs: 0, signal: stop.signal })).toBe(0);
  });
});
