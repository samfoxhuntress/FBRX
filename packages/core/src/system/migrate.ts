import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, copyFile, mkdir, readdir, rm, rmdir, stat, unlink, utimes } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { newId, type MigrateEngineInfo, type MigrateEvent, type MigrateJob, type MigrateRequest } from '@fbrx/shared';
import { CoreError, errorMessage } from '../errors';
import type { EventBus } from '../events';
import type { Logger } from '../logger';

/**
 * Copy & migrate: moves data between folders, drives and network shares with Robocopy (Windows), rsync (macOS and
 * Linux) or FBRX's own copier (everywhere). Commands run without a shell, from argument lists, and a few guard
 * rails stop the classic accidents: mirroring onto a drive root or system folder, copying a folder into itself,
 * and moving away a whole drive or home folder.
 */

const JUNK_FILES = ['Thumbs.db', 'desktop.ini', '.DS_Store', '~$*', '*.tmp', '*.temp'];
const JUNK_DIRS = ['$RECYCLE.BIN', 'System Volume Information', '.Trash', '.Trashes', 'node_modules/.cache'];

function which(cmd: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const p = join(dir, process.platform === 'win32' ? `${cmd}.exe` : cmd);
    if (dir && existsSync(p)) return p;
  }
  return null;
}

function robocopyPath(): string | null {
  if (process.platform !== 'win32') return null;
  const p = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'robocopy.exe');
  return existsSync(p) ? p : which('robocopy');
}

/** A path as the copy tools want it: absolute, no trailing separator (a quoted "C:\Data\" confuses Robocopy). */
function clean(p: string): string {
  const r = resolve(p.trim());
  const root = parse(r).root;
  if (r === root) return process.platform === 'win32' ? `${root}.` : root;
  return r.replace(/[\\/]+$/, '');
}

const isRoot = (p: string) => {
  const r = resolve(p);
  return r === parse(r).root;
};

/**
 * Folders that must never be mirrored onto or moved away: system folders, including everything inside them, and
 * the folders that hold people's files (home, Users), themselves only, so a backup into Documents\Backup is fine.
 */
function protectedPaths(): { tree: string[]; exact: string[] } {
  const key = (p: string) => resolve(p).toLowerCase();
  if (process.platform === 'win32') {
    const sys = process.env.SystemRoot ?? 'C:\\Windows';
    return {
      tree: [sys, process.env.ProgramFiles ?? 'C:\\Program Files', process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', process.env.ProgramData ?? 'C:\\ProgramData'].map(key),
      exact: [homedir(), join(parse(sys).root, 'Users')].map(key),
    };
  }
  return {
    tree: ['/System', '/usr', '/bin', '/sbin', '/etc', '/boot', '/dev', '/proc', '/sys'].map(key),
    exact: [homedir(), '/Users', '/home', '/var', '/opt', '/Library', '/Applications', '/private'].map(key),
  };
}

const inside = (child: string, parent: string) => {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const globToRegex = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');

export class Migrator {
  private readonly jobs = new Map<string, MigrateJob & { child?: ChildProcess; abort?: AbortController }>();

  constructor(
    private readonly d: {
      events: EventBus;
      log: Logger;
      audit: (action: string, outcome: 'success' | 'failure' | 'info', details: Record<string, unknown>) => void;
    },
  ) {}

  engines(): MigrateEngineInfo[] {
    const robo = robocopyPath();
    const rsync = process.platform === 'win32' ? null : which('rsync');
    return [
      { id: 'robocopy', name: 'Robocopy', available: !!robo, note: robo ? 'Windows\' robust file copy: retries, multi-threaded, keeps permissions and timestamps' : 'Windows only' },
      { id: 'rsync', name: 'rsync', available: !!rsync, note: rsync ? 'The standard copier on macOS and Linux' : process.platform === 'win32' ? 'macOS and Linux' : 'Not installed' },
      { id: 'builtin', name: 'FBRX copier', available: true, note: 'Works everywhere; keeps timestamps' },
    ];
  }

  /** Checks a request and returns the problems that stop it (thrown) and the ones to warn about. */
  private check(r: MigrateRequest): { source: string; dest: string; warnings: string[] } {
    if (!r.source?.trim() || !r.dest?.trim()) throw new CoreError('INVALID_ARGUMENT', 'Choose a source and a destination folder');
    if (/["\r\n\0]/.test(r.source + r.dest)) throw new CoreError('INVALID_ARGUMENT', 'Folder paths cannot contain quotes or line breaks');
    if (!isAbsolute(r.source.trim()) || !isAbsolute(r.dest.trim())) throw new CoreError('INVALID_ARGUMENT', 'Use full folder paths (for example C:\\Users\\you\\Documents or \\\\server\\share)');
    const source = clean(r.source);
    const dest = clean(r.dest);
    let st;
    try {
      st = statSync(source);
    } catch {
      throw new CoreError('NOT_FOUND', `The source folder ${source} does not exist or cannot be read`);
    }
    if (!st.isDirectory()) throw new CoreError('INVALID_ARGUMENT', 'The source must be a folder');
    if (resolve(source).toLowerCase() === resolve(dest).toLowerCase()) throw new CoreError('INVALID_ARGUMENT', 'The source and the destination are the same folder');
    if (inside(dest, source)) throw new CoreError('INVALID_ARGUMENT', 'The destination is inside the source; that would copy the folder into itself forever');
    const prot = protectedPaths();
    const isProtected = (p: string) => {
      const k = resolve(p).toLowerCase();
      return prot.exact.includes(k) || prot.tree.some((t) => inside(k, t));
    };
    if (r.mode === 'mirror') {
      if (isRoot(dest)) throw new CoreError('FORBIDDEN', 'Mirroring onto a whole drive would delete everything on it that is not in the source. Mirror into a folder on the drive instead.');
      if (isProtected(dest)) throw new CoreError('FORBIDDEN', `FBRX will not mirror onto ${dest}: it is a system or home folder`);
      if (inside(source, dest)) throw new CoreError('INVALID_ARGUMENT', 'The source is inside the destination; mirroring would delete it');
    }
    if (r.mode === 'move') {
      if (isRoot(source)) throw new CoreError('FORBIDDEN', 'FBRX will not move a whole drive. Copy it instead.');
      if (isProtected(source)) throw new CoreError('FORBIDDEN', `FBRX will not move ${source} away: it is a system or home folder. Copy it instead.`);
    }
    const warnings: string[] = [];
    if (r.mode === 'mirror') warnings.push(`Mirror deletes files in ${dest} that are not in ${source}.`);
    if (r.mode === 'move') warnings.push(`Move deletes the originals in ${source} after they are copied.`);
    if (r.permissions && r.engine === 'robocopy') warnings.push('Copying permissions may need FBRX to run as administrator for files you do not own.');
    if (r.engine === 'builtin' && r.permissions) warnings.push('The FBRX copier keeps file modes but not owners or Windows permissions; use Robocopy for those.');
    if (!existsSync(dest)) warnings.push(`${dest} does not exist yet; it will be created.`);
    return { source, dest, warnings };
  }

  /** The command line for Robocopy or rsync (arguments, then a readable version). */
  private command(r: MigrateRequest, source: string, dest: string): { bin: string; args: string[] } | null {
    const retries = Math.max(0, Math.min(10, Math.round(r.retries ?? 2)));
    const excludeFiles = [...(r.excludeFiles ?? []), ...(r.skipJunk ? JUNK_FILES : [])].map((x) => x.trim()).filter(Boolean);
    const excludeDirs = [...(r.excludeDirs ?? []), ...(r.skipJunk ? JUNK_DIRS : [])].map((x) => x.trim()).filter(Boolean);
    if (r.engine === 'robocopy') {
      const bin = robocopyPath();
      if (!bin) throw new CoreError('UNAVAILABLE', 'Robocopy is part of Windows; use the FBRX copier on this computer');
      const sub = r.subfolders !== false;
      const args = [source, dest];
      if (r.mode === 'mirror') args.push('/MIR');
      else if (sub) args.push('/E');
      if (r.mode === 'update') args.push('/XO');
      if (r.mode === 'move') args.push('/MOVE');
      args.push(r.permissions ? '/COPY:DATS' : '/COPY:DAT', '/DCOPY:DAT', `/R:${retries}`, '/W:2');
      const threads = Math.max(1, Math.min(64, Math.round(r.threads ?? 8)));
      if (threads > 1) args.push(`/MT:${threads}`);
      if (excludeFiles.length) args.push('/XF', ...excludeFiles);
      if (excludeDirs.length) args.push('/XD', ...excludeDirs);
      if (r.dryRun) args.push('/L');
      // One line per file, sizes in bytes, no per-file percentages, no folder list: easy to follow and to count.
      args.push('/NP', '/NDL', '/BYTES', '/FP');
      return { bin, args };
    }
    if (r.engine === 'rsync') {
      const bin = process.platform === 'win32' ? null : which('rsync');
      if (!bin) throw new CoreError('UNAVAILABLE', 'rsync is not installed on this computer');
      const args = [r.permissions ? '-a' : '-rlt', '-v', '--stats', '--human-readable'];
      if (r.subfolders === false) args.splice(0, 1, r.permissions ? '-lptgoD' : '-lt', '--dirs');
      if (r.mode === 'update') args.push('--update');
      if (r.mode === 'mirror') args.push('--delete');
      if (r.mode === 'move') args.push('--remove-source-files');
      if (r.dryRun) args.push('--dry-run');
      for (const x of excludeFiles) args.push(`--exclude=${x}`);
      for (const x of excludeDirs) args.push(`--exclude=${x}/`);
      // A trailing slash copies the folder's contents into the destination rather than the folder itself.
      args.push(`${source}${source.endsWith('/') ? '' : '/'}`, dest);
      return { bin, args };
    }
    return null;
  }

  plan(r: MigrateRequest): { command: string; warnings: string[] } {
    const { source, dest, warnings } = this.check(r);
    const c = this.command(r, source, dest);
    const q = (a: string) => (/[\s"]/.test(a) ? `"${a}"` : a);
    const command = c ? [process.platform === 'win32' ? 'robocopy' : c.bin.split(/[\\/]/).pop()!, ...c.args.map(q)].join(' ') : `FBRX copier: ${r.mode}${r.dryRun ? ' (preview)' : ''} ${q(source)} → ${q(dest)}`;
    return { command, warnings };
  }

  list(): MigrateJob[] {
    return [...this.jobs.values()].map(({ child: _c, abort: _a, ...j }) => j).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  start(r: MigrateRequest): { jobId: string; command: string } {
    if ([...this.jobs.values()].some((j) => j.state === 'running')) throw new CoreError('CONFLICT', 'A copy is already running. Wait for it or cancel it first.');
    const { source, dest } = this.check(r);
    const { command } = this.plan(r);
    const jobId = newId('mig');
    const job: MigrateJob & { child?: ChildProcess; abort?: AbortController } = { jobId, request: { ...r, source, dest }, state: 'running', startedAt: new Date().toISOString(), finishedAt: null, files: 0, bytes: 0, errors: 0, summary: null };
    this.jobs.set(jobId, job);
    // Keep the last twenty jobs.
    for (const id of [...this.jobs.keys()].slice(0, Math.max(0, this.jobs.size - 20))) if (this.jobs.get(id)!.state !== 'running') this.jobs.delete(id);
    this.d.audit('migrate.start', 'info', { jobId, engine: r.engine, mode: r.mode, source, dest, dryRun: !!r.dryRun });
    const c = this.command(r, source, dest);
    if (c) this.runTool(job, c.bin, c.args);
    else void this.runBuiltin(job, source, dest);
    return { jobId, command };
  }

  /** Stops every running copy (at shutdown). */
  cancelAll(): void {
    for (const j of this.jobs.values()) if (j.state === 'running') this.cancel(j.jobId);
  }

  cancel(jobId: string): void {
    const j = this.jobs.get(jobId);
    if (!j || j.state !== 'running') return;
    j.state = 'canceled';
    j.abort?.abort();
    j.child?.kill();
  }

  private emit(e: MigrateEvent) {
    this.d.events.emit('migrate.event', e);
  }

  /** Collects output lines and sends them a few times a second instead of one event per file. */
  private readonly pending = new Map<string, { lines: string[]; timer: NodeJS.Timeout | null }>();
  private line(jobId: string, text: string) {
    let p = this.pending.get(jobId);
    if (!p) this.pending.set(jobId, (p = { lines: [], timer: null }));
    p.lines.push(text.slice(0, 2000));
    if (p.lines.length > 400) p.lines.splice(0, p.lines.length - 400);
    p.timer ??= setTimeout(() => this.flushLines(jobId), 200);
  }
  private flushLines(jobId: string) {
    const p = this.pending.get(jobId);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(jobId);
    if (p.lines.length) this.emit({ jobId, type: 'lines', lines: p.lines });
  }

  private finish(job: MigrateJob, state: MigrateJob['state'], summary: string) {
    if (job.finishedAt) return;
    this.flushLines(job.jobId);
    if (job.state !== 'canceled') job.state = state;
    job.finishedAt = new Date().toISOString();
    job.summary = job.state === 'canceled' ? `Canceled. ${summary}` : summary;
    const { child: _c, abort: _a, ...visible } = job as MigrateJob & { child?: unknown; abort?: unknown };
    this.d.audit('migrate.finish', job.state === 'done' ? 'success' : job.state === 'canceled' ? 'info' : 'failure', { jobId: job.jobId, state: job.state, files: job.files, bytes: job.bytes, errors: job.errors });
    this.emit({ jobId: job.jobId, type: 'done', job: visible });
  }

  private runTool(job: MigrateJob & { child?: ChildProcess }, bin: string, args: string[]) {
    const robocopy = job.request.engine === 'robocopy';
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      this.finish(job, 'failed', errorMessage(err));
      return;
    }
    job.child = child;
    let buf = '';
    let lastProgress = 0;
    const tail: string[] = [];
    const onLine = (line: string) => {
      const t = line.replace(/\s+$/, '');
      if (!t.trim()) return;
      tail.push(t);
      if (tail.length > 40) tail.shift();
      if (robocopy) {
        // "	    New File  		      1234	C:\path\file" (one per copied file); "ERROR 5 (0x00000005)…" on failures.
        const m = t.match(/^\s*(New File|Newer|Older|Changed|Tweaked|\*EXTRA File)\s+(\d+)\s/i);
        if (m && !/EXTRA/i.test(m[1])) {
          job.files++;
          job.bytes += Number(m[2]);
        }
      } else if (!/^(sending|sent|total|building|created|deleting|Number of|Total|Literal|Matched|File list|\s)/i.test(t) && !t.endsWith('/')) job.files++;
      if (/\bERROR \d+|failed:|rsync error/i.test(t)) job.errors++;
      this.line(job.jobId, t);
      if (Date.now() - lastProgress > 250) {
        lastProgress = Date.now();
        this.emit({ jobId: job.jobId, type: 'progress', files: job.files, bytes: job.bytes, errors: job.errors });
      }
    };
    const feed = (b: Buffer) => {
      buf += b.toString('utf8');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      lines.forEach(onLine);
    };
    child.stdout?.on('data', feed);
    child.stderr?.on('data', feed);
    child.on('error', (err) => this.finish(job, 'failed', errorMessage(err)));
    child.on('close', (code) => {
      if (buf) onLine(buf);
      this.emit({ jobId: job.jobId, type: 'progress', files: job.files, bytes: job.bytes, errors: job.errors });
      const summary = tail.filter((l) => /^\s*(Dirs|Files|Bytes|Times|Speed|Ended)\s*:|^(sent|total size|Number of)/i.test(l)).join('\n');
      // Robocopy's exit code is a bit mask: under 8 means everything that should be copied was copied.
      const ok = robocopy ? code !== null && code < 8 : code === 0 || code === 24;
      const what = robocopy ? robocopyExit(code) : code === 24 ? 'Some files vanished while copying.' : code === 0 ? 'Finished.' : `rsync stopped with code ${code}.`;
      this.finish(job, ok ? 'done' : 'failed', `${what}${summary ? `\n${summary}` : ''}`);
    });
  }

  /** FBRX's own copier: walks the tree, copies new and changed files, keeps timestamps; mirror and move included. */
  private async runBuiltin(job: MigrateJob & { abort?: AbortController }, source: string, dest: string) {
    const r = job.request;
    const abort = new AbortController();
    job.abort = abort;
    const skipFile = [...(r.excludeFiles ?? []), ...(r.skipJunk ? JUNK_FILES : [])].filter(Boolean).map(globToRegex);
    const skipDir = [...(r.excludeDirs ?? []), ...(r.skipJunk ? JUNK_DIRS : [])].filter(Boolean).map(globToRegex);
    const say = (text: string) => this.line(job.jobId, text);
    let lastProgress = 0;
    const progress = (force = false) => {
      if (!force && Date.now() - lastProgress < 250) return;
      lastProgress = Date.now();
      this.emit({ jobId: job.jobId, type: 'progress', files: job.files, bytes: job.bytes, errors: job.errors });
    };
    const seen = new Set<string>();
    const walk = async (from: string, to: string, depth: number): Promise<void> => {
      if (abort.signal.aborted) return;
      let entries;
      try {
        entries = await readdir(from, { withFileTypes: true });
      } catch (err) {
        job.errors++;
        say(`ERROR reading ${from}: ${errorMessage(err)}`);
        return;
      }
      if (!r.dryRun) await mkdir(to, { recursive: true });
      for (const e of entries) {
        if (abort.signal.aborted) return;
        const src = join(from, e.name);
        const dst = join(to, e.name);
        seen.add(resolve(dst).toLowerCase());
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          if (r.subfolders === false || skipDir.some((x) => x.test(e.name))) continue;
          await walk(src, dst, depth + 1);
          if (r.mode === 'move' && !r.dryRun) await rmdir(src).catch(() => undefined);
          continue;
        }
        if (!e.isFile() || skipFile.some((x) => x.test(e.name))) continue;
        try {
          const s = await stat(src);
          const d = await stat(dst).catch(() => null);
          const same = d && d.size === s.size && Math.abs(d.mtimeMs - s.mtimeMs) < 2000;
          const newerThere = d && d.mtimeMs > s.mtimeMs + 2000;
          if (same || (r.mode === 'update' && newerThere)) {
            if (r.mode === 'move' && !r.dryRun && same) await unlink(src);
            continue;
          }
          say(`${d ? 'Changed' : 'New file'}  ${s.size}  ${src}`);
          if (!r.dryRun) {
            await copyFile(src, dst);
            await utimes(dst, s.atime, s.mtime);
            if (r.permissions && process.platform !== 'win32') await chmod(dst, s.mode).catch(() => undefined);
            if (r.mode === 'move') await unlink(src);
          }
          job.files++;
          job.bytes += s.size;
        } catch (err) {
          job.errors++;
          say(`ERROR ${src}: ${errorMessage(err)}`);
        }
        progress();
      }
    };
    const prune = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (abort.signal.aborted) return;
        const p = join(dir, e.name);
        if (seen.has(resolve(p).toLowerCase())) {
          if (e.isDirectory()) await prune(p);
          continue;
        }
        if (skipDir.some((x) => x.test(e.name)) || skipFile.some((x) => x.test(e.name))) continue;
        say(`*EXTRA ${e.isDirectory() ? 'Dir' : 'File'}  ${p}${r.dryRun ? '' : ' (deleted)'}`);
        if (!r.dryRun) await rm(p, { recursive: true, force: true }).catch((err) => (job.errors++, say(`ERROR deleting ${p}: ${errorMessage(err)}`)));
      }
    };
    try {
      say(`${r.dryRun ? 'Preview: ' : ''}${r.mode} ${source} → ${dest}`);
      await walk(source, dest, 0);
      if (r.mode === 'mirror' && !abort.signal.aborted && existsSync(dest)) await prune(dest);
      progress(true);
      const mb = (job.bytes / 1e6).toFixed(1);
      this.finish(job, job.errors ? 'failed' : 'done', `${r.dryRun ? 'Would copy' : 'Copied'} ${job.files} file(s), ${mb} MB${job.errors ? `, ${job.errors} error(s)` : ''}.`);
    } catch (err) {
      this.finish(job, 'failed', errorMessage(err));
    }
  }
}

function robocopyExit(code: number | null): string {
  if (code === null) return 'Robocopy was stopped.';
  if (code >= 16) return 'Robocopy could not run (bad folder, permissions or arguments).';
  if (code >= 8) return 'Some files or folders could not be copied (see the errors above).';
  const parts = [];
  if (code & 1) parts.push('files were copied');
  if (code & 2) parts.push('the destination has extra files');
  if (code & 4) parts.push('some files did not match');
  return parts.length ? `Finished: ${parts.join(', ')}.` : 'Finished: everything was already up to date.';
}
