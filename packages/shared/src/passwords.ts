/**
 * The Vault's password keeper: sign-ins (a site's username and password, an optional 2-step code and notes), kept
 * encrypted with the rest of the vault. They are saved from anywhere in FBRX (the Vault, the password generator, the
 * right-click menu, Fabrix in the chat, FBRX Browser after you sign in) and FBRX Browser fills them in on the sites
 * they belong to. Fabrix never sees a password: its tools save and find sign-ins by name and site only.
 */

export interface LoginInput {
  /** What it is for, as the person calls it: "Netflix", "Home router". */
  title: string;
  username: string;
  password: string;
  /** The web addresses it belongs to (FBRX Browser offers it there); none for a sign-in that is not on the web. */
  urls: string[];
  notes: string;
  /** The secret behind a 2-step (authenticator) code: its base32 key or an otpauth:// address; '' for none. */
  totp: string;
  favorite: boolean;
}

/** A password's strength: 0 very weak, 1 weak, 2 fair, 3 good, 4 strong. */
export type PasswordStrength = 0 | 1 | 2 | 3 | 4;
export const STRENGTH_WORDS: Record<PasswordStrength, string> = { 0: 'Very weak', 1: 'Weak', 2: 'Fair', 3: 'Good', 4: 'Strong' };

/** A sign-in as lists show it: never its password, 2-step secret or notes. */
export interface LoginSummary {
  id: string;
  title: string;
  username: string;
  urls: string[];
  favorite: boolean;
  hasTotp: boolean;
  hasNotes: boolean;
  strength: PasswordStrength;
  /** Another sign-in has the same password. */
  reused: boolean;
  createdAt: string;
  updatedAt: string;
  passwordChangedAt: string;
  lastUsedAt: string | null;
}

/** A password a sign-in had before, kept in case the change did not take on the site. */
export interface PreviousPassword {
  password: string;
  /** When it was replaced. */
  until: string;
}

/** A sign-in with everything in it (passwords.reveal, for the person only). */
export interface Login extends LoginSummary {
  password: string;
  notes: string;
  totp: string;
  /** Its earlier passwords, newest first (at most PASSWORD_HISTORY). */
  history: PreviousPassword[];
}

export const PASSWORD_HISTORY = 5;

export const LOGIN_LIMITS = { title: 120, username: 300, password: 1000, urls: 20, url: 2000, notes: 10_000, totp: 600 } as const;

/** A password is due for a change after this long. */
export const PASSWORD_OLD_DAYS = 365;

/** Passwords people pick most often: one of these is very weak whatever else it has. */
const COMMON = new Set(
  'password password1 password123 123456 1234567 12345678 123456789 1234567890 qwerty qwerty123 qwertyuiop abc123 111111 000000 123123 iloveyou admin welcome welcome1 letmein monkey dragon football baseball sunshine princess master shadow superman trustno1 passw0rd p@ssw0rd changeme secret login hello starwars whatever freedom computer michael jordan23 1q2w3e4r 1qaz2wsx zaq12wsx asdfgh asdfghjkl'.split(
    ' ',
  ),
);
/** Runs of keys people type in order. */
const SEQUENCES = ['abcdefghijklmnopqrstuvwxyz', '0123456789', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

/**
 * How hard a password is to guess, from its length and kinds of characters, less what makes it predictable: a
 * common password, a character repeated, a run like "abcd" or "1234". A long passphrase scores well on length alone.
 */
export function passwordStrength(password: string): PasswordStrength {
  if (!password) return 0;
  const lower = password.toLowerCase();
  if (password.length < 8 || COMMON.has(lower) || COMMON.has(lower.replace(/[\d!@#$%^&*.?]+$/, ''))) return 0;
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/\d/.test(password)) pool += 10;
  if (/[^A-Za-z0-9]/.test(password)) pool += 33;
  // Each character counts, except one that repeats the one before or carries on a run.
  let effective = 0;
  for (let i = 0; i < lower.length; i++) effective += i > 0 && (lower[i] === lower[i - 1] || followsOn(lower[i - 1], lower[i])) ? 0.25 : 1;
  const bits = effective * Math.log2(Math.max(pool, 10));
  return bits < 30 ? 0 : bits < 40 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
}

/** Whether `next` comes right after (or before) `prev` in a run of keys people type in order. */
function followsOn(prev: string, next: string): boolean {
  return SEQUENCES.some((s) => {
    const at = s.indexOf(prev);
    return at >= 0 && (s[at + 1] === next || s[at - 1] === next);
  });
}

export interface GeneratorOptions {
  length: number;
  /** Symbols such as !@#$ too (some sites refuse them). */
  symbols: boolean;
  digits: boolean;
}
export const GENERATOR_DEFAULTS: GeneratorOptions = { length: 20, symbols: true, digits: true };
export const GENERATOR_LENGTH = { min: 8, max: 128 } as const;

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*()-_=+[]{};:,.?';

/**
 * A random password from the system's secure random numbers, with at least one of each kind of character asked for
 * (sites often require that). Look-alike characters (0/O, 1/l/I) are left out so it can be read and typed.
 */
export function generatePassword(options: Partial<GeneratorOptions> = {}): string {
  const o = { ...GENERATOR_DEFAULTS, ...options };
  const length = Math.max(GENERATOR_LENGTH.min, Math.min(GENERATOR_LENGTH.max, Math.round(o.length)));
  const sets = [LETTERS, ...(o.digits ? [DIGITS] : []), ...(o.symbols ? [SYMBOLS] : [])];
  const all = sets.join('');
  for (;;) {
    const out = Array.from({ length }, () => pick(all)).join('');
    if (sets.every((s) => [...out].some((c) => s.includes(c))) && /[a-z]/.test(out) && /[A-Z]/.test(out)) return out;
  }
}

/** One character of `chars`, each equally likely (rejection sampling over random bytes). */
function pick(chars: string): string {
  const limit = 256 - (256 % chars.length);
  for (;;) {
    const b = globalThis.crypto.getRandomValues(new Uint8Array(1))[0];
    if (b < limit) return chars[b % chars.length];
  }
}

/**
 * Suffixes under which each name belongs to someone else (a country's second level, or a hosting service's own
 * sites), so "a.github.io" and "b.github.io" are different sites while "mail.example.com" and "example.com" are one.
 */
const SHARED_SUFFIXES = new Set(
  'co.uk org.uk ac.uk gov.uk me.uk ltd.uk plc.uk com.au net.au org.au edu.au gov.au co.nz org.nz co.jp ne.jp or.jp ac.jp co.kr co.in net.in org.in com.br com.mx com.ar com.cn com.tw com.hk com.sg com.my com.tr com.sa co.za co.il com.ua com.pl github.io gitlab.io herokuapp.com vercel.app netlify.app pages.dev workers.dev azurewebsites.net cloudfront.net appspot.com web.app firebaseapp.com blogspot.com wordpress.com s3.amazonaws.com onrender.com fly.dev glitch.me repl.co ngrok.io ngrok-free.app'.split(
    ' ',
  ),
);

const isIp = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');

/**
 * The site a host belongs to: its registered name ("accounts.example.com" → "example.com"). An address on the local
 * network (an IP address or a single name like "router") is its own site, port included.
 */
export function siteOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^\[|\]$/g, '');
  if (!host) return null;
  if (isIp(host) || !host.includes('.')) return u.port ? `${host}:${u.port}` : host;
  const labels = host.split('.');
  const two = labels.slice(-2).join('.');
  return SHARED_SUFFIXES.has(two) && labels.length > 2 ? labels.slice(-3).join('.') : two;
}

/** A host to show for an address ("https://www.example.com/login" → "example.com"). */
export function displayHost(url: string): string {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * How well a sign-in's addresses fit a page: 2 the same host, 1 the same site (another part of it), 0 not at all.
 * A sign-in saved for a secure (https) page is never offered on an insecure (http) one.
 */
export function loginMatch(urls: string[], pageUrl: string): 0 | 1 | 2 {
  const site = siteOf(pageUrl);
  if (!site) return 0;
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return 0;
  }
  let best: 0 | 1 | 2 = 0;
  for (const raw of urls) {
    if (siteOf(raw) !== site) continue;
    let saved: URL;
    try {
      saved = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      continue;
    }
    if (saved.protocol === 'https:' && page.protocol !== 'https:') continue;
    const same = saved.hostname.replace(/^www\./, '') === page.hostname.replace(/^www\./, '');
    best = Math.max(best, same ? 2 : 1) as 0 | 1 | 2;
  }
  return best;
}

/** A title for a sign-in saved from a page: its site's name, capitalized ("netflix.com" → "Netflix"). */
export function titleForUrl(url: string): string {
  const site = siteOf(url);
  if (!site) return '';
  if (site.includes(':') || !site.includes('.') || /^\d/.test(site)) return site;
  const name = site.split('.')[0];
  return name.charAt(0).toUpperCase() + name.slice(1);
}
