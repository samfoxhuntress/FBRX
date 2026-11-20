import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { APP_IDS, FBRX_APPS, appUnlocked, type AppId, type AppPresence, type AppStatus, type Tier } from '@fbrx/shared';
import { CoreError } from '../errors';
import type { SharedLicense } from '../license/license-service';
import { downloadAndOpen } from './app-installer';

/** Where an app's own record goes, in its data folder. */
export const PRESENCE_FILE = 'app.json';
/** Where FBRX Endpoint shares its license with the other FBRX apps, in its data folder (see SharedLicense). */
export const SHARED_LICENSE_FILE = 'apps-license.json';
/**
 * What FBRX Endpoint hands to FBRX Digger (2.5.0): its saved connections and network environments, without passwords
 * or API keys, which stay in Endpoint's vault. Digger takes each in once.
 */
export const HANDOVER_FILE = 'apps-handover.json';

export interface AppRegistryDeps {
  /** The app running now. */
  self: AppId;
  /** Its data folder (it writes app.json there). */
  dataDir: string;
  /**
   * The folder that holds every FBRX app's data folder (each named after its app), or null where apps are not side by
   * side (a server).
   */
  appsDir: string | null;
  version: string;
  /** The program that starts this app, written so the others can open it. */
  exec: string | null;
  tier: () => Tier;
  /** The latest release of each app, from release.json, for "Get". */
  releases: () => Partial<Record<AppId, { version: string; download: string }>>;
  /** Starts a program on its own (tests pass a fake). */
  launch?: (exec: string) => void;
  /** Where Get saves an installer: the person's Downloads folder and home (a Linux AppImage goes to ~/Applications). */
  dirs?: { downloads: string; home: string };
  /** Downloads and opens an app's installer (tests pass a fake). */
  install?: typeof downloadAndOpen;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

const plain = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The program name an app's record may name: its own app's, so a record cannot point the Endpoint at anything else.
 * An app's program carries its name or its data folder's ("FBRX OS.exe", fbrx-os, "FBRX Digger.app"); an AppImage
 * adds its version and machine ("FBRX-Digger-1.3.0-x86_64.AppImage").
 */
export function looksLike(id: AppId, exec: string): boolean {
  const names = new Set([plain(FBRX_APPS[id].name), plain(FBRX_APPS[id].folder)]);
  const file = basename(exec.replace(/\\/g, '/'));
  const name = plain(file.replace(/\.(exe|appimage)$/i, ''));
  const appImage = /\.appimage$/i.test(file) && [...names].some((n) => new RegExp(`^${n}\\d[0-9a-z]*$`).test(name));
  // On a Mac the program sits inside "FBRX Digger.app/Contents/MacOS/".
  const bundle = /\/([^/]+)\.app\/contents\/macos\/[^/]+$/i.exec(exec.replace(/\\/g, '/'))?.[1];
  return names.has(name) || appImage || (!!bundle && names.has(plain(bundle)));
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
      const raw = JSON.parse(readFileSync(join(this.d.appsDir, FBRX_APPS[id].folder, PRESENCE_FILE), 'utf8')) as Partial<AppPresence>;
      if (raw.id !== id || typeof raw.exec !== 'string' || typeof raw.version !== 'string') return null;
      if (!looksLike(id, raw.exec) || !existsSync(raw.exec)) return null;
      return { id, version: raw.version.slice(0, 40), exec: raw.exec, at: String(raw.at ?? '') };
    } catch {
      return null;
    }
  }

  /** FBRX Endpoint: writes a file in its data folder for the other FBRX apps on this computer (its user's alone). */
  share(file: string, data: unknown): void {
    if (this.d.self !== 'os' || !this.d.appsDir) return;
    try {
      writeFileSync(join(this.d.dataDir, file), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    } catch (err) {
      this.d.log?.('could not share a file with the other FBRX apps', { file, error: (err as Error).message });
    }
  }

  /** Another app: a file FBRX Endpoint shared, when Endpoint is installed on this computer (null otherwise). */
  fromEndpoint(file: string): Record<string, unknown> | null {
    if (this.d.self === 'os' || !this.d.appsDir || !this.presence('os')) return null;
    try {
      const raw = JSON.parse(readFileSync(join(this.d.appsDir, FBRX_APPS.os.folder, file), 'utf8')) as unknown;
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /** FBRX Endpoint: shares its license with the other FBRX apps on this computer (FBRX Digger runs at its edition). */
  shareLicense(license: SharedLicense): void {
    this.share(SHARED_LICENSE_FILE, license);
  }

  /** Another app: FBRX Endpoint's license, when Endpoint is installed on this computer (null otherwise). */
  endpointLicense(): SharedLicense | null {
    return this.fromEndpoint(SHARED_LICENSE_FILE) as SharedLicense | null;
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

  /**
   * Gets an app the edition unlocks and this computer does not have (the person at the computer asked): its installer
   * for this computer, from its latest release on GitHub, checked and opened.
   */
  async get(id: AppId): Promise<{ file: string; name: string }> {
    const a = FBRX_APPS[id];
    if (id === this.d.self) throw new CoreError('INVALID_ARGUMENT', `This is ${a.name}`);
    if (!a.built) throw new CoreError('NOT_FOUND', `${a.name} arrives in ${a.since}`);
    if (!appUnlocked(id, this.d.tier())) throw new CoreError('FORBIDDEN', `${a.name} comes with a fuller edition`);
    const release = this.d.releases()[id];
    if (!release) throw new CoreError('NOT_FOUND', `${a.name} has no release yet`);
    if (!this.d.dirs) throw new CoreError('UNAVAILABLE', 'Apps are got from the desktop app');
    const got = await (this.d.install ?? downloadAndOpen)(id, { tag: `${a.tag}${release.version}`, downloads: this.d.dirs.downloads, home: this.d.dirs.home });
    this.d.log?.('got an app', { id, file: got.file });
    return got;
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
