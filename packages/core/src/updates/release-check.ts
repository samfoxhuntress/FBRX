import { spawn } from 'node:child_process';
import { chmodSync, cpSync, createWriteStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { RELEASE_MANIFEST_URL, compareSemver, isValidSemver, type ReleaseCheck, type ReleaseInfo, type Settings } from '@fbrx/shared';
import { CoreError } from '../errors';
import type { EventBus } from '../events';
import type { Logger } from '../logger';
import { unzip } from '../util/unzip';

/**
 * New versions of FBRX OS, offered rather than forced.
 *
 * FBRX OS is installed from a downloaded copy of its repository (the setup wizard builds and installs the app from
 * that folder). The repository carries release.json; this checks it now and then, tells the person when there is a
 * newer version, and, when asked, downloads the new version into the same folder and starts the installer there,
 * exactly what the person would otherwise do by hand. The installer closes FBRX, updates it and reopens it.
 */

const ManifestSchema = z.object({
  version: z.string().refine(isValidSemver, 'not a version'),
  stage: z.string().max(40).default('Alpha'),
  codename: z.string().max(60).default(''),
  released: z.string().max(40).default(''),
  importance: z.enum(['optional', 'recommended', 'important']).default('recommended'),
  summary: z.string().max(600).default(''),
  notes: z.array(z.string().max(400)).max(40).default([]),
  download: z.string().url(),
  page: z.string().url(),
});

/** Written by the setup wizard into the data folder: where FBRX was installed from. */
export const INSTALL_SOURCE_FILE = 'install-source.json';
const STATE_FILE = 'release-state.json';
/** Folders in the install folder that belong to this computer and are never overwritten. */
const KEEP = new Set(['.git', '.fbrx-keys', '.fbrx-setup', 'node_modules', 'Share']);
const FIRST_CHECK_MS = 90_000;
const EVERY_MS = 6 * 60 * 60_000;

export interface ReleaseCheckerDeps {
  appVersion: string;
  dataRoot: string;
  settings: () => Settings;
  skip: (version: string) => void;
  events: EventBus;
  log: Logger;
  internet: () => boolean;
  /** Raises the "update available" alert (inbox and notification). */
  notify: (title: string, body: string, version: string) => Promise<unknown>;
  /** Starts the installer in the install folder (tests replace it). */
  launchInstaller?: (root: string) => string;
  /** A good moment to install by itself (nobody presenting, the agent idle, the computer not in use). */
  quiet?: () => boolean;
}

export class ReleaseChecker {
  private state: ReleaseCheck;
  private timer: NodeJS.Timeout | null = null;
  private busy: Promise<ReleaseCheck> | null = null;

  constructor(private readonly d: ReleaseCheckerDeps) {
    this.state = { state: 'idle', currentVersion: d.appVersion, latest: null, checkedAt: null, message: null, skipped: false, canInstall: false, installing: null };
  }

  private get manifestUrl(): string {
    return process.env.FBRX_RELEASE_MANIFEST || RELEASE_MANIFEST_URL;
  }

  start(): void {
    this.stop();
    const tick = () => {
      if (this.d.settings().updates.checkRepo && this.d.internet()) void this.check().catch(() => undefined);
    };
    this.timer = setTimeout(() => {
      tick();
      this.timer = setInterval(tick, EVERY_MS);
      this.timer.unref?.();
    }, FIRST_CHECK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = null;
  }

  status(): ReleaseCheck {
    const off = !this.d.settings().updates.checkRepo && this.state.state === 'idle';
    return { ...this.state, state: off ? 'off' : this.state.state, skipped: !!this.state.latest && this.d.settings().updates.skipVersion === this.state.latest.version, canInstall: !!this.installRoot() };
  }

  private set(patch: Partial<ReleaseCheck>) {
    this.state = { ...this.state, ...patch };
    this.d.events.emit('release.changed', this.status());
  }

  /** Looks at release.json in the repository. */
  check(): Promise<ReleaseCheck> {
    this.busy ??= this.run().finally(() => (this.busy = null));
    return this.busy;
  }

  private async run(): Promise<ReleaseCheck> {
    if (!this.d.internet()) throw new CoreError('POLICY_DENIED', 'Your organization blocks internet access from FBRX OS');
    this.set({ state: 'checking', message: null });
    try {
      const res = await fetch(this.manifestUrl, { headers: { 'user-agent': `FBRX-OS/${this.d.appVersion}`, 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`The release list answered ${res.status}`);
      const latest: ReleaseInfo = ManifestSchema.parse(await res.json());
      const newer = compareSemver(latest.version, this.d.appVersion) > 0;
      this.set({ state: newer ? 'available' : 'current', latest, checkedAt: new Date().toISOString(), message: null });
      this.d.log.info('Checked for a new version', { current: this.d.appVersion, latest: latest.version });
      if (newer) this.maybeAutoInstall();
      if (newer && !this.d.settings().updates.autoInstall && this.d.settings().updates.skipVersion !== latest.version && this.readState().notified !== latest.version) {
        this.writeState({ notified: latest.version });
        await this.d.notify(
          `FBRX OS ${latest.stage} ${latest.version} is available`,
          `${latest.summary || 'A new version is ready.'} Open Settings → Updates to install it when it suits you.`,
          latest.version,
        );
      }
    } catch (e) {
      const message = e instanceof z.ZodError ? 'The release list could not be read' : (e as Error).message;
      this.set({ state: 'error', checkedAt: new Date().toISOString(), message });
      this.d.log.warn('Could not check for a new version', { error: message });
    }
    return this.status();
  }

  private readonly autoTried = new Set<string>();
  private autoTimer: NodeJS.Timeout | null = null;

  /**
   * "Install automatically" (Settings → Updates, or the organization's FBRX Command): installs a newer version from the
   * repository by itself, once per version, waiting for a quiet moment so it never interrupts a lesson.
   */
  private maybeAutoInstall(): void {
    const s = this.d.settings().updates;
    const latest = this.state.latest;
    if (!s.autoInstall || !latest || this.state.state !== 'available' || s.skipVersion === latest.version || !this.installRoot()) return;
    if (this.autoTried.has(latest.version) || (this.state.installing && this.state.installing.phase !== 'failed')) return;
    if (this.d.quiet && !this.d.quiet()) {
      if (!this.autoTimer) {
        this.autoTimer = setTimeout(() => {
          this.autoTimer = null;
          this.maybeAutoInstall();
        }, 10 * 60_000);
        this.autoTimer.unref?.();
      }
      return;
    }
    this.autoTried.add(latest.version);
    this.d.log.info('Installing the new version automatically', { version: latest.version });
    try {
      this.install();
    } catch (e) {
      this.d.log.warn('Automatic update could not start', { error: (e as Error).message });
    }
  }

  skip(version: string): ReleaseCheck {
    this.d.skip(version);
    this.d.events.emit('release.changed', this.status());
    return this.status();
  }

  /** The folder the setup wizard installed from, when it is still there. */
  installRoot(): string | null {
    try {
      const { root } = JSON.parse(readFileSync(join(this.d.dataRoot, INSTALL_SOURCE_FILE), 'utf8')) as { root?: string };
      return root && existsSync(join(root, 'package-lock.json')) && existsSync(join(root, 'apps', 'desktop')) ? root : null;
    } catch {
      return null;
    }
  }

  /** Downloads the new version into the install folder and starts the installer. Progress arrives as release.changed. */
  install(): ReleaseCheck {
    const latest = this.state.latest;
    if (!latest || this.state.state !== 'available') throw new CoreError('CONFLICT', 'There is no new version to install. Check for updates first.');
    const root = this.installRoot();
    if (!root) throw new CoreError('CONFLICT', 'FBRX OS does not know which folder it was installed from. Download the new version and run the installer in it.');
    if (this.state.installing && !['failed', 'started'].includes(this.state.installing.phase)) throw new CoreError('CONFLICT', 'The update is already being prepared');
    const host = new URL(latest.download).hostname;
    if (!['github.com', 'codeload.github.com', new URL(this.manifestUrl).hostname].includes(host)) throw new CoreError('FORBIDDEN', `Downloads are only taken from GitHub (not ${host})`);
    void this.prepare(latest, root);
    return this.status();
  }

  private async prepare(latest: ReleaseInfo, root: string): Promise<void> {
    const work = mkdtempSync(join(tmpdir(), 'fbrx-update-'));
    try {
      this.set({ installing: { phase: 'downloading', pct: 0, message: null } });
      const res = await fetch(latest.download, { headers: { 'user-agent': `FBRX-OS/${this.d.appVersion}` }, signal: AbortSignal.timeout(10 * 60_000) });
      if (!res.ok || !res.body) throw new Error(`The download answered ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      let got = 0;
      let last = 0;
      const zip = join(work, 'fbrx.zip');
      const counter = Readable.fromWeb(res.body as never).on('data', (c: Buffer) => {
        got += c.length;
        if (Date.now() - last > 250) {
          last = Date.now();
          this.set({ installing: { phase: 'downloading', pct: total ? Math.round((got / total) * 100) : null, message: `${(got / 1e6).toFixed(1)} MB` } });
        }
      });
      await pipeline(counter, createWriteStream(zip));

      this.set({ installing: { phase: 'unpacking', pct: null, message: null } });
      const out = join(work, 'x');
      unzip(zip, out);
      const top = readdirSync(out).map((n) => join(out, n)).find((p) => existsSync(join(p, 'package-lock.json')));
      if (!top) throw new Error('The download does not look like FBRX OS');
      const pkg = JSON.parse(readFileSync(join(top, 'apps', 'desktop', 'package.json'), 'utf8')) as { version?: string };
      if (pkg.version !== latest.version) throw new Error(`The download holds version ${pkg.version ?? 'unknown'}, not ${latest.version}`);
      cpSync(top, root, { recursive: true, force: true, filter: (src) => !KEEP.has(src.slice(top.length + 1).split(/[\\/]/)[0]) });
      if (process.platform !== 'win32') chmodSync(join(root, 'Install FBRX OS.command'), 0o755);

      this.set({ installing: { phase: 'starting', pct: null, message: null } });
      const message = (this.d.launchInstaller ?? launchInstaller)(root);
      this.d.log.info('Update prepared; installer started', { version: latest.version, root });
      this.set({ installing: { phase: 'started', pct: null, message } });
    } catch (e) {
      this.d.log.error('Update failed', e);
      this.set({ installing: { phase: 'failed', pct: null, message: (e as Error).message } });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  private readState(): { notified?: string } {
    try {
      return JSON.parse(readFileSync(join(this.d.dataRoot, STATE_FILE), 'utf8'));
    } catch {
      return {};
    }
  }

  private writeState(s: { notified?: string }) {
    try {
      writeFileSync(join(this.d.dataRoot, STATE_FILE), JSON.stringify(s));
    } catch {
      /* only means the reminder may come again */
    }
  }
}

/** Opens the installer in its own window, where the person can follow it. Returns what to tell them. */
function launchInstaller(root: string): string {
  if (process.platform === 'win32') {
    const cmd = join(root, 'Install FBRX OS.cmd');
    spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start', '"FBRX OS update"', '/D', `"${root}"`, `"${cmd}"`, '--yes'], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
    return 'The installer is running in its own window. FBRX OS closes, updates and opens again by itself (a few minutes).';
  }
  if (process.platform === 'darwin') {
    spawn('open', ['-a', 'Terminal', join(root, 'Install FBRX OS.command')], { detached: true, stdio: 'ignore' }).unref();
    return 'The installer opened in Terminal: press Return to start. FBRX OS closes, updates and opens again by itself.';
  }
  spawn('xdg-open', [root], { detached: true, stdio: 'ignore' }).unref();
  return `The new version is in ${root}. Run the installer there to finish.`;
}
