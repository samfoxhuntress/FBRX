import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { RELEASE_MANIFEST_URL, compareSemver, isValidSemver, stageFor } from '@fbrx/shared';
import { type Db, unzip } from '@fbrx/shared/node';

/**
 * New versions of FBRX Command, the way FBRX OS gets its own: offered, never forced.
 *
 * FBRX Command is built from the same FBRX folder as FBRX OS and carries the same version number. It looks at the
 * repository's release.json now and then (90 seconds after it starts, then every six hours) and shows a newer version
 * in the console. "Update now" downloads the new FBRX folder over the one FBRX Command was installed from (keeping
 * that computer's keys and setup files) and starts "Install FBRX Command" there, which stops FBRX Command, rebuilds
 * it and starts it again. Its data (database, keys, certificate, uploads) is never touched.
 */

const ManifestSchema = z
  .object({
    version: z.string().refine(isValidSemver, 'not a version'),
    stage: z.string().max(40).optional(),
    released: z.string().max(40).default(''),
    importance: z.enum(['optional', 'recommended', 'important']).default('recommended'),
    summary: z.string().max(600).default(''),
    notes: z.array(z.string().max(400)).max(40).default([]),
    download: z.string().url(),
    page: z.string().url(),
    /** What is new in FBRX Command itself, when the release says so. */
    command: z.object({ summary: z.string().max(600).default(''), notes: z.array(z.string().max(400)).max(40).default([]) }).optional(),
  })
  // Alpha for 1.x, Beta for 2.x, when release.json does not say.
  .transform((m) => ({ ...m, stage: m.stage ?? stageFor(m.version) }));

export interface CommandRelease {
  version: string;
  stage: string;
  released: string;
  importance: 'optional' | 'recommended' | 'important';
  summary: string;
  notes: string[];
  download: string;
  page: string;
}

export interface CommandUpdateStatus {
  state: 'idle' | 'checking' | 'current' | 'available' | 'error' | 'off';
  currentVersion: string;
  latest: CommandRelease | null;
  checkedAt: string | null;
  message: string | null;
  /** Checks on their own (the console's switch). */
  autoCheck: boolean;
  skipped: boolean;
  /** FBRX Command knows the folder it was installed from, so Update now can do it all. */
  canInstall: boolean;
  installedFrom: string | null;
  installing: { phase: 'downloading' | 'unpacking' | 'starting' | 'started' | 'failed'; pct: number | null; message: string | null } | null;
}

/** Folders in the FBRX folder that belong to this computer and are never overwritten. */
const KEEP = new Set(['.git', '.fbrx-keys', '.fbrx-setup', 'node_modules', 'Share']);
const FIRST_CHECK_MS = 90_000;
const EVERY_MS = 6 * 60 * 60_000;
const META_KEY = 'command.updates';

export interface CommandUpdaterDeps {
  version: string;
  db: Db;
  dataDir: string;
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;
  /** Starts "Install FBRX Command" in the FBRX folder (tests replace it). */
  launchInstaller?: (root: string, home: string) => string;
  manifestUrl?: string;
  fetch?: typeof fetch;
}

interface Saved {
  autoCheck?: boolean;
  skip?: string | null;
}

export class CommandUpdater {
  private state: Omit<CommandUpdateStatus, 'autoCheck' | 'skipped' | 'canInstall' | 'installedFrom'>;
  private timer: NodeJS.Timeout | null = null;
  private busy: Promise<CommandUpdateStatus> | null = null;

  constructor(private readonly d: CommandUpdaterDeps) {
    this.state = { state: 'idle', currentVersion: d.version, latest: null, checkedAt: null, message: null, installing: null };
  }

  private get manifestUrl(): string {
    return this.d.manifestUrl ?? process.env.FBRX_RELEASE_MANIFEST ?? RELEASE_MANIFEST_URL;
  }

  private saved(): Saved {
    try {
      return JSON.parse(this.d.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', META_KEY)?.value ?? '{}') as Saved;
    } catch {
      return {};
    }
  }

  private save(patch: Saved) {
    this.d.db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', META_KEY, JSON.stringify({ ...this.saved(), ...patch }));
  }

  /** Checking is on unless switched off in the console or with FBRX_CP_UPDATE_CHECK=off. */
  autoCheck(): boolean {
    return process.env.FBRX_CP_UPDATE_CHECK !== 'off' && this.saved().autoCheck !== false;
  }

  start(): void {
    this.stop();
    const tick = () => {
      if (this.autoCheck()) void this.check().catch(() => undefined);
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
  }

  /**
   * The FBRX folder FBRX Command was installed from ("Install FBRX Command" writes it into config.json next to the
   * data folder), when it is still there.
   */
  installRoot(): string | null {
    let root = process.env.FBRX_CP_INSTALLED_FROM ?? null;
    if (!root) {
      try {
        root = (JSON.parse(readFileSync(join(dirname(this.d.dataDir), 'config.json'), 'utf8')) as { installedFrom?: string }).installedFrom ?? null;
      } catch {
        return null;
      }
    }
    return root && existsSync(join(root, 'package-lock.json')) && existsSync(join(root, 'scripts', 'setup', 'command.mjs')) ? root : null;
  }

  status(): CommandUpdateStatus {
    const auto = this.autoCheck();
    const root = this.installRoot();
    return {
      ...this.state,
      state: !auto && this.state.state === 'idle' ? 'off' : this.state.state,
      autoCheck: auto,
      skipped: !!this.state.latest && this.saved().skip === this.state.latest.version,
      canInstall: !!root,
      installedFrom: root,
    };
  }

  setAutoCheck(on: boolean): CommandUpdateStatus {
    this.save({ autoCheck: on });
    if (on && this.state.state === 'idle') void this.check().catch(() => undefined);
    return this.status();
  }

  skip(version: string | null): CommandUpdateStatus {
    this.save({ skip: version });
    return this.status();
  }

  /** Looks at release.json in the repository. */
  check(): Promise<CommandUpdateStatus> {
    this.busy ??= this.run().finally(() => (this.busy = null));
    return this.busy;
  }

  private async run(): Promise<CommandUpdateStatus> {
    this.state = { ...this.state, state: 'checking', message: null };
    try {
      const res = await (this.d.fetch ?? fetch)(this.manifestUrl, { headers: { 'user-agent': `FBRX-Command/${this.d.version}`, 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`The release list answered ${res.status}`);
      const m = ManifestSchema.parse(await res.json());
      const latest: CommandRelease = {
        version: m.version,
        stage: m.stage,
        released: m.released,
        importance: m.importance,
        summary: m.command?.summary || m.summary,
        notes: m.command?.notes.length ? m.command.notes : m.notes,
        download: m.download,
        page: m.page,
      };
      const newer = compareSemver(latest.version, this.d.version) > 0;
      this.state = { ...this.state, state: newer ? 'available' : 'current', latest, checkedAt: new Date().toISOString(), message: null };
      this.d.log('info', 'Checked for a new version of FBRX Command', { current: this.d.version, latest: latest.version });
    } catch (e) {
      const message = e instanceof z.ZodError ? 'The release list could not be read' : (e as Error).message;
      this.state = { ...this.state, state: 'error', checkedAt: new Date().toISOString(), message };
      this.d.log('warn', 'Could not check for a new version of FBRX Command', { error: message });
    }
    return this.status();
  }

  /** Downloads the new FBRX folder over the installed-from folder and starts the installer there. */
  install(): CommandUpdateStatus {
    const latest = this.state.latest;
    if (!latest || this.state.state !== 'available') throw new Error('There is no new version to install. Check for updates first.');
    const root = this.installRoot();
    if (!root) throw new Error('FBRX Command does not know which FBRX folder it was installed from. Download the new FBRX zip, unzip it and run "Install FBRX Command" in it.');
    if (this.state.installing && !['failed', 'started'].includes(this.state.installing.phase)) throw new Error('The update is already being prepared');
    const host = new URL(latest.download).hostname;
    if (!['github.com', 'codeload.github.com', new URL(this.manifestUrl).hostname].includes(host)) throw new Error(`Downloads are only taken from GitHub (not ${host})`);
    void this.prepare(latest, root);
    return this.status();
  }

  private setInstalling(installing: CommandUpdateStatus['installing']) {
    this.state = { ...this.state, installing };
  }

  private async prepare(latest: CommandRelease, root: string): Promise<void> {
    const work = mkdtempSync(join(tmpdir(), 'fbrx-command-update-'));
    try {
      this.setInstalling({ phase: 'downloading', pct: 0, message: null });
      const res = await (this.d.fetch ?? fetch)(latest.download, { headers: { 'user-agent': `FBRX-Command/${this.d.version}` }, signal: AbortSignal.timeout(10 * 60_000) });
      if (!res.ok || !res.body) throw new Error(`The download answered ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      let got = 0;
      const zip = join(work, 'fbrx.zip');
      const counter = Readable.fromWeb(res.body as never).on('data', (c: Buffer) => {
        got += c.length;
        this.setInstalling({ phase: 'downloading', pct: total ? Math.round((got / total) * 100) : null, message: `${(got / 1e6).toFixed(1)} MB` });
      });
      await pipeline(counter, createWriteStream(zip));

      this.setInstalling({ phase: 'unpacking', pct: null, message: null });
      const out = join(work, 'x');
      unzip(zip, out);
      const top = readdirSync(out)
        .map((n) => join(out, n))
        .find((p) => existsSync(join(p, 'package-lock.json')) && existsSync(join(p, 'scripts', 'setup', 'command.mjs')));
      if (!top) throw new Error('The download does not look like FBRX');
      const pkg = JSON.parse(readFileSync(join(top, 'apps', 'desktop', 'package.json'), 'utf8')) as { version?: string };
      if (pkg.version !== latest.version) throw new Error(`The download holds version ${pkg.version ?? 'unknown'}, not ${latest.version}`);
      cpSync(top, root, { recursive: true, force: true, filter: (src) => !KEEP.has(src.slice(top.length + 1).split(/[\\/]/)[0]) });
      if (process.platform !== 'win32') chmodSync(join(root, 'Install FBRX Command.command'), 0o755);

      this.setInstalling({ phase: 'starting', pct: null, message: null });
      const message = (this.d.launchInstaller ?? launchInstaller)(root, dirname(this.d.dataDir));
      this.d.log('info', 'FBRX Command update prepared; installer started', { version: latest.version, root });
      this.setInstalling({ phase: 'started', pct: null, message });
    } catch (e) {
      this.d.log('error', 'FBRX Command update failed', { error: (e as Error).message });
      this.setInstalling({ phase: 'failed', pct: null, message: (e as Error).message });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

/**
 * Starts "Install FBRX Command" in the FBRX folder, apart from this process (it stops FBRX Command, rebuilds it and
 * starts it again). Returns what to tell the person.
 */
function launchInstaller(root: string, home: string): string {
  if (process.platform === 'win32') {
    const cmd = join(root, 'Install FBRX Command.cmd');
    spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start', '"FBRX Command update"', '/D', `"${root}"`, `"${cmd}"`, '--yes', '--no-open'], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
    return 'The installer is running in its own window on the FBRX Command computer. FBRX Command stops, updates and starts again by itself (a few minutes); then reload this page.';
  }
  if (process.platform === 'darwin') {
    spawn('open', ['-a', 'Terminal', join(root, 'Install FBRX Command.command')], { detached: true, stdio: 'ignore' }).unref();
    return 'The installer opened in Terminal on the FBRX Command computer: press Return there to start. FBRX Command stops, updates and starts again by itself; then reload this page.';
  }
  // Linux: run the setup in the background with a copy of this Node.js (the installed one is replaced as it runs).
  const work = mkdtempSync(join(tmpdir(), 'fbrx-command-node-'));
  const node = join(work, basename(process.execPath));
  copyFileSync(process.execPath, node);
  chmodSync(node, 0o755);
  mkdirSync(join(home, 'logs'), { recursive: true });
  const out = openSync(join(home, 'logs', 'update.log'), 'a');
  spawn(node, [join(root, 'scripts', 'setup', 'command.mjs'), '--yes', '--no-open'], { cwd: root, detached: true, stdio: ['ignore', out, out] }).unref();
  return `The installer is running on the FBRX Command computer (its log: ${join(home, 'logs', 'update.log')}). FBRX Command stops, updates and starts again by itself (a few minutes); then reload this page.`;
}
