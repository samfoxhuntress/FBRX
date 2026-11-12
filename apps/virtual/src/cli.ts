import { randomBytes } from 'node:crypto';
import { statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bestModelFor, modelFit, type CatalogModel, type DownloadProgress, type EffectiveSettings, type InstalledModel, type RuntimeHardware, type RuntimeStatus } from '@fbrx/shared';
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
  const tokens = (n: number) => (n >= 1024 && n % 1024 === 0 ? `${n / 1024}K` : n.toLocaleString());
  const FIT_WORDS = { gpu: 'fits the graphics card', memory: 'fits in memory', tight: 'only just fits', 'too-big': 'too big for this server' } as const;
  const core = new CoreLink(config.core.url, config.core.tokenFile);
  const call = <T>(method: string, params?: unknown) => core.call<T>(method, params ?? {}, 'fbrx-server', 120_000);
  const flags = new Set(a.filter((x) => x.startsWith('--')));
  const [sub = 'status', ...rest] = a.filter((x) => !x.startsWith('--'));
  /** Shows a download until it ends, with its speed and time left (Ctrl+C stops watching; the download carries on). */
  const follow = async (id: string, what: string) => {
    let last: { at: number; bytes: number } | null = null;
    let speed = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const d = (await call<DownloadProgress[]>('runtime.downloads')).find((x) => x.modelId === id);
      if (!d) continue;
      if (d.state === 'downloading' || d.state === 'verifying') {
        const now = Date.now();
        // Smoothed over the last readings, so one slow moment does not swing the estimate.
        if (last && now > last.at) speed = speed ? speed * 0.7 + (((d.receivedBytes - last.bytes) / (now - last.at)) * 1000) * 0.3 : ((d.receivedBytes - last.bytes) / (now - last.at)) * 1000;
        last = { at: now, bytes: d.receivedBytes };
        const pct = d.totalBytes ? Math.round((d.receivedBytes / d.totalBytes) * 100) : 0;
        const eta = speed > 0 && d.totalBytes ? Math.round((d.totalBytes - d.receivedBytes) / speed) : null;
        const left = eta === null ? '' : eta >= 3600 ? ` · ${Math.floor(eta / 3600)} h ${Math.round((eta % 3600) / 60)} min left` : ` · ${Math.max(1, Math.round(eta / 60))} min left`;
        process.stdout.write(`\r${what}: ${d.state === 'verifying' ? 'checking…' : `${pct}% (${GB(d.receivedBytes)} of ${GB(d.totalBytes)}${speed > 0 ? ` · ${(speed / 1e6).toFixed(0)} MB/s` : ''}${left})`}          `);
        continue;
      }
      process.stdout.write('\n');
      if (d.state === 'completed') return console.log(`${what}: done.`);
      throw new Error(`${what}: ${d.state === 'cancelled' ? 'cancelled' : (d.error ?? 'failed')}`);
    }
  };
  /** Free space where the core keeps its models. */
  const diskFree = () => {
    try {
      const f = statfsSync(dirname(config.core.tokenFile));
      return f.bavail * f.bsize;
    } catch {
      return Infinity;
    }
  };
  /** A model from Hugging Face (owner/name[:QUANT]) joins the list; FBRX's own and ones added before are found as they are. */
  const add = async (source: string, name?: string) => {
    const m = await call<CatalogModel>('runtime.addModel', { source, ...(name ? { name } : {}) });
    console.log(`${m.name} (${m.id}): ${GB(m.sizeBytes)}${m.hf ? `, from Hugging Face (${m.hf.repo})` : ''}.`);
    return m;
  };
  switch (sub) {
    case 'status': {
      const [st, hw, models] = await Promise.all([call<RuntimeStatus>('runtime.status'), call<RuntimeHardware>('runtime.hardware'), call<InstalledModel[]>('runtime.installed')]);
      const active = models.find((m) => m.active);
      console.log(`Runtime:   ${st.state}${st.message ? ` (${st.message})` : ''}`);
      console.log(`Model:     ${active ? `${active.name} (${active.id})` : 'none yet: fbrx-server ai recommend'}`);
      if (st.contextSize) console.log(`Context:   ${tokens(st.contextSize)} tokens${st.contextAuto ? ' (Auto: fbrx-server ai context to change it)' : ''}`);
      console.log(`Memory:    ${GB(hw.memoryBytes)} (${GB(hw.freeMemoryBytes)} free) · ${hw.cpus} threads`);
      console.log(`Graphics:  ${hw.gpus.length ? hw.gpus.map((g) => `${g.name}${g.vramBytes ? ` ${GB(g.vramBytes)}` : ''}`).join(', ') : 'none found'} · runtime build: ${hw.variant}`);
      console.log(`Disk:      ${GB(diskFree())} free for models`);
      return;
    }
    case 'models': {
      const [catalog, installed, hw] = await Promise.all([call<CatalogModel[]>('runtime.catalog'), call<InstalledModel[]>('runtime.installed'), call<RuntimeHardware>('runtime.hardware')]);
      const have = new Map(installed.map((m) => [m.id, m]));
      for (const m of catalog) {
        const mine = have.get(m.id);
        const mark = mine?.active ? '* ' : mine ? '+ ' : '  ';
        const notes = [FIT_WORDS[modelFit(m.sizeBytes, hw)], m.contextLength ? `${tokens(m.contextLength)} context` : '', m.added ? 'from Hugging Face' : m.tier === 'server' ? 'for servers' : ''].filter(Boolean).join(' · ');
        console.log(`${mark}${m.id.padEnd(30)} ${m.name.padEnd(30)} ${GB(m.sizeBytes).padStart(6)}  ${notes}`);
      }
      for (const m of installed.filter((x) => x.source === 'imported')) console.log(`${m.active ? '* ' : '+ '}${m.id.padEnd(30)} ${m.name.padEnd(30)} ${GB(m.sizeBytes).padStart(6)}  imported`);
      console.log('\n* in use   + downloaded      fbrx-server ai download <id> --use (downloads it, then makes it this server\'s AI)');
      return;
    }
    case 'recommend': {
      const [catalog, hw] = await Promise.all([call<CatalogModel[]>('runtime.catalog'), call<RuntimeHardware>('runtime.hardware')]);
      const best = bestModelFor(catalog, hw, diskFree());
      if (!best) throw new Error(`No model fits this server: ${GB(hw.memoryBytes)} of memory, ${GB(diskFree())} free on the disk (20 GB stays free)`);
      const fit = modelFit(best.sizeBytes, hw);
      console.log(`Best for this server: ${best.name} (${GB(best.sizeBytes)}${best.contextLength ? `, ${tokens(best.contextLength)} context` : ''})`);
      console.log(`  ${best.description}`);
      console.log(`  It ${fit === 'gpu' ? 'runs on the graphics card' : 'runs on the processors, in memory'} here.`);
      console.log(`\nInstall it:  sudo fbrx-server ai download ${best.id} --use`);
      return;
    }
    case 'add': {
      const [source, ...name] = rest;
      if (!source) throw new Error('Usage: fbrx-server ai add <owner/name[:QUANT]> [name]   (a GGUF model on Hugging Face; Q4_K_M unless named)');
      const m = await add(source, name.join(' ') || undefined);
      console.log(`Download it: sudo fbrx-server ai download ${m.id} --use`);
      return;
    }
    case 'install-runtime':
      await call('runtime.installRuntime');
      await follow('llama-runtime', 'The runtime');
      return;
    case 'download': {
      let id = rest[0];
      if (!id) throw new Error('Usage: fbrx-server ai download <id | owner/name[:QUANT]> [--use]   (fbrx-server ai models lists them)');
      // A Hugging Face model by its repository: added to the list first.
      if (id.includes('/')) id = (await add(id)).id;
      await call('runtime.download', { modelId: id });
      await follow(id, id);
      if (!flags.has('--use')) return console.log(`Make it this server's AI: sudo fbrx-server ai use ${id}`);
      const st = await call<RuntimeStatus>('runtime.useModel', { modelId: id });
      console.log(`${id} is this server's AI. Runtime: ${st.state}${st.message ? ` (${st.message})` : ''}`);
      return;
    }
    case 'use': {
      const id = rest[0];
      if (!id) throw new Error('Usage: fbrx-server ai use <id>');
      const st = await call<RuntimeStatus>('runtime.useModel', { modelId: id });
      console.log(`${id} is this server's AI. Runtime: ${st.state}${st.message ? ` (${st.message})` : ''}`);
      return;
    }
    case 'delete': {
      const id = rest[0];
      if (!id) throw new Error('Usage: fbrx-server ai delete <id>');
      const r = await call<{ deleted: boolean }>('runtime.deleteModel', { modelId: id });
      console.log(r.deleted ? `${id} is deleted.` : `${id} was not on this server.`);
      return;
    }
    case 'context': {
      const want = rest[0]?.toLowerCase();
      if (want) {
        const n = want === 'auto' ? 0 : /^\d+k$/.test(want) ? Number(want.slice(0, -1)) * 1024 : Number(want);
        if (!Number.isInteger(n) || (n !== 0 && (n < 2048 || n > 262144))) throw new Error('Usage: fbrx-server ai context [auto | 32k | 64k | 128k | <tokens>]   (2,048 to 262,144 tokens)');
        await call<EffectiveSettings>('settings.update', { patch: { runtime: { contextSize: n } } });
      }
      const st = await call<RuntimeStatus>('runtime.status');
      console.log(`Context window: ${st.contextSize ? `${tokens(st.contextSize)} tokens` : 'set when a model is chosen'}${st.contextAuto ? ' (Auto: as much as this server has room for, up to 128K)' : ''}`);
      if (want) console.log('The runtime restarts with it at the next question.');
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
          'fbrx-server ai                       the runtime, the model in use, its context window, memory and graphics',
          'fbrx-server ai models                the models, what fits this server, which are downloaded',
          'fbrx-server ai recommend             the best model for this server, and how to install it',
          'fbrx-server ai download <id> [--use] download a model (and make it this server\'s AI); Ctrl+C stops watching',
          'fbrx-server ai download <owner/name[:QUANT]> [--use]   the same for a GGUF model on Hugging Face',
          'fbrx-server ai add <owner/name[:QUANT]> [name]          put a Hugging Face model on the list',
          'fbrx-server ai use <id>              make it this server\'s AI (the one the mesh borrows)',
          'fbrx-server ai delete <id>           delete a model (one added from Hugging Face also leaves the list)',
          'fbrx-server ai context [auto|64k|128k|<tokens>]  how much the model keeps in mind at once',
          'fbrx-server ai install-runtime       install or update the built-in runtime (llama.cpp)',
          'fbrx-server ai import <file> [name]  a GGUF model file copied to the server (/srv, not a home folder)',
          'fbrx-server ai start | stop | logs   the runtime itself',
        ].join('\n'),
      );
      process.exitCode = sub === 'help' ? 0 : 1;
  }
}
