#!/usr/bin/env node
/**
 * FBRX OS headless runner: the full core (agent, governance, vault, plugins, connectors, backup, fleet agent,
 * Local API) without the desktop UI. Useful for servers, kiosks, CI and lab machines.
 *
 *   fbrx-headless [--data-dir DIR] [--dev]                 run (default)
 *   fbrx-headless enroll <serverUrl> <token> [--name N] [--fingerprint FP]    enroll with a control plane, then run
 *   fbrx-headless backup <passphrase> [--label L]          create an encrypted snapshot and exit
 *   fbrx-headless restore <file> <passphrase> [--clone]    stage a snapshot restore and exit
 *   fbrx-headless status                                    print status JSON and exit
 *   fbrx-headless token                                     print the Local API token and exit
 *
 * On FBRX Server (the "ai" role) it runs as a service with --server: the mesh and the Local API are on from the first
 * start, the roles it announces come from --roles, and a console token for the server's own management console
 * (FBRX Virtual) is written to --console-token-file (root only; a new one each start).
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { Kernel } from '../src/kernel';
import { createNodePlatform } from '../src/node-platform';
import { defaultDataRoot } from '../src/paths';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const bool = (name: string) => {
  const i = argv.indexOf(name);
  if (i === -1) return false;
  argv.splice(i, 1);
  return true;
};

const dataDir = flag('--data-dir') ?? defaultDataRoot();
const devMode = bool('--dev') || process.env.FBRX_DEV_MODE === '1';
const name = flag('--name');
const fingerprint = flag('--fingerprint');
const label = flag('--label');
const clone = bool('--clone');
const serverMode = bool('--server') || process.env.FBRX_SERVER === '1';
const roles = (flag('--roles') ?? process.env.FBRX_SERVER_ROLES ?? '').split(',').map((r) => r.trim()).filter((r) => /^[a-z][a-z0-9-]{0,31}$/.test(r));
const consoleTokenFile = flag('--console-token-file') ?? process.env.FBRX_CONSOLE_TOKEN_FILE ?? (serverMode ? join(dataDir, 'console.token') : undefined);
const [command = 'run', ...rest] = argv;
const user = { origin: 'user' as const, actor: 'cli' };

let kernel: Kernel | null = null;
let restarting = false;

async function boot(): Promise<Kernel> {
  const k = await Kernel.create({
    dataDir,
    logToConsole: command === 'run' || command === 'enroll',
    platform: createNodePlatform({
      dataDir,
      devMode,
      requestRestart: (reason) => {
        if (restarting || command !== 'run') return;
        restarting = true;
        console.log(`Restarting core (${reason})…`);
        setTimeout(async () => {
          await kernel?.stop();
          kernel = await boot();
          restarting = false;
        }, 100);
      },
    }),
  });
  if (serverMode && command === 'run') applyServerDefaults(k);
  await k.start();
  if (serverMode && command === 'run') {
    // A server has no administrator sitting at it: its console's administrators decide whether it is a controller.
    const controller = () => k.assist.setAdmin(k.settings.get().mesh.assist.controller);
    controller();
    k.settings.onChange(controller);
  }
  if (consoleTokenFile && command === 'run') {
    const token = `fbrx_console_${randomBytes(32).toString('base64url')}`;
    mkdirSync(dirname(consoleTokenFile), { recursive: true, mode: 0o700 });
    writeFileSync(consoleTokenFile, `${token}\n`, { mode: 0o600 });
    chmodSync(consoleTokenFile, 0o600);
    k.localApi.setConsoleToken(token);
  }
  return k;
}

/** A server's first start: on the mesh, Local API for its console, named after the host; roles every start. */
function applyServerDefaults(k: Kernel) {
  const first = !k.meta.get<boolean>('server.defaults.v1');
  k.settings.update({
    ...(first
      ? {
          general: { deviceName: hostname(), onboardingComplete: true },
          localApi: { enabled: true, allowRemote: false },
          mesh: { enabled: true },
          runtime: { autoStart: false },
        }
      : {}),
    mesh: { ...(first ? { enabled: true } : {}), assist: { roles } },
  } as never);
  if (first) k.meta.set('server.defaults.v1', true);
}

async function main() {
  kernel = await boot();
  const k = kernel;
  switch (command) {
    case 'run':
      break;
    case 'enroll': {
      const [serverUrl, token] = rest;
      if (!serverUrl || !token) throw new Error('usage: enroll <serverUrl> <token> [--name NAME] [--fingerprint SHA256]');
      const s = await k.call('fleet.enroll', { serverUrl, token, deviceName: name, ...(fingerprint ? { fingerprint } : {}) }, user);
      console.log(JSON.stringify(s, null, 2));
      break;
    }
    case 'backup': {
      const info = await k.call('backup.create', { passphrase: rest[0], label }, user);
      console.log(JSON.stringify(info, null, 2));
      await k.stop();
      return;
    }
    case 'restore': {
      const [file, passphrase] = rest;
      await k.call('backup.restore', { file, passphrase, mode: clone ? 'clone' : 'migrate' }, user);
      console.log('Restore staged. It will be applied the next time FBRX OS starts.');
      await k.stop();
      return;
    }
    case 'status':
      console.log(JSON.stringify(await k.call('system.status', {}, user), null, 2));
      await k.stop();
      return;
    case 'token':
      console.log((k.localApi.info(true).token ?? '(vault locked)'));
      await k.stop();
      return;
    default:
      throw new Error(`Unknown command ${command}`);
  }
  const info = k.localApi.info(false);
  console.log(`FBRX OS headless core running. Data: ${dataDir}. Local API: ${info.running ? info.url : 'disabled'}`);
  const shutdown = async () => {
    console.log('Shutting down…');
    await kernel?.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await kernel?.stop().catch(() => undefined);
  process.exit(1);
});
