import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RestoreRequest, SnapshotHeader, SnapshotInfo } from '@fbrx/shared';
import { CoreError, errorMessage } from '../errors';
import type { AuditLog } from '../audit/audit-log';
import type { Db } from '../storage/db';
import type { MetaStore } from '../storage/meta';
import type { DataPaths } from '../paths';
import type { KeychainAdapter } from '../platform';
import type { Logger } from '../logger';
import type { SettingsService } from '../settings/settings-service';
import type { Vault } from '../vault/vault';
import { SNAPSHOT_EXT, createSnapshot, inspectSnapshot, listSnapshots, stageRestore } from './snapshot';

export interface BackupDeps {
  db: Db;
  meta: MetaStore;
  paths: DataPaths;
  vault: Vault;
  keychain: KeychainAdapter;
  settings: SettingsService;
  audit: AuditLog;
  log: Logger;
  appVersion: string;
  device: () => { name: string; hostname: string; platform: string; deviceId: string | null };
  notify: (title: string, body: string, level: 'info' | 'success' | 'warning' | 'error') => void;
  requestRestart: (reason: string) => void;
  canSchedule: () => boolean;
}

/** Snapshot creation, scheduled backups with retention, and staged restore. */
export class BackupService {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private warnedNoPassphrase = false;

  constructor(private readonly d: BackupDeps) {}

  dir(): string {
    return this.d.settings.get().backup.directory || this.d.paths.snapshots;
  }

  list(): SnapshotInfo[] {
    return listSnapshots(this.dir());
  }

  lastBackupAt(): string | null {
    return this.d.meta.get<string>('backup.last');
  }

  private scheduledPassphrase(): string | undefined {
    const name = this.d.settings.get().backup.passphraseSecret;
    if (!name || !this.d.vault.isUnlocked) return undefined;
    try {
      return this.d.vault.get(name);
    } catch {
      return undefined;
    }
  }

  async create(o: { passphrase?: string; label?: string; includeModels?: boolean; actor: string; scheduled?: boolean }): Promise<SnapshotInfo> {
    if (this.busy) throw new CoreError('CONFLICT', 'A backup is already running');
    const passphrase = o.passphrase || this.scheduledPassphrase();
    if (!passphrase) {
      throw new CoreError(
        'INVALID_ARGUMENT',
        `A passphrase is required. Enter one, or store it in the vault as "${this.d.settings.get().backup.passphraseSecret}" for unattended backups.`,
      );
    }
    this.busy = true;
    const started = Date.now();
    try {
      const info = await createSnapshot({
        passphrase,
        label: o.label ?? (o.scheduled ? 'Scheduled backup' : null),
        includeModels: o.includeModels ?? this.d.settings.get().backup.includeModels,
        outDir: this.dir(),
        fileTag: o.scheduled ? 'auto' : undefined,
        db: this.d.db,
        paths: this.d.paths,
        vaultKey: this.d.vault.isUnlocked ? this.d.vault.exportKeyForSnapshot() : null,
        appVersion: this.d.appVersion,
        device: this.d.device(),
      });
      this.d.meta.set('backup.last', info.header!.createdAt);
      this.d.audit.append({
        category: 'backup',
        action: 'created',
        actor: o.actor,
        target: info.name,
        outcome: 'success',
        details: { sizeBytes: info.sizeBytes, durationMs: Date.now() - started, scheduled: !!o.scheduled, includesModels: info.header!.includesModels, vaultIncluded: this.d.vault.isUnlocked },
      });
      if (o.scheduled) this.applyRetention();
      return info;
    } catch (err) {
      this.d.audit.append({ category: 'backup', action: 'created', actor: o.actor, outcome: 'failure', details: { error: errorMessage(err) } });
      throw err;
    } finally {
      this.busy = false;
    }
  }

  private applyRetention() {
    const keep = this.d.settings.get().backup.retention;
    const autos = this.list().filter((s) => s.name.includes('-auto-'));
    for (const s of autos.slice(keep)) {
      rmSync(s.file, { force: true });
      this.d.log.info('Pruned old scheduled snapshot', { file: s.name });
    }
  }

  inspect(file: string): SnapshotHeader {
    const info = inspectSnapshot(file);
    if (!info.header) throw new CoreError('INVALID_ARGUMENT', info.error ?? 'Unreadable snapshot');
    return info.header;
  }

  async restore(req: RestoreRequest, actor: string): Promise<{ restored: boolean; restartRequired: boolean }> {
    if (!existsSync(req.file)) throw new CoreError('NOT_FOUND', `Snapshot not found: ${req.file}`);
    if (req.mode !== 'migrate' && req.mode !== 'clone') throw new CoreError('INVALID_ARGUMENT', 'mode must be "migrate" or "clone"');
    const header = await stageRestore({ file: req.file, passphrase: req.passphrase, mode: req.mode, paths: this.d.paths, keychain: this.d.keychain });
    this.d.audit.append({
      category: 'backup',
      action: 'restore.staged',
      actor,
      target: header.snapshotId,
      outcome: 'success',
      details: { mode: req.mode, fromHost: header.hostname, snapshotCreatedAt: header.createdAt, appVersion: header.appVersion },
    });
    this.d.log.warn('Snapshot staged for restore; restarting', { snapshot: header.snapshotId, mode: req.mode });
    setTimeout(() => this.d.requestRestart('restore'), 250);
    return { restored: true, restartRequired: true };
  }

  delete(file: string, actor: string): boolean {
    const abs = resolve(file);
    if (!abs.startsWith(resolve(this.dir())) || !abs.endsWith(SNAPSHOT_EXT)) {
      throw new CoreError('FORBIDDEN', 'Only snapshots in the backup folder can be deleted here');
    }
    if (!existsSync(abs)) return false;
    rmSync(abs, { force: true });
    this.d.audit.append({ category: 'backup', action: 'deleted', actor, target: abs, outcome: 'success' });
    return true;
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), 5 * 60_000);
    setTimeout(() => void this.tick(), 30_000).unref();
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick() {
    const cfg = this.d.settings.get().backup;
    if (!cfg.scheduleEnabled || this.busy || !this.d.canSchedule()) return;
    const last = this.lastBackupAt();
    if (last && Date.now() - new Date(last).getTime() < cfg.intervalHours * 3600_000) return;
    if (!this.scheduledPassphrase()) {
      if (!this.warnedNoPassphrase) {
        this.warnedNoPassphrase = true;
        this.d.notify('Scheduled backup skipped', `Store a backup passphrase in the vault as "${cfg.passphraseSecret}" to enable unattended backups.`, 'warning');
      }
      return;
    }
    try {
      const info = await this.create({ actor: 'scheduler', scheduled: true });
      this.d.log.info('Scheduled backup created', { file: info.name });
    } catch (err) {
      this.d.log.error('Scheduled backup failed', { error: errorMessage(err) });
      this.d.notify('Scheduled backup failed', errorMessage(err), 'error');
    }
  }
}
