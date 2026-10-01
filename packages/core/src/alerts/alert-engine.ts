import { hostname } from 'node:os';
import si from 'systeminformation';
import nodemailer from 'nodemailer';
import { newId, type AlertChannel, type AlertItem, type AlertRuleInfo, type AlertSeverity, type Settings } from '@fbrx/shared';
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
];

export interface AlertEngineDeps {
  db: Db;
  events: EventBus;
  log: Logger;
  settings: () => Settings;
  monitor: SystemMonitor;
  workspace: WorkspaceStore;
  notify: (title: string, body: string, level: 'info' | 'warning' | 'error') => void;
  /** Pushes an alert to paired phones; returns how many received it. */
  toMobile: (alert: AlertItem) => number;
  /** Forwards an alert to the organisation's control plane; false when not enrolled. */
  toOrganisation: (alert: AlertItem) => boolean;
  secret: (name: string) => string | undefined;
  meshPeers: () => Array<{ id: string; name: string; online: boolean }>;
}

/**
 * Background alert rules with an inbox and delivery to the desktop, phones, the organisation's control plane,
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

  constructor(private readonly d: AlertEngineDeps) {}

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
    return ALERT_RULES.map((r) => ({
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

  markRead(id: string): void {
    if (id === '*') this.d.db.run('UPDATE alerts SET read = 1 WHERE read = 0');
    else this.d.db.run('UPDATE alerts SET read = 1 WHERE id = ?', id);
    this.d.events.emit('alerts.changed', this.counts());
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
  async fire(ruleId: string, title: string, body: string, o: { key?: string; severity?: AlertSeverity; force?: boolean } = {}): Promise<AlertItem | null> {
    const rule = this.rule(ruleId);
    const cfg = this.d.settings().alerts;
    if (!o.force && (!rule || !rule.enabled)) return null;
    const k = `${ruleId}:${o.key ?? ''}`;
    const prev = this.last.get(k);
    if (!o.force && prev && Date.now() - prev < cfg.cooldownMinutes * 60_000) return null;
    this.last.set(k, Date.now());
    const severity = o.severity ?? rule?.severity ?? 'info';
    const alert: AlertItem = { id: newId('alrt'), ruleId, severity, title: title.slice(0, 200), body: body.slice(0, 2000), createdAt: new Date().toISOString(), read: false, deliveries: {} };
    this.d.db.run(
      'INSERT INTO alerts (id, rule_id, severity, title, body, created_at, read, deliveries) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
      alert.id,
      ruleId,
      severity,
      alert.title,
      alert.body,
      alert.createdAt,
      '{}',
    );
    this.d.db.run("DELETE FROM alerts WHERE id NOT IN (SELECT id FROM alerts ORDER BY created_at DESC LIMIT 1000)");
    alert.deliveries = await this.deliver(alert, new Set(cfg.routing[severity]));
    this.d.db.run('UPDATE alerts SET deliveries = ? WHERE id = ?', JSON.stringify(alert.deliveries), alert.id);
    this.d.events.emit('alerts.new', alert);
    this.d.events.emit('alerts.changed', this.counts());
    return alert;
  }

  private async deliver(a: AlertItem, routes: Set<AlertChannel>): Promise<AlertItem['deliveries']> {
    const ch = this.d.settings().alerts.channels;
    const quiet = this.inQuietHours() && a.severity !== 'critical';
    const out: AlertItem['deliveries'] = { inbox: 'ok' };
    const attempt = async (c: AlertChannel, fn: () => Promise<string> | string) => {
      try {
        out[c] = await fn();
      } catch (err) {
        out[c] = errorMessage(err);
      }
    };
    if (routes.has('desktop') && ch.desktop) {
      if (quiet) out.desktop = 'held (quiet hours)';
      else await attempt('desktop', () => (this.d.notify(a.title, a.body, a.severity === 'critical' ? 'error' : a.severity === 'warning' ? 'warning' : 'info'), 'ok'));
    }
    if (routes.has('mobile') && ch.mobile) await attempt('mobile', () => `${this.d.toMobile(a)} device(s)`);
    if (routes.has('organisation') && ch.organisation) await attempt('organisation', () => (this.d.toOrganisation(a) ? 'ok' : 'not enrolled'));
    if (routes.has('webhook') && ch.webhook.enabled && ch.webhook.url) await attempt('webhook', () => this.sendWebhook(a));
    if (routes.has('email') && ch.email.enabled) {
      if (quiet) out.email = 'held (quiet hours)';
      else await attempt('email', () => this.sendEmail(a));
    }
    return out;
  }

  async sendWebhook(a: AlertItem): Promise<string> {
    const w = this.d.settings().alerts.channels.webhook;
    if (!/^https?:\/\//i.test(w.url)) throw new CoreError('INVALID_ARGUMENT', 'Webhook URL must start with https://');
    let body: string;
    let headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const device = hostname();
    if (w.format === 'discord') body = JSON.stringify({ username: 'FBRX OS', content: `**${a.title}**\n${a.body}\n_${device}_` });
    else if (w.format === 'slack') body = JSON.stringify({ text: `*${a.title}*\n${a.body}\n_${device}_` });
    else if (w.format === 'teams') body = JSON.stringify({ text: `**${a.title}**  \n${a.body}  \n_${device}_` });
    else if (w.format === 'ntfy') {
      body = a.body;
      headers = { Title: a.title.replace(/[^\x20-\x7e]/g, ''), Priority: a.severity === 'critical' ? 'urgent' : a.severity === 'warning' ? 'high' : 'default', Tags: 'computer' };
    } else body = JSON.stringify({ source: 'fbrx-os', device, ...a });
    const r = await fetch(w.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`Webhook HTTP ${r.status}`);
    return 'ok';
  }

  async sendEmail(a: AlertItem): Promise<string> {
    const e = this.d.settings().alerts.channels.email;
    if (!e.host || !e.to) throw new CoreError('INVALID_ARGUMENT', 'Set the SMTP server and recipient first');
    const pass = e.user ? this.d.secret(e.passwordSecret) : undefined;
    if (e.user && !pass) throw new CoreError('NOT_FOUND', `Save the SMTP password in Credentials as ${e.passwordSecret}`);
    const t = nodemailer.createTransport({ host: e.host, port: e.port, secure: e.secure, auth: e.user ? { user: e.user, pass } : undefined, connectionTimeout: 15_000 });
    await t.sendMail({
      from: e.from || e.user,
      to: e.to,
      subject: `[FBRX ${a.severity.toUpperCase()}] ${a.title}`,
      text: `${a.body}\n\n— FBRX OS on ${hostname()} at ${new Date(a.createdAt).toLocaleString()}`,
    });
    return 'ok';
  }

  async test(channel: AlertChannel): Promise<{ ok: boolean; result: string }> {
    const a: AlertItem = {
      id: newId('alrt'),
      ruleId: 'test',
      severity: 'info',
      title: 'Test alert from FBRX OS',
      body: `If you can read this, ${channel} alerts work.`,
      createdAt: new Date().toISOString(),
      read: false,
      deliveries: {},
    };
    try {
      let result = 'ok';
      if (channel === 'webhook') result = await this.sendWebhook(a);
      else if (channel === 'email') result = await this.sendEmail(a);
      else if (channel === 'desktop') this.d.notify(a.title, a.body, 'info');
      else if (channel === 'mobile') result = `${this.d.toMobile(a)} device(s) reached`;
      else if (channel === 'organisation') result = this.d.toOrganisation(a) ? 'sent to the control plane' : 'this device is not enrolled';
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
    const m = this.d.monitor;
    const cpu = m.average('cpu', 300);
    if (cpu != null && cpu > (rules.cpu_high.threshold ?? 90)) void this.fire('cpu_high', 'CPU has been very busy', `Average CPU load ${cpu.toFixed(0)}% over the last 5 minutes. Open Processes to see what is using it.`);
    const mem = m.average('mem', 300);
    if (mem != null && mem > (rules.mem_high.threshold ?? 92)) void this.fire('mem_high', 'Memory is almost full', `${mem.toFixed(0)}% of memory in use over the last 5 minutes.`);
    const cur = m.current;
    if (cur?.tempC && cur.tempC > (rules.temp_high.threshold ?? 90)) void this.fire('temp_high', 'Processor is running hot', `CPU temperature is ${cur.tempC} °C. Check the fans and airflow.`);
    if (cur?.battery && !cur.battery.charging && cur.battery.percent <= (rules.battery_low.threshold ?? 15)) {
      void this.fire('battery_low', 'Battery is low', `${cur.battery.percent}% remaining and not charging.`);
    }
    if (this.ticks % 4 === 1) await this.diskCheck(rules.disk_low.threshold ?? 10);
    await this.connectivityCheck();
    for (const p of this.d.meshPeers()) {
      const prev = this.peerState.get(p.id);
      this.peerState.set(p.id, p.online);
      if (prev === true && !p.online) void this.fire('mesh_offline', `${p.name} went offline`, `${p.name} stopped responding on your mesh.`, { key: p.id });
      if (prev === false && p.online) void this.fire('mesh_online', `${p.name} is online`, `${p.name} is reachable again.`, { key: p.id });
    }
    if (this.ticks % 20 === 2) this.taskCheck();
    if (IS_WIN && this.ticks % 10 === 1) await this.windowsChecks(rules.signatures_old.threshold ?? 3).catch(() => undefined);
  }

  private async diskCheck(threshold: number) {
    const fsz = await si.fsSize().catch(() => []);
    for (const d of fsz) {
      if (!d.size || d.size < 2e9 || /^\/(snap|boot|run|dev|sys|proc)/.test(d.mount)) continue;
      const free = (d.available / d.size) * 100;
      if (free < threshold) void this.fire('disk_low', `Drive ${d.mount} is running out of space`, `${(d.available / 1e9).toFixed(1)} GB free (${free.toFixed(0)}%). Open Storage to clean up.`, { key: d.mount });
    }
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
        void this.fire('net_down', 'Internet connection lost', 'FBRX OS cannot reach the internet. Open Network Center to troubleshoot.');
      }
    } else {
      if (this.netDown) {
        const mins = Math.max(1, Math.round((Date.now() - this.downSince) / 60_000));
        void this.fire('net_restored', 'Internet connection restored', `Back online after about ${mins} minute(s).`);
      }
      this.netFails = 0;
      this.netDown = false;
    }
  }

  private taskCheck() {
    const today = new Date().toISOString().slice(0, 10);
    for (const t of this.d.workspace.dueSoon(0)) {
      const due = (t.due ?? '').slice(0, 10);
      void this.fire('task_due', due < today ? `Overdue: ${t.title}` : `Due today: ${t.title}`, `Priority ${t.priority}.`, { key: `${t.id}:${today}` });
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
    let j: any;
    try {
      j = JSON.parse(r.out.trim());
    } catch {
      return;
    }
    this.lastCrash = new Date().toISOString();
    if (j.av === true && j.rtp === false) void this.fire('defender_off', 'Real-time protection is off', 'Microsoft Defender real-time protection is disabled. Turn it back on in Security.');
    if (typeof j.sigAge === 'number' && j.sigAge > sigDays) void this.fire('signatures_old', 'Virus definitions are out of date', `Definitions are ${j.sigAge} days old. Open Security → Update definitions.`);
    if (j.threat) {
      if (this.lastThreat && j.threat.time > this.lastThreat) void this.fire('defender_threat', 'Microsoft Defender detected a threat', `${j.threat.res || 'A threat'} was detected. Open Security → Threats for details.`, { key: j.threat.time });
      this.lastThreat = j.threat.time;
    } else this.lastThreat ??= '0';
    for (const name of [].concat(j.firewall ?? [])) void this.fire('firewall_off', `Firewall is off (${name} profile)`, 'Turn Windows Firewall back on in Security → Firewall.', { key: name });
    for (const p of [].concat(j.printers ?? []) as Array<{ name: string; status: string }>) void this.fire('printer_error', `Printer "${p.name}" needs attention`, `Status: ${p.status}. Open Network Center → Printers.`, { key: p.name });
    for (const c of [].concat(j.crashes ?? []) as Array<{ app: string; time: string }>) void this.fire('crash', `${c.app} crashed`, 'Open Bug catcher to investigate with Fabric.', { key: c.time });
    if (j.bsod) void this.fire('crash', 'Windows recovered from a stop error (blue screen)', 'Open Bug catcher for the crash details.', { key: 'bsod', severity: 'critical' });
  }
}

function toAlert(r: any): AlertItem {
  let deliveries = {};
  try {
    deliveries = JSON.parse(r.deliveries);
  } catch {
    /* ignore */
  }
  return { id: r.id, ruleId: r.rule_id, severity: r.severity, title: r.title, body: r.body, createdAt: r.created_at, read: !!r.read, deliveries };
}
