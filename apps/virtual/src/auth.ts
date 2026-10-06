import { randomUUID } from 'node:crypto';
import { VIRTUAL_ROLES, type VirtualRole, type VirtualUser } from '@fbrx/shared';
import { hashPassword, randomToken, sha256Hex, verifyPassword, type Db } from '@fbrx/shared/node';
import { badRequest, conflict, notFound, unauthorized } from './errors';

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/i;
export const MIN_PASSWORD = 10;

interface UserRow {
  id: string;
  username: string;
  name: string;
  password_hash: string;
  role: string;
  created_at: string;
  last_login_at: string | null;
}

const toUser = (r: UserRow): VirtualUser => ({ id: r.id, username: r.username, name: r.name, role: (VIRTUAL_ROLES as readonly string[]).includes(r.role) ? (r.role as VirtualRole) : 'viewer', createdAt: r.created_at, lastLoginAt: r.last_login_at });

/** What each role may do. Viewers look; operators run virtual machines; administrators change the server itself. */
export const RANK: Record<VirtualRole, number> = { viewer: 0, operator: 1, admin: 2 };
export const allows = (role: VirtualRole, needed: VirtualRole) => RANK[role] >= RANK[needed];

/** FBRX Virtual's own accounts: people who sign in to this server's console. */
export class Auth {
  // A password check costs the same whether or not the account exists.
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly db: Db,
    private readonly sessionHours: number,
  ) {}

  userCount(): number {
    return Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0);
  }

  listUsers(): VirtualUser[] {
    return this.db.all<UserRow>('SELECT * FROM users ORDER BY username').map(toUser);
  }

  getUser(id: string): VirtualUser {
    const r = this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
    if (!r) throw notFound('No such user');
    return toUser(r);
  }

  async createUser(p: { username: string; name: string; password: string; role: VirtualRole }): Promise<VirtualUser> {
    if (!USERNAME_RE.test(p.username)) throw badRequest('Usernames are 2-32 letters, digits, dots, dashes or underscores');
    if (p.password.length < MIN_PASSWORD) throw badRequest(`Passwords need at least ${MIN_PASSWORD} characters`);
    if (this.db.get('SELECT 1 FROM users WHERE username = ?', p.username)) throw conflict(`There is already a user called ${p.username}`);
    const id = randomUUID();
    this.db.run('INSERT INTO users (id, username, name, password_hash, role, created_at) VALUES (?,?,?,?,?,?)', id, p.username, p.name.trim() || p.username, await hashPassword(p.password), p.role, new Date().toISOString());
    return this.getUser(id);
  }

  private admins(): number {
    return Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")?.n ?? 0);
  }

  async updateUser(id: string, p: { name?: string; role?: VirtualRole; password?: string }): Promise<VirtualUser> {
    const u = this.getUser(id);
    if (p.role && p.role !== 'admin' && u.role === 'admin' && this.admins() <= 1) throw conflict('Keep at least one administrator');
    if (p.password !== undefined && p.password.length < MIN_PASSWORD) throw badRequest(`Passwords need at least ${MIN_PASSWORD} characters`);
    this.db.tx(() => {
      if (p.name !== undefined) this.db.run('UPDATE users SET name = ? WHERE id = ?', p.name.trim() || u.username, id);
      if (p.role !== undefined) this.db.run('UPDATE users SET role = ? WHERE id = ?', p.role, id);
    });
    if (p.password !== undefined) {
      this.db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(p.password), id);
      this.db.run('DELETE FROM sessions WHERE user_id = ?', id);
    }
    return this.getUser(id);
  }

  deleteUser(id: string): void {
    const u = this.getUser(id);
    if (u.role === 'admin' && this.admins() <= 1) throw conflict('Keep at least one administrator');
    this.db.run('DELETE FROM users WHERE id = ?', id);
  }

  async changeOwnPassword(id: string, current: string, next: string, keepToken: string): Promise<void> {
    const r = this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
    if (!r || !(await verifyPassword(current, r.password_hash))) throw badRequest('Your current password is not right');
    if (next.length < MIN_PASSWORD) throw badRequest(`Passwords need at least ${MIN_PASSWORD} characters`);
    this.db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(next), id);
    this.db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', id, sha256Hex(keepToken));
  }

  /** Checks a username and password and starts a session. */
  async login(username: string, password: string, ip: string | null): Promise<{ token: string; user: VirtualUser; expiresAt: string }> {
    const r = this.db.get<UserRow>('SELECT * FROM users WHERE username = ?', username);
    if (!r) {
      this.dummyHash ??= hashPassword('not-a-real-password');
      await verifyPassword(password, await this.dummyHash);
      throw unauthorized('Wrong username or password');
    }
    if (!(await verifyPassword(password, r.password_hash))) throw unauthorized('Wrong username or password');
    const now = new Date();
    this.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', now.toISOString(), r.id);
    return { ...this.startSession(r.id, ip), user: this.getUser(r.id) };
  }

  startSession(userId: string, ip: string | null): { token: string; expiresAt: string } {
    const token = randomToken('fbv');
    const expiresAt = new Date(Date.now() + this.sessionHours * 3600_000).toISOString();
    this.db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip) VALUES (?,?,?,?,?)', sha256Hex(token), userId, new Date().toISOString(), expiresAt, ip);
    return { token, expiresAt };
  }

  /** The signed-in person behind a session token, or null. */
  session(token: string | null | undefined): VirtualUser | null {
    if (!token) return null;
    const r = this.db.get<UserRow & { expires_at: string }>('SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?', sha256Hex(token));
    if (!r) return null;
    if (r.expires_at < new Date().toISOString()) {
      this.logout(token);
      return null;
    }
    return toUser(r);
  }

  logout(token: string): void {
    this.db.run('DELETE FROM sessions WHERE token_hash = ?', sha256Hex(token));
  }

  sweep(): void {
    this.db.run('DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString());
  }
}
