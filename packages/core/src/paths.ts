import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { PRODUCT_NAME } from '@fbrx/shared';

/**
 * Everything FBRX OS persists lives under one root so a workstation can be backed up, moved and restored
 * as a unit. Paths marked "machine-local" are never included in snapshots.
 */
export interface DataPaths {
  root: string;
  db: string;
  plugins: string;
  pluginData: string;
  models: string;
  workspace: string;
  snapshots: string;
  /** machine-local */
  logs: string;
  /** machine-local: downloaded runtime binaries */
  runtime: string;
  /** machine-local */
  tmp: string;
  /** machine-local: headless keychain fallback */
  keychainFile: string;
}

export function resolveDataPaths(root: string): DataPaths {
  const r = resolve(root);
  return {
    root: r,
    db: join(r, 'fbrx.db'),
    plugins: join(r, 'plugins'),
    pluginData: join(r, 'plugin-data'),
    models: join(r, 'models'),
    workspace: join(r, 'workspace'),
    snapshots: join(r, 'snapshots'),
    logs: join(r, 'logs'),
    runtime: join(r, 'runtime'),
    tmp: join(r, 'tmp'),
    keychainFile: join(r, 'keychain.key'),
  };
}

export function ensureDataDirs(p: DataPaths): void {
  for (const dir of [p.root, p.plugins, p.pluginData, p.models, p.workspace, p.snapshots, p.logs, p.runtime, p.tmp]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Entries (relative to root) that are bound to this machine and excluded from snapshots. */
export const MACHINE_LOCAL_ENTRIES = ['logs', 'runtime', 'tmp', 'snapshots', 'keychain.key', 'fbrx.db', 'fbrx.db-wal', 'fbrx.db-shm', '.restore-staging', '.pre-restore'];

export function defaultDataRoot(): string {
  if (process.env.FBRX_HOME) return resolve(process.env.FBRX_HOME);
  const home = homedir();
  switch (process.platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', PRODUCT_NAME);
    case 'win32':
      return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), PRODUCT_NAME);
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'fbrx-os');
  }
}
