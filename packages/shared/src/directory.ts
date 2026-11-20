/**
 * The FBRX directory (FBRX Server's directory role): the same accounts on every computer that joins it. The server
 * keeps the users, their groups (Administrators makes them administrators of their computers), which computers they
 * get an account on, and the password rules; each computer's FBRX OS applies them through that computer's own
 * administrator prompt. An account's password is the computer's own once its person has signed in and changed the
 * first one. Signing in against the server itself (a domain) is for later.
 */

/** The built-in group whose members are administrators of the computers they have an account on. */
export const DIRECTORY_ADMINS = 'administrators';

/** Short account names every system accepts: Windows allows 20 characters, and capitals mean nothing to it. */
export const DIRECTORY_USER_RE = /^[a-z][a-z0-9_-]{0,19}$/;
export const DIRECTORY_GROUP_RE = /^[a-z][a-z0-9_-]{0,31}$/;
/** A full name: no characters that the account databases use as separators, and no control characters. */
export const DIRECTORY_FULLNAME_RE = /^[^\u0000-\u001f\u007f:,;"\\]{0,64}$/;

/** Accounts that belong to the system (or to FBRX), which the directory never makes or changes. */
export const DIRECTORY_RESERVED_USERS = [
  'root', 'admin', 'administrator', 'guest', 'nobody', 'daemon', 'bin', 'sys', 'sync', 'games', 'man', 'lp', 'mail', 'news', 'uucp', 'proxy', 'www-data',
  'backup', 'list', 'irc', 'gnats', 'systemd-network', 'systemd-resolve', 'messagebus', 'syslog', 'sshd', 'defaultaccount', 'wdagutilityaccount', 'krbtgt',
  'fbrx-time', 'fbrx-command', 'fbrx-core', 'fbrx-files', 'fbrx-server',
];

/**
 * Groups that already mean something on a computer (a way to be an administrator, read every disk or every log).
 * Administrators is the directory's one way to give administrator rights.
 */
export const DIRECTORY_RESERVED_GROUPS = [
  'admin', 'sudo', 'wheel', 'root', 'adm', 'staff', 'users', 'everyone', 'disk', 'shadow', 'docker', 'lxd', 'libvirt', 'kvm', 'lpadmin', 'sambashare', 'systemd-journal',
  'operator', 'daemon', 'bin', 'sys', 'tty', 'audio', 'video', 'plugdev', 'netdev', 'dialout', 'nogroup', 'guests', 'power users', 'backup operators',
  'remote desktop users', 'network configuration operators', 'hyper-v administrators', 'access control assistance operators', 'fbrx-files',
];

export interface DirectoryRules {
  /** Fewest characters in a password (Windows applies at most 14 this way). */
  minLength: number;
  /** Capitals, small letters and numbers, all three. */
  complex: boolean;
  /** Days before a password must be changed; 0: never. */
  maxAgeDays: number;
  /** Wrong passwords in a row before the account waits; 0: no lockout. */
  lockoutAttempts: number;
  /** How long it waits. */
  lockoutMinutes: number;
}

export const DEFAULT_DIRECTORY_RULES: DirectoryRules = { minLength: 12, complex: true, maxAgeDays: 0, lockoutAttempts: 10, lockoutMinutes: 15 };

export interface DirectoryUser {
  username: string;
  fullName: string;
  /** A disabled account stays on its computers (with its files) but nobody can sign in to it. */
  enabled: boolean;
  /** Group names; administrators among them makes this person an administrator. */
  groups: string[];
  /** The computers (their ids) this person gets an account on, or all that join. */
  computers: 'all' | string[];
  /** A first password waits to be set on computers (each computer gets it once). */
  passwordWaiting: boolean;
  /** Raised each time an administrator sets a new first password. */
  passwordVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface DirectoryGroup {
  name: string;
  description: string;
  /** Administrators: its members are administrators of their computers. It cannot be removed. */
  builtIn: boolean;
}

export interface DirectoryComputer {
  id: string;
  name: string;
  os: 'windows' | 'mac' | 'linux';
  joinedAt: string;
  lastSeenAt: string | null;
  /** The directory version it last applied, and how that went. */
  applied: { version: number; at: string; ok: boolean; problems: string[] } | null;
}

/** A code a computer joins with: shown once, when it is made. */
export interface DirectoryJoinCode {
  id: string;
  label: string;
  expiresAt: string;
  usesLeft: number;
  createdAt: string;
}

export interface DirectoryStatus {
  enabled: true;
  /** Its name, shown on computers ("Fox Huntress Labs"). */
  name: string;
  /** Raised with every change computers apply. */
  version: number;
  rules: DirectoryRules;
  users: DirectoryUser[];
  groups: DirectoryGroup[];
  computers: DirectoryComputer[];
  codes: DirectoryJoinCode[];
  /** This server's certificate fingerprint, for a computer to compare once when it saves the server. */
  certificate: string | null;
}

/** One account as a computer is told to have it. */
export interface DirectoryPolicyUser {
  username: string;
  fullName: string;
  enabled: boolean;
  admin: boolean;
  /** Groups other than administrators. */
  groups: string[];
  /** A first password this computer has not set yet. */
  password?: { version: number; value: string };
}

/** What the directory tells one computer to have. */
export interface DirectoryPolicy {
  directory: string;
  version: number;
  rules: DirectoryRules;
  users: DirectoryPolicyUser[];
  /** Groups to have (other than administrators). */
  groups: string[];
  /** Directory accounts that are gone or no longer for this computer: disabled there, never deleted. */
  retired: string[];
}

/** What a computer says after applying (or failing to apply) a version. */
export interface DirectoryReport {
  version: number;
  ok: boolean;
  problems: string[];
  /** The first-password versions it set, by account. */
  passwords: Record<string, number>;
}

/** This computer in a directory, as FBRX OS shows it. */
export interface DirectoryMembership {
  joined: boolean;
  /** The saved server it joined through. */
  serverId: string | null;
  serverName: string | null;
  directory: string | null;
  computerId: string | null;
  /** The newest version the server has, and the one this computer last applied. */
  version: number | null;
  appliedVersion: number | null;
  lastSyncAt: string | null;
  lastAppliedAt: string | null;
  /** Why the last sync or apply did not work, in words. */
  error: string | null;
  /** What applying would change on this computer now. */
  plan: DirectoryStep[];
  /** Problems with the last apply. */
  problems: string[];
}

export type DirectoryStepKind = 'create' | 'adopt' | 'rename' | 'password' | 'admin' | 'unadmin' | 'makeGroup' | 'join' | 'leave' | 'disable' | 'enable' | 'rules';

export interface DirectoryStep {
  kind: DirectoryStepKind;
  user?: string;
  group?: string;
  /** What it does, in words. */
  words: string;
}

/** What is wrong with a user name, in words (null: fine). */
export function directoryUserProblem(username: string): string | null {
  if (!DIRECTORY_USER_RE.test(username)) return 'Account names are 1-20 small letters, numbers, - or _, starting with a letter';
  if (DIRECTORY_RESERVED_USERS.includes(username)) return `${username} belongs to the system`;
  return null;
}

/** What is wrong with a group name, in words (null: fine). */
export function directoryGroupProblem(name: string): string | null {
  if (!DIRECTORY_GROUP_RE.test(name)) return 'Group names are 1-32 small letters, numbers, - or _, starting with a letter';
  if (DIRECTORY_RESERVED_GROUPS.includes(name)) return `${name} already means something on computers: use administrators to give administrator rights`;
  return null;
}

/** What is wrong with a first password under these rules, in words (null: fine). */
export function directoryPasswordProblem(password: string, rules: DirectoryRules): string | null {
  if (/[\u0000-\u001f\u007f]/.test(password)) return 'A password cannot hold line breaks or other control characters';
  if (password.length > 128) return 'At most 128 characters';
  if (password.length < Math.max(rules.minLength, 8)) return `At least ${Math.max(rules.minLength, 8)} characters`;
  if (rules.complex && !(/[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password))) return 'Use capitals, small letters and numbers';
  return null;
}

/** Whether this user gets an account on that computer. */
export function directoryCovers(user: Pick<DirectoryUser, 'computers'>, computerId: string): boolean {
  return user.computers === 'all' || user.computers.includes(computerId);
}

/** The rules in words, as computers and the console list them. */
export function directoryRulesWords(r: DirectoryRules): string[] {
  return [
    `At least ${r.minLength} characters${r.complex ? ', with capitals, small letters and numbers' : ''}`,
    r.maxAgeDays ? `Changed every ${r.maxAgeDays} days` : 'No forced changes',
    r.lockoutAttempts ? `${r.lockoutAttempts} wrong passwords in a row lock the account for ${r.lockoutMinutes} minutes` : 'No lockout',
  ];
}
