import {
  MEMORY_CATEGORIES,
  NEVER_KEPT,
  PRIVATE_MEMORY,
  findSensitive,
  newId,
  scrubSensitive,
  type MemoryCategory,
  type MemoryEntry,
  type MemoryStatus,
  type RecentChat,
  type Settings,
} from '@fbrx/shared';
import { CoreError } from '../errors';
import type { Db } from '../storage/db';
import type { EventBus } from '../events';

/**
 * What the AI remembers about the person, on this computer only, for whichever AI is chosen (FBRX puts it in the
 * conversation, so a new provider or model knows it too):
 *
 * - short term: the last 24 hours of conversations (titles, what was asked and answered last), derived from the chat
 *   history, so it ages out by itself;
 * - long term: lasting facts (name, where they live, work, preferences…), learned from what the person says or kept
 *   when the AI is asked to remember, and searchable chat history.
 *
 * Identity and money numbers (Social Security, driver's license and passport numbers, tax IDs, bank details, full
 * card numbers, passwords) are never kept: they are taken out before anything is stored. Private kinds (addresses,
 * where they are, email and phone, birthday, cards by their last four digits) are kept only when the person allows
 * them, and never go to a cloud AI or onto the internet.
 */

interface Row {
  id: string;
  content: string;
  tags: string;
  category: MemoryCategory;
  source: MemoryEntry['source'];
  private: number;
  key: string | null;
  created_at: string;
  updated_at: string | null;
}

const toEntry = (r: Row): MemoryEntry => ({ id: r.id, content: r.content, category: r.category, source: r.source, private: !!r.private, createdAt: r.created_at, updatedAt: r.updated_at });

export interface MemoryDeps {
  db: Db;
  settings: () => Settings['memory'];
  /** A student's or child's computer: nothing is learned or remembered about them. */
  learner?: () => boolean;
  events?: EventBus;
}

/** A fact found in what the person said. */
interface Learned {
  key: string | null;
  category: MemoryCategory;
  content: string;
}

// Trailing filler that is not part of the fact ("I live in Springfield now").
const clean = (s: string) =>
  s
    .trim()
    .replace(/[\s.,;:!?]+$/, '')
    .replace(/\s+(?:now|actually|these days|nowadays|too|as well)$/i, '')
    .replace(/\s+/g, ' ');
// Lead words in any case ("My", "my", "I"), names captured only when written with a capital.
const MY = '\\b[Mm]y';
const I = '\\b[Ii]';
const APOS = "['’]";
// A proper name: capitalized words, with "of", "and", "&" or "the" between them ("Bank of America"), then maybe ", State".
const PLACE = "([A-Z][\\w&'’.-]*(?:\\s+(?:(?:of|and|&|the|de|du|la|upon)\\s+)?[A-Z][\\w&'’.-]*){0,5}(?:,\\s*[A-Z][\\w'’.-]*(?:\\s+[A-Z][\\w'’.-]*){0,2})?)";
const rx = (src: string, flags = '') => new RegExp(src, flags);
const LEARN: Array<{ re: RegExp; make: (m: RegExpExecArray) => Learned | null }> = [
  { re: /\b(?:please\s+)?(?:remember|don'?t forget|note) that ([^\n]{5,300})/i, make: (m) => ({ key: null, category: 'general', content: clean(m[1]) }) },
  { re: rx(`${MY} name is ([A-Z][\\w'-]+(?:\\s+[A-Z][\\w'-]+){0,2})`), make: (m) => ({ key: 'name', category: 'general', content: `Their name is ${clean(m[1])}` }) },
  { re: /\b(?:[Pp]lease\s+)?[Cc]all me ([A-Z][\w'-]+)/, make: (m) => ({ key: 'call-me', category: 'preference', content: `Likes to be called ${clean(m[1])}` }) },
  { re: /\bmy (?:home |mailing |street )?address is ([^\n]{8,140})/i, make: (m) => ({ key: 'home-address', category: 'address', content: `Home address: ${clean(m[1])}` }) },
  { re: /\bmy work address is ([^\n]{8,140})/i, make: (m) => ({ key: 'work-address', category: 'address', content: `Work address: ${clean(m[1])}` }) },
  { re: rx(`${I} (?:live|am living|${APOS}m living) in ${PLACE}`), make: (m) => ({ key: 'location', category: 'location', content: `Lives in ${clean(m[1])}` }) },
  { re: rx(`${I}(?:${APOS}m| am) (?:based|located) in ${PLACE}`), make: (m) => ({ key: 'location', category: 'location', content: `Lives in ${clean(m[1])}` }) },
  { re: rx(`${I} work (?:at|for) ${PLACE}`), make: (m) => ({ key: 'employer', category: 'work', content: `Works at ${clean(m[1])}` }) },
  { re: /\bi work as (?:an? )?([^.,!?\n]{3,60})/i, make: (m) => ({ key: 'job', category: 'work', content: `Works as ${clean(m[1])}` }) },
  { re: /\bmy (?:birthday|date of birth) is (?:on )?([^.,!?\n]{3,30})/i, make: (m) => ({ key: 'birthday', category: 'birthday', content: `Birthday: ${clean(m[1])}` }) },
  { re: /\bmy (?:work |personal )?e-?mail(?: address)? is (\S+@\S+\.\w+)/i, make: (m) => ({ key: 'email', category: 'contact', content: `Email: ${clean(m[1])}` }) },
  { re: /\bmy (?:phone|cell|mobile)(?: number)? is (\+?[\d(][\d\s().-]{6,20}\d)/i, make: (m) => ({ key: 'phone', category: 'contact', content: `Phone: ${clean(m[1])}` }) },
  {
    re: rx(`${MY} (wife|husband|partner|son|daughter|kid|child|mom|mother|dad|father|brother|sister|boss|manager|dog|cat)(?:${APOS}s name)? is (?:called |named )?([A-Z][\\w'-]+)`),
    make: (m) => ({ key: `family-${m[1].toLowerCase()}`, category: 'family', content: `Their ${m[1].toLowerCase()} is ${clean(m[2])}` }),
  },
  { re: /\bi (?:prefer|always want|'d rather) ([^.!?\n]{4,120})/i, make: (m) => ({ key: null, category: 'preference', content: `Prefers ${clean(m[1])}` }) },
  {
    re: /\bmy (visa|mastercard|amex|american express|discover|debit card|credit card|card)\b[^\n]{0,30}?((?:\d[ -]?){12,18}\d)/i,
    make: (m) => {
      const digits = m[2].replace(/\D/g, '');
      return { key: `card-${digits.slice(-4)}`, category: 'payment', content: `Has a ${m[1].toLowerCase()} ending ${digits.slice(-4)}` };
    },
  },
];

/**
 * The sentences of a message, so one fact never runs into the next. A period after a street or unit abbreviation
 * ("12 Oak St. Springfield") does not end a sentence.
 */
export function sentences(text: string): string[] {
  return text
    .split(/(?<!\b(?:St|Ave|Rd|Dr|Blvd|Ln|Ct|Apt|No|Mt|Ft|Mr|Mrs|Ms)\.)(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The kind of a fact told by the AI or the person, from its words. */
export function categorize(text: string): MemoryCategory {
  if (/\b(address|street|st\.|avenue|ave|road|rd\.|apt|suite|zip|postcode|p\.?o\.? box)\b/i.test(text) && /\d/.test(text)) return 'address';
  if (/\S+@\S+\.\w+|\bphone\b|\+?\d[\d\s().-]{8,}\d/i.test(text)) return 'contact';
  if (/\b(card|visa|mastercard|amex)\b.*\b\d{4}\b/i.test(text)) return 'payment';
  if (/\bbirthday|date of birth|born on\b/i.test(text)) return 'birthday';
  if (/\blives? in|based in|located in|moved to\b/i.test(text)) return 'location';
  if (/\bprefers?|likes?|dislikes?|hates?|loves?|favou?rite\b/i.test(text)) return 'preference';
  if (/\bworks? (?:at|for|as)|job|employer|colleague|manager|boss\b/i.test(text)) return 'work';
  if (/\b(wife|husband|partner|son|daughter|kids?|children|mom|dad|mother|father|brother|sister|dog|cat)\b/i.test(text)) return 'family';
  return 'general';
}

export class MemoryService {
  constructor(private readonly d: MemoryDeps) {}

  private changed(): void {
    this.d.events?.emit('memory.changed', { count: this.d.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM memories')?.n ?? 0 });
  }

  private on(): boolean {
    return this.d.settings().enabled && !this.d.learner?.();
  }

  /** Whether the person lets it keep this kind of fact. */
  allows(category: MemoryCategory): boolean {
    const keep = this.d.settings().keep;
    return !PRIVATE_MEMORY.includes(category) || !!keep[category as keyof typeof keep];
  }

  /**
   * Keeps a fact. Identity and money numbers are taken out first (and a fact that was only that is refused); a private
   * kind the person has not allowed is refused. A fact with a key replaces the older one with that key.
   */
  remember(p: { content: string; category?: MemoryCategory; key?: string | null; source: MemoryEntry['source']; tags?: string[] }): MemoryEntry {
    if (!this.on()) throw new CoreError('UNAVAILABLE', 'Memory is turned off (Settings → Memory)');
    const scrubbed = scrubSensitive(p.content.trim().slice(0, 2000), { cardLast4: this.d.settings().keep.payment });
    const rest = scrubbed.text.replace(/\[[^\]]*: never kept\]/g, '').replace(/[\W_]+/g, '');
    if (scrubbed.removed.length && rest.length < 8) throw new CoreError('FORBIDDEN', `Not kept: it is ${scrubbed.removed[0].what}, which FBRX never remembers`);
    // A full card number makes it a payment fact, whether it is kept as "card ending 1234" or not at all.
    const hasCard = findSensitive(p.content).some((f) => f.kind.id === 'card' && p.content.slice(f.start, f.end).replace(/\D/g, '').length >= 13);
    const category = p.category && MEMORY_CATEGORIES.includes(p.category) ? p.category : hasCard ? 'payment' : categorize(scrubbed.text);
    if (!this.allows(category)) throw new CoreError('FORBIDDEN', `Not kept: remembering ${category === 'payment' ? 'payment cards' : `${category} details`} is turned off (Settings → Memory)`);
    const now = new Date().toISOString();
    const priv = PRIVATE_MEMORY.includes(category) ? 1 : 0;
    const tags = (p.tags ?? []).join(' ');
    const old = p.key ? this.d.db.get<Row>('SELECT * FROM memories WHERE key = ?', p.key) : this.d.db.get<Row>('SELECT * FROM memories WHERE lower(content) = lower(?)', scrubbed.text);
    if (old) {
      this.d.db.run('UPDATE memories SET content = ?, category = ?, private = ?, source = ?, updated_at = ? WHERE id = ?', scrubbed.text, category, priv, p.source, now, old.id);
      this.changed();
      return toEntry(this.d.db.get<Row>('SELECT * FROM memories WHERE id = ?', old.id)!);
    }
    const id = newId('mem');
    this.d.db.run('INSERT INTO memories (id, content, tags, category, source, private, key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, scrubbed.text, tags, category, p.source, priv, p.key ?? null, now);
    this.changed();
    return toEntry(this.d.db.get<Row>('SELECT * FROM memories WHERE id = ?', id)!);
  }

  /** Learns lasting facts from what the person said (nothing is sent anywhere: plain pattern matching). */
  learn(text: string): MemoryEntry[] {
    const s = this.d.settings();
    if (!this.on() || !s.learn || !s.longTerm) return [];
    const kept = new Map<string, MemoryEntry>();
    for (const sentence of sentences(text.slice(0, 8000))) {
      for (const { re, make } of LEARN) {
        const m = re.exec(sentence);
        const fact = m ? make(m) : null;
        if (!fact || fact.content.length < 6) continue;
        try {
          // A later fact with the same meaning replaces the earlier one ("I live in A… I live in B").
          const e = this.remember({ ...fact, source: 'auto' });
          kept.set(e.id, e);
        } catch {
          /* never kept, or not allowed */
        }
      }
    }
    return [...kept.values()];
  }

  list(): MemoryEntry[] {
    return this.d.db.all<Row>('SELECT * FROM memories ORDER BY COALESCE(updated_at, created_at) DESC').map(toEntry);
  }

  update(id: string, content: string): MemoryEntry {
    const row = this.d.db.get<Row>('SELECT * FROM memories WHERE id = ?', id);
    if (!row) throw new CoreError('NOT_FOUND', 'That memory is gone');
    // Kept first (it may be refused), then the old wording goes.
    const e = this.remember({ content, key: row.key, source: 'person' });
    if (e.id !== id) this.forget(id);
    return e;
  }

  forget(id: string): boolean {
    const gone = this.d.db.run('DELETE FROM memories WHERE id = ?', id).changes > 0;
    if (gone) this.changed();
    return gone;
  }

  forgetAll(): number {
    const n = this.d.db.run('DELETE FROM memories').changes;
    this.changed();
    return n;
  }

  /** Facts that best match a question, then the newest. */
  recall(query: string, limit = 8, o: { privateToo?: boolean } = {}): MemoryEntry[] {
    const terms = query
      .toLowerCase()
      .match(/[\p{L}\p{N}_]{3,}/gu)
      ?.slice(0, 12);
    const priv = o.privateToo === false ? 'AND m.private = 0' : '';
    let rows: Row[] = [];
    if (terms?.length) {
      rows = this.d.db.all<Row>(
        `SELECT m.* FROM memories_fts f JOIN memories m ON m.rowid = f.rowid WHERE memories_fts MATCH ? ${priv} ORDER BY rank LIMIT ?`,
        terms.map((t) => `"${t}"`).join(' OR '),
        limit,
      );
    }
    return rows.map(toEntry);
  }

  /** Short-term memory: the conversations of the last 24 hours (not the one going on now). */
  recent(exclude: string | null, now = Date.now()): RecentChat[] {
    if (!this.on() || !this.d.settings().shortTerm) return [];
    const since = new Date(now - 24 * 3600_000).toISOString();
    const convs = this.d.db.all<{ id: string; title: string; updated_at: string }>(
      "SELECT id, title, updated_at FROM conversations WHERE updated_at >= ? AND id != ? AND origin = 'user' ORDER BY updated_at DESC LIMIT 8",
      since,
      exclude ?? '',
    );
    const cut = (t: string, n: number) => {
      const s = t.replace(/\s+/g, ' ').trim();
      return s.length > n ? `${s.slice(0, n)}…` : s;
    };
    return convs.map((c) => {
      const first = this.d.db.get<{ content: string }>("SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY seq LIMIT 1", c.id)?.content ?? '';
      const lastUser = this.d.db.get<{ content: string }>("SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY seq DESC LIMIT 1", c.id)?.content ?? '';
      const lastReply = this.d.db.get<{ content: string }>("SELECT content FROM messages WHERE conversation_id = ? AND role = 'assistant' AND content != '' ORDER BY seq DESC LIMIT 1", c.id)?.content ?? '';
      const gist = [`asked: ${cut(scrubSensitive(first).text, 220)}`, lastUser && lastUser !== first ? `last asked: ${cut(scrubSensitive(lastUser).text, 160)}` : '', lastReply ? `answer: ${cut(scrubSensitive(lastReply).text, 220)}` : '']
        .filter(Boolean)
        .join(' · ');
      return { conversationId: c.id, title: c.title, at: c.updated_at, gist };
    });
  }

  /** Long-term chat history: past messages that mention these words (newest first). */
  searchChats(query: string, limit = 10): Array<{ conversationId: string; title: string; at: string; role: string; text: string }> {
    const terms = query
      .toLowerCase()
      .match(/[\p{L}\p{N}_]{3,}/gu)
      ?.slice(0, 4);
    if (!terms?.length) return [];
    const where = terms.map(() => 'lower(m.content) LIKE ?').join(' AND ');
    return this.d.db
      .all<{ conversation_id: string; title: string; created_at: string; role: string; content: string }>(
        `SELECT m.conversation_id, c.title, m.created_at, m.role, m.content FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE m.role IN ('user', 'assistant') AND ${where} ORDER BY m.created_at DESC LIMIT ?`,
        ...terms.map((t) => `%${t.replace(/[%_]/g, '')}%`),
        Math.max(1, Math.min(30, limit)),
      )
      .map((r) => {
        const text = scrubSensitive(r.content).text.replace(/\s+/g, ' ');
        const at = Math.max(0, text.toLowerCase().indexOf(terms[0]) - 120);
        return { conversationId: r.conversation_id, title: r.title, at: r.created_at, role: r.role, text: `${at ? '…' : ''}${text.slice(at, at + 400)}${text.length > at + 400 ? '…' : ''}` };
      });
  }

  /**
   * What the AI is told about the person at the start of a chat. With a cloud AI, private facts stay behind (and
   * nothing at all goes when the person chose so); short-term memory is left out there too, as it holds their words.
   */
  context(o: { conversationId: string | null; text: string; cloud: boolean }): string | null {
    const s = this.d.settings();
    if (!this.on()) return null;
    if (o.cloud && s.cloud === 'none') return null;
    const lines: string[] = [];
    if (s.longTerm) {
      const keyed = this.d.db.all<Row>(`SELECT * FROM memories WHERE key IS NOT NULL ${o.cloud ? 'AND private = 0' : ''} ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 20`);
      const relevant = this.recall(o.text, 8, { privateToo: !o.cloud });
      const newest = this.d.db.all<Row>(`SELECT * FROM memories WHERE key IS NULL ${o.cloud ? 'AND private = 0' : ''} ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 6`);
      const seen = new Set<string>();
      const facts = [...keyed.map(toEntry), ...relevant, ...newest.map(toEntry)].filter((m) => !seen.has(m.id) && seen.add(m.id));
      if (facts.length) lines.push('## What you remember about the person (long-term memory, kept on this computer)', ...facts.slice(0, 24).map((m) => `- ${m.content}`));
    }
    if (!o.cloud) {
      const recent = this.recent(o.conversationId);
      if (recent.length) {
        if (lines.length) lines.push('');
        lines.push('## Their last 24 hours (short-term memory)', ...recent.map((r) => `- "${r.title}" (${new Date(r.at).toLocaleString()}): ${r.gist}`));
      }
    }
    if (!lines.length) return null;
    lines.push(
      '',
      'Use this to be helpful; do not recite it back unasked. When the person tells you something lasting about themselves, call memory.remember. Never put their personal details (address, phone, email, card) into an internet search or any other tool that goes online.',
    );
    return lines.join('\n');
  }

  /** Values that must never go onto the internet: the private facts (addresses, email and phone, cards). */
  privateValues(): string[] {
    return this.d.db
      .all<{ content: string; category: MemoryCategory }>("SELECT content, category FROM memories WHERE category IN ('address', 'contact', 'payment')")
      .map((r) => r.content.replace(/^[^:]{1,40}:\s*/, '').trim())
      .filter((v) => v.length >= 6);
  }

  status(conversationId: string | null = null): MemoryStatus {
    return { entries: this.list(), recent: this.recent(conversationId), neverKept: NEVER_KEPT };
  }
}
