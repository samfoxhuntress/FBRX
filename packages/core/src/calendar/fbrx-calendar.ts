import {
  CALENDAR_LINK_COLORS,
  FBRX_CALENDAR,
  newId,
  nextAutomationRun,
  type AutomationSchedule,
  type CalendarEvent,
  type CalendarEventPatch,
  type CalendarLink,
  type CalendarLinkKind,
  type CalendarRepeat,
  type CalendarShowAs,
  type FbrxCalendarId,
  type NewCalendarEvent,
} from '@fbrx/shared';
import { CoreError } from '../errors';
import type { Db } from '../storage/db';

/**
 * The FBRX calendar: events kept on this computer, added by hand (or by Fabrix, with approval), which may repeat and
 * may be about a project, a note, a task or an automation, and take its color. Beside them it shows what FBRX knows
 * of the days ahead: open tasks and active projects by their due date, and when the automations run.
 *
 * An event's color: one chosen for it, else its project's (the project itself, or the project its note or task is
 * in), else the color of what it is about (an automation, a note, a task) or of Fabrix when Fabrix added it, else the
 * calendar's.
 */

interface ItemRow {
  id: string;
  title: string;
  start: string;
  end: string;
  all_day: number;
  location: string | null;
  notes: string | null;
  color: string | null;
  link_kind: CalendarLinkKind | null;
  link_id: string | null;
  repeat: CalendarRepeat;
  repeat_until: string | null;
  show_as: CalendarShowAs;
  made_by: 'person' | 'fabrix';
  created_at: string;
  updated_at: string;
}

/** What FBRX knows from elsewhere: projects, tasks, notes and automations (the workspace and Automations). */
export interface FbrxCalendarSources {
  projects: () => Array<{ id: string; name: string; color: string; status: string; due: string | null }>;
  tasks: () => Array<{ id: string; title: string; details: string; status: string; due: string | null; projectId: string | null }>;
  note: (id: string) => { title: string; projectId: string | null } | null;
  task: (id: string) => { title: string; projectId: string | null } | null;
  automations: () => Array<{ id: string; name: string; enabled: boolean; schedule: AutomationSchedule; nextRunAt: string | null }>;
}

/** The calendar's own name and color, and which of its calendars are shown. */
export interface FbrxCalendarView {
  name: string;
  color: string;
  shown: (id: FbrxCalendarId) => boolean;
}

const DAY = 86_400_000;
/** An automation's run shows as a short block. */
const RUN_MINUTES = 15;
/** Enough occurrences for any window FBRX shows (400 days, every day). */
const MAX_OCCURRENCES = 500;
const CALENDAR_NAMES: Record<FbrxCalendarId, string> = { events: 'Events', tasks: 'Tasks due', projects: 'Project deadlines', automations: 'Automations' };

const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
/** Local midnight of a "YYYY-MM-DD" day (or of the day an ISO time falls on). */
const dayStart = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * The starts of a repeating event from its first, jumping close to `from` (whole periods that end before it are
 * skipped), in local time so a meeting stays at 9:00 across daylight-saving changes.
 */
function* starts(first: Date, repeat: CalendarRepeat, from: Date, length: number): Generator<Date> {
  if (repeat === 'none') {
    yield first;
    return;
  }
  if (repeat === 'daily' || repeat === 'weekly' || repeat === 'weekdays') {
    const step = repeat === 'weekly' ? 7 : 1;
    const behind = Math.floor((from.getTime() - length - first.getTime()) / DAY) - 7;
    let d = behind > 0 ? addDays(first, Math.floor(behind / 7) * 7) : new Date(first);
    for (;;) {
      if (repeat !== 'weekdays' || (d.getDay() !== 0 && d.getDay() !== 6)) yield d;
      d = addDays(d, step);
    }
  }
  for (let k = 0; ; k++) {
    const d = new Date(first);
    if (repeat === 'monthly') {
      // The same day of the month; a month without it (the 31st in April) is skipped.
      d.setDate(1);
      d.setMonth(first.getMonth() + k);
      if (new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() < first.getDate()) continue;
      d.setDate(first.getDate());
    } else {
      d.setFullYear(first.getFullYear() + k);
      if (d.getMonth() !== first.getMonth()) continue; // February 29th, in a year without one
    }
    yield d;
  }
}

export class FbrxCalendar {
  constructor(
    private readonly db: Db,
    private readonly src: FbrxCalendarSources,
  ) {}

  /** Events kept here. */
  count(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM calendar_items')?.n ?? 0;
  }

  // ---------------------------------------------------------------------------------------------- reading

  /** Everything the FBRX calendar shows in [from, to): your events (each occurrence), tasks, deadlines, runs. */
  events(from: Date, to: Date, view: FbrxCalendarView): CalendarEvent[] {
    const projects = new Map(this.src.projects().map((p) => [p.id, p]));
    const project = (id: string | null) => {
      const p = id ? projects.get(id) : undefined;
      return p ? { id: p.id, name: p.name, color: p.color } : null;
    };
    const base = (calendarId: FbrxCalendarId) => ({
      accountId: FBRX_CALENDAR,
      calendarId,
      accountName: view.name,
      calendarName: CALENDAR_NAMES[calendarId],
      location: null,
      organizer: null,
      joinUrl: null,
      webLink: null,
      cancelled: false,
      notes: null,
      repeat: 'none' as const,
      repeatUntil: null,
      seriesStart: null,
      ownColor: null,
      madeBy: null,
      canEdit: false,
      canDelete: false,
    });
    const out: CalendarEvent[] = [];

    if (view.shown('events')) {
      const automations = new Map(this.src.automations().map((a) => [a.id, a]));
      const rows = this.db.all<ItemRow>("SELECT * FROM calendar_items WHERE start < ? AND (repeat != 'none' OR end > ? OR start >= ?) ORDER BY start", to.toISOString(), from.toISOString(), from.toISOString());
      for (const r of rows) {
        const link = this.link(r.link_kind, r.link_id, { project, automation: (id) => automations.get(id) ?? null });
        const first = new Date(r.start);
        const length = new Date(r.end).getTime() - first.getTime();
        const until = r.repeat_until ? dayStart(r.repeat_until) : null;
        const last = until ? addDays(until, 1) : null;
        let n = 0;
        for (const s of starts(first, r.repeat, from, length)) {
          if (s >= to || (last && s >= last) || ++n > MAX_OCCURRENCES) break;
          const e = new Date(s.getTime() + length);
          if (e <= from && !(e.getTime() === s.getTime() && s >= from)) continue;
          out.push({
            ...base('events'),
            id: r.repeat === 'none' ? r.id : `${r.id}@${s.toISOString()}`,
            series: r.id,
            seriesStart: r.start,
            title: r.title,
            start: s.toISOString(),
            end: e.toISOString(),
            allDay: !!r.all_day,
            location: r.location,
            notes: r.notes,
            showAs: r.show_as,
            repeat: r.repeat,
            repeatUntil: r.repeat_until,
            link,
            ownColor: r.color,
            madeBy: r.made_by,
            color: r.color ?? link?.project?.color ?? (link && link.kind !== 'project' ? CALENDAR_LINK_COLORS[link.kind] : null) ?? (r.made_by === 'fabrix' ? CALENDAR_LINK_COLORS.fabrix : view.color),
            canEdit: true,
            canDelete: true,
          });
        }
      }
    }

    const allDay = (day: Date) => ({ start: day.toISOString(), end: addDays(day, 1).toISOString(), allDay: true, showAs: 'free' as const });
    const inRange = (day: Date | null): day is Date => !!day && day < to && addDays(day, 1) > from;
    if (view.shown('tasks')) {
      for (const t of this.src.tasks()) {
        const day = t.status !== 'done' && t.due ? dayStart(t.due) : null;
        if (!inRange(day)) continue;
        const p = project(t.projectId);
        out.push({ ...base('tasks'), ...allDay(day), id: `task:${t.id}`, series: null, title: t.title, notes: t.details || null, link: { kind: 'task', id: t.id, name: t.title, project: p }, color: p?.color ?? CALENDAR_LINK_COLORS.task });
      }
    }
    if (view.shown('projects')) {
      for (const p of projects.values()) {
        const day = p.status === 'active' && p.due ? dayStart(p.due) : null;
        if (!inRange(day)) continue;
        out.push({ ...base('projects'), ...allDay(day), id: `project:${p.id}`, series: null, title: `${p.name} is due`, link: { kind: 'project', id: p.id, name: p.name, project: project(p.id) }, color: p.color });
      }
    }
    if (view.shown('automations')) {
      for (const a of this.src.automations()) {
        if (!a.enabled) continue;
        const link: CalendarLink = { kind: 'automation', id: a.id, name: a.name, project: null };
        const runs: Date[] = [];
        if (a.schedule.kind === 'daily') {
          // Every run in the window (a daily schedule runs at most once a day).
          for (let at = nextAutomationRun(a.schedule, new Date(from.getTime() - 1), null); at && at < to && runs.length < 400; at = nextAutomationRun(a.schedule, at, null)) runs.push(at);
        } else if (a.schedule.kind === 'interval' && a.nextRunAt) {
          // Something that runs every few minutes or hours would fill the calendar: its next run only.
          const at = new Date(a.nextRunAt);
          if (at >= from && at < to) runs.push(at);
        }
        for (const at of runs) {
          out.push({ ...base('automations'), id: `automation:${a.id}@${at.toISOString()}`, series: null, title: a.name, start: at.toISOString(), end: new Date(at.getTime() + RUN_MINUTES * 60_000).toISOString(), allDay: false, showAs: 'free', link, color: CALENDAR_LINK_COLORS.automation });
        }
      }
    }
    return out;
  }

  /** What an event is about, with its project (null when it was deleted since). */
  private link(kind: CalendarLinkKind | null, id: string | null, o: { project: (id: string | null) => CalendarLink['project']; automation: (id: string) => { name: string } | null }): CalendarLink | null {
    if (!kind || !id) return null;
    if (kind === 'project') {
      const p = o.project(id);
      return p ? { kind, id, name: p.name, project: p } : null;
    }
    if (kind === 'automation') {
      const a = o.automation(id);
      return a ? { kind, id, name: a.name, project: null } : null;
    }
    const item = kind === 'note' ? this.src.note(id) : this.src.task(id);
    return item ? { kind, id, name: item.title, project: o.project(item.projectId) } : null;
  }

  // ---------------------------------------------------------------------------------------------- writing

  private row(id: string): ItemRow {
    // An occurrence of a repeating event stands for the whole event.
    const r = this.db.get<ItemRow>('SELECT * FROM calendar_items WHERE id = ?', id.split('@')[0]);
    if (!r) throw new CoreError('NOT_FOUND', 'That event is not in the FBRX calendar any more.');
    return r;
  }

  /** Start, end and all-day from what was asked (a day for all day; an end, a duration, or half an hour). */
  private when(p: { start: string; end?: string; durationMinutes?: number; allDay?: boolean }, parse: (s: string) => { date: Date; dateOnly: boolean }) {
    const start = parse(p.start);
    const allDay = p.allDay ?? start.dateOnly;
    if (allDay) {
      const first = new Date(start.date.getFullYear(), start.date.getMonth(), start.date.getDate());
      // The end of an all-day event is the last day it covers.
      const lastDay = p.end ? parse(p.end).date : first;
      const end = addDays(new Date(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate()), 1);
      return { start: first, end: end <= first ? addDays(first, 1) : end, allDay };
    }
    const end = p.end ? parse(p.end).date : new Date(start.date.getTime() + (p.durationMinutes ?? 30) * 60_000);
    if (end <= start.date) throw new CoreError('INVALID_ARGUMENT', 'The event has to end after it starts.');
    return { start: start.date, end, allDay };
  }

  private checkLink(link: NewCalendarEvent['link']) {
    if (!link) return;
    const known =
      link.kind === 'project'
        ? this.src.projects().some((p) => p.id === link.id)
        : link.kind === 'automation'
          ? this.src.automations().some((a) => a.id === link.id)
          : !!(link.kind === 'note' ? this.src.note(link.id) : this.src.task(link.id));
    if (!known) throw new CoreError('NOT_FOUND', `That ${link.kind} is not there any more.`);
  }

  private checkUntil(until: string | null | undefined, start: Date) {
    if (!until) return;
    const d = dayStart(until);
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new CoreError('INVALID_ARGUMENT', 'Repeat until a day (YYYY-MM-DD).');
    if (addDays(d, 1) <= start) throw new CoreError('INVALID_ARGUMENT', 'It has to repeat until a day after it starts.');
  }

  create(p: NewCalendarEvent, by: 'person' | 'fabrix', parse: (s: string) => { date: Date; dateOnly: boolean }): string {
    const title = p.title.trim();
    if (!title) throw new CoreError('INVALID_ARGUMENT', 'An event needs a title.');
    const w = this.when(p, parse);
    this.checkLink(p.link);
    this.checkUntil(p.repeatUntil, w.start);
    const id = newId('ev');
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO calendar_items (id, title, start, end, all_day, location, notes, color, link_kind, link_id, repeat, repeat_until, show_as, made_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      title.slice(0, 255),
      w.start.toISOString(),
      w.end.toISOString(),
      w.allDay ? 1 : 0,
      p.location?.trim() || null,
      p.notes?.trim() || null,
      p.color ?? null,
      p.link?.kind ?? null,
      p.link?.id ?? null,
      p.repeat ?? 'none',
      p.repeat && p.repeat !== 'none' ? (p.repeatUntil ?? null) : null,
      p.showAs ?? 'busy',
      by,
      now,
      now,
    );
    return id;
  }

  /** Changes an event (the whole series, when it repeats); returns its id. */
  update(p: CalendarEventPatch, parse: (s: string) => { date: Date; dateOnly: boolean }): string {
    const r = this.row(p.id);
    const title = p.title === undefined ? r.title : p.title.trim();
    if (!title) throw new CoreError('INVALID_ARGUMENT', 'An event needs a title.');
    // A new time comes whole: its start, and its end or length (else half an hour), all day or not.
    if (p.start === undefined && (p.end !== undefined || p.durationMinutes !== undefined || p.allDay !== undefined)) throw new CoreError('INVALID_ARGUMENT', 'To change when it is, give its start too.');
    const w = p.start === undefined ? { start: new Date(r.start), end: new Date(r.end), allDay: !!r.all_day } : this.when({ start: p.start, end: p.end, durationMinutes: p.durationMinutes, allDay: p.allDay }, parse);
    const link = p.link === undefined ? (r.link_kind && r.link_id ? { kind: r.link_kind, id: r.link_id } : null) : p.link;
    if (p.link) this.checkLink(p.link);
    const repeat = p.repeat ?? r.repeat;
    const until = repeat === 'none' ? null : p.repeatUntil === undefined ? r.repeat_until : p.repeatUntil;
    this.checkUntil(until, w.start);
    this.db.run(
      `UPDATE calendar_items SET title = ?, start = ?, end = ?, all_day = ?, location = ?, notes = ?, color = ?, link_kind = ?, link_id = ?, repeat = ?, repeat_until = ?, show_as = ?, updated_at = ?
       WHERE id = ?`,
      title.slice(0, 255),
      w.start.toISOString(),
      w.end.toISOString(),
      w.allDay ? 1 : 0,
      p.location === undefined ? r.location : p.location.trim() || null,
      p.notes === undefined ? r.notes : p.notes.trim() || null,
      p.color === undefined ? r.color : p.color,
      link?.kind ?? null,
      link?.id ?? null,
      repeat,
      until,
      p.showAs ?? r.show_as,
      new Date().toISOString(),
      r.id,
    );
    return r.id;
  }

  /** Deletes an event (every occurrence, when it repeats). */
  delete(id: string): void {
    this.db.run('DELETE FROM calendar_items WHERE id = ?', this.row(id).id);
  }
}
