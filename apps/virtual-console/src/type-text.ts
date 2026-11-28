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

/** The most a paste types: a few minutes of keys at PACE. */
export const MAX_PASTE = 20_000;

/**
 * How fast a paste types. A virtual machine's keyboard (QEMU's PS/2 or USB) holds only a few keys; keys that arrive in
 * a burst while the guest is busy are dropped, and a dropped Shift turns the rest of the text into the wrong case or
 * symbols. So keys go a little apart, with a breath every few dozen keys and after each line (where a terminal or an
 * editor does its work).
 */
export const PACE = { keyMs: 12, everyKeys: 32, pauseMs: 120, lineMs: 60 };

type Sender = { sendKey(keysym: number, code: string | null, down?: boolean): void };

/**
 * Types the keys into the machine at PACE, holding Shift over a run of keys that need it and letting it go before any
 * key that does not (and at the end, whatever happened). Stops early when `signal` aborts; resolves with how many keys
 * were typed.
 */
export async function typeKeys(rfb: Sender, keys: KeyStroke[], o: { signal?: AbortSignal; onProgress?: (done: number) => void; pace?: Partial<typeof PACE> } = {}): Promise<number> {
  const pace = { ...PACE, ...o.pace };
  const wait = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
  let shift = false;
  const setShift = (down: boolean) => {
    if (down === shift) return;
    rfb.sendKey(SHIFT.keysym, SHIFT.code, down);
    shift = down;
  };
  let done = 0;
  try {
    for (const k of keys) {
      if (o.signal?.aborted) break;
      setShift(k.shift);
      rfb.sendKey(k.keysym, k.code, true);
      rfb.sendKey(k.keysym, k.code, false);
      done++;
      if (done % 25 === 0) o.onProgress?.(done);
      await wait(k.code === 'Enter' ? pace.lineMs : pace.keyMs);
      if (done % pace.everyKeys === 0) await wait(pace.pauseMs);
    }
  } finally {
    setShift(false);
  }
  o.onProgress?.(done);
  return done;
}
