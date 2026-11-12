/**
 * Pasting into a virtual machine's screen: the text is typed, key by key, as on a US keyboard. A VNC clipboard reaches
 * only machines that run a clipboard agent; typing reaches every one, from a BIOS screen to a login prompt.
 */

/** A key press as noVNC sends it: the X keysym and the physical key (so QEMU types exactly that key). */
export interface KeyStroke {
  keysym: number;
  code: string;
  shift: boolean;
}

const SHIFT = { keysym: 0xffe1, code: 'ShiftLeft' };

/** The US layout's keys for what is not a letter or a digit: [unshifted, shifted, code]. */
const SYMBOLS: Array<[string, string, string]> = [
  ['`', '~', 'Backquote'],
  ['-', '_', 'Minus'],
  ['=', '+', 'Equal'],
  ['[', '{', 'BracketLeft'],
  [']', '}', 'BracketRight'],
  ['\\', '|', 'Backslash'],
  [';', ':', 'Semicolon'],
  ["'", '"', 'Quote'],
  [',', '<', 'Comma'],
  ['.', '>', 'Period'],
  ['/', '?', 'Slash'],
];
const SHIFTED_DIGITS = ')!@#$%^&*(';

/** The key for one character, or null when a US keyboard has none (accented letters, emoji…). */
export function keyFor(ch: string): KeyStroke | null {
  if (ch === '\n') return { keysym: 0xff0d, code: 'Enter', shift: false };
  if (ch === '\t') return { keysym: 0xff09, code: 'Tab', shift: false };
  if (ch === ' ') return { keysym: 0x20, code: 'Space', shift: false };
  if (/^[a-z]$/.test(ch)) return { keysym: ch.charCodeAt(0), code: `Key${ch.toUpperCase()}`, shift: false };
  if (/^[A-Z]$/.test(ch)) return { keysym: ch.charCodeAt(0), code: `Key${ch}`, shift: true };
  if (/^[0-9]$/.test(ch)) return { keysym: ch.charCodeAt(0), code: `Digit${ch}`, shift: false };
  const digit = SHIFTED_DIGITS.indexOf(ch);
  if (digit !== -1) return { keysym: ch.charCodeAt(0), code: `Digit${digit}`, shift: true };
  for (const [plain, shifted, code] of SYMBOLS) {
    if (ch === plain) return { keysym: ch.charCodeAt(0), code, shift: false };
    if (ch === shifted) return { keysym: ch.charCodeAt(0), code, shift: true };
  }
  return null;
}

/** The keys for a text (Windows line ends count once), and how many characters a US keyboard cannot type. */
export function keysFor(text: string): { keys: KeyStroke[]; skipped: number } {
  const keys: KeyStroke[] = [];
  let skipped = 0;
  for (const ch of text.replace(/\r\n?/g, '\n')) {
    const k = keyFor(ch);
    if (k) keys.push(k);
    else skipped++;
  }
  return { keys, skipped };
}

/** The most a paste types: about two minutes of keys. */
export const MAX_PASTE = 20_000;

type Sender = { sendKey(keysym: number, code: string | null, down?: boolean): void };

/**
 * Types the keys into the machine, a few milliseconds apart so none are dropped, holding Shift where the US layout
 * needs it. Stops early when `signal` aborts; resolves with how many were typed.
 */
export async function typeKeys(rfb: Sender, keys: KeyStroke[], o: { signal?: AbortSignal; onProgress?: (done: number) => void; delayMs?: number } = {}): Promise<number> {
  const wait = () => new Promise((r) => setTimeout(r, o.delayMs ?? 8));
  let done = 0;
  for (const k of keys) {
    if (o.signal?.aborted) break;
    if (k.shift) rfb.sendKey(SHIFT.keysym, SHIFT.code, true);
    rfb.sendKey(k.keysym, k.code, true);
    rfb.sendKey(k.keysym, k.code, false);
    if (k.shift) rfb.sendKey(SHIFT.keysym, SHIFT.code, false);
    done++;
    if (done % 25 === 0) o.onProgress?.(done);
    await wait();
  }
  o.onProgress?.(done);
  return done;
}
