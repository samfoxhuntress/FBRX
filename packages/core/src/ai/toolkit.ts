import {
  TOOLKIT_LIMITS,
  TOOLKIT_SYSTEMS,
  TOOLKIT_SYSTEM_NAMES,
  newId,
  toolkitInputProblem,
  toolkitPlaceholders,
  toolkitToolName,
  type InvocationOrigin,
  type ToolkitAction,
  type ToolkitCommands,
  type ToolkitInput,
  type ToolkitSystem,
} from '@fbrx/shared';
import { CoreError } from '../errors';
import type { EventBus } from '../events';
import type { MetaStore } from '../storage/meta';
import type { ToolSpec } from '../tools/types';
import type { ApprovalQueue } from '../governance/approvals';
import { runShell } from '../tools/builtin/shell-tools';
import { elevated } from '../windows/ps';
import { truncate } from '../util/misc';
import { TOOLKIT_LIBRARY, type LibraryAction } from './toolkit-library';

/**
 * The AI Toolkit (see @fbrx/shared toolkit.ts): FBRX's library of actions, the ones Fabrix built (each approved by the
 * person) and the person's own, kept on this computer. Every enabled action is a tool of its own (kit.<name>) that
 * goes through governance like any other: the policy, the guardian, approvals for the ones that ask first, the audit.
 */

const SAVED = 'ai.toolkit';
const LIBRARY_STATE = 'ai.toolkit.library';
/** At most this many actions go with one request. */
const PER_REQUEST = 3;
export const TOOLKIT_SOURCE_ID = 'toolkit';

export const thisSystem = (): ToolkitSystem => (process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux');

const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
const psq = (v: string) => `'${v.replace(/'/g, "''")}'`;

/** A command with its inputs filled in: numbers and addresses as they are (checked), anything else quoted. */
export function fillCommand(command: string, inputs: ToolkitInput[], values: Record<string, unknown>, system: ToolkitSystem): string {
  return command.replace(/\{\{\s*([a-z][a-z0-9_]{0,30})\s*\}\}/g, (_m, name: string) => {
    const input = inputs.find((i) => i.name === name);
    if (!input) throw new CoreError('INVALID_ARGUMENT', `The command uses {{${name}}}, which is not one of its inputs`);
    const value = String(values[name] ?? '').trim();
    const problem = toolkitInputProblem(input.kind, value);
    if (problem) throw new CoreError('INVALID_ARGUMENT', `${input.name} must be ${problem}`);
    if (input.kind === 'number' || input.kind === 'ip') return value;
    return system === 'windows' ? psq(value) : shq(value);
  });
}

// What a command that only looks is made of: the programs, and for some the words that keep them read-only. Programs
// that read files (cat, Get-Content) are not among them: reading files goes through the folders the AI may use.
const LOOK_PROGRAMS = new Set(
  'ipconfig ifconfig ping ping6 nslookup dig host getent tracert traceroute tracepath pathping netstat ss arp route hostname whoami systeminfo uname uptime df free lsblk lscpu lsusb lspci ps tasklist nmcli networksetup scutil system_profiler sw_vers sysctl resolvectl iwconfig iw lsof vm_stat netsh sc echo printf date test-connection test-netconnection resolve-dnsname'.split(' '),
);
/** Programs that only shape what came before them in a pipeline (never the first: then they would read files). */
const FILTERS = new Set('grep egrep findstr awk sed sort uniq head tail wc cut tr measure-object select-object format-table format-list format-wide where-object sort-object select-string out-string convertto-json group-object'.split(' '));
/** PowerShell Get- commands that read files, secrets or the clipboard. */
const SECRET_GETS = /^get-(content|clipboard|credential|secret|storedcredential|psreadlineoption|history)$/;
const CHANGE_WORDS: Record<string, RegExp> = {
  ipconfig: /\/(release|renew|flushdns|registerdns|setclassid)/i,
  ifconfig: /\s(up|down|add|delete|alias|-alias|inet|mtu|ether|lladdr)\b/i,
  route: /\s(add|delete|del|change|flush|-f)\b/i,
  arp: /\s-(d|s)\b/i,
  nmcli: /\s(modify|mod|up|down|add|delete|del|connect|disconnect|reapply|set|on|off|edit|import|reload)\b|\s(-s|--show-secrets)\b/i,
  networksetup: /\s-set/i,
  scutil: /\s--set/i,
  sysctl: /\s-w\b|=/,
  resolvectl: /\s(flush-caches|dns\s+\S+\s+\S|domain\s+\S+\s+\S|revert|reset)/i,
  netsh: /\s(set|add|delete|reset|connect|disconnect)\b|key\s*=\s*clear/i,
  sc: /\s(start|stop|config|create|delete|pause|continue)\b/i,
  sed: /\s-i\b/,
  iw: /\s(set|connect|disconnect|del|add)\b/i,
};

/**
 * Whether a command only looks (reads settings and states): every program in it is one that only reads, used in a
 * read-only way, with no redirection into a file. Fabrix's own actions that pass run without asking; anything else
 * asks first (the person can change that in the AI Toolkit).
 */
export function looksOnly(command: string): boolean {
  const c = command.replace(/\s2>\s*(&1|\/dev\/null|\$null)/g, ' ');
  if (/[<>`]|\$\(|\bsudo\b|\brunas\b/i.test(c)) return false;
  // Each command, and whether it takes what the one before it printed (after a single |).
  const parts = c.split(/(\|\||&&|[;\n]|\|)/);
  let piped = false;
  for (const raw of parts) {
    if (raw === '|') {
      piped = true;
      continue;
    }
    if (/^(\|\||&&|[;\n])$/.test(raw)) {
      piped = false;
      continue;
    }
    const part = raw.trim().replace(/^[&(]\s*/, '');
    if (!part) continue;
    const program = part.split(/\s+/)[0].toLowerCase().replace(/\.exe$/, '');
    const wasPiped = piped;
    piped = false;
    if (FILTERS.has(program)) {
      if (!wasPiped || (program === 'sed' && /\s-i\b/.test(part))) return false;
      continue;
    }
    if (/^get-[a-z]+$/.test(program)) {
      if (SECRET_GETS.test(program)) return false;
      continue;
    }
    if (program === 'ip') {
      if (/\s(add|del|delete|set|flush|change|replace|append|restore|save)\b/i.test(part)) return false;
      continue;
    }
    if (!LOOK_PROGRAMS.has(program)) return false;
    if (CHANGE_WORDS[program]?.test(` ${part.slice(program.length)}`)) return false;
  }
  return true;
}

/**
 * Programs that send traffic beyond this computer: lookups, pings, traces, port checks and downloads. An action that
 * runs one is a network tool, so an offline chat asks before it runs (the library also says so for its own).
 */
const NETWORK_PROGRAMS =
  /(^|[\s;|&(`$'"])(ping6?|tracert|traceroute6?|tracepath6?|mtr|pathping|nslookup|dig|host|drill|resolvectl\s+query|getent\s+a?hosts|nc|ncat|netcat|telnet|curl|wget|ssh|scp|sftp|rsync|ftp|nmap|arping|whois|test-netconnection|tnc|test-connection|resolve-dnsname|invoke-webrequest|iwr|invoke-restmethod|irm|start-bitstransfer)(\.exe)?(?=$|[\s;|&)'"])|\/dev\/(tcp|udp)\/|\bnet\.webclient\b|\bnet\.sockets\.tcpclient\b/i;

/** Whether a command sends traffic beyond this computer (see NETWORK_PROGRAMS). */
export function usesNetwork(command: string): boolean {
  return NETWORK_PROGRAMS.test(command);
}

/** Whether an action reaches the network: the library says so for its own, and any action's commands can show it. */
export function actionUsesNetwork(a: Pick<ToolkitAction, 'id' | 'commands' | 'undo'>): boolean {
  if (TOOLKIT_LIBRARY.some((l) => l.id === a.id && l.network)) return true;
  return [...Object.values(a.commands), ...Object.values(a.undo?.commands ?? {})].some((c) => !!c && usesNetwork(c));
}

const STOP = new Set('the and for with that this what why how can you your please help are was from into have has not but out about there they them then when where which would could should just like make get its our very also some any all thing things show tell give find check see run use computer fabrix'.split(' '));
const stem = (w: string) => (w.length > 5 ? w.replace(/(ing|ed|es|s)$/, '') : w);
const words = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .replace(/wi-fi/g, 'wifi')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((w) => (w.length >= 3 || w === 'ip') && !STOP.has(w))
      .map(stem),
  );

export interface ToolkitDeps {
  meta: MetaStore;
  events?: EventBus;
  approvals?: ApprovalQueue;
  /** The longest a command may run (the policy's shell limit), in seconds. */
  timeoutSeconds: () => number;
  workspace: string;
  now?: () => Date;
  /** Tests: the system to act as, and how commands run. */
  system?: ToolkitSystem;
  exec?: (command: string, o: { admin: boolean; system: ToolkitSystem; timeoutMs: number; signal: AbortSignal }) => Promise<{ ok: boolean; output: string }>;
}

type SaveInput = Partial<Pick<ToolkitAction, 'kit' | 'when' | 'commands' | 'inputs' | 'ask' | 'admin' | 'undo'>> & { id?: string; name: string };

export class ToolkitStore {
  constructor(private readonly d: ToolkitDeps) {}

  get system(): ToolkitSystem {
    return this.d.system ?? thisSystem();
  }

  private now() {
    return (this.d.now?.() ?? new Date()).toISOString();
  }

  private saved(): ToolkitAction[] {
    return this.d.meta.get<ToolkitAction[]>(SAVED) ?? [];
  }

  private libraryState(): Record<string, { enabled?: boolean; uses?: number; lastUsedAt?: string | null }> {
    return this.d.meta.get<Record<string, { enabled?: boolean; uses?: number; lastUsedAt?: string | null }>>(LIBRARY_STATE) ?? {};
  }

  private changed() {
    this.d.events?.emit('toolkit.changed', { count: this.list().length });
  }

  private static fromLibrary(l: LibraryAction): ToolkitAction {
    const { keywords: _k, network: _n, ...a } = l;
    return { ...a, source: 'library', changed: false, enabled: true, uses: 0, createdAt: '', updatedAt: '', lastUsedAt: null };
  }

  /** Every action: the library (as FBRX wrote it or as you changed it), then Fabrix's and yours, newest first. */
  list(): ToolkitAction[] {
    const saved = this.saved();
    const state = this.libraryState();
    const library = TOOLKIT_LIBRARY.map((l) => {
      const own = saved.find((s) => s.id === l.id);
      const base = own ?? ToolkitStore.fromLibrary(l);
      const st = state[l.id];
      return { ...base, enabled: st?.enabled ?? base.enabled, uses: st?.uses ?? 0, lastUsedAt: st?.lastUsedAt ?? null };
    });
    const others = saved.filter((s) => s.source !== 'library').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return [...library, ...others];
  }

  get(id: string): ToolkitAction {
    const a = this.list().find((x) => x.id === id || x.tool === id);
    if (!a) throw new CoreError('NOT_FOUND', 'That toolkit action is gone');
    return a;
  }

  /**
   * Saves an action: a new one (Fabrix's or yours), or a change to any (a library action you change is kept as yours
   * to Reset). When Fabrix changes an action, it asks first again until the person says otherwise.
   */
  save(input: SaveInput, by: 'fabrix' | 'person'): ToolkitAction {
    const name = input.name.trim().slice(0, TOOLKIT_LIMITS.name);
    if (!name) throw new CoreError('INVALID_ARGUMENT', 'An action needs a name');
    const all = this.list();
    const same = input.id ? all.find((a) => a.id === input.id) : by === 'fabrix' ? all.find((a) => a.source === 'built' && a.name.toLowerCase() === name.toLowerCase()) : undefined;
    if (input.id && !same) throw new CoreError('NOT_FOUND', 'That toolkit action is gone');
    const commands = cleanCommands(input.commands ?? same?.commands ?? {});
    if (!Object.keys(commands).length) throw new CoreError('INVALID_ARGUMENT', 'An action needs a command for at least one system');
    const inputs = (input.inputs ?? same?.inputs ?? []).slice(0, TOOLKIT_LIMITS.inputs).map((i) => ({ name: i.name.trim(), label: i.label.trim().slice(0, TOOLKIT_LIMITS.label), kind: i.kind }));
    for (const i of inputs) if (!/^[a-z][a-z0-9_]{0,30}$/.test(i.name)) throw new CoreError('INVALID_ARGUMENT', `"${i.name}" is not an input name (lower case letters, digits and _)`);
    const undoIn = input.undo === undefined ? (same?.undo ?? null) : input.undo;
    const undo = undoIn && Object.keys(cleanCommands(undoIn.commands)).length ? { commands: cleanCommands(undoIn.commands), seconds: Math.min(TOOLKIT_LIMITS.undoSeconds.max, Math.max(TOOLKIT_LIMITS.undoSeconds.min, Math.round(undoIn.seconds || 60))) } : null;
    const used = new Set([...Object.values(commands), ...Object.values(undo?.commands ?? {})].flatMap((c) => toolkitPlaceholders(c!)));
    for (const u of used) if (!inputs.some((i) => i.name === u)) throw new CoreError('INVALID_ARGUMENT', `A command uses {{${u}}}: add an input named ${u}`);
    const unused = inputs.find((i) => !used.has(i.name));
    if (unused) throw new CoreError('INVALID_ARGUMENT', `No command uses the input ${unused.name} (put {{${unused.name}}} where it goes)`);
    const ask = by === 'fabrix' ? input.ask === true || !!undo || !Object.values(commands).every((c) => looksOnly(c!)) : (input.ask ?? same?.ask ?? true);
    const at = this.now();
    const action: ToolkitAction = {
      id: same?.id ?? newId('kit'),
      tool: same?.tool ?? toolkitToolName(name, all.map((a) => a.tool)),
      kit: (input.kit ?? same?.kit ?? (by === 'fabrix' ? 'Built by Fabrix' : 'Mine')).trim().slice(0, TOOLKIT_LIMITS.kit) || 'Mine',
      name,
      when: (input.when ?? same?.when ?? '').trim().slice(0, TOOLKIT_LIMITS.when),
      commands,
      inputs,
      ask,
      admin: (input.admin ?? same?.admin ?? []).filter((s) => TOOLKIT_SYSTEMS.includes(s)),
      undo,
      source: same?.source ?? (by === 'fabrix' ? 'built' : 'yours'),
      changed: same?.source === 'library' ? true : false,
      enabled: same?.enabled ?? true,
      uses: same?.uses ?? 0,
      createdAt: same?.createdAt || at,
      updatedAt: at,
      lastUsedAt: same?.lastUsedAt ?? null,
    };
    this.d.meta.set(SAVED, [action, ...this.saved().filter((s) => s.id !== action.id)]);
    this.changed();
    return action;
  }

  setEnabled(id: string, enabled: boolean): ToolkitAction {
    const a = this.get(id);
    if (a.source === 'library') {
      const state = this.libraryState();
      this.d.meta.set(LIBRARY_STATE, { ...state, [a.id]: { ...state[a.id], enabled } });
    } else this.d.meta.set(SAVED, this.saved().map((s) => (s.id === a.id ? { ...s, enabled, updatedAt: this.now() } : s)));
    this.changed();
    return this.get(a.id);
  }

  /** A library action back as FBRX wrote it. */
  reset(id: string): ToolkitAction {
    const a = this.get(id);
    if (a.source !== 'library') throw new CoreError('INVALID_ARGUMENT', 'Only library actions can be reset');
    this.d.meta.set(SAVED, this.saved().filter((s) => s.id !== a.id));
    this.changed();
    return this.get(a.id);
  }

  remove(id: string): boolean {
    const a = this.get(id);
    if (a.source === 'library') throw new CoreError('INVALID_ARGUMENT', 'Library actions can be turned off or reset, not removed');
    this.d.meta.set(SAVED, this.saved().filter((s) => s.id !== a.id));
    this.changed();
    return true;
  }

  /**
   * The actions that fit a request, by the words they share with it: one of a library action's keywords counts 3 (so
   * "traceroute" alone finds it; a keyword of several words counts when they come together), a word of the name 2, one
   * of "when" 1. An action needs 3, and goes along only when it fits nearly as well as the best one.
   */
  match(text: string, limit = PER_REQUEST): ToolkitAction[] {
    const asked = words(text);
    if (!asked.size) return [];
    const flat = ` ${text.toLowerCase().replace(/wi-fi/g, 'wifi').replace(/[^a-z0-9.]+/g, ' ')} `;
    const keywords = new Map(
      TOOLKIT_LIBRARY.map((l) => [l.id, { single: words(l.keywords.filter((k) => !k.includes(' ')).join(' ')), phrases: l.keywords.filter((k) => k.includes(' ')) }]),
    );
    const scored = this.list()
      .filter((a) => a.enabled && a.commands[this.system])
      .map((a) => {
        const keys = keywords.get(a.id);
        const name = words(a.name);
        const about = words(`${a.when} ${a.kit}`);
        let score = 0;
        for (const w of asked) score += keys?.single.has(w) ? 3 : name.has(w) ? 2 : about.has(w) ? 1 : 0;
        for (const p of keys?.phrases ?? []) if (flat.includes(` ${p} `)) score += 3;
        return { a, score };
      })
      .filter((x) => x.score >= 3)
      .sort((x, y) => y.score - x.score || y.a.uses - x.a.uses);
    const best = scored[0]?.score ?? 0;
    return scored
      .filter((x) => x.score >= best * 0.6)
      .slice(0, limit)
      .map((x) => x.a);
  }

  /** What goes with a request: the actions that fit it, as tools to call, and their names (for a short tool list). */
  context(text: string): { text: string; tools: string[] } | null {
    const found = this.match(text);
    if (!found.length) return null;
    return {
      text: found.map((a) => `- ${a.tool}: ${a.name}. ${a.when}${a.ask ? ' (asks the person first)' : ''}`).join('\n'),
      tools: found.map((a) => a.tool),
    };
  }

  private used(a: ToolkitAction) {
    const at = this.now();
    if (a.source === 'library') {
      const state = this.libraryState();
      this.d.meta.set(LIBRARY_STATE, { ...state, [a.id]: { ...state[a.id], uses: (state[a.id]?.uses ?? 0) + 1, lastUsedAt: at } });
    } else this.d.meta.set(SAVED, this.saved().map((s) => (s.id === a.id ? { ...s, uses: s.uses + 1, lastUsedAt: at } : s)));
  }

  private async exec(command: string, admin: boolean, timeoutMs: number, signal: AbortSignal): Promise<{ ok: boolean; output: string }> {
    const system = this.system;
    if (this.d.exec) return this.d.exec(command, { admin, system, timeoutMs, signal });
    if (admin && system === 'windows') {
      const r = await elevated(command, { timeoutMs });
      return { ok: r.ok, output: r.output };
    }
    const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    const full =
      admin && !asRoot
        ? system === 'mac'
          ? `osascript -e ${shq(`do shell script "${command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with administrator privileges`)}`
          : `pkexec sh -c ${shq(command)}`
        : command;
    const r = await runShell(full, this.d.workspace, timeoutMs, signal);
    const out = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n');
    if (r.timedOut) return { ok: false, output: `${out}\n(stopped after ${Math.round(timeoutMs / 1000)} seconds)`.trim() };
    return { ok: r.code === 0, output: out };
  }

  /**
   * Runs an action on this computer. One that can be undone puts its change back after its time unless the person
   * keeps it (the approval FBRX shows for that), so a change that cuts the connection mends itself.
   */
  async run(id: string, values: Record<string, unknown>, ctx: { signal: AbortSignal; origin: InvocationOrigin; runId: string | null }): Promise<{ output: string; ok: boolean; undone?: boolean }> {
    const a = this.get(id);
    const system = this.system;
    const command = a.commands[system];
    if (!command) throw new CoreError('UNAVAILABLE', `"${a.name}" has no command for ${TOOLKIT_SYSTEM_NAMES[system]} yet. Add one in AI Toolkit.`);
    const filled = fillCommand(command, a.inputs, values, system);
    const timeoutMs = this.d.timeoutSeconds() * 1000;
    const admin = a.admin.includes(system);
    this.used(a);
    const r = await this.exec(filled, admin, timeoutMs, ctx.signal);
    let output = truncate(r.output || (r.ok ? '(done, nothing printed)' : '(failed, nothing printed)'), 16_000);
    if (!r.ok) output = `It did not work.\n${output}`;
    const undo = a.undo?.commands[system];
    if (!r.ok || !undo || !a.undo) return { output, ok: r.ok };
    const back = fillCommand(undo, a.inputs, values, system);
    const answer = this.d.approvals
      ? await this.d.approvals.request(
          {
            runId: ctx.runId,
            tool: a.tool,
            toolTitle: `Keep the change: ${a.name}`,
            risk: 'execute',
            input: values,
            reason: `FBRX puts it back in ${a.undo.seconds} seconds unless you keep it. Approve to keep the change; reject or wait to put it back.`,
            origin: ctx.origin,
            findings: [],
          },
          a.undo.seconds,
        )
      : { decision: 'expired' as const };
    if (answer.decision === 'approve') return { output: `${output}\n\nThe person kept the change.`, ok: true };
    const u = await this.exec(back, admin, timeoutMs, new AbortController().signal);
    return { output: `${output}\n\nNot kept, so FBRX put it back${u.ok ? '' : ' (that did not work: check it by hand)'}:\n${truncate(u.output, 4000)}`, ok: true, undone: true };
  }

  /** Every enabled action as a tool of its own. */
  tools(): ToolSpec[] {
    const system = this.system;
    return this.list()
      .filter((a) => a.enabled)
      .map((a): ToolSpec => {
        const undoMs = a.undo ? a.undo.seconds * 1000 + 60_000 : 0;
        const network = actionUsesNetwork(a);
        return {
          name: a.tool,
          title: a.name,
          description: `${a.when || a.name} An action in the AI Toolkit (${a.kit}).${a.undo ? ` Puts the change back after ${a.undo.seconds} seconds unless the person keeps it.` : ''}`,
          // One that asks first stays 'execute'; one that reaches the network says so, so an offline chat asks.
          risk: a.ask ? 'execute' : network ? 'network' : 'read',
          network,
          source: 'builtin',
          sourceId: TOOLKIT_SOURCE_ID,
          timeoutMs: this.d.timeoutSeconds() * 1000 * (a.undo ? 2 : 1) + undoMs + 5_000,
          unavailable: () => (a.commands[system] ? null : `"${a.name}" has no command for ${TOOLKIT_SYSTEM_NAMES[system]} yet`),
          inputSchema: {
            type: 'object',
            properties: Object.fromEntries(a.inputs.map((i) => [i.name, { type: 'string', description: i.label, maxLength: 253 }])),
            required: a.inputs.map((i) => i.name),
          },
          resources: (i) => {
            const c = a.commands[system];
            return c ? { command: fillCommand(c, a.inputs, i ?? {}, system) } : {};
          },
          run: async (i, ctx) => {
            const r = await this.run(a.id, i ?? {}, { signal: ctx.signal, origin: ctx.origin, runId: ctx.runId });
            return { output: r.output, data: { ok: r.ok, undone: r.undone ?? false } };
          },
        };
      });
  }
}

function cleanCommands(c: ToolkitCommands): ToolkitCommands {
  const out: ToolkitCommands = {};
  for (const s of TOOLKIT_SYSTEMS) {
    const v = c[s]?.trim();
    if (v) out[s] = v.slice(0, TOOLKIT_LIMITS.command);
  }
  return out;
}
