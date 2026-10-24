import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SettingsService } from '../settings/settings-service';
import type { PolicyEngine } from '../governance/policy-engine';
import { canonicalPath, expandPathVars, isWithin } from '../governance/path-guard';
import type { SpecialDirs } from '../platform';
import { safeFileName } from '../util/misc';

/**
 * Where what the agent makes is saved: the folder chosen in Settings (Documents/FBRX at first) when the policy lets the
 * AI write there, otherwise Documents inside FBRX's workspace. A new file never replaces one already there.
 */
export class OutputFolder {
  constructor(private readonly d: { settings: SettingsService; policy: PolicyEngine; workspace: string; dirs: () => SpecialDirs & { workspace: string; data: string } }) {}

  /** The folder chosen in Settings, as a path. */
  chosen(): string {
    return expandPathVars(this.d.settings.get().ai.outputFolder, this.d.dirs());
  }

  /** Whether the AI may save in the chosen folder (its policy's folders include it). */
  allowed(): boolean {
    const chosen = this.chosen();
    return this.d.policy.allowedRoots().some((r) => isWithin(chosen, r));
  }

  path(): string {
    return this.allowed() ? this.chosen() : join(this.d.workspace, 'Documents');
  }

  /** A path for a new file named after `title`, with " (2)", " (3)"… when the name is taken. */
  newFile(title: string, ext: string, sub = ''): string {
    const dir = sub ? join(this.path(), sub) : this.path();
    const base = safeFileName(title.replace(/\.[a-z0-9]{1,5}$/i, ''), 80);
    for (let n = 1; ; n++) {
      const file = join(dir, `${base}${n > 1 ? ` (${n})` : ''}.${ext}`);
      if (!existsSync(file)) return file;
    }
  }

  /** Whether a file is something the agent made or was given: in the output folder or the workspace. */
  holds(file: string): boolean {
    const real = canonicalPath(file);
    return isWithin(real, canonicalPath(this.path())) || isWithin(real, canonicalPath(this.d.workspace));
  }
}
