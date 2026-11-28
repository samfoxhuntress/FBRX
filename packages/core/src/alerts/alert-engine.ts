import { hostname } from 'node:os';
import si from 'systeminformation';
import nodemailer from 'nodemailer';
import { fbrxAlertDuration, fbrxAlertKey, fbrxAlertRoleName, fbrxAlertText, newId, type AlertChannel, type AlertItem, type AlertRuleInfo, type AlertSeverity, type FbrxAlert, type FbrxAlertApp, type FbrxAlertState, type Settings } from '@fbrx/shared';
import { postFbrxAlert, sendFbrxAlertSyslog } from '@fbrx/shared/node';
import { CoreError, errorMessage } from '../errors';
import type { EventBus } from '../events';
import type { Logger } from '../logger';
import type { Db } from '../storage/db';
import type { SystemMonitor } from '../system/system-monitor';
import type { WorkspaceStore } from '../workspace/workspace-store';
import { IS_WIN, ps } from '../windows/ps';

interface RuleDef {
  id: string;
  group: string;
  label: string;
  help: string;
  unit: string | null;
  threshold: number | null;
  enabled: boolean;
  severity: AlertSeverity;
  windowsOnly?: boolean;
}

export const ALERT_RULES: RuleDef[] = [
  { id: 'cpu_high', group: 'Performance', label: 'CPU stays very busy', unit: '%', threshold: 90, enabled: true, severity: 'warning', help: 'Average CPU load above the threshold for 5 minutes' },
  { id: 'mem_high', group: 'Performance', label: 'Memory almost full', unit: '%', threshold: 92, enabled: true, severity: 'warning', help: 'Memory in use above the threshold for 5 minutes' },
  { id: 'temp_high', group: 'Performance', label: 'Processor running hot', unit: '°C', threshold: 90, enabled: true, severity: 'warning', help: 'CPU package temperature above the threshold (where the hardware reports it)' },
  { id: 'disk_low', group: 'Storage', label: 'Drive running out of space', unit: '% free', threshold: 10, enabled: true, severity: 'warning', help: 'Any fixed drive with less free space than this' },
  { id: 'battery_low', group: 'Power', label: 'Battery low and not charging', unit: '%', threshold: 15, enabled: true, severity: 'warning', help: '' },
  { id: 'net_down', group: 'Network', label: 'Internet connection lost', unit: null, threshold: null, enabled: true, severity: 'critical', help: 'Three failed connectivity checks in a row' },
  { id: 'net_restored', group: 'Network', label: 'Internet connection restored', unit: null, threshold: null, enabled: true, severity: 'info', help: '' },
  { id: 'new_device', group: 'Network', label: 'Unknown device joined my network', unit: null, threshold: null, enabled: false, severity: 'warning', help: 'Compares each LAN scan with the devices seen before' },
  { id: 'shield_threat', group: 'Security', label: 'FBRX Shield found a threat', unit: null, threshold: null, enabled: true, severity: 'critical', help: 'Malware or a suspicious file, from a scan or a new download' },
  { id: 'network_threat', group: 'Security', label: 'The network gate saw a threat from this computer', unit: null, threshold: null, enabled: true, severity: 'warning', help: 'From FBRX MiniDome on an FBRX Server gate you allow Network protection on FBRX Mesh' },
  { id: 'av_problem', group: 'Security', label: 'Antivirus needs attention', unit: null, threshold: null, enabled: true, severity: 'warning', help: 'The antivirus protecting this computer is off, out of date or missing' },
  { id: 'defender_off', group: 'Security', label: 'Real-time protection turned off', unit: null, threshold: null, enabled: true, severity: 'critical', help: 'Microsoft Defender real-time protection is disabled', windowsOnly: true },
  { id: 'defender_threat', group: 'Security', label: 'Threat detected', unit: null, threshold: null, enabled: true, severity: 'critical', help: 'Microsoft Defender recorded a new detection', windowsOnly: true },
  { id: 'signatures_old', group: 'Security', label: 'Virus definitions out of date', unit: 'days', threshold: 3, enabled: true, severity: 'warning', help: '', windowsOnly: true },
  { id: 'firewall_off', group: 'Security', label: 'Firewall turned off', unit: null, threshold: null, enabled: true, severity: 'critical', help: 'A Windows Firewall profile is disabled', windowsOnly: true },
  { id: 'crash', group: 'Reliability', label: 'An app crashed or Windows had a stop error', unit: null, threshold: null, enabled: true, severity: 'warning', help: 'From the Windows event log', windowsOnly: true },
  { id: 'printer_error', group: 'Devices', label: 'Printer has a problem', unit: null, threshold: null, enabled: true, severity: 'warning', help: 'Error, offline, paper jam or toner states', windowsOnly: true },
  { id: 'task_due', group: 'Workspace', label: 'Task due today or overdue', unit: null, threshold: null, enabled: true, severity: 'info', help: 'Once per day per task' },
  { id: 'mesh_offline', group: 'Mesh', label: 'One of my devices went offline', unit: null, threshold: null, enabled: false, severity: 'info', help: 'A paired device stopped responding' },
  { id: 'mesh_online', group: 'Mesh', label: 'One of my devices came online', unit: null, threshold: null, enabled: false, severity: 'info', help: '' },
  { id: 'approval_waiting', group: 'Agent', label: 'An action is waiting for my approval', unit: null, threshold: null, enabled: true, severity: 'warning', help: 'So you can approve from your phone' },
  { id: 'update_available', group: 'Updates', label: 'FBRX OS update available', unit: null, threshold: null, enabled: true, severity: 'info', help: '' },
  { id: 'edition_trial', group: 'Edition', label: 'My Pro trial is ending, or has ended', unit: null, threshold: null, enabled: true, severity: 'info', help: 'The day before the free trial ends, and when it has' },
];

/**
 * Conditions that stay true until someone deals with them (an antivirus off or behind, a firewall off): said once,
 * then at most once a day while they last, across restarts, and taken off the inbox when they are over.
 */
const ONGOING_RULES = new Set(['av_problem', 'signatures_old', 'defender_off', 'firewall_off', 'printer_error']);
const ONGOING_EVERY_MS = 24 * 3600_000;
const ONGOING_KEY = 'alerts.ongoing';

/**
 * Problems that last until they are over. The outside (webhooks, syslog, e-mail, the organization) hears each one
 * once, then its all-clear when it ends (FBRX Alert v1); the inbox and the desktop keep their reminders.
 */
const CONDITION_RULES = new Set(['cpu_high', 'mem_high', 'temp_high', 'battery_low', 'disk_low', 'net_down', 'mesh_offline', ...ONGOING_RULES]);
/** Rules that tell a problem is over: the outside gets the problem's all-clear instead. */
const ALL_CLEAR_RULES = new Set(['net_restored', 'mesh_online']);
const OUTWARD: AlertChannel[] = ['organisation', 'webhook', 'email', 'syslog'];
const OPEN_KEY = 'alerts.open';
const MAX_OPEN = 500;

/** A problem the outside has been told about and not yet told is over. */
interface OpenProblem {
  rule: string;
  ref: string;
  severity: AlertSeverity;
  title: string;
  startedAt: string;
  /** The outward channels that took it: its all-clear goes to the same ones. */
  channels: AlertChannel[];
}

export interface AlertEngineDeps {
  db: Db;
  /** Where ongoing conditions remember when they were last said (tests may leave it out). */
  meta?: { get<T>(key: string): T | null; set(key: string, value: unknown): void };
  events: EventBus;
  log: Logger;
  settings: () => Settings;
  monitor: SystemMonitor;
  workspace: WorkspaceStore;
  notify: (title: string, body: string, level: 'info' | 'warning' | 'error', ruleId: string) => void;
  /** Pushes an alert to paired phones; returns how many received it. */
  toMobile: (alert: AlertItem) => number;
  /** Forwards an alert to the organization's control plane; false when not enrolled. */
  toOrganisation: (alert: AlertItem, v: FbrxAlert) => boolean;
  secret: (name: string) => string | undefined;
  meshPeers: () => Array<{ id: string; name: string; online: boolean }>;
  /** What to tell the person about this computer's edition (its Pro trial ending, or over), once each. */
  editionNotice: () => { title: string; body: string } | null;
  /** Who sends: FBRX OS unless FBRX Digger. */
  app?: FbrxAlertApp;
  /** The machine's name in alerts (the host name unless set). */
  host?: string;
  /**
   * The rules this app raises, when not all of them: FBRX Digger leaves the computer's health (drives, processor,
   * memory, battery, security) to FBRX OS.
   */
  allow?: (ruleId: string) => boolean;
}

/**
 * Background alert rules with an inbox and delivery to the desktop, phones, the organization's control plane,
 * webhooks (Slack, Teams, Discord, ntfy, JSON) and e-mail. Cooldowns stop repeats; quiet hours hold back
 * everything but critical alerts.
 */
export class AlertEngine {
  private timer: NodeJS.Timeout | null = null;
  private kick: NodeJS.Timeout | null = null;
  private ticks = 0;
  private readonly last = new Map<string, number>();
  private netFails = 0;
  private netDown = false;
  private downSince = 0;
  private peerState = new Map<string, boolean>();
  private lastThreat: string | null = null;
  private lastCrash: string | null = null;
  /** Where open problems are kept when there is no meta store (tests). */
  private openMem: Record<string, OpenProblem> = {};

  constructor(private readonly d: AlertEngineDeps) {}

  private get app(): FbrxAlertApp {
    return this.d.app ?? 'fbrx-os';
  }

  private get host(): string {
    return this.d.host ?? hostname();
  }

  /** The problems the outside has been told about and not yet told are over. */
  openProblems(): Record<string, OpenProblem> {
    return this.d.meta ? (this.d.meta.get<Record<string, OpenProblem>>(OPEN_KEY) ?? {}) : this.openMem;
  }

  private saveOpen(map: Record<string, OpenProblem>): void {
    const keys = Object.keys(map);
    // Bounded: the oldest go first.
    if (keys.length > MAX_OPEN) for (const k of keys.sort((a, b) => map[a]!.startedAt.localeCompare(map[b]!.startedAt)).slice(0, keys.length - MAX_OPEN)) delete map[k];
    if (this.d.meta) this.d.meta.set(OPEN_KEY, map);
    else this.openMem = map;
  }

  /** An inbox alert in FBRX Alert v1 form. */
  private v1(a: AlertItem, state: FbrxAlertState, ref?: string, startedAt?: string): FbrxAlert {
    const now = new Date().toISOString();
    return { v: 1, id: a.id, key: fbrxAlertKey(this.app, this.host, a.ruleId, ref), state, severity: a.severity, source: { app: this.app, host: this.host }, rule: a.ruleId, title: a.title, ...(a.body ? { detail: a.body } : {}), startedAt: startedAt ?? a.createdAt, sentAt: now };
  }

  /**
   * A problem is over: the outward channels that heard about it get its all-clear, and it is said again at once if it
   * comes back. Nothing happens when the outside was never told.
   */
  clear(ruleId: string, ref = ''): boolean {
    const k = `${ruleId}:${ref}`;
    const map = this.openProblems();
    const was = map[k];
    if (!was) return false;
    delete map[k];
    this.saveOpen(map);
    this.last.delete(k);
    if (!was.channels.length) return true;
    const now = new Date().toISOString();
    const v: FbrxAlert = { v: 1, id: newId('alrt'), key: fbrxAlertKey(this.app, this.host, was.rule, was.ref || undefined), state: 'resolved', severity: was.severity, source: { app: this.app, host: this.host }, rule: was.rule, title: was.title, startedAt: was.startedAt, endedAt: now, sentAt: now };
    const item: AlertItem = { id: v.id, ruleId, severity: 'info', title: `All clear: ${was.title}`.slice(0, 200), body: '', createdAt: now, read: true, deliveries: {} };
    void this.deliver(item, new Set(was.channels), v).catch((err) => this.d.log.debug('All-clear failed', { rule: ruleId, error: errorMessage(err) }));
    return true;
  }

  /** From the background checks: never after the engine stopped. */
  private clearing(ruleId: string, ref = ''): void {
    if (this.timer) this.clear(ruleId, ref);
  }

  start(): void {
    if (this.timer) return;
    this.lastCrash = new Date().toISOString();
    this.timer = setInterval(() => void this.tick().catch((err) => this.d.log.debug('Alert tick failed', { error: errorMessage(err) })), 30_000);
    this.timer.unref?.();
    this.kick = setTimeout(() => void this.tick().catch(() => undefined), 10_000);
    this.kick.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.kick) clearTimeout(this.kick);
    this.timer = null;
    this.kick = null;
  }

  rules(): AlertRuleInfo[] {
    const cfg = this.d.settings().alerts.rules;
    return ALERT_RULES.filter((r) => this.d.allow?.(r.id) ?? true).map((r) => ({
      id: r.id,
      group: r.group,
      label: r.label,
      help: r.help,
      unit: r.unit,
      threshold: cfg[r.id]?.threshold ?? r.threshold,
      enabled: cfg[r.id]?.enabled ?? r.enabled,
      severity: r.severity,
      windowsOnly: !!r.windowsOnly,
    }));
  }

  private rule(id: string) {
    return this.rules().find((r) => r.id === id);
  }

  inbox(p: { limit?: number; unreadOnly?: boolean } = {}): AlertItem[] {
    return this.d.db
      .all<any>(`SELECT * FROM alerts ${p.unreadOnly ? 'WHERE read = 0' : ''} ORDER BY created_at DESC LIMIT ?`, Math.min(p.limit ?? 200, 1000))
      .map(toAlert);
  }

  counts(): { unread: number; critical: number } {
    const r = this.d.db.get<{ unread: number; critical: number }>(
      "SELECT COUNT(*) AS unread, SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS critical FROM alerts WHERE read = 0",
    );
    return { unread: r?.unread ?? 0, critical: r?.critical ?? 0 };
  }

  /**
   * An organization alert from FBRX Command (this computer is one its rules name): it joins the inbox with
   * Acknowledge, and the desktop shows it once. Its all-clear, or word that someone acknowledged it, updates the same
   * entry.
   */
  fromOrganisation(alertId: string, a: FbrxAlert, acknowledged: { by: string; at: string } | null): AlertItem | null {
    const ref = `org:${alertId}`;
    const prev = this.d.db.get<any>('SELECT * FROM alerts WHERE ref = ?', ref);
    const before = prev ? toAlert(prev) : null;
    const org: NonNullable<AlertItem['org']> = { alertId, state: a.state, acknowledged, report: a.report && /^https?:\/\//i.test(a.report) ? a.report : null };
    const over = a.state === 'resolved';
    const where = [a.source.computer ?? a.source.host, a.source.role ? fbrxAlertRoleName(a.source.role) : null].filter(Boolean).join(' · ');
    const title = `${over ? 'All clear: ' : ''}${a.title}`.slice(0, 200);
    const body = [!over ? a.detail : null, !over && a.yours ? `What is left for you: ${a.yours}` : null, `From your organization (FBRX Command)${where ? ` · ${where}` : ''}`]
      .filter(Boolean)
      .join('\n')
      .slice(0, 2000);
    const severity = over ? 'info' : a.severity;
    let id: string;
    if (prev) {
      id = prev.id;
      // News (its all-clear) makes it unread again; an acknowledgement does not.
      const news = over && before?.org?.state !== 'resolved';
      this.d.db.run('UPDATE alerts SET severity = ?, title = ?, body = ?, org = ?, read = CASE WHEN ? THEN 0 ELSE read END WHERE id = ?', severity, title, body, JSON.stringify(org), news ? 1 : 0, id);
      if (news) this.d.notify(title, body, 'info', 'org');
    } else {
      if (over) return null;
      id = newId('alrt');
      this.d.db.run(
        'INSERT INTO alerts (id, rule_id, severity, title, body, created_at, read, deliveries, ref, org) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)',
        id,
        'org',
        severity,
        title,
        body,
        new Date().toISOString(),
        '{}',
        ref,
        JSON.stringify(org),
      );
      const quiet = this.inQuietHours() && a.severity !== 'critical';
      if (!acknowledged && !quiet) this.d.notify(title, body, a.severity === 'critical' ? 'error' : a.severity === 'warning' ? 'warning' : 'info', 'org');
    }
    const item = toAlert(this.d.db.get<any>('SELECT * FROM alerts WHERE id = ?', id));
    this.d.events.emit('alerts.changed', this.counts());
    return item;
  }

  /** Marks an organization alert acknowledged here (FBRX Command is told by the caller). */
  acknowledgedHere(id: string, by: string): AlertItem {
    const row = this.d.db.get<any>('SELECT * FROM alerts WHERE id = ?', id);
    const item = row ? toAlert(row) : null;
    if (!item?.org) throw new CoreError('NOT_FOUND', 'That is not an alert from your organization');
    const org = { ...item.org, acknowledged: item.org.acknowledged ?? { by, at: new Date().toISOString() } };
    this.d.db.run('UPDATE alerts SET org = ?, read = 1 WHERE id = ?', JSON.stringify(org), id);
    this.d.events.emit('alerts.changed', this.counts());
    return { ...item, org, read: true };
  }

  markRead(id: string): void {
    if (id === '*') this.d.db.run('UPDATE alerts SET read = 1 WHERE read = 0');
    else this.d.db.run('UPDATE alerts SET read = 1 WHERE id = ?', id);
    this.d.events.emit('alerts.changed', this.counts());
  }

  /**
   * The thing an alert was about has been dealt with (a file trusted or quarantined in FBRX Shield, say): its alerts
   * leave the inbox, and the next one about it is not held back by the cooldown.
   */
  resolve(ruleId: string, key: string): number {
    const n = this.d.db.run('DELETE FROM alerts WHERE rule_id = ? AND ref = ?', ruleId, key).changes ?? 0;
    this.last.delete(`${ruleId}:${key}`);
    if (n) this.d.events.emit('alerts.changed', this.counts());
    return n;
  }

  private ongoing(): Record<string, number> {
    return this.d.meta?.get<Record<string, number>>(ONGOING_KEY) ?? {};
  }

  /**
   * Of an ongoing rule's alerts, the ones not about these keys are over: they leave the inbox, and the condition is
   * said again at once if it comes back.
   */
  settle(ruleId: string, keep: string[]): number {
    for (const p of Object.values(this.openProblems())) if (p.rule === ruleId && !keep.includes(p.ref)) this.clear(ruleId, p.ref);
    const gone = this.d.db.all<{ id: string; ref: string | null }>('SELECT id, ref FROM alerts WHERE rule_id = ?', ruleId).filter((r) => !keep.includes(r.ref ?? ''));
    for (const r of gone) this.d.db.run('DELETE FROM alerts WHERE id = ?', r.id);
    const map = this.ongoing();
    let changed = false;
    for (const k of Object.keys(map)) {
      if (!k.startsWith(`${ruleId}:`) || keep.includes(k.slice(ruleId.length + 1))) continue;
      delete map[k];
      this.last.delete(k);
      changed = true;
    }
    if (changed) this.d.meta?.set(ONGOING_KEY, map);
    if (gone.length) this.d.events.emit('alerts.changed', this.counts());
    return gone.length;
  }

  remove(id: string): void {
    if (id === '*') this.d.db.run('DELETE FROM alerts');
    else this.d.db.run('DELETE FROM alerts WHERE id = ?', id);
    this.d.events.emit('alerts.changed', this.counts());
  }

  private inQuietHours(): boolean {
    const q = this.d.settings().alerts.quietHours;
    if (!q.enabled) return false;
    const now = new Date();
    const m = now.getHours() * 60 + now.getMinutes();
    const [sh, sm] = q.start.split(':').map(Number);
    const [eh, em] = q.end.split(':').map(Number);
    const s = sh * 60 + sm;
    const e = eh * 60 + em;
    return s <= e ? m >= s && m < e : m >= s || m < e;
  }

  /**
   * Raises an alert: stored in the inbox and routed by severity. `key` scopes the cooldown (one per drive,
   * printer, task, …). Returns null when the rule is off or still cooling down.
   */
  /** Fires from the background checks; never after the engine stopped (the database may already be closed). */
  private raise(ruleId: string, title: string, body: string, o: { key?: string; severity?: AlertSeverity } = {}): void {
    if (!this.timer) return;
    void this.fire(ruleId, title, body, o).catch((err) => this.d.log.debug('Alert failed', { rule: ruleId, error: errorMessage(err) }));
  }

  async fire(ruleId: string, title: string, body: string, o: { key?: string; severity?: AlertSeverity; force?: boolean } = {}): Promise<AlertItem | null> {
    const rule = this.rule(ruleId);
    const cfg = this.d.settings().alerts;
    if (!o.force && (!rule || !rule.enabled)) return null;
    const k = `${ruleId}:${o.key ?? ''}`;
    const prev = this.last.get(k);
    if (!o.force && prev && Date.now() - prev < cfg.cooldownMinutes * 60_000) return null;
    if (!o.force && ONGOING_RULES.has(ruleId)) {
      const map = this.ongoing();
      if (map[k] && Date.now() - map[k] < ONGOING_EVERY_MS) return null;
      // Remembered across restarts; entries over a week old are forgotten.
      for (const [x, at] of Object.entries(map)) if (Date.now() - at > 7 * ONGOING_EVERY_MS) delete map[x];
      this.d.meta?.set(ONGOING_KEY, { ...map, [k]: Date.now() });
    }
    this.last.set(k, Date.now());
    const severity = o.severity ?? rule?.severity ?? 'info';
    const alert: AlertItem = { id: newId('alrt'), ruleId, severity, title: title.slice(0, 200), body: body.slice(0, 2000), createdAt: new Date().toISOString(), read: false, deliveries: {} };
    this.d.db.run(
      'INSERT INTO alerts (id, rule_id, severity, title, body, created_at, read, deliveries, ref) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
      alert.id,
      ruleId,
      severity,
      alert.title,
      alert.body,
      alert.createdAt,
      '{}',
      o.key ?? null,
    );
    this.d.db.run("DELETE FROM alerts WHERE id NOT IN (SELECT id FROM alerts ORDER BY created_at DESC LIMIT 1000)");
    const routes = new Set<AlertChannel>(cfg.routing[severity]);
    const condition = CONDITION_RULES.has(ruleId) && ruleId !== 'test';
    const was = condition ? this.openProblems()[k] : undefined;
    // A problem goes out once (a channel that failed tries again with the next reminder); an all-clear rule's news
    // already went out as the problem's all-clear.
    if (was) for (const c of was.channels) routes.delete(c);
    if (ALL_CLEAR_RULES.has(ruleId)) for (const c of OUTWARD) routes.delete(c);
    const v = this.v1(alert, condition ? 'open' : 'event', o.key, was?.startedAt);
    alert.deliveries = await this.deliver(alert, routes, v);
    if (condition) {
      const told = OUTWARD.filter((c) => alert.deliveries[c] === 'ok');
      const map = this.openProblems();
      const now = map[k];
      if (now) now.channels = [...new Set([...now.channels, ...told])];
      else map[k] = { rule: ruleId, ref: o.key ?? '', severity, title: alert.title, startedAt: alert.createdAt, channels: told };
      this.saveOpen(map);
    }
    this.d.db.run('UPDATE alerts SET deliveries = ? WHERE id = ?', JSON.stringify(alert.deliveries), alert.id);
    this.d.events.emit('alerts.new', alert);
    this.d.events.emit('alerts.changed', this.counts());
    return alert;
  }

  private async deliver(a: AlertItem, routes: Set<AlertChannel>, v: FbrxAlert): Promise<AlertItem['deliveries']> {
    const ch = this.d.settings().alerts.channels;
    const quiet = this.inQuietHours() && a.severity !== 'critical' && v.state !== 'resolved';
    const out: AlertItem['deliveries'] = v.state === 'resolved' ? {} : { inbox: 'ok' };
    const attempt = async (c: AlertChannel, fn: () => Promise<string> | string) => {
      try {
        out[c] = await fn();
      } catch (err) {
        out[c] = errorMessage(err);
      }
    };
    if (routes.has('desktop') && ch.desktop && v.state !== 'resolved') {
      if (quiet) out.desktop = 'held (quiet hours)';
      else await attempt('desktop', () => (this.d.notify(a.title, a.body, a.severity === 'critical' ? 'error' : a.severity === 'warning' ? 'warning' : 'info', a.ruleId), 'ok'));
    }
    if (routes.has('mobile') && ch.mobile && v.state !== 'resolved') await attempt('mobile', () => `${this.d.toMobile(a)} device(s)`);
    if (routes.has('organisation') && ch.organisation) await attempt('organisation', () => (this.d.toOrganisation(a, v) ? 'ok' : 'not enrolled'));
    if (routes.has('webhook') && ch.webhook.enabled && ch.webhook.url) await attempt('webhook', () => this.sendWebhook(a, v));
    if (routes.has('email') && ch.email.enabled) {
      if (quiet) out.email = 'held (quiet hours)';
      else await attempt('email', () => this.sendEmail(v));
    }
    if (routes.has('syslog') && ch.syslog.enabled && ch.syslog.host) await attempt('syslog', () => this.sendSyslog(v));
    return out;
  }

  async sendSyslog(v: FbrxAlert): Promise<string> {
    const s = this.d.settings().alerts.channels.syslog;
    await sendFbrxAlertSyslog({ host: s.host.trim(), port: s.port, protocol: s.protocol }, v);
    return 'ok';
  }

  /** To the webhook: FBRX Alert v1, signed (the fbrx format), or a chat message saying it in words. */
  async sendWebhook(item: AlertItem, v: FbrxAlert): Promise<string> {
    const w = this.d.settings().alerts.channels.webhook;
    if (!/^https?:\/\//i.test(w.url)) throw new CoreError('INVALID_ARGUMENT', 'Webhook URL must start with https://');
    if (w.format === 'fbrx') {
      const secret = this.d.secret(w.secretName);
      if (!secret) throw new CoreError('NOT_FOUND', `Save the webhook's signing secret in Credentials as ${w.secretName}`);
      await postFbrxAlert(w.url, v, secret, { userAgent: `FBRX-Alert/1 (${this.app})` });
      return 'ok';
    }
    // The other formats say it in words; an all-clear says so.
    const a = v.state === 'resolved' ? { ...item, title: `All clear: ${v.title}`.slice(0, 200), body: `Over after ${fbrxAlertDuration(v) ?? 'a while'}.` } : item;
    let body: string;
    let headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const device = this.host;
    if (w.format === 'discord') body = JSON.stringify({ username: 'FBRX OS', content: `**${a.title}**\n${a.body}\n_${device}_` });
    else if (w.format === 'slack') body = JSON.stringify({ text: `*${a.title}*\n${a.body}\n_${device}_` });
    else if (w.format === 'teams') body = JSON.stringify({ text: `**${a.title}**  \n${a.body}  \n_${device}_` });
    else if (w.format === 'ntfy') {
      body = a.body;
      headers = { Title: a.title.replace(/[^\x20-\x7e]/g, ''), Priority: a.severity === 'critical' ? 'urgent' : a.severity === 'warning' ? 'high' : 'default', Tags: 'computer' };
    } else body = JSON.stringify({ source: this.app, device, ...a, key: v.key, state: v.state });
    const r = await fetch(w.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`Webhook HTTP ${r.status}`);
    return 'ok';
  }

  async sendEmail(v: FbrxAlert): Promise<string> {
    const e = this.d.settings().alerts.channels.email;
    if (!e.host || !e.to) throw new CoreError('INVALID_ARGUMENT', 'Set the SMTP server and recipient first');
    const pass = e.user ? this.d.secret(e.passwordSecret) : undefined;
    if (e.user && !pass) throw new CoreError('NOT_FOUND', `Save the SMTP password in Credentials as ${e.passwordSecret}`);
    const t = nodemailer.createTransport({ host: e.host, port: e.port, secure: e.secure, auth: e.user ? { user: e.user, pass } : undefined, connectionTimeout: 15_000 });
    const m = fbrxAlertText(v);
    await t.sendMail({ from: e.from || e.user, to: e.to, subject: m.subject, text: m.text });
    return 'ok';
  }

  async test(channel: AlertChannel): Promise<{ ok: boolean; result: string }> {
    const a: AlertItem = {
      id: newId('alrt'),
      ruleId: 'test',
      severity: 'info',
      title: `Test alert from ${this.app === 'fbrx-digger' ? 'FBRX Digger' : 'FBRX OS'}`,
      body: `If you can read this, ${channel} alerts work.`,
      createdAt: new Date().toISOString(),
      read: false,
      deliveries: {},
    };
    try {
      let result = 'ok';
      const v = this.v1(a, 'event');
      if (channel === 'webhook') result = await this.sendWebhook(a, v);
      else if (channel === 'email') result = await this.sendEmail(v);
      else if (channel === 'syslog') result = await this.sendSyslog(v);
      else if (channel === 'desktop') this.d.notify(a.title, a.body, 'info', a.ruleId);
      else if (channel === 'mobile') result = `${this.d.toMobile(a)} device(s) reached`;
      else if (channel === 'organisation') result = this.d.toOrganisation(a, v) ? 'sent to the control plane' : 'this device is not enrolled';
      else if (channel === 'inbox') await this.fire('test', a.title, a.body, { force: true });
      return { ok: true, result };
    } catch (err) {
      return { ok: false, result: errorMessage(err) };
    }
  }

  // ----------------------------------------------------------------------------------------- checks

  private async tick(): Promise<void> {
    this.ticks++;
    const rules = Object.fromEntries(this.rules().map((r) => [r.id, r]));
    // The computer's health is checked only where it is this app's to tell (not in FBRX Digger).
    if (rules.disk_low) await this.healthChecks(rules);
    if (rules.net_down || rules.net_restored) await this.connectivityCheck();
    for (const p of this.d.meshPeers()) {
      const prev = this.peerState.get(p.id);
      this.peerState.set(p.id, p.online);
      if (prev === true && !p.online) this.raise('mesh_offline', `${p.name} went offline`, `${p.name} stopped responding on your mesh.`, { key: p.id });
      if (prev === false && p.online) this.raise('mesh_online', `${p.name} is online`, `${p.name} is reachable again.`, { key: p.id });
      if (p.online) this.clearing('mesh_offline', p.id);
    }
    if (this.ticks % 20 === 2) this.taskCheck();
    if (this.ticks % 20 === 3) {
      const n = this.d.editionNotice();
      if (n) this.raise('edition_trial', n.title, n.body);
    }
    if (rules.disk_low && IS_WIN && this.ticks % 10 === 1) await this.windowsChecks(rules.signatures_old.threshold ?? 3).catch(() => undefined);
  }

  /** The computer's health: processor, memory, temperature, battery and drives. */
  private async healthChecks(rules: Record<string, AlertRuleInfo>) {
    const m = this.d.monitor;
    const cpu = m.average('cpu', 300);
    // Each problem is over a little below where it started, so a value near the line does not flap.
    const cpuMax = rules.cpu_high.threshold ?? 90;
    if (cpu != null && cpu > cpuMax) this.raise('cpu_high', 'CPU has been very busy', `Average CPU load ${cpu.toFixed(0)}% over the last 5 minutes. Open Processes to see what is using it.`);
    else if (cpu != null && cpu < cpuMax - 10) this.clearing('cpu_high');
    const mem = m.average('mem', 300);
    const memMax = rules.mem_high.threshold ?? 92;
    if (mem != null && mem > memMax) this.raise('mem_high', 'Memory is almost full', `${mem.toFixed(0)}% of memory in use over the last 5 minutes.`);
    else if (mem != null && mem < memMax - 5) this.clearing('mem_high');
    const cur = m.current;
    const tempMax = rules.temp_high.threshold ?? 90;
    if (cur?.tempC && cur.tempC > tempMax) this.raise('temp_high', 'Processor is running hot', `CPU temperature is ${cur.tempC} °C. Check the fans and airflow.`);
    else if (cur?.tempC && cur.tempC < tempMax - 10) this.clearing('temp_high');
    const batMin = rules.battery_low.threshold ?? 15;
    if (cur?.battery && !cur.battery.charging && cur.battery.percent <= batMin) {
      this.raise('battery_low', 'Battery is low', `${cur.battery.percent}% remaining and not charging.`);
    } else if (cur?.battery && (cur.battery.charging || cur.battery.percent > batMin + 5)) this.clearing('battery_low');
    if (this.ticks % 4 === 1) await this.diskCheck(rules.disk_low.threshold ?? 10);
  }

  private async diskCheck(threshold: number) {
    const fsz = await si.fsSize().catch(() => []);
    if (!fsz.length) return;
    const low = new Set<string>();
    for (const d of fsz) {
      if (!d.size || d.size < 2e9 || /^\/(snap|boot|run|dev|sys|proc)/.test(d.mount)) continue;
      const free = (d.available / d.size) * 100;
      if (free < threshold) this.raise('disk_low', `Drive ${d.mount} is running out of space`, `${(d.available / 1e9).toFixed(1)} GB free (${free.toFixed(0)}%). Open Storage to clean up.`, { key: d.mount });
      // Over once it has a little room again (or the drive is gone).
      if (free < threshold + 2) low.add(d.mount);
    }
    for (const p of Object.values(this.openProblems())) if (p.rule === 'disk_low' && !low.has(p.ref)) this.clearing('disk_low', p.ref);
  }

  private async connectivityCheck() {
    const probe = (url: string) =>
      fetch(url, { signal: AbortSignal.timeout(6000) }).then(
        (r) => r.ok,
        () => false,
      );
    const online = (await probe('http://www.msftconnecttest.com/connecttest.txt')) || (await probe('https://1.1.1.1/cdn-cgi/trace'));
    if (!online) {
      this.netFails++;
      if (this.netFails >= 3 && !this.netDown) {
        this.netDown = true;
        this.downSince = Date.now();
        this.raise('net_down', 'Internet connection lost', 'FBRX OS cannot reach the internet. Open Network Center to troubleshoot.');
      }
    } else {
      if (this.netDown) {
        const mins = Math.max(1, Math.round((Date.now() - this.downSince) / 60_000));
        this.raise('net_restored', 'Internet connection restored', `Back online after about ${mins} minute(s).`);
      }
      this.clearing('net_down');
      this.netFails = 0;
      this.netDown = false;
    }
  }

  private taskCheck() {
    const today = new Date().toISOString().slice(0, 10);
    for (const t of this.d.workspace.dueSoon(0)) {
      const due = (t.due ?? '').slice(0, 10);
      this.raise('task_due', due < today ? `Overdue: ${t.title}` : `Due today: ${t.title}`, `Priority ${t.priority}.`, { key: `${t.id}:${today}` });
    }
  }

  private async windowsChecks(sigDays: number) {
    const since = this.lastCrash ?? new Date(Date.now() - 3600_000).toISOString();
    const r = await ps(
      `$s=Get-MpComputerStatus -ErrorAction SilentlyContinue
$t=Get-MpThreatDetection -ErrorAction SilentlyContinue | Sort-Object InitialDetectionTime -Descending | Select-Object -First 1
$fw=@(Get-NetFirewallProfile -ErrorAction SilentlyContinue | Where-Object { -not $_.Enabled } | ForEach-Object { [string]$_.Name })
$p=@(Get-Printer -ErrorAction SilentlyContinue | Where-Object { [string]$_.PrinterStatus -notin 'Normal','Idle','Printing','0','3' } | ForEach-Object { [pscustomobject]@{ name=$_.Name; status=[string]$_.PrinterStatus } })
$since=[datetime]::Parse('${since}').ToLocalTime()
$cr=@(Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Application Error'; Id=1000; StartTime=$since} -MaxEvents 5 -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ app=[string]$_.Properties[0].Value; time=$_.TimeCreated.ToUniversalTime().ToString('o') } })
$bs=@(Get-WinEvent -FilterHashtable @{LogName='System'; Id=1001; ProviderName='Microsoft-Windows-WER-SystemErrorReporting'; StartTime=$since} -MaxEvents 1 -ErrorAction SilentlyContinue).Count
[pscustomobject]@{ av=$s.AntivirusEnabled; rtp=$s.RealTimeProtectionEnabled; sigAge=$s.AntivirusSignatureAge; threat=$(if ($t) { [pscustomobject]@{ time=$t.InitialDetectionTime.ToUniversalTime().ToString('o'); res=([string]($t.Resources | Select-Object -First 1)) } }); firewall=$fw; printers=$p; crashes=$cr; bsod=$bs } | ConvertTo-Json -Depth 4 -Compress`,
      60_000,
    );
    if (!this.timer) return;
    let j: any;
    try {
      j = JSON.parse(r.out.trim());
    } catch {
      return;
    }
    this.lastCrash = new Date().toISOString();
    // Defender's own state only counts while it is the antivirus in use (not when another one has taken over).
    const off = j.av === true && j.rtp === false;
    const old = j.av === true && typeof j.sigAge === 'number' && j.sigAge > sigDays;
    if (off) this.raise('defender_off', 'Real-time protection is off', 'Microsoft Defender real-time protection is disabled. Turn it back on in Security.', { key: 'defender' });
    if (old) this.raise('signatures_old', 'Virus definitions are out of date', `Definitions are ${j.sigAge} days old. Open Security → Update definitions.`, { key: 'defender' });
    this.settle('defender_off', off ? ['defender'] : []);
    this.settle('signatures_old', old ? ['defender'] : []);
    if (j.threat) {
      if (this.lastThreat && j.threat.time > this.lastThreat) this.raise('defender_threat', 'Microsoft Defender detected a threat', `${j.threat.res || 'A threat'} was detected. Open Security → Threats for details.`, { key: j.threat.time });
      this.lastThreat = j.threat.time;
    } else this.lastThreat ??= '0';
    const fw: string[] = [].concat(j.firewall ?? []);
    for (const name of fw) this.raise('firewall_off', `Firewall is off (${name} profile)`, 'Turn Windows Firewall back on in Security → Firewall.', { key: name });
    this.settle('firewall_off', fw);
    const printers = [].concat(j.printers ?? []) as Array<{ name: string; status: string }>;
    for (const p of printers) this.raise('printer_error', `Printer "${p.name}" needs attention`, `Status: ${p.status}. Open Network Center → Printers.`, { key: p.name });
    this.settle('printer_error', printers.map((p) => p.name));
    for (const c of [].concat(j.crashes ?? []) as Array<{ app: string; time: string }>) this.raise('crash', `${c.app} crashed`, 'Open Bug catcher to investigate with Fabrix.', { key: c.time });
    if (j.bsod) this.raise('crash', 'Windows recovered from a stop error (blue screen)', 'Open Bug catcher for the crash details.', { key: 'bsod', severity: 'critical' });
  }
}

function toAlert(r: any): AlertItem {
  let deliveries = {};
  try {
    deliveries = JSON.parse(r.deliveries);
  } catch {
    /* ignore */
  }
  let org: AlertItem['org'];
  try {
    org = r.org ? JSON.parse(r.org) : undefined;
  } catch {
    org = undefined;
  }
  return { id: r.id, ruleId: r.rule_id, severity: r.severity, title: r.title, body: r.body, createdAt: r.created_at, read: !!r.read, deliveries, ...(org ? { org } : {}) };
}
