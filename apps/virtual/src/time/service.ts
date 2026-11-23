import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative } from 'node:path';
import {
  encodeTimeCode,
  isDue,
  nextDue,
  nfsPath,
  smbPath,
  SCHEDULE_TIME_PATTERN,
  TIME_DEFAULT_SETTINGS,
  type BootCheck,
  type TimeComputer,
  type TimeCopyOut,
  type TimeDrive,
  type TimeDiskFile,
  type TimeImage,
  type TimeJob,
  type TimeJobInput,
  type TimeSettings,
  type TimeStatus,
  type TimeTask,
  type TimeTaskKind,
  type VmDetail,
} from '@fbrx/shared';
import { openString, sealString, type Db } from '@fbrx/shared/node';
import type { Hypervisor } from '../drivers/types';
import { IMAGES_POOL, VM_NAME_RE } from '../drivers/types';
import { badRequest, conflict, errorMessage, notFound } from '../errors';
import type { ImageFacts, TimeDriver } from './driver';
import type { MountPlace } from '../files/system';
import type { TimeCopier } from './copy-out';

/**
 * FBRX Time on the server (the time role): backup jobs for virtual machines, the images computers send to its backup
 * folder, and boot checks. One task at a time (copies and checks are heavy); the rest wait their turn. Images live in
 * the repository folder, one folder each:
 *
 *   <repository>/images/<machine>/<when>-<id>/   disks, the machine's definition, check screenshots
 *   <repository>/incoming/                       the backup folder computers write to (the fbrx-time share)
 *   <repository>/lab/                            scratch disks of a boot check, deleted when it ends
 */

export interface TimeServiceOptions {
  db: Db;
  hv: Hypervisor;
  driver: TimeDriver;
  /** The repository folder. */
  dir: string;
  /** The share's sign-in, written by the installer (SHARE_NAME, SHARE_USER, SHARE_PASSWORD). */
  shareFile: string;
  /** Where virtual machine disks live (a restored machine's disks go here). */
  imagesDir: string;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** A computer's backup counts as finished when nothing in it changed for this long. */
  quietMs?: number;
  /** This server's AI (the ai role), asked once for an answer; absent when the server has none. */
  advise?: (prompt: string) => Promise<{ answer: string; model: string }>;
  /** Copies images off the server (a NAS, an NFS export, a drive); absent: they stay on the server only. */
  copier?: TimeCopier;
  /** Seals the NAS account's password at rest. */
  key?: Uint8Array;
}

/** What FBRX Time keeps of where it copies images (the password sealed). */
interface SavedCopyOut {
  kind: TimeCopyOut['kind'];
  path: string;
  user: string;
  secret: string | null;
  keep: number;
  label: string;
}

/** Where images are copied, as someone sets it (a new password, or none to keep the one saved). */
export interface CopyOutInput {
  kind: TimeCopyOut['kind'];
  path: string;
  user?: string;
  password?: string;
  keep: number;
}

/** What this server's AI is asked about a check that failed or warned: the image, what the check saw, short. */
export function advicePrompt(img: TimeImage): string {
  const c = img.check;
  return [
    'You help someone who looks after the backups on their FBRX Server. FBRX Time checks every backup image by starting it as a throwaway virtual machine (its disks only read, on a private test network that reaches nothing else, or none), letting it run a few minutes, then looking at it: still running, the guest agent answering, its screen, whether it asked the test network for an address.',
    'This check did not pass cleanly. Say in plain words what most likely went wrong, how worried to be about restoring from this image, and three to five concrete next steps (in the original machine or computer, in FBRX Time, or by restoring it to look). Keep it short; no headings.',
    '',
    `Image: ${img.subject} (${img.source === 'vm' ? 'a virtual machine on this server' : 'a computer'}), taken ${img.createdAt}, ${img.os ?? 'unknown system'}, ${img.firmware ?? 'unknown'} firmware, consistency ${img.consistency ?? 'unknown'}`,
    `Disks: ${img.disks.map((d) => `${d.target} (${d.format}, ${d.bus})`).join(', ') || 'none'}`,
    `Check: ${c.state}, ran ${c.seconds ?? '?'} seconds. ${c.detail}`,
    `Guest agent: ${c.agent === null ? 'none answered (may not be installed)' : c.agent ? 'answered' : 'did not answer'}`,
    `Test network: ${!c.network ? 'not tried' : c.network.address ? `got ${c.network.address}${c.network.answered ? ', answered a ping' : ', no answer to ping'}` : 'it did not ask for an address'}`,
    `Screen at the end: ${c.screenshot ? 'kept (described in the check above)' : 'none'}`,
  ].join('\n');
}

interface Pending {
  task: TimeTask;
  run: (task: TimeTask, signal: AbortSignal) => Promise<string>;
}

const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'machine';
const stamp = (d: Date) => d.toISOString().replace(/[:]/g, '').replace(/\..+$/, '');
const json = <T>(s: unknown, fallback: T): T => {
  try {
    return s ? (JSON.parse(String(s)) as T) : fallback;
  } catch {
    return fallback;
  }
};

const NO_CHECK: BootCheck = { state: 'none', at: null, seconds: null, detail: '', screenshot: null, agent: null };

/** 3.2 GB, 412 MB for a small one, 2.0 TB for a drive. */
const size = (b: number) => (b >= 1024 ** 4 ? `${(b / 1024 ** 4).toFixed(1)} TB` : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`);

export class TimeService {
  private readonly queue: Pending[] = [];
  private current: { task: TimeTask; abort: AbortController } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastScan = 0;
  private readonly quietMs: number;

  constructor(private readonly o: TimeServiceOptions) {
    this.quietMs = o.quietMs ?? 10 * 60_000;
    for (const d of ['images', 'incoming', 'lab']) mkdirSync(join(o.dir, d), { recursive: true });
    // Work cut short by a restart.
    o.db.run("UPDATE time_tasks SET state = 'failed', finished_at = ?, detail = 'FBRX Virtual restarted before it finished' WHERE state IN ('queued', 'running')", new Date().toISOString());
    for (const r of o.db.all<{ id: string; check_json: string }>('SELECT id, check_json FROM time_images')) {
      const c = json<BootCheck>(r.check_json, NO_CHECK);
      if (c.state === 'queued' || c.state === 'running') this.saveCheck(r.id, { ...c, state: 'none', detail: 'The check was cut short by a restart.' });
    }
    rmSync(join(o.dir, 'lab'), { recursive: true, force: true });
    mkdirSync(join(o.dir, 'lab'), { recursive: true });
  }

  start(): void {
    this.timer = setInterval(() => void this.tick().catch((e) => this.o.log('warn', `FBRX Time: ${errorMessage(e)}`)), 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.current?.abort.abort();
    this.queue.length = 0;
  }

  // ----------------------------------------------------------------------------------------- settings

  settings(): TimeSettings {
    const r = this.o.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'time.settings'");
    return { ...TIME_DEFAULT_SETTINGS, ...json<Partial<TimeSettings>>(r?.value, {}) };
  }

  setSettings(p: Partial<TimeSettings>): TimeSettings {
    const next = { ...this.settings(), ...p };
    if (next.checkSeconds < 30 || next.checkSeconds > 1800) throw badRequest('A boot check runs between 30 seconds and 30 minutes');
    if (next.keepComputer < 1 || next.keepComputer > 365) throw badRequest('Keep between 1 and 365 images of each computer');
    this.o.db.run("INSERT INTO settings (key, value) VALUES ('time.settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(next));
    return next;
  }

  // --------------------------------------------------------------------------------- copies off the server

  private savedCopyOut(): SavedCopyOut | null {
    const r = this.o.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'time.copyOut'");
    return json<SavedCopyOut | null>(r?.value, null);
  }

  /** Where each new image is also copied, with how the last copy went (never the password). */
  copyOut(): TimeCopyOut | null {
    const c = this.savedCopyOut();
    if (!c) return null;
    const last = this.o.db.get<{ finished_at: string; state: string; detail: string }>("SELECT finished_at, state, detail FROM time_tasks WHERE kind = 'copy' AND state IN ('done', 'failed') ORDER BY finished_at DESC LIMIT 1");
    return { kind: c.kind, path: c.path, user: c.user, keep: c.keep, label: c.label, last: last ? { at: last.finished_at, ok: last.state === 'done', detail: last.detail } : null };
  }

  async drives(): Promise<TimeDrive[]> {
    return this.o.copier ? this.o.copier.drives() : [];
  }

  private place(c: SavedCopyOut): MountPlace {
    if (c.kind === 'drive') return { kind: 'drive', uuid: c.path };
    if (c.kind === 'nfs') return { kind: 'nfs', path: c.path };
    if (!c.secret || !this.o.key) throw new Error('The password for the shared folder is missing: set it again in FBRX Time → Settings');
    return { kind: 'smb', path: c.path, user: c.user, password: openString(this.o.key, c.secret, 'time.copyOut') };
  }

  /**
   * Sets (or changes) where images are copied. The place is opened and written to first, so a wrong path or password
   * is said now rather than at the next backup. Copies already made at the old place stay there.
   */
  async setCopyOut(i: CopyOutInput, signal: AbortSignal = AbortSignal.timeout(90_000)): Promise<TimeCopyOut> {
    if (!this.o.copier) throw conflict('Copies off the server are not available on this server');
    if (!Number.isInteger(i.keep) || i.keep < 1 || i.keep > 365) throw badRequest('Keep between 1 and 365 images of each machine there');
    const before = this.savedCopyOut();
    let next: SavedCopyOut;
    if (i.kind === 'drive') {
      const d = (await this.o.copier.drives()).find((x) => x.uuid === i.path);
      if (!d) throw badRequest('That drive is not plugged into the server: plug it in and look again');
      next = { kind: 'drive', path: d.uuid, user: '', secret: null, keep: i.keep, label: `${d.label || d.model || 'Drive'} (${size(d.sizeBytes)}, ${d.fileSystem})` };
    } else if (i.kind === 'nfs') {
      const path = nfsPath(i.path);
      if (!path) throw badRequest(`${i.path || 'That'} is not an NFS export: write it like nas:/export/backups`);
      next = { kind: 'nfs', path, user: '', secret: null, keep: i.keep, label: path };
    } else {
      const path = smbPath(i.path);
      if (!path) throw badRequest(`${i.path || 'That'} is not a shared folder: write it like \\\\nas\\backups`);
      const user = (i.user ?? '').trim();
      if (!user || user.length > 100 || /[\r\n]/.test(user)) throw badRequest('Enter the account the NAS signs in with');
      if (i.password && (i.password.length > 256 || /[\r\n]/.test(i.password))) throw badRequest('That password cannot be used');
      if (!this.o.key) throw conflict('This server cannot keep a password safely');
      const secret = i.password ? sealString(this.o.key, i.password, 'time.copyOut') : before?.kind === 'smb' && before.path === path && before.user === user ? before.secret : null;
      if (!secret) throw badRequest(`Enter the password for ${user}`);
      next = { kind: 'smb', path, user, secret, keep: i.keep, label: path.replace(/\//g, '\\') };
    }
    try {
      await this.o.copier.test(this.place(next), signal);
    } catch (e) {
      throw badRequest(errorMessage(e));
    }
    this.o.db.run("INSERT INTO settings (key, value) VALUES ('time.copyOut', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(next));
    return this.copyOut()!;
  }

  /** Stops copying images off the server; the copies already made stay where they are. */
  clearCopyOut(): void {
    this.o.db.run("DELETE FROM settings WHERE key = 'time.copyOut'");
  }

  /** Copies an image to the place (after each new image, or when asked). */
  copyImage(imageId: string): TimeTask {
    const img = this.image(imageId);
    if (!this.savedCopyOut() || !this.o.copier) throw conflict('Set where to copy images first (FBRX Time → Settings)');
    if (this.queue.some((p) => p.task.imageId === imageId && p.task.kind === 'copy')) throw conflict('This image is already waiting to be copied');
    return this.enqueue(this.newTask('copy', img.subject, img.id), async (task, signal) => {
      const c = this.savedCopyOut();
      if (!c || !this.o.copier) return 'Copying off the server was turned off';
      const dir = this.imageDir(img.id);
      const now = this.image(img.id);
      const r = await this.o.copier.copy(this.place(c), dir, slug(img.subject), dir.split(/[\\/]/).pop()!, { ...now, copiedAt: new Date().toISOString() }, c.keep, signal);
      return `${img.subject}'s image of ${img.createdAt.slice(0, 16).replace('T', ' ')} UTC copied to ${c.label} (${size(img.bytes)})${r.pruned ? `; ${r.pruned} older cop${r.pruned === 1 ? 'y' : 'ies'} removed there` : ''}`;
    });
  }

  /** A new image goes off the server too, when a place is set. */
  private copyLater(image: TimeImage) {
    if (!this.savedCopyOut() || !this.o.copier) return;
    try {
      this.copyImage(image.id);
    } catch (e) {
      this.o.log('warn', `FBRX Time: could not queue a copy of ${image.subject}: ${errorMessage(e)}`);
    }
  }

  // --------------------------------------------------------------------------------------------- jobs

  private rowToJob(r: Record<string, unknown>, now = new Date()): TimeJob {
    const job = {
      id: String(r.id),
      name: String(r.name),
      vmId: String(r.vm_id),
      vmName: String(r.vm_name),
      schedule: r.schedule as TimeJob['schedule'],
      time: String(r.time),
      day: Number(r.day),
      verify: !!r.verify,
      keep: Number(r.keep),
      enabled: !!r.enabled,
      lastRunAt: (r.last_run_at as string) ?? null,
      lastOk: r.last_ok === null || r.last_ok === undefined ? null : !!r.last_ok,
      nextRunAt: null as string | null,
      createdAt: String(r.created_at),
    };
    job.nextRunAt = job.enabled ? (nextDue(job.schedule, job.time, job.day, now)?.toISOString() ?? null) : null;
    return job;
  }

  jobs(): TimeJob[] {
    return this.o.db.all<Record<string, unknown>>('SELECT * FROM time_jobs ORDER BY name COLLATE NOCASE').map((r) => this.rowToJob(r));
  }

  job(id: string): TimeJob {
    const r = this.o.db.get<Record<string, unknown>>('SELECT * FROM time_jobs WHERE id = ?', id);
    if (!r) throw notFound('No such backup job');
    return this.rowToJob(r);
  }

  private checkJob(i: TimeJobInput) {
    if (!SCHEDULE_TIME_PATTERN.test(i.time)) throw badRequest('Pick a time like 21:30');
    if (!Number.isInteger(i.day) || i.day < 0 || i.day > 6) throw badRequest('Pick a day of the week');
    if (!Number.isInteger(i.keep) || i.keep < 1 || i.keep > 365) throw badRequest('Keep between 1 and 365 images');
  }

  async createJob(i: TimeJobInput): Promise<TimeJob> {
    this.checkJob(i);
    const vm = await this.o.hv.getVm(i.vmId);
    const id = randomUUID();
    this.o.db.run(
      'INSERT INTO time_jobs (id, name, vm_id, vm_name, schedule, time, day, verify, keep, enabled, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id,
      (i.name?.trim() || `Back up ${vm.name}`).slice(0, 80),
      vm.id,
      vm.name,
      i.schedule,
      i.time,
      i.day,
      i.verify ? 1 : 0,
      i.keep,
      i.enabled === false ? 0 : 1,
      new Date().toISOString(),
    );
    return this.job(id);
  }

  updateJob(id: string, i: Partial<TimeJobInput>): TimeJob {
    const j = this.job(id);
    const next = { ...j, ...i } as TimeJob;
    this.checkJob({ ...next, vmId: j.vmId });
    this.o.db.run('UPDATE time_jobs SET name = ?, schedule = ?, time = ?, day = ?, verify = ?, keep = ?, enabled = ? WHERE id = ?', (next.name || j.name).slice(0, 80), next.schedule, next.time, next.day, next.verify ? 1 : 0, next.keep, next.enabled ? 1 : 0, id);
    return this.job(id);
  }

  deleteJob(id: string): void {
    this.job(id);
    this.o.db.run('DELETE FROM time_jobs WHERE id = ?', id);
    // Its images stay; they are no longer pruned by the job.
    this.o.db.run('UPDATE time_images SET job_id = NULL WHERE job_id = ?', id);
  }

  // ------------------------------------------------------------------------------------------- images

  private rowToImage(r: Record<string, unknown>): TimeImage {
    return {
      id: String(r.id),
      source: r.source === 'computer' ? 'computer' : 'vm',
      subject: String(r.subject),
      jobId: (r.job_id as string) ?? null,
      createdAt: String(r.created_at),
      bytes: Number(r.bytes),
      disks: json<TimeDiskFile[]>(r.disks, []),
      os: (r.os as TimeImage['os']) ?? 'other',
      firmware: r.firmware === 'bios' ? 'bios' : 'uefi',
      consistency: r.consistency as TimeImage['consistency'],
      check: json<BootCheck>(r.check_json, NO_CHECK),
      note: String(r.note ?? ''),
    };
  }

  images(subject?: string): TimeImage[] {
    const rows = subject ? this.o.db.all<Record<string, unknown>>('SELECT * FROM time_images WHERE subject = ? ORDER BY created_at DESC', subject) : this.o.db.all<Record<string, unknown>>('SELECT * FROM time_images ORDER BY created_at DESC');
    return rows.map((r) => this.rowToImage(r));
  }

  image(id: string): TimeImage {
    const r = this.o.db.get<Record<string, unknown>>('SELECT * FROM time_images WHERE id = ?', id);
    if (!r) throw notFound('No such image');
    return this.rowToImage(r);
  }

  private imageDir(id: string): string {
    const r = this.o.db.get<{ dir: string }>('SELECT dir FROM time_images WHERE id = ?', id);
    if (!r) throw notFound('No such image');
    return join(this.o.dir, r.dir);
  }

  private facts(id: string): ImageFacts {
    const r = this.o.db.get<{ facts: string }>('SELECT facts FROM time_images WHERE id = ?', id);
    return { cpus: 2, memoryMb: 4096, ...json<Partial<ImageFacts>>(r?.facts, {}) };
  }

  /** The image's facts (machine size), for the driver. */
  factsOf = (image: TimeImage): ImageFacts => this.facts(image.id);

  private saveCheck(id: string, c: BootCheck) {
    this.o.db.run('UPDATE time_images SET check_json = ? WHERE id = ?', JSON.stringify(c), id);
  }

  /**
   * This server's AI looks at a check that failed or warned and says what to do; kept with the image's check. Asked
   * by itself after such a check (Settings: AI advice on problems), or again from the image.
   */
  async advise(id: string): Promise<BootCheck> {
    const img = this.image(id);
    if (!this.o.advise) throw conflict("This server has no AI to ask (the ai role adds one)");
    if (img.check.state !== 'failed' && img.check.state !== 'warning') throw conflict('Only a check that failed or warned has something to explain');
    const r = await this.o.advise(advicePrompt(img));
    // The check may have run again meanwhile: keep the advice only with the check it is about.
    const now = this.image(id).check;
    if (now.at !== img.check.at) return now;
    const next = { ...now, advice: { text: r.answer.trim().slice(0, 6000), model: r.model, at: new Date().toISOString() } };
    this.saveCheck(id, next);
    return next;
  }

  /** The boot check's picture, as a data URL. */
  screenshot(id: string): string | null {
    const img = this.image(id);
    if (!img.check.screenshot) return null;
    const file = join(this.imageDir(id), img.check.screenshot);
    return existsSync(file) ? `data:image/png;base64,${readFileSync(file).toString('base64')}` : null;
  }

  deleteImage(id: string): void {
    const img = this.image(id);
    if (this.current?.task.imageId === id || this.queue.some((p) => p.task.imageId === id)) throw conflict('FBRX Time is working with this image: wait for it to finish');
    rmSync(this.imageDir(id), { recursive: true, force: true });
    this.o.db.run('DELETE FROM time_images WHERE id = ?', img.id);
  }

  private addImage(i: Omit<TimeImage, 'id'> & { id?: string; dir: string; facts?: Partial<ImageFacts> & { key?: string } }): TimeImage {
    const id = i.id ?? randomUUID();
    this.o.db.run(
      'INSERT INTO time_images (id, source, subject, job_id, created_at, dir, bytes, disks, os, firmware, consistency, check_json, note, facts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id,
      i.source,
      i.subject,
      i.jobId,
      i.createdAt,
      relative(this.o.dir, i.dir),
      i.bytes,
      JSON.stringify(i.disks),
      i.os,
      i.firmware,
      i.consistency,
      JSON.stringify(i.check),
      i.note,
      JSON.stringify(i.facts ?? {}),
    );
    return this.image(id);
  }

  /** Keeps the newest `keep` images of a machine and deletes the rest. */
  private prune(source: TimeImage['source'], subject: string, keep: number) {
    const old = this.o.db.all<{ id: string }>('SELECT id FROM time_images WHERE source = ? AND subject = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?', source, subject, keep);
    for (const r of old) {
      try {
        this.deleteImage(r.id);
        this.o.log('info', `FBRX Time: deleted an old image of ${subject} (keeping ${keep})`);
      } catch (e) {
        this.o.log('warn', `FBRX Time: could not delete an old image of ${subject}: ${errorMessage(e)}`);
      }
    }
  }

  // -------------------------------------------------------------------------------------------- tasks

  private newTask(kind: TimeTaskKind, subject: string, imageId: string | null = null): TimeTask {
    const task: TimeTask = { id: randomUUID(), kind, subject, state: 'queued', queuedAt: new Date().toISOString(), startedAt: null, finishedAt: null, progress: null, detail: '', imageId };
    this.o.db.run('INSERT INTO time_tasks (id, kind, subject, state, queued_at, image_id) VALUES (?,?,?,?,?,?)', task.id, kind, subject, 'queued', task.queuedAt, imageId);
    return task;
  }

  private saveTask(t: TimeTask) {
    this.o.db.run('UPDATE time_tasks SET state = ?, started_at = ?, finished_at = ?, progress = ?, detail = ?, image_id = ? WHERE id = ?', t.state, t.startedAt, t.finishedAt, t.progress, t.detail.slice(0, 2000), t.imageId, t.id);
  }

  private enqueue(task: TimeTask, run: Pending['run']): TimeTask {
    this.queue.push({ task, run });
    void this.pump();
    return task;
  }

  private async pump(): Promise<void> {
    if (this.current) return;
    const next = this.queue.shift();
    if (!next) return;
    const abort = new AbortController();
    this.current = { task: next.task, abort };
    const t = next.task;
    t.state = 'running';
    t.startedAt = new Date().toISOString();
    this.saveTask(t);
    try {
      t.detail = await next.run(t, abort.signal);
      t.state = 'done';
      t.progress = 100;
    } catch (e) {
      t.state = 'failed';
      t.detail = errorMessage(e);
      this.o.log('warn', `FBRX Time: ${t.kind} of ${t.subject} failed: ${t.detail}`);
    } finally {
      t.finishedAt = new Date().toISOString();
      this.saveTask(t);
      this.current = null;
      void this.pump();
    }
  }

  tasks(limit = 30): TimeTask[] {
    const live = [...(this.current ? [this.current.task] : []), ...this.queue.map((p) => p.task)];
    const ids = new Set(live.map((t) => t.id));
    const done = this.o.db
      .all<Record<string, unknown>>("SELECT * FROM time_tasks WHERE state IN ('done', 'failed') ORDER BY COALESCE(finished_at, queued_at) DESC LIMIT ?", limit)
      .filter((r) => !ids.has(String(r.id)))
      .map(
        (r): TimeTask => ({
          id: String(r.id),
          kind: r.kind as TimeTaskKind,
          subject: String(r.subject),
          state: r.state as TimeTask['state'],
          queuedAt: String(r.queued_at),
          startedAt: (r.started_at as string) ?? null,
          finishedAt: (r.finished_at as string) ?? null,
          progress: r.progress === null || r.progress === undefined ? null : Number(r.progress),
          detail: String(r.detail ?? ''),
          imageId: (r.image_id as string) ?? null,
        }),
      );
    return [...live.map((t) => ({ ...t })), ...done];
  }

  /** Stops the boot check running now (the image stays, unchecked). A backup or a copy finishes what it started. */
  cancelCurrent(): boolean {
    if (!this.current) return false;
    if (this.current.task.kind !== 'check') throw conflict('Only a boot check can be stopped: a backup finishes what it started');
    this.current.abort.abort();
    return true;
  }

  // ------------------------------------------------------------------------------------------ backups

  private pendingFor(subject: string, kind: TimeTaskKind): boolean {
    return [...(this.current ? [this.current.task] : []), ...this.queue.map((p) => p.task)].some((t) => t.subject === subject && t.kind === kind);
  }

  /** Backs up a virtual machine now (for a job, or once). `at` is when a job's run counts from. */
  async backupVm(vmId: string, jobId: string | null = null, at = new Date()): Promise<TimeTask> {
    const vm = await this.o.hv.getVm(vmId);
    if (this.pendingFor(vm.name, 'backup')) throw conflict(`${vm.name} is already being backed up`);
    if (jobId) this.o.db.run('UPDATE time_jobs SET last_run_at = ? WHERE id = ?', at.toISOString(), jobId);
    return this.enqueue(this.newTask('backup', vm.name), (task) => this.runBackup(vm.id, jobId, task));
  }

  runJob(id: string): Promise<TimeTask> {
    const j = this.job(id);
    return this.backupVm(j.vmId, j.id);
  }

  private async runBackup(vmId: string, jobId: string | null, task: TimeTask): Promise<string> {
    const job = jobId ? this.job(jobId) : null;
    let vm: VmDetail;
    try {
      vm = await this.o.hv.getVm(vmId);
    } catch (e) {
      if (jobId) this.o.db.run('UPDATE time_jobs SET last_ok = 0 WHERE id = ?', jobId);
      throw e;
    }
    const created = new Date();
    const id = randomUUID();
    const dir = join(this.o.dir, 'images', slug(vm.name), `${stamp(created)}-${id.slice(0, 8)}`);
    try {
      const r = await this.o.driver.backupVm(vm, dir, (pct) => {
        task.progress = pct;
      });
      if (r.domainXml) writeFileSync(join(dir, 'domain.xml'), r.domainXml);
      const verify = job?.verify ?? false;
      const image = this.addImage({
        id,
        source: 'vm',
        subject: vm.name,
        jobId,
        createdAt: created.toISOString(),
        dir,
        bytes: r.disks.reduce((a, d) => a + d.bytes, 0),
        disks: r.disks,
        os: vm.os,
        firmware: vm.firmware,
        consistency: r.consistency,
        check: verify ? { ...NO_CHECK, state: 'queued' } : NO_CHECK,
        note: job ? '' : 'Backed up by hand',
        facts: { cpus: vm.cpus, memoryMb: vm.memoryMb },
      });
      task.imageId = image.id;
      if (jobId) {
        this.o.db.run('UPDATE time_jobs SET last_ok = 1 WHERE id = ?', jobId);
        this.prune('vm', vm.name, job!.keep);
      }
      if (verify) this.check(image.id);
      this.copyLater(image);
      return `${vm.name}: ${r.disks.length} disk${r.disks.length === 1 ? '' : 's'}, ${size(image.bytes)} (${r.consistency === 'quiesced' ? 'consistent: the guest agent paused writes' : r.consistency === 'offline' ? 'the machine was off' : 'copied while it ran'})${verify ? '; boot check next' : ''}`;
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      if (jobId) this.o.db.run('UPDATE time_jobs SET last_ok = 0 WHERE id = ?', jobId);
      throw e;
    }
  }

  // ------------------------------------------------------------------------------------------- checks

  /** Opens the image as a throwaway machine, confirms it starts, then shuts it down and deletes it. */
  check(imageId: string): TimeTask {
    const img = this.image(imageId);
    if (this.current?.task.imageId === imageId && this.current.task.kind === 'check') throw conflict('This image is being checked now');
    if (this.queue.some((p) => p.task.imageId === imageId && p.task.kind === 'check')) throw conflict('This image is already waiting for its check');
    this.saveCheck(img.id, { ...img.check, state: 'queued' });
    return this.enqueue(this.newTask('check', img.subject, img.id), async (task, signal) => {
      const image = this.image(imageId);
      this.saveCheck(image.id, { ...image.check, state: 'running' });
      const scratch = join(this.o.dir, 'lab', task.id);
      const started = Date.now();
      const seconds = this.settings().checkSeconds;
      const timer = setInterval(() => (task.progress = Math.min(99, Math.round(((Date.now() - started) / 1000 / seconds) * 100))), 2000);
      try {
        const result = await this.o.driver.bootCheck(image, this.imageDir(image.id), scratch, seconds, signal, { network: this.settings().checkNetwork });
        this.saveCheck(image.id, result);
        // A problem: this server's AI looks at it right away (it waits its turn with the AI, not with the checks).
        if ((result.state === 'failed' || result.state === 'warning') && this.o.advise && this.settings().aiAdvice) {
          void this.advise(image.id).catch((e) => this.o.log('warn', `FBRX Time: the AI could not look at the check of ${image.subject}: ${errorMessage(e)}`));
        }
        if (result.state === 'failed') throw new Error(result.detail);
        return result.detail;
      } catch (e) {
        const c = this.image(imageId).check;
        if (c.state === 'running') this.saveCheck(image.id, { state: 'failed', at: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000), detail: errorMessage(e), screenshot: null, agent: null });
        throw e;
      } finally {
        clearInterval(timer);
      }
    });
  }

  // ----------------------------------------------------------------------------------------- restores

  /**
   * A virtual machine's image becomes a new, stopped machine (its disks copied). A computer's image is put back in the
   * backup folder under Restore, where the computer's recovery screen can find it.
   */
  restore(imageId: string, name: string): TimeTask {
    const img = this.image(imageId);
    if (img.source === 'vm' && !VM_NAME_RE.test(name)) throw badRequest('Use letters, digits, dot, dash and underscore for the new machine’s name');
    return this.enqueue(this.newTask('restore', img.subject, img.id), async () => {
      const dir = this.imageDir(img.id);
      if (img.source === 'vm') {
        const r = await this.o.driver.restore(img, dir, name, this.o.imagesDir);
        await this.o.hv.refreshPool(IMAGES_POOL).catch(() => undefined);
        return `New virtual machine ${r.vmName} from ${img.subject}'s image of ${img.createdAt}: it is stopped, on the default network. Start it from Virtual machines.`;
      }
      const target = join(this.o.dir, 'incoming', 'Restore', `${slug(img.subject)}-${stamp(new Date(img.createdAt))}`);
      await cp(join(dir, 'WindowsImageBackup'), join(target, 'WindowsImageBackup'), { recursive: true, mode: constants.COPYFILE_FICLONE });
      return `Ready in the backup folder: Restore\\${slug(img.subject)}-${stamp(new Date(img.createdAt))}. On ${img.subject}, start from a Windows recovery drive, choose System Image Recovery, and point it at that network folder.`;
    });
  }

  // ---------------------------------------------------------------------------------------- computers

  /** Computers' backups in the backup folder: each one in WindowsImageBackup\<computer>. */
  private computerFolders(): Array<{ name: string; path: string; newest: number; bytes: number; backups: string[] }> {
    const root = join(this.o.dir, 'incoming', 'WindowsImageBackup');
    if (!existsSync(root)) return [];
    const out: Array<{ name: string; path: string; newest: number; bytes: number; backups: string[] }> = [];
    for (const name of readdirSync(root)) {
      const path = join(root, name);
      if (!statSync(path).isDirectory()) continue;
      let newest = 0;
      let bytes = 0;
      const walk = (p: string, depth: number) => {
        for (const e of readdirSync(p, { withFileTypes: true })) {
          const f = join(p, e.name);
          if (e.isDirectory()) {
            if (depth < 4) walk(f, depth + 1);
            continue;
          }
          const st = statSync(f);
          newest = Math.max(newest, st.mtimeMs);
          bytes += st.size;
        }
      };
      walk(path, 0);
      const backups = readdirSync(path).filter((b) => /^Backup \d{4}-\d{2}-\d{2} \d{6}$/.test(b) && readdirSync(join(path, b)).some((f) => f.toLowerCase().endsWith('.vhdx')));
      out.push({ name, path, newest, bytes, backups: backups.sort() });
    }
    return out;
  }

  computers(): TimeComputer[] {
    const seen = new Map<string, TimeComputer>();
    for (const r of this.o.db.all<{ subject: string; n: number; last: string }>("SELECT subject, COUNT(*) AS n, MAX(created_at) AS last FROM time_images WHERE source = 'computer' GROUP BY subject")) seen.set(r.subject, { name: r.subject, images: r.n, lastImageAt: r.last, receiving: false });
    for (const f of this.computerFolders()) {
      const c = seen.get(f.name) ?? { name: f.name, images: 0, lastImageAt: null, receiving: false };
      c.receiving = Date.now() - f.newest < this.quietMs;
      seen.set(f.name, c);
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Keeps each finished computer backup that arrived in the backup folder: a copy in the repository (the folder only
   * ever holds a computer's latest), then a boot check when that is on. Returns how many were kept.
   */
  async scanComputers(now = Date.now()): Promise<number> {
    this.lastScan = now;
    let kept = 0;
    for (const f of this.computerFolders()) {
      const latest = f.backups[f.backups.length - 1];
      if (!latest || now - f.newest < this.quietMs) continue;
      const key = `${f.name}|${latest}|${f.bytes}`;
      if (this.o.db.get("SELECT 1 FROM time_images WHERE source = 'computer' AND json_extract(facts, '$.key') = ?", key)) continue;
      if (this.pendingFor(f.name, 'import')) continue;
      kept++;
      this.enqueue(this.newTask('import', f.name), async () => {
        const m = /^Backup (\d{4})-(\d{2})-(\d{2}) (\d{2})(\d{2})(\d{2})$/.exec(latest)!;
        const created = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!));
        const id = randomUUID();
        const dir = join(this.o.dir, 'images', slug(f.name), `${stamp(created)}-${id.slice(0, 8)}`);
        try {
          await cp(f.path, join(dir, 'WindowsImageBackup', f.name), { recursive: true, mode: constants.COPYFILE_FICLONE });
          const bdir = join(dir, 'WindowsImageBackup', f.name, latest);
          const vhdx = readdirSync(bdir)
            .filter((x) => x.toLowerCase().endsWith('.vhdx'))
            .map((x) => ({ x, size: statSync(join(bdir, x)).size }))
            .sort((a, b) => b.size - a.size);
          const disks: TimeDiskFile[] = [];
          for (let i = 0; i < vhdx.length; i++) {
            const file = join('WindowsImageBackup', f.name, latest, vhdx[i]!.x);
            const facts = await this.o.driver.inspect(join(dir, file));
            disks.push({ target: `sd${String.fromCharCode(97 + i)}`, file, format: facts.format, bus: 'sata', bytes: vhdx[i]!.size, virtualBytes: facts.virtualBytes });
          }
          const verify = this.settings().verifyComputers;
          const image = this.addImage({
            id,
            source: 'computer',
            subject: f.name,
            jobId: null,
            createdAt: created.toISOString(),
            dir,
            bytes: disks.reduce((a, d) => a + d.bytes, 0),
            disks,
            os: 'windows',
            firmware: 'uefi',
            consistency: 'computer',
            check: verify ? { ...NO_CHECK, state: 'queued' } : NO_CHECK,
            note: '',
            facts: { key, cpus: 2, memoryMb: 4096 },
          });
          this.prune('computer', f.name, this.settings().keepComputer);
          if (verify) this.check(image.id);
          this.copyLater(image);
          return `${f.name}'s backup of ${created.toISOString().slice(0, 16).replace('T', ' ')} UTC kept (${size(image.bytes)})${verify ? '; boot check next' : ''}`;
        } catch (e) {
          rmSync(dir, { recursive: true, force: true });
          throw e;
        }
      });
    }
    return kept;
  }

  // -------------------------------------------------------------------------------------------- clock

  /** Every minute: jobs that are due, and (every five minutes) computers' backups that arrived. */
  async tick(now = new Date()): Promise<void> {
    for (const j of this.jobs()) {
      if (!j.enabled || j.schedule === 'off') continue;
      if (!isDue(j.schedule, j.time, j.day, j.lastRunAt ?? j.createdAt, now)) continue;
      if (this.pendingFor(j.vmName, 'backup')) continue;
      this.o.log('info', `FBRX Time: starting ${j.name}`);
      // Counted as run now, so a failing job waits for its next time instead of trying every minute.
      await this.backupVm(j.vmId, j.id, now).catch((e) => {
        this.o.db.run('UPDATE time_jobs SET last_run_at = ?, last_ok = 0 WHERE id = ?', now.toISOString(), j.id);
        this.o.log('warn', `FBRX Time: ${j.name} did not start: ${errorMessage(e)}`);
      });
    }
    if (now.getTime() - this.lastScan >= 5 * 60_000) await this.scanComputers(now.getTime());
  }

  // ------------------------------------------------------------------------------------------- status

  /** The share's sign-in, as the installer wrote it (KEY=value lines). */
  private share(host: string, admin: boolean): TimeStatus['share'] {
    if (!existsSync(this.o.shareFile)) return null;
    const v: Record<string, string> = {};
    for (const line of readFileSync(this.o.shareFile, 'utf8').split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m) v[m[1]!] = m[2]!.replace(/^"|"$/g, '');
    }
    if (!v.SHARE_NAME || !v.SHARE_USER) return null;
    const path = `\\\\${host}\\${v.SHARE_NAME}`;
    const password = admin ? (v.SHARE_PASSWORD ?? null) : null;
    return { path, user: v.SHARE_USER, password, code: password ? encodeTimeCode({ share: path, user: v.SHARE_USER, password, server: host }) : null };
  }

  async status(o: { host: string; admin: boolean; enabled: boolean }): Promise<TimeStatus> {
    let freeBytes: number | null = null;
    let totalBytes: number | null = null;
    try {
      const fs = statfsSync(this.o.dir);
      freeBytes = fs.bavail * fs.bsize;
      totalBytes = fs.blocks * fs.bsize;
    } catch {
      /* unknown */
    }
    const used = this.o.db.get<{ b: number }>('SELECT COALESCE(SUM(bytes), 0) AS b FROM time_images')?.b ?? 0;
    return {
      enabled: o.enabled,
      repository: this.o.dir,
      usedBytes: used,
      freeBytes,
      totalBytes,
      share: this.share(o.host, o.admin),
      settings: this.settings(),
      computers: this.computers(),
      tasks: this.tasks(),
      canBoot: await this.o.driver.canBoot(),
      copyOut: this.copyOut(),
    };
  }
}
