import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  DIRECTORY_FULLNAME_RE,
  directoryGroupProblem,
  directoryUserProblem,
  type DirectoryMembership,
  type DirectoryPolicy,
  type DirectoryPolicyUser,
  type DirectoryRules,
  type DirectoryStep,
} from '@fbrx/shared';
import { CoreError, errorMessage } from '../errors';
import type { MetaStore } from '../storage/meta';
import type { Vault } from '../vault/vault';
import type { SavedServers } from './saved-servers';
import { EMPTY_MEMORY, planDirectory, stepResults, type DirectoryMemory, type DirectoryOs, type LocalAccounts, type PlannedStep } from './directory-apply';

const KEY = 'directory.membership';
const TOKEN = 'fbrx.directory.token';
const SYNC_EVERY_MS = 15 * 60_000;

interface Stored {
  serverId: string;
  serverName: string;
  directory: string;
  computerId: string;
  joinedAt: string;
  version: number | null;
  appliedVersion: number | null;
  lastSyncAt: string | null;
  lastAppliedAt: string | null;
  error: string | null;
  problems: string[];
  plan: DirectoryStep[];
  memory: DirectoryMemory;
  /** The version a notice about waiting changes was last shown for. */
  noticed: number | null;
}

export interface ScriptRun {
  output: string;
  /** The person declined the administrator prompt. */
  cancelled: boolean;
}

export interface DirectoryClientDeps {
  meta: MetaStore;
  vault: Vault;
  servers: Pick<SavedServers, 'get' | 'call'>;
  audit: (action: string, details: Record<string, unknown>) => void;
  /** This system, or null where the directory cannot apply anything. */
  os: DirectoryOs | null;
  /** The account FBRX runs as (the one applying changes). */
  me: () => string;
  computerName: () => string;
  /** The accounts on this computer, and the members of the directory's groups. */
  readAccounts: (groups: string[]) => Promise<LocalAccounts>;
  /** Runs the plan through the system's administrator prompt. */
  run: (plan: { steps: PlannedStep[]; passwords: string[] }, local: LocalAccounts, workDir: string) => Promise<ScriptRun>;
  /** Where the first passwords file lives while a run waits (a folder only this account can read). */
  tmpDir: string;
  notify: (title: string, body: string) => void;
}

/**
 * This computer in an FBRX directory (FBRX Server's directory role). It joins through a saved server with a join code,
 * looks for changes every 15 minutes, and applies them when someone with administrator rights says so (the system's
 * own administrator prompt). The server's word is checked here too: names it sends that no system should get are
 * left out, never passed on.
 */
export class DirectoryClient {
  private timer: NodeJS.Timeout | null = null;
  private busy: Promise<unknown> | null = null;

  constructor(private readonly d: DirectoryClientDeps) {}

  private stored(): Stored | null {
    return this.d.meta.get<Stored>(KEY) ?? null;
  }

  private write(s: Stored | null) {
    if (s) this.d.meta.set(KEY, s);
    else this.d.meta.delete(KEY);
  }

  private patch(p: Partial<Stored>) {
    const s = this.stored();
    if (s) this.write({ ...s, ...p });
  }

  status(): DirectoryMembership {
    const s = this.stored();
    if (!s) return { joined: false, serverId: null, serverName: null, directory: null, computerId: null, version: null, appliedVersion: null, lastSyncAt: null, lastAppliedAt: null, error: null, plan: [], problems: [] };
    return {
      joined: true,
      serverId: s.serverId,
      serverName: s.serverName,
      directory: s.directory,
      computerId: s.computerId,
      version: s.version,
      appliedVersion: s.appliedVersion,
      lastSyncAt: s.lastSyncAt,
      lastAppliedAt: s.lastAppliedAt,
      error: s.error,
      plan: s.plan,
      problems: s.problems,
    };
  }

  start() {
    this.stop();
    const tick = () => void this.sync().catch(() => undefined);
    this.timer = setInterval(tick, SYNC_EVERY_MS);
    this.timer.unref?.();
    const first = setTimeout(tick, 30_000);
    first.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private token(): string {
    if (!this.d.vault.isUnlocked) throw new CoreError('LOCKED', "Unlock the vault (Credentials) first: this computer's key to the directory is kept there");
    const t = this.d.vault.get(TOKEN, { allowInternal: true });
    if (!t) throw new CoreError('UNAUTHENTICATED', 'This computer lost its key to the directory: leave it and join again with a new join code');
    return t;
  }

  /** One thing at a time: a sync waits for an apply, and the other way round. */
  private async one<T>(fn: () => Promise<T>): Promise<T> {
    while (this.busy) await this.busy.catch(() => undefined);
    const p = fn();
    this.busy = p;
    try {
      return await p;
    } finally {
      this.busy = null;
    }
  }

  async join(serverId: string, code: string): Promise<DirectoryMembership> {
    if (!this.d.os) throw new CoreError('UNAVAILABLE', 'The FBRX directory applies accounts on Windows, macOS and Linux');
    if (this.stored()) throw new CoreError('CONFLICT', 'This computer is in a directory already: leave it first');
    if (!this.d.vault.isUnlocked) throw new CoreError('LOCKED', "Unlock the vault (Credentials) first: this computer's key to the directory is kept there");
    const server = this.d.servers.get(serverId);
    const out = await this.d.servers.call<{ computerId: string; token: string; directory: string }>(serverId, 'POST', '/v1/directory/join', null, { code: code.trim(), name: this.d.computerName(), os: this.d.os }).catch((e: CoreError) => {
      if (e.code === 'UNAUTHENTICATED') throw new CoreError('UNAUTHENTICATED', 'That join code is not right, or it was used up or ran out: ask for a new one');
      if (e.code === 'NOT_FOUND') throw new CoreError('UNAVAILABLE', `Update ${server.name}: its FBRX Server is older than the directory`);
      throw e;
    });
    this.d.vault.set({ name: TOKEN, value: out.token, kind: 'token', description: `This computer's key to the FBRX directory on ${server.name}` }, { internal: true });
    this.write({
      serverId,
      serverName: server.name,
      directory: String(out.directory).slice(0, 80),
      computerId: out.computerId,
      joinedAt: new Date().toISOString(),
      version: null,
      appliedVersion: null,
      lastSyncAt: null,
      lastAppliedAt: null,
      error: null,
      problems: [],
      plan: [],
      memory: EMPTY_MEMORY,
      noticed: null,
    });
    this.d.audit('directory.joined', { server: server.host, directory: out.directory });
    await this.sync().catch(() => undefined);
    return this.status();
  }

  /** Leaves the directory: the server forgets this computer; the accounts on it stay as they are. */
  async leave(): Promise<DirectoryMembership> {
    const s = this.stored();
    if (!s) return this.status();
    try {
      await this.d.servers.call(s.serverId, 'POST', '/v1/directory/leave', this.token());
    } catch {
      /* The server may be gone or have removed this computer already: it is left here either way. */
    }
    if (this.d.vault.isUnlocked) this.d.vault.delete(TOKEN, { internal: true });
    this.write(null);
    this.d.audit('directory.left', { directory: s.directory });
    return this.status();
  }

  private async fetchPolicy(s: Stored): Promise<{ policy: DirectoryPolicy; dropped: string[] }> {
    const raw = await this.d.servers.call<DirectoryPolicy>(s.serverId, 'GET', '/v1/directory/policy', this.token());
    return checkPolicy(raw);
  }

  /** What the directory wants now, and what applying it would change here. */
  async sync(): Promise<DirectoryMembership> {
    return this.one(async () => {
      const s = this.stored();
      if (!s) return this.status();
      try {
        const { policy, dropped } = await this.fetchPolicy(s);
        const local = await this.d.readAccounts([...new Set([...policy.groups, ...s.memory.groups])]);
        const plan = planDirectory(policy, local, s.memory, this.d.me());
        const steps = plan.steps.map(({ kind, user, group, words }) => ({ kind, user, group, words }));
        this.patch({ directory: policy.directory.slice(0, 80), version: policy.version, lastSyncAt: new Date().toISOString(), error: null, plan: steps, problems: [...dropped, ...plan.problems] });
        // Changes are waiting and nobody was told about this version yet.
        if (steps.length && s.noticed !== policy.version) {
          this.patch({ noticed: policy.version });
          this.d.notify(`${policy.directory}: ${steps.length} change${steps.length === 1 ? '' : 's'} for this computer`, 'Someone with administrator rights here applies them in Settings, Directory.');
        }
      } catch (e) {
        this.patch({ lastSyncAt: new Date().toISOString(), error: errorMessage(e) });
      }
      return this.status();
    });
  }

  /** Applies what the directory wants, through the system's administrator prompt. */
  async apply(): Promise<DirectoryMembership> {
    return this.one(async () => {
      const s = this.stored();
      if (!s) throw new CoreError('CONFLICT', 'This computer is not in a directory');
      const { policy, dropped } = await this.fetchPolicy(s);
      const local = await this.d.readAccounts([...new Set([...policy.groups, ...s.memory.groups])]);
      const plan = planDirectory(policy, local, s.memory, this.d.me());
      const problems = [...dropped, ...plan.problems];
      const memory: DirectoryMemory = { ...s.memory };
      const passwords: Record<string, number> = {};
      // A step that failed, or something the server sent that could not be used, is a failed apply; what the plan
      // keeps as it is on purpose (the account applying the changes) is only said.
      let ok = !dropped.length;
      if (plan.steps.length) {
        const work = mkdtempSync(join(this.d.tmpDir, 'fbrx-directory-'));
        let run: ScriptRun;
        try {
          chmodSync(work, 0o700);
          run = await this.d.run(plan, local, work);
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
        if (run.cancelled) {
          this.patch({ error: 'The administrator prompt was closed: nothing changed' });
          throw new CoreError('CANCELLED', 'The administrator prompt was closed: nothing changed');
        }
        const abort = /^FBRX-ABORT (.*)$/m.exec(run.output);
        if (abort) {
          this.patch({ error: abort[1] });
          throw new CoreError('CONFLICT', `${abort[1]}: nothing changed. Try again.`);
        }
        const results = stepResults(run.output, plan.steps.length);
        plan.steps.forEach((step, i) => {
          const r = results[i];
          if (!r.ok) {
            ok = false;
            problems.push(`${step.words}: ${r.why}`);
            return;
          }
          remember(memory, step, policy.groups);
          if ((step.kind === 'create' || step.kind === 'password') && step.user && step.passwordVersion) passwords[step.user] = step.passwordVersion;
          // An account the directory took over keeps its own password: its first one is not needed here.
          const first = step.kind === 'adopt' ? policy.users.find((u) => u.username === step.user)?.password : undefined;
          if (first && step.user) passwords[step.user] = first.version;
        });
      }
      const now = new Date().toISOString();
      this.patch({ memory, version: policy.version, appliedVersion: ok ? policy.version : s.appliedVersion, lastAppliedAt: now, error: null, problems, plan: [], noticed: policy.version });
      try {
        await this.d.servers.call(s.serverId, 'POST', '/v1/directory/report', this.token(), { version: policy.version, ok, problems: problems.slice(0, 50), passwords });
      } catch (e) {
        this.patch({ error: `Applied, but ${s.serverName} was not told: ${errorMessage(e)}` });
      }
      this.d.audit('directory.applied', { version: policy.version, ok, steps: plan.steps.length, problems: problems.length });
      // What is left (steps that failed) shows again.
      void this.sync().catch(() => undefined);
      return this.status();
    });
  }
}

/** What the directory did here, so later runs only touch its own accounts and groups. */
function remember(m: DirectoryMemory, step: PlannedStep, groups: string[]) {
  const add = (list: string[], v?: string) => (v && !list.includes(v) ? [...list, v] : list);
  if ((step.kind === 'create' || step.kind === 'adopt') && step.user) m.users = add(m.users, step.user);
  if ((step.kind === 'makeGroup' || step.kind === 'join') && step.group && groups.includes(step.group)) m.groups = add(m.groups, step.group);
  if (step.kind === 'disable' && step.user) m.disabled = add(m.disabled, step.user);
  if (step.kind === 'enable' && step.user) m.disabled = m.disabled.filter((x) => x !== step.user);
  if (step.kind === 'rules' && step.rules) m.rules = step.rules;
}

/** The server's policy as this computer accepts it: anything no system should get is left out, and said so. */
export function checkPolicy(raw: DirectoryPolicy): { policy: DirectoryPolicy; dropped: string[] } {
  const dropped: string[] = [];
  const groups = (Array.isArray(raw?.groups) ? raw.groups : []).filter((g) => {
    const bad = typeof g !== 'string' || directoryGroupProblem(g);
    if (bad) dropped.push(`Left out the group ${JSON.stringify(String(g)).slice(0, 40)}: ${bad === true ? 'not a name' : bad}`);
    return !bad;
  });
  const users: DirectoryPolicyUser[] = [];
  for (const u of Array.isArray(raw?.users) ? raw.users : []) {
    const name = typeof u?.username === 'string' ? u.username : '';
    const bad = directoryUserProblem(name) ?? (typeof u.fullName !== 'string' || !DIRECTORY_FULLNAME_RE.test(u.fullName) ? 'its full name has characters accounts cannot hold' : null);
    const pw = u.password && typeof u.password.value === 'string' && !/[\u0000-\u001f\u007f]/.test(u.password.value) && u.password.value.length <= 128 && Number.isInteger(u.password.version) ? u.password : undefined;
    if (bad || (u.password && !pw)) {
      dropped.push(`Left out the account ${JSON.stringify(name).slice(0, 40)}: ${bad ?? 'its first password cannot be used'}`);
      continue;
    }
    users.push({ username: name, fullName: u.fullName, enabled: u.enabled !== false, admin: u.admin === true, groups: (Array.isArray(u.groups) ? u.groups : []).filter((g) => groups.includes(g)), ...(pw ? { password: { version: pw.version, value: pw.value } } : {}) });
  }
  const retired = (Array.isArray(raw?.retired) ? raw.retired : []).filter((r) => typeof r === 'string' && !directoryUserProblem(r));
  const r = raw?.rules ?? ({} as DirectoryRules);
  const int = (v: unknown, lo: number, hi: number, dflt: number) => (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : dflt);
  const rules: DirectoryRules = { minLength: int(r.minLength, 8, 64, 12), complex: r.complex !== false, maxAgeDays: int(r.maxAgeDays, 0, 999, 0), lockoutAttempts: int(r.lockoutAttempts, 0, 100, 10), lockoutMinutes: int(r.lockoutMinutes, 1, 1440, 15) };
  const directory = typeof raw?.directory === 'string' ? raw.directory.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80) : 'FBRX directory';
  return { policy: { directory, version: Number.isInteger(raw?.version) ? raw.version : 0, rules, users, groups, retired }, dropped };
}
