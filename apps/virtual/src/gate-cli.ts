import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addPath, deletePath, getPath, parseValue, setPath, type GateCommit, type GateConfig, type GateIssue, type GateLive, type GateState } from '@fbrx/gate';
import { loadConfig } from './config';

/**
 * fbrx-gate: FBRX Gate's command line, on the gate itself (as root). It edits the same candidate as the console,
 * through the local FBRX Virtual service, signed in with the root-only CLI token.
 */
const HELP = `fbrx-gate: FBRX Gate's command line

  status                         what runs: ports, the internet side, leases, problems
  show [running] [path…]         the configuration being edited (or what runs), or part of it
  set <path…> <value>            change a setting     set networks guest access internet
  add <path…> <json>             add to a list        add firewall rules '{"id":"ssh","name":"…",…}'
  delete <path…>                 remove an item or an optional setting
  edit                           edit the whole configuration in $EDITOR
  check                          problems and warnings in what is being edited
  compare                        what a commit would change
  commit [confirmed <minutes>] [comment <text…>]
                                 apply it; "confirmed" rolls back by itself unless you confirm in time
  confirm                        keep a commit made with "confirmed"
  rollback <commit>              go back to an earlier commit
  rollback now                   undo the commit waiting to be confirmed, now
  reset                          throw the edits away
  history                        commits, newest first
  leases                         devices that got an address
  preview nftables|dnsmasq|networkd
                                 the files the configuration turns into

Paths are words: networks lan dhcp end · interfaces eno2.30 mtu · firewall forwards web port`;

const config = loadConfig();
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = paint('31');
const yellow = paint('33');
const green = paint('32');
const dim = paint('2');
const bold = paint('1');

function token(): string {
  const file = join(config.dataDir, 'cli.token');
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    throw new Error(`Cannot read ${file}: run fbrx-gate as root on the gate (sudo fbrx-gate …), with FBRX Virtual running.`);
  }
}

function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const tls = !!config.tls;
  const cert = join(config.dataDir, 'tls', 'virtual.crt');
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const opts = {
      host: '127.0.0.1',
      port: config.port,
      method,
      path,
      headers: { authorization: `Bearer ${token()}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) },
      // The service's own certificate, pinned: no name check (it is made for the server's names, not 127.0.0.1).
      ...(tls && existsSync(cert) ? { ca: readFileSync(cert), checkServerIdentity: () => undefined } : {}),
    };
    const req = (tls ? httpsRequest : httpRequest)(opts, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json: any = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          /* not JSON */
        }
        if ((res.statusCode ?? 500) >= 400) {
          const err = new Error(json?.error?.message ?? `HTTP ${res.statusCode}`) as Error & { issues?: GateIssue[] };
          err.issues = json?.error?.issues;
          reject(err);
        } else resolve(json as T);
      });
    });
    req.on('error', (e) => reject(new Error(`FBRX Virtual does not answer on port ${config.port} (${e.message}). sudo systemctl status fbrx-virtual`)));
    req.end(data);
  });
}

const issues = (list: GateIssue[], color: (s: string) => string, label: string) => {
  for (const i of list) console.log(`${color(label)} ${dim(i.path)}  ${i.message}`);
};

function printCheck(s: Pick<GateState, 'errors' | 'warnings' | 'changes'>) {
  issues(s.errors, red, 'error  ');
  issues(s.warnings, yellow, 'warning');
  if (!s.errors.length) console.log(s.changes.length ? `${green('ok')} ${s.changes.length} change${s.changes.length === 1 ? '' : 's'} to commit` : dim('Nothing to commit.'));
}

async function state(): Promise<GateState> {
  return (await api<{ state: GateState }>('GET', '/v1/gate')).state;
}

async function save(next: GateConfig) {
  const r = await api<{ state: GateState }>('PUT', '/v1/gate/candidate', { config: next });
  printCheck(r.state);
}

const fmtBytes = (n: number) => (n > 1e12 ? `${(n / 1e12).toFixed(1)} TB` : n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`);
const show = (v: unknown) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

async function main(argv: string[]): Promise<number> {
  const [cmd = 'status', ...rest] = argv;
  switch (cmd) {
    case 'help':
    case '-h':
    case '--help':
      console.log(HELP);
      return 0;
    case 'status': {
      const s = await state();
      const live = await api<GateLive>('GET', '/v1/gate/live');
      const run = s.running;
      console.log(bold(`FBRX Gate ${run?.hostname ?? ''}`) + (run ? '' : dim('  (nothing committed yet: sudo fbrx-gate commit)')));
      if (s.confirm) console.log(yellow(`Commit ${s.confirm.commitId} rolls back at ${new Date(s.confirm.deadline).toLocaleTimeString()} unless confirmed: sudo fbrx-gate confirm`));
      if (s.changes.length) console.log(yellow(`${s.changes.length} change${s.changes.length === 1 ? '' : 's'} not committed (fbrx-gate compare)`));
      console.log(`Internet     ${live.wan.address ?? '—'}${live.wan.gateway ? ` via ${live.wan.gateway}` : ''}`);
      for (const i of live.interfaces) {
        const net = run?.networks.find((n) => n.interface === i.name);
        console.log(`${i.name.padEnd(12)} ${i.up ? green('up  ') : red('down')} mtu ${String(i.mtu).padEnd(5)} ${(net ? `${net.name} ${net.address}` : i.name === run?.wan.interface ? 'internet' : '').padEnd(26)} ↓ ${fmtBytes(i.rxBytes)}  ↑ ${fmtBytes(i.txBytes)}`);
      }
      console.log(`Leases       ${live.leases.length}   Connections ${live.conntrack ?? '—'}   DNS ${live.dns.running ? green('running') : red('stopped')}   Shaping ${live.qos.kind ?? 'off'}`);
      const dropped = (live.counters['default:input']?.packets ?? 0) + (live.counters['default:forward']?.packets ?? 0);
      console.log(`Dropped      ${dropped} packets since the last commit`);
      for (const p of live.problems) console.log(red(`problem      ${p}`));
      return 0;
    }
    case 'show': {
      const s = await state();
      const running = rest[0] === 'running';
      const path = running ? rest.slice(1) : rest;
      const v = getPath(running ? s.running : s.candidate, path);
      if (v === undefined) throw new Error(`There is no ${path.join(' ')}`);
      show(v);
      return 0;
    }
    case 'set': {
      if (rest.length < 2) throw new Error('Usage: fbrx-gate set <path…> <value>');
      const s = await state();
      const path = rest.slice(0, -1);
      const value = parseValue(rest[rest.length - 1], getPath(s.candidate, path));
      await save(setPath(s.candidate, path, value));
      return 0;
    }
    case 'add': {
      if (rest.length < 2) throw new Error("Usage: fbrx-gate add <path…> '<json>'");
      const s = await state();
      await save(addPath(s.candidate, rest.slice(0, -1), JSON.parse(rest[rest.length - 1])));
      return 0;
    }
    case 'delete': {
      const s = await state();
      await save(deletePath(s.candidate, rest));
      return 0;
    }
    case 'edit': {
      const s = await state();
      const dir = mkdtempSync(join(tmpdir(), 'fbrx-gate-'));
      const file = join(dir, 'gate.json');
      try {
        writeFileSync(file, `${JSON.stringify(s.candidate, null, 2)}\n`, { mode: 0o600 });
        const editor = process.env.VISUAL || process.env.EDITOR || 'nano';
        const r = spawnSync(editor, [file], { stdio: 'inherit' });
        if (r.status !== 0) throw new Error(`${editor} exited with ${r.status}`);
        await save(JSON.parse(readFileSync(file, 'utf8')));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      return 0;
    }
    case 'check':
      printCheck(await state());
      return 0;
    case 'compare': {
      const s = await state();
      if (!s.changes.length) console.log(dim('No changes.'));
      for (const c of s.changes) {
        const sign = c.kind === 'added' ? green('+') : c.kind === 'removed' ? red('-') : yellow('~');
        const val = (v: unknown) => (v === undefined ? '' : JSON.stringify(v).slice(0, 120));
        console.log(`${sign} ${c.path.replace(/\./g, ' ')}${c.kind === 'changed' ? `  ${dim(val(c.from))} → ${val(c.to)}` : `  ${dim(val(c.kind === 'added' ? c.to : c.from))}`}`);
      }
      return 0;
    }
    case 'commit': {
      let confirmMinutes = 0;
      let comment = '';
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === 'confirmed') confirmMinutes = Number(rest[++i] ?? 5) || 5;
        else if (rest[i] === 'comment') {
          comment = rest.slice(i + 1).join(' ');
          break;
        }
      }
      const r = await api<{ commit: GateCommit; notes: string[] }>('POST', '/v1/gate/commit', { comment, confirmMinutes });
      console.log(green(`Commit ${r.commit.id} applied`) + (r.commit.confirmBy ? yellow(`: it rolls back at ${new Date(r.commit.confirmBy).toLocaleTimeString()} unless you run fbrx-gate confirm`) : ''));
      for (const n of r.notes) console.log(dim(n));
      return 0;
    }
    case 'confirm': {
      const r = await api<{ commit: GateCommit }>('POST', '/v1/gate/confirm', {});
      console.log(green(`Commit ${r.commit.id} confirmed`));
      return 0;
    }
    case 'rollback': {
      if (rest[0] === 'now') {
        const r = await api<{ commit: GateCommit }>('POST', '/v1/gate/confirm/undo', {});
        console.log(yellow(`Commit ${r.commit.id} rolled back`) + dim(' (what was edited is still the candidate, to fix and commit again)'));
        return 0;
      }
      const to = Number(rest[0]);
      if (!to) throw new Error('Usage: fbrx-gate rollback <commit> (fbrx-gate history lists them)');
      const r = await api<{ commit: GateCommit }>('POST', '/v1/gate/rollback', { to });
      console.log(green(`Back to commit ${to} (as commit ${r.commit.id})`));
      return 0;
    }
    case 'reset':
      await api('POST', '/v1/gate/candidate/reset', {});
      console.log('Edits thrown away: the candidate is what runs.');
      return 0;
    case 'history': {
      const { commits } = await api<{ commits: GateCommit[] }>('GET', '/v1/gate/history');
      for (const c of commits) {
        const st = c.status === 'confirmed' ? green(c.status) : c.status === 'applied' ? yellow('waiting') : red(c.status);
        console.log(`${String(c.id).padStart(4)}  ${new Date(c.at).toLocaleString()}  ${c.by.padEnd(10)} ${st.padEnd(tty ? 20 : 11)} ${c.changes} change${c.changes === 1 ? ' ' : 's'}  ${c.comment}${c.error ? red(`  (${c.error})`) : ''}`);
      }
      return 0;
    }
    case 'leases': {
      const live = await api<GateLive>('GET', '/v1/gate/live');
      if (!live.leases.length) console.log(dim('No leases.'));
      for (const l of live.leases) console.log(`${l.address.padEnd(16)} ${l.mac}  ${(l.name ?? '').padEnd(24)} ${l.network ?? ''}  ${l.expires ? `until ${new Date(l.expires).toLocaleString()}` : 'reserved'}`);
      return 0;
    }
    case 'preview': {
      const what = rest[0] ?? 'nftables';
      const p = await api<{ nftables: string; dnsmasq: string; networkd: Array<{ name: string; content: string }> }>('GET', '/v1/gate/preview');
      if (what === 'nftables') process.stdout.write(p.nftables);
      else if (what === 'dnsmasq') process.stdout.write(p.dnsmasq);
      else if (what === 'networkd') for (const f of p.networkd) console.log(`${bold(`# ${f.name}`)}\n${f.content}`);
      else throw new Error('preview nftables, dnsmasq or networkd');
      return 0;
    }
    default:
      console.error(`Unknown command ${cmd}\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: Error & { issues?: GateIssue[] }) => {
    console.error(red(e.message));
    if (e.issues) issues(e.issues, red, 'error  ');
    process.exit(1);
  },
);
