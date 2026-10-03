/**
 * Text and phoneme tweaks for the natural voices (Kokoro). The pronunciation module reads digits one by one and
 * knows no units or acronyms, so text is tidied first; British voices then get British vowels and no "r" after
 * vowels, since the dictionary is American.
 */

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function numberWords(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 0) return `minus ${numberWords(-n)}`;
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : '');
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberWords(n % 100)}` : ''}`;
  for (const [size, name] of [
    [1e9, 'billion'],
    [1e6, 'million'],
    [1e3, 'thousand'],
  ] as const) {
    if (n >= size) return `${numberWords(Math.floor(n / size))} ${name}${n % size ? ` ${numberWords(n % size)}` : ''}`;
  }
  return String(n);
}

/** "twenty three" → "twenty third". */
export function ordinalWords(n: number): string {
  const w = numberWords(n);
  const irregular: Record<string, string> = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
  const last = w.split(' ').pop()!;
  const head = w.slice(0, w.length - last.length);
  return head + (irregular[last] ?? (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`));
}

const UNITS: Record<string, string> = { TB: 'terabytes', GB: 'gigabytes', MB: 'megabytes', KB: 'kilobytes', GHZ: 'gigahertz', MHZ: 'megahertz', MBPS: 'megabits per second', GBPS: 'gigabits per second', MS: 'milliseconds' };
/** Short capitals said as a word rather than letter by letter. */
const SAID_AS_WORDS: Record<string, string> = { RAM: 'ram', LAN: 'lan', WAN: 'wan', PIN: 'pin', SIM: 'sim', ZIP: 'zip', GIF: 'gif', JSON: 'jason', JPEG: 'jay peg', NASA: 'nasa', WIFI: 'wifi', OK: 'okay', AM: 'A M', PM: 'P M' };

export function normalizeForSpeech(text: string): string {
  return (
    text
      .replace(/(\d)\s*%/g, '$1 percent')
      .replace(/(\d)\s*°\s*C\b/g, '$1 degrees')
      .replace(/(\d)\s*°\s*F\b/g, '$1 degrees Fahrenheit')
      .replace(/\b(\d+(?:\.\d+)?)\s*(TB|GB|MB|KB|GHz|MHz|Mbps|Gbps|ms)\b/gi, (_m, n: string, u: string) => `${n} ${UNITS[u.toUpperCase()]}`)
      .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y: string, mo: string, d: string) => (Number(mo) >= 1 && Number(mo) <= 12 ? `${MONTHS[Number(mo) - 1]} ${ordinalWords(Number(d))}, ${y}` : m))
      .replace(/\b(\d{1,2}):(\d{2})\b/g, (_m, h: string, mi: string) => `${Number(h)} ${mi === '00' ? "o'clock" : Number(mi) < 10 ? `oh ${Number(mi)}` : mi}`)
      .replace(/\b\d{1,3}(?:,\d{3})+\b/g, (m) => numberWords(Number(m.replace(/,/g, ''))))
      .replace(/\b(\d+)\.(\d+)\b/g, (_m, a: string, b: string) => `${numberWords(Number(a))} point ${b.split('').map((d) => ONES[Number(d)]).join(' ')}`)
      // Years (1100–2099) are read the way the pronunciation module already does ("twenty twenty-six").
      .replace(/\b\d+\b/g, (m) => (/^(1[1-9]|20)\d\d$/.test(m) ? m : m.length > 1 && m.startsWith('0') ? m.split('').map((d) => ONES[Number(d)]).join(' ') : m.length > 12 ? m : numberWords(Number(m))))
      // Acronyms are spelled out (F B R X), unless the whole sentence is in capitals.
      .replace(/\b[A-Z]{2,6}\b/g, (m, _i: number, all: string) => (/[a-z]/.test(all) ? (SAID_AS_WORDS[m] ?? m.split('').join(' ')) : m))
  );
}

const VOWELS = 'aeiouæɑɒɔəɛɜɪʊʌAIOQWYᵊɐ';

/** American (Misaki US) phonemes to British (Misaki GB) ones, near enough for the British voices. */
export function britishPhonemes(p: string): string {
  const notVowel = `(?=[^${VOWELS}ˈˌ]|$)`;
  return p
    .replace(/O/g, 'Q')
    .replace(new RegExp(`ɑɹ${notVowel}`, 'g'), 'ɑː')
    .replace(new RegExp(`ɔɹ${notVowel}`, 'g'), 'ɔː')
    .replace(new RegExp(`ɜɹ${notVowel}`, 'g'), 'ɜː')
    .replace(new RegExp(`ɛɹ${notVowel}`, 'g'), 'ɛə')
    .replace(new RegExp(`ɪɹ${notVowel}`, 'g'), 'ɪə')
    .replace(new RegExp(`ʊɹ${notVowel}`, 'g'), 'ʊə')
    .replace(new RegExp(`əɹ${notVowel}`, 'g'), 'ə')
    .replace(new RegExp(`ɹ${notVowel}`, 'g'), '')
    .replace(/ɑ(?!ː)/g, 'ɒ');
}
