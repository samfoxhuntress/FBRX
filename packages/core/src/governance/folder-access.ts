import { statSync } from 'node:fs';
import { isAbsolute, normalize, resolve, sep } from 'node:path';
import { newId, type FolderAccessStatus, type FolderRequest } from '@fbrx/shared';
import { CoreError } from '../errors';
import type { AuditLog } from '../audit/audit-log';
import type { EventBus } from '../events';
import type { PolicyEngine } from './policy-engine';

/**
 * The folders the AI may use (the policy's allowed folders), as the person sees them: add one with a folder picker,
 * take one away, and answer the AI when it asks for one it does not have yet (another drive, a network share, a
 * folder outside the home folder). The AI never grants itself a folder: the person picks it, or says no.
 */

/** System folders the AI is never given, whatever is asked. */
const NEVER = [/^[a-z]:\\(windows|program files( \(x86\))?|programdata)(\\|$)/i, /^\/(etc|bin|sbin|usr|boot|dev|proc|sys|System|Library|private|var\/root)(\/|$)/];

const LABELS: Record<string, string> = {
  '${HOME}': 'Your home folder',
  '${DOCUMENTS}': 'Documents',
  '${DESKTOP}': 'Desktop',
  '${DOWNLOADS}': 'Downloads',
  '${WORKSPACE}': "FBRX's workspace",
  '${DATA}': "FBRX's data folder",
};

export interface FolderAccessDeps {
  policy: PolicyEngine;
  events: EventBus;
  audit: AuditLog;
  /** How a token (${HOME}…) reads on this computer. */
  expand: (entry: string) => string;
  agentName: () => string;
  /** Tells the person when FBRX is not in front. */
  notify: (title: string, body: string) => void;
  /** How long a request waits for an answer. */
  timeoutSeconds: () => number;
}

const same = (a: string, b: string) => (process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b);
const inside = (p: string, root: string) => {
  const a = process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p;
  const b = process.platform === 'win32' || process.platform === 'darwin' ? root.toLowerCase() : root;
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
};

export class FolderAccess {
  private readonly pending = new Map<string, { req: FolderRequest; done: (path: string | null) => void }>();

  constructor(private readonly d: FolderAccessDeps) {}

  status(): FolderAccessStatus {
    const eff = this.d.policy.effective();
    return {
      managed: eff.source === 'managed',
      folders: eff.policy.filesystem.allowedRoots.map((entry) => ({ entry, path: this.d.expand(entry), label: LABELS[entry.trim()] ?? null })),
      readOnly: eff.policy.filesystem.readOnly,
      requests: [...this.pending.values()].map((p) => p.req),
    };
  }

  /** Whether the AI may use this folder already. */
  allowed(path: string): boolean {
    return this.d.policy.allowedRoots().some((r) => inside(normalize(path), r));
  }

  private check(path: string): string {
    const p = normalize(resolve(path.trim()));
    if (!isAbsolute(p)) throw new CoreError('INVALID_ARGUMENT', 'Pick a folder');
    if (NEVER.some((re) => re.test(p))) throw new CoreError('FORBIDDEN', `${p} is part of the operating system; the AI is never given it`);
    let st;
    try {
      st = statSync(p);
    } catch {
      throw new CoreError('NOT_FOUND', `There is no folder ${p}`);
    }
    if (!st.isDirectory()) throw new CoreError('INVALID_ARGUMENT', `${p} is a file, not a folder`);
    return p;
  }

  private managedError() {
    return new CoreError('MANAGED', 'Your organization decides which folders the AI may use (FBRX Command → Governance)');
  }

  /** Lets the AI use a folder (the person chose it). */
  add(path: string, actor: string): FolderAccessStatus {
    if (this.d.policy.effective().source === 'managed') throw this.managedError();
    const p = this.check(path);
    const policy = structuredClone(this.d.policy.policy);
    if (!policy.filesystem.allowedRoots.some((r) => same(this.d.expand(r), p))) {
      policy.filesystem.allowedRoots.push(p);
      this.d.policy.updateLocal(policy);
    }
    this.d.audit.append({ category: 'policy', action: 'folder.granted', actor, target: p, outcome: 'success' });
    return this.status();
  }

  /** Takes a folder away from the AI. */
  remove(entry: string, actor: string): FolderAccessStatus {
    if (this.d.policy.effective().source === 'managed') throw this.managedError();
    const policy = structuredClone(this.d.policy.policy);
    const before = policy.filesystem.allowedRoots.length;
    policy.filesystem.allowedRoots = policy.filesystem.allowedRoots.filter((r) => r !== entry);
    if (policy.filesystem.allowedRoots.length !== before) {
      this.d.policy.updateLocal(policy);
      this.d.audit.append({ category: 'policy', action: 'folder.removed', actor, target: this.d.expand(entry), outcome: 'success' });
    }
    return this.status();
  }

  /**
   * The AI asks for a folder: FBRX shows the person the folder and why, with a way to pick another, and waits for the
   * answer. Resolves with the folder granted, or null (declined, unanswered, or decided by the organization).
   */
  async request(p: { path?: string; reason: string; signal?: AbortSignal }): Promise<{ granted: string | null; message: string }> {
    if (this.d.policy.effective().source === 'managed') return { granted: null, message: this.managedError().message };
    const asked = p.path?.trim() ? normalize(resolve(p.path.trim())) : null;
    if (asked && this.allowed(asked)) return { granted: asked, message: `You may already use ${asked}.` };
    if (asked && NEVER.some((re) => re.test(asked))) return { granted: null, message: `${asked} is part of the operating system; the AI is never given it.` };
    const req: FolderRequest = { id: newId('fold'), path: asked, reason: p.reason.trim().slice(0, 500), at: new Date().toISOString(), agentName: this.d.agentName() };
    const answer = new Promise<string | null>((done) => this.pending.set(req.id, { req, done }));
    this.d.events.emit('governance.folderRequest', { ...req, state: 'open' });
    this.d.notify(`${req.agentName} asks to use a folder`, `${asked ?? 'A folder you pick'}: ${req.reason}`);
    const timeout = new Promise<null>((r) => {
      const t = setTimeout(() => r(null), this.d.timeoutSeconds() * 1000);
      t.unref?.();
      p.signal?.addEventListener('abort', () => (clearTimeout(t), r(null)), { once: true });
    });
    const granted = await Promise.race([answer, timeout]);
    if (this.pending.delete(req.id)) this.d.events.emit('governance.folderRequest', { ...req, state: 'closed' });
    return granted
      ? { granted, message: `The person let you use ${granted}.` }
      : { granted: null, message: 'The person did not give you a folder. Do not ask again for the same thing in this task; say what you would need it for instead.' };
  }

  /** The person's answer: a folder (the one asked for, or another they picked), or null to say no. */
  answer(id: string, path: string | null, actor: string): FolderAccessStatus {
    const p = this.pending.get(id);
    if (!p) throw new CoreError('NOT_FOUND', 'That request is over');
    if (path) {
      this.add(path, actor);
      p.done(this.check(path));
    } else {
      this.d.audit.append({ category: 'policy', action: 'folder.declined', actor, target: p.req.path ?? '', outcome: 'denied' });
      p.done(null);
    }
    this.pending.delete(id);
    this.d.events.emit('governance.folderRequest', { ...p.req, state: 'closed' });
    return this.status();
  }
}
