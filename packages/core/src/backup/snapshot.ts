import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync, appendFileSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import * as tar from 'tar';
import { KDF_STRONG, scryptKey, sha256Hex } from '@fbrx/shared/node';
import { SNAPSHOT_FORMAT_VERSION, newId, type SnapshotHeader, type SnapshotInfo } from '@fbrx/shared';
import { CoreError } from '../errors';
import type { DataPaths } from '../paths';
import { Db } from '../storage/db';
import { SCHEMA_VERSION } from '../storage/migrations';
import type { KeychainAdapter } from '../platform';
import { sha256File } from '../ai/runtime/model-manager';
import { validatePassphrase } from '../vault/vault';
import { slugify } from '../util/misc';

const MAGIC = Buffer.from('FBRXSNAP');
const TAG_LEN = 16;
export const SNAPSHOT_EXT = '.fbrxsnap';
/** Folders (relative to the data root) captured in a snapshot. The database is captured separately. */
const CONTENT_DIRS = ['plugins', 'plugin-data', 'workspace'];

interface Manifest {
  format: number;
  snapshotId: string;
  createdAt: string;
  appVersion: string;
  schemaVersion: number;
  vaultKey: string | null;
  files: Array<{ path: string; size: number; sha256: string }>;
}

export interface CreateSnapshotOptions {
  passphrase: string;
  label?: string | null;
  includeModels?: boolean;
  outDir: string;
  fileTag?: string;
  db: Db;
  paths: DataPaths;
  vaultKey: Buffer | null;
  appVersion: string;
  device: { name: string; hostname: string; platform: string; deviceId: string | null };
}

function walk(dir: string, root: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, root, out);
    else if (e.isFile()) out.push(relative(root, full).replace(/\\/g, '/'));
  }
  return out;
}

export function readHeader(file: string): { header: SnapshotHeader; dataStart: number; size: number; headerBytes: Buffer } {
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size;
    const pre = Buffer.alloc(12);
    if (readSync(fd, pre, 0, 12, 0) !== 12 || !pre.subarray(0, 8).equals(MAGIC)) {
      throw new CoreError('INVALID_ARGUMENT', 'Not an FBRX OS snapshot');
    }
    const len = pre.readUInt32BE(8);
    if (len <= 0 || len > 1_000_000) throw new CoreError('INVALID_ARGUMENT', 'Corrupt snapshot header');
    const headerBytes = Buffer.alloc(len);
    readSync(fd, headerBytes, 0, len, 12);
    const header = JSON.parse(headerBytes.toString('utf8')) as SnapshotHeader;
    if (header.format > SNAPSHOT_FORMAT_VERSION) {
      throw new CoreError('INVALID_ARGUMENT', `Snapshot format ${header.format} is newer than this version of FBRX OS supports; update first`);
    }
    return { header, dataStart: 12 + len, size, headerBytes };
  } finally {
    closeSync(fd);
  }
}

/**
 * Creates an encrypted, self-contained snapshot of the workstation:
 *   FBRXSNAP | u32 header length | header JSON (authenticated) | AES-256-GCM(tar.gz) | GCM tag
 * The key is derived from the passphrase with scrypt. The archive carries the vault key, so restoring
 * with the passphrase brings every credential back on any machine.
 */
export async function createSnapshot(o: CreateSnapshotOptions): Promise<SnapshotInfo> {
  validatePassphrase(o.passphrase);
  mkdirSync(o.outDir, { recursive: true });
  const work = join(o.paths.tmp, `snap-${Date.now()}-${randomBytes(3).toString('hex')}`);
  // Payload tree: manifest.json + db/ (written here directly; renaming a folder with a just-written file in it fails
  // on Windows while the file is still open or being scanned), then data/<dir> appended from the live root.
  const tree = join(work, 'tree');
  mkdirSync(join(tree, 'db'), { recursive: true });
  const createdAt = new Date().toISOString();
  const snapshotId = newId('snap');
  const stamp = createdAt.replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const fileName = `fbrx-${slugify(o.device.name || o.device.hostname, 24)}-${o.fileTag ? `${o.fileTag}-` : ''}${stamp}${SNAPSHOT_EXT}`;
  const target = join(o.outDir, fileName);
  const tgz = join(work, 'payload.tgz');
  try {
    o.db.snapshotTo(join(tree, 'db', 'fbrx.db'));
    const dirs = [...CONTENT_DIRS, ...(o.includeModels ? ['models'] : [])];
    const files: Manifest['files'] = [];
    const dbFile = join(tree, 'db', 'fbrx.db');
    files.push({ path: 'db/fbrx.db', size: statSync(dbFile).size, sha256: await sha256File(dbFile) });
    for (const d of dirs) {
      for (const rel of walk(join(o.paths.root, d), o.paths.root)) {
        const abs = join(o.paths.root, rel);
        files.push({ path: `data/${rel}`, size: statSync(abs).size, sha256: await sha256File(abs) });
      }
    }
    const manifest: Manifest = {
      format: SNAPSHOT_FORMAT_VERSION,
      snapshotId,
      createdAt,
      appVersion: o.appVersion,
      schemaVersion: o.db.schemaVersion(),
      vaultKey: o.vaultKey ? o.vaultKey.toString('base64') : null,
      files,
    };
    writeFileSync(join(tree, 'manifest.json'), JSON.stringify(manifest));
    const plain = join(work, 'payload.tar');
    await tar.c({ file: plain, cwd: tree, portable: true }, ['manifest.json', 'db']);
    const existingDirs = dirs.filter((d) => existsSync(join(o.paths.root, d)));
    if (existingDirs.length) await tar.r({ file: plain, cwd: o.paths.root, portable: true, prefix: 'data' }, existingDirs);
    await pipeline(createReadStream(plain), createGzip({ level: 6 }), createWriteStream(tgz));
    await rm(plain, { force: true });

    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const header: SnapshotHeader = {
      format: SNAPSHOT_FORMAT_VERSION,
      snapshotId,
      createdAt,
      label: o.label ?? null,
      appVersion: o.appVersion,
      schemaVersion: manifest.schemaVersion,
      deviceName: o.device.name,
      hostname: o.device.hostname,
      platform: o.device.platform,
      deviceId: o.device.deviceId,
      includesModels: !!o.includeModels,
      encryption: { cipher: 'aes-256-gcm', kdf: 'scrypt', ...KDF_STRONG, salt: salt.toString('base64'), iv: iv.toString('base64') },
    };
    const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(headerBytes.length);
    const key = await scryptKey(o.passphrase, salt, KDF_STRONG);
    const partial = `${target}.partial`;
    writeFileSync(partial, Buffer.concat([MAGIC, lenBuf, headerBytes]));
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(headerBytes);
    await pipeline(createReadStream(tgz), cipher, createWriteStream(partial, { flags: 'a' }));
    appendFileSync(partial, cipher.getAuthTag());
    renameSync(partial, target);
    return { file: target, name: fileName, sizeBytes: statSync(target).size, header, error: null };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export function inspectSnapshot(file: string): SnapshotInfo {
  try {
    const { header, size } = readHeader(file);
    return { file, name: basename(file), sizeBytes: size, header, error: null };
  } catch (err) {
    return { file, name: basename(file), sizeBytes: existsSync(file) ? statSync(file).size : 0, header: null, error: (err as Error).message };
  }
}

export function listSnapshots(dir: string): SnapshotInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(SNAPSHOT_EXT))
    .map((f) => inspectSnapshot(join(dir, f)))
    .sort((a, b) => (b.header?.createdAt ?? '').localeCompare(a.header?.createdAt ?? ''));
}

export interface StageRestoreOptions {
  file: string;
  passphrase: string;
  mode: 'migrate' | 'clone';
  paths: DataPaths;
  keychain: KeychainAdapter;
}

export const STAGING_DIR = '.restore-staging';
export const PRE_RESTORE_DIR = '.pre-restore';

/**
 * Decrypts and verifies a snapshot into `<root>/.restore-staging`, re-binds the vault key to this machine's
 * keychain, and (for clones) strips the fleet identity. Nothing live is touched until the next boot calls
 * `applyStagedRestore`.
 */
export async function stageRestore(o: StageRestoreOptions): Promise<SnapshotHeader> {
  const { header, dataStart, size, headerBytes } = readHeader(o.file);
  const staging = join(o.paths.root, STAGING_DIR);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const tgz = join(o.paths.tmp, `restore-${Date.now()}.tgz`);
  try {
    const key = await scryptKey(o.passphrase, Buffer.from(header.encryption.salt, 'base64'), {
      N: header.encryption.N,
      r: header.encryption.r,
      p: header.encryption.p,
    });
    const tag = Buffer.alloc(TAG_LEN);
    const fd = openSync(o.file, 'r');
    readSync(fd, tag, 0, TAG_LEN, size - TAG_LEN);
    closeSync(fd);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.encryption.iv, 'base64'));
    decipher.setAAD(headerBytes);
    decipher.setAuthTag(tag);
    try {
      await pipeline(createReadStream(o.file, { start: dataStart, end: size - TAG_LEN - 1 }), decipher, createWriteStream(tgz));
    } catch {
      throw new CoreError('UNAUTHENTICATED', 'Wrong passphrase, or the snapshot file is corrupt');
    }
    await tar.x({ file: tgz, cwd: staging, strict: true, filter: (p) => !p.split(/[\\/]/).includes('..') });
    const manifest = JSON.parse(readFileSync(join(staging, 'manifest.json'), 'utf8')) as Manifest;
    if (manifest.snapshotId !== header.snapshotId) throw new CoreError('INVALID_ARGUMENT', 'Snapshot manifest does not match its header');
    for (const f of manifest.files) {
      const abs = resolve(staging, f.path);
      if (!abs.startsWith(resolve(staging)) || !existsSync(abs)) throw new CoreError('INVALID_ARGUMENT', `Snapshot is missing ${f.path}`);
      if ((await stat(abs)).size !== f.size || (await sha256File(abs)) !== f.sha256) {
        throw new CoreError('INVALID_ARGUMENT', `Integrity check failed for ${f.path}`);
      }
    }
    if (manifest.schemaVersion > SCHEMA_VERSION) {
      throw new CoreError('INVALID_ARGUMENT', `Snapshot was taken by a newer FBRX OS (schema ${manifest.schemaVersion}); update this installation first`);
    }

    const db = new Db(join(staging, 'db', 'fbrx.db'));
    try {
      if (manifest.vaultKey && o.keychain.available()) {
        const dek = Buffer.from(manifest.vaultKey, 'base64');
        db.run(
          'UPDATE vault_keys SET dek_keychain = ?, keychain_kind = ?, updated_at = ? WHERE id = ?',
          await o.keychain.protect(dek),
          o.keychain.kind,
          new Date().toISOString(),
          'primary',
        );
      }
      if (o.mode === 'clone') {
        db.run("DELETE FROM meta WHERE key LIKE 'fleet.%' OR key = 'license.managed'");
        db.run("DELETE FROM secrets WHERE (internal = 1 AND (name LIKE 'fbrx.fleet.%' OR name LIKE 'fbrx.localapi.%' OR name LIKE 'fbrx.mesh.%')) OR managed = 1");
        // A clone is a new machine: it gets its own mesh identity and pairs its own devices.
        if (db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mesh_devices'")) db.run('DELETE FROM mesh_devices');
        db.run("DELETE FROM settings_layers WHERE layer = 'managed'");
        db.run("DELETE FROM policy_layers WHERE layer = 'managed'");
        db.run('DELETE FROM fleet_commands');
      }
      db.run(
        "INSERT INTO meta (key, value) VALUES ('restore.last', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        JSON.stringify({ snapshotId: header.snapshotId, mode: o.mode, from: header.hostname, snapshotCreatedAt: header.createdAt, restoredAt: new Date().toISOString() }),
      );
    } finally {
      db.close();
    }
    for (const f of ['fbrx.db-wal', 'fbrx.db-shm']) rmSync(join(staging, 'db', f), { force: true });
    writeFileSync(
      join(staging, 'READY.json'),
      JSON.stringify({ snapshotId: header.snapshotId, mode: o.mode, includesModels: header.includesModels, stagedAt: new Date().toISOString() }),
    );
    return header;
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  } finally {
    rmSync(tgz, { force: true });
  }
}

/** Swaps a staged restore into place. Must run before the database is opened. Returns true if applied. */
export function applyStagedRestore(paths: DataPaths, log: (msg: string, data?: unknown) => void): boolean {
  const staging = join(paths.root, STAGING_DIR);
  const ready = join(staging, 'READY.json');
  if (!existsSync(ready)) {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    return false;
  }
  const info = JSON.parse(readFileSync(ready, 'utf8')) as { snapshotId: string; includesModels: boolean };
  const backup = join(paths.root, PRE_RESTORE_DIR, new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(backup, { recursive: true });
  const moveAside = (name: string) => {
    const p = join(paths.root, name);
    if (existsSync(p)) renameSync(p, join(backup, name));
  };
  for (const f of ['fbrx.db', 'fbrx.db-wal', 'fbrx.db-shm']) moveAside(f);
  const dirs = [...CONTENT_DIRS, ...(info.includesModels ? ['models'] : [])];
  for (const d of dirs) moveAside(d);
  renameSync(join(staging, 'db', 'fbrx.db'), paths.db);
  for (const d of dirs) {
    const src = join(staging, 'data', d);
    if (existsSync(src)) renameSync(src, join(paths.root, d));
    else mkdirSync(join(paths.root, d), { recursive: true });
  }
  rmSync(staging, { recursive: true, force: true });
  // Keep only the three most recent pre-restore safety copies.
  const pre = join(paths.root, PRE_RESTORE_DIR);
  const olds = readdirSync(pre).sort().reverse().slice(3);
  for (const o of olds) rmSync(join(pre, o), { recursive: true, force: true });
  log('Applied staged restore', { snapshotId: info.snapshotId, previousDataSavedTo: backup });
  return true;
}
