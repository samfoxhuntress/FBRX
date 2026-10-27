/**
 * Calendar: the FBRX calendar, kept on the computer (events you add, plus your tasks' and projects' due dates and your
 * automations' runs), and shared calendars as add-ons: Outlook / Microsoft 365 accounts (Microsoft Graph, signed in
 * through the browser) and calendar links (an iCalendar address published by Outlook, Google, Apple or a school).
 * Events are kept on the computer for the Calendar page, Dash, meeting reminders and the agent.
 */

/** fbrx: the calendar on this computer (always there); microsoft and ics: shared calendars added to it. */
export const CALENDAR_KINDS = ['fbrx', 'microsoft', 'ics'] as const;
export type CalendarKind = (typeof CALENDAR_KINDS)[number];

/** The FBRX calendar's account id, and its calendars: your events, and what FBRX puts on it from elsewhere. */
export const FBRX_CALENDAR = 'fbrx';
export const FBRX_CALENDARS = ['events', 'tasks', 'projects', 'automations'] as const;
export type FbrxCalendarId = (typeof FBRX_CALENDARS)[number];

/** How an FBRX event repeats (until a day, or for good). */
export const CALENDAR_REPEATS = ['none', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly'] as const;
export type CalendarRepeat = (typeof CALENDAR_REPEATS)[number];

/** What an FBRX event can be connected to, and what it takes its color from. */
export const CALENDAR_LINKS = ['project', 'note', 'task', 'automation'] as const;
export type CalendarLinkKind = (typeof CALENDAR_LINKS)[number];

/**
 * Colors for what has none of its own: automations, notes and tasks outside a project, and what Fabrix added.
 * (Projects have their own color; everything else takes its calendar's.)
 */
export const CALENDAR_LINK_COLORS = { automation: '#8b5cf6', note: '#eab308', task: '#14b8a6', fabrix: '#f4b942' } as const;

/** How an event shows on the person's schedule (Outlook's "show as"). Only "free" leaves the time open. */
export const CALENDAR_SHOW_AS = ['free', 'tentative', 'busy', 'oof', 'workingElsewhere', 'unknown'] as const;
export type CalendarShowAs = (typeof CALENDAR_SHOW_AS)[number];

/** Colors offered for accounts, in order (the first unused one is picked for a new account). */
export const CALENDAR_COLORS = ['#3b82f6', '#f97316', '#10b981', '#a855f7', '#ef4444', '#eab308', '#14b8a6', '#ec4899'] as const;

/** One calendar inside an account (Microsoft accounts can have several; a link is one). */
export interface CalendarSource {
  id: string;
  name: string;
  enabled: boolean;
  canWrite: boolean;
  isDefault: boolean;
}

export interface CalendarAccount {
  id: string;
  kind: CalendarKind;
  name: string;
  /** The signed-in address (Microsoft) or the host the link points to. */
  address: string | null;
  color: string;
  enabled: boolean;
  calendars: CalendarSource[];
  /** New events can be added (a Microsoft account with write access). */
  canWrite: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  /** Events kept for this account (the last week and the next two months). */
  events: number;
  createdAt: string;
}

/** What an FBRX event is about: a project, a note, a task or an automation (and the project it belongs to). */
export interface CalendarLink {
  kind: CalendarLinkKind;
  id: string;
  name: string;
  /** The project it is in (the project itself, or the note's or task's), for its color. */
  project: { id: string; name: string; color: string } | null;
}

export interface CalendarEvent {
  accountId: string;
  calendarId: string;
  /** Unique within the account; for a repeating FBRX event, one per occurrence (`series` is the event's own id). */
  id: string;
  title: string;
  /** ISO time. All-day events start and end at local midnight. */
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  organizer: string | null;
  /** Link to join an online meeting. */
  joinUrl: string | null;
  /** Link to open the event in Outlook on the web. */
  webLink: string | null;
  showAs: CalendarShowAs;
  cancelled: boolean;
  /**
   * Its color: one chosen for the event, else its project's, else the color of what it is (an automation, a note,
   * something Fabrix added), else its calendar's.
   */
  color: string;
  accountName: string;
  calendarName: string;
  canDelete: boolean;
  /**
   * FBRX events: the event behind the occurrence (and when it first starts), its notes, how it repeats, what it is
   * about, who added it.
   */
  series: string | null;
  seriesStart: string | null;
  notes: string | null;
  repeat: CalendarRepeat;
  repeatUntil: string | null;
  link: CalendarLink | null;
  /** The color chosen for this event itself (null: it follows what it is about). */
  ownColor: string | null;
  madeBy: 'person' | 'fabrix' | null;
  canEdit: boolean;
}

export interface CalendarSignIn {
  id: string;
  /** Open this in the browser to sign in. */
  url: string;
  startedAt: string;
}

export interface CalendarStatus {
  accounts: CalendarAccount[];
  microsoft: {
    /** An app (client) ID is set or built in, so "Outlook / Microsoft 365" can sign in. */
    configured: boolean;
    /** Set by the organization (FBRX Command) and locked. */
    managed: boolean;
    /** This copy of FBRX has an app ID built in. */
    builtIn: boolean;
    tenant: string;
    readOnly: boolean;
  };
  remindMinutes: number;
  syncMinutes: number;
  /** A Microsoft sign-in waiting for the browser. */
  signIn: CalendarSignIn | null;
}

export interface CalendarChange {
  reason: 'accounts' | 'synced' | 'signin';
  /** How a Microsoft sign-in ended. */
  signIn?: { id: string; ok: boolean; error?: string; accountId?: string };
}

export interface NewCalendarEvent {
  /** Which account and calendar (default: the FBRX calendar). */
  accountId?: string;
  calendarId?: string;
  title: string;
  /** ISO time, or a date (YYYY-MM-DD) for an all-day event. */
  start: string;
  end?: string;
  durationMinutes?: number;
  allDay?: boolean;
  location?: string;
  notes?: string;
  /** FBRX calendar only: */
  repeat?: CalendarRepeat;
  /** The last day it repeats (YYYY-MM-DD), or none for good. */
  repeatUntil?: string | null;
  link?: { kind: CalendarLinkKind; id: string } | null;
  /** A color of its own, or null to follow what it is about. */
  color?: string | null;
  showAs?: CalendarShowAs;
}

/** A change to an FBRX event (its id, and what changes). */
export type CalendarEventPatch = Partial<Omit<NewCalendarEvent, 'accountId' | 'calendarId'>> & { id: string };

/** A free stretch of time. */
export interface CalendarFreeSlot {
  start: string;
  end: string;
  minutes: number;
}
