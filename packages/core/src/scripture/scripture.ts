import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';

/**
 * Bible verses, word for word, from verified public-domain texts shipped with FBRX OS (resources/scripture): a model
 * quotes from here, not from memory, where every model misquotes or invents. Read-only and offline. Each text is a
 * Brotli-compressed JSONL file ({"book", "chapter", "verse", "text"} per line); its checksum is fixed here, so a damaged
 * or swapped file is refused rather than quoted.
 */

export interface ScriptureVersion {
  id: string;
  short: string;
  name: string;
  /** SHA-256 of the uncompressed JSONL, from its build manifest. */
  sha256: string;
  /** How people name it, lowercased. */
  aliases: string[];
}

export const SCRIPTURE_VERSIONS: ScriptureVersion[] = [
  { id: 'kjv', short: 'KJV', name: 'King James Version', sha256: '2a32063407a9b044b9e6722c777991c4b78bfe541535a074dd2311658c84610d', aliases: ['kjv', 'king james', 'king james version', 'authorized version', 'authorised version', 'av', 'kjva'] },
  { id: 'asv', short: 'ASV', name: 'American Standard Version (1901)', sha256: '81150cc82c634f4b0d02a891791bc054c0f816f5d8dceee19f802b0c59f7855e', aliases: ['asv', 'american standard', 'american standard version'] },
  { id: 'web', short: 'WEB', name: 'World English Bible', sha256: '63703ea9179e144d75b884b5bf95208520296451f71efe4fcefdac579efa2bc0', aliases: ['web', 'world english', 'world english bible'] },
  { id: 'bsb', short: 'BSB', name: 'Berean Standard Bible', sha256: 'ec4af019f3563ec0c1d836778651168b28be62ad394c4d251d198f552eab714d', aliases: ['bsb', 'berean', 'berean standard', 'berean standard bible'] },
  { id: 'ylt', short: 'YLT', name: "Young's Literal Translation", sha256: '0ef045db9903c772726f5539505dc625a4a606fe0d3faf773ebc0923524a3ecd', aliases: ['ylt', 'young', 'youngs', "young's", 'young literal', "young's literal", "young's literal translation", 'youngs literal translation'] },
  { id: 'darby', short: 'Darby', name: 'Darby Translation', sha256: '7cdd05f2805e201ad6e46c089d4ef273dc3a9d7a2c3ee105dcaac6f7579ba197', aliases: ['darby', 'dby', 'darby translation', 'darby bible'] },
];

/** The 14 books of the KJV Apocrypha, in their own file; quoted as the KJV. */
const APOCRYPHA = { id: 'kjv-apocrypha', sha256: '7611261fb6d170dc4159f0f509d076a4be68ad045425ae9ca0356cf5da9e2245' };

/** Each book as the texts name it, then the other ways people write it (numbers, spaces and dots aside). */
const BOOKS: Array<[string, ...string[]]> = [
  ['Genesis', 'gen', 'ge', 'gn'],
  ['Exodus', 'exod', 'exo', 'ex'],
  ['Leviticus', 'lev', 'le', 'lv'],
  ['Numbers', 'num', 'nu', 'nm', 'nb'],
  ['Deuteronomy', 'deut', 'deu', 'de', 'dt'],
  ['Joshua', 'josh', 'jos', 'jsh'],
  ['Judges', 'judg', 'jdg', 'jg', 'jdgs'],
  ['Ruth', 'rth', 'ru'],
  ['1 Samuel', '1sam', '1sa', '1sm'],
  ['2 Samuel', '2sam', '2sa', '2sm'],
  ['1 Kings', '1kgs', '1ki', '1kin'],
  ['2 Kings', '2kgs', '2ki', '2kin'],
  ['1 Chronicles', '1chr', '1ch', '1chron'],
  ['2 Chronicles', '2chr', '2ch', '2chron'],
  ['Ezra', 'ezr'],
  ['Nehemiah', 'neh', 'ne'],
  ['Esther', 'esth', 'est'],
  ['Job', 'jb'],
  ['Psalms', 'psalm', 'ps', 'psa', 'pss', 'psm'],
  ['Proverbs', 'prov', 'pro', 'prv', 'pr'],
  ['Ecclesiastes', 'eccl', 'eccles', 'ecc', 'ec', 'qoh', 'qoheleth'],
  ['Song of Solomon', 'song', 'songofsongs', 'sos', 'canticles', 'cant', 'songofsol', 'ss'],
  ['Isaiah', 'isa', 'is'],
  ['Jeremiah', 'jer', 'je', 'jr'],
  ['Lamentations', 'lam', 'la'],
  ['Ezekiel', 'ezek', 'eze', 'ezk'],
  ['Daniel', 'dan', 'da', 'dn'],
  ['Hosea', 'hos', 'ho'],
  ['Joel', 'jl', 'joe'],
  ['Amos', 'am'],
  ['Obadiah', 'obad', 'ob'],
  ['Jonah', 'jon', 'jnh'],
  ['Micah', 'mic', 'mc'],
  ['Nahum', 'nah', 'na'],
  ['Habakkuk', 'hab', 'hb'],
  ['Zephaniah', 'zeph', 'zep', 'zp'],
  ['Haggai', 'hag', 'hg'],
  ['Zechariah', 'zech', 'zec', 'zc'],
  ['Malachi', 'mal', 'ml'],
  ['Matthew', 'matt', 'mat', 'mt'],
  ['Mark', 'mrk', 'mar', 'mk'],
  ['Luke', 'luk', 'lk'],
  ['John', 'jhn', 'joh', 'jn'],
  ['Acts', 'act', 'ac', 'actsoftheapostles'],
  ['Romans', 'rom', 'ro', 'rm'],
  ['1 Corinthians', '1cor', '1co'],
  ['2 Corinthians', '2cor', '2co'],
  ['Galatians', 'gal', 'ga'],
  ['Ephesians', 'eph', 'ephes'],
  ['Philippians', 'phil', 'php', 'pp'],
  ['Colossians', 'col'],
  ['1 Thessalonians', '1thess', '1thes', '1th'],
  ['2 Thessalonians', '2thess', '2thes', '2th'],
  ['1 Timothy', '1tim', '1ti', '1tm'],
  ['2 Timothy', '2tim', '2ti', '2tm'],
  ['Titus', 'tit'],
  ['Philemon', 'philem', 'phm', 'pm'],
  ['Hebrews', 'heb'],
  ['James', 'jas', 'jm'],
  ['1 Peter', '1pet', '1pe', '1pt'],
  ['2 Peter', '2pet', '2pe', '2pt'],
  ['1 John', '1jn', '1jhn', '1jo', '1joh'],
  ['2 John', '2jn', '2jhn', '2jo', '2joh'],
  ['3 John', '3jn', '3jhn', '3jo', '3joh'],
  ['Jude', 'jd'],
  ['Revelation', 'rev', 're', 'revelations', 'revelationofjohn', 'therevelation', 'revelationofstjohn'],
  // The KJV Apocrypha.
  ['1 Esdras', '1esd', '1esdr'],
  ['2 Esdras', '2esd', '2esdr'],
  ['Tobit', 'tob', 'tb'],
  ['Judith', 'jdt', 'jdth'],
  ['Additions to Esther', 'addesth', 'addest', 'restofesther', 'therestofesther', 'esthergreek', 'greekesther'],
  ['Wisdom of Solomon', 'wis', 'wisd', 'wisdom'],
  ['Sirach', 'sir', 'ecclesiasticus', 'ecclus'],
  ['Baruch', 'bar'],
  ['Prayer of Azariah', 'prazar', 'praz', 'azariah', 'songofthethreeholychildren', 'songofthethree', 'songofthreeyouths'],
  ['Susanna', 'sus'],
  ['Bel and the Dragon', 'bel', 'belandthedragon'],
  ['Prayer of Manasseh', 'prman', 'manasseh', 'prayerofmanasses', 'prayerofmanasseh'],
  ['1 Maccabees', '1macc', '1mac', '1ma'],
  ['2 Maccabees', '2macc', '2mac', '2ma'],
];
const APOCRYPHA_BOOKS = new Set(BOOKS.slice(66).map((b) => b[0]));

/**
 * A reference, for the tool shortlist: a book's full name with a chapter after it ("John 3", "Psalm 23"), or a shorter
 * name with chapter and verse ("1 Cor 13:4", "Rev 3:20"). A short name with a bare number is too often something else
 * ("MacBook Pro 14", "rev 2", "Mar 15").
 */
const plain = (n: string) => n.replace(/^[1-3]\s*/, '').toLowerCase().replace(/[^a-z ]/g, '');
const FULL_NAMES = [...new Set([...BOOKS.map(([name]) => plain(name)), 'psalm', 'song of songs'])];
const SHORT_NAMES = [...new Set(BOOKS.flatMap(([, ...others]) => others.map(plain)).filter((n) => n.length >= 2 && !FULL_NAMES.includes(n)))];
export const SCRIPTURE_REFERENCE = new RegExp(
  `(?:^|[^a-z0-9])(?:(?:${FULL_NAMES.join('|')})\\s+\\d{1,3}(?![\\d%])|(?:${SHORT_NAMES.join('|')})\\.?\\s*\\d{1,3}:\\d{1,3})`,
  'i',
);

/** "I Samuel", "1st Samuel", "First Samuel" and "1 Sam." all read "1samuel". */
function bookKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/^\s*(?:iii|third|3rd)\b\s*/, '3')
    .replace(/^\s*(?:ii|second|2nd)\b\s*/, '2')
    .replace(/^\s*(?:i|first|1st)\b\s*(?=[a-z])/, '1')
    .replace(/[^a-z0-9]/g, '');
}

const BY_KEY = new Map<string, string>();
for (const [name, ...others] of BOOKS) for (const k of [name, ...others]) BY_KEY.set(bookKey(k), name);

/** The book a name means, or null. An unambiguous start of a name counts too ("Deuter", "Philipp"). */
export function findBook(text: string): string | null {
  const key = bookKey(text);
  if (!key) return null;
  const exact = BY_KEY.get(key);
  if (exact) return exact;
  if (key.replace(/^\d/, '').length < 3) return null;
  const hits = new Set(BOOKS.filter(([name]) => bookKey(name).startsWith(key)).map(([name]) => name));
  return hits.size === 1 ? [...hits][0] : null;
}

/** The version a name means, or null. */
export function findVersion(text: string): ScriptureVersion | null {
  const t = text.trim().toLowerCase().replace(/[()[\]]/g, '').replace(/\s+/g, ' ');
  return SCRIPTURE_VERSIONS.find((v) => v.id === t || v.aliases.includes(t)) ?? null;
}

export interface Reference {
  book: string;
  from: { chapter: number; verse: number | null };
  to: { chapter: number; verse: number | null } | null;
}

/**
 * "John 3:16", "1 Cor 13:4-7", "Psalm 23", "Genesis 1:1-2:3", "Isaiah 40-41", "Jude 3" (a one-chapter book's verse).
 * Returns the book as written when it is no book at all, so the answer can say so.
 */
export function parseReference(text: string): { ref: Reference } | { noBook: string } | { invalid: true } {
  const m = text
    .trim()
    .replace(/[–—]/g, '-')
    .match(/^((?:[1-3]|i{1,3}|first|second|third|1st|2nd|3rd)?\s*[a-z][a-z .']*?)\.?\s*(\d{1,3})(?:\s*[:.]\s*(\d{1,3}))?(?:\s*-\s*(\d{1,3})(?:\s*[:.]\s*(\d{1,3}))?)?$/i);
  if (!m) return { invalid: true };
  const book = findBook(m[1]);
  if (!book) return { noBook: m[1].trim() };
  const n = (s: string | undefined) => (s === undefined ? null : Number(s));
  const [c1, v1, a, b] = [Number(m[2]), n(m[3]), n(m[4]), n(m[5])];
  // "Book 3:16-18" is verses 16 to 18; "Book 3:16-4:2" crosses chapters; "Book 40-41" is two chapters.
  if (v1 === null) return { ref: { book, from: { chapter: c1, verse: null }, to: a === null ? null : b === null ? { chapter: a, verse: null } : { chapter: a, verse: b } } };
  return { ref: { book, from: { chapter: c1, verse: v1 }, to: a === null ? null : b === null ? { chapter: c1, verse: a } : { chapter: a, verse: b } } };
}

interface Text {
  verses: Map<string, string>;
  /** Each book's chapters, and the highest verse number in each. */
  chapters: Map<string, number[]>;
}

const key = (book: string, chapter: number, verse: number) => `${book}|${chapter}|${verse}`;

/** At most this many verses in one answer (Psalm 119 is 176): the rest is asked for again. */
export const MAX_VERSES = 40;

export class Scripture {
  private loaded = new Map<string, Text>();

  constructor(private readonly dir: () => string | null) {}

  /** Why there is nothing to look up in, or null. */
  unavailable(): string | null {
    const d = this.dir();
    return d && existsSync(join(d, 'kjv.jsonl.br')) ? null : 'The Bible texts are not installed with this copy of FBRX';
  }

  private text(id: string, sha256: string): Text {
    const have = this.loaded.get(id);
    if (have) return have;
    const d = this.dir();
    if (!d) throw new Error('The Bible texts are not installed with this copy of FBRX');
    const raw = brotliDecompressSync(readFileSync(join(d, `${id}.jsonl.br`)));
    if (createHash('sha256').update(raw).digest('hex') !== sha256) throw new Error(`The ${id} text in FBRX's files is damaged, so it is not quoted; reinstalling FBRX OS restores it`);
    const t: Text = { verses: new Map(), chapters: new Map() };
    for (const line of raw.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      const v = JSON.parse(line) as { book: string; chapter: number; verse: number; text: string };
      // A verse a version leaves out may be there with no words (the ASV's 16): it counts as left out.
      if (v.text.trim()) t.verses.set(key(v.book, v.chapter, v.verse), v.text);
      const ch = t.chapters.get(v.book) ?? [];
      ch[v.chapter - 1] = Math.max(ch[v.chapter - 1] ?? 0, v.verse);
      t.chapters.set(v.book, ch);
    }
    // Two texts at a time is plenty (each is a few megabytes in memory).
    if (this.loaded.size >= 2) this.loaded.delete(this.loaded.keys().next().value!);
    this.loaded.set(id, t);
    return t;
  }

  /** The answer for a model: the exact words with the reference, or why there are none. */
  lookup(reference: string, versionName?: string): { output: string; data?: unknown } {
    let ask = reference.trim().slice(0, 120);
    // "John 3:16 KJV", "John 3:16 (ASV)": the version may come with the reference.
    let named = versionName?.trim() ? findVersion(versionName) : null;
    if (versionName?.trim() && !named) return { output: `FBRX has no "${versionName.trim().slice(0, 40)}" text. It has: ${SCRIPTURE_VERSIONS.map((v) => `${v.short} (${v.name})`).join(', ')}, and the KJV Apocrypha.` };
    const tail = ask.match(/^(.*?\d)\s*[,(]?\s*([a-z][a-z' ]{1,30})\)?\s*$/i);
    if (tail && findVersion(tail[2])) {
      named ??= findVersion(tail[2]);
      ask = tail[1];
    }
    const parsed = parseReference(ask);
    if ('invalid' in parsed) return { output: `"${ask}" is not a reference FBRX can read: give a book, a chapter and verses, such as "John 3:16", "Psalm 23" or "1 Corinthians 13:4-7".` };
    if ('noBook' in parsed) return { output: `No such book: there is no "${parsed.noBook.slice(0, 40)}" in the Bible (nor in the Apocrypha). Do not quote one.` };
    const { ref } = parsed;
    const apocrypha = APOCRYPHA_BOOKS.has(ref.book);
    const version = named ?? SCRIPTURE_VERSIONS[0];
    if (apocrypha && version.id !== 'kjv') return { output: `${ref.book} is in the Apocrypha, which FBRX has only in the KJV (the ${version.short} has no ${ref.book}). Ask for it in the KJV.` };
    const t = apocrypha ? this.text(APOCRYPHA.id, APOCRYPHA.sha256) : this.text(version.id, version.sha256);
    const chapters = t.chapters.get(ref.book) ?? [];
    const has = (c: number) => c >= 1 && c <= chapters.length && !!chapters[c - 1];
    const s = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
    // A one-chapter book's number is a verse ("Jude 3"), unless it reads as chapter and verse.
    if (chapters.length === 1 && ref.from.verse === null && !(ref.from.chapter === 1 && !ref.to)) {
      ref.from = { chapter: 1, verse: ref.from.chapter };
      if (ref.to) ref.to = { chapter: 1, verse: ref.to.chapter };
    }
    const end = ref.to ?? { chapter: ref.from.chapter, verse: ref.from.verse };
    for (const c of [ref.from.chapter, end.chapter]) if (!has(c)) return { output: `No such verse: ${ref.book} has ${s(chapters.length, 'chapter')}, so there is no chapter ${c}. Do not quote one.` };
    const first = ref.from.verse ?? 1;
    const last = end.verse ?? chapters[end.chapter - 1];
    for (const [c, v] of [[ref.from.chapter, first], [end.chapter, last]] as const) {
      if (v <= chapters[c - 1]) continue;
      // A verse past this version's last one may be one it leaves out (the KJV has it).
      if (!apocrypha && version.id !== 'kjv' && v <= (this.text('kjv', SCRIPTURE_VERSIONS[0].sha256).chapters.get(ref.book)?.[c - 1] ?? 0))
        return { output: `${ref.book} ${c}:${v} is not in the ${version.short}: it leaves out a few verses that are missing from the older manuscripts. The KJV has it: ask for it in the KJV. Do not quote it from memory.` };
      return { output: `No such verse: ${ref.book} ${c} has ${s(chapters[c - 1], 'verse')}, so there is no verse ${v}. Do not quote one.` };
    }
    if (end.chapter < ref.from.chapter || (end.chapter === ref.from.chapter && last < first)) return { output: `"${ask}" runs backwards: give the first verse first.` };

    const lines: string[] = [];
    const missing: string[] = [];
    let count = 0;
    let stopped: { chapter: number; verse: number } | null = null;
    const cross = end.chapter !== ref.from.chapter;
    for (let c = ref.from.chapter; c <= end.chapter && !stopped; c++) {
      const top = c === end.chapter ? last : chapters[c - 1];
      for (let v = c === ref.from.chapter ? first : 1; v <= top; v++) {
        if (count === MAX_VERSES) {
          stopped = { chapter: c, verse: v };
          break;
        }
        const words = t.verses.get(key(ref.book, c, v));
        const label = cross ? `${c}:${v}` : String(v);
        if (words === undefined) {
          missing.push(`${ref.book} ${c}:${v}`);
          continue;
        }
        lines.push(`[${label}] ${words}`);
        count++;
      }
    }
    const shown = (to: { chapter: number; verse: number }) =>
      `${ref.book} ${ref.from.chapter}:${first}${to.chapter === ref.from.chapter ? (to.verse === first ? '' : `-${to.verse}`) : `-${to.chapter}:${to.verse}`}`;
    const name = apocrypha ? 'King James Version, Apocrypha' : version.name;
    if (!lines.length)
      return {
        output: `${missing[0]} is not in the ${version.short}: it leaves out a few verses that are missing from the older manuscripts. The KJV has it: ask for it in the KJV. Do not quote it from memory.`,
      };
    const lastShown = stopped ? (stopped.verse > 1 ? { chapter: stopped.chapter, verse: stopped.verse - 1 } : { chapter: stopped.chapter - 1, verse: chapters[stopped.chapter - 2] }) : { chapter: end.chapter, verse: last };
    const out = [
      `${shown(lastShown)} (${name}, ${apocrypha ? 'KJV' : version.short}), word for word from FBRX's verified copy. Quote it exactly as it stands, with its reference:`,
      ...lines,
      ...(missing.length ? [`(Not in the ${version.short}: ${missing.join(', ')}; it leaves out a few verses missing from the older manuscripts.)`] : []),
      ...(stopped ? [`…${MAX_VERSES} verses shown; the passage goes on from ${ref.book} ${stopped.chapter}:${stopped.verse}. Ask for that if the person wants more.`] : []),
    ];
    return { output: out.join('\n'), data: { reference: shown(lastShown), version: apocrypha ? 'KJV' : version.short, verses: count } };
  }
}
