import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  DEFAULT_DIRECTORY_RULES,
  DIRECTORY_ADMINS,
  DIRECTORY_FULLNAME_RE,
  directoryCovers,
  directoryGroupProblem,
  directoryPasswordProblem,
  directoryUserProblem,
  newId,
  type DirectoryComputer,
  type DirectoryGroup,
  type DirectoryJoinCode,
  type DirectoryPolicy,
  type DirectoryReport,
  type DirectoryRules,
  type DirectoryStatus,
  type DirectoryUser,
} from '@fbrx/shared';
import { openString, sealString, type Db } from '@fbrx/shared/node';
import { badRequest, conflict, notFound, unauthorized } from '../errors';

/**
 * The FBRX directory (the directory role). Its state lives in the settings table (one record). A first password is
 * sealed with the server's key and handed once to each computer the person gets an account on; computers prove
 * themselves with a token the server keeps only a hash of, given in exchange for a join code (also kept as a hash).
 */

interface SavedUser extends Omit<DirectoryUser, 'passwordWaiting'> {
  /** The first password, sealed. */
  secret: string | null;
}

interface SavedComputer extends DirectoryComputer {
  tokenHash: string;
  /** The first-password versions this computer set, by account. */
  passwords: Record<string, number>;
}

interface SavedCode extends DirectoryJoinCode {
  hash: string;
}

interface Saved {
  name: string;
  version: number;
  rules: DirectoryRules;
  users: SavedUser[];
  groups: DirectoryGroup[];
  computers: SavedComputer[];
  codes: SavedCode[];
  /** Accounts that were removed: computers disable them (never delete them). */
  retired: string[];
}

const KEY = 'directory.state';
const ADMINS_GROUP: DirectoryGroup = { name: DIRECTORY_ADMINS, description: 'Administrators of the computers they have an account on', builtIn: true };
export const MAX_DIRECTORY_USERS = 500;
const MAX_GROUPS = 100;
const MAX_COMPUTERS = 2000;
const MAX_CODES = 50;
/** Join codes: no letters that read like others (0/O, 1/I/L). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** Join codes are typed by people: case, spaces and dashes do not count. */
export const normalCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

export interface UserInput {
  username: string;
  fullName?: string;
  enabled?: boolean;
  groups?: string[];
  computers?: 'all' | string[];
  password?: string;
}

export interface DirectoryServiceOptions {
  db: Db;
  key: Uint8Array;
  /** The directory's name until an administrator gives it one (the server's). */
  defaultName: string;
  now?: () => Date;
}

export class DirectoryService {
  constructor(private readonly o: DirectoryServiceOptions) {}

  private now() {
    return (this.o.now?.() ?? new Date()).toISOString();
  }

  private load(): Saved {
    const r = this.o.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', KEY);
    const s: Partial<Saved> = r ? JSON.parse(r.value) : {};
    return {
      name: s.name ?? this.o.defaultName,
      version: s.version ?? 1,
      rules: { ...DEFAULT_DIRECTORY_RULES, ...s.rules },
      users: s.users ?? [],
      groups: s.groups?.some((g) => g.name === DIRECTORY_ADMINS) ? s.groups : [ADMINS_GROUP, ...(s.groups ?? [])],
      computers: s.computers ?? [],
      codes: s.codes ?? [],
      retired: s.retired ?? [],
    };
  }

  private save(s: Saved) {
    this.o.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', KEY, JSON.stringify(s));
  }

  /** A change computers apply: the version goes up. */
  private change(fn: (s: Saved) => void): Saved {
    const s = this.load();
    fn(s);
    s.version += 1;
    this.save(s);
    return s;
  }

  status(): Omit<DirectoryStatus, 'certificate'> {
    const s = this.load();
    const nowMs = Date.parse(this.now());
    return {
      enabled: true,
      name: s.name,
      version: s.version,
      rules: s.rules,
      users: s.users.map(({ secret, ...u }) => ({ ...u, passwordWaiting: !!secret })),
      groups: s.groups,
      computers: s.computers.map(({ tokenHash: _t, passwords: _p, ...c }) => c),
      codes: s.codes.filter((c) => c.usesLeft > 0 && Date.parse(c.expiresAt) > nowMs).map(({ hash: _h, ...c }) => c),
    };
  }

  setup(p: { name?: string; rules?: Partial<DirectoryRules> }): Omit<DirectoryStatus, 'certificate'> {
    const name = p.name?.trim();
    if (name !== undefined && (!name || name.length > 80 || !DIRECTORY_FULLNAME_RE.test(name))) throw badRequest('Give the directory a name of up to 80 characters');
    const rules = p.rules ? checkRules({ ...this.load().rules, ...p.rules }) : null;
    this.change((s) => {
      if (name) s.name = name;
      if (rules) s.rules = rules;
    });
    return this.status();
  }

  private checkGroups(s: Saved, groups: string[]): string[] {
    const out = [...new Set(groups.map((g) => g.trim().toLowerCase()))];
    for (const g of out) if (!s.groups.some((x) => x.name === g)) throw badRequest(`There is no group ${g}: add it first`);
    return out;
  }

  private checkComputers(s: Saved, computers: 'all' | string[]): 'all' | string[] {
    if (computers === 'all') return 'all';
    const out = [...new Set(computers)];
    for (const c of out) if (!s.computers.some((x) => x.id === c)) throw badRequest('One of those computers is not in the directory any more');
    return out;
  }

  addUser(p: UserInput): DirectoryUser {
    const username = p.username.trim().toLowerCase();
    const problem = directoryUserProblem(username);
    if (problem) throw badRequest(problem);
    const s0 = this.load();
    if (s0.users.some((u) => u.username === username)) throw conflict(`${username} is in the directory already`);
    if (s0.users.length >= MAX_DIRECTORY_USERS) throw conflict(`At most ${MAX_DIRECTORY_USERS} people are in a directory`);
    if (!p.password) throw badRequest('Give a first password: each computer sets it, and the person changes it when they first sign in');
    const pwProblem = directoryPasswordProblem(p.password, s0.rules);
    if (pwProblem) throw badRequest(pwProblem);
    const fullName = checkFullName(p.fullName ?? '');
    const now = this.now();
    let user!: SavedUser;
    this.change((s) => {
      user = {
        username,
        fullName,
        enabled: p.enabled ?? true,
        groups: this.checkGroups(s, p.groups ?? []),
        computers: this.checkComputers(s, p.computers ?? 'all'),
        secret: sealString(this.o.key, p.password!, `directory.user:${username}`),
        passwordVersion: 1,
        createdAt: now,
        updatedAt: now,
      };
      s.users.push(user);
      s.retired = s.retired.filter((r) => r !== username);
    });
    return this.user(username);
  }

  user(username: string): DirectoryUser {
    const u = this.status().users.find((x) => x.username === username);
    if (!u) throw notFound(`${username} is not in the directory`);
    return u;
  }

  updateUser(username: string, p: Omit<UserInput, 'username'>): DirectoryUser {
    const s0 = this.load();
    if (!s0.users.some((u) => u.username === username)) throw notFound(`${username} is not in the directory`);
    if (p.password !== undefined) {
      const pwProblem = directoryPasswordProblem(p.password, s0.rules);
      if (pwProblem) throw badRequest(pwProblem);
    }
    const fullName = p.fullName !== undefined ? checkFullName(p.fullName) : undefined;
    this.change((s) => {
      const u = s.users.find((x) => x.username === username)!;
      if (fullName !== undefined) u.fullName = fullName;
      if (p.enabled !== undefined) u.enabled = p.enabled;
      if (p.groups) u.groups = this.checkGroups(s, p.groups);
      if (p.computers) u.computers = this.checkComputers(s, p.computers);
      if (p.password !== undefined) {
        u.secret = sealString(this.o.key, p.password, `directory.user:${username}`);
        u.passwordVersion += 1;
      }
      u.updatedAt = this.now();
    });
    return this.user(username);
  }

  /** The account leaves the directory; computers disable it and keep its files. */
  removeUser(username: string): void {
    if (!this.load().users.some((u) => u.username === username)) throw notFound(`${username} is not in the directory`);
    this.change((s) => {
      s.users = s.users.filter((u) => u.username !== username);
      if (!s.retired.includes(username)) s.retired.push(username);
      for (const c of s.computers) delete c.passwords[username];
    });
  }

  addGroup(p: { name: string; description?: string }): DirectoryGroup {
    const name = p.name.trim().toLowerCase();
    const problem = directoryGroupProblem(name);
    if (problem) throw badRequest(problem);
    const s0 = this.load();
    if (s0.groups.some((g) => g.name === name)) throw conflict(`There is a group ${name} already`);
    if (s0.groups.length >= MAX_GROUPS) throw conflict(`At most ${MAX_GROUPS} groups`);
    const group: DirectoryGroup = { name, description: checkFullName(p.description ?? '', 'The description'), builtIn: false };
    this.change((s) => s.groups.push(group));
    return group;
  }

  updateGroup(name: string, p: { description: string }): DirectoryGroup {
    const description = checkFullName(p.description, 'The description');
    const s = this.load();
    const g = s.groups.find((x) => x.name === name);
    if (!g) throw notFound(`There is no group ${name}`);
    g.description = description;
    this.save(s);
    return g;
  }

  /** Its members leave it on their computers; the group itself stays there. */
  removeGroup(name: string): void {
    const g = this.load().groups.find((x) => x.name === name);
    if (!g) throw notFound(`There is no group ${name}`);
    if (g.builtIn) throw conflict('Administrators is built in: take people out of it instead');
    this.change((s) => {
      s.groups = s.groups.filter((x) => x.name !== name);
      for (const u of s.users) u.groups = u.groups.filter((x) => x !== name);
    });
  }

  /** A join code, shown this once. */
  addCode(p: { label?: string; days?: number; uses?: number }): { code: DirectoryJoinCode; value: string } {
    const s = this.load();
    const nowMs = Date.parse(this.now());
    s.codes = s.codes.filter((c) => c.usesLeft > 0 && Date.parse(c.expiresAt) > nowMs);
    if (s.codes.length >= MAX_CODES) throw conflict(`At most ${MAX_CODES} join codes at a time: remove some`);
    const raw = Array.from({ length: 10 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    const days = Math.min(Math.max(Math.round(p.days ?? 7), 1), 90);
    const code: SavedCode = {
      id: newId('jc'),
      label: checkFullName(p.label ?? '', 'The label'),
      expiresAt: new Date(nowMs + days * 86_400_000).toISOString(),
      usesLeft: Math.min(Math.max(Math.round(p.uses ?? 1), 1), 500),
      createdAt: this.now(),
      hash: sha256(raw),
    };
    s.codes.push(code);
    this.save(s);
    const { hash: _h, ...view } = code;
    return { code: view, value: `${raw.slice(0, 5)}-${raw.slice(5)}` };
  }

  removeCode(id: string): void {
    const s = this.load();
    if (!s.codes.some((c) => c.id === id)) throw notFound('That join code is gone already');
    s.codes = s.codes.filter((c) => c.id !== id);
    this.save(s);
  }

  /** The computer's token stops working; the accounts on it stay as they are. */
  removeComputer(id: string): DirectoryComputer {
    const c = this.load().computers.find((x) => x.id === id);
    if (!c) throw notFound('That computer is not in the directory any more');
    this.change((s) => {
      s.computers = s.computers.filter((x) => x.id !== id);
      for (const u of s.users) if (u.computers !== 'all') u.computers = u.computers.filter((x) => x !== id);
    });
    const { tokenHash: _t, passwords: _p, ...view } = c;
    return view;
  }

  /** A computer joins with a join code and gets its token (shown this once). */
  join(p: { code: string; name: string; os: DirectoryComputer['os'] }): { computerId: string; token: string; directory: string } {
    const s = this.load();
    const nowMs = Date.parse(this.now());
    const hash = sha256(normalCode(p.code));
    const code = s.codes.find((c) => same(c.hash, hash) && c.usesLeft > 0 && Date.parse(c.expiresAt) > nowMs);
    if (!code) throw unauthorized('That join code is not right, or it was used up or ran out');
    if (s.computers.length >= MAX_COMPUTERS) throw conflict(`At most ${MAX_COMPUTERS} computers are in a directory`);
    const secret = randomBytes(32).toString('base64url');
    const computer: SavedComputer = {
      id: newId('dc'),
      name: p.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) || 'Computer',
      os: p.os,
      joinedAt: this.now(),
      lastSeenAt: this.now(),
      applied: null,
      tokenHash: sha256(secret),
      passwords: {},
    };
    code.usesLeft -= 1;
    s.computers.push(computer);
    this.save(s);
    return { computerId: computer.id, token: `${computer.id}.${secret}`, directory: s.name };
  }

  /** The computer a token belongs to (it is seen now). */
  private computerFor(s: Saved, token: string | null): SavedComputer {
    const m = token ? /^(dc_[A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{20,100})$/.exec(token) : null;
    const c = m ? s.computers.find((x) => x.id === m[1]) : undefined;
    if (!c || !same(c.tokenHash, sha256(m![2]))) throw unauthorized('This computer is not in the directory (any more): join it again with a new join code');
    c.lastSeenAt = this.now();
    return c;
  }

  /** The computer a token belongs to, for the audit log. */
  computerName(token: string | null): string {
    return this.computerFor(this.load(), token).name;
  }

  /** What this computer should have; first passwords it has not set yet come along. */
  policy(token: string | null): DirectoryPolicy {
    const s = this.load();
    const c = this.computerFor(s, token);
    this.save(s);
    const mine = s.users.filter((u) => directoryCovers(u, c.id));
    return {
      directory: s.name,
      version: s.version,
      rules: s.rules,
      users: mine.map((u) => {
        const set = c.passwords[u.username] ?? 0;
        return {
          username: u.username,
          fullName: u.fullName,
          enabled: u.enabled,
          admin: u.groups.includes(DIRECTORY_ADMINS),
          groups: u.groups.filter((g) => g !== DIRECTORY_ADMINS),
          ...(u.secret && set < u.passwordVersion ? { password: { version: u.passwordVersion, value: openString(this.o.key, u.secret, `directory.user:${u.username}`) } } : {}),
        };
      }),
      groups: s.groups.filter((g) => !g.builtIn).map((g) => g.name),
      retired: [...s.retired, ...s.users.filter((u) => !directoryCovers(u, c.id)).map((u) => u.username)],
    };
  }

  /** How applying went on a computer; the first passwords it set are not sent to it again. */
  report(token: string | null, r: DirectoryReport): void {
    const s = this.load();
    const c = this.computerFor(s, token);
    c.applied = { version: Math.min(r.version, s.version), at: this.now(), ok: r.ok, problems: r.problems.slice(0, 50).map((p) => p.slice(0, 300)) };
    for (const [name, v] of Object.entries(r.passwords)) {
      const u = s.users.find((x) => x.username === name);
      if (u && Number.isInteger(v) && v >= 1 && v <= u.passwordVersion) c.passwords[name] = Math.max(c.passwords[name] ?? 0, v);
    }
    this.save(s);
  }

  /** The computer leaves the directory itself. */
  leave(token: string | null): string {
    const s = this.load();
    const c = this.computerFor(s, token);
    this.removeComputer(c.id);
    return c.name;
  }
}

function checkFullName(v: string, what = 'A full name'): string {
  const t = v.trim();
  if (!DIRECTORY_FULLNAME_RE.test(t)) throw badRequest(`${what} is up to 64 characters, without : , ; " or \\`);
  return t;
}

function checkRules(r: DirectoryRules): DirectoryRules {
  const int = (v: number, lo: number, hi: number, what: string) => {
    if (!Number.isInteger(v) || v < lo || v > hi) throw badRequest(`${what}: ${lo}-${hi}`);
    return v;
  };
  return {
    minLength: int(r.minLength, 8, 64, 'Fewest characters'),
    complex: !!r.complex,
    maxAgeDays: int(r.maxAgeDays, 0, 999, 'Days before a change'),
    lockoutAttempts: int(r.lockoutAttempts, 0, 100, 'Wrong passwords before a lockout'),
    lockoutMinutes: int(r.lockoutMinutes, 1, 1440, 'Minutes locked'),
  };
}
