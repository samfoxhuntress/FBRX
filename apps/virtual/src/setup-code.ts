import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The first-time setup code, for the FBRX Server screen: `setup-code` for the fbrx-server command, and a login-screen
 * snippet (`setup-code.issue`, linked from /etc/issue.d) so it shows above the console login prompt.
 */
export function writeSetupCode(dataDir: string, code: string | null): void {
  try {
    if (!code) {
      clearSetupCode(dataDir);
      return;
    }
    writeFileSync(join(dataDir, 'setup-code'), `${code}\n`, { mode: 0o600 });
    writeFileSync(join(dataDir, 'setup-code.issue'), `FBRX Virtual first-time setup code: ${code}\n\n`, { mode: 0o644 });
  } catch {
    /* read-only data folder */
  }
}

export function clearSetupCode(dataDir: string): void {
  for (const f of ['setup-code', 'setup-code.issue']) rmSync(join(dataDir, f), { force: true });
}
