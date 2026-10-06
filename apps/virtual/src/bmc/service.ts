import type { BmcConfig, BmcProbe } from '@fbrx/shared';
import { formatFingerprint, openString, peerCertificate, sealString, type Db } from '@fbrx/shared/node';
import { conflict, errorMessage } from '../errors';
import { checkHost, Redfish } from './redfish';

interface Saved {
  host: string;
  username: string;
  password: string; // sealed
  fingerprint: string | null;
  kind: string | null;
  connectedAt: string | null;
  lastError: string | null;
}

const KEY = 'bmc';

/**
 * The connection to this server's management controller (iDRAC on a Dell PowerEdge). Its password is kept encrypted
 * with FBRX Virtual's master key; its certificate is trusted by fingerprint, after the person checked it.
 */
export class BmcService {
  constructor(
    private readonly db: Db,
    private readonly key: Buffer,
    private readonly fetcher: typeof fetch | null = null,
  ) {}

  private saved(): Saved | null {
    const row = this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', KEY);
    return row ? (JSON.parse(row.value) as Saved) : null;
  }

  private save(s: Saved | null) {
    if (!s) this.db.run('DELETE FROM settings WHERE key = ?', KEY);
    else this.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', KEY, JSON.stringify(s));
  }

  config(): BmcConfig | null {
    const s = this.saved();
    return s ? { host: s.host, username: s.username, fingerprint: s.fingerprint, kind: s.kind, connectedAt: s.connectedAt, lastError: s.lastError } : null;
  }

  /** The certificate the controller presents, for the person to check before trusting it. */
  async probe(host: string): Promise<BmcProbe> {
    const h = checkHost(host);
    const c = await peerCertificate(`https://${h}`, 10_000);
    return { host: h, fingerprint: c.fingerprint, subject: c.subject, issuer: c.issuer, trusted: c.trusted };
  }

  /** Checks the details work (signs in and reads the controller) and keeps them. */
  async connect(p: { host: string; username: string; password: string; fingerprint: string | null }): Promise<BmcConfig> {
    const host = checkHost(p.host);
    const fingerprint = p.fingerprint ? formatFingerprint(p.fingerprint) : null;
    const rf = new Redfish({ host, username: p.username, password: p.password, fingerprint }, this.fetcher);
    const kind = await rf.kind();
    this.save({ host, username: p.username, password: sealString(this.key, p.password, 'bmc'), fingerprint, kind, connectedAt: new Date().toISOString(), lastError: null });
    return this.config()!;
  }

  disconnect(): void {
    this.save(null);
  }

  client(): Redfish {
    const s = this.saved();
    if (!s) throw conflict('Connect the management controller first (Server → Connect)');
    return new Redfish({ host: s.host, username: s.username, password: openString(this.key, s.password, 'bmc'), fingerprint: s.fingerprint }, this.fetcher);
  }

  /** Runs a call against the controller, remembering the last failure for the console. */
  async use<T>(fn: (rf: Redfish) => Promise<T>): Promise<T> {
    const rf = this.client();
    try {
      const out = await fn(rf);
      const s = this.saved();
      if (s?.lastError) this.save({ ...s, lastError: null });
      return out;
    } catch (e) {
      const s = this.saved();
      if (s) this.save({ ...s, lastError: errorMessage(e) });
      throw e;
    }
  }
}
