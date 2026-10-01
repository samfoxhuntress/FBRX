import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

let patched = false;

/**
 * Loads `node:sqlite` (built into Node ≥22.13 and Electron ≥35) without its ExperimentalWarning noise.
 * Using the built-in driver means FBRX OS ships zero native modules, so macOS and Windows builds need no
 * per-platform compilation.
 */
export function loadSqlite(): { DatabaseSync: typeof DatabaseSyncType } {
  if (!patched) {
    patched = true;
    const original = process.emitWarning.bind(process);
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      const text = typeof warning === 'string' ? warning : warning?.message;
      if (text && text.includes('SQLite is an experimental feature')) return;
      return (original as (...a: unknown[]) => void)(warning, ...rest);
    }) as typeof process.emitWarning;
  }
  return process.getBuiltinModule('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };
}
