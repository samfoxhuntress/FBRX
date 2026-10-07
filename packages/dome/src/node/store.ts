import { Db, type Migration } from '@fbrx/shared/node';
import { DEFAULT_DOME_SETTINGS, DOME_SEVERITIES, type DomeDevice, type DomeFinding, type DomeKind, type DomeSettings, type DomeSeverity, type DomeSignal, type DomeStatus } from '../types';

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'dome',
    up: `
      CREATE TABLE dome_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        severity TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        ip TEXT,
        mac TEXT,
        name TEXT,
        network TEXT,
        subject TEXT,
        evidence TEXT NOT NULL DEFAULT '[]',
        first_at TEXT NOT NULL,
        last_at TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        notified TEXT
      );
      CREATE INDEX dome_findings_last ON dome_findings (last_at);
      CREATE TABLE dome_devices (
        mac TEXT PRIMARY KEY,
        ip TEXT,
        name TEXT,
        network TEXT,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );
      CREATE TABLE dome_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
];

interface FindingRow {
  id: number;
  key: string;
  kind: string;
  severity: string;
  status: string;
  title: string;
  detail: string;
  ip: string | null;
  mac: string | null;
  name: string | null;
  network: string | null;
  subject: string | null;
  evidence: string;
  first_at: string;
  last_at: string;
  count: number;
  notified: string | null;
}

interface DeviceRow {
  mac: string;
  ip: string | null;
  name: string | null;
  network: string | null;
  first_seen: string;
  last_seen: string;
}

const rank = (s: string) => DOME_SEVERITIES.indexOf(s as DomeSeverity);

const toFinding = (r: FindingRow): DomeFinding => ({
  id: r.id,
  key: r.key,
  kind: r.kind as DomeKind,
  severity: r.severity as DomeSeverity,
  status: r.status as DomeStatus,
  title: r.title,
  detail: r.detail,
  device: { ip: r.ip, mac: r.mac, name: r.name, network: r.network },
  subject: r.subject,
  evidence: JSON.parse(r.evidence) as string[],
  firstAt: r.first_at,
  lastAt: r.last_at,
  count: r.count,
  notified: r.notified,
});

/** MiniDome's own small database: findings (one per key, counted), the devices seen, settings. */
export class DomeStore {
  readonly db: Db;

  constructor(file: string) {
    this.db = new Db(file);
    this.db.migrate(MIGRATIONS);
  }

  close() {
    this.db.close();
  }

  meta<T>(key: string): T | null {
    const r = this.db.get<{ value: string }>('SELECT value FROM dome_meta WHERE key = ?', key);
    return r ? (JSON.parse(r.value) as T) : null;
  }

  setMeta(key: string, value: unknown) {
    this.db.run('INSERT INTO dome_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  }

  settings(): DomeSettings {
    return { ...DEFAULT_DOME_SETTINGS, ...(this.meta<Partial<DomeSettings>>('settings') ?? {}) };
  }

  setSettings(s: DomeSettings) {
    this.setMeta('settings', s);
  }

  /**
   * Records a signal: a new finding, or one more of an existing one (newest evidence first, severity only goes up).
   * A resolved finding that happens again opens again; a muted one is only counted. Returns the finding and
   * whether it is news (new, reopened or worse than before).
   */
  record(s: DomeSignal, device: { name: string | null; network: string | null; mac: string | null }, at = new Date()): { finding: DomeFinding; news: boolean } {
    const now = at.toISOString();
    const old = this.db.get<FindingRow>('SELECT * FROM dome_findings WHERE key = ?', s.key);
    if (!old) {
      const r = this.db.run(
        'INSERT INTO dome_findings (key, kind, severity, status, title, detail, ip, mac, name, network, subject, evidence, first_at, last_at, count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
        s.key,
        s.kind,
        s.severity,
        'open',
        s.title,
        s.detail,
        s.ip,
        s.mac ?? device.mac,
        device.name,
        device.network,
        s.subject,
        JSON.stringify(s.evidence.slice(0, 10)),
        now,
        now,
      );
      return { finding: this.finding(r.lastInsertRowid)!, news: true };
    }
    const worse = rank(s.severity) > rank(old.severity);
    const reopened = old.status === 'resolved';
    const evidence = [...s.evidence, ...(JSON.parse(old.evidence) as string[])].filter((x, i, a) => a.indexOf(x) === i).slice(0, 10);
    this.db.run(
      'UPDATE dome_findings SET severity = ?, status = ?, title = ?, detail = ?, mac = COALESCE(?, mac), name = COALESCE(?, name), network = COALESCE(?, network), evidence = ?, last_at = ?, count = count + 1 WHERE id = ?',
      worse ? s.severity : old.severity,
      reopened ? 'open' : old.status,
      s.title,
      s.detail,
      s.mac ?? device.mac,
      device.name,
      device.network,
      JSON.stringify(evidence),
      now,
      old.id,
    );
    return { finding: this.finding(old.id)!, news: old.status !== 'muted' && (worse || reopened) };
  }

  finding(id: number): DomeFinding | null {
    const r = this.db.get<FindingRow>('SELECT * FROM dome_findings WHERE id = ?', id);
    return r ? toFinding(r) : null;
  }

  findings(o: { status?: DomeStatus | 'active'; limit?: number } = {}): DomeFinding[] {
    const where = o.status === 'active' ? "WHERE status IN ('open', 'acknowledged')" : o.status ? 'WHERE status = ?' : '';
    const params = o.status && o.status !== 'active' ? [o.status] : [];
    return this.db.all<FindingRow>(`SELECT * FROM dome_findings ${where} ORDER BY last_at DESC LIMIT ?`, ...params, o.limit ?? 200).map(toFinding);
  }

  setStatus(id: number, status: DomeStatus): DomeFinding | null {
    this.db.run('UPDATE dome_findings SET status = ? WHERE id = ?', status, id);
    return this.finding(id);
  }

  setNotified(id: number, who: string) {
    this.db.run('UPDATE dome_findings SET notified = ? WHERE id = ?', who, id);
  }

  openCounts(): Record<DomeSeverity, number> {
    const out = { info: 0, warning: 0, serious: 0, critical: 0 } as Record<DomeSeverity, number>;
    for (const r of this.db.all<{ severity: string; n: number }>("SELECT severity, COUNT(*) AS n FROM dome_findings WHERE status = 'open' GROUP BY severity")) out[r.severity as DomeSeverity] = r.n;
    return out;
  }

  /** Keeps the newest findings (resolved and muted ones go first). */
  trim(max = 5000) {
    this.db.run("DELETE FROM dome_findings WHERE status IN ('resolved', 'muted') AND id NOT IN (SELECT id FROM dome_findings ORDER BY last_at DESC LIMIT ?)", max);
  }

  // ------------------------------------------------------------------------------------------------ devices

  /** A device seen; returns whether it is the first time. */
  seen(d: { mac: string; ip: string | null; name: string | null; network: string | null }, at = new Date()): boolean {
    const now = at.toISOString();
    const old = this.db.get<DeviceRow>('SELECT * FROM dome_devices WHERE mac = ?', d.mac);
    if (!old) {
      this.db.run('INSERT INTO dome_devices (mac, ip, name, network, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)', d.mac, d.ip, d.name, d.network, now, now);
      return true;
    }
    this.db.run('UPDATE dome_devices SET ip = COALESCE(?, ip), name = COALESCE(?, name), network = COALESCE(?, network), last_seen = ? WHERE mac = ?', d.ip, d.name, d.network, now, d.mac);
    return false;
  }

  device(mac: string): Omit<DomeDevice, 'fbrx'> | null {
    const r = this.db.get<DeviceRow>('SELECT * FROM dome_devices WHERE mac = ?', mac);
    return r ? { mac: r.mac, ip: r.ip, name: r.name, network: r.network, firstSeen: r.first_seen, lastSeen: r.last_seen } : null;
  }

  devices(): Array<Omit<DomeDevice, 'fbrx'>> {
    return this.db.all<DeviceRow>('SELECT * FROM dome_devices ORDER BY last_seen DESC LIMIT 2000').map((r) => ({ mac: r.mac, ip: r.ip, name: r.name, network: r.network, firstSeen: r.first_seen, lastSeen: r.last_seen }));
  }

  deviceCount(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM dome_devices')?.n ?? 0;
  }

  /** The device that has (or last had) an address. */
  byIp(ip: string): Omit<DomeDevice, 'fbrx'> | null {
    const r = this.db.get<DeviceRow>('SELECT * FROM dome_devices WHERE ip = ? ORDER BY last_seen DESC LIMIT 1', ip);
    return r ? { mac: r.mac, ip: r.ip, name: r.name, network: r.network, firstSeen: r.first_seen, lastSeen: r.last_seen } : null;
  }
}
