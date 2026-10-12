import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { modelFit, type CatalogModel, type DownloadProgress, type InstalledModel, type RuntimeHardware, type RuntimeStatus } from '@fbrx/shared';
import { Db } from '@fbrx/shared/node';
import { Auth } from './auth';
import { Audit } from './audit';
import { loadConfig } from './config';
import { CoreLink } from './core-link';
import { VIRTUAL_MIGRATIONS } from './migrations';
import { clearSetupCode } from './setup-code';
import { checkForUpdate, installedVersion, readStaged, DEFAULT_UPDATE_PATHS } from './server-update';

/**
 * Server-side helpers for FBRX Virtual, run on the server itself (fbrx-server reset-password ...): for when nobody can
 * sign in any more.
 */
const [cmd, ...args] = process.argv.slice(2);
const config = loadConfig();
const db = new Db(join(config.dataDir, 'virtual.db'));
db.migrate(VIRTUAL_MIGRATIONS);
const auth = new Auth(db, config.sessionHours);
const audit = new Audit(db);
const newPassword = () => randomBytes(12).toString('base64url');

try {
  switch (cmd) {
    case 'reset-password': {
      const username = args[0];
      const user = auth.listUsers().find((u) => u.username.toLowerCase() === String(username ?? '').toLowerCase());
      if (!user) throw new Error(username ? `No user called ${username}. Users: ${auth.listUsers().map((u) => u.username).join(', ') || 'none'}` : 'Usage: reset-password <username>');
      const password = newPassword();
      await auth.updateUser(user.id, { password });
      audit.record('console', 'user.password-reset', user.username);
      console.log(`New password for ${user.username}: ${password}\nSign in and change it (Users & audit → My password).`);
      break;
    }
    case 'create-admin': {
      const username = args[0] ?? 'admin';
      const password = newPassword();
      await auth.createUser({ username, name: username, password, role: 'admin' });
      audit.record('console', 'user.create', username, 'success', { role: 'admin' });
      clearSetupCode(config.dataDir); // set up now: the first-time code is spent
      console.log(`Administrator ${username} created. Password: ${password}`);
      break;
    }
    case 'users':
      for (const u of auth.listUsers()) console.log(`${u.username.padEnd(20)} ${u.role.padEnd(9)} last sign-in ${u.lastLoginAt ?? 'never'}`);
      break;
    case 'ai':
      await ai(args);
      break;
    case 'update-check':
      await updateCheck(args);
      break;
    case 'update-staged': {
      // For fbrx-server update (status): what is staged, one line.
      const st = readStaged(DEFAULT_UPDATE_PATHS);
      if (st) console.log(`${st.version}${st.summary ? ` · ${st.summary}` : ''}`);
      break;
    }
    default:
      console.log('FBRX Virtual server helpers:\n  users                     list who can sign in\n  reset-password <username> give someone a new password\n  create-admin [username]   add an administrator\n  ai [command]              the models on this server (ai help)');
      process.exitCode = cmd ? 1 : 0;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  db.close();
}

// ----------------------------------------------------------------------------------- fbrx-server update

/** fbrx-server update check [--file <bundle>] [--from <release list>] [--force]: gets a newer FBRX Server ready. */
async function updateCheck(a: string[]): Promise<void> {
  let file: string | undefined;
  let manifest = process.env.FBRX_SERVER_UPDATE_URL || undefined;
  let force = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--file') file = a[++i];
    else if (a[i] === '--from') manifest = a[++i];
    else if (a[i] === '--force') force = true;
    else throw new Error(`Unknown option ${a[i]} (update check [--file <bundle.tar.gz>] [--from <release list>] [--force])`);
  }
  const tty = process.stdout.isTTY;
  let shown = -1;
  const r = await checkForUpdate({
    file,
    manifest,
    force,
    anyHost: !!manifest,
    log: (l) => console.log(l),
    progress: (got, total) => {
      if (!tty || !total) return;
      const pct = Math.floor((got / total) * 100);
      if (pct !== shown) process.stdout.write(`\r  ${pct}% of ${(total / 1e6).toFixed(0)} MB   `);
      shown = pct;
      if (got >= total) process.stdout.write('\n');
    },
  });
  if (r.state === 'current') {
    console.log(`FBRX Server ${r.installed} is up to date${r.latest !== r.installed ? ` (that bundle is ${r.latest}; --force installs it anyway)` : ''}.`);
    return;
  }
  const s = r.staged;
  console.log(`\nFBRX Server ${s.version} is ready to install (this server runs ${r.installed})${r.already ? ', downloaded earlier' : ''}.`);
  if (s.summary) console.log(`  ${s.summary}`);
  for (const n of s.notes) console.log(`  • ${n}`);
  console.log(`\nInstall it:   sudo fbrx-server update commit`);
  console.log('Virtual machines keep running; the console and the AI role restart. If it does not come back, the server goes back to');
  console.log(`${installedVersion(DEFAULT_UPDATE_PATHS)} by itself; sudo fbrx-server update rollback goes back later too.`);
}

// ------------------------------------------------------------------------------------------- fbrx-server ai

/** The models on this server, through the FBRX core (the ai role), as the console's Models page does. */
async function ai(a: string[]): Promise<void> {
  // (Declared here: the commands above run before the rest of this file is read.)
  const GB = (n: number) => `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`;
  const FIT_WORDS = { gpu: 'fits the graphics card', memory: 'fits in memory', tight: 'only just fits', 'too-big': 'too big for this server' } as const;
  const core = new CoreLink(config.core.url, config.core.tokenFile);
  const call = <T>(method: string, params?: unknown) => core.call<T>(method, params ?? {}, 'fbrx-server', 120_000);
  const [sub = 'status', ...rest] = a;
  /** Shows a download until it ends (Ctrl+C stops watching; the download carries on). */
  const follow = async (id: string, what: string) => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const d = (await call<DownloadProgress[]>('runtime.downloads')).find((x) => x.modelId === id);
      if (!d) continue;
      if (d.state === 'downloading' || d.state === 'verifying') {
        const pct = d.totalBytes ? Math.round((d.receivedBytes / d.totalBytes) * 100) : 0;
        process.stdout.write(`\r${what}: ${d.state === 'verifying' ? 'checking…' : `${pct}% (${GB(d.receivedBytes)} of ${GB(d.totalBytes)})`}   `);
        continue;
      }
      process.stdout.write('\n');
      if (d.state === 'completed') return console.log(`${what}: done.`);
      throw new Error(`${what}: ${d.state === 'cancelled' ? 'cancelled' : (d.error ?? 'failed')}`);
    }
  };
  switch (sub) {
    case 'status': {
      const [st, hw, models] = await Promise.all([call<RuntimeStatus>('runtime.status'), call<RuntimeHardware>('runtime.hardware'), call<InstalledModel[]>('runtime.installed')]);
      const active = models.find((m) => m.active);
      console.log(`Runtime:   ${st.state}${st.message ? ` (${st.message})` : ''}`);
      console.log(`Model:     ${active ? `${active.name} (${active.id})` : 'none yet: fbrx-server ai models'}`);
      console.log(`Memory:    ${GB(hw.memoryBytes)} (${GB(hw.freeMemoryBytes)} free) · ${hw.cpus} threads`);
      console.log(`Graphics:  ${hw.gpus.length ? hw.gpus.map((g) => `${g.name}${g.vramBytes ? ` ${GB(g.vramBytes)}` : ''}`).join(', ') : 'none found'} · runtime build: ${hw.variant}`);
      return;
    }
    case 'models': {
      const [catalog, installed, hw] = await Promise.all([call<CatalogModel[]>('runtime.catalog'), call<InstalledModel[]>('runtime.installed'), call<RuntimeHardware>('runtime.hardware')]);
      const have = new Map(installed.map((m) => [m.id, m]));
      for (const m of catalog) {
        const mine = have.get(m.id);
        const mark = mine?.active ? '* ' : mine ? '+ ' : '  ';
        console.log(`${mark}${m.id.padEnd(30)} ${m.name.padEnd(24)} ${GB(m.sizeBytes).padStart(6)}  ${FIT_WORDS[modelFit(m.sizeBytes, hw)]}${m.tier === 'server' ? ' · for servers' : ''}`);
      }
      for (const m of installed.filter((x) => x.source === 'imported')) console.log(`${m.active ? '* ' : '+ '}${m.id.padEnd(30)} ${m.name.padEnd(24)} ${GB(m.sizeBytes).padStart(6)}  imported`);
      console.log('\n* in use   + downloaded      fbrx-server ai download <id>, then fbrx-server ai use <id>');
      return;
    }
    case 'install-runtime':
      await call('runtime.installRuntime');
      await follow('llama-runtime', 'The runtime');
      return;
    case 'download': {
      const id = rest[0];
      if (!id) throw new Error('Usage: fbrx-server ai download <id> (fbrx-server ai models lists them)');
      await call('runtime.download', { modelId: id });
      await follow(id, id);
      return;
    }
    case 'use': {
      const id = rest[0];
      if (!id) throw new Error('Usage: fbrx-server ai use <id>');
      const st = await call<RuntimeStatus>('runtime.useModel', { modelId: id });
      console.log(`${id} is this server's AI. Runtime: ${st.state}${st.message ? ` (${st.message})` : ''}`);
      return;
    }
    case 'import': {
      const [path, ...name] = rest;
      if (!path) throw new Error('Usage: fbrx-server ai import /srv/model.gguf [name]');
      // The core runs locked down: home folders are out of its sight.
      if (/^\/(home|root)\//.test(path)) throw new Error('The FBRX core cannot read home folders: copy the file to /srv (or /var/tmp) first');
      const m = await call<InstalledModel>('runtime.importModel', { path, ...(name.length ? { name: name.join(' ') } : {}) });
      console.log(`Imported ${m.name} as ${m.id}. Make it this server's AI: fbrx-server ai use ${m.id}`);
      return;
    }
    case 'start':
    case 'stop': {
      const st = await call<RuntimeStatus>(`runtime.${sub}`);
      console.log(`Runtime: ${st.state}${st.message ? ` (${st.message})` : ''}`);
      return;
    }
    case 'logs':
      for (const l of await call<string[]>('runtime.logs')) console.log(l);
      return;
    default:
      console.log(
        [
          'fbrx-server ai                     the runtime, the model in use, memory and graphics',
          'fbrx-server ai models              the models, what fits this server, which are downloaded',
          'fbrx-server ai install-runtime     install or update the built-in runtime (llama.cpp)',
          'fbrx-server ai download <id>       download a model (Ctrl+C stops watching; it carries on)',
          'fbrx-server ai use <id>            make it this server\'s AI (the one the mesh borrows)',
          'fbrx-server ai import <file> [name] a GGUF model file copied to the server (/srv, not a home folder)',
          'fbrx-server ai start | stop | logs the runtime itself',
        ].join('\n'),
      );
      process.exitCode = sub === 'help' ? 0 : 1;
  }
}
