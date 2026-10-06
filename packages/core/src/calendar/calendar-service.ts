import { randomBytes } from 'node:crypto';
import {
  CALENDAR_COLORS,
  isPathLocked,
  newId,
  type CalendarAccount,
  type CalendarEvent,
  type CalendarFreeSlot,
  type CalendarKind,
  type CalendarShowAs,
  type CalendarSignIn,
  type CalendarSource,
  type CalendarStatus,
  type NewCalendarEvent,
  type Settings,
} from '@fbrx/shared';
import { CoreError, errorMessage } from '../errors';
import type { EventBus } from '../events';
import type { Logger } from '../logger';
import type { Db } from '../storage/db';
import type { Vault } from '../vault/vault';
import { parseIcs } from './ics';
import { authorizeUrl, GraphClient, loopbackListener, msEndpoints, msScopes, msToken, pkcePair, type GraphOccurrence, type MsEndpoints, type MsTokens } from './microsoft';

/**
 * Calendar (Workspace → Calendar, FBRX Glass, reminders and the agent's calendar tools).
 *
 * - Outlook / Microsoft 365: the person signs in in the browser; the refresh token is an internal vault secret and
 *   access tokens stay in memory. Microsoft expands repeating meetings; FBRX keeps the last week and the next two
 *   months on the computer and refreshes them every few minutes.
 * - Calendar links (iCalendar): the address is a credential too (a "secret address"), so it lives in the vault.
 * - Reading is open to the agent's read tools; adding an event goes through approvals like any change.
 */

const SECRET = (id: string) => `fbrx.calendar.${id}`;
const PAST_DAYS = 7;
const FUTURE_DAYS = 62;
const MAX_FEED_BYTES = 15 * 1024 * 1024;
const SIGN_IN_MINUTES = 10;

interface AccountRow {
  id: string;
  kind: CalendarKind;
  name: string;
  address: string | null;
  color: string;
  enabled: number;
  can_write: number;
  calendars: string;
  config: string;
  last_sync_at: string | null;
  last_error: string | null;
  created_at: string;
}

interface EventRow {
  account_id: string;
  calendar_id: string;
  id: string;
  title: string;
  start: string;
  end: string;
  all_day: number;
  location: string | null;
  organizer: string | null;
  join_url: string | null;
  web_link: string | null;
  show_as: string;
  cancelled: number;
}

interface MsConfig {
  clientId: string;
  tenant: string;
}

interface PendingSignIn extends CalendarSignIn {
  close: () => void;
  timer: NodeJS.Timeout;
}

type Occurrence = Omit<GraphOccurrence, 'id'> & { id: string; calendarId: string };

export interface CalendarDeps {
  db: Db;
  vault: Vault;
  events: EventBus;
  log: Logger;
  settings: () => Settings['calendar'];
  /** Settings paths locked by the organization. */
  locked: () => readonly string[];
  /** The Microsoft app (client) ID built into this copy of FBRX, if any. */
  builtInClientId: string | null;
  internet: () => boolean;
  notify: (title: string, body: string) => void;
  endpoints?: MsEndpoints;
}

/** "webcal://…" and "https://…" calendar addresses; anything else is refused. */
export function normalizeCalendarLink(raw: string): URL {
  const s = raw.trim().replace(/^webcals?:\/\//i, 'https://');
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new CoreError('INVALID_ARGUMENT', 'That is not a web address. Paste the calendar’s iCal / ICS link (it usually ends in .ics).');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new CoreError('INVALID_ARGUMENT', 'Calendar links start with https://, http:// or webcal://');
  return u;
}

async function fetchFeed(url: string): Promise<string> {
  const res = await fetch(url, { headers: { accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5', 'user-agent': 'FBRX-Calendar' }, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    if (res.status === 404 || res.status === 410) throw new Error('The calendar link no longer works (it was removed or reset). Publish the calendar again and paste the new link.');
    if (res.status === 401 || res.status === 403) throw new Error('This calendar link needs a sign-in. Use the calendar’s public or secret iCal address instead.');
    throw new Error(`The calendar link answered HTTP ${res.status}.`);
  }
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FEED_BYTES) {
      await reader.cancel();
      throw new Error('This calendar is too large to keep on the computer (over 15 MB).');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const window = () => {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - PAST_DAYS);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + FUTURE_DAYS);
  return { from, to };
};

export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** "2026-10-06" (a day) or an ISO time. */
export function parseWhen(s: string): { date: Date; dateOnly: boolean } {
  const t = s.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return { date: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])), dateOnly: true };
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) throw new CoreError('INVALID_ARGUMENT', `Not a date or time: "${s}" (use 2026-10-06 or 2026-10-06T14:30)`);
  return { date: d, dateOnly: false };
}

export class CalendarService {
  private syncTimer: NodeJS.Timeout | null = null;
  private remindTimer: NodeJS.Timeout | null = null;
  private syncEvery = 0;
  private running = false;
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly tokens = new Map<string, MsTokens>();
  private readonly reminded = new Set<string>();
  private pending: PendingSignIn | null = null;
  private readonly ep: MsEndpoints;

  constructor(private readonly d: CalendarDeps) {
    this.ep = d.endpoints ?? msEndpoints();
  }

  // ------------------------------------------------------------------------------------------ lifecycle

  start(): void {
    this.running = true;
    this.schedule();
    const kick = setTimeout(() => void this.syncAll(), 3_000);
    kick.unref?.();
    this.remindTimer = setInterval(() => this.remind(), 30_000);
    this.remindTimer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.remindTimer) clearInterval(this.remindTimer);
    this.syncTimer = null;
    this.remindTimer = null;
    this.syncEvery = 0;
    this.endSignIn();
  }

  /** Follows the "sync every" setting. */
  schedule(): void {
    if (!this.running) return;
    const minutes = this.d.settings().syncMinutes;
    if (this.syncTimer && this.syncEvery === minutes) return;
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncEvery = minutes;
    this.syncTimer = setInterval(() => void this.syncAll(), minutes * 60_000);
    this.syncTimer.unref?.();
  }

  // --------------------------------------------------------------------------------------------- views

  private row(id: string): AccountRow {
    const r = this.d.db.get<AccountRow>('SELECT * FROM calendar_accounts WHERE id = ?', id);
    if (!r) throw new CoreError('NOT_FOUND', 'That calendar is no longer connected.');
    return r;
  }

  private view(r: AccountRow): CalendarAccount {
    const n = this.d.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM calendar_events WHERE account_id = ?', r.id)?.n ?? 0;
    return {
      id: r.id,
      kind: r.kind,
      name: r.name,
      address: r.address,
      color: r.color,
      enabled: !!r.enabled,
      calendars: JSON.parse(r.calendars) as CalendarSource[],
      canWrite: !!r.can_write,
      lastSyncAt: r.last_sync_at,
      lastError: r.last_error,
      events: n,
      createdAt: r.created_at,
    };
  }

  accounts(): CalendarAccount[] {
    return this.d.db.all<AccountRow>('SELECT * FROM calendar_accounts ORDER BY created_at').map((r) => this.view(r));
  }

  private msConfig(): MsConfig | null {
    const s = this.d.settings().microsoft;
    const clientId = s.clientId.trim() || this.d.builtInClientId || '';
    return clientId ? { clientId, tenant: s.tenant.trim() || 'common' } : null;
  }

  status(): CalendarStatus {
    const s = this.d.settings();
    const locked = this.d.locked();
    return {
      accounts: this.accounts(),
      microsoft: {
        configured: !!this.msConfig(),
        managed: !!s.microsoft.clientId.trim() && isPathLocked('calendar.microsoft.clientId', locked),
        builtIn: !!this.d.builtInClientId,
        tenant: s.microsoft.tenant || 'common',
        readOnly: s.microsoft.readOnly,
      },
      remindMinutes: s.remindMinutes,
      syncMinutes: s.syncMinutes,
      signIn: this.pending ? { id: this.pending.id, url: this.pending.url, startedAt: this.pending.startedAt } : null,
    };
  }

  /** Events that overlap [from, to) in the accounts and calendars that are turned on. */
  events(from: Date, to: Date, accountId?: string): CalendarEvent[] {
    const accounts = new Map(this.d.db.all<AccountRow>('SELECT * FROM calendar_accounts WHERE enabled = 1').map((r) => [r.id, { r, cals: new Map((JSON.parse(r.calendars) as CalendarSource[]).map((c) => [c.id, c])) }]));
    const rows = this.d.db.all<EventRow>(
      `SELECT * FROM calendar_events WHERE start < ? AND (end > ? OR start >= ?)${accountId ? ' AND account_id = ?' : ''} ORDER BY start, title`,
      to.toISOString(),
      from.toISOString(),
      from.toISOString(),
      ...(accountId ? [accountId] : []),
    );
    const out: CalendarEvent[] = [];
    for (const e of rows) {
      const a = accounts.get(e.account_id);
      if (!a) continue;
      const cal = a.cals.get(e.calendar_id);
      if (cal && !cal.enabled) continue;
      out.push({
        accountId: e.account_id,
        calendarId: e.calendar_id,
        id: e.id,
        title: e.title,
        start: e.start,
        end: e.end,
        allDay: !!e.all_day,
        location: e.location,
        organizer: e.organizer,
        joinUrl: e.join_url,
        webLink: e.web_link,
        showAs: e.show_as as CalendarShowAs,
        cancelled: !!e.cancelled,
        color: a.r.color,
        accountName: a.r.name,
        calendarName: cal?.name ?? a.r.name,
        canDelete: a.r.kind === 'microsoft' && !!a.r.can_write && (cal?.canWrite ?? false),
      });
    }
    return out;
  }

  /** Open stretches of at least `minMinutes` within the working hours of each day. */
  freeSlots(from: Date, days: number, minMinutes: number, dayStart: string, dayEnd: string): CalendarFreeSlot[] {
    const [sh, sm] = dayStart.split(':').map(Number);
    const [eh, em] = dayEnd.split(':').map(Number);
    const out: CalendarFreeSlot[] = [];
    for (let i = 0; i < days; i++) {
      const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
      let cursor = new Date(day.getFullYear(), day.getMonth(), day.getDate(), sh, sm).getTime();
      const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), eh, em).getTime();
      cursor = Math.max(cursor, i === 0 ? Math.ceil(Date.now() / 300_000) * 300_000 : cursor);
      const busy = this.events(new Date(cursor), new Date(end))
        .filter((e) => !e.allDay && !e.cancelled && e.showAs !== 'free')
        .map((e) => [new Date(e.start).getTime(), new Date(e.end).getTime()] as const)
        .sort((a, b) => a[0] - b[0]);
      for (const [s, e] of busy) {
        if (s - cursor >= minMinutes * 60_000) out.push({ start: new Date(cursor).toISOString(), end: new Date(s).toISOString(), minutes: Math.round((s - cursor) / 60_000) });
        cursor = Math.max(cursor, e);
      }
      if (end - cursor >= minMinutes * 60_000) out.push({ start: new Date(cursor).toISOString(), end: new Date(end).toISOString(), minutes: Math.round((end - cursor) / 60_000) });
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------ accounts

  private nextColor(): string {
    const used = new Set(this.d.db.all<{ color: string }>('SELECT color FROM calendar_accounts').map((r) => r.color));
    return CALENDAR_COLORS.find((c) => !used.has(c)) ?? CALENDAR_COLORS[used.size % CALENDAR_COLORS.length];
  }

  private requireReady() {
    if (!this.d.internet()) throw new CoreError('POLICY_DENIED', 'Internet access is blocked by policy.');
    if (!this.d.vault.isUnlocked) throw new CoreError('LOCKED', 'Your saved credentials are locked. Unlock them first (calendar sign-ins are kept with them).');
  }

  private changed(reason: 'accounts' | 'synced') {
    this.d.events.emit('calendar.changed', { reason });
  }

  /** Adds a calendar link after reading it once (so a wrong address is caught right away). */
  async addLink(p: { name: string; url: string; color?: string }): Promise<CalendarAccount> {
    const url = normalizeCalendarLink(p.url);
    this.requireReady();
    const { from, to } = window();
    let parsed: ReturnType<typeof parseIcs>;
    try {
      parsed = parseIcs(await fetchFeed(url.toString()), from, to);
    } catch (err) {
      throw new CoreError('INVALID_ARGUMENT', errorMessage(err));
    }
    const id = newId('cal');
    const name = p.name.trim() || parsed.name || url.hostname;
    this.d.vault.set({ name: SECRET(id), value: url.toString(), kind: 'token', description: `Calendar link for ${name}` }, { internal: true });
    this.d.db.run(
      'INSERT INTO calendar_accounts (id, kind, name, address, color, enabled, can_write, calendars, config, created_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?)',
      id,
      'ics',
      name,
      url.hostname,
      p.color ?? this.nextColor(),
      JSON.stringify([{ id: 'feed', name: parsed.name ?? name, enabled: true, canWrite: false, isDefault: true }] satisfies CalendarSource[]),
      '{}',
      new Date().toISOString(),
    );
    this.store(id, parsed.events.map((e) => ({ ...e, calendarId: 'feed' })));
    this.d.db.run('UPDATE calendar_accounts SET last_sync_at = ?, last_error = NULL WHERE id = ?', new Date().toISOString(), id);
    this.changed('accounts');
    return this.view(this.row(id));
  }

  update(id: string, p: { name?: string; color?: string; enabled?: boolean; calendars?: Array<{ id: string; enabled: boolean }> }): CalendarAccount {
    const r = this.row(id);
    const cals = JSON.parse(r.calendars) as CalendarSource[];
    for (const c of p.calendars ?? []) {
      const found = cals.find((x) => x.id === c.id);
      if (found) found.enabled = c.enabled;
    }
    this.d.db.run(
      'UPDATE calendar_accounts SET name = ?, color = ?, enabled = ?, calendars = ? WHERE id = ?',
      p.name?.trim() || r.name,
      p.color ?? r.color,
      p.enabled === undefined ? r.enabled : p.enabled ? 1 : 0,
      JSON.stringify(cals),
      id,
    );
    this.changed('accounts');
    // A calendar turned on again is fetched now.
    if ((p.enabled || p.calendars?.some((c) => c.enabled)) && r.kind === 'microsoft') void this.sync(id);
    return this.view(this.row(id));
  }

  remove(id: string): { deleted: boolean } {
    this.row(id);
    this.d.db.tx(() => {
      this.d.db.run('DELETE FROM calendar_events WHERE account_id = ?', id);
      this.d.db.run('DELETE FROM calendar_accounts WHERE id = ?', id);
    });
    this.d.vault.delete(SECRET(id), { internal: true });
    this.tokens.delete(id);
    this.changed('accounts');
    return { deleted: true };
  }

  // ---------------------------------------------------------------------------------- Microsoft sign-in

  /** Starts signing in: the person opens the returned address in their browser. */
  async signIn(): Promise<CalendarSignIn> {
    const ms = this.msConfig();
    if (!ms)
      throw new CoreError(
        'UNAVAILABLE',
        'To sign in to Outlook / Microsoft 365, FBRX needs a Microsoft app (client) ID. Your organization can set it from FBRX Command, or add your own in Calendar → Settings. A calendar link works without one.',
      );
    this.requireReady();
    this.endSignIn();
    const { verifier, challenge } = pkcePair();
    const state = randomBytes(16).toString('base64url');
    const id = newId('signin');
    const readOnly = this.d.settings().microsoft.readOnly;
    let redirectUri = '';
    const listener = await loopbackListener(state, async (q) => {
      try {
        const error = q.get('error');
        if (error) throw new Error(q.get('error_description')?.split(/\r?\n/)[0] || (error === 'access_denied' ? 'Sign-in was cancelled.' : `Microsoft sign-in failed (${error})`));
        const code = q.get('code');
        if (!code) throw new Error('Microsoft did not send a sign-in code.');
        const tokens = await msToken(this.ep, ms.tenant, { client_id: ms.clientId, grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, scope: msScopes(readOnly) });
        const accountId = await this.finishSignIn(ms, tokens);
        this.d.events.emit('calendar.changed', { reason: 'signin', signIn: { id, ok: true, accountId } });
      } catch (err) {
        this.d.events.emit('calendar.changed', { reason: 'signin', signIn: { id, ok: false, error: errorMessage(err) } });
        throw err;
      } finally {
        if (this.pending?.id === id) this.endSignIn();
      }
    });
    redirectUri = `http://localhost:${listener.port}`;
    const url = authorizeUrl(this.ep, { tenant: ms.tenant, clientId: ms.clientId, redirectUri, challenge, state, readOnly });
    const timer = setTimeout(() => {
      if (this.pending?.id !== id) return;
      this.endSignIn();
      this.d.events.emit('calendar.changed', { reason: 'signin', signIn: { id, ok: false, error: 'Sign-in took too long. Try again.' } });
    }, SIGN_IN_MINUTES * 60_000);
    timer.unref?.();
    this.pending = { id, url, startedAt: new Date().toISOString(), close: listener.close, timer };
    return { id, url, startedAt: this.pending.startedAt };
  }

  cancelSignIn(): { ok: true } {
    const p = this.pending;
    this.endSignIn();
    if (p) this.d.events.emit('calendar.changed', { reason: 'signin', signIn: { id: p.id, ok: false, error: 'Sign-in was cancelled.' } });
    return { ok: true };
  }

  private endSignIn() {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.close();
    this.pending = null;
  }

  /** Keeps the sign-in: a new account, or the same address signed in again. */
  private async finishSignIn(ms: MsConfig, tokens: MsTokens): Promise<string> {
    if (!tokens.refreshToken) throw new Error('Microsoft did not allow FBRX to stay signed in (no offline access).');
    const graph = new GraphClient(this.ep, async () => tokens.accessToken);
    const me = await graph.me();
    const calendars = await graph.calendars();
    const canWrite = /Calendars\.ReadWrite/i.test(tokens.scope);
    const existing = this.d.db.get<AccountRow>("SELECT * FROM calendar_accounts WHERE kind = 'microsoft' AND lower(address) = lower(?)", me.address ?? '');
    const id = existing?.id ?? newId('cal');
    const before = new Map(existing ? (JSON.parse(existing.calendars) as CalendarSource[]).map((c) => [c.id, c.enabled]) : []);
    const sources: CalendarSource[] = calendars.map((c) => ({ id: c.id, name: c.name, enabled: before.get(c.id) ?? true, canWrite: canWrite && c.canEdit, isDefault: c.isDefaultCalendar }));
    this.d.vault.set({ name: SECRET(id), value: tokens.refreshToken, kind: 'token', description: `Outlook / Microsoft 365 calendar for ${me.address ?? me.name ?? 'an account'}` }, { internal: true });
    if (existing) {
      this.d.db.run('UPDATE calendar_accounts SET can_write = ?, calendars = ?, config = ?, last_error = NULL WHERE id = ?', canWrite ? 1 : 0, JSON.stringify(sources), JSON.stringify(ms), id);
    } else {
      this.d.db.run(
        'INSERT INTO calendar_accounts (id, kind, name, address, color, enabled, can_write, calendars, config, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)',
        id,
        'microsoft',
        me.name ?? me.address ?? 'Outlook',
        me.address,
        this.nextColor(),
        canWrite ? 1 : 0,
        JSON.stringify(sources),
        JSON.stringify(ms),
        new Date().toISOString(),
      );
    }
    this.tokens.set(id, tokens);
    this.changed('accounts');
    await this.sync(id);
    return id;
  }

  private async accessToken(id: string, force = false): Promise<string> {
    const cached = this.tokens.get(id);
    if (!force && cached && cached.expiresAt - 60_000 > Date.now()) return cached.accessToken;
    const r = this.row(id);
    const cfg = JSON.parse(r.config) as Partial<MsConfig>;
    const ms = cfg.clientId ? { clientId: cfg.clientId, tenant: cfg.tenant || 'common' } : this.msConfig();
    if (!ms) throw new Error('No Microsoft app (client) ID is set any more. Set it in Calendar → Settings.');
    const refresh = this.d.vault.get(SECRET(id), { allowInternal: true });
    if (!refresh) throw new Error('FBRX is no longer signed in to this calendar. Sign in again.');
    let t: MsTokens;
    try {
      t = await msToken(this.ep, ms.tenant, { client_id: ms.clientId, grant_type: 'refresh_token', refresh_token: refresh, scope: msScopes(!r.can_write) });
    } catch (err) {
      if ((err as { code?: string }).code === 'invalid_grant') throw new Error('Microsoft ended this sign-in (the password changed, or access was removed). Sign in again.');
      throw err;
    }
    if (t.refreshToken && t.refreshToken !== refresh) this.d.vault.set({ name: SECRET(id), value: t.refreshToken, kind: 'token' }, { internal: true });
    this.tokens.set(id, t);
    return t.accessToken;
  }

  private graph(id: string): GraphClient {
    return new GraphClient(this.ep, (force) => this.accessToken(id, force));
  }

  // ---------------------------------------------------------------------------------------------- sync

  async syncAll(): Promise<void> {
    this.schedule();
    const ids = this.d.db.all<{ id: string }>('SELECT id FROM calendar_accounts WHERE enabled = 1').map((r) => r.id);
    await Promise.all(ids.map((id) => this.sync(id)));
  }

  sync(id: string): Promise<void> {
    const running = this.inflight.get(id);
    if (running) return running;
    const p = this.syncNow(id).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  private async syncNow(id: string): Promise<void> {
    let r: AccountRow;
    try {
      r = this.row(id);
    } catch {
      return;
    }
    try {
      this.requireReady();
      const { from, to } = window();
      let found: Occurrence[];
      if (r.kind === 'ics') {
        const url = this.d.vault.get(SECRET(id), { allowInternal: true });
        if (!url) throw new Error('The calendar link is missing. Remove this calendar and add the link again.');
        found = parseIcs(await fetchFeed(url), from, to).events.map((e) => ({ ...e, calendarId: 'feed' }));
      } else {
        const graph = this.graph(id);
        const before = new Map((JSON.parse(r.calendars) as CalendarSource[]).map((c) => [c.id, c.enabled]));
        const canWrite = !!r.can_write;
        const sources: CalendarSource[] = (await graph.calendars()).map((c) => ({ id: c.id, name: c.name, enabled: before.get(c.id) ?? true, canWrite: canWrite && c.canEdit, isDefault: c.isDefaultCalendar }));
        found = [];
        for (const c of sources.filter((x) => x.enabled)) for (const e of await graph.calendarView(c.id, from, to)) found.push({ ...e, calendarId: c.id });
        if (!this.d.db.get('SELECT 1 FROM calendar_accounts WHERE id = ?', id)) return;
        this.d.db.run('UPDATE calendar_accounts SET calendars = ? WHERE id = ?', JSON.stringify(sources), id);
      }
      if (!this.d.db.get('SELECT 1 FROM calendar_accounts WHERE id = ?', id)) return;
      this.store(id, found);
      this.d.db.run('UPDATE calendar_accounts SET last_sync_at = ?, last_error = NULL WHERE id = ?', new Date().toISOString(), id);
    } catch (err) {
      const msg = errorMessage(err);
      this.d.log.warn('Calendar sync failed', { account: id, error: msg });
      if (this.d.db.get('SELECT 1 FROM calendar_accounts WHERE id = ?', id)) this.d.db.run('UPDATE calendar_accounts SET last_error = ? WHERE id = ?', msg, id);
    }
    this.changed('synced');
  }

  private insert(accountId: string, e: Occurrence) {
    this.d.db.run(
      `INSERT OR REPLACE INTO calendar_events (account_id, calendar_id, id, title, start, end, all_day, location, organizer, join_url, web_link, show_as, cancelled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      accountId,
      e.calendarId,
      e.id,
      e.title.slice(0, 500),
      e.start.toISOString(),
      e.end.toISOString(),
      e.allDay ? 1 : 0,
      e.location?.slice(0, 500) ?? null,
      e.organizer?.slice(0, 200) ?? null,
      e.joinUrl?.slice(0, 2000) ?? null,
      e.webLink?.slice(0, 2000) ?? null,
      e.showAs,
      e.cancelled ? 1 : 0,
    );
  }

  private store(accountId: string, list: Occurrence[]) {
    this.d.db.tx(() => {
      this.d.db.run('DELETE FROM calendar_events WHERE account_id = ?', accountId);
      for (const e of list) this.insert(accountId, e);
    });
  }

  // ------------------------------------------------------------------------------------- adding events

  async create(p: NewCalendarEvent): Promise<CalendarEvent> {
    const title = p.title.trim();
    if (!title) throw new CoreError('INVALID_ARGUMENT', 'An event needs a title.');
    const writable = this.d.db.all<AccountRow>("SELECT * FROM calendar_accounts WHERE kind = 'microsoft' AND can_write = 1 AND enabled = 1 ORDER BY created_at");
    const r = p.accountId ? writable.find((a) => a.id === p.accountId) : writable[0];
    if (!r) throw new CoreError('UNAVAILABLE', p.accountId ? 'That calendar cannot take new events (it is a link, or read-only).' : 'No connected calendar can take new events. Sign in to Outlook / Microsoft 365 with write access first.');
    const cals = JSON.parse(r.calendars) as CalendarSource[];
    const cal = p.calendarId ? cals.find((c) => c.id === p.calendarId) : (cals.find((c) => c.isDefault && c.canWrite) ?? cals.find((c) => c.canWrite));
    if (!cal?.canWrite) throw new CoreError('UNAVAILABLE', 'That calendar cannot take new events.');
    this.requireReady();

    const start = parseWhen(p.start);
    const allDay = p.allDay ?? start.dateOnly;
    let body: Record<string, unknown>;
    if (allDay) {
      const first = new Date(start.date.getFullYear(), start.date.getMonth(), start.date.getDate());
      const endDay = p.end ? parseWhen(p.end).date : new Date(first.getFullYear(), first.getMonth(), first.getDate() + 1);
      const last = endDay <= first ? new Date(first.getFullYear(), first.getMonth(), first.getDate() + 1) : new Date(endDay.getFullYear(), endDay.getMonth(), endDay.getDate());
      const zone = localZone();
      body = { subject: title, isAllDay: true, start: { dateTime: `${ymd(first)}T00:00:00`, timeZone: zone }, end: { dateTime: `${ymd(last)}T00:00:00`, timeZone: zone } };
    } else {
      const end = p.end ? parseWhen(p.end).date : new Date(start.date.getTime() + (p.durationMinutes ?? 30) * 60_000);
      if (end <= start.date) throw new CoreError('INVALID_ARGUMENT', 'The event has to end after it starts.');
      const utc = (d: Date) => d.toISOString().slice(0, 19);
      body = { subject: title, start: { dateTime: utc(start.date), timeZone: 'UTC' }, end: { dateTime: utc(end), timeZone: 'UTC' } };
    }
    if (p.location?.trim()) body.location = { displayName: p.location.trim() };
    if (p.notes?.trim()) body.body = { contentType: 'text', content: p.notes.trim() };
    const made = await this.graph(r.id).createEvent(cal.id, body);
    this.insert(r.id, { ...made, calendarId: cal.id });
    this.changed('synced');
    const ev = this.events(new Date(made.start.getTime() - 1), new Date(made.end.getTime() + 1), r.id).find((e) => e.id === made.id);
    if (!ev) throw new CoreError('INTERNAL', 'The event was added but could not be shown.');
    return ev;
  }

  async delete(accountId: string, id: string): Promise<{ deleted: boolean }> {
    const r = this.row(accountId);
    const e = this.d.db.get<EventRow>('SELECT * FROM calendar_events WHERE account_id = ? AND id = ?', accountId, id);
    if (!e) throw new CoreError('NOT_FOUND', 'That event is not in the calendar any more.');
    const cal = (JSON.parse(r.calendars) as CalendarSource[]).find((c) => c.id === e.calendar_id);
    if (r.kind !== 'microsoft' || !r.can_write || !cal?.canWrite) throw new CoreError('FORBIDDEN', 'Events from this calendar can only be changed where it comes from.');
    this.requireReady();
    await this.graph(accountId).deleteEvent(id);
    this.d.db.run('DELETE FROM calendar_events WHERE account_id = ? AND id = ?', accountId, id);
    this.changed('synced');
    return { deleted: true };
  }

  // ------------------------------------------------------------------------------------------ reminders

  /** Meetings starting within the reminder time, once each. */
  remind(now = Date.now()): void {
    const minutes = this.d.settings().remindMinutes;
    if (!minutes) return;
    if (this.reminded.size > 2000) this.reminded.clear();
    for (const e of this.events(new Date(now), new Date(now + minutes * 60_000))) {
      const start = new Date(e.start).getTime();
      if (e.allDay || e.cancelled || e.showAs === 'free' || start < now) continue;
      const key = `${e.accountId}:${e.id}:${e.start}`;
      if (this.reminded.has(key)) continue;
      this.reminded.add(key);
      const inMin = Math.max(1, Math.round((start - now) / 60_000));
      const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      const bits = [`In ${inMin} minute${inMin === 1 ? '' : 's'} (${time(e.start)}–${time(e.end)})`, e.location, e.joinUrl ? 'Online meeting: join from Calendar' : null].filter(Boolean);
      this.d.notify(e.title, bits.join(' · '));
    }
  }
}
