import ICAL from 'ical.js';
import type { CalendarShowAs } from '@fbrx/shared';

/**
 * Calendar links: an iCalendar (.ics) feed read into the occurrences that fall inside a window. Repeating events are
 * expanded (with their skipped and moved dates), times are turned into real instants using the feed's own time zone
 * definitions, and where a feed names a zone without defining it (common in Google and Apple feeds, and Outlook's
 * Windows zone names), the computer's time zone data fills in.
 */

export interface IcsOccurrence {
  id: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location: string | null;
  organizer: string | null;
  joinUrl: string | null;
  webLink: string | null;
  showAs: CalendarShowAs;
  cancelled: boolean;
}

/** Outlook writes Windows time zone names; these are the ones most calendars use. */
const WINDOWS_ZONES: Record<string, string> = {
  'Pacific Standard Time': 'America/Los_Angeles',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Central Standard Time': 'America/Chicago',
  'Eastern Standard Time': 'America/New_York',
  'US Eastern Standard Time': 'America/Indianapolis',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Atlantic Standard Time': 'America/Halifax',
  'Newfoundland Standard Time': 'America/St_Johns',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'SA Pacific Standard Time': 'America/Bogota',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Russian Standard Time': 'Europe/Moscow',
  'Israel Standard Time': 'Asia/Jerusalem',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Arabian Standard Time': 'Asia/Dubai',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Singapore Standard Time': 'Asia/Singapore',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'W. Australia Standard Time': 'Australia/Perth',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'UTC': 'UTC',
  'Coordinated Universal Time': 'UTC',
};

const MEETING_LINK = /https:\/\/(?:teams\.microsoft\.com|teams\.live\.com|[\w.-]*zoom\.us|meet\.google\.com|[\w.-]*webex\.com|whereby\.com|meet\.jit\.si)\/[^\s"<>\\]+/i;

/** The first online-meeting link in a piece of text, if any. */
export function findJoinUrl(...texts: Array<string | null | undefined>): string | null {
  for (const t of texts) {
    const m = t ? MEETING_LINK.exec(t) : null;
    if (m) return m[0].replace(/[.,;)>]+$/, '');
  }
  return null;
}

function validZone(tz: string): string | null {
  const name = WINDOWS_ZONES[tz] ?? tz;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return name;
  } catch {
    return null;
  }
}

/** A wall-clock time in a named zone as an instant. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): Date {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const offset = (ms: number) => {
    const parts = fmt.formatToParts(new Date(ms));
    const g = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? 0);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - ms;
  };
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = wall - offset(wall);
  t = wall - offset(t);
  return new Date(t);
}

function instant(t: ICAL.Time): Date {
  if (t.isDate) return new Date(t.year, t.month - 1, t.day);
  // A zone the feed names but does not define: ical.js keeps the name and treats the time as floating.
  const named = (t as ICAL.Time & { timezone?: string }).timezone;
  if (t.zone?.tzid === 'floating' && named) {
    const tz = validZone(named);
    if (tz) return zonedToUtc(t.year, t.month, t.day, t.hour, t.minute, t.second, tz);
  }
  return t.toJSDate();
}

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function showAs(v: ICAL.Component): CalendarShowAs {
  const busy = String(v.getFirstPropertyValue('x-microsoft-cdo-busystatus') ?? '').toUpperCase();
  if (busy === 'FREE') return 'free';
  if (busy === 'TENTATIVE') return 'tentative';
  if (busy === 'OOF') return 'oof';
  if (busy === 'WORKINGELSEWHERE') return 'workingElsewhere';
  if (busy === 'BUSY') return 'busy';
  if (String(v.getFirstPropertyValue('transp') ?? '').toUpperCase() === 'TRANSPARENT') return 'free';
  if (String(v.getFirstPropertyValue('status') ?? '').toUpperCase() === 'TENTATIVE') return 'tentative';
  return 'busy';
}

function details(v: ICAL.Component, e: ICAL.Event) {
  const description = text(v.getFirstPropertyValue('description'));
  const location = text(e.location);
  const organizerProp = v.getFirstProperty('organizer');
  const organizer = organizerProp ? text(organizerProp.getParameter('cn')) ?? text(String(organizerProp.getFirstValue() ?? '').replace(/^mailto:/i, '')) : null;
  const url = text(v.getFirstPropertyValue('url'));
  return {
    title: text(e.summary) ?? '(No title)',
    location,
    organizer,
    joinUrl: findJoinUrl(text(v.getFirstPropertyValue('x-microsoft-skypeteamsmeetingurl')), location, description, url),
    webLink: url && /^https?:\/\//i.test(url) && !findJoinUrl(url) ? url : null,
    showAs: showAs(v),
    cancelled: String(v.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED',
  };
}

/** Reads a feed and returns the occurrences that overlap [from, to), sorted by start. */
export function parseIcs(feed: string, from: Date, to: Date, maxPerEvent = 5000): { name: string | null; events: IcsOccurrence[] } {
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(ICAL.parse(feed));
  } catch (err) {
    throw new Error(`This is not a calendar (iCalendar) file: ${err instanceof Error ? err.message : String(err)}`);
  }
  const cal = root.name === 'vcalendar' ? root : root.getFirstSubcomponent('vcalendar');
  if (!cal) throw new Error('This is not a calendar (iCalendar) file.');
  for (const tz of cal.getAllSubcomponents('vtimezone')) {
    try {
      ICAL.TimezoneService.register(tz);
    } catch {
      /* a broken zone definition: its events fall back to the zone name */
    }
  }
  const masters = new Map<string, { e: ICAL.Event; v: ICAL.Component }>();
  const exceptions: Array<{ e: ICAL.Event; v: ICAL.Component }> = [];
  for (const v of cal.getAllSubcomponents('vevent')) {
    const e = new ICAL.Event(v);
    if (!e.startDate) continue;
    if (e.isRecurrenceException()) exceptions.push({ e, v });
    else masters.set(e.uid || `noid-${masters.size}`, { e, v });
  }
  const orphans: Array<{ e: ICAL.Event; v: ICAL.Component }> = [];
  for (const x of exceptions) {
    const m = masters.get(x.e.uid);
    if (m) m.e.relateException(x.e);
    else orphans.push(x);
  }

  const out: IcsOccurrence[] = [];
  const add = (uid: string, start: Date, end: Date, allDay: boolean, v: ICAL.Component, e: ICAL.Event, occurrence: boolean) => {
    if (end <= start) end = new Date(start.getTime() + (allDay ? 86_400_000 : 0));
    if (start >= to || (end <= from && start < from)) return;
    out.push({ id: occurrence ? `${uid}@${start.toISOString()}` : uid, start, end, allDay, ...details(v, e) });
  };
  const endOf = (start: ICAL.Time, end: ICAL.Time | null, duration: ICAL.Duration | null): ICAL.Time => {
    if (end) return end;
    const t = start.clone();
    if (duration) t.addDuration(duration);
    else if (start.isDate) t.day += 1;
    return t;
  };

  for (const [uid, { e, v }] of masters) {
    if (!e.isRecurring()) {
      const s = e.startDate;
      add(uid, instant(s), instant(endOf(s, e.endDate, e.duration)), s.isDate, v, e, false);
      continue;
    }
    const it = e.iterator();
    for (let n = 0; n < maxPerEvent; n++) {
      const next = it.next();
      if (!next) break;
      const d = e.getOccurrenceDetails(next);
      const start = instant(d.startDate);
      if (start >= to) break;
      const end = instant(d.endDate ?? endOf(d.startDate, null, e.duration));
      const item = d.item;
      add(uid, start, end, d.startDate.isDate, item.component, item, true);
    }
  }
  for (const { e, v } of orphans) {
    const s = e.startDate;
    add(`${e.uid}@${instant(e.recurrenceId ?? s).toISOString()}`, instant(s), instant(endOf(s, e.endDate, e.duration)), s.isDate, v, e, false);
  }
  out.sort((a, b) => a.start.getTime() - b.start.getTime() || a.title.localeCompare(b.title));
  return { name: text(cal.getFirstPropertyValue('x-wr-calname')), events: out };
}
