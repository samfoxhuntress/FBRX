import { execFile } from 'node:child_process';
import { chownSync, existsSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import type { HaStep } from '@fbrx/shared';
import { Db } from '@fbrx/shared/node';
// Command's own table changes: FBRX Command and FBRX Virtual come in the same FBRX Server bundle, always together.
import { CP_MIGRATIONS } from '../../../control-plane/src/migrations';
import { readEnv } from '../routes/roles';
import type { CopySource } from './copy';

export type RunCommand = (cmd: string, args: string[]) => Promise<{ code: number; out: string }>;

const runSystem: RunCommand = (cmd, args) =>
  new Promise((resolve) =>
    execFile(cmd, args, { timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    }),
  );

/** What of Command's database is not copied: the copy's own bookkeeping, and the third vote's leases (of the moment). */
const NOT_COPIED = /^(sqlite_|ha_journal_|ha_copy_state$|ha_witness_leases$)/;

const iso = () => new Date().toISOString();
const hostOf = (url: string | null) => {
  try {
    return url ? new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase() : null;
  } catch {
    return null;
  }
};

/**
 * FBRX Command (the command role) in a high-availability pair. Command runs on the active server only: its database
 * is copied to the standby as it changes (FBRX Virtual reads Command's database file next to it, as it does its own),
 * with what the standby needs to be the same Command (its keys, its certificate and its settings). On a takeover the
 * standby starts it; a server that stops serving stops it, since two Commands would send every alert and e-mail twice.
 * Computers find the active one at Command's address, which has to move with the pair: on a gate pair, the gate's
 * address in a network.
 */
export class CommandHa {
  readonly dataDir: string;
  readonly dbFile: string;
  private readonly run: RunCommand;
  private readonly unit: string;
  private db: Db | null = null;
  /**
   * This server keeps the copy now. ran: Command was running here, so what it wrote may differ from the active
   * server's (the copy starts over in full).
   */
  onStandby: ((ran: boolean) => void) | null = null;

  constructor(private readonly o: { envFile: string; secretsFile: string; unit?: string; run?: RunCommand }) {
    this.dataDir = readEnv(o.envFile).FBRX_CP_DATA_DIR ?? '/var/lib/fbrx-command';
    this.dbFile = join(this.dataDir, 'control-plane.db');
    this.run = o.run ?? runSystem;
    this.unit = o.unit ?? 'fbrx-command.service';
  }

  /** Where computers reach Command, from its settings. */
  publicUrl(): string | null {
    return readEnv(this.o.envFile).FBRX_CP_PUBLIC_URL ?? null;
  }

  /**
   * Its database, for the copy: every table Command has (looked up again when an update changes them). Null until
   * Command has made it, so that its files stay Command's own.
   */
  source(): CopySource | null {
    if (!existsSync(this.dbFile)) return null;
    const db = new Db(this.dbFile);
    this.db = db;
    // The copy applies rows as the active server has them, and its deletes are in the journal too: no cascades here.
    db.exec('PRAGMA foreign_keys = OFF');
    // Opening it may have made its side files (-wal, -shm) as this program's user: they go to Command's at once.
    db.get('SELECT count(*) AS n FROM sqlite_master');
    this.giveBack();
    const tables = () =>
      db
        .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .filter((t) => !NOT_COPIED.test(t.name))
        .map((t) => ({ name: t.name }));
    return { name: 'command', label: 'FBRX Command', db, tables, watchSchema: true };
  }

  /** Its keys, certificate and settings, the same on both servers (computers check its certificate when they connect). */
  files(): Array<{ name: string; path: string; secret?: boolean }> {
    return [
      { name: 'command-settings', path: this.o.envFile },
      { name: 'command-secrets', path: this.o.secretsFile, secret: true },
      { name: 'command-jwt-key', path: join(this.dataDir, 'keys', 'jwt.key'), secret: true },
      { name: 'command-master-key', path: join(this.dataDir, 'keys', 'master.key'), secret: true },
      { name: 'command-license-key', path: join(this.dataDir, 'keys', 'license-signing.pem'), secret: true },
      { name: 'command-tls-cert', path: join(this.dataDir, 'tls', 'command.crt') },
      { name: 'command-tls-key', path: join(this.dataDir, 'tls', 'command.key'), secret: true },
    ];
  }

  /** The database's files written by this program (root) go back to Command's user, so Command can open them. */
  private giveBack() {
    try {
      const owner = statSync(this.dataDir);
      for (const f of [this.dbFile, `${this.dbFile}-wal`, `${this.dbFile}-shm`]) if (existsSync(f)) chownSync(f, owner.uid, owner.gid);
    } catch {
      /* not root (tests) */
    }
  }

  /** This server serves: Command starts here, on its copy. */
  async activate(): Promise<HaStep[]> {
    const t0 = performance.now();
    this.giveBack();
    const r = await this.run('systemctl', ['start', this.unit]);
    const ms = `${Math.round(performance.now() - t0)} ms`;
    return [{ at: iso(), text: r.code === 0 ? `FBRX Command started here (${ms})` : `FBRX Command did not start (${r.out.slice(0, 160) || `exit ${r.code}`}): journalctl -u fbrx-command says why` }];
  }

  /**
   * This server stops serving (or has not decided yet): Command stops here, if it runs. Its database is then kept at
   * this version's tables (Command does that itself when it starts, and does not start on the standby), so the copy
   * of an updated active server fits it.
   */
  async deactivate(): Promise<HaStep[]> {
    const steps: HaStep[] = [];
    const ran = (await this.run('systemctl', ['is-active', '--quiet', this.unit])).code === 0;
    if (ran) {
      const t0 = performance.now();
      const r = await this.run('systemctl', ['stop', this.unit]);
      const ms = `${Math.round(performance.now() - t0)} ms`;
      steps.push({ at: iso(), text: r.code === 0 ? `FBRX Command stopped here (${ms})` : `FBRX Command did not stop (${r.out.slice(0, 160) || `exit ${r.code}`})` });
    }
    try {
      this.db?.migrate(CP_MIGRATIONS);
    } catch (e) {
      steps.push({ at: iso(), text: `FBRX Command's copy could not be brought to this version's tables: ${(e as Error).message}` });
    }
    this.giveBack();
    this.onStandby?.(ran);
    return steps;
  }

  /**
   * What could go wrong: computers reach Command at an address that stays on one server (they would not find it after a
   * takeover), or the pair's third vote is this same Command (it stops with the active server, so the standby could
   * never be given the pair).
   */
  warnings(witnessUrl: string | null, moving: string[], partner: string): string[] {
    const out: string[] = [];
    const host = hostOf(this.publicUrl());
    if (host && isIP(host) && !moving.includes(host)) {
      out.push(
        moving.length
          ? `Computers reach FBRX Command at ${host}, which stays on one server: after a takeover they cannot find it on ${partner}. Give it the gate's address in a network (${moving.join(', ')}) with the installer's --command-address.`
          : `Computers reach FBRX Command at ${host}, which stays on one server: after a takeover they cannot find it on ${partner}. Give it a name in your DNS (the installer's --command-address) and point the name at the server that serves.`,
      );
    }
    const vote = hostOf(witnessUrl);
    if (vote && host && vote === host) out.push('The third vote is FBRX Command on this pair: it stops with the active server, so the standby could never take over. Use FBRX Command on another server, or a third FBRX Server.');
    return out;
  }
}
