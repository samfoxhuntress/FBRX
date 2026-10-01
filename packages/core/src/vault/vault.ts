import { randomBytes } from 'node:crypto';
import { KDF_STRONG, b64u, fromB64u, openBytes, openString, scryptKey, sealString, type KdfParams } from '@fbrx/shared/node';
import { SECRET_KINDS, type ManagedSecret, type SecretKind, type SecretMeta, type VaultStatus } from '@fbrx/shared';
import { CoreError } from '../errors';
import type { Db } from '../storage/db';
import type { KeychainAdapter } from '../platform';
import type { EventBus } from '../events';
import type { Logger } from '../logger';

const KEY_CHECK = 'fbrx-vault-key-check-v1';
const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
/** Secrets under this prefix belong to FBRX itself (device token, Local API tokens …) and are never listed or revealed. */
export const INTERNAL_PREFIX = 'fbrx.';

interface KeyRow {
  dek_keychain: string | null;
  keychain_kind: string | null;
  dek_recovery: string | null;
  recovery_salt: string | null;
  recovery_params: string | null;
  key_check: string;
}

interface SecretRow {
  name: string;
  kind: SecretKind;
  description: string;
  tags: string;
  managed: number;
  internal: number;
  version: number;
  value_enc: string;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
}

/**
 * Credential vault with envelope encryption.
 *
 * A random 256-bit data-encryption key (DEK) encrypts every secret (AES-256-GCM, secret name bound as AAD).
 * The DEK itself is stored wrapped twice:
 *   1. by the OS keychain (macOS Keychain / Windows DPAPI via Electron safeStorage) → unlocks silently on this machine;
 *   2. optionally by a recovery passphrase (scrypt) → unlocks the vault on any machine.
 * Snapshots additionally carry the DEK wrapped by the snapshot passphrase, which is how a restore on a new
 * workstation brings every credential back without re-entry.
 */
export class Vault {
  private dek: Buffer | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private readonly db: Db,
    private readonly keychain: KeychainAdapter,
    private readonly log: Logger,
    private readonly events?: EventBus,
  ) {}

  /** Called at boot. Creates the vault on first run; otherwise tries to unlock via the keychain. */
  async open(): Promise<void> {
    const row = this.keyRow();
    if (!row) {
      await this.create();
      return;
    }
    if (row.dek_keychain && this.keychain.available()) {
      try {
        const dek = await this.keychain.unprotect(row.dek_keychain);
        this.assertKey(dek, row);
        this.dek = dek;
        this.log.info('Vault unlocked with keychain', { keychain: this.keychain.kind });
      } catch {
        this.log.warn('Vault key could not be unwrapped by this machine keychain; recovery passphrase required');
      }
    } else {
      this.log.warn('Vault is locked: no keychain-wrapped key for this machine');
    }
    this.changed();
  }

  private async create(): Promise<void> {
    const dek = randomBytes(32);
    const now = new Date().toISOString();
    const wrapped = this.keychain.available() ? await this.keychain.protect(dek) : null;
    this.db.run(
      'INSERT INTO vault_keys (id, dek_keychain, keychain_kind, key_check, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      'primary',
      wrapped,
      this.keychain.kind,
      sealString(dek, KEY_CHECK, 'key-check'),
      now,
      now,
    );
    this.dek = dek;
    this.log.info('Vault created', { keychain: this.keychain.kind });
    this.changed();
  }

  private keyRow(): KeyRow | undefined {
    return this.db.get<KeyRow>('SELECT * FROM vault_keys WHERE id = ?', 'primary');
  }

  private assertKey(dek: Buffer, row: KeyRow): void {
    if (openString(dek, row.key_check, 'key-check') !== KEY_CHECK) throw new Error('Key check mismatch');
  }

  get isUnlocked(): boolean {
    return this.dek !== null;
  }

  status(): VaultStatus {
    const row = this.keyRow();
    const counts = this.db.get<{ n: number; m: number }>(
      'SELECT COUNT(*) AS n, COALESCE(SUM(managed), 0) AS m FROM secrets WHERE internal = 0',
    );
    return {
      state: !row ? 'uninitialized' : this.dek ? 'unlocked' : 'locked',
      keychain: this.keychain.available() ? 'available' : 'unavailable',
      secretCount: Number(counts?.n ?? 0),
      managedCount: Number(counts?.m ?? 0),
      hasRecovery: !!row?.dek_recovery,
    };
  }

  /** Sets (or replaces) the recovery passphrase. Requires the vault to be unlocked. */
  async setRecoveryPassphrase(passphrase: string): Promise<void> {
    validatePassphrase(passphrase);
    const dek = this.requireKey();
    const salt = randomBytes(16);
    const params: KdfParams = KDF_STRONG;
    const kek = await scryptKey(passphrase, salt, params);
    this.db.run(
      'UPDATE vault_keys SET dek_recovery = ?, recovery_salt = ?, recovery_params = ?, updated_at = ? WHERE id = ?',
      sealString(kek, dek, 'vault-recovery'),
      b64u(salt),
      JSON.stringify(params),
      new Date().toISOString(),
      'primary',
    );
    this.changed();
  }

  async verifyRecoveryPassphrase(passphrase: string): Promise<boolean> {
    const row = this.keyRow();
    if (!row?.dek_recovery || !row.recovery_salt) return false;
    try {
      const kek = await scryptKey(passphrase, fromB64u(row.recovery_salt), JSON.parse(row.recovery_params ?? 'null') ?? KDF_STRONG);
      const dek = openBytes(kek, row.dek_recovery, 'vault-recovery');
      this.assertKey(dek, row);
      return true;
    } catch {
      return false;
    }
  }

  /** Unlocks with the recovery passphrase and re-binds the key to this machine's keychain. */
  async unlockWithRecovery(passphrase: string): Promise<void> {
    const row = this.keyRow();
    if (!row) throw new CoreError('NOT_FOUND', 'Vault is not initialised');
    if (!row.dek_recovery || !row.recovery_salt) {
      throw new CoreError('FORBIDDEN', 'No recovery passphrase is configured for this vault');
    }
    let dek: Buffer;
    try {
      const kek = await scryptKey(passphrase, fromB64u(row.recovery_salt), JSON.parse(row.recovery_params ?? 'null') ?? KDF_STRONG);
      dek = openBytes(kek, row.dek_recovery, 'vault-recovery');
      this.assertKey(dek, row);
    } catch {
      throw new CoreError('UNAUTHENTICATED', 'Recovery passphrase is incorrect');
    }
    await this.bindKeychain(dek);
    this.dek = dek;
    this.changed();
  }

  /** Installs a DEK recovered from a snapshot and binds it to this machine. */
  async adoptKey(dek: Buffer): Promise<void> {
    const row = this.keyRow();
    if (!row) throw new CoreError('NOT_FOUND', 'Vault is not initialised');
    this.assertKey(dek, row);
    await this.bindKeychain(dek);
    this.dek = dek;
    this.changed();
  }

  private async bindKeychain(dek: Buffer): Promise<void> {
    if (!this.keychain.available()) return;
    this.db.run(
      'UPDATE vault_keys SET dek_keychain = ?, keychain_kind = ?, updated_at = ? WHERE id = ?',
      await this.keychain.protect(dek),
      this.keychain.kind,
      new Date().toISOString(),
      'primary',
    );
  }

  lock(): void {
    this.dek?.fill(0);
    this.dek = null;
    this.changed();
  }

  /** Exposes the DEK to the snapshot service only. */
  exportKeyForSnapshot(): Buffer {
    return Buffer.from(this.requireKey());
  }

  private requireKey(): Buffer {
    if (!this.dek) throw new CoreError('LOCKED', 'The vault is locked. Unlock it with your recovery passphrase.');
    return this.dek;
  }

  list(): SecretMeta[] {
    return this.db
      .all<SecretRow>('SELECT * FROM secrets WHERE internal = 0 ORDER BY name COLLATE NOCASE')
      .map(toMeta);
  }

  has(name: string): boolean {
    return !!this.db.get('SELECT 1 FROM secrets WHERE name = ?', name);
  }

  set(input: { name: string; value: string; kind?: SecretKind; description?: string; tags?: string[] }, opts: { managed?: boolean; internal?: boolean; force?: boolean } = {}): SecretMeta {
    const { name } = input;
    if (!NAME_RE.test(name)) throw new CoreError('INVALID_ARGUMENT', 'Secret names may contain letters, digits, ".", "_" and "-" (max 128)');
    const internal = opts.internal ?? false;
    if (!internal && name.startsWith(INTERNAL_PREFIX)) throw new CoreError('FORBIDDEN', `Names starting with "${INTERNAL_PREFIX}" are reserved`);
    if (input.value.length > 64 * 1024) throw new CoreError('INVALID_ARGUMENT', 'Secret value is too large (max 64 KiB)');
    const kind = input.kind ?? 'other';
    if (!SECRET_KINDS.includes(kind)) throw new CoreError('INVALID_ARGUMENT', `Unknown secret kind ${kind}`);
    const dek = this.requireKey();
    const existing = this.db.get<SecretRow>('SELECT * FROM secrets WHERE name = ?', name);
    if (existing?.managed && !opts.managed && !opts.force) {
      throw new CoreError('MANAGED', `"${name}" is managed by your organisation and cannot be changed locally`);
    }
    const now = new Date().toISOString();
    const enc = sealString(dek, input.value, `secret:${name}`);
    if (existing) {
      this.db.run(
        'UPDATE secrets SET kind = ?, description = ?, tags = ?, managed = ?, internal = ?, version = version + 1, value_enc = ?, updated_at = ? WHERE name = ?',
        kind,
        input.description ?? existing.description,
        JSON.stringify(input.tags ?? JSON.parse(existing.tags)),
        opts.managed ? 1 : 0,
        internal ? 1 : 0,
        enc,
        now,
        name,
      );
    } else {
      this.db.run(
        'INSERT INTO secrets (name, kind, description, tags, managed, internal, version, value_enc, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?,?)',
        name,
        kind,
        input.description ?? '',
        JSON.stringify(input.tags ?? []),
        opts.managed ? 1 : 0,
        internal ? 1 : 0,
        enc,
        now,
        now,
      );
    }
    this.changed();
    return toMeta(this.db.get<SecretRow>('SELECT * FROM secrets WHERE name = ?', name)!);
  }

  /** Decrypts a secret. Callers are responsible for authorisation and auditing. */
  get(name: string, opts: { allowInternal?: boolean } = {}): string | undefined {
    const row = this.db.get<SecretRow>('SELECT * FROM secrets WHERE name = ?', name);
    if (!row) return undefined;
    if (row.internal && !opts.allowInternal) throw new CoreError('FORBIDDEN', 'Internal secret');
    const value = openString(this.requireKey(), row.value_enc, `secret:${name}`);
    this.db.run('UPDATE secrets SET last_accessed_at = ? WHERE name = ?', new Date().toISOString(), name);
    return value;
  }

  delete(name: string, opts: { managed?: boolean; internal?: boolean } = {}): boolean {
    const row = this.db.get<SecretRow>('SELECT * FROM secrets WHERE name = ?', name);
    if (!row) return false;
    if (row.managed && !opts.managed) throw new CoreError('MANAGED', `"${name}" is managed by your organisation`);
    if (row.internal && !opts.internal) throw new CoreError('FORBIDDEN', 'Internal secret');
    this.db.run('DELETE FROM secrets WHERE name = ?', name);
    this.changed();
    return true;
  }

  /** Replaces the full set of organisation-managed secrets with what the control plane sent. */
  applyManaged(secrets: ManagedSecret[]): { added: number; updated: number; removed: number } {
    const dek = this.requireKey();
    const now = new Date().toISOString();
    let added = 0;
    let updated = 0;
    let removed = 0;
    this.db.tx(() => {
      const wanted = new Set(secrets.map((s) => s.name));
      for (const row of this.db.all<{ name: string }>('SELECT name FROM secrets WHERE managed = 1')) {
        if (!wanted.has(row.name)) {
          this.db.run('DELETE FROM secrets WHERE name = ?', row.name);
          removed++;
        }
      }
      for (const s of secrets) {
        if (!NAME_RE.test(s.name) || s.name.startsWith(INTERNAL_PREFIX)) continue;
        const existing = this.db.get<SecretRow>('SELECT * FROM secrets WHERE name = ?', s.name);
        const enc = sealString(dek, s.value, `secret:${s.name}`);
        if (!existing) {
          this.db.run(
            "INSERT INTO secrets (name, kind, description, tags, managed, internal, version, value_enc, created_at, updated_at) VALUES (?, 'other', ?, '[]', 1, 0, ?, ?, ?, ?)",
            s.name,
            s.description ?? '',
            s.version,
            enc,
            now,
            now,
          );
          added++;
        } else if (!existing.managed || existing.version !== s.version) {
          this.db.run(
            'UPDATE secrets SET managed = 1, version = ?, value_enc = ?, description = ?, updated_at = ? WHERE name = ?',
            s.version,
            enc,
            s.description ?? existing.description,
            now,
            s.name,
          );
          updated++;
        }
      }
    });
    this.changed();
    return { added, updated, removed };
  }

  clearManaged(): number {
    const { changes } = this.db.run('DELETE FROM secrets WHERE managed = 1');
    this.changed();
    return changes;
  }

  /** All decrypted, non-internal secret values (for the output redactor). Empty when locked. */
  valuesForRedaction(): Array<{ name: string; value: string }> {
    if (!this.dek) return [];
    const out: Array<{ name: string; value: string }> = [];
    for (const row of this.db.all<SecretRow>('SELECT name, value_enc FROM secrets')) {
      try {
        const value = openString(this.dek, row.value_enc, `secret:${row.name}`);
        if (value.length >= 4) out.push({ name: row.name, value });
      } catch {
        /* skip corrupt entries */
      }
    }
    return out;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private changed() {
    for (const l of this.listeners) l();
    this.events?.emit('vault.changed', this.status());
  }
}

export function validatePassphrase(p: string): void {
  if (typeof p !== 'string' || p.length < 10) {
    throw new CoreError('INVALID_ARGUMENT', 'Passphrases must be at least 10 characters');
  }
}

function toMeta(r: SecretRow): SecretMeta {
  return {
    name: r.name,
    kind: r.kind,
    description: r.description,
    tags: JSON.parse(r.tags),
    managed: !!r.managed,
    version: Number(r.version),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastAccessedAt: r.last_accessed_at,
  };
}
