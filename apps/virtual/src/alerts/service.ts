import { statSync, statfsSync } from 'node:fs';
import nodemailer from 'nodemailer';
import { ALERT_SEVERITIES, fbrxAlertKey, fbrxAlertText, newId, type FbrxAlert, type ServerAlertChannel, type ServerAlertRow, type ServerAlertSettings, type ServerAlertsList } from '@fbrx/shared';
import { openString, postFbrxAlert, sealString, sendFbrxAlertSyslog, type Db } from '@fbrx/shared/node';

/**
 * FBRX Server's alerts (FBRX Alert v1): what goes wrong on the server and its roles (its drives, FBRX Time, Gate,
 * MiniDome) is said once to e-mail, a signed webhook and syslog, each from the severity you choose, then its all-clear
 * when it is over, to the places that heard about it. The console's Alerts page lists what is going on and what was.
 */

type Severity = FbrxAlert['severity'];
const KEY = 'alerts.settings';
const RANK = (s: Severity) => ALERT_SEVERITIES.indexOf(s);
const KEEP = 500;
const DISK_EVERY_MS = 5 * 60_000;
const GATE_EVERY_MS = 60_000;
/** Problems the gate reports that are no problem (a simulated gate says it changes nothing). */
const QUIET_GATE = /^Simulated gate/;

interface Stored {
  email: Omit<ServerAlertSettings['email'], 'passwordSet'> & { password: string | null };
  webhook: Omit<ServerAlertSettings['webhook'], 'secretSet'> & { secret: string | null };
  syslog: ServerAlertSettings['syslog'];
}

const DEFAULTS: Stored = {
  email: { enabled: false, min: 'warning', host: '', port: 587, secure: false, user: '', from: '', to: '', password: null },
  webhook: { enabled: false, min: 'info', url: '', secret: null },
  syslog: { enabled: false, min: 'info', host: '', port: 514, protocol: 'udp' },
};

/** What a role says went wrong (or happened). */
export interface AlertInput {
  rule: string;
  /** What it is about (a drive, a backup job, a device), so each has its own alert. */
  subject?: string;
  role?: string;
  severity: Severity;
  title: string;
  detail?: string;
  done?: string;
  yours?: string;
}

export interface ServerAlertsOptions {
  db: Db;
  key: Uint8Array;
  host: string;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Folders whose drives are watched for space (the data and images folders). */
  dirs?: string[];
  /** The gate's own list of what is wrong, when this server is a gate. */
  gateProblems?: () => Promise<string[]>;
  /** For tests: how full a folder's drive is. */
  space?: (dir: string) => { freePct: number; freeBytes: number; device: string } | null;
}

interface Row {
  id: string;
  key: string;
  state: FbrxAlert['state'];
  severity: Severity;
  rule: string;
  subject: string | null;
  role: string | null;
  title: string;
  detail: string | null;
  done: string | null;
  yours: string | null;
  started_at: string;
  ended_at: string | null;
  deliveries: string;
  cleared: string;
}

function driveSpace(dir: string): { freePct: number; freeBytes: number; device: string } | null {
  try {
    const s = statfsSync(dir);
    const total = s.blocks * s.bsize;
    if (!total) return null;
    return { freePct: (s.bavail / s.blocks) * 100, freeBytes: s.bavail * s.bsize, device: String(statSync(dir).dev) };
  } catch {
    return null;
  }
}

const gb = (b: number) => `${(b / 1e9).toFixed(1)} GB`;

export class ServerAlerts {
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly o: ServerAlertsOptions) {
    o.db.exec(`CREATE TABLE IF NOT EXISTS server_alerts (
      id TEXT PRIMARY KEY, key TEXT NOT NULL, state TEXT NOT NULL, severity TEXT NOT NULL, rule TEXT NOT NULL,
      subject TEXT, role TEXT, title TEXT NOT NULL, detail TEXT, done TEXT, yours TEXT,
      started_at TEXT NOT NULL, ended_at TEXT, deliveries TEXT NOT NULL DEFAULT '{}', cleared TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS server_alerts_key ON server_alerts (key, state);`);
  }

  start(): void {
    const every = (ms: number, fn: () => Promise<void>) => {
      const run = () => void fn().catch((e) => this.o.log('warn', `Alerts: a check failed: ${(e as Error).message}`));
      const t = setInterval(run, ms);
      t.unref?.();
      this.timers.push(t);
      const first = setTimeout(run, 15_000);
      first.unref?.();
      this.timers.push(first);
    };
    if (this.o.dirs?.length) every(DISK_EVERY_MS, () => this.checkDisks());
    if (this.o.gateProblems) every(GATE_EVERY_MS, () => this.checkGate());
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  // ------------------------------------------------------------------------------------------ settings

  private stored(): Stored {
    const r = this.o.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', KEY);
    if (!r) return structuredClone(DEFAULTS);
    try {
      const s = JSON.parse(r.value) as Partial<Stored>;
      return { email: { ...DEFAULTS.email, ...s.email }, webhook: { ...DEFAULTS.webhook, ...s.webhook }, syslog: { ...DEFAULTS.syslog, ...s.syslog } };
    } catch {
      return structuredClone(DEFAULTS);
    }
  }

  settings(): ServerAlertSettings {
    const s = this.stored();
    const { password, ...email } = s.email;
    const { secret, ...webhook } = s.webhook;
    return { email: { ...email, passwordSet: !!password }, webhook: { ...webhook, secretSet: !!secret }, syslog: s.syslog };
  }

  /**
   * Changes where alerts go. A password or secret is kept unless a new one is given ('' removes it); both are kept
   * sealed with the server's key and never shown again.
   */
  setSettings(i: { email?: Partial<Omit<ServerAlertSettings['email'], 'passwordSet'>> & { password?: string }; webhook?: Partial<Omit<ServerAlertSettings['webhook'], 'secretSet'>> & { secret?: string }; syslog?: Partial<ServerAlertSettings['syslog']> }): ServerAlertSettings {
    const s = this.stored();
    if (i.email) {
      const { password, ...rest } = i.email;
      s.email = { ...s.email, ...rest, password: password === undefined ? s.email.password : password ? sealString(this.o.key, password, 'alerts.email') : null };
    }
    if (i.webhook) {
      const { secret, ...rest } = i.webhook;
      if (rest.url !== undefined && rest.url && !/^https?:\/\//i.test(rest.url)) throw new Error('The webhook address must start with https://');
      s.webhook = { ...s.webhook, ...rest, secret: secret === undefined ? s.webhook.secret : secret ? sealString(this.o.key, secret, 'alerts.webhook') : null };
    }
    if (i.syslog) s.syslog = { ...s.syslog, ...i.syslog };
    this.o.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', KEY, JSON.stringify(s));
    return this.settings();
  }

  // ------------------------------------------------------------------------------------------- raising

  private keyOf(rule: string, subject?: string | null) {
    return fbrxAlertKey('fbrx-server', this.o.host, rule, subject);
  }

  private v1(r: Row, state: FbrxAlert['state'] = r.state): FbrxAlert {
    return {
      v: 1,
      id: r.id,
      key: r.key,
      state,
      severity: r.severity,
      source: { app: 'fbrx-server', host: this.o.host, ...(r.role ? { role: r.role } : {}) },
      rule: r.rule,
      title: r.title,
      ...(r.detail ? { detail: r.detail } : {}),
      ...(r.done ? { done: r.done } : {}),
      ...(r.yours ? { yours: r.yours } : {}),
      startedAt: r.started_at,
      ...(r.ended_at ? { endedAt: r.ended_at } : {}),
      sentAt: new Date().toISOString(),
    };
  }

  private openRow(key: string): Row | null {
    return this.o.db.get<Row>("SELECT * FROM server_alerts WHERE key = ? AND state = 'open'", key) ?? null;
  }

  private insert(i: AlertInput, state: 'open' | 'event'): Row {
    const r: Row = {
      id: newId('alrt'),
      key: this.keyOf(i.rule, i.subject),
      state,
      severity: i.severity,
      rule: i.rule,
      subject: i.subject ?? null,
      role: i.role ?? null,
      title: i.title.slice(0, 200),
      detail: i.detail?.slice(0, 2000) ?? null,
      done: i.done?.slice(0, 1000) ?? null,
      yours: i.yours?.slice(0, 1000) ?? null,
      started_at: new Date().toISOString(),
      ended_at: null,
      deliveries: '{}',
      cleared: '{}',
    };
    this.o.db.run(
      'INSERT INTO server_alerts (id, key, state, severity, rule, subject, role, title, detail, done, yours, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      r.id, r.key, r.state, r.severity, r.rule, r.subject, r.role, r.title, r.detail, r.done, r.yours, r.started_at,
    );
    this.o.db.run(`DELETE FROM server_alerts WHERE state != 'open' AND id NOT IN (SELECT id FROM server_alerts WHERE state != 'open' ORDER BY started_at DESC LIMIT ${KEEP})`);
    return r;
  }

  /** A problem that lasts until it is over: said once, however often it is raised, until it is cleared. */
  async raise(i: AlertInput): Promise<FbrxAlert | null> {
    if (this.openRow(this.keyOf(i.rule, i.subject))) return null;
    const r = this.insert(i, 'open');
    await this.deliver(r, 'deliveries', this.channelsFor(r.severity));
    return this.v1(r);
  }

  /** Something that happened once (a threat seen, a check that failed): no all-clear to come. */
  async event(i: AlertInput): Promise<FbrxAlert> {
    const r = this.insert(i, 'event');
    await this.deliver(r, 'deliveries', this.channelsFor(r.severity));
    return this.v1(r);
  }

  /** The problem is over: its all-clear goes to the channels that took its alert. False when it was not open. */
  async clear(rule: string, subject?: string | null): Promise<boolean> {
    const r = this.openRow(this.keyOf(rule, subject));
    if (!r) return false;
    r.state = 'resolved';
    r.ended_at = new Date().toISOString();
    this.o.db.run("UPDATE server_alerts SET state = 'resolved', ended_at = ? WHERE id = ?", r.ended_at, r.id);
    const told = Object.entries(JSON.parse(r.deliveries) as Record<string, string>)
      .filter(([, v]) => v === 'ok')
      .map(([c]) => c as ServerAlertChannel);
    await this.deliver(r, 'cleared', told);
    return true;
  }

  /** Of a rule's open problems, the ones not about these subjects are over. */
  async settle(rule: string, keep: string[]): Promise<number> {
    const open = this.o.db.all<{ subject: string | null }>("SELECT subject FROM server_alerts WHERE rule = ? AND state = 'open'", rule);
    let n = 0;
    for (const o of open) if (!keep.includes(o.subject ?? '') && (await this.clear(rule, o.subject))) n++;
    return n;
  }

  list(limit = 60): ServerAlertsList {
    const row = (r: Row): ServerAlertRow => ({ alert: this.v1(r), deliveries: JSON.parse(r.deliveries), cleared: JSON.parse(r.cleared) });
    return {
      open: this.o.db.all<Row>("SELECT * FROM server_alerts WHERE state = 'open' ORDER BY started_at DESC").map(row),
      recent: this.o.db.all<Row>("SELECT * FROM server_alerts WHERE state != 'open' ORDER BY COALESCE(ended_at, started_at) DESC LIMIT ?", Math.min(limit, 200)).map(row),
    };
  }

  // ------------------------------------------------------------------------------------------ delivery

  private channelsFor(severity: Severity): ServerAlertChannel[] {
    const s = this.stored();
    const on = (c: { enabled: boolean; min: Severity }) => c.enabled && RANK(severity) >= RANK(c.min);
    return [...(on(s.email) && s.email.host && s.email.to ? (['email'] as const) : []), ...(on(s.webhook) && s.webhook.url ? (['webhook'] as const) : []), ...(on(s.syslog) && s.syslog.host ? (['syslog'] as const) : [])];
  }

  private async deliver(r: Row, column: 'deliveries' | 'cleared', channels: ServerAlertChannel[]): Promise<void> {
    if (!channels.length) return;
    const v = this.v1(r);
    const out: Partial<Record<ServerAlertChannel, string>> = {};
    await Promise.all(
      channels.map(async (c) => {
        try {
          await this.send(c, v);
          out[c] = 'ok';
        } catch (e) {
          out[c] = (e as Error).message.slice(0, 300);
          this.o.log('warn', `Alerts: ${c} did not take "${v.title}": ${out[c]}`);
        }
      }),
    );
    try {
      this.o.db.run(`UPDATE server_alerts SET ${column} = ? WHERE id = ?`, JSON.stringify(out), r.id);
    } catch {
      /* the server is shutting down */
    }
  }

  private async send(c: ServerAlertChannel, v: FbrxAlert): Promise<void> {
    const s = this.stored();
    if (c === 'webhook') {
      const secret = s.webhook.secret ? openString(this.o.key, s.webhook.secret, 'alerts.webhook') : undefined;
      await postFbrxAlert(s.webhook.url, v, secret, { userAgent: 'FBRX-Alert/1 (fbrx-server)' });
    } else if (c === 'syslog') {
      await sendFbrxAlertSyslog({ host: s.syslog.host.trim(), port: s.syslog.port, protocol: s.syslog.protocol }, v);
    } else {
      const e = s.email;
      const pass = e.password ? openString(this.o.key, e.password, 'alerts.email') : undefined;
      const t = nodemailer.createTransport({ host: e.host, port: e.port, secure: e.secure, auth: e.user ? { user: e.user, pass } : undefined, connectionTimeout: 15_000 });
      const m = fbrxAlertText(v);
      await t.sendMail({ from: e.from || e.user || `FBRX Server <fbrx@${this.o.host}>`, to: e.to, subject: m.subject, text: m.text });
    }
  }

  /** Sends a test alert to one channel, whatever its severity setting. */
  async test(c: ServerAlertChannel): Promise<{ ok: boolean; result: string }> {
    const now = new Date().toISOString();
    const v: FbrxAlert = { v: 1, id: newId('alrt'), key: this.keyOf('test'), state: 'event', severity: 'info', source: { app: 'fbrx-server', host: this.o.host }, rule: 'test', title: 'Test alert from FBRX Server', detail: `If this arrived, ${c} alerts from ${this.o.host} work.`, startedAt: now, sentAt: now };
    try {
      await this.send(c, v);
      return { ok: true, result: 'Sent' };
    } catch (e) {
      return { ok: false, result: (e as Error).message };
    }
  }

  // -------------------------------------------------------------------------------------------- checks

  /** The drives of the data and images folders: a warning under 10% free, critical under 3%, over at 12%. */
  async checkDisks(): Promise<void> {
    const seen = new Map<string, string>();
    for (const dir of this.o.dirs ?? []) {
      const s = (this.o.space ?? driveSpace)(dir);
      if (!s || seen.has(s.device)) continue;
      seen.set(s.device, dir);
      if (s.freePct < 10) {
        const severity: Severity = s.freePct < 3 ? 'critical' : 'warning';
        const open = this.openRow(this.keyOf('disk_low', dir));
        // Worse than when it was said: said again, as critical.
        if (open && open.severity !== severity && severity === 'critical') await this.clear('disk_low', dir);
        await this.raise({ rule: 'disk_low', subject: dir, severity, title: `The drive of ${dir} is running out of space`, detail: `${gb(s.freeBytes)} free (${s.freePct.toFixed(0)}%).`, yours: 'Delete old ISOs, snapshots or FBRX Time images (FBRX Time keeps fewer if you lower Keep), or add a drive.' });
      } else if (s.freePct >= 12) await this.clear('disk_low', dir);
    }
  }

  /** What the gate says is wrong (no internet address, DHCP and DNS down, the firewall not loaded…). */
  async checkGate(): Promise<void> {
    if (!this.o.gateProblems) return;
    const problems = (await this.o.gateProblems()).filter((p) => !QUIET_GATE.test(p));
    const subject = (p: string) => p.slice(0, 120);
    for (const p of problems) {
      const internet = /internet port has no address/i.test(p);
      await this.raise({ rule: 'gate_problem', subject: subject(p), role: 'gate', severity: internet ? 'critical' : 'warning', title: internet ? 'The gate has lost the internet' : `FBRX Gate: ${p.split(':')[0]}`, detail: p, yours: internet ? 'Check the cable or the modem on the internet port, and the internet provider.' : undefined });
    }
    await this.settle('gate_problem', problems.map(subject));
  }
}
