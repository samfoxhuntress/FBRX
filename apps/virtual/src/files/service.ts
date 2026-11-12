import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FILES_ACCOUNT_RE,
  FILES_RESERVED_ACCOUNTS,
  FILES_RESERVED_SHARES,
  FILES_SHARE_RE,
  isDue,
  isIPv4,
  MESH_TRAFFIC_CLASSES,
  nextDue,
  nfsPath,
  placeWords,
  SCHEDULE_TIME_PATTERN,
  smbPath,
  type FilesAccount,
  type FilesBackup,
  type FilesBackupRun,
  type FilesMode,
  type FilesPlace,
  type FilesStatus,
  type FileShare,
  type MeshTrafficClass,
  type Schedule,
} from '@fbrx/shared';
import { openString, sealString, type Db } from '@fbrx/shared/node';
import type { GateEngine } from '@fbrx/gate/node';
import type { GateRule } from '@fbrx/gate';
import type { Hypervisor } from '../drivers/types';
import type { NftRunner } from '../mesh-mark';
import { gateLetsIn } from '../routes/command';
import { badRequest, conflict, errorMessage, notFound } from '../errors';
import { FILES_GROUP, type BackupPlace, type FilesSystem } from './system';
import { FILES_PRIORITY_REMOVE, filesPriorityNft } from './priority';

/**
 * The file server (the files role). Its settings live in the settings table (one record); passwords for other devices
 * are sealed with the server's key, and the share accounts' passwords are only ever in Samba. One backup copies at a
 * time; the rest wait their turn.
 */

type SavedPlace = { kind: 'smb'; path: string; user: string; secret: string | null } | { kind: 'nfs'; path: string };

interface SavedBackup {
  id: string;
  name: string;
  source: { kind: 'share'; share: string } | { kind: 'remote'; place: SavedPlace };
  destination: SavedPlace;
  schedule: Schedule;
  time: string;
  day: number;
  keepDays: number;
  enabled: boolean;
  createdAt: string;
  last: FilesBackupRun | null;
}

interface Saved {
  mode: FilesMode;
  vm: { vmId: string; name: string; address: string | null; addressSet: boolean } | null;
  shares: { name: string; comment: string; readOnly: boolean; accounts: string[] }[];
  accounts: FilesAccount[];
  priority: { enabled: boolean; trafficClass: MeshTrafficClass };
  backups: SavedBackup[];
}

const KEY = 'files.state';
const EMPTY: Saved = { mode: 'off', vm: null, shares: [], accounts: [], priority: { enabled: false, trafficClass: 'af31' }, backups: [] };

/** What a backup is asked to do, as the console sends it. */
export interface BackupInput {
  name: string;
  source: { kind: 'share'; share: string } | { kind: 'remote'; place: PlaceInput };
  destination: PlaceInput;
  schedule: Schedule;
  time: string;
  day: number;
  keepDays: number;
  enabled?: boolean;
}

/** A place on another device; the password is kept as it was when left out. */
export type PlaceInput = { kind: 'smb'; path: string; user: string; password?: string } | { kind: 'nfs'; path: string };

export interface FilesServiceOptions {
  db: Db;
  hv: Hypervisor;
  system: FilesSystem;
  nft: NftRunner;
  /** The server's key, for sealing other devices' passwords. */
  key: Uint8Array;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** FBRX Gate on this server, when it is one. */
  gate: () => { engine: GateEngine } | null;
  /** This server's AI (the ai role), asked about a backup that failed. */
  advise?: (prompt: string) => Promise<{ answer: string; model: string }>;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'backup';
const oneLine = (s: string, n: number) => s.replace(/[\r\n[\]]+/g, ' ').trim().slice(0, n);

/** Samba's shares file for these shares. */
export function renderShares(shares: Saved['shares'], root: string): string {
  const out = ['# FBRX file server: its shares (FBRX Virtual writes this file; changes made here are replaced).', ''];
  for (const s of shares) {
    out.push(
      `[${s.name}]`,
      `   comment = ${oneLine(s.comment, 80)}`,
      `   path = ${join(root, s.name)}`,
      `   valid users = ${s.accounts.length ? s.accounts.join(' ') : `@${FILES_GROUP}`}`,
      `   force group = ${FILES_GROUP}`,
      `   read only = ${s.readOnly ? 'yes' : 'no'}`,
      '   browseable = yes',
      '   create mask = 0660',
      '   directory mask = 2770',
      '   smb encrypt = desired',
      '',
    );
  }
  return out.join('\n');
}

/** What this server's AI is asked about a backup that failed. */
export function backupAdvicePrompt(b: FilesBackup): string {
  const from = b.source.kind === 'share' ? `the share ${b.source.share} on this server` : `${placeWords(b.source.place)} (${b.source.place.kind.toUpperCase()})`;
  return [
    'You help someone who looks after the file server on their FBRX Server (Debian). A backup copies a shared folder to another device, like a NAS, with rsync: it opens the other device (mount.cifs for SMB, NFS), copies what changed into <backup>/current and keeps changed or deleted files in <backup>/kept/<date>.',
    'This backup failed. Say in plain words what most likely went wrong and three to five concrete next steps (on the NAS, the network, or in the backup’s settings). Keep it short; no headings.',
    '',
    `Backup: ${b.name}, from ${from} to ${placeWords(b.destination)} (${b.destination.kind.toUpperCase()}${b.destination.kind === 'smb' ? `, signed in as ${b.destination.user || 'nobody'}` : ''})`,
    `What happened: ${b.last?.detail ?? 'unknown'}`,
  ].join('\n');
}

export class FilesService {
  private readonly queue: string[] = [];
  private current: { id: string; abort: AbortController } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly sizes = new Map<string, { at: number; size: number | null }>();

  constructor(private readonly o: FilesServiceOptions) {
    // Copies cut short by a restart.
    const s = this.load();
    let changed = false;
    for (const b of s.backups) {
      if (b.last?.state === 'running') {
        b.last = { ...b.last, state: 'failed', finishedAt: new Date().toISOString(), detail: 'FBRX Virtual restarted before it finished' };
        changed = true;
      }
    }
    if (changed) this.save(s);
  }

  start(): void {
    // The shares file and the marking as the settings say (the role may have been off, or the kernel restarted).
    const s = this.load();
    if (s.mode === 'host') void this.o.system.writeShares(renderShares(s.shares, this.o.system.root)).catch((e) => this.o.log('warn', `File server: shares not written: ${errorMessage(e)}`));
    void this.applyPriority().catch((e) => this.o.log('warn', `File server: priority not put back: ${errorMessage(e)}`));
    this.timer = setInterval(() => void this.tick().catch((e) => this.o.log('warn', `File server: ${errorMessage(e)}`)), 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.queue.length = 0;
    this.current?.abort.abort();
  }

  // -------------------------------------------------------------------------------------------- state

  private load(): Saved {
    const r = this.o.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', KEY);
    try {
      return r ? { ...EMPTY, ...(JSON.parse(r.value) as Partial<Saved>) } : structuredClone(EMPTY);
    } catch {
      return structuredClone(EMPTY);
    }
  }

  private save(s: Saved) {
    this.o.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', KEY, JSON.stringify(s));
  }

  private place(p: SavedPlace): FilesPlace {
    return p.kind === 'smb' ? { kind: 'smb', path: p.path, user: p.user, hasPassword: !!p.secret } : { kind: 'nfs', path: p.path };
  }

  private view(b: SavedBackup): FilesBackup {
    const { source, destination, ...rest } = b;
    const next = b.enabled ? nextDue(b.schedule, b.time, b.day, new Date()) : null;
    return {
      ...rest,
      source: source.kind === 'share' ? source : { kind: 'remote', place: this.place(source.place) },
      destination: this.place(destination),
      folder: slug(b.name),
      nextAt: next?.toISOString() ?? null,
    };
  }

  private size(name: string): number | null {
    const c = this.sizes.get(name);
    if (!c || Date.now() - c.at > 5 * 60_000) {
      this.sizes.set(name, { at: Date.now(), size: c?.size ?? null });
      void this.o.system.sizeOf(name).then((size) => this.sizes.set(name, { at: Date.now(), size })).catch(() => undefined);
    }
    return c?.size ?? null;
  }

  async status(host: string): Promise<Omit<FilesStatus, 'enabled'>> {
    const s = this.load();
    const ready = s.mode === 'host' ? await this.o.system.ready() : { ready: true, why: null };
    let vm: FilesStatus['vm'] = null;
    if (s.vm) {
      const d = await this.o.hv.getVm(s.vm.vmId).catch(() => null);
      vm = { vmId: s.vm.vmId, name: d?.name ?? s.vm.name, address: s.vm.addressSet ? s.vm.address : (d?.ip ?? s.vm.address), addressSet: s.vm.addressSet, running: d ? d.state === 'running' : null, autostart: d ? d.autostart : null };
    }
    const g = this.o.gate();
    const running = g?.engine.running() ?? null;
    return {
      mode: s.mode,
      simulated: this.o.system.kind === 'simulated',
      host: { ...ready, root: this.o.system.root, address: host },
      vm,
      shares: s.shares.map((x): FileShare => ({ ...x, path: join(this.o.system.root, x.name), sizeBytes: this.size(x.name) })),
      accounts: s.accounts,
      priority: { ...s.priority, applied: s.priority.enabled && s.mode !== 'off' ? await this.priorityInPlace(s) : null },
      backups: s.backups.map((b) => this.view(b)),
      gate: { present: !!g, open: g && running ? gateLetsIn(running, 445) : null },
    };
  }

  // --------------------------------------------------------------------------------------------- mode

  /** Serve from this server, from one of its virtual machines, or not at all. Shares and their files are kept. */
  async setMode(mode: FilesMode, vm?: { vmId: string; address?: string | null }): Promise<void> {
    const s = this.load();
    if (mode === 'vm') {
      if (!vm?.vmId) throw badRequest('Pick the virtual machine that is the file server');
      const d = await this.o.hv.getVm(vm.vmId).catch(() => null);
      if (!d) throw notFound('There is no such virtual machine');
      const typed = vm.address?.trim() || null;
      if (typed && !isIPv4(typed)) throw badRequest('Type its address like 192.168.1.20');
      s.vm = { vmId: d.id, name: d.name, address: typed ?? d.ip, addressSet: !!typed };
    }
    if (mode === 'host') {
      const r = await this.o.system.ready();
      if (!r.ready) throw conflict(r.why ?? 'Samba is not ready');
      for (const sh of s.shares) await this.o.system.makeFolder(sh.name);
    }
    s.mode = mode;
    if (mode !== 'vm') s.vm = mode === 'off' ? null : s.vm;
    await this.o.system.writeShares(renderShares(mode === 'host' ? s.shares : [], this.o.system.root));
    this.save(s);
    await this.applyPriority();
  }

  async setAutostart(on: boolean): Promise<void> {
    const s = this.load();
    if (s.mode !== 'vm' || !s.vm) throw conflict('The file server is not a virtual machine');
    await this.o.hv.updateVm(s.vm.vmId, { autostart: on }, undefined);
  }

  // ------------------------------------------------------------------------------------------- shares

  private checkAccounts(s: Saved, accounts: string[]) {
    const missing = accounts.filter((a) => !s.accounts.some((x) => x.name === a));
    if (missing.length) throw badRequest(`There is no account ${missing.join(', ')}: add it first`);
    return [...new Set(accounts)];
  }

  async addShare(p: { name: string; comment?: string; readOnly?: boolean; accounts?: string[] }): Promise<void> {
    const s = this.load();
    const name = p.name.trim().toLowerCase();
    if (!FILES_SHARE_RE.test(name)) throw badRequest('Name a share with lowercase letters, digits and dashes (32 at most), starting with a letter');
    if (FILES_RESERVED_SHARES.includes(name)) throw badRequest(`${name} is taken by the server: pick another name`);
    if (s.shares.some((x) => x.name === name)) throw conflict(`There is already a share named ${name}`);
    if (s.shares.length >= 64) throw badRequest('64 shares at most');
    const share = { name, comment: oneLine(p.comment ?? '', 80), readOnly: !!p.readOnly, accounts: this.checkAccounts(s, p.accounts ?? []) };
    await this.o.system.makeFolder(name);
    s.shares.push(share);
    await this.writeShares(s);
    this.save(s);
  }

  async updateShare(name: string, p: { comment?: string; readOnly?: boolean; accounts?: string[] }): Promise<void> {
    const s = this.load();
    const share = s.shares.find((x) => x.name === name);
    if (!share) throw notFound(`There is no share ${name}`);
    if (p.comment !== undefined) share.comment = oneLine(p.comment, 80);
    if (p.readOnly !== undefined) share.readOnly = p.readOnly;
    if (p.accounts !== undefined) share.accounts = this.checkAccounts(s, p.accounts);
    await this.writeShares(s);
    this.save(s);
  }

  /** Stops sharing it; its files stay in the folder. */
  async removeShare(name: string): Promise<void> {
    const s = this.load();
    if (!s.shares.some((x) => x.name === name)) throw notFound(`There is no share ${name}`);
    const used = s.backups.find((b) => b.source.kind === 'share' && b.source.share === name);
    if (used) throw conflict(`The backup ${used.name} copies this share: remove it or change it first`);
    s.shares = s.shares.filter((x) => x.name !== name);
    await this.writeShares(s);
    this.save(s);
  }

  private async writeShares(s: Saved) {
    if (s.mode === 'host') await this.o.system.writeShares(renderShares(s.shares, this.o.system.root));
  }

  // ----------------------------------------------------------------------------------------- accounts

  private checkPassword(pw: string) {
    if (pw.length < 8) throw badRequest('Use a password of 8 characters or more');
    if (pw.length > 128 || /[\r\n]/.test(pw)) throw badRequest('That password cannot be used (128 characters at most, no line breaks)');
  }

  async addAccount(name: string, password: string): Promise<void> {
    const s = this.load();
    const n = name.trim().toLowerCase();
    if (!FILES_ACCOUNT_RE.test(n)) throw badRequest('Name an account with lowercase letters, digits, dashes and underscores (2 to 31), starting with a letter');
    if (FILES_RESERVED_ACCOUNTS.includes(n)) throw badRequest(`${n} is taken by the server: pick another name`);
    if (s.accounts.some((a) => a.name === n)) throw conflict(`There is already an account named ${n}`);
    this.checkPassword(password);
    try {
      await this.o.system.setAccount(n, password);
    } catch (e) {
      throw conflict(errorMessage(e));
    }
    s.accounts.push({ name: n, createdAt: new Date().toISOString() });
    this.save(s);
  }

  async setPassword(name: string, password: string): Promise<void> {
    const s = this.load();
    if (!s.accounts.some((a) => a.name === name)) throw notFound(`There is no account ${name}`);
    this.checkPassword(password);
    await this.o.system.setAccount(name, password);
  }

  async removeAccount(name: string): Promise<void> {
    const s = this.load();
    if (!s.accounts.some((a) => a.name === name)) throw notFound(`There is no account ${name}`);
    await this.o.system.removeAccount(name);
    s.accounts = s.accounts.filter((a) => a.name !== name);
    // Shares only it could open fall back to every account; say so in the console by what they show.
    for (const sh of s.shares) sh.accounts = sh.accounts.filter((a) => a !== name);
    await this.writeShares(s);
    this.save(s);
  }

  // ----------------------------------------------------------------------------------------- priority

  async setPriority(p: { enabled: boolean; trafficClass?: MeshTrafficClass }): Promise<void> {
    const s = this.load();
    if (p.trafficClass && !MESH_TRAFFIC_CLASSES.includes(p.trafficClass)) throw badRequest('Not a traffic class');
    s.priority = { enabled: p.enabled, trafficClass: p.trafficClass ?? s.priority.trafficClass };
    this.save(s);
    await this.applyPriority();
  }

  private vmAddress(s: Saved): string | null {
    return s.vm?.address && isIPv4(s.vm.address) ? s.vm.address : null;
  }

  private async load_nft(script: string) {
    const dir = mkdtempSync(join(tmpdir(), 'fbrx-files-'));
    try {
      const file = join(dir, 'files.nft');
      writeFileSync(file, script, { mode: 0o600 });
      const r = await this.o.nft(['-f', file]);
      if (r.code !== 0) throw new Error(`nft: ${(r.err || r.out).trim().slice(0, 300) || 'failed'}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Puts the marking in place as the settings say (or takes it away). */
  async applyPriority(): Promise<void> {
    const s = this.load();
    const want = s.priority.enabled && (s.mode === 'host' || (s.mode === 'vm' && this.vmAddress(s)));
    if (!want) {
      // Nothing there to remove is fine.
      await this.load_nft(FILES_PRIORITY_REMOVE.inet).catch(() => undefined);
      await this.load_nft(FILES_PRIORITY_REMOVE.bridge).catch(() => undefined);
      return;
    }
    const t = filesPriorityNft(s.priority.trafficClass, s.mode === 'vm' ? this.vmAddress(s) : null);
    await this.load_nft(t.inet);
    if (t.bridge) await this.load_nft(t.bridge).catch((e) => this.o.log('warn', `File server: bridged traffic not marked (${errorMessage(e)})`));
    else await this.load_nft(FILES_PRIORITY_REMOVE.bridge).catch(() => undefined);
  }

  private async priorityInPlace(s: Saved): Promise<boolean | null> {
    if (s.mode === 'vm' && !this.vmAddress(s)) return false;
    const r = await this.o.nft(['list', 'table', 'inet', 'fbrx_files']);
    if (r.code !== 0) return /No such file|does not exist/i.test(r.err) ? false : null;
    return r.out.includes(`dscp set ${s.priority.trafficClass}`) && (s.mode !== 'vm' || r.out.includes(this.vmAddress(s)!));
  }

  // ---------------------------------------------------------------------------------------------- gate

  /** The firewall rules that let each of the gate's networks reach the shares on the gate (TCP 445). */
  gateRules(): GateRule[] {
    const g = this.o.gate();
    if (!g) return [];
    return g.engine.candidate().networks.map((n) => ({ id: `fbrx-files-${n.name}`, name: `File server for ${n.name}`, enabled: true, from: n.name, to: 'gate', proto: 'tcp' as const, ports: '445', action: 'accept' as const, log: false }));
  }

  /** Adds those rules to what is being edited on the gate, to commit with What If. */
  openGate(by: string): { added: number } {
    const g = this.o.gate();
    if (!g) throw conflict('This server is not a gate');
    const c = structuredClone(g.engine.candidate());
    const have = new Set(c.firewall.rules.map((r) => r.id));
    const add = this.gateRules().filter((r) => !have.has(r.id));
    if (!add.length) return { added: 0 };
    c.firewall.rules.push(...add);
    const check = g.engine.setCandidate(c, by);
    if (!check.ok && check.errors.length) throw badRequest(check.errors.join('; '));
    return { added: add.length };
  }

  // ------------------------------------------------------------------------------------------- backups

  backup(id: string): SavedBackup {
    const b = this.load().backups.find((x) => x.id === id);
    if (!b) throw notFound('There is no such backup');
    return b;
  }

  private savePlace(id: string, p: PlaceInput, before: SavedPlace | null): SavedPlace {
    if (p.kind === 'nfs') {
      const path = nfsPath(p.path);
      if (!path) throw badRequest(`${p.path || 'That'} is not an NFS export: write it like nas:/export/backups`);
      return { kind: 'nfs', path };
    }
    const path = smbPath(p.path);
    if (!path) throw badRequest(`${p.path || 'That'} is not a shared folder: write it like \\\\nas\\backups`);
    const user = p.user.trim();
    if (!user || user.length > 100 || /[\r\n]/.test(user)) throw badRequest('Enter the account the device signs in with');
    if (p.password && (p.password.length > 256 || /[\r\n]/.test(p.password))) throw badRequest('That password cannot be used');
    const secret = p.password ? sealString(this.o.key, p.password, `files.backup:${id}`) : before?.kind === 'smb' ? before.secret : null;
    if (!secret) throw badRequest(`Enter the password for ${user}`);
    return { kind: 'smb', path, user, secret };
  }

  private check(b: Pick<BackupInput, 'name' | 'schedule' | 'time' | 'day' | 'keepDays'>) {
    if (!b.name.trim() || b.name.length > 80) throw badRequest('Name the backup (80 characters at most)');
    if (b.schedule !== 'off' && !SCHEDULE_TIME_PATTERN.test(b.time)) throw badRequest('Pick a time like 01:30');
    if (b.day < 0 || b.day > 6) throw badRequest('Pick a day of the week');
    if (b.keepDays < 0 || b.keepDays > 3650) throw badRequest('Keep changed files between 0 and 3650 days');
  }

  /** Two backups writing to one folder would delete each other's copies (each mirrors its source there). */
  private clash(s: Saved, b: SavedBackup) {
    const where = (x: SavedBackup) => `${placeWords(this.place(x.destination)).toLowerCase()}|${slug(x.name)}`;
    if (s.backups.some((x) => x.id !== b.id && where(x) === where(b))) throw conflict('Another backup already writes to a folder of that name on that device: give this one another name');
  }

  createBackup(p: BackupInput): FilesBackup {
    const s = this.load();
    this.check(p);
    if (s.backups.length >= 32) throw badRequest('32 backups at most');
    const id = randomUUID();
    if (p.source.kind === 'share') {
      const share = p.source.share;
      if (!s.shares.some((x) => x.name === share)) throw badRequest(`There is no share ${share}`);
    }
    const b: SavedBackup = {
      id,
      name: p.name.trim(),
      source: p.source.kind === 'share' ? { kind: 'share', share: p.source.share } : { kind: 'remote', place: this.savePlace(id, p.source.place, null) },
      destination: this.savePlace(id, p.destination, null),
      schedule: p.schedule,
      time: p.time,
      day: p.day,
      keepDays: p.keepDays,
      enabled: p.enabled ?? true,
      createdAt: new Date().toISOString(),
      last: null,
    };
    this.clash(s, b);
    s.backups.push(b);
    this.save(s);
    return this.view(b);
  }

  updateBackup(id: string, p: Partial<BackupInput>): FilesBackup {
    const s = this.load();
    const b = s.backups.find((x) => x.id === id);
    if (!b) throw notFound('There is no such backup');
    const next = { ...b, ...(p.name !== undefined ? { name: p.name.trim() } : {}), ...(p.schedule ? { schedule: p.schedule } : {}), ...(p.time !== undefined ? { time: p.time } : {}), ...(p.day !== undefined ? { day: p.day } : {}), ...(p.keepDays !== undefined ? { keepDays: p.keepDays } : {}), ...(p.enabled !== undefined ? { enabled: p.enabled } : {}) };
    this.check(next);
    if (p.source) {
      if (p.source.kind === 'share') {
        const share = p.source.share;
        if (!s.shares.some((x) => x.name === share)) throw badRequest(`There is no share ${share}`);
        next.source = { kind: 'share', share };
      } else next.source = { kind: 'remote', place: this.savePlace(id, p.source.place, b.source.kind === 'remote' ? b.source.place : null) };
    }
    if (p.destination) next.destination = this.savePlace(id, p.destination, b.destination);
    this.clash(s, next);
    Object.assign(b, next);
    this.save(s);
    return this.view(b);
  }

  deleteBackup(id: string): void {
    const s = this.load();
    if (!s.backups.some((x) => x.id === id)) throw notFound('There is no such backup');
    if (this.current?.id === id) this.current.abort.abort();
    const q = this.queue.indexOf(id);
    if (q >= 0) this.queue.splice(q, 1);
    s.backups = s.backups.filter((x) => x.id !== id);
    this.save(s);
  }

  /** Starts it now (or after the one copying). */
  runBackup(id: string): FilesBackup {
    const s = this.load();
    const b = s.backups.find((x) => x.id === id);
    if (!b) throw notFound('There is no such backup');
    if (this.current?.id === id || this.queue.includes(id)) throw conflict('This backup is already copying, or waiting its turn');
    b.last = { state: 'running', startedAt: new Date().toISOString(), finishedAt: null, files: null, bytes: null, detail: this.current ? 'Waiting for another backup to finish' : 'Starting', advice: null };
    this.save(s);
    this.queue.push(id);
    void this.pump();
    return this.view(b);
  }

  stopBackup(id: string): void {
    const q = this.queue.indexOf(id);
    if (q >= 0) {
      this.queue.splice(q, 1);
      this.finish(id, { state: 'failed', detail: 'Stopped before it started' });
      return;
    }
    if (this.current?.id !== id) throw conflict('This backup is not copying');
    this.current.abort.abort();
  }

  private finish(id: string, r: Partial<FilesBackupRun> & { state: FilesBackupRun['state']; detail: string }) {
    const s = this.load();
    const b = s.backups.find((x) => x.id === id);
    if (!b) return null;
    b.last = { startedAt: b.last?.startedAt ?? new Date().toISOString(), files: null, bytes: null, advice: null, ...r, finishedAt: new Date().toISOString() };
    this.save(s);
    return b;
  }

  private resolve(p: SavedPlace, id: string): BackupPlace {
    if (p.kind === 'nfs') return p;
    if (!p.secret) throw new Error(`No password is saved for ${p.user}: edit the backup and enter it`);
    let password: string;
    try {
      password = openString(this.o.key, p.secret, `files.backup:${id}`);
    } catch {
      throw new Error(`The saved password for ${p.user} cannot be read on this server any more: edit the backup and enter it again`);
    }
    return { kind: 'smb', path: p.path, user: p.user, password };
  }

  private async pump(): Promise<void> {
    if (this.current) return;
    const id = this.queue.shift();
    if (!id) return;
    const abort = new AbortController();
    this.current = { id, abort };
    const started = Date.now();
    try {
      const b = this.backup(id);
      const s = this.load();
      const src = b.source;
      if (src.kind === 'share' && !s.shares.some((x) => x.name === src.share)) throw new Error(`The share ${src.share} is gone`);
      const source: BackupPlace = src.kind === 'share' ? { kind: 'folder', path: join(this.o.system.root, src.share) } : this.resolve(src.place, id);
      const destination = this.resolve(b.destination, id) as Exclude<BackupPlace, { kind: 'folder' }>;
      const s2 = this.load();
      const running = s2.backups.find((x) => x.id === id);
      if (running?.last) {
        running.last.detail = 'Copying';
        this.save(s2);
      }
      const r = await this.o.system.backup({ slug: slug(b.name), source, destination, keepDays: b.keepDays, today: new Date().toISOString().slice(0, 10) }, abort.signal);
      this.finish(id, { state: 'ok', files: r.files, bytes: r.bytes, detail: `${r.detail} in ${Math.max(1, Math.round((Date.now() - started) / 1000))} s` });
      this.o.log('info', `File server: backup ${b.name} done (${r.detail})`);
    } catch (e) {
      const done = this.finish(id, { state: 'failed', detail: abort.signal.aborted ? 'Stopped' : errorMessage(e) });
      if (done && !abort.signal.aborted) {
        this.o.log('warn', `File server: backup ${done.name} failed: ${errorMessage(e)}`);
        void this.adviseOn(id);
      }
    } finally {
      this.current = null;
      void this.pump();
    }
  }

  private async adviseOn(id: string) {
    if (!this.o.advise) return;
    const b = this.load().backups.find((x) => x.id === id);
    if (!b?.last) return;
    try {
      const { answer } = await this.o.advise(backupAdvicePrompt(this.view(b)));
      const s = this.load();
      const now = s.backups.find((x) => x.id === id);
      if (now?.last && now.last.startedAt === b.last.startedAt) {
        now.last.advice = answer.trim().slice(0, 4000);
        this.save(s);
      }
    } catch (e) {
      this.o.log('warn', `File server: this server's AI did not answer about the backup (${errorMessage(e)})`);
    }
  }

  /** Every minute: backups that fell due, and a virtual machine whose address moved. */
  async tick(now = new Date()): Promise<void> {
    const s = this.load();
    for (const b of s.backups) {
      if (!b.enabled || b.schedule === 'off' || this.current?.id === b.id || this.queue.includes(b.id)) continue;
      if (isDue(b.schedule, b.time, b.day, b.last?.startedAt ?? b.createdAt, now)) this.runBackup(b.id);
    }
    if (s.mode === 'vm' && s.vm && !s.vm.addressSet) {
      const d = await this.o.hv.getVm(s.vm.vmId).catch(() => null);
      if (d?.ip && d.ip !== s.vm.address) {
        s.vm.address = d.ip;
        this.save(s);
        if (s.priority.enabled) await this.applyPriority();
      }
    }
  }
}
