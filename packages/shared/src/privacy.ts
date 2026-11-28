/**
 * What FBRX's AI never remembers, and never sends to the internet: numbers that let someone take over a person's
 * identity or money (government ID numbers, bank details, full card numbers, passwords). Found in text by their shape
 * and the words around them, so "my social security number is 123-45-6789" and "SSN 123456789" are caught while an
 * order number is not. Payment cards may be remembered by their last four digits only.
 */

export interface SensitiveKind {
  id: string;
  /** "a Social Security number", for sentences. */
  what: string;
  /** For lists: "Social Security and other national ID numbers". */
  label: string;
}

export const NEVER_KEPT: readonly SensitiveKind[] = [
  { id: 'national-id', what: 'a Social Security or national ID number', label: 'Social Security and other national ID numbers' },
  { id: 'license', what: 'a driver’s license number', label: 'Driver’s license numbers' },
  { id: 'passport', what: 'a passport number', label: 'Passport numbers' },
  { id: 'tax-id', what: 'a tax ID number', label: 'Tax ID numbers' },
  { id: 'bank', what: 'a bank account number', label: 'Bank account and routing numbers' },
  { id: 'card', what: 'a full payment card number or its security code', label: 'Full payment card numbers and security codes' },
  { id: 'password', what: 'a password or PIN', label: 'Passwords, PINs and security answers' },
];

const KIND = Object.fromEntries(NEVER_KEPT.map((k) => [k.id, k])) as Record<string, SensitiveKind>;

interface Rule {
  id: string;
  re: RegExp;
  /** Which capture group is the secret (0: the whole match). */
  group?: number;
}

// Words that say what a number is, then (within a few words) the number.
const NEAR = '(?:\\s*(?:#|no\\.?|number|num|is|was|=|:|of|the|my|his|her|their|-)){0,4}\\s*';
const RULES: Rule[] = [
  // US SSN / ITIN written with separators; nine digits in a row only next to the words.
  { id: 'national-id', re: /\b(?!000|666)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b/g },
  { id: 'national-id', re: new RegExp(`\\b(?:ssn|ss#|social security|social insurance|sin|national (?:id|insurance)|nino|id card|aadhaar|tax file)${NEAR}((?:\\d[\\s-]?){6,11}\\d|[A-Z]{2}\\d{6}[A-D])\\b`, 'gi'), group: 1 },
  // Part of one: "my social security number starts with 818".
  { id: 'national-id', re: /\b(?:ssn|social security(?: number)?)\b[^.?!\n]{0,30}?\b(?:starts?|begins?|ends?)\s+(?:with\s+)?(\d{2,})/gi, group: 1 },
  { id: 'license', re: new RegExp(`\\b(?:driver'?s?|driving)\\s+licen[cs]e${NEAR}([A-Z0-9][A-Z0-9-]{4,15})\\b`, 'gi'), group: 1 },
  { id: 'license', re: new RegExp(`\\b(?:DL|license number|licence number)${NEAR}([A-Z0-9]*\\d[A-Z0-9-]{3,15})\\b`, 'g'), group: 1 },
  { id: 'passport', re: new RegExp(`\\bpassport${NEAR}([A-Z0-9]*\\d[A-Z0-9]{4,9})\\b`, 'gi'), group: 1 },
  { id: 'tax-id', re: new RegExp(`\\b(?:ein|tin|itin|tax id|tax identification|vat number|vat id)${NEAR}(\\d[\\d-]{6,14}\\d|[A-Z]{2}[A-Z0-9]{8,12})\\b`, 'gi'), group: 1 },
  { id: 'bank', re: new RegExp(`\\b(?:account|acct|routing|aba|sort code|bsb|iban|swift|checking|savings)${NEAR}([A-Z]{2}\\d{2}[A-Z0-9]{10,30}|\\d[\\d\\s-]{5,20}\\d)\\b`, 'gi'), group: 1 },
  { id: 'bank', re: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,3})?\b/g },
  { id: 'card', re: new RegExp(`\\b(?:cvv|cvc|cvv2|security code|card code)${NEAR}(\\d{3,4})\\b`, 'gi'), group: 1 },
  { id: 'password', re: /\b(?:password|passcode|passphrase|pin(?: code| number)?|security answer|secret answer)\s*(?:is|was|=|:)\s*["']?([^\s"']{3,64})/gi, group: 1 },
];

/** A payment card number: 13–19 digits (spaces or dashes allowed) that pass the Luhn check. */
const CARD = /\b(?:\d[ -]?){12,18}\d\b/g;

export function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
    double = !double;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

export interface SensitiveFinding {
  kind: SensitiveKind;
  /** Where in the text, and what (never shown or logged). */
  start: number;
  end: number;
}

/** Every identity or money number in the text. */
export function findSensitive(text: string): SensitiveFinding[] {
  const out: SensitiveFinding[] = [];
  for (const r of RULES) {
    r.re.lastIndex = 0;
    for (let m = r.re.exec(text); m; m = r.re.exec(text)) {
      const value = m[r.group ?? 0];
      if (!value) continue;
      const start = m.index + m[0].lastIndexOf(value);
      out.push({ kind: KIND[r.id], start, end: start + value.length });
    }
  }
  CARD.lastIndex = 0;
  for (let m = CARD.exec(text); m; m = CARD.exec(text)) {
    if (luhn(m[0].replace(/\D/g, ''))) out.push({ kind: KIND.card, start: m.index, end: m.index + m[0].length });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * The text with identity and money numbers taken out ("[a Social Security number: never kept]"). A full card number
 * becomes "card ending 1234" when cards may be remembered that way, and is taken out otherwise.
 */
export function scrubSensitive(text: string, o: { cardLast4?: boolean } = {}): { text: string; removed: SensitiveKind[] } {
  const found = findSensitive(text);
  if (!found.length) return { text, removed: [] };
  let out = '';
  let at = 0;
  const removed: SensitiveKind[] = [];
  for (const f of found) {
    if (f.start < at) continue;
    const value = text.slice(f.start, f.end);
    const digits = value.replace(/\D/g, '');
    const isCard = f.kind.id === 'card' && digits.length >= 13;
    out += text.slice(at, f.start) + (isCard && o.cardLast4 ? `card ending ${digits.slice(-4)}` : `[${f.kind.what}: never kept]`);
    if (!(isCard && o.cardLast4)) removed.push(f.kind);
    at = f.end;
  }
  return { text: out + text.slice(at), removed };
}
