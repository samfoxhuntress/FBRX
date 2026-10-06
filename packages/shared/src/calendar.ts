/**
 * Calendar: Outlook / Microsoft 365 accounts (Microsoft Graph, signed in through the browser) and calendar links
 * (an iCalendar address published by Outlook, Google, Apple or a school). Events are kept on the computer for the
 * Calendar page, FBRX Glass, meeting reminders and the agent.
 */

export const CALENDAR_KINDS = ['microsoft', 'ics'] as const;
export type CalendarKind = (typeof CALENDAR_KINDS)[number];

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

export interface CalendarEvent {
  accountId: string;
  calendarId: string;
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
  /** The account's color and name, for display. */
  color: string;
  accountName: string;
  calendarName: string;
  canDelete: boolean;
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
  /** Which account and calendar (default: the first account that can add events, its default calendar). */
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
}

/** A free stretch of time. */
export interface CalendarFreeSlot {
  start: string;
  end: string;
  minutes: number;
}
