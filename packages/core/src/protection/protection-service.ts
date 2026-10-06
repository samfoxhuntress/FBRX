import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isPathLocked,
  newId,
  type AvProduct,
  type ProtectionKind,
  type ProtectionOption,
  type ProtectionState,
  type ProtectionStatus,
  type ScanJob,
  type ScanType,
  type Settings,
  type ShieldDetection,
  type ShieldStatus,
} from '@fbrx/shared';
import { CoreError, errorMessage } from '../errors';
import type { EventBus } from '../events';
import type { Logger } from '../logger';
import type { MetaStore } from '../storage/meta';
import { exec, IS_WIN } from '../windows/ps';
import * as sec from '../windows/security';
import { catalogEntry, detectProducts, findExecutable, scanCommand } from './products';
import type { Shield } from './shield';

/**
 * What protects this computer: the person's (or organization's) choice of Microsoft Defender, FBRX Shield or an
 * antivirus already installed, resolved against what is really here. Runs scans with whichever is active, keeps FBRX
 * Shield's download checks, threat database and scheduled scans going, and raises an alert when protection slips.
 */

const STATUS_TTL_MS = 60_000;
const CHECK_EVERY_MS = 30 * 60_000;
/** Products that are scanners rather than protection (they never become the active antivirus). */
const SCANNERS_ONLY = new Set(['clamav']);

export interface ProtectionDeps {
  shield: Shield;
  meta: MetaStore;
  events: EventBus;
  log: Logger;
  settings: () => Settings['protection'];
  locked: () => readonly string[];
  setProvider: (value: string) => void;
  dirs: () => { home: string; downloads: string; desktop: string };
  alert: (rule: string, title: string, body: string, key: string) => void;
  /** For tests: what is installed. */
  detect?: () => Promise<AvProduct[]>;
}

export interface ProtectionSummary {
  provider: ProtectionKind;
  name: string;
  state: ProtectionState;
  realtime: boolean | null;
  threats: number;
}

export class ProtectionService {
  private cached: ProtectionStatus | null = null;
  private computing: Promise<ProtectionStatus> | null = null;
  private current: ScanJob | null = null;
  private abort: AbortController | null = null;
  private timer: NodeJS.Timeout | null = null;
  private kick: NodeJS.Timeout | null = null;
  private running = false;
  private lastProblems = new Set<string>();

  constructor(private readonly d: ProtectionDeps) {}

  // ------------------------------------------------------------------------------------------ lifecycle

  start(): void {
    this.running = true;
    this.applyWatch();
    this.kick = setTimeout(() => this.background(), 15_000);
    this.kick.unref?.();
    this.timer = setInterval(() => this.background(), CHECK_EVERY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    if (this.kick) clearTimeout(this.kick);
    this.timer = null;
    this.kick = null;
    this.abort?.abort();
    this.d.shield.unwatch();
  }

  /** Download checks follow the setting. */
  applyWatch(): void {
    if (!this.running) return;
    const s = this.d.settings().shield;
    const dirs = this.d.dirs();
    // Never the home folder itself (some systems report it as Downloads).
    const want = s.watchDownloads ? [dirs.downloads, dirs.desktop].filter((x) => x && x !== dirs.home && existsSync(x)) : [];
    const now = this.d.shield.status(null).watching;
    if (want.join('|') !== now.join('|')) {
      if (want.length) this.d.shield.watch(want);
      else this.d.shield.unwatch();
    }
  }

  private background(): void {
    if (!this.running) return;
    void this.housekeeping().catch((err) => this.d.log.debug('Protection check failed', { error: errorMessage(err) }));
  }

  /** Every half hour: the threat database once a day, status (and alerts), and scheduled scans. */
  private async housekeeping(): Promise<void> {
    const s = this.d.settings().shield;
    const sig = this.d.meta.get<{ at: string | null }>('shield.signatures');
    if (s.updateSignatures && (!sig?.at || Date.now() - Date.parse(sig.at) > 24 * 3600_000)) {
      await this.d.shield.updateSignatures().catch((err) => this.d.log.info('Threat database update failed', { error: errorMessage(err) }));
    }
    if (!this.running) return;
    const st = await this.status(true);
    if (!this.running) return;
    // Microsoft Defender on Windows has its own alerts, and FBRX Shield's findings raise theirs as they happen.
    const problems = new Set(st.active.kind === 'defender' && IS_WIN ? [] : st.problems.filter((p) => !p.startsWith('FBRX Shield found')));
    for (const p of problems) if (!this.lastProblems.has(p)) this.d.alert('av_problem', `${st.active.name} needs attention`, p, `${st.active.id}:${p}`);
    this.lastProblems = problems;
    if (st.shield.full && s.schedule !== 'off' && !this.current) {
      const last = this.d.meta.get<string>('shield.scheduledAt');
      const every = s.schedule === 'daily' ? 24 * 3600_000 : 7 * 24 * 3600_000;
      if (!last || Date.now() - Date.parse(last) > every) {
        this.d.meta.set('shield.scheduledAt', new Date().toISOString());
        this.scan({ type: 'quick', engine: 'shield' });
      }
    }
  }

  // ------------------------------------------------------------------------------------------- status

  private lastScan(): ShieldStatus['lastScan'] {
    return this.d.meta.get<ShieldStatus['lastScan']>('shield.lastScan');
  }

  /** The protection summary sent to FBRX Command with each heartbeat (from the last check; never slow). */
  summary(): ProtectionSummary | null {
    const s = this.cached;
    return s ? { provider: s.active.kind, name: s.active.name, state: s.state, realtime: s.realtime, threats: s.threats } : null;
  }

  async status(refresh = false): Promise<ProtectionStatus> {
    if (!refresh && this.cached && Date.now() - Date.parse(this.cached.checkedAt) < STATUS_TTL_MS) return this.cached;
    if (this.computing) return this.computing;
    this.computing = this.compute().finally(() => (this.computing = null));
    this.cached = await this.computing;
    this.d.events.emit('protection.changed', { state: this.cached.state });
    return this.cached;
  }

  private async compute(): Promise<ProtectionStatus> {
    const s = this.d.settings();
    const products = await (this.d.detect ?? detectProducts)().catch(() => [] as AvProduct[]);
    const defender = products.find((p) => p.id === 'defender') ?? null;
    const others = products.filter((p) => p.id !== 'defender' && !SCANNERS_ONLY.has(p.id));
    const defenderAvailable = IS_WIN || !!defender;
    const shield = this.d.shield.status(this.lastScan());
    const notes: string[] = [];
    const problems: string[] = [];

    // An antivirus that is on; then Microsoft Defender when it has taken over on Windows; then an installed antivirus
    // even if it is off (so the person hears that it is off); then Defender; then FBRX Shield.
    const autoPick = (): { kind: ProtectionKind; id: string; name: string } => {
      const product = (p: AvProduct) => ({ kind: 'product' as const, id: p.id, name: p.name });
      const DEFENDER = { kind: 'defender' as const, id: 'defender', name: 'Microsoft Defender' };
      const on = others.find((p) => p.realtime === true);
      if (on) return product(on);
      if (IS_WIN && defender?.realtime === true) return DEFENDER;
      const installed = others.find((p) => p.realtime === null) ?? others[0];
      if (installed) return product(installed);
      if (defenderAvailable) return DEFENDER;
      return { kind: 'shield', id: 'shield', name: 'FBRX Shield' };
    };
    let active: ProtectionStatus['active'];
    if (s.provider === 'shield') active = { kind: 'shield', id: 'shield', name: 'FBRX Shield' };
    else if (s.provider === 'defender' && defenderAvailable) active = { kind: 'defender', id: 'defender', name: 'Microsoft Defender' };
    else if (s.provider.startsWith('product:') && others.some((p) => p.id === s.provider.slice(8))) {
      const p = others.find((x) => x.id === s.provider.slice(8))!;
      active = { kind: 'product', id: p.id, name: p.name };
    } else {
      active = autoPick();
      if (s.provider === 'defender') problems.push('Microsoft Defender is not on this computer; FBRX picked what is here instead.');
      else if (s.provider.startsWith('product:')) problems.push(`${catalogEntry(s.provider.slice(8))?.name ?? s.provider.slice(8)} is no longer on this computer; FBRX picked what is here instead.`);
    }

    let realtime: boolean | null = null;
    let upToDate: boolean | null = null;
    let definitionsAgeDays: number | null = null;
    let lastScan: string | null = shield.lastScan?.at ?? null;
    let threats = 0;
    const open = this.d.shield.detections(500).filter((x) => x.action === 'open');
    const openMalware = open.filter((x) => x.kind !== 'suspicious').length;
    const openSuspicious = open.length - openMalware;

    if (active.kind === 'shield') {
      realtime = this.d.settings().shield.watchDownloads;
      const sigAge = shield.signaturesUpdatedAt ? (Date.now() - Date.parse(shield.signaturesUpdatedAt)) / 86_400_000 : null;
      definitionsAgeDays = sigAge === null ? null : Math.floor(sigAge);
      upToDate = shield.signatures > 0 && sigAge !== null && sigAge <= 7;
      threats = openMalware;
      if (!realtime) problems.push('Download checks are off: new files are only checked when you scan.');
      if (!shield.signatures) problems.push('The threat database is empty: update it so FBRX Shield knows current malware.');
      else if (!upToDate) problems.push('The threat database is more than a week old.');
      if (shield.signaturesError) problems.push(`The last threat database update failed: ${shield.signaturesError}`);
      notes.push('FBRX Shield checks new downloads, scans on demand and quarantines malware. It does not yet block programs as they start.');
      if (IS_WIN) notes.push('Microsoft Defender keeps running underneath, as Windows requires.');
      else if (process.platform === 'darwin') notes.push("macOS's own built-in protection keeps running too.");
    } else if (active.kind === 'defender') {
      if (IS_WIN) {
        const def = await sec.defenderStatus().catch(() => null);
        if (def) {
          realtime = def.realtime && def.antivirus;
          definitionsAgeDays = def.signatureAgeDays;
          upToDate = def.signatureAgeDays === null ? null : def.signatureAgeDays <= 3;
          lastScan = [def.lastQuickScan, def.lastFullScan].filter(Boolean).sort().pop() ?? lastScan;
          threats = (await sec.threats().catch(() => [])).filter((t) => t.active).length;
        } else if (defender) {
          realtime = defender.realtime;
          upToDate = defender.upToDate;
        }
      } else {
        realtime = defender?.realtime ?? null;
        upToDate = defender?.upToDate ?? null;
      }
      if (realtime === false) problems.push('Microsoft Defender real-time protection is off.');
      if (upToDate === false) problems.push("Microsoft Defender's virus definitions are out of date.");
    } else {
      const p = others.find((x) => x.id === active.id)!;
      // Its own scans are not reported to FBRX; only the ones FBRX started count.
      lastScan = this.d.meta.get<string>(`protection.lastScan.${p.id}`);
      realtime = p.realtime;
      upToDate = p.upToDate;
      if (realtime === false) problems.push(`${p.name} is turned off.`);
      if (upToDate === false) problems.push(`${p.name}'s definitions are out of date.`);
      if (realtime === null) notes.push(`FBRX cannot read ${p.name}'s status on this system; check ${p.name}'s own app.`);
      notes.push(p.canScan ? `Scans run in ${p.name}.` : `${p.name} does its own scans; open ${p.name} to start one, or scan with FBRX Shield for a second opinion.`);
    }
    if (active.kind !== 'shield' && openMalware) {
      threats += openMalware;
      problems.push(`FBRX Shield found ${openMalware} threat${openMalware === 1 ? '' : 's'} waiting for a decision.`);
    }
    if (openSuspicious) problems.push(`FBRX Shield found ${openSuspicious} suspicious file${openSuspicious === 1 ? '' : 's'} waiting for your decision.`);
    const state: ProtectionState = threats > 0 || realtime === false ? 'at-risk' : problems.length || upToDate === false ? 'attention' : realtime === null && upToDate === null ? 'unknown' : 'protected';

    const options: ProtectionOption[] = [
      { value: 'auto', label: 'Automatic', detail: `Uses ${autoPick().name}: an antivirus you installed first, then Microsoft Defender on Windows, otherwise FBRX Shield.`, available: true },
      { value: 'shield', label: 'FBRX Shield', detail: "FBRX's own antivirus: download checks, scans, a threat database and quarantine.", available: true },
      {
        value: 'defender',
        label: 'Microsoft Defender',
        detail: defenderAvailable ? (IS_WIN ? 'Built into Windows.' : 'Microsoft Defender for Endpoint, installed on this computer.') : 'Not on this computer.',
        available: defenderAvailable,
      },
      ...others.map((p) => ({ value: `product:${p.id}`, label: p.name, detail: `Found on this computer${p.realtime === true ? ', on' : p.realtime === false ? ', turned off' : ''}${p.upToDate === false ? ', out of date' : ''}.`, available: true })),
    ];
    const canScan = active.kind === 'shield' || (active.kind === 'defender' && (IS_WIN || !!findExecutable(['/usr/local/bin/mdatp', '/usr/bin/mdatp']))) || (active.kind === 'product' && !!scanCommand(active.id));
    return {
      choice: s.provider,
      managed: isPathLocked('protection.provider', this.d.locked()),
      active,
      state,
      realtime,
      upToDate,
      definitionsAgeDays,
      lastScan,
      threats,
      problems,
      notes,
      products,
      options,
      canScan,
      shield,
      checkedAt: new Date().toISOString(),
    };
  }

  async setProvider(value: string): Promise<ProtectionStatus> {
    const v = value.trim();
    if (!/^(auto|shield|defender|product:[a-z0-9-]{1,40})$/.test(v)) throw new CoreError('INVALID_ARGUMENT', 'Unknown antivirus choice');
    if (isPathLocked('protection.provider', this.d.locked())) throw new CoreError('MANAGED', 'Your organization chooses the antivirus on this computer.');
    this.d.setProvider(v);
    return this.status(true);
  }

  // ---------------------------------------------------------------------------------------------- scans

  /** Where a quick or full scan looks (FBRX Shield). */
  targets(type: ScanType, path?: string): string[] {
    const { home, downloads, desktop } = this.d.dirs();
    if (type === 'custom') {
      if (!path?.trim()) throw new CoreError('INVALID_ARGUMENT', 'Choose a file or folder to scan');
      return [path.trim()];
    }
    const startup = IS_WIN
      ? [join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'), join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'StartUp')]
      : process.platform === 'darwin'
        ? [join(home, 'Library', 'LaunchAgents'), '/Library/LaunchAgents', '/Library/LaunchDaemons']
        : [join(home, '.config', 'autostart')];
    const list = type === 'quick' ? [...[downloads, desktop].filter((x) => x !== home), tmpdir(), ...startup] : [home, tmpdir(), ...startup];
    return [...new Set(list)].filter((x) => x && existsSync(x));
  }

  job(): ScanJob | null {
    return this.current;
  }

  /** Starts a scan with the active antivirus (or FBRX Shield for a second opinion). One at a time. */
  scan(p: { type: ScanType; path?: string; engine?: 'active' | 'shield'; quarantine?: boolean }): ScanJob {
    if (this.current?.state === 'running') throw new CoreError('CONFLICT', 'A scan is already running.');
    const st = this.cached;
    const kind: ProtectionKind = p.engine === 'shield' || !st ? 'shield' : st.active.kind;
    const engineName = kind === 'shield' ? 'FBRX Shield' : st!.active.name;
    if (kind === 'product' && !scanCommand(st!.active.id)) throw new CoreError('UNAVAILABLE', `${engineName} has no scanner FBRX can start. Open ${engineName} to scan, or scan with FBRX Shield.`);
    const targets = kind === 'shield' || kind === 'product' ? this.targets(p.type, p.path) : p.type === 'custom' ? this.targets('custom', p.path) : [];
    const job: ScanJob = {
      id: newId('scan'),
      engine: kind,
      engineName,
      type: p.type,
      target: p.type === 'custom' ? (p.path ?? null) : null,
      state: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      files: 0,
      skipped: 0,
      current: null,
      found: 0,
      detections: [],
      output: null,
      error: null,
    };
    this.current = job;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const emit = () => this.d.events.emit('protection.scan', { ...job, detections: job.detections.slice(0, 50) });
    emit();
    const run = async () => {
      if (kind === 'shield') {
        const r = await this.d.shield.scan(targets, {
          signal,
          quarantine: p.quarantine !== false,
          onProgress: (x) => {
            Object.assign(job, { files: x.files, skipped: x.skipped, found: x.found, current: x.current });
            emit();
          },
        });
        Object.assign(job, { files: r.files, skipped: r.skipped, found: r.detections.length, detections: r.detections });
        this.d.meta.set('shield.lastScan', { at: new Date().toISOString(), type: p.type, files: r.files, found: r.detections.length });
      } else if (kind === 'defender' && IS_WIN) {
        const r = await sec.scan(p.type, p.path);
        Object.assign(job, { found: r.threatsFound ? 1 : 0, output: r.output.slice(-4000) });
      } else {
        const exe = kind === 'defender' ? findExecutable(['/usr/local/bin/mdatp', '/usr/bin/mdatp']) : scanCommand(st!.active.id)?.exe;
        if (!exe) throw new Error(`${engineName}'s scanner is not on this computer.`);
        const outputs: string[] = [];
        let found = false;
        const runs = kind === 'defender' ? [p.type === 'custom' ? ['scan', 'custom', '--path', targets[0]] : ['scan', p.type]] : targets.map((t) => scanCommand(st!.active.id)!.cmd.args(t));
        for (const args of runs) {
          if (signal.aborted) break;
          const r = await exec(exe, args, { timeoutMs: 6 * 3600_000, signal });
          outputs.push(`${r.out}${r.err}`.trim());
          const cmd = kind === 'product' ? scanCommand(st!.active.id)!.cmd : null;
          if ((cmd && cmd.foundCodes.includes(r.code ?? -1)) || (/\b(?:threats?|infected|malware|virus(?:es)?)\b[^\r\n]{0,40}\b(?:found|detected)\b/i.test(r.out) && !/\b(?:no|0)\s+(?:threats?|infected|malware)/i.test(r.out))) found = true;
          else if (r.code !== 0 && cmd && !cmd.cleanCodes.includes(r.code ?? -1)) throw new Error(`${engineName} stopped with code ${r.code}: ${(r.err || r.out).trim().slice(-300)}`);
        }
        Object.assign(job, { found: found ? 1 : 0, output: outputs.join('\n').slice(-4000) });
        if (kind === 'product') this.d.meta.set(`protection.lastScan.${st!.active.id}`, new Date().toISOString());
      }
      job.state = signal.aborted ? 'cancelled' : 'done';
    };
    void run()
      .catch((err) => {
        job.state = signal.aborted ? 'cancelled' : 'failed';
        job.error = errorMessage(err);
      })
      .finally(() => {
        job.current = null;
        job.finishedAt = new Date().toISOString();
        emit();
        if (this.running) void this.status(true).catch(() => undefined);
      });
    return job;
  }

  cancel(): { ok: true } {
    this.abort?.abort();
    return { ok: true };
  }

  /** A new finding: tell the person, and FBRX Command through the alert channels. */
  onDetection(d: ShieldDetection): void {
    this.d.events.emit('shield.detected', d);
    if (this.running) void this.status(true).catch(() => undefined);
    const where = d.source === 'download' ? 'A new download' : 'A file';
    const what = d.kind === 'suspicious' ? 'looks suspicious' : d.kind === 'test' ? 'is the antivirus test file' : 'is malware';
    const done = d.action === 'quarantined' ? ' It is in quarantine now.' : d.kind === 'suspicious' ? ' Open FBRX Shield to decide what to do.' : ' Open FBRX Shield to quarantine it.';
    this.d.alert('shield_threat', `FBRX Shield: ${d.name}`, `${where} ${what}: ${d.path}. ${d.reason}${done}`, d.id);
  }
}

/** Default folders for scans and download checks. */
export function defaultDirs(): { home: string; downloads: string; desktop: string } {
  const home = homedir();
  return { home, downloads: join(home, 'Downloads'), desktop: join(home, 'Desktop') };
}
