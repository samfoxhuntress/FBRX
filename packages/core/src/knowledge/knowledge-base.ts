import { createHash } from 'node:crypto';
import { Db } from '../storage/db';
import type { Logger } from '../logger';
import { DOC_SECTIONS } from './docs.generated';
import { FIXES, PLAYBOOKS } from './playbooks';

/**
 * FBRX's own knowledge, in a search database on this computer (knowledge.db in FBRX's data folder): its guides, one
 * entry per section; the troubleshooting playbooks; the FBRX/1 commands; and the fixes fbrx.fix knows. Built from what
 * ships with FBRX, rebuilt when FBRX is updated, and never sent anywhere: the agent searches it with fbrx.help.
 */

export interface KnowledgeHit {
  kind: 'guide' | 'playbook' | 'command' | 'fix';
  ref: string;
  title: string;
  text: string;
}

export interface KnowledgeDeps {
  file: string;
  appVersion: string;
  /** FBRX/1 commands with their help. */
  commands: () => Array<{ command: string; help: string; mode: 'operational' | 'configure' }>;
  log: Pick<Logger, 'info' | 'warn'>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kb (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(title, body, content='kb', content_rowid='id', tokenize='porter unicode61');
CREATE TABLE IF NOT EXISTS kb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export class KnowledgeBase {
  private db: Db | null = null;

  constructor(private readonly d: KnowledgeDeps) {}

  /** What the database is built from: this FBRX's version and the knowledge it ships. */
  private stamp(): string {
    const h = createHash('sha256');
    h.update(this.d.appVersion);
    for (const s of DOC_SECTIONS) h.update(s.t).update(s.x);
    for (const p of PLAYBOOKS) h.update(p.id).update(p.text);
    for (const c of this.d.commands()) h.update(c.command);
    return h.digest('hex').slice(0, 16);
  }

  private open(): Db {
    if (this.db) return this.db;
    const db = new Db(this.d.file);
    db.exec(SCHEMA);
    this.db = db;
    const stamp = this.stamp();
    if (db.get<{ value: string }>("SELECT value FROM kb_meta WHERE key = 'stamp'")?.value !== stamp) this.build(stamp);
    return db;
  }

  /** (Re)builds the database from the knowledge FBRX ships. Returns how many entries it holds. */
  build(stamp = this.stamp()): number {
    const db = this.db ?? this.open();
    const rows: Array<Omit<KnowledgeHit, 'text'> & { body: string }> = [];
    for (const s of DOC_SECTIONS) rows.push({ kind: 'guide', ref: s.d, title: s.t, body: s.x });
    for (const p of PLAYBOOKS) rows.push({ kind: 'playbook', ref: p.id, title: p.title, body: `${p.text}\n\nPeople say: ${p.symptoms}.${p.fixes.length ? `\nFixes fbrx.fix can apply: ${p.fixes.join(', ')}.` : ''}` });
    for (const f of FIXES) rows.push({ kind: 'fix', ref: f.id, title: `Fix: ${f.label}`, body: `${f.detail} (fbrx.fix "${f.id}")` });
    // The FBRX/1 commands, one entry per first word ("show", "request"…), so a search finds the whole family.
    const byWord = new Map<string, string[]>();
    for (const c of this.d.commands()) {
      const key = `${c.mode === 'configure' ? 'configure: ' : ''}${c.command.split(' ')[0]}`;
      byWord.set(key, [...(byWord.get(key) ?? []), `${c.command}: ${c.help}`]);
    }
    for (const [word, lines] of byWord) rows.push({ kind: 'command', ref: word, title: `FBRX/1 command line: ${word} …`, body: `In Terminal → FBRX/1 (FBRX's own command line):\n${lines.join('\n')}` });
    db.tx(() => {
      db.exec("DELETE FROM kb; INSERT INTO kb_fts(kb_fts) VALUES('delete-all');");
      for (const r of rows) {
        const { lastInsertRowid } = db.run('INSERT INTO kb (kind, ref, title, body) VALUES (?, ?, ?, ?)', r.kind, r.ref, r.title, r.body);
        db.run('INSERT INTO kb_fts (rowid, title, body) VALUES (?, ?, ?)', lastInsertRowid, r.title, r.body);
      }
      db.run("INSERT OR REPLACE INTO kb_meta (key, value) VALUES ('stamp', ?)", stamp);
    });
    this.d.log.info('Built FBRX knowledge', { entries: rows.length });
    return rows.length;
  }

  /** The entries that best match a question, best first (titles count more than text). */
  search(query: string, limit = 6): KnowledgeHit[] {
    const db = this.open();
    const terms = query
      .toLowerCase()
      .match(/[\p{L}\p{N}_]{2,}/gu)
      ?.filter((t) => !STOP.has(t))
      .slice(0, 16);
    if (!terms?.length) return [];
    const match = terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' OR ');
    const rows = db.all<{ kind: KnowledgeHit['kind']; ref: string; title: string; body: string }>(
      `SELECT kb.kind, kb.ref, kb.title, kb.body FROM kb_fts JOIN kb ON kb.id = kb_fts.rowid
       WHERE kb_fts MATCH ? ORDER BY bm25(kb_fts, 6.0, 1.0) + (CASE kb.kind WHEN 'playbook' THEN -2.0 ELSE 0 END) LIMIT ?`,
      match,
      Math.max(1, Math.min(20, limit)),
    );
    return rows.map((r, i) => ({ kind: r.kind, ref: r.ref, title: r.title, text: r.body.length > (i < 3 ? 2400 : 900) ? `${r.body.slice(0, i < 3 ? 2400 : 900)}…` : r.body }));
  }

  count(): number {
    return this.open().get<{ n: number }>('SELECT COUNT(*) AS n FROM kb')?.n ?? 0;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

/** Words that would match everything. */
const STOP = new Set(['the', 'and', 'for', 'how', 'why', 'what', 'is', 'it', 'my', 'do', 'does', 'to', 'of', 'in', 'on', 'a', 'an', 'fbrx', 'can', 'you', 'me', 'this', 'that', 'with', 'are', 'be', 'when', 'or', 'not', 'so', 'its', 'about', 'there', 'some', 'get', 'have', 'has', 'was', 'will', 'just', 'i']);
