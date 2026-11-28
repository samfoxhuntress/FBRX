import { z } from 'zod';
import { ALERT_SEVERITIES } from './ext';

/**
 * FBRX Alert v1: the one format every FBRX product speaks when something needs a person (FBRX OS, FBRX Digger, FBRX
 * Server, Gate, MiniDome, FBRX Command). An alert says what happened, where, how bad, when it started (and, with its
 * all-clear, when it ended), what FBRX already did and what is left for the person, with a link to a report when
 * there is one. A problem keeps one key from its alert to its all-clear, so it is said once and then cleared; a thing
 * that just happened (a threat found, a crash) is an event and has no all-clear.
 */

export const FBRX_ALERT_VERSION = 1;
export const FBRX_ALERT_APPS = ['fbrx-os', 'fbrx-digger', 'fbrx-view', 'fbrx-server', 'fbrx-gate', 'fbrx-minidome', 'fbrx-command'] as const;
export type FbrxAlertApp = (typeof FBRX_ALERT_APPS)[number];
/** open: a problem that lasts until it is over; resolved: its all-clear; event: something that happened once. */
export const FBRX_ALERT_STATES = ['open', 'resolved', 'event'] as const;
export type FbrxAlertState = (typeof FBRX_ALERT_STATES)[number];

const when = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'a date and time (ISO 8601)');

export const FbrxAlertSchema = z.object({
  v: z.literal(FBRX_ALERT_VERSION),
  /** This message. */
  id: z.string().min(1).max(64),
  /** The problem: the same for its alert and its all-clear. */
  key: z.string().min(1).max(300),
  state: z.enum(FBRX_ALERT_STATES),
  severity: z.enum(ALERT_SEVERITIES),
  source: z.object({
    app: z.enum(FBRX_ALERT_APPS),
    /** The machine that sent it. */
    host: z.string().min(1).max(253),
    /** A server role (gate, dome, directory, time…) when it is about one. */
    role: z.string().max(64).optional(),
    /** The computer it is about, when that is not the sender (FBRX Command telling about a member's computer). */
    computer: z.string().max(253).optional(),
    organization: z.string().max(200).optional(),
  }),
  /** The check that raised it (disk_low, net_down…). */
  rule: z.string().min(1).max(64),
  /** What happened. */
  title: z.string().min(1).max(200),
  detail: z.string().max(2000).optional(),
  /** What FBRX already did about it. */
  done: z.string().max(1000).optional(),
  /** What is left for the person. */
  yours: z.string().max(1000).optional(),
  startedAt: when,
  endedAt: when.optional(),
  sentAt: when,
  /** The incident report, when there is one. */
  report: z.string().url().max(500).optional(),
});
export type FbrxAlert = z.infer<typeof FbrxAlertSchema>;

/** A problem's key: the app, the machine, the check and what it is about (a drive, a printer, a peer). */
export function fbrxAlertKey(app: FbrxAlertApp, host: string, rule: string, subject?: string | null): string {
  return [app, host, rule, subject]
    .filter((s): s is string => !!s)
    .map((s) => s.replace(/[\s|]+/g, '_'))
    .join('|')
    .slice(0, 300);
}

const minutes = (a: string, b: string) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60_000));

/** How long a problem lasted, in words. */
export function fbrxAlertDuration(a: Pick<FbrxAlert, 'startedAt' | 'endedAt'>): string | null {
  if (!a.endedAt) return null;
  const m = minutes(a.startedAt, a.endedAt);
  if (m < 1) return 'under a minute';
  if (m < 120) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} hours` : `${Math.round(h / 24)} days`;
}

const FBRX_ALERT_ROLES: Record<string, string> = { gate: 'FBRX Gate', minidome: 'MiniDome', time: 'FBRX Time', files: 'File server', directory: 'FBRX directory' };

/** A server role as people read it ("gate" → "FBRX Gate"); a role without a name is shown as it came. */
export function fbrxAlertRoleName(role: string): string {
  return FBRX_ALERT_ROLES[role] ?? role;
}

/** The alert as a subject line and plain text, for e-mail and chat. */
export function fbrxAlertText(a: FbrxAlert): { subject: string; text: string } {
  const tag = a.state === 'resolved' ? 'ALL CLEAR' : a.severity.toUpperCase();
  const where = [a.source.computer ?? a.source.host, a.source.role, a.source.organization].filter(Boolean).join(' · ');
  const lasted = fbrxAlertDuration(a);
  const lines = [
    a.state === 'resolved' ? `All clear: ${a.title}` : a.title,
    `Where: ${where}`,
    a.state === 'resolved' ? `Started ${a.startedAt}, ended ${a.endedAt}${lasted ? ` (${lasted})` : ''}` : `${a.state === 'event' ? 'At' : 'Since'} ${a.startedAt}`,
    ...(a.detail && a.state !== 'resolved' ? ['', a.detail] : []),
    ...(a.done ? ['', `What FBRX did: ${a.done}`] : []),
    ...(a.yours && a.state !== 'resolved' ? [`What is left for you: ${a.yours}`] : []),
    ...(a.report ? ['', `Report: ${a.report}`] : []),
    '',
    `— ${a.source.app} (FBRX Alert v${a.v}, key ${a.key})`,
  ];
  return { subject: `[FBRX ${tag}] ${a.title}`.slice(0, 250), text: lines.join('\n') };
}

const SYSLOG_SEVERITY: Record<FbrxAlert['severity'], number> = { critical: 2, warning: 4, info: 6 };
const printable = (s: string, max: number) => s.replace(/[^\x21-\x7e]/g, '_').slice(0, max) || '-';
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

/**
 * The alert as one RFC 5424 syslog message: the severity maps to crit, warning or informational (an all-clear is a
 * notice), the facility is local0 unless set, and the message carries key=value pairs a SIEM can split.
 */
export function fbrxAlertSyslog(a: FbrxAlert, o: { facility?: number } = {}): string {
  const facility = o.facility ?? 16;
  const pri = facility * 8 + (a.state === 'resolved' ? 5 : SYSLOG_SEVERITY[a.severity]);
  const quote = (s: string) => `"${oneLine(s).replace(/["\\]/g, '\\$&')}"`;
  const pairs = [
    `state=${a.state}`,
    `severity=${a.severity}`,
    `rule=${printable(a.rule, 64)}`,
    `key=${quote(a.key)}`,
    ...(a.source.role ? [`role=${printable(a.source.role, 64)}`] : []),
    ...(a.source.computer ? [`computer=${quote(a.source.computer)}`] : []),
    `started=${a.startedAt}`,
    ...(a.endedAt ? [`ended=${a.endedAt}`] : []),
    ...(a.report ? [`report=${quote(a.report)}`] : []),
  ].join(' ');
  const msg = `${a.state === 'resolved' ? 'All clear: ' : ''}${oneLine(a.title)}${a.detail && a.state !== 'resolved' ? ` - ${oneLine(a.detail)}` : ''} ${pairs}`;
  return `<${pri}>1 ${a.sentAt} ${printable(a.source.host, 255)} ${printable(a.source.app, 48)} - ${a.state.toUpperCase()} - ${msg}`;
}

// ------------------------------------------------------------------------------------------------- servers

/** Where an FBRX Server sends its alerts: each channel from a severity up; an all-clear goes where its alert went. */
export interface ServerAlertSettings {
  email: { enabled: boolean; min: FbrxAlert['severity']; host: string; port: number; secure: boolean; user: string; from: string; to: string; passwordSet: boolean };
  webhook: { enabled: boolean; min: FbrxAlert['severity']; url: string; secretSet: boolean };
  syslog: { enabled: boolean; min: FbrxAlert['severity']; host: string; port: number; protocol: 'udp' | 'tcp' | 'tls' };
}

export const SERVER_ALERT_CHANNELS = ['email', 'webhook', 'syslog'] as const;
export type ServerAlertChannel = (typeof SERVER_ALERT_CHANNELS)[number];

/** One of a server's alerts as its console shows it: the alert, and how each channel took it (and its all-clear). */
export interface ServerAlertRow {
  alert: FbrxAlert;
  deliveries: Partial<Record<ServerAlertChannel, string>>;
  cleared: Partial<Record<ServerAlertChannel, string>>;
}

export interface ServerAlertsList {
  /** Problems going on now. */
  open: ServerAlertRow[];
  /** The latest that are over, and things that happened once. */
  recent: ServerAlertRow[];
}

// ------------------------------------------------------------------------------------- organizations (FBRX Command)

/**
 * Who gets what in an organization (FBRX Command → Alerts): the alerts a rule takes (from a severity up, from these
 * apps, about computers with these tags), whom it tells first (e-mail, and FBRX OS on chosen computers), its quiet
 * hours (critical alerts come through), and whom it tells next when nobody acknowledges in time.
 */
export interface OrgAlertRule {
  id: string;
  name: string;
  enabled: boolean;
  min: FbrxAlert['severity'];
  /** Only alerts from these apps (none: every app). */
  apps: FbrxAlertApp[];
  /** Only alerts about computers with one of these tags (none: any computer, and the servers). */
  tags: string[];
  /** E-mail addresses that hear each alert first (and its all-clear). */
  emails: string[];
  /** FBRX OS on computers with one of these tags shows it, with Acknowledge. */
  computerTags: string[];
  /** And on the help desk computers (Devices → Receives help desk tickets). */
  helpdeskComputers: boolean;
  /** No e-mail or notification between these times (critical alerts come through; the console always shows them). */
  quiet: { enabled: boolean; from: string; to: string; timeZone: string };
  /** Nobody acknowledged it within this many minutes: the next people hear it too (0: never). */
  escalateAfterMinutes: number;
  escalateEmails: string[];
  escalateComputerTags: string[];
}

export const OrgAlertRuleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  min: z.enum(ALERT_SEVERITIES),
  apps: z.array(z.enum(FBRX_ALERT_APPS)).max(FBRX_ALERT_APPS.length),
  tags: z.array(z.string().trim().min(1).max(64)).max(20),
  emails: z.array(z.string().trim().email().max(200)).max(20),
  computerTags: z.array(z.string().trim().min(1).max(64)).max(20),
  helpdeskComputers: z.boolean(),
  quiet: z.object({ enabled: z.boolean(), from: z.string().regex(/^\d{2}:\d{2}$/), to: z.string().regex(/^\d{2}:\d{2}$/), timeZone: z.string().min(1).max(64) }),
  escalateAfterMinutes: z.number().int().min(0).max(7 * 24 * 60),
  escalateEmails: z.array(z.string().trim().email().max(200)).max(20),
  escalateComputerTags: z.array(z.string().trim().min(1).max(64)).max(20),
});

/** One of an organization's alerts as FBRX Command keeps it: the latest word on it, who heard it, who acknowledged it. */
export interface OrgAlertRow {
  id: string;
  alert: FbrxAlert;
  deviceId: string | null;
  deviceName: string | null;
  /** How many times it was said while it lasted (repeats are folded into one). */
  count: number;
  acknowledged: { by: string; at: string; note: string | null } | null;
  escalatedAt: string | null;
  /** Who heard it, in words ("e-mail it@example.com", "FBRX OS on RECEPTION-PC"), and what went wrong for any. */
  notified: string[];
}

export interface OrgAlertsList {
  open: OrgAlertRow[];
  recent: OrgAlertRow[];
}

/** Where FBRX Servers (and anything else that speaks FBRX Alert v1) send their alerts to FBRX Command. */
export interface OrgAlertInbound {
  url: string;
  secretSet: boolean;
}
