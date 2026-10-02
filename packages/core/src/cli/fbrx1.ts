import type { CliResult, DeepPartial, EffectiveSettings, Settings } from '@fbrx/shared';
import { DEFAULT_SETTINGS, SettingsSchema, deepMerge, isPathLocked, leafPaths, newId } from '@fbrx/shared';
import { CoreError, errorMessage } from '../errors';

/**
 * FBRX/1: the FBRX OS command line, in the style of network operating systems (Junos, IOS). Operational commands
 * (`show …`, `request …`, `ping`) run straight away; `configure` enters configuration mode, where `set` and
 * `delete` build a candidate configuration that `commit` applies (validated like any settings change, refusing what
 * the organization locks) and `rollback` discards. Output can be piped: `| match <text>`, `| except <text>`,
 * `| count`, `| last <n>`, `| display json`, `| display set`.
 *
 * Every command goes through the same core API (and governance) as the desktop app, as the person at the computer.
 */

type Call = (method: string, params?: unknown) => Promise<any>;

interface Session {
  mode: 'operational' | 'configure';
  candidate: Record<string, unknown>;
}

interface Node {
  help: string;
  children?: Record<string, Node>;
  /** Free argument after the keyword (shown as <arg> in help). */
  arg?: string;
  run?: (args: string[], ctx: Ctx) => Promise<string> | string;
}

interface Ctx {
  call: Call;
  session: Session;
  json: boolean;
}

const pad = (s: unknown, n: number) => String(s ?? '').padEnd(n);
const yes = (b: boolean) => (b ? 'yes' : 'no');
const dur = (sec: number) => {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${d ? `${d}d ` : ''}${h}h ${m}m`;
};
const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

function table(rows: Array<Array<unknown>>, header: string[]): string {
  const all = [header, ...rows.map((r) => r.map((c) => String(c ?? '')))];
  const w = header.map((_, i) => Math.max(...all.map((r) => String(r[i] ?? '').length)));
  return all.map((r) => r.map((c, i) => (i === r.length - 1 ? String(c) : pad(c, w[i] + 2))).join('').trimEnd()).join('\n');
}

/** Settings as a Junos-style hierarchy (`section { key value; }`), or as `set` lines. */
function renderConfig(obj: Record<string, unknown>, asSet: boolean, prefix: string[] = []): string[] {
  const out: string[] = [];
  const indent = '    '.repeat(prefix.length);
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('_')) continue;
    const path = [...prefix, k];
    const fmt = (x: unknown) => (typeof x === 'string' ? (x === '' || /\s|;/.test(x) ? JSON.stringify(x.length > 120 ? `${x.slice(0, 117)}...` : x) : x) : JSON.stringify(x));
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (asSet) out.push(...renderConfig(v as Record<string, unknown>, true, path));
      else {
        out.push(`${indent}${k} {`);
        out.push(...renderConfig(v as Record<string, unknown>, false, path));
        out.push(`${indent}}`);
      }
    } else if (asSet) out.push(`set ${path.join(' ')} ${fmt(v)}`);
    else out.push(`${indent}${k} ${fmt(v)};`);
  }
  return out;
}

function parseValue(raw: string): unknown {
  if (raw === 'true' || raw === 'false') return raw === 'true';
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (/^[[{"]/.test(raw)) {
    try {
      return JSON.parse(raw);
    } catch {
      /* plain text */
    }
  }
  return raw;
}

/** Splits a command line into words, keeping "quoted strings" together. */
export function words(line: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? m[3]));
  return out;
}

function deepSet(obj: Record<string, any>, path: string[], value: unknown) {
  let o = obj;
  for (const p of path.slice(0, -1)) o = o[p] = o[p] && typeof o[p] === 'object' ? o[p] : {};
  o[path[path.length - 1]] = value;
}

function getPath(obj: any, path: string[]): unknown {
  return path.reduce((o, p) => (o && typeof o === 'object' ? o[p] : undefined), obj);
}

const OPERATIONAL: Record<string, Node> = {
  show: {
    help: 'Show information',
    children: {
      version: {
        help: 'Product, version and license',
        run: async (_a, c) => {
          const s = await c.call('system.status');
          return [`Product:      ${s.product}`, `Version:      ${s.version}`, `Platform:     ${s.platform} ${s.arch}`, `Device name:  ${s.deviceName}`, `License:      ${s.license.edition}${s.license.customer ? ` (${s.license.customer})` : ''}`, `Build:        ${s.devMode ? 'development' : 'release'}`].join('\n');
        },
      },
      system: {
        help: 'System status and resources',
        children: {
          status: {
            help: 'Services, vault, fleet and the agent',
            run: async (_a, c) => {
              const s = await c.call('system.status');
              return [
                `Uptime (FBRX):       ${dur(s.uptimeSeconds)}`,
                `Vault:               ${s.vault.state}`,
                `Fleet:               ${s.fleet.state}${s.fleet.tenantName ? ` (${s.fleet.tenantName})` : ''}`,
                `Local AI runtime:    ${s.runtime.state}${s.runtime.modelId ? ` (${s.runtime.modelId})` : ''}`,
                `Agent runs active:   ${s.activeRuns}`,
                `Approvals pending:   ${s.pendingApprovals}`,
                `Emergency stop:      ${s.aiHalt ? `ON since ${s.aiHalt.at} by ${s.aiHalt.by}` : 'off'}`,
                `Services failing:    ${s.services.filter((x: any) => x.state === 'failed').length} of ${s.services.length}`,
                `Last 24 hours:       ${s.stats.agentRuns24h} agent runs, ${s.stats.toolCalls24h} tool calls, ${s.stats.policyDenials24h} denials, ${s.stats.errors24h} errors`,
              ].join('\n');
            },
          },
          resources: {
            help: 'Processor, memory and disks right now',
            run: async (_a, c) => {
              const [live, st] = await Promise.all([c.call('sysinfo.live'), c.call('sysinfo.static')]);
              const cur = live.current;
              const lines = [`Processor:  ${st.cpu.model} (${st.cpu.threads} threads)`, cur ? `CPU load:   ${cur.cpu.toFixed(0)}%` : 'CPU load:   sampling…', `Memory:     ${cur ? `${gb(cur.memUsed)} used of ${gb(cur.memTotal)} (${((cur.memUsed / cur.memTotal) * 100).toFixed(0)}%)` : gb(st.memoryTotal)}`];
              return `${lines.join('\n')}\n\n${table(
                st.disks.map((d: any) => [d.mount, gb(d.size - d.used), gb(d.size), `${((d.used / d.size) * 100).toFixed(0)}%`]),
                ['Disk', 'Free', 'Size', 'Used'],
              )}`;
            },
          },
        },
      },
      services: {
        help: 'FBRX services and their state',
        run: async (_a, c) => table((await c.call('system.status')).services.map((s: any) => [s.name, s.state, s.message ?? '']), ['Service', 'State', 'Detail']),
      },
      alerts: {
        help: 'Recent alerts',
        run: async (_a, c) => table((await c.call('alerts.inbox', { limit: 30 })).map((a: any) => [a.createdAt?.slice(0, 16).replace('T', ' '), a.severity, a.read ? '' : 'new', a.title]), ['When', 'Severity', '', 'Alert']),
      },
      approvals: {
        help: 'Actions waiting for approval',
        run: async (_a, c) => {
          const l = await c.call('approvals.list');
          return l.length ? table(l.map((a: any) => [a.id, a.toolTitle, a.risk, a.reason]), ['Id', 'Action', 'Risk', 'Reason']) : 'No approvals pending.';
        },
      },
      license: {
        help: 'License details',
        run: async (_a, c) => {
          const l = await c.call('license.status');
          return [`Edition:   ${l.edition}`, `Customer:  ${l.customer ?? '-'}`, `Expires:   ${l.expiresAt ?? 'never'}`, `Features:  ${(l.features ?? []).join(', ') || '-'}`].join('\n');
        },
      },
      ai: {
        help: 'AI providers and models',
        children: {
          providers: { help: 'Configured AI providers', run: async (_a, c) => table((await c.call('ai.providers')).map((p: any) => [p.id, p.name, yes(p.enabled), p.available ? 'ready' : (p.message ?? 'unavailable'), p.defaultModel ?? '']), ['Id', 'Name', 'Enabled', 'State', 'Model']) },
          models: {
            help: 'Models of a provider',
            arg: 'provider',
            run: async (a, c) => {
              const id = a[0] ?? (await c.call('settings.get')).settings.ai.defaultProvider;
              return table((await c.call('ai.models', { providerId: id })).map((m: any) => [m.id, m.details ?? '', m.unavailable ?? '']), ['Model', 'Details', 'Note']);
            },
          },
        },
      },
      network: {
        help: 'Network information',
        children: {
          interfaces: { help: 'Network adapters', run: async (_a, c) => table((await c.call('net.context')).interfaces.map((i: any) => [i.name, i.ip, i.mac, i.up ? 'up' : 'down', i.type ?? '']), ['Interface', 'Address', 'MAC', 'State', 'Type']) },
          devices: {
            help: 'Devices from the last network scan',
            run: async (_a, c) => {
              const scans = await c.call('net.scans');
              if (!scans.length) return 'No scans yet. Run "request network scan".';
              const s = await c.call('net.scanGet', { id: scans[0].id });
              return `${s.label} (${s.subnet}) at ${s.scannedAt}\n\n${table(
                s.devices.map((d: any) => [d.ip, d.mac ?? '', d.vendor ?? '', d.typeLabel, d.ports.join(',')]),
                ['Address', 'MAC', 'Maker', 'Type', 'Ports'],
              )}`;
            },
          },
          vendors: {
            help: 'The MAC vendor registry in use',
            run: async (_a, c) => {
              const v = await c.call('net.vendorInfo');
              return `IEEE registry: ${v.entries} blocks (${v.source}${v.updatedAt ? `, ${v.updatedAt}` : ''})`;
            },
          },
        },
      },
      consoles: {
        help: 'Open device consoles',
        run: async (_a, c) => {
          const l = await c.call('console.list');
          return l.length ? table(l.map((s: any) => [s.id, s.label, `${s.protocol} ${s.host}:${s.port}`, s.state]), ['Id', 'Device', 'Connection', 'State']) : 'No device consoles.';
        },
      },
      tasks: {
        help: 'Open tasks',
        run: async (_a, c) =>
          table(
            (await c.call('tasks.list')).filter((t: any) => t.status !== 'done').map((t: any) => [t.priority, t.due?.slice(0, 10) ?? '', t.status, t.title]),
            ['Priority', 'Due', 'Status', 'Task'],
          ),
      },
      audit: {
        help: 'The audit log (newest first)',
        arg: 'count',
        run: async (a, c) =>
          table(
            (await c.call('audit.query', { limit: Math.min(200, Number(a[0]) || 20) })).map((e: any) => [e.ts?.slice(0, 19).replace('T', ' '), e.category, e.action, e.outcome, e.actor]),
            ['When', 'Category', 'Action', 'Outcome', 'By'],
          ),
      },
      log: {
        help: 'FBRX log (newest last)',
        arg: 'count',
        run: async (a, c) => (await c.call('logs.tail', { lines: Math.min(500, Number(a[0]) || 40) })).map((l: any) => `${l.ts.slice(11, 19)} ${l.level.padEnd(5)} [${l.scope}] ${l.message}`).join('\n'),
      },
      configuration: {
        help: 'Settings in use (add a section name, e.g. "show configuration appearance")',
        arg: 'section',
        run: async (a, c) => {
          const s = (await c.call('settings.get')) as EffectiveSettings;
          const section: Record<string, unknown> = a[0] ? { [a[0]]: getPath(s.settings, [a[0]]) } : s.settings;
          if (a[0] && section[a[0]] === undefined) throw new CoreError('NOT_FOUND', `No configuration section "${a[0]}"`);
          if (c.json) return JSON.stringify(section, null, 2);
          return renderConfig(section as Record<string, unknown>, false).join('\n');
        },
      },
      trophies: {
        help: 'The easter-egg trophy case',
        run: async (_a, c) => {
          const t = await c.call('fun.trophies');
          const n = Object.keys(t.unlocked).length;
          return `${n} trophies found. Open Settings → Trophy case to see them.`;
        },
      },
    },
  },
  request: {
    help: 'Do something',
    children: {
      service: {
        help: 'Service actions',
        children: { restart: { help: 'Restart an FBRX service (see "show services")', arg: 'name', run: async (a, c) => (await c.call('system.restartService', { name: a[0] ?? '' }), `Restarted ${a[0]}.`) } },
      },
      backup: { help: 'Backups', children: { now: { help: 'Back up this computer now (uses the saved backup passphrase)', run: async (_a, c) => `Backup saved: ${(await c.call('backup.create', {})).file}` } } },
      network: {
        help: 'Network actions',
        children: {
          scan: {
            help: 'Scan the local network for devices (about a minute)',
            run: async (_a, c) => {
              const s = await c.call('net.scan', { reqId: newId('cli'), label: 'FBRX/1' });
              return `Found ${s.devices.length} devices on ${s.subnet}. "show network devices" lists them.`;
            },
          },
        },
      },
      ai: {
        help: 'AI actions',
        children: {
          stop: { help: 'EMERGENCY STOP: cancel all agent work and block AI until resumed', run: async (_a, c) => ((r) => `Emergency stop ON: ${r.cancelledRuns} run(s) canceled, ${r.deniedApprovals} approval(s) denied, local model stopped.`)(await c.call('ai.hardStop')) },
          resume: { help: 'Lift the emergency stop', run: async (_a, c) => (await c.call('ai.resume'), 'Emergency stop lifted. The AI may run again.') },
        },
      },
      alerts: { help: 'Alert actions', children: { 'mark-read': { help: 'Mark every alert read', run: async (_a, c) => ((l: any[]) => Promise.all(l.filter((a) => !a.read).map((a) => c.call('alerts.markRead', { id: a.id }))).then((r) => `Marked ${r.length} alert(s) read.`))(await c.call('alerts.inbox', { limit: 200 })) } } },
      goose: { help: 'Easter-egg department', children: { release: { help: 'You know what this does', run: async (_a, c) => ((await c.call('settings.get')).settings.appearance.easterEggs ? 'HONK. (Releasing the goose is a desktop-app thing: use Spotlight and type "honk".)' : 'Fun extras are off.') } } },
    },
  },
  ping: {
    help: 'Ping a host',
    arg: 'host',
    run: async (a, c) => {
      if (!a[0]) throw new CoreError('INVALID_ARGUMENT', 'ping <host> [count <n>]');
      const count = a[1] === 'count' ? Number(a[2]) || 4 : 4;
      const r = await c.call('net.ping', { host: a[0], count });
      return `${r.host}: ${r.received}/${r.sent} replies, loss ${r.loss}%, avg ${r.avg ?? '-'} ms (min ${r.min ?? '-'}, max ${r.max ?? '-'})`;
    },
  },
  configure: { help: 'Enter configuration mode', run: (_a, c) => ((c.session.mode = 'configure'), 'Entering configuration mode. "set", "delete", "show", "commit", "rollback", "exit".') },
  help: { help: 'List commands', run: () => helpText(OPERATIONAL) },
  clear: { help: 'Clear the screen', run: () => '' },
};

const CONFIG: Record<string, Node> = {
  set: { help: 'Set a value: set <section> <key> <value>', arg: 'path value' },
  delete: { help: 'Return a value to its default: delete <section> <key>', arg: 'path' },
  show: { help: 'Show the candidate changes ("show | compare" shows them as set lines)' },
  commit: { help: 'Apply the changes ("commit check" only validates them)' },
  rollback: { help: 'Discard the uncommitted changes' },
  run: { help: 'Run an operational command, e.g. "run show services"', arg: 'command' },
  exit: { help: 'Leave configuration mode' },
  help: { help: 'List commands' },
};

function helpText(tree: Record<string, Node>, prefix = ''): string {
  return Object.entries(tree)
    .map(([k, n]) => `  ${pad(`${prefix}${k}${n.arg ? ` <${n.arg}>` : ''}${n.children ? ' …' : ''}`, 34)} ${n.help}`)
    .join('\n');
}

function applyPipes(text: string, pipes: string[][]): string {
  let lines = text.split('\n');
  for (const p of pipes) {
    const [cmd, ...rest] = p;
    const arg = rest.join(' ');
    if (cmd === 'match') lines = lines.filter((l) => l.toLowerCase().includes(arg.toLowerCase()));
    else if (cmd === 'except') lines = lines.filter((l) => !l.toLowerCase().includes(arg.toLowerCase()));
    else if (cmd === 'count') lines = [`Count: ${lines.filter((l) => l.trim()).length} lines`];
    else if (cmd === 'last') lines = lines.slice(-(Number(rest[0]) || 10));
    else if (cmd === 'display') continue;
    else throw new CoreError('INVALID_ARGUMENT', `Unknown pipe "${cmd}" (match, except, count, last, display json, display set)`);
  }
  return lines.join('\n');
}

export class Fbrx1Cli {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly d: {
      call: Call;
      user: () => string;
      host: () => string;
    },
  ) {}

  private session(id: string): Session {
    let s = this.sessions.get(id);
    if (!s) {
      s = { mode: 'operational', candidate: {} };
      this.sessions.set(id, s);
      if (this.sessions.size > 50) this.sessions.delete(this.sessions.keys().next().value!);
    }
    return s;
  }

  prompt(id: string): string {
    const s = this.session(id);
    const base = `${this.d.user()}@${this.d.host()}`;
    return s.mode === 'configure' ? `[edit]\n${base}#` : `${base}>`;
  }

  async exec(id: string, line: string): Promise<CliResult> {
    const s = this.session(id);
    const done = (output: string, clear = false): CliResult => ({ output, prompt: this.prompt(id), mode: s.mode, ...(clear ? { clear } : {}) });
    const [cmdPart, ...pipeParts] = line.split('|');
    const pipes = pipeParts.map((p) => words(p)).filter((p) => p.length);
    const json = pipes.some((p) => p[0] === 'display' && p[1] === 'json');
    const asSet = pipes.some((p) => p[0] === 'display' && p[1] === 'set');
    const w = words(cmdPart);
    if (!w.length) return done('');
    if (w[w.length - 1] === '?') return done(this.help(s, w.slice(0, -1)));
    try {
      if (s.mode === 'configure') {
        const out = await this.configCommand(s, w, pipes);
        return done(out);
      }
      if (w[0] === 'clear') return done('', true);
      if (w[0] === 'show' && w[1] === 'configuration' && asSet) {
        const st = (await this.d.call('settings.get')) as EffectiveSettings;
        const section = w[2] ? { [w[2]]: getPath(st.settings, [w[2]]) } : st.settings;
        return done(applyPipes(renderConfig(section as Record<string, unknown>, true).join('\n'), pipes));
      }
      const { node, args } = this.resolve(OPERATIONAL, w);
      if (!node.run) return done(`${w.join(' ')}: incomplete command. Options:\n${helpText(node.children ?? {})}`);
      const text = await node.run(args, { call: this.d.call, session: s, json });
      return done(applyPipes(text, pipes));
    } catch (err) {
      return done(`error: ${errorMessage(err)}`);
    }
  }

  /** Finds the command node for the words (unique prefixes allowed, like "sh sys st"). */
  private resolve(tree: Record<string, Node>, w: string[]): { node: Node; args: string[] } {
    let level = tree;
    let node: Node | null = null;
    let i = 0;
    for (; i < w.length; i++) {
      const key = level[w[i]] ? w[i] : (() => {
        const hits = Object.keys(level).filter((k) => k.startsWith(w[i]));
        if (hits.length > 1) throw new CoreError('INVALID_ARGUMENT', `"${w[i]}" is ambiguous: ${hits.join(', ')}`);
        return hits[0];
      })();
      if (!key) {
        if (node?.arg || node?.run) break;
        throw new CoreError('INVALID_ARGUMENT', `syntax error, expecting one of: ${Object.keys(level).join(', ')} (got "${w[i]}")`);
      }
      node = level[key];
      if (!node.children) {
        i++;
        break;
      }
      level = node.children;
    }
    if (!node) throw new CoreError('INVALID_ARGUMENT', 'unknown command');
    return { node, args: w.slice(i) };
  }

  private help(s: Session, w: string[]): string {
    const tree = s.mode === 'configure' ? CONFIG : OPERATIONAL;
    if (!w.length) return `Possible completions:\n${helpText(tree)}`;
    try {
      const { node } = this.resolve(tree, w);
      return node.children ? `Possible completions:\n${helpText(node.children)}` : `${node.help}${node.arg ? `\n  <${node.arg}>` : ''}`;
    } catch (err) {
      return `error: ${errorMessage(err)}`;
    }
  }

  private async configCommand(s: Session, w: string[], pipes: string[][]): Promise<string> {
    const [cmd, ...rest] = w;
    if (cmd === 'exit' || cmd === 'quit' || cmd === 'top') {
      if (Object.keys(s.candidate).length && rest[0] !== 'discard') return 'Uncommitted changes. "commit" them, "rollback", or "exit discard".';
      s.candidate = {};
      s.mode = 'operational';
      return 'Exiting configuration mode.';
    }
    if (cmd === 'help') return helpText(CONFIG);
    if (cmd === 'run') return (await this.exec('__run__', `${rest.join(' ')}${pipes.length ? ` | ${pipes.map((p) => p.join(' ')).join(' | ')}` : ''}`)).output;
    if (cmd === 'set' || cmd === 'delete') {
      const settings = ((await this.d.call('settings.get')) as EffectiveSettings).settings;
      const path = cmd === 'set' ? rest.slice(0, -1) : rest;
      if (path.length < 2) throw new CoreError('INVALID_ARGUMENT', cmd === 'set' ? 'set <section> <key> <value>, e.g. set appearance preset tropical' : 'delete <section> <key>');
      const current = getPath(settings, path);
      if (current === undefined) throw new CoreError('NOT_FOUND', `No setting ${path.join(' ')} (try "run show configuration ${path[0]}")`);
      if (current && typeof current === 'object' && !Array.isArray(current)) throw new CoreError('INVALID_ARGUMENT', `${path.join(' ')} is a section; name a setting inside it`);
      let value: unknown;
      if (cmd === 'set') {
        value = parseValue(rest[rest.length - 1]);
        if (typeof current === 'string' && typeof value !== 'string') value = String(rest[rest.length - 1]);
      } else value = getPath(DEFAULT_SETTINGS, path);
      deepSet(s.candidate, path, value);
      return '';
    }
    if (cmd === 'show') {
      if (!Object.keys(s.candidate).length) return 'No uncommitted changes.';
      const compare = pipes.some((p) => p[0] === 'compare');
      return compare ? renderConfig(s.candidate, true).map((l) => `+ ${l}`).join('\n') : renderConfig(s.candidate, false).join('\n');
    }
    if (cmd === 'rollback') {
      s.candidate = {};
      return 'Uncommitted changes discarded.';
    }
    if (cmd === 'commit') {
      if (!Object.keys(s.candidate).length) return 'Nothing to commit.';
      if (rest[0] === 'check') {
        const eff = (await this.d.call('settings.get')) as EffectiveSettings;
        const locked = leafPaths(s.candidate).filter((p) => isPathLocked(p, eff.locked));
        if (locked.length) return `error: managed by your organization: ${locked.join(', ')}`;
        const r = SettingsSchema.safeParse(deepMerge(structuredClone(eff.settings), s.candidate));
        return r.success ? 'configuration check succeeds' : `error: ${r.error.issues.map((i) => `${i.path.join(' ')}: ${i.message}`).join('; ')}`;
      }
      await this.d.call('settings.update', { patch: s.candidate as DeepPartial<Settings> });
      const n = renderConfig(s.candidate, true).length;
      s.candidate = {};
      return `commit complete (${n} change${n === 1 ? '' : 's'})`;
    }
    throw new CoreError('INVALID_ARGUMENT', `syntax error, expecting one of: ${Object.keys(CONFIG).join(', ')}`);
  }

  /** Tab completion for the last word. */
  complete(id: string, line: string): string[] {
    const s = this.session(id);
    if (line.includes('|')) return ['match', 'except', 'count', 'last', 'display json', 'display set'].filter((x) => x.startsWith(line.split('|').pop()!.trim()));
    const w = words(line);
    const endsWithSpace = /\s$/.test(line) || !line;
    const head = endsWithSpace ? w : w.slice(0, -1);
    const last = endsWithSpace ? '' : (w[w.length - 1] ?? '');
    let level = s.mode === 'configure' ? CONFIG : OPERATIONAL;
    for (const x of head) {
      const k = level[x] ? x : Object.keys(level).find((key) => key.startsWith(x));
      const n = k ? level[k] : undefined;
      if (!n?.children) return [];
      level = n.children;
    }
    return Object.keys(level).filter((k) => k.startsWith(last));
  }
}
