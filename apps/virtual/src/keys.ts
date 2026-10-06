import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

/** The key that encrypts saved secrets (the management controller's password) in FBRX Virtual's data folder. */
export function loadMasterKey(dataDir: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  if (env.FBRX_V_MASTER_KEY) {
    const k = Buffer.from(env.FBRX_V_MASTER_KEY, 'base64');
    if (k.length !== 32) throw new Error('FBRX_V_MASTER_KEY must be 32 bytes, base64-encoded');
    return k;
  }
  const dir = join(dataDir, 'keys');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'master.key');
  if (existsSync(file)) return Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  const k = randomBytes(32);
  writeFileSync(file, k.toString('base64'), { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
  return k;
}
