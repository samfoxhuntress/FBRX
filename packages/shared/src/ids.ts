const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

function randomChars(n: number): string {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b & 31];
  return out;
}

/**
 * Time-sortable, URL-safe identifier: `<prefix>_<10 char time><12 char random>`.
 * Lexicographic order matches creation order, which keeps SQLite indexes tight.
 */
export function newId(prefix: string): string {
  let t = Date.now();
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return `${prefix}_${time}${randomChars(12)}`;
}

export function shortId(n = 8): string {
  return randomChars(n);
}
