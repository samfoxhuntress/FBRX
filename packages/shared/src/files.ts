import type { MeshTrafficClass } from './net';
import type { Schedule } from './schedule';

/**
 * The file server on FBRX Server (the files role): shared folders for your network. "host" serves them from the
 * server itself (Samba, folders in /srv/fbrx-files); "vm" makes one of its virtual machines the file server (a NAS
 * system, Windows Server, any machine that shares folders): FBRX gives its traffic priority and backs it up, the
 * machine keeps its own shares. Either way, backups copy the files to another device (a NAS, another server) on a
 * schedule and keep what changed for a while.
 */
export type FilesMode = 'off' | 'host' | 'vm';

/** SMB (445) and NFS (2049): the traffic that goes first with priority on. */
export const FILES_PORTS = [445, 2049] as const;

/** Share names: lowercase letters, digits and dashes (they are folder names on the server too). */
export const FILES_SHARE_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** Account names: lowercase letters, digits, dash and underscore, as Linux takes them. */
export const FILES_ACCOUNT_RE = /^[a-z][a-z0-9_-]{1,30}$/;
/** Names Samba or the server keep for themselves. */
export const FILES_RESERVED_SHARES = ['global', 'homes', 'printers', 'netlogon', 'sysvol', 'fbrx-time', 'ipc'];
export const FILES_RESERVED_ACCOUNTS = ['root', 'admin', 'administrator', 'guest', 'nobody', 'fbrx-time', 'fbrx-command', 'fbrx-core', 'fbrx-files'];

/** A shared folder served by this server (host mode). */
export interface FileShare {
  name: string;
  comment: string;
  readOnly: boolean;
  /** Who may open it: these accounts, or every file server account when empty. */
  accounts: string[];
  /** The folder on the server. */
  path: string;
  /** What is in it, when it could be counted. */
  sizeBytes: number | null;
}

/** An account people sign in to the shares with (no login on the server itself). */
export interface FilesAccount {
  name: string;
  createdAt: string;
}

/** The virtual machine that is the file server (vm mode). */
export interface FilesVm {
  vmId: string;
  name: string;
  /** Its address on the network: the one it reports, or the one typed in. */
  address: string | null;
  /** The address was typed in (the machine does not report one). */
  addressSet: boolean;
  running: boolean | null;
  /** It starts with the server. */
  autostart: boolean | null;
}

export interface FilesPriority {
  enabled: boolean;
  trafficClass: MeshTrafficClass;
  /** In place on this server: true, false, or null when it cannot be told (nftables missing). */
  applied: boolean | null;
}

/** Where a backup reads from or writes to, on another device. */
export type FilesPlace =
  /** A Windows-style shared folder: \\nas\backups (or //nas/backups), signed in as user. */
  | { kind: 'smb'; path: string; user: string; hasPassword: boolean }
  /** An NFS export: nas:/export/backups. */
  | { kind: 'nfs'; path: string };

export interface FilesBackupRun {
  state: 'running' | 'ok' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  /** Files copied this time, and their size. */
  files: number | null;
  bytes: number | null;
  detail: string;
  /** This server's AI on a backup that failed (with the ai role). */
  advice: string | null;
}

export interface FilesBackup {
  id: string;
  name: string;
  /** A share on this server (host mode), or a folder on another device (the file server machine, say). */
  source: { kind: 'share'; share: string } | { kind: 'remote'; place: FilesPlace };
  /** The device the copy goes to. Each backup gets a folder of its own there: <name>/current, <name>/kept/<date>. */
  destination: FilesPlace;
  /** Its folder at the destination (from its name). */
  folder: string;
  schedule: Schedule;
  time: string;
  day: number;
  /** Files changed or deleted are kept this many days in <name>/kept. */
  keepDays: number;
  enabled: boolean;
  createdAt: string;
  last: FilesBackupRun | null;
  nextAt: string | null;
}

export interface FilesStatus {
  /** The files role is on. */
  enabled: boolean;
  mode: FilesMode;
  /** Pretend (development, demos): nothing is shared on the network. */
  simulated: boolean;
  /** Serving from this server: Samba is installed and running. */
  host: { ready: boolean; why: string | null; root: string; address: string };
  vm: FilesVm | null;
  shares: FileShare[];
  accounts: FilesAccount[];
  priority: FilesPriority;
  backups: FilesBackup[];
  /** On a gate (host mode): whether your networks may reach the shares on the gate (TCP 445). */
  gate: { present: boolean; open: boolean | null };
}

/** \\nas\backups and //nas/backups both become //nas/backups (what mount.cifs takes); null when it is not one. */
export function smbPath(p: string): string | null {
  const s = p.trim().replace(/\\/g, '/');
  const m = /^\/\/([A-Za-z0-9][A-Za-z0-9._-]*|\[[0-9a-fA-F:]+\])\/([^/][^\0]*?)\/?$/.exec(s);
  if (!m || m[2]!.split('/').some((x) => x === '..' || x === '')) return null;
  return `//${m[1]}/${m[2]}`;
}

/** nas:/export/backups, checked (the device's name starts with a letter or digit: never an option); null otherwise. */
export function nfsPath(p: string): string | null {
  const s = p.trim();
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*|\[[0-9a-fA-F:]+\]):(\/[^\0]*?)\/?$/.exec(s);
  if (!m || m[2]!.split('/').some((x) => x === '..')) return null;
  return `${m[1]}:${m[2]}`;
}

/** "\\nas\backups" for people (the way Windows writes it). */
export function placeWords(p: FilesPlace): string {
  return p.kind === 'smb' ? (smbPath(p.path) ?? p.path).replace(/\//g, '\\') : p.path;
}
