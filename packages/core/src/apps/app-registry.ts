import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { APP_IDS, FBRX_APPS, appUnlocked, type AppId, type AppPresence, type AppStatus, type Tier } from '@fbrx/shared';
import { CoreError } from '../errors';

/** Where an app's own record goes, in its data folder. */
export const PRESENCE_FILE = 'app.json';

export interface AppRegistryDeps {
  /** The app running now. */
  self: AppId;
  /** Its data folder (it writes app.json there). */
  dataDir: string;
  /** The folder that holds every FBRX app's data folder (each named after its app), or null where apps are not side by side (a server). */
  appsDir: string | null;
  version: string;
  /** The program that starts this app, written so the others can open it. */
  exec: string | null;
  tier: () => Tier;
  /** The latest release of each app, from release.json, for "Get". */
  releases: () => Partial<Record<AppId, { version: string; download: string }>>;
  /** Starts a program on its own (tests pass a fake). */
  launch?: (exec: string) => void;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

/** The program name an app's record may name: its own app's, so a record cannot point the Endpoint at anything else. */
function looksLike(id: AppId, exec: string): boolean {
  const want = FBRX_APPS[id].name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const name = basename(exec).toLowerCase().replace(/\.(exe|appimage)$/, '').replace(/[^a-z0-9]/g, '');
  // On a Mac the program sits inside "FBRX Digger.app/Contents/MacOS/".
  const bundle = /\/([^/]+)\.app\/contents\/macos\/[^/]+$/i.exec(exec.replace(/\\/g, '/'))?.[1]?.toLowerCase().replace(/[^a-z0-9]/g, '');
  return name === want || bundle === want || (id === 'digger' && name === 'fbrxdigger');
}

/**
 * The FBRX app family on this computer. Each app writes app.json in its data folder when it starts (its id, version and
 * the program that starts it); the others read those to know what is installed. The Endpoint lists the family (Settings
 * → FBRX apps) and opens an installed app for a page another app has taken (the Network Center's Digger tab).
 */
export class AppRegistry {
  constructor(private readonly d: AppRegistryDeps) {}

  /** Writes this app's record, so the others know it is here. */
  announce(): void {
    if (!this.d.exec) return;
    const me: AppPresence = { id: this.d.self, version: this.d.version, exec: this.d.exec, at: new Date().toISOString() };
    try {
      writeFileSync(join(this.d.dataDir, PRESENCE_FILE), `${JSON.stringify(me, null, 2)}\n`);
    } catch (err) {
      this.d.log?.('could not write app.json', { error: (err as Error).message });
    }
  }

  /** Another app's record, when it is installed here and its program is still there. */
  presence(id: AppId): AppPresence | null {
    if (!this.d.appsDir || id === this.d.self) return null;
    try {
      const raw = JSON.parse(readFileSync(join(this.d.appsDir, FBRX_APPS[id].name, PRESENCE_FILE), 'utf8')) as Partial<AppPresence>;
      if (raw.id !== id || typeof raw.exec !== 'string' || typeof raw.version !== 'string') return null;
      if (!looksLike(id, raw.exec) || !existsSync(raw.exec)) return null;
      return { id, version: raw.version.slice(0, 40), exec: raw.exec, at: String(raw.at ?? '') };
    } catch {
      return null;
    }
  }

  installed(): AppId[] {
    return APP_IDS.filter((id) => !!this.presence(id));
  }

  list(): AppStatus[] {
    const tier = this.d.tier();
    const releases = this.d.releases();
    return APP_IDS.map((id) => {
      const a = FBRX_APPS[id];
      const self = id === this.d.self;
      const here = self ? null : this.presence(id);
      return {
        id,
        name: a.name,
        short: a.short,
        what: a.what,
        edition: a.edition,
        since: a.since,
        built: a.built,
        self,
        installed: self || !!here,
        version: self ? this.d.version : (here?.version ?? null),
        unlocked: appUnlocked(id, tier),
        download: releases[id]?.download ?? null,
      };
    });
  }

  /** Opens an installed app (the person at the computer asked). */
  open(id: AppId): { opened: AppId } {
    if (id === this.d.self) throw new CoreError('INVALID_ARGUMENT', `This is ${FBRX_APPS[id].name}`);
    if (!appUnlocked(id, this.d.tier())) throw new CoreError('FORBIDDEN', `${FBRX_APPS[id].name} comes with a fuller edition`);
    const here = this.presence(id);
    if (!here) throw new CoreError('NOT_FOUND', `${FBRX_APPS[id].name} is not installed on this computer`);
    const launch =
      this.d.launch ??
      ((exec: string) => {
        const child = spawn(exec, [], { detached: true, stdio: 'ignore' });
        child.on('error', (err) => this.d.log?.('could not open an app', { exec, error: err.message }));
        child.unref();
      });
    launch(here.exec);
    return { opened: id };
  }
}
