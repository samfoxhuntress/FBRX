import { LOGIN_LIMITS, PASSWORD_HISTORY, displayHost, loginMatch, newId, passwordStrength, siteOf, titleForUrl, type Login, type LoginInput, type LoginSummary, type PreviousPassword } from '@fbrx/shared';
import { CoreError } from '../errors';
import type { Db } from '../storage/db';
import { parseTotp, totpCode } from './totp';
import type { Vault } from './vault';

interface LoginRow {
  id: string;
  data_enc: string;
  favorite: number;
  created_at: string;
  updated_at: string;
  password_changed_at: string;
  last_used_at: string | null;
}

/** What is sealed with the vault key: everything that says what the sign-in is for, and its earlier passwords. */
type Sealed = Pick<LoginInput, 'title' | 'username' | 'password' | 'urls' | 'notes' | 'totp'> & { history: PreviousPassword[] };
/** A sign-in as far as storing over it needs. */
type Stored = Sealed & Pick<Login, 'id' | 'favorite' | 'passwordChangedAt'>;

const sealLabel = (id: string) => `login:${id}`;

/** Addresses as typed, made whole ("example.com/login" → "https://example.com/login"), without repeats or blanks. */
export function normalizeUrls(urls: string[]): string[] {
  const out: string[] = [];
  for (const raw of urls) {
    const text = raw.trim();
    if (!text) continue;
    let u: URL;
    try {
      u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
      throw new CoreError('INVALID_ARGUMENT', `"${text.slice(0, 80)}" is not a web address`);
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new CoreError('INVALID_ARGUMENT', 'Sign-ins are for web addresses (https:// or http://)');
    const url = u.toString();
    if (!out.includes(url)) out.push(url);
  }
  return out.slice(0, LOGIN_LIMITS.urls);
}

function checkLimits(d: Sealed): void {
  const long = (['title', 'username', 'password', 'notes', 'totp'] as const).find((k) => d[k].length > LOGIN_LIMITS[k]);
  if (long) throw new CoreError('INVALID_ARGUMENT', `The ${long} is too long (at most ${LOGIN_LIMITS[long]} characters)`);
  if (d.urls.some((u) => u.length > LOGIN_LIMITS.url)) throw new CoreError('INVALID_ARGUMENT', 'A web address is too long');
}

function summary(l: Login): LoginSummary {
  const { password: _p, notes: _n, totp: _t, history: _h, ...rest } = l;
  return rest;
}

/** The earlier passwords after a change from `before` to `password` (the one replaced first). */
function nextHistory(before: Pick<Sealed, 'password' | 'history'> | null, password: string): PreviousPassword[] {
  if (!before) return [];
  if (!before.password || before.password === password) return before.history;
  return [{ password: before.password, until: new Date().toISOString() }, ...before.history.filter((h) => h.password !== password)].slice(0, PASSWORD_HISTORY);
}

const byFavoriteThenTitle = (a: LoginSummary, b: LoginSummary) => Number(b.favorite) - Number(a.favorite) || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });

/**
 * The Vault's password keeper. Each sign-in is one row whose content is sealed with the vault key (AES-256-GCM, bound
 * to the sign-in's id), so it is as safe as the credentials beside it, comes back with a backup, and is gone with a
 * vault reset. Strength and reuse are worked out when listing, from the passwords themselves, and never stored.
 */
export class Passwords {
  constructor(
    private readonly db: Db,
    private readonly vault: Vault,
  ) {}

  list(): LoginSummary[] {
    return this.all().map(summary).sort(byFavoriteThenTitle);
  }

  /** The sign-ins for a web address: the same host first, then the most recently used. */
  query(url: string): LoginSummary[] {
    return this.all()
      .map((l) => ({ l, match: loginMatch(l.urls, url) }))
      .filter((x) => x.match > 0)
      .sort((a, b) => b.match - a.match || (b.l.lastUsedAt ?? '').localeCompare(a.l.lastUsedAt ?? ''))
      .map((x) => summary(x.l));
  }

  reveal(id: string): Login {
    const l = this.all().find((x) => x.id === id);
    if (!l) throw new CoreError('NOT_FOUND', 'That sign-in is not in the Vault');
    return l;
  }

  /** Adds a sign-in, or changes one (id): only the fields given change. Its title comes from its site when blank. */
  save(input: { id?: string } & Partial<LoginInput>): LoginSummary {
    const before = input.id ? this.reveal(input.id) : null;
    const urls = input.urls !== undefined ? normalizeUrls(input.urls) : (before?.urls ?? []);
    const password = input.password ?? before?.password ?? '';
    const d: Sealed = {
      title: (input.title ?? before?.title ?? '').trim() || titleForUrl(urls[0] ?? '') || 'Sign-in',
      username: (input.username ?? before?.username ?? '').trim(),
      password,
      urls,
      notes: input.notes ?? before?.notes ?? '',
      totp: (input.totp ?? before?.totp ?? '').trim(),
      history: nextHistory(before, password),
    };
    if (!d.username && !d.password) throw new CoreError('INVALID_ARGUMENT', 'A sign-in needs a username or a password');
    if (d.totp && !parseTotp(d.totp)) {
      throw new CoreError('INVALID_ARGUMENT', 'That is not a 2-step key: paste the key the site shows (letters and the digits 2–7), or its otpauth:// address');
    }
    const id = this.write(before, d, input.favorite ?? before?.favorite ?? false);
    this.vault.touched();
    return this.list().find((l) => l.id === id)!;
  }

  remove(id: string): boolean {
    const { changes } = this.db.run('DELETE FROM vault_logins WHERE id = ?', id);
    if (changes) this.vault.touched();
    return changes > 0;
  }

  /** What FBRX Browser types into a sign-in form: only on a page of one of the sign-in's sites. */
  fill(id: string, url: string): { username: string; password: string } {
    const l = this.reveal(id);
    if (!loginMatch(l.urls, url)) throw new CoreError('FORBIDDEN', `This sign-in is not for ${displayHost(url)}`);
    this.db.run('UPDATE vault_logins SET last_used_at = ? WHERE id = ?', new Date().toISOString(), id);
    return { username: l.username, password: l.password };
  }

  /** Whether the Vault has this sign-in for the page's site: the same password, another one, or none at all. */
  verify(url: string, username: string, password: string): { found: 'none' | 'same' | 'changed'; id: string | null; title: string | null } {
    const name = username.trim().toLowerCase();
    const l = this.all()
      .filter((x) => loginMatch(x.urls, url) > 0 && x.username.toLowerCase() === name)
      .sort((a, b) => loginMatch(b.urls, url) - loginMatch(a.urls, url))[0];
    if (!l) return { found: 'none', id: null, title: null };
    return { found: l.password === password ? 'same' : 'changed', id: l.id, title: l.title };
  }

  /** The sign-in's 2-step code now. */
  code(id: string): { code: string; remaining: number; period: number } {
    const spec = parseTotp(this.reveal(id).totp);
    if (!spec) throw new CoreError('NOT_FOUND', 'This sign-in has no 2-step key');
    return totpCode(spec);
  }

  /**
   * Sign-ins from the CSV file a browser or password manager exports (its columns are found by name). One the Vault
   * already has (same site and username) takes the file's password when it differs; the same one again is skipped.
   */
  import(csv: string): { added: number; updated: number; skipped: number } {
    const rows = readLoginsCsv(csv);
    const known = new Map<string, Stored>(this.all().map((l) => [importKey(l), l]));
    let added = 0;
    let updated = 0;
    let skipped = 0;
    this.db.tx(() => {
      for (const r of rows) {
        let urls: string[];
        try {
          urls = normalizeUrls(r.url ? [r.url] : []);
        } catch {
          urls = [];
        }
        const d: Sealed = {
          title: r.title.trim().slice(0, LOGIN_LIMITS.title) || titleForUrl(urls[0] ?? '') || 'Sign-in',
          username: r.username.trim().slice(0, LOGIN_LIMITS.username),
          password: r.password.slice(0, LOGIN_LIMITS.password),
          urls,
          notes: r.notes.slice(0, LOGIN_LIMITS.notes),
          totp: r.totp.trim() && parseTotp(r.totp) ? r.totp.trim() : '',
          history: [],
        };
        if (!d.username && !d.password) {
          skipped++;
          continue;
        }
        const key = importKey(d);
        const same = known.get(key);
        if (same && same.password === d.password) {
          skipped++;
          continue;
        }
        const next: Sealed = same ? { ...same, password: d.password, notes: same.notes || d.notes, totp: same.totp || d.totp, history: nextHistory(same, d.password) } : d;
        const favorite = same?.favorite ?? r.favorite;
        const id = this.write(same ?? null, next, favorite);
        if (same) updated++;
        else added++;
        // A later row for the same sign-in in this file meets this one.
        known.set(key, { ...next, id, favorite, passwordChangedAt: '' });
      }
    });
    if (added || updated) this.vault.touched();
    return { added, updated, skipped };
  }

  /** The passwords themselves, for the output redactor (so one never reaches a model). Empty while locked. */
  valuesForRedaction(): Array<{ name: string; value: string }> {
    if (!this.vault.isUnlocked) return [];
    const out: Array<{ name: string; value: string }> = [];
    for (const l of this.all()) if (l.password.length >= 6) out.push({ name: `sign-in ${l.title}`, value: l.password });
    return out;
  }

  /** Stores a sign-in (new, or over `before`) and gives its id. Its password's date moves only when it changed. */
  private write(before: Stored | null, d: Sealed, favorite: boolean): string {
    checkLimits(d);
    const now = new Date().toISOString();
    const id = before?.id ?? newId('login');
    const sealed = this.vault.seal(sealLabel(id), JSON.stringify({ title: d.title, username: d.username, password: d.password, urls: d.urls, notes: d.notes, totp: d.totp, history: d.history } satisfies Sealed));
    if (before) {
      this.db.run(
        'UPDATE vault_logins SET data_enc = ?, favorite = ?, updated_at = ?, password_changed_at = ? WHERE id = ?',
        sealed,
        favorite ? 1 : 0,
        now,
        d.password === before.password ? before.passwordChangedAt : now,
        id,
      );
    } else {
      this.db.run(
        'INSERT INTO vault_logins (id, data_enc, favorite, created_at, updated_at, password_changed_at) VALUES (?,?,?,?,?,?)',
        id,
        sealed,
        favorite ? 1 : 0,
        now,
        now,
        now,
      );
    }
    return id;
  }

  /** Every sign-in, opened (the vault must be unlocked), with its strength and whether its password is reused. */
  private all(): Login[] {
    const open = this.db.all<LoginRow>('SELECT * FROM vault_logins').map((r) => ({ r, d: JSON.parse(this.vault.unseal(sealLabel(r.id), r.data_enc)) as Sealed }));
    const uses = new Map<string, number>();
    for (const { d } of open) if (d.password) uses.set(d.password, (uses.get(d.password) ?? 0) + 1);
    return open.map(({ r, d }) => ({
      id: r.id,
      ...d,
      favorite: !!r.favorite,
      hasTotp: !!d.totp,
      hasNotes: !!d.notes.trim(),
      strength: passwordStrength(d.password),
      reused: (uses.get(d.password) ?? 0) > 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      passwordChangedAt: r.password_changed_at,
      lastUsedAt: r.last_used_at,
    }));
  }
}

/** The same sign-in, as far as an import can tell: its site (or title) and username. */
function importKey(l: Pick<Sealed, 'title' | 'username' | 'urls'>): string {
  return `${(l.urls[0] && siteOf(l.urls[0])) || l.title.toLowerCase()}|${l.username.toLowerCase()}`;
}

interface CsvLogin {
  title: string;
  url: string;
  username: string;
  password: string;
  notes: string;
  totp: string;
  favorite: boolean;
}

/** Each column's names in the files browsers and password managers export (compared in lowercase). */
const COLUMNS: Record<keyof CsvLogin | 'type', string[]> = {
  title: ['name', 'title', 'account', 'item name'],
  url: ['url', 'login_uri', 'website', 'web site', 'uri', 'login url', 'hostname', 'origin'],
  username: ['username', 'login_username', 'user name', 'login', 'email', 'user', 'login name'],
  password: ['password', 'login_password'],
  notes: ['note', 'notes', 'extra', 'comments'],
  totp: ['totp', 'login_totp', 'otpauth', 'one-time password', 'otp'],
  favorite: ['favorite', 'favourite', 'fav'],
  type: ['type'],
};
const MAX_IMPORT_ROWS = 10_000;

/** The sign-ins in an exported CSV file (header row first). Rows of another kind (a card, a note) are left out. */
export function readLoginsCsv(csv: string): CsvLogin[] {
  const [head, ...rows] = parseCsv(csv);
  if (!head) throw new CoreError('INVALID_ARGUMENT', 'The file is empty');
  const names = head.map((h) => h.trim().toLowerCase());
  const col = (k: keyof typeof COLUMNS) => names.findIndex((n) => COLUMNS[k].includes(n));
  const at = Object.fromEntries((Object.keys(COLUMNS) as Array<keyof typeof COLUMNS>).map((k) => [k, col(k)])) as Record<keyof typeof COLUMNS, number>;
  if (at.password < 0 && at.username < 0) {
    throw new CoreError('INVALID_ARGUMENT', 'This file has no username or password column. Export your passwords as a CSV file from your browser or password manager, then import that.');
  }
  const cell = (r: string[], k: keyof typeof COLUMNS) => (at[k] >= 0 ? (r[at[k]] ?? '') : '');
  return rows
    .slice(0, MAX_IMPORT_ROWS)
    .filter((r) => !cell(r, 'type') || cell(r, 'type').trim().toLowerCase() === 'login')
    .map((r) => ({
      title: cell(r, 'title'),
      url: cell(r, 'url'),
      username: cell(r, 'username'),
      password: cell(r, 'password'),
      notes: cell(r, 'notes'),
      totp: cell(r, 'totp'),
      favorite: /^(1|true|yes|y|x)$/i.test(cell(r, 'favorite').trim()),
    }));
}

/** Comma-separated values (RFC 4180): quoted fields may hold commas, quotes ("") and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const t = text.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (t[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) rows.push([...row, field]);
  return rows.filter((r) => r.some((f) => f.trim()));
}
