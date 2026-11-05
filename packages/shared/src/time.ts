import type { Schedule } from './schedule';

/**
 * FBRX Time: whole-machine image backups. On FBRX Server (the time role) it backs up virtual machines, keeps the images
 * computers send to its backup folder, and checks each image the only way that proves it: it opens the image as a
 * throwaway virtual machine with no network, confirms it starts, then shuts it down and deletes it. On a computer
 * (FBRX Endpoint) it makes a full image of the computer, by hand or on a schedule, to a drive or a network folder.
 */

// ------------------------------------------------------------------------------------------- the server

export type TimeImageSource = 'vm' | 'computer';
export type BootCheckState = 'none' | 'queued' | 'running' | 'passed' | 'warning' | 'failed';

/** A backup job on the server: one virtual machine, on a schedule. */
export interface TimeJob {
  id: string;
  name: string;
  vmId: string;
  vmName: string;
  schedule: Schedule;
  /** 24-hour local time ("21:30"). */
  time: string;
  /** For a weekly job: 0 = Sunday … 6 = Saturday. */
  day: number;
  /** Boot-check each new image. */
  verify: boolean;
  /** Images kept for this machine; older ones are deleted after a new one is made. */
  keep: number;
  enabled: boolean;
  lastRunAt: string | null;
  lastOk: boolean | null;
  nextRunAt: string | null;
  createdAt: string;
}

export interface TimeJobInput {
  name?: string;
  vmId: string;
  schedule: Schedule;
  time: string;
  day: number;
  verify: boolean;
  keep: number;
  enabled?: boolean;
}

export interface TimeDiskFile {
  /** The disk it was in the machine (vda, sda…). */
  target: string;
  /** File name in the image's folder. */
  file: string;
  format: 'qcow2' | 'vhdx' | 'raw';
  bus: string;
  bytes: number;
  /** The disk's size as the machine sees it. */
  virtualBytes: number | null;
}

/** What the last boot check saw. */
export interface BootCheck {
  state: BootCheckState;
  at: string | null;
  /** How long the throwaway machine ran. */
  seconds: number | null;
  /** In words: "Started and kept running for 3 minutes; its screen shows a picture; the guest agent answered." */
  detail: string;
  /** Its screen at the end (a PNG in the image's folder), when there was one. */
  screenshot: string | null;
  /** The machine's guest agent answered (the operating system is up), when it has one. */
  agent: boolean | null;
}

export interface TimeImage {
  id: string;
  source: TimeImageSource;
  /** The virtual machine's or the computer's name. */
  subject: string;
  jobId: string | null;
  createdAt: string;
  bytes: number;
  disks: TimeDiskFile[];
  os: 'linux' | 'windows' | 'other';
  firmware: 'bios' | 'uefi';
  /**
   * offline: the machine was off; quiesced: its guest agent paused writes for the copy (consistent applications);
   * crash: copied while running, like pulling the plug (file systems recover, open databases may replay their logs);
   * computer: made by the computer itself (its own snapshot service).
   */
  consistency: 'offline' | 'quiesced' | 'crash' | 'computer';
  check: BootCheck;
  note: string;
}

export type TimeTaskKind = 'backup' | 'check' | 'restore' | 'import';

/** Something FBRX Time is doing or did: one at a time, the rest wait their turn. */
export interface TimeTask {
  id: string;
  kind: TimeTaskKind;
  subject: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** 0–100 while it runs, when known. */
  progress: number | null;
  detail: string;
  imageId: string | null;
}

/** The server's backup folder that computers write their images to (an SMB share). */
export interface TimeShare {
  /** \\server\fbrx-time */
  path: string;
  user: string;
  /** Administrators only. */
  password: string | null;
  /** All three in one line, for FBRX Endpoint (Backup → Whole computer → An FBRX Server). */
  code: string | null;
}

export interface TimeSettings {
  /** Boot-check images from computers when they arrive. */
  verifyComputers: boolean;
  /** How long a boot check lets the machine run before it judges it. */
  checkSeconds: number;
  /** Images kept for each computer. */
  keepComputer: number;
}

export interface TimeComputer {
  name: string;
  images: number;
  lastImageAt: string | null;
  /** A backup is landing in the folder now. */
  receiving: boolean;
}

export interface TimeStatus {
  /** The time role is on this server. */
  enabled: boolean;
  repository: string;
  usedBytes: number;
  freeBytes: number | null;
  totalBytes: number | null;
  share: TimeShare | null;
  settings: TimeSettings;
  computers: TimeComputer[];
  /** Running and waiting first, then the latest finished ones. */
  tasks: TimeTask[];
  /** The hypervisor can open images (for boot checks and restores). */
  canBoot: boolean;
}

export const TIME_DEFAULT_SETTINGS: TimeSettings = { verifyComputers: true, checkSeconds: 180, keepComputer: 7 };

// ------------------------------------------------------------------------------------------ connection code

export interface TimeCode {
  /** \\server\fbrx-time */
  share: string;
  user: string;
  password: string;
  /** The server's name, to show. */
  server: string;
}

const CODE_PREFIX = 'fbrx-time:';
// base64url of UTF-8 text, in browsers and Node alike.
const toB64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64 = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

/** One line a person copies from the server to a computer: where to back up to, and how to sign in there. */
export function encodeTimeCode(c: TimeCode): string {
  return CODE_PREFIX + toB64(JSON.stringify({ s: c.share, u: c.user, p: c.password, n: c.server }));
}

export function decodeTimeCode(code: string): TimeCode | null {
  const t = code.trim();
  if (!t.startsWith(CODE_PREFIX)) return null;
  try {
    const j = JSON.parse(fromB64(t.slice(CODE_PREFIX.length))) as { s?: unknown; u?: unknown; p?: unknown; n?: unknown };
    if (typeof j.s !== 'string' || !/^\\\\[^\\]+\\[^\\]+/.test(j.s) || typeof j.u !== 'string' || typeof j.p !== 'string') return null;
    return { share: j.s, user: j.u, password: j.p, server: typeof j.n === 'string' ? j.n : '' };
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------------------------- a computer

/** FBRX Endpoint's whole-computer image: where it goes and when. */
export interface ImageBackupConfig {
  /** A drive ("E:") or a network folder ("\\server\share"). */
  target: string;
  /** For a network folder. */
  user: string;
  schedule: Schedule;
  time: string;
  day: number;
}

export interface ImageBackupRun {
  at: string;
  finishedAt: string | null;
  ok: boolean;
  target: string;
  /** What Windows said, the end of it. */
  detail: string;
}

export interface ImageBackupStatus {
  /** This computer can make image backups here (Windows, for now). */
  supported: boolean;
  /** Why not, in words. */
  reason: string | null;
  /** Set up: the backup task exists on this computer (made once, with administrator permission). */
  configured: boolean;
  config: ImageBackupConfig | null;
  running: boolean;
  startedAt: string | null;
  last: ImageBackupRun | null;
  /** Images Windows lists at the target, newest first. */
  versions: string[];
  nextAt: string | null;
}
