import { randomBytes } from 'node:crypto';
import {
  OrgAlertRuleSchema,
  fbrxAlertDuration,
  fbrxAlertKey,
  fbrxAlertText,
  newId,
  type FbrxAlert,
  type OrgAlertEvent,
  type OrgAlertReport,
  type OrgAlertInbound,
  type OrgAlertRow,
  type OrgAlertRule,
  type OrgAlertsList,
  type ServerToDeviceMessage,
} from '@fbrx/shared';
import { openString, sealString, type Db } from '@fbrx/shared/node';

const RANK = { info: 0, warning: 1, critical: 2 } as const;
/** Alerts that are over (and events) are kept this long. */
const KEEP_DAYS = 90;
/** A computer that was offline gets the alerts meant for it that are still open and this recent when it connects. */
const RESEND_DAYS = 7;

export type AlertWebhookEvent = 'alert.opened' | 'alert.resolved' | 'alert.acknowledged' | 'alert.escalated';

export interface AlertCenterDeps {
  db: Db;
  master: Buffer;
  sendToDevice: (deviceId: string, msg: ServerToDeviceMessage) => boolean;
  emitAdmin: (event: { type: 'alert.updated'; tenantId: string; alert: unknown }) => void;
  webhook: (tenantId: string, event: AlertWebhookEvent, payload: unknown) => void;
  mail: (to: string, subject: string, text: string) => Promise<void>;
  log: (msg: string, data?: unknown) => void;
  /** FBRX Command's address, for the incident report's link in each alert it sends on. */
  publicUrl?: () => string | null;
  now?: () => Date;
}

interface Row {
  id: string;
  tenant_id: string;
  key: string;
  state: FbrxAlert['state'];
  severity: FbrxAlert['severity'];
  device_id: string | null;
  alert: string;
  count: number;
  rules: string;
  targets: string;
  notified: string;
  held: number;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  ack_note: string | null;
  escalated_at: string | null;
  started_at: string;
  updated_at: string;
}

/** Who heard an alert, so its all-clear and any update reach the same people. */
interface Targets {
  emails: string[];
  devices: string[];
}

/** Whether a time falls in a rule's quiet hours (in its time zone; overnight hours wrap past midnight). */
export function inQuietHours(q: OrgAlertRule['quiet'], at: Date): boolean {
  if (!q.enabled || q.from === q.to) return false;
  let hm: string;
  try {
    hm = new Intl.DateTimeFormat('en-GB', { timeZone: q.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  } catch {
    hm = at.toISOString().slice(11, 16);
  }
  return q.from < q.to ? hm >= q.from && hm < q.to : hm >= q.from || hm < q.to;
}

/** Who heard it, as stored (an older or empty row reads as nobody). */
const targetsOf = (s: string | null): Targets => {
  const t = json<Partial<Targets> | null>(s, null);
  return { emails: Array.isArray(t?.emails) ? t.emails : [], devices: Array.isArray(t?.devices) ? t.devices : [] };
};

const json = <T>(s: string | null, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

/**
 * FBRX Alerts in an organization (FBRX Command → Alerts). Every alert from the organization's computers, its FBRX
 * Servers and FBRX Command itself lands here: a problem keeps one row from its alert to its all-clear (repeats are
 * folded into it), a thing that happened once is an event. The organization's rules decide who hears what, first and
 * then when nobody acknowledges it in time: e-mail, and FBRX OS on chosen computers, which shows it with Acknowledge.
 * The console shows everything, always. Acknowledging stops the escalation; the all-clear reaches whoever heard the
 * alert.
 */
export class AlertCenter {
  constructor(private readonly d: AlertCenterDeps) {}

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }

  // ------------------------------------------------------------------------------------------------ rules

  rules(tenantId: string): OrgAlertRule[] {
    return this.d.db
      .all<{ id: string; rule: string }>('SELECT id, rule FROM org_alert_rules WHERE tenant_id = ? ORDER BY position, created_at', tenantId)
      .map((r) => ({ ...json<Omit<OrgAlertRule, 'id'>>(r.rule, {} as never), id: r.id }));
  }

  /** Replaces the organization's rules with these, in this order (the page edits the list as a whole). */
  saveRules(tenantId: string, input: unknown[]): OrgAlertRule[] {
    if (input.length > 50) throw new Error('At most 50 rules');
    const rules = input.map((r) => ({ id: typeof (r as { id?: unknown }).id === 'string' ? String((r as { id: string }).id) : null, rule: OrgAlertRuleSchema.parse(r) }));
    const now = this.now().toISOString();
    this.d.db.tx(() => {
      this.d.db.run('DELETE FROM org_alert_rules WHERE tenant_id = ?', tenantId);
      rules.forEach((r, i) => {
        const id = r.id && /^arl_[\w-]+$/.test(r.id) ? r.id : newId('arl');
        this.d.db.run('INSERT INTO org_alert_rules (id, tenant_id, rule, position, created_at, updated_at) VALUES (?,?,?,?,?,?)', id, tenantId, JSON.stringify(r.rule), i, now, now);
      });
    });
    return this.rules(tenantId);
  }

  // ------------------------------------------------------------------------------------ servers' alerts

  inbound(tenantId: string, baseUrl: string): OrgAlertInbound {
    const t = this.d.db.get<{ s: string | null }>('SELECT alert_inbound_secret AS s FROM tenants WHERE id = ?', tenantId);
    return { url: `${baseUrl.replace(/\/+$/, '')}/v1/alerts/inbound/${tenantId}`, secretSet: !!t?.s };
  }

  /** A new signing secret for the alerts FBRX Servers send here (shown once; the old one stops working). */
  newInboundSecret(tenantId: string): string {
    const secret = randomBytes(24).toString('hex');
    this.d.db.run('UPDATE tenants SET alert_inbound_secret = ? WHERE id = ?', sealString(this.d.master, secret, `alert-inbound:${tenantId}`), tenantId);
    return secret;
  }

  inboundSecret(tenantId: string): string | null {
    const t = this.d.db.get<{ s: string | null }>('SELECT alert_inbound_secret AS s FROM tenants WHERE id = ?', tenantId);
    if (!t?.s) return null;
    try {
      return openString(this.d.master, t.s, `alert-inbound:${tenantId}`);
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------------------------------------ alerts

  /**
   * Takes an alert in. A problem's alert opens its row (or is folded into the open one; a worse severity is said
   * again), its all-clear closes it and reaches whoever heard it, an event is a row of its own.
   */
  ingest(tenantId: string, alert: FbrxAlert, from: { deviceId?: string | null } = {}): OrgAlertRow | null {
    const now = this.now().toISOString();
    const deviceId = from.deviceId ?? null;
    if (alert.state === 'resolved') {
      const row = this.d.db.get<Row>("SELECT * FROM org_alerts WHERE tenant_id = ? AND key = ? AND state = 'open'", tenantId, alert.key);
      if (!row) return null;
      const opened = json<FbrxAlert>(row.alert, alert);
      const over: FbrxAlert = { ...alert, startedAt: opened.startedAt, endedAt: alert.endedAt ?? now };
      this.d.db.run("UPDATE org_alerts SET state = 'resolved', alert = ?, held = 0, updated_at = ? WHERE id = ?", JSON.stringify({ ...over, report: opened.report }), now, row.id);
      this.steps(row.id, alert);
      const lasted = fbrxAlertDuration(over);
      this.record(row.id, 'resolved', `All clear${lasted ? ` after ${lasted}` : ''}${alert.detail ? `: ${alert.detail}` : ''}`);
      const done = this.get(row.id)!;
      this.allClear(done, targetsOf(row.targets));
      this.d.webhook(tenantId, 'alert.resolved', { alert: over, id: row.id });
      return this.changed(done);
    }
    if (alert.state === 'open') {
      const row = this.d.db.get<Row>("SELECT * FROM org_alerts WHERE tenant_id = ? AND key = ? AND state = 'open'", tenantId, alert.key);
      if (row) {
        const worse = RANK[alert.severity] > RANK[row.severity];
        const kept = json<FbrxAlert>(row.alert, alert);
        this.steps(row.id, alert);
        if (worse) this.record(row.id, 'worse', `Got worse: ${alert.severity}${alert.detail ? `. ${alert.detail}` : ''}`);
        else this.repeated(row.id, Number(row.count) + 1);
        this.d.db.run(
          'UPDATE org_alerts SET alert = ?, severity = ?, count = count + 1, updated_at = ? WHERE id = ?',
          JSON.stringify({ ...alert, startedAt: kept.startedAt, report: kept.report }),
          worse ? alert.severity : row.severity,
          now,
          row.id,
        );
        // Said once; said again (to everyone) only when it got worse.
        if (worse) this.route(this.raw(row.id)!, 'alert', { again: true, fresh: true });
        return this.changed(this.get(row.id)!);
      }
    }
    const id = newId('alr');
    // Every alert FBRX Command sends on links its incident report (the sender's own report link is kept).
    const base = this.d.publicUrl?.()?.replace(/\/+$/, '');
    const withReport: FbrxAlert = alert.report || !base ? alert : { ...alert, report: `${base}/#/alerts/${id}` };
    this.d.db.run(
      'INSERT INTO org_alerts (id, tenant_id, key, state, severity, device_id, alert, started_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id,
      tenantId,
      alert.key,
      alert.state,
      alert.severity,
      deviceId,
      JSON.stringify(withReport),
      alert.startedAt,
      now,
    );
    this.record(id, 'opened', `${alert.state === 'event' ? 'Happened' : 'Started'}: ${alert.title} (${alert.severity}, from ${[alert.source.computer ?? alert.source.host, alert.source.role].filter(Boolean).join(' · ')})`, alert.startedAt);
    this.steps(id, alert);
    alert = withReport;
    this.route(this.raw(id)!, 'alert');
    this.d.webhook(tenantId, 'alert.opened', { alert, id, deviceId });
    return this.changed(this.get(id)!);
  }

  acknowledge(id: string, by: string, note: string | null = null): OrgAlertRow {
    const row = this.raw(id);
    if (!row) throw new Error('Unknown alert');
    if (!row.acknowledged_at) {
      this.d.db.run('UPDATE org_alerts SET acknowledged_by = ?, acknowledged_at = ?, ack_note = ? WHERE id = ?', by.slice(0, 120), this.now().toISOString(), note?.slice(0, 500) || null, id);
      this.record(id, 'acknowledged', `Acknowledged by ${by.slice(0, 120)}${note ? `: ${note.slice(0, 500)}` : ''}`);
      const view = this.get(id)!;
      // The computers that show it mark it acknowledged too.
      for (const deviceId of targetsOf(row.targets).devices) this.sendTo(deviceId, view);
      this.d.webhook(row.tenant_id, 'alert.acknowledged', { alert: view.alert, id, by, note });
    }
    return this.changed(this.get(id)!);
  }

  get(id: string): OrgAlertRow | null {
    const row = this.raw(id);
    return row ? this.view(row) : null;
  }

  tenantOf(id: string): string | null {
    return this.raw(id)?.tenant_id ?? null;
  }

  /** Going on now (worst first) and the latest that are over or happened once. */
  list(tenantId: string | null): OrgAlertsList {
    const where = tenantId ? 'tenant_id = ? AND' : '';
    const args = tenantId ? [tenantId] : [];
    const open = this.d.db
      .all<Row>(`SELECT * FROM org_alerts WHERE ${where} state = 'open' ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, started_at DESC LIMIT 200`, ...args)
      .map((r) => this.view(r));
    const recent = this.d.db.all<Row>(`SELECT * FROM org_alerts WHERE ${where} state != 'open' ORDER BY updated_at DESC LIMIT 100`, ...args).map((r) => this.view(r));
    return { open, recent };
  }

  /** A computer came online: the alerts meant for it that nobody acknowledged yet, and still open. */
  onDeviceOnline(deviceId: string): void {
    const since = new Date(this.now().getTime() - RESEND_DAYS * 86_400_000).toISOString();
    const rows = this.d.db.all<Row>(
      "SELECT * FROM org_alerts WHERE state != 'resolved' AND acknowledged_at IS NULL AND updated_at > ? AND targets LIKE ?",
      since,
      `%${JSON.stringify(deviceId)}%`,
    );
    for (const r of rows) this.sendTo(deviceId, this.view(r));
  }

  /**
   * Once a minute: escalates open alerts nobody acknowledged in time, sends what quiet hours held once they are over,
   * and forgets what ended long ago.
   */
  tick(): void {
    const at = this.now();
    for (const row of this.d.db.all<Row>("SELECT * FROM org_alerts WHERE state = 'open' AND acknowledged_at IS NULL AND (held = 1 OR escalated_at IS NULL)")) {
      const rules = this.rulesFor(row);
      if (row.held && rules.every((r) => !inQuietHours(r.quiet, at))) {
        this.d.db.run('UPDATE org_alerts SET held = 0 WHERE id = ?', row.id);
        this.record(row.id, 'released', 'Quiet hours over: told now');
        this.route(this.raw(row.id)!, 'alert', { again: true });
      }
      if (!row.escalated_at) {
        const age = (at.getTime() - Date.parse(row.started_at)) / 60_000;
        const due = rules.filter((r) => r.escalateAfterMinutes > 0 && age >= r.escalateAfterMinutes && (r.escalateEmails.length || r.escalateComputerTags.length));
        if (due.length) {
          this.d.db.run('UPDATE org_alerts SET escalated_at = ? WHERE id = ?', at.toISOString(), row.id);
          this.record(row.id, 'escalated', `Nobody acknowledged it within ${Math.min(...due.map((r) => r.escalateAfterMinutes))} minutes: the next people are told`);
          this.route(this.raw(row.id)!, 'escalation', { rules: due });
          const view = this.get(row.id)!;
          this.d.webhook(row.tenant_id, 'alert.escalated', { alert: view.alert, id: row.id });
          this.changed(view);
        }
      }
    }
    const gone = this.d.db.run("DELETE FROM org_alerts WHERE state != 'open' AND updated_at < ?", new Date(at.getTime() - KEEP_DAYS * 86_400_000).toISOString());
    if (gone.changes) this.d.db.run('DELETE FROM org_alert_timeline WHERE alert_id NOT IN (SELECT id FROM org_alerts)');
  }

  // ------------------------------------------------------------------------------------------- the report

  /** One line of an alert's incident report. */
  private record(id: string, kind: OrgAlertEvent['kind'], text: string, at = this.now().toISOString()): void {
    // In UTC, so the lines sort by time whatever offset the sender wrote.
    this.d.db.run('INSERT INTO org_alert_timeline (alert_id, at, kind, text) VALUES (?,?,?,?)', id, new Date(at).toISOString(), kind, text.slice(0, 600));
  }

  /** Said again: one line, kept up to date ("Said again: 12 times"), so a chatty problem stays readable. */
  private repeated(id: string, count: number): void {
    const last = this.d.db.get<{ id: number; kind: string }>('SELECT id, kind FROM org_alert_timeline WHERE alert_id = ? ORDER BY id DESC LIMIT 1', id);
    const text = `Said again: ${count} times so far`;
    if (last?.kind === 'repeated') this.d.db.run('UPDATE org_alert_timeline SET at = ?, text = ? WHERE id = ?', this.now().toISOString(), text, last.id);
    else this.record(id, 'repeated', text);
  }

  /** The steps the sender told (a takeover's), each once. */
  private steps(id: string, alert: FbrxAlert): void {
    for (const s of alert.steps ?? []) {
      const seen = this.d.db.get('SELECT 1 FROM org_alert_timeline WHERE alert_id = ? AND kind = ? AND at = ? AND text = ?', id, 'step', new Date(s.at).toISOString(), s.text.slice(0, 600));
      if (!seen) this.record(id, 'step', s.text, s.at);
    }
  }

  /** The incident report of one alert. */
  report(id: string): OrgAlertReport | null {
    const row = this.get(id);
    if (!row) return null;
    const timeline = this.d.db.all<OrgAlertEvent>('SELECT at, kind, text FROM org_alert_timeline WHERE alert_id = ? ORDER BY at, id', id);
    const a = row.alert;
    const start = Date.parse(a.startedAt);
    const lastedMs = a.state === 'resolved' && a.endedAt ? Math.max(0, Date.parse(a.endedAt) - start) : null;
    const acknowledgedAfterMs = row.acknowledged ? Math.max(0, Date.parse(row.acknowledged.at) - start) : null;
    const where = [row.deviceName ?? a.source.computer ?? a.source.host, a.source.role].filter(Boolean).join(' · ');
    const mins = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} seconds` : ms < 7_200_000 ? `${Math.round(ms / 60_000)} minutes` : `${(ms / 3_600_000).toFixed(1)} hours`);
    const markdown = [
      `# Incident report: ${a.title}`,
      '',
      `* **Where:** ${where}`,
      `* **How bad:** ${a.severity}`,
      `* **Started:** ${a.startedAt}`,
      a.state === 'resolved' ? `* **All clear:** ${a.endedAt ?? ''}${lastedMs != null ? ` (it lasted ${mins(lastedMs)})` : ''}` : a.state === 'open' ? '* **Still going on**' : '* **Happened once**',
      row.acknowledged ? `* **Acknowledged:** by ${row.acknowledged.by}${acknowledgedAfterMs != null ? `, ${mins(acknowledgedAfterMs)} after it started` : ''}${row.acknowledged.note ? ` (${row.acknowledged.note})` : ''}` : '* **Acknowledged:** not yet',
      ...(a.detail ? ['', a.detail] : []),
      ...(a.done ? ['', `**What was already done:** ${a.done}`] : []),
      ...(a.yours ? ['', `**What was left to do:** ${a.yours}`] : []),
      '',
      '## Timeline',
      '',
      ...timeline.map((e) => `* ${e.at}: ${e.text}`),
      '',
    ].join('\n');
    return { row, timeline, lastedMs, acknowledgedAfterMs, markdown };
  }

  // ------------------------------------------------------------------------------------------- delivering

  private raw(id: string): Row | undefined {
    return this.d.db.get<Row>('SELECT * FROM org_alerts WHERE id = ?', id);
  }

  private view(r: Row): OrgAlertRow {
    const device = r.device_id ? this.d.db.get<{ name: string }>('SELECT name FROM devices WHERE id = ?', r.device_id) : undefined;
    return {
      id: r.id,
      alert: json<FbrxAlert>(r.alert, {} as FbrxAlert),
      deviceId: r.device_id,
      deviceName: device?.name ?? null,
      count: Number(r.count),
      acknowledged: r.acknowledged_at ? { by: r.acknowledged_by ?? 'someone', at: r.acknowledged_at, note: r.ack_note } : null,
      escalatedAt: r.escalated_at,
      notified: json<string[]>(r.notified, []),
    };
  }

  private changed(view: OrgAlertRow): OrgAlertRow {
    const tenantId = this.tenantOf(view.id);
    if (tenantId) this.d.emitAdmin({ type: 'alert.updated', tenantId, alert: view });
    return view;
  }

  /** The rules that take this alert: from its severity up, from its app, about a computer with one of their tags. */
  private matching(row: Row): OrgAlertRule[] {
    const alert = json<FbrxAlert>(row.alert, {} as FbrxAlert);
    const tags = row.device_id ? json<string[]>(this.d.db.get<{ tags: string }>('SELECT tags FROM devices WHERE id = ?', row.device_id)?.tags ?? '[]', []) : [];
    return this.rules(row.tenant_id).filter(
      (r) => r.enabled && RANK[row.severity] >= RANK[r.min] && (!r.apps.length || r.apps.includes(alert.source?.app)) && (!r.tags.length || r.tags.some((t) => tags.includes(t))),
    );
  }

  private rulesFor(row: Row): OrgAlertRule[] {
    const ids = json<string[]>(row.rules, []);
    return this.rules(row.tenant_id).filter((r) => ids.includes(r.id));
  }

  private devicesFor(tenantId: string, tags: string[], helpdesk: boolean): Array<{ id: string; name: string }> {
    if (!tags.length && !helpdesk) return [];
    return this.d.db
      .all<{ id: string; name: string; tags: string; helpdesk_receiver: number }>("SELECT id, name, tags, helpdesk_receiver FROM devices WHERE tenant_id = ? AND status = 'active'", tenantId)
      .filter((d) => (helpdesk && Number(d.helpdesk_receiver) === 1) || json<string[]>(d.tags, []).some((t) => tags.includes(t)));
  }

  private sendTo(deviceId: string, view: OrgAlertRow): boolean {
    return this.d.sendToDevice(deviceId, { type: 'org.alert', alertId: view.id, alert: view.alert, acknowledged: view.acknowledged ? { by: view.acknowledged.by, at: view.acknowledged.at } : null });
  }

  /**
   * Tells the people the rules name: first (alert), or the next people (escalation). Quiet hours hold all but critical
   * alerts (they go out when the hours are over, if it is still going on). Nobody hears the same alert twice.
   */
  private route(row: Row, kind: 'alert' | 'escalation', o: { again?: boolean; fresh?: boolean; rules?: OrgAlertRule[] } = {}): void {
    const at = this.now();
    const rules = o.rules ?? this.matching(row);
    if (kind === 'alert' && !o.again) this.d.db.run('UPDATE org_alerts SET rules = ? WHERE id = ?', JSON.stringify(rules.map((r) => r.id)), row.id);
    const targets = targetsOf(row.targets);
    const notified = json<string[]>(row.notified, []);
    const view = this.view(row);
    const text = fbrxAlertText(view.alert);
    const prefix = kind === 'escalation' ? '[Not acknowledged] ' : '';
    let held = false;
    // Said again because it got worse: everyone hears it again. Otherwise nobody hears it twice.
    const seenEmails = new Set(o.fresh ? [] : targets.emails);
    const seenDevices = new Set(o.fresh ? [] : targets.devices);
    for (const r of rules) {
      if (inQuietHours(r.quiet, at) && row.severity !== 'critical') {
        held = true;
        if (!notified.includes(`held for quiet hours (${r.name})`)) {
          notified.push(`held for quiet hours (${r.name})`);
          this.record(row.id, 'held', `Held for quiet hours (${r.name})`);
        }
        continue;
      }
      const emails = kind === 'escalation' ? r.escalateEmails : r.emails;
      const devices = kind === 'escalation' ? this.devicesFor(row.tenant_id, r.escalateComputerTags, false) : this.devicesFor(row.tenant_id, r.computerTags, r.helpdeskComputers);
      for (const to of emails) {
        if (seenEmails.has(to.toLowerCase())) continue;
        seenEmails.add(to.toLowerCase());
        if (!targets.emails.includes(to.toLowerCase())) targets.emails.push(to.toLowerCase());
        notified.push(`${kind === 'escalation' ? 'escalated to ' : ''}e-mail ${to}`);
        this.record(row.id, 'told', `${kind === 'escalation' ? 'Escalated to ' : 'Told '}${to} by e-mail${o.fresh ? ' (again: it got worse)' : ''}`);
        void this.d.mail(to, `${prefix}${text.subject}`, text.text).catch((err: Error) => this.note(row.id, `e-mail ${to} failed: ${err.message}`));
      }
      for (const dev of devices) {
        if (seenDevices.has(dev.id)) continue;
        seenDevices.add(dev.id);
        if (!targets.devices.includes(dev.id)) targets.devices.push(dev.id);
        const online = this.sendTo(dev.id, view);
        notified.push(`${kind === 'escalation' ? 'escalated to ' : ''}FBRX OS on ${dev.name}${online ? '' : ' (when it is next online)'}`);
        this.record(row.id, 'told', `${kind === 'escalation' ? 'Escalated to ' : 'Shown in '}FBRX OS on ${dev.name}${online ? '' : ' (when it is next online)'}${o.fresh ? ' (again: it got worse)' : ''}`);
      }
    }
    this.d.db.run('UPDATE org_alerts SET targets = ?, notified = ?, held = ? WHERE id = ?', JSON.stringify(targets), JSON.stringify(notified.slice(-60)), held ? 1 : 0, row.id);
  }

  /** The all-clear goes wherever its alert went. */
  private allClear(view: OrgAlertRow, targets: Targets): void {
    const text = fbrxAlertText(view.alert);
    for (const to of targets.emails) void this.d.mail(to, text.subject, text.text).catch((err: Error) => this.note(view.id, `all-clear e-mail ${to} failed: ${err.message}`));
    for (const deviceId of targets.devices) this.sendTo(deviceId, view);
  }

  private note(id: string, line: string): void {
    const row = this.raw(id);
    if (!row) return;
    this.d.db.run('UPDATE org_alerts SET notified = ? WHERE id = ?', JSON.stringify([...json<string[]>(row.notified, []), line].slice(-60)), id);
    this.record(id, 'failed', line.charAt(0).toUpperCase() + line.slice(1));
    this.d.log('Alert delivery failed', { id, line });
  }
}

/** An alert FBRX Command raises itself about a computer (a service that failed, and its all-clear when it runs again). */
export function commandAlert(o: { device: { id: string; name: string }; rule: string; subject: string; state: FbrxAlert['state']; severity: FbrxAlert['severity']; title: string; detail?: string; startedAt?: string }): FbrxAlert {
  const now = new Date().toISOString();
  return {
    v: 1,
    id: newId('fa'),
    key: fbrxAlertKey('fbrx-command', o.device.id, o.rule, o.subject),
    state: o.state,
    severity: o.severity,
    source: { app: 'fbrx-command', host: 'FBRX Command', computer: o.device.name.slice(0, 253) },
    rule: o.rule,
    title: o.title.slice(0, 200),
    ...(o.detail ? { detail: o.detail.slice(0, 2000) } : {}),
    startedAt: o.startedAt ?? now,
    ...(o.state === 'resolved' ? { endedAt: now } : {}),
    sentAt: now,
  };
}

/** An alert from an FBRX OS older than 2.6.0 (a line of text), as an FBRX Alert: something that happened once. */
export function legacyDeviceAlert(device: { id: string; name: string; hostname?: string | null }, ev: { severity: FbrxAlert['severity']; message: string; data?: unknown; at: string }): FbrxAlert {
  const ruleId = typeof (ev.data as { ruleId?: unknown } | null)?.ruleId === 'string' ? String((ev.data as { ruleId: string }).ruleId).slice(0, 64) : 'alert';
  const at = Number.isNaN(Date.parse(ev.at)) ? new Date().toISOString() : ev.at;
  const [title, ...rest] = ev.message.split(': ');
  return {
    v: 1,
    id: newId('fa'),
    key: fbrxAlertKey('fbrx-os', device.id, ruleId, at),
    state: 'event',
    severity: ev.severity,
    source: { app: 'fbrx-os', host: (device.hostname || device.name).slice(0, 253) || 'computer', computer: device.name.slice(0, 253) },
    rule: ruleId,
    title: (title || ruleId).slice(0, 200),
    ...(rest.length ? { detail: rest.join(': ').slice(0, 2000) } : {}),
    startedAt: at,
    sentAt: at,
  };
}
