import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CalendarChange, CalendarEvent, CalendarStatus, NotificationEvent } from '@fbrx/shared';
import { parseIcs, zonedToUtc } from '../src/calendar/ics';
import { normalizeCalendarLink } from '../src/calendar/calendar-service';
import { makeKernel, tempDir, USER, waitFor } from './helpers';

const LOCAL_API = { origin: 'api' as const, actor: 'script' };

const OUTLOOK_FEED = `BEGIN:VCALENDAR
METHOD:PUBLISH
PRODID:Microsoft Exchange Server 2010
VERSION:2.0
X-WR-CALNAME:Calendar
BEGIN:VTIMEZONE
TZID:Pacific Standard Time
BEGIN:STANDARD
DTSTART:16010101T020000
TZOFFSETFROM:-0700
TZOFFSETTO:-0800
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010101T020000
TZOFFSETFROM:-0800
TZOFFSETTO:-0700
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
RRULE:FREQ=WEEKLY;UNTIL=20261231T170000Z;INTERVAL=1;BYDAY=MO,WE;WKST=SU
EXDATE;TZID=Pacific Standard Time:20261012T093000
UID:standup-1
SUMMARY:Team standup
DTSTART;TZID=Pacific Standard Time:20260928T093000
DTEND;TZID=Pacific Standard Time:20260928T094500
LOCATION:Room 4
X-MICROSOFT-SKYPETEAMSMEETINGURL:https://teams.microsoft.com/l/meetup-join/abc
END:VEVENT
BEGIN:VEVENT
UID:standup-1
RECURRENCE-ID;TZID=Pacific Standard Time:20261014T093000
SUMMARY:Team standup (moved)
DTSTART;TZID=Pacific Standard Time:20261014T110000
DTEND;TZID=Pacific Standard Time:20261014T111500
END:VEVENT
BEGIN:VEVENT
UID:holiday
SUMMARY:School holiday
DTSTART;VALUE=DATE:20261009
DTEND;VALUE=DATE:20261010
TRANSP:TRANSPARENT
END:VEVENT
END:VCALENDAR`;

const OTHER_FEED = `BEGIN:VCALENDAR
VERSION:2.0
X-WR-CALNAME:Family
BEGIN:VEVENT
UID:ny
SUMMARY:Call with Grandma
DTSTART;TZID=America/New_York:20261006T090000
DTEND;TZID=America/New_York:20261006T100000
DESCRIPTION:Join here: https://meet.google.com/abc-defg-hij\\nSee you
ORGANIZER;CN=Ana Rivera:mailto:ana@example.com
END:VEVENT
BEGIN:VEVENT
UID:cancelled
SUMMARY:Piano lesson
DTSTART:20261006T200000Z
DTEND:20261006T210000Z
STATUS:CANCELLED
END:VEVENT
END:VCALENDAR`;

describe('calendar links (iCalendar)', () => {
  it('expands repeats with skipped and moved dates in the feed’s own time zone', () => {
    const { name, events } = parseIcs(OUTLOOK_FEED, new Date('2026-10-01T00:00:00Z'), new Date('2026-10-20T00:00:00Z'));
    expect(name).toBe('Calendar');
    const standups = events.filter((e) => e.title.startsWith('Team standup'));
    // 9:30 Pacific (daylight time) is 16:30 UTC; Oct 12 is skipped and Oct 14 moved to 11:00.
    expect(standups.map((e) => [e.title, e.start.toISOString()])).toEqual([
      ['Team standup', '2026-10-05T16:30:00.000Z'],
      ['Team standup', '2026-10-07T16:30:00.000Z'],
      ['Team standup (moved)', '2026-10-14T18:00:00.000Z'],
      ['Team standup', '2026-10-19T16:30:00.000Z'],
    ]);
    expect(standups[0]).toMatchObject({ location: 'Room 4', joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc', showAs: 'busy', allDay: false });
    expect(new Set(standups.map((e) => e.id)).size).toBe(4);
    const holiday = events.find((e) => e.title === 'School holiday')!;
    expect(holiday).toMatchObject({ allDay: true, showAs: 'free' });
    expect([holiday.start.getFullYear(), holiday.start.getMonth(), holiday.start.getDate(), holiday.start.getHours()]).toEqual([2026, 9, 9, 0]);
  });

  it('uses the computer’s zone data for zones a feed names but does not define, and finds meeting links', () => {
    const { events } = parseIcs(OTHER_FEED, new Date('2026-10-05T00:00:00Z'), new Date('2026-10-08T00:00:00Z'));
    expect(events[0]).toMatchObject({ title: 'Call with Grandma', organizer: 'Ana Rivera', joinUrl: 'https://meet.google.com/abc-defg-hij' });
    expect(events[0].start.toISOString()).toBe('2026-10-06T13:00:00.000Z');
    expect(events[1]).toMatchObject({ title: 'Piano lesson', cancelled: true });
    expect(zonedToUtc(2026, 1, 15, 9, 0, 0, 'Europe/Berlin').toISOString()).toBe('2026-01-15T08:00:00.000Z');
    expect(() => parseIcs('<html>not a calendar</html>', new Date(), new Date())).toThrow(/not a calendar/);
    expect(normalizeCalendarLink('webcal://calendar.example.com/feed.ics').toString()).toBe('https://calendar.example.com/feed.ics');
    expect(() => normalizeCalendarLink('file:///etc/passwd')).toThrow(/https/);
  });
});

/** A feed with events relative to now, served from this computer. */
function liveFeed(): string {
  const t = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const soon = new Date(Date.now() + 5 * 60_000);
  const later = new Date(Date.now() + 3 * 3600_000);
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'X-WR-CALNAME:Rivera family',
    'BEGIN:VEVENT',
    'UID:soon',
    'SUMMARY:Dentist',
    `DTSTART:${t(soon)}`,
    `DTEND:${t(new Date(soon.getTime() + 30 * 60_000))}`,
    'LOCATION:Main St clinic',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:later',
    'SUMMARY:Soccer practice',
    `DTSTART:${t(later)}`,
    `DTEND:${t(new Date(later.getTime() + 3600_000))}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

describe('Calendar on a computer', () => {
  let feedServer: Server;
  let feedUrl: string;
  let feedStatus = 200;

  beforeAll(async () => {
    feedServer = createServer((req, res) => {
      if (feedStatus !== 200) return void res.writeHead(feedStatus).end();
      res.writeHead(200, { 'content-type': 'text/calendar' }).end(liveFeed());
    });
    await new Promise<void>((r) => feedServer.listen(0, '127.0.0.1', () => r()));
    feedUrl = `http://127.0.0.1:${(feedServer.address() as AddressInfo).port}/family.ics`;
  });
  afterAll(() => feedServer.close());

  it('adds a calendar link, shows its events, answers the agent and reminds before a meeting', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      expect(kernel.registry.get('calendar.agenda')!.unavailable!()).toMatch(/No calendar is connected/);
      await expect(kernel.call('calendar.addLink', { name: '', url: feedUrl }, LOCAL_API)).rejects.toThrow();
      await expect(kernel.call('calendar.addLink', { name: 'x', url: 'not a link' }, USER)).rejects.toThrow(/not a web address/);

      const account = (await kernel.call('calendar.addLink', { name: '', url: feedUrl }, USER)) as CalendarStatus['accounts'][number];
      expect(account).toMatchObject({ kind: 'ics', name: 'Rivera family', address: '127.0.0.1', canWrite: false, events: 2, lastError: null });
      // The link (a credential) is kept in the vault, never in the account.
      expect(JSON.stringify(await kernel.call('calendar.status', undefined, USER))).not.toContain('family.ics');

      const now = new Date();
      const events = (await kernel.call('calendar.events', { from: now.toISOString(), to: new Date(now.getTime() + 86400_000).toISOString() }, USER)) as CalendarEvent[];
      expect(events.map((e) => e.title)).toEqual(['Dentist', 'Soccer practice']);
      expect(events[0]).toMatchObject({ location: 'Main St clinic', accountName: 'Rivera family', canDelete: false });

      const agenda = await kernel.registry.get('calendar.agenda')!.run({ days: 2 }, {} as any);
      expect(agenda.output).toMatch(/Dentist · Main St clinic \[Rivera family\]/);
      const free = await kernel.registry.get('calendar.free_time')!.run({ dayStart: '00:00', dayEnd: '23:59', minMinutes: 5 }, {} as any);
      expect(free.output).toMatch(/Free stretches/);
      expect(kernel.registry.get('calendar.create_event')!.risk).toBe('write');
      await expect(kernel.registry.get('calendar.create_event')!.run({ title: 'Lunch', start: '2026-10-07T12:00' }, {} as any)).rejects.toThrow(/No connected calendar can take new events/);

      // A reminder once, ten minutes before (the default).
      const notes: NotificationEvent[] = [];
      kernel.events.on('notification', (n) => notes.push(n));
      kernel.calendar.remind();
      kernel.calendar.remind();
      expect(notes.map((n) => n.title)).toEqual(['Dentist']);
      expect(notes[0].body).toMatch(/^In [45] minutes \(.*\) · Main St clinic$/);

      // A link that stops working keeps the events it had and says why.
      feedStatus = 404;
      await kernel.call('calendar.sync', { id: account.id }, USER);
      const st = (await kernel.call('calendar.status', undefined, USER)) as CalendarStatus;
      expect(st.accounts[0]).toMatchObject({ events: 2, lastError: expect.stringMatching(/no longer works/) });
      feedStatus = 200;

      // Turned off: hidden; removed: gone, with its secret.
      await kernel.call('calendar.update', { id: account.id, enabled: false }, USER);
      expect(kernel.calendar.events(now, new Date(now.getTime() + 86400_000))).toEqual([]);
      await kernel.call('calendar.remove', { id: account.id }, USER);
      expect(kernel.vault.has(`fbrx.calendar.${account.id}`)).toBe(false);
      expect(((await kernel.call('calendar.status', undefined, USER)) as CalendarStatus).accounts).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('lets plugins read events only with the calendar permission, without meeting links', async () => {
    const { kernel, cleanup } = await makeKernel();
    const plugin = (id: string, permissions: string[]) => {
      const dir = tempDir('fbrx-plugin-');
      writeFileSync(join(dir, 'fbrx-plugin.json'), JSON.stringify({ id: `com.test.${id}`, name: id, version: '0.1.0', namespace: id, main: 'index.mjs', permissions }));
      writeFileSync(
        join(dir, 'index.mjs'),
        `export default { tools: [{ name: 'today', title: 'today', description: 'd', risk: 'read', inputSchema: { type: 'object', properties: {} },
  async run(_i, ctx) { const now = Date.now(); return JSON.stringify(await ctx.calendar.events(new Date(now), new Date(now + 86400000))); } }] };`,
      );
      return dir;
    };
    try {
      await kernel.call('calendar.addLink', { name: 'Family', url: feedUrl }, USER);
      await kernel.call('plugins.install', { path: plugin('planner', ['calendar']) }, USER);
      await kernel.call('plugins.install', { path: plugin('nosy', []) }, USER);
      const ok = await kernel.gate.invoke('planner.today', {}, USER);
      expect(ok.status).toBe('succeeded');
      const seen = JSON.parse(ok.output);
      expect(seen.map((e: { title: string }) => e.title)).toEqual(['Dentist', 'Soccer practice']);
      expect(Object.keys(seen[0]).sort()).toEqual(['allDay', 'calendar', 'cancelled', 'end', 'location', 'showAs', 'start', 'title']);
      const denied = await kernel.gate.invoke('nosy.today', {}, USER);
      expect(denied.status).toBe('failed');
      expect(denied.output).toMatch(/lacks the "calendar" permission/);
    } finally {
      await cleanup();
    }
  });
});

/** A stand-in for Microsoft sign-in and Microsoft Graph. */
function fakeMicrosoft() {
  const state = {
    challenge: '',
    codes: new Map<string, { challenge: string; redirect: string }>(),
    refreshTokens: new Set<string>(),
    issued: 0,
    refreshes: 0,
    revoked: false,
    events: [] as any[],
    posted: [] as any[],
  };
  const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  const body = (req: IncomingMessage) => new Promise<string>((r) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => r(b));
  });
  const token = () => {
    state.issued++;
    const refresh = `refresh-${state.issued}`;
    state.refreshTokens.add(refresh);
    return { access_token: `access-${state.issued}`, refresh_token: refresh, expires_in: 1, scope: 'openid profile offline_access User.Read Calendars.ReadWrite' };
  };
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString().replace('Z', '0000');
  state.events = [
    { id: 'evt-1', subject: 'Budget review', start: { dateTime: iso(now + 2 * 3600_000), timeZone: 'UTC' }, end: { dateTime: iso(now + 3 * 3600_000), timeZone: 'UTC' }, isAllDay: false, location: { displayName: 'Harbor Lane Design, room 2' }, organizer: { emailAddress: { name: 'Sam Lee', address: 'sam@harborlane.example' } }, isOnlineMeeting: true, onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/xyz' }, showAs: 'busy', isCancelled: false, webLink: 'https://outlook.office.com/calendar/item/evt-1' },
    { id: 'evt-2', subject: 'Out of office', start: { dateTime: iso(now + 86400_000).slice(0, 10) + 'T00:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: iso(now + 2 * 86400_000).slice(0, 10) + 'T00:00:00.0000000', timeZone: 'UTC' }, isAllDay: true, showAs: 'oof', isCancelled: false },
  ];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    const auth = req.headers.authorization ?? '';
    if (url.pathname === '/common/oauth2/v2.0/authorize') {
      const q = url.searchParams;
      if (q.get('client_id') !== 'test-client' || q.get('code_challenge_method') !== 'S256' || !/Calendars\.ReadWrite/.test(q.get('scope')!)) return void json(res, 400, { error: 'invalid_request' });
      const code = `code-${state.codes.size + 1}`;
      state.codes.set(code, { challenge: q.get('code_challenge')!, redirect: q.get('redirect_uri')! });
      return void res.writeHead(302, { location: `${q.get('redirect_uri')}/?code=${code}&state=${q.get('state')}` }).end();
    }
    if (url.pathname === '/common/oauth2/v2.0/token') {
      const f = new URLSearchParams(await body(req));
      if (f.get('grant_type') === 'authorization_code') {
        const c = state.codes.get(f.get('code')!);
        const proof = createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url');
        if (!c || proof !== c.challenge || f.get('redirect_uri') !== c.redirect) return void json(res, 400, { error: 'invalid_grant', error_description: 'AADSTS70000: bad code\r\nTrace ID: 1' });
        state.codes.delete(f.get('code')!);
        return void json(res, 200, token());
      }
      if (f.get('grant_type') === 'refresh_token') {
        if (state.revoked || !state.refreshTokens.has(f.get('refresh_token')!)) return void json(res, 400, { error: 'invalid_grant', error_description: 'AADSTS50173: The provided grant has expired.\r\nTrace ID: 2' });
        state.refreshTokens.delete(f.get('refresh_token')!);
        state.refreshes++;
        return void json(res, 200, token());
      }
      return void json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (!/^Bearer access-\d+$/.test(auth)) return void json(res, 401, { error: { code: 'InvalidAuthenticationToken', message: 'Access token is empty.' } });
    if (url.pathname === '/v1.0/me') return void json(res, 200, { displayName: 'Jordan Rivera', mail: 'jordan@harborlane.example' });
    if (url.pathname === '/v1.0/me/calendars') return void json(res, 200, { value: [{ id: 'cal-main', name: 'Calendar', canEdit: true, isDefaultCalendar: true }, { id: 'cal-holidays', name: 'Holidays', canEdit: false, isDefaultCalendar: false }] });
    if (url.pathname === '/v1.0/me/calendars/cal-main/calendarView') {
      if (req.headers.prefer !== 'outlook.timezone="UTC"' || !url.searchParams.get('startDateTime')) return void json(res, 400, { error: { message: 'bad view' } });
      // Two pages, like Graph.
      if (!url.searchParams.get('page')) return void json(res, 200, { value: [state.events[0]], '@odata.nextLink': `http://${req.headers.host}/v1.0/me/calendars/cal-main/calendarView?page=2&startDateTime=x` });
      return void json(res, 200, { value: state.events.slice(1) });
    }
    if (url.pathname === '/v1.0/me/calendars/cal-holidays/calendarView') return void json(res, 200, { value: [] });
    if (url.pathname === '/v1.0/me/calendars/cal-main/events' && req.method === 'POST') {
      const e = JSON.parse(await body(req));
      state.posted.push(e);
      const made = { id: `evt-new-${state.posted.length}`, subject: e.subject, start: e.start, end: e.end, isAllDay: !!e.isAllDay, location: e.location, showAs: 'busy', isCancelled: false };
      state.events.push(made);
      return void json(res, 201, made);
    }
    if (url.pathname.startsWith('/v1.0/me/events/') && req.method === 'DELETE') {
      state.events = state.events.filter((e) => e.id !== decodeURIComponent(url.pathname.split('/').pop()!));
      return void res.writeHead(204).end();
    }
    json(res, 404, { error: { message: `no route ${url.pathname}` } });
  });
  return { server, state };
}

describe('Outlook / Microsoft 365', () => {
  const ms = fakeMicrosoft();
  const saved = { a: process.env.FBRX_MS_AUTHORITY, g: process.env.FBRX_MS_GRAPH };

  beforeAll(async () => {
    await new Promise<void>((r) => ms.server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(ms.server.address() as AddressInfo).port}`;
    process.env.FBRX_MS_AUTHORITY = base;
    process.env.FBRX_MS_GRAPH = `${base}/v1.0`;
  });
  afterAll(() => {
    ms.server.close();
    if (saved.a === undefined) delete process.env.FBRX_MS_AUTHORITY;
    else process.env.FBRX_MS_AUTHORITY = saved.a;
    if (saved.g === undefined) delete process.env.FBRX_MS_GRAPH;
    else process.env.FBRX_MS_GRAPH = saved.g;
  });

  it('signs in through the browser (PKCE), syncs every calendar, adds and deletes events, and asks to sign in again when access ends', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      // No app ID yet: says how to get one.
      expect(((await kernel.call('calendar.status', undefined, USER)) as CalendarStatus).microsoft.configured).toBe(false);
      await expect(kernel.call('calendar.signIn', undefined, USER)).rejects.toThrow(/Microsoft app \(client\) ID/);
      kernel.settings.update({ calendar: { microsoft: { clientId: 'test-client' } } });
      await expect(kernel.call('calendar.signIn', undefined, LOCAL_API)).rejects.toThrow();

      const changes: CalendarChange[] = [];
      kernel.events.on('calendar.changed', (c) => changes.push(c));
      const signIn = (await kernel.call('calendar.signIn', undefined, USER)) as { id: string; url: string };
      expect(signIn.url).toMatch(/\/common\/oauth2\/v2\.0\/authorize\?client_id=test-client&.*redirect_uri=http%3A%2F%2Flocalhost%3A\d+/);
      expect(((await kernel.call('calendar.status', undefined, USER)) as CalendarStatus).signIn?.id).toBe(signIn.id);
      // "The browser": Microsoft sends it back to FBRX on this computer.
      const page = await fetch(signIn.url);
      expect(await page.text()).toContain('Your calendar is connected');
      await waitFor(() => changes.some((c) => c.signIn?.ok));

      const st = (await kernel.call('calendar.status', undefined, USER)) as CalendarStatus;
      expect(st.signIn).toBeNull();
      expect(st.accounts).toHaveLength(1);
      const acct = st.accounts[0];
      expect(acct).toMatchObject({ kind: 'microsoft', name: 'Jordan Rivera', address: 'jordan@harborlane.example', canWrite: true, events: 2, lastError: null });
      expect(acct.calendars.map((c) => [c.name, c.canWrite, c.isDefault])).toEqual([['Calendar', true, true], ['Holidays', false, false]]);
      expect(kernel.vault.list().some((s) => s.name.includes('calendar'))).toBe(false);

      const now = new Date();
      const list = kernel.calendar.events(now, new Date(now.getTime() + 3 * 86400_000));
      list.sort((a, b) => a.title.localeCompare(b.title));
      expect(list.map((e) => [e.title, e.allDay, e.showAs])).toEqual([
        ['Budget review', false, 'busy'],
        ['Out of office', true, 'oof'],
      ]);
      expect(list[0]).toMatchObject({ joinUrl: 'https://teams.microsoft.com/l/meetup-join/xyz', organizer: 'Sam Lee', canDelete: true, calendarName: 'Calendar' });
      expect(new Date(list[1].start).getHours()).toBe(0);

      // The agent adds an event (a change, so it is a write tool); access tokens are refreshed and rotated as needed.
      const refreshesBefore = ms.state.refreshes;
      const made = await kernel.registry.get('calendar.create_event')!.run({ title: 'Focus time', start: '2026-10-07T13:00', durationMinutes: 90, location: 'Desk' }, {} as any);
      expect(made.output).toMatch(/Added "Focus time" to Jordan Rivera \(Calendar\)/);
      expect(ms.state.posted[0]).toMatchObject({ subject: 'Focus time', start: { timeZone: 'UTC', dateTime: new Date('2026-10-07T13:00').toISOString().slice(0, 19) }, location: { displayName: 'Desk' } });
      expect(new Date(`${ms.state.posted[0].end.dateTime}Z`).getTime() - new Date(`${ms.state.posted[0].start.dateTime}Z`).getTime()).toBe(90 * 60_000);
      expect(ms.state.refreshes).toBeGreaterThan(refreshesBefore);
      const allDay = (await kernel.call('calendar.create', { title: 'Offsite', start: '2026-10-09' }, USER)) as CalendarEvent;
      expect(allDay.allDay).toBe(true);
      expect(ms.state.posted[1]).toMatchObject({ isAllDay: true, start: { dateTime: '2026-10-09T00:00:00' }, end: { dateTime: '2026-10-10T00:00:00' } });
      await kernel.call('calendar.delete', { accountId: acct.id, id: allDay.id }, USER);
      expect(ms.state.events.some((e) => e.id === allDay.id)).toBe(false);

      // Turning a calendar off hides it at once.
      await kernel.call('calendar.update', { id: acct.id, calendars: [{ id: 'cal-main', enabled: false }] }, USER);
      expect(kernel.calendar.events(now, new Date(now.getTime() + 3 * 86400_000))).toEqual([]);
      await kernel.call('calendar.update', { id: acct.id, calendars: [{ id: 'cal-main', enabled: true }] }, USER);

      // Signing in again with the same address keeps one account.
      const again = (await kernel.call('calendar.signIn', undefined, USER)) as { url: string };
      await (await fetch(again.url)).text();
      await waitFor(() => changes.filter((c) => c.signIn?.ok).length === 2);
      expect(((await kernel.call('calendar.status', undefined, USER)) as CalendarStatus).accounts).toHaveLength(1);

      // Microsoft ends the sign-in: the account says so instead of failing quietly.
      ms.state.revoked = true;
      await kernel.call('calendar.sync', { id: acct.id }, USER);
      const after = ((await kernel.call('calendar.status', undefined, USER)) as CalendarStatus).accounts[0];
      expect(after.lastError).toMatch(/Sign in again/);
      expect(after.events).toBeGreaterThan(0);

      // A sign-in can be cancelled.
      const pending = (await kernel.call('calendar.signIn', undefined, USER)) as { id: string };
      await kernel.call('calendar.cancelSignIn', undefined, USER);
      expect(changes.at(-1)).toMatchObject({ reason: 'signin', signIn: { id: pending.id, ok: false, error: 'Sign-in was cancelled.' } });
    } finally {
      ms.state.revoked = false;
      await cleanup();
    }
  });
});
