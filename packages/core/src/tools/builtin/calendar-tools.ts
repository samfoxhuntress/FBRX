import type { CalendarEvent } from '@fbrx/shared';
import { CoreError } from '../../errors';
import { localZone, parseWhen, type CalendarService } from '../../calendar/calendar-service';
import type { ToolSpec } from '../types';

/**
 * The agent's view of the person's calendars (Calendar page): what is on, when they are free, and adding an event.
 * Adding goes through approvals like any other change; reading needs none. Sign-ins and links are never visible.
 */
export function calendarTools(cal: CalendarService): ToolSpec[] {
  const unavailable = () => (cal.accounts().some((a) => a.enabled) ? null : 'No calendar is connected. The person can connect Outlook / Microsoft 365 or a calendar link in Calendar.');
  const tool = (t: Omit<ToolSpec, 'source' | 'sourceId' | 'unavailable'>): ToolSpec => ({ source: 'builtin', sourceId: null, unavailable, ...t });
  const day = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const time = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const line = (e: CalendarEvent) =>
    `- ${e.allDay ? 'all day' : `${time(e.start)}–${time(e.end)}`} ${e.title}${e.cancelled ? ' (cancelled)' : ''}${e.showAs === 'tentative' ? ' (tentative)' : e.showAs === 'free' ? ' (free)' : e.showAs === 'oof' ? ' (away)' : ''}${e.location ? ` · ${e.location}` : ''}${e.organizer ? ` · organizer ${e.organizer}` : ''}${e.joinUrl ? ' · online meeting' : ''} [${e.accountName}]`;
  const startOf = (s?: string) => {
    if (!s) {
      const n = new Date();
      return new Date(n.getFullYear(), n.getMonth(), n.getDate());
    }
    return parseWhen(s).date;
  };

  return [
    tool({
      name: 'calendar.agenda',
      title: 'Calendar agenda',
      description:
        "What is on the person's calendars (Outlook / Microsoft 365 and calendar links): meetings and events day by day, with times, places, organizers and whether there is an online meeting. Use it for \"what's on today/tomorrow/this week\", \"when is my next meeting\" or to find an event by name.",
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'First day (YYYY-MM-DD) or a time (ISO). Default: today.' },
          days: { type: 'integer', minimum: 1, maximum: 62, description: 'How many days to show (default 1).' },
          query: { type: 'string', description: 'Only events whose title, place or organizer contains this.' },
        },
      },
      async run(i: { from?: string; days?: number; query?: string }) {
        const from = startOf(i.from);
        const days = Math.max(1, Math.min(62, Math.round(i.days ?? 1)));
        const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
        const q = i.query?.trim().toLowerCase();
        const list = cal.events(from, to).filter((e) => !q || [e.title, e.location, e.organizer].some((x) => x?.toLowerCase().includes(q)));
        const lines = [`Times are in ${localZone()}. ${list.length} event${list.length === 1 ? '' : 's'} from ${day(from)} for ${days} day${days === 1 ? '' : 's'}${q ? ` matching "${i.query}"` : ''}.`];
        for (let n = 0; n < days; n++) {
          const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + n);
          const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
          const items = list.filter((e) => new Date(e.start) < next && (new Date(e.end) > d || e.start === e.end));
          if (items.length) lines.push(`${day(d)}:`, ...items.map(line));
          else if (days <= 7 && !q) lines.push(`${day(d)}: nothing scheduled`);
        }
        const stale = cal.accounts().filter((a) => a.enabled && a.lastError);
        if (stale.length) lines.push(`Note: ${stale.map((a) => `${a.name} could not be updated (${a.lastError})`).join('; ')}`);
        return { output: lines.join('\n'), data: { events: list.slice(0, 200).map((e) => ({ title: e.title, start: e.start, end: e.end, allDay: e.allDay, location: e.location, calendar: e.accountName })) } };
      },
    }),
    tool({
      name: 'calendar.free_time',
      title: 'Find free time',
      description: 'Open stretches in the person’s calendars during working hours, for finding a time to meet or to focus. Events marked free and all-day events do not block time.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'First day (YYYY-MM-DD). Default: today (from now on).' },
          days: { type: 'integer', minimum: 1, maximum: 14, description: 'How many days (default 1).' },
          minMinutes: { type: 'integer', minimum: 5, maximum: 480, description: 'Shortest useful stretch (default 30).' },
          dayStart: { type: 'string', pattern: '^\\d{2}:\\d{2}$', description: 'Working day starts (default 09:00).' },
          dayEnd: { type: 'string', pattern: '^\\d{2}:\\d{2}$', description: 'Working day ends (default 17:00).' },
        },
      },
      async run(i: { from?: string; days?: number; minMinutes?: number; dayStart?: string; dayEnd?: string }) {
        const from = startOf(i.from);
        const days = Math.max(1, Math.min(14, Math.round(i.days ?? 1)));
        const slots = cal.freeSlots(from, days, i.minMinutes ?? 30, i.dayStart ?? '09:00', i.dayEnd ?? '17:00');
        const lines = [`Times are in ${localZone()}. Free stretches of at least ${i.minMinutes ?? 30} minutes between ${i.dayStart ?? '09:00'} and ${i.dayEnd ?? '17:00'}:`];
        if (!slots.length) lines.push('None.');
        for (const s of slots) lines.push(`- ${day(new Date(s.start))} ${time(s.start)}–${time(s.end)} (${s.minutes} min)`);
        return { output: lines.join('\n'), data: { slots } };
      },
    }),
    tool({
      name: 'calendar.create_event',
      title: 'Add a calendar event',
      description:
        "Adds an event to the person's Outlook / Microsoft 365 calendar (calendar links are read-only). Give a start time (or a date for an all-day event) and either an end or a duration. It does not invite anyone. Check calendar.free_time first when the person asks for a free slot.",
      risk: 'write',
      inputSchema: {
        type: 'object',
        required: ['title', 'start'],
        properties: {
          title: { type: 'string', maxLength: 255 },
          start: { type: 'string', description: 'Local time like 2026-10-06T14:30, or a date (YYYY-MM-DD) for an all-day event.' },
          end: { type: 'string', description: 'End time (or the last day for a multi-day all-day event).' },
          durationMinutes: { type: 'integer', minimum: 5, maximum: 1440, description: 'Used when there is no end (default 30).' },
          allDay: { type: 'boolean' },
          location: { type: 'string', maxLength: 255 },
          notes: { type: 'string', maxLength: 4000 },
          account: { type: 'string', description: 'Account id or name (default: the first that can take events).' },
        },
      },
      async run(i: { title: string; start: string; end?: string; durationMinutes?: number; allDay?: boolean; location?: string; notes?: string; account?: string }) {
        let accountId: string | undefined;
        if (i.account) {
          const a = cal.accounts().find((x) => x.id === i.account || x.name.toLowerCase() === i.account!.toLowerCase() || x.address?.toLowerCase() === i.account!.toLowerCase());
          if (!a) throw new CoreError('NOT_FOUND', `No calendar "${i.account}". Connected: ${cal.accounts().map((x) => x.name).join(', ')}`);
          accountId = a.id;
        }
        const e = await cal.create({ accountId, title: i.title, start: i.start, end: i.end, durationMinutes: i.durationMinutes, allDay: i.allDay, location: i.location, notes: i.notes });
        return { output: `Added "${e.title}" to ${e.accountName} (${e.calendarName}): ${day(new Date(e.start))} ${e.allDay ? 'all day' : `${time(e.start)}–${time(e.end)}`}.`, data: { event: e } };
      },
    }),
  ];
}
