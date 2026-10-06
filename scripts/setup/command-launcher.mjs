#!/usr/bin/env node
/**
 * FBRX Command launcher, installed next to FBRX Command by "Install FBRX Command" and run with the Node.js copied
 * beside it. Dependency-free.
 *
 *   node launcher.mjs open      start FBRX Command if needed, then open it in the browser (the Start menu / app icon)
 *   node launcher.mjs start     start it in the background if it is not running (at login)
 *   node launcher.mjs serve     run it in this process (what start runs; also the macOS login item)
 *   node launcher.mjs stop      stop it
 *   node launcher.mjs status    print where it is and whether it answers
 *
 * Settings live in config.json in FBRX Command's home folder (install.json next to this file says where); the data
 * (database, keys, certificate, uploads) is in data/ there and is never touched by updates.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = dirname(fileURLToPath(import.meta.url));
const install = JSON.parse(readFileSync(join(APP, 'install.json'), 'utf8'));
const HOME = install.home;
const config = JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8'));
const LOGS = join(HOME, 'logs');
const PID = join(HOME, 'command.pid');
const AGENT = 'com.fbrx.command';
mkdirSync(LOGS, { recursive: true });

/** Where the console opens on this computer: plain HTTP on 127.0.0.1, no certificate warning. */
const localUrl = () => `http://127.0.0.1:${config.mode === 'network' ? config.localPort : config.port}`;

const log = (msg) => {
  try {
    writeFileSync(join(LOGS, 'launcher.log'), `${new Date().toISOString()} ${msg}\n`, { flag: 'a' });
  } catch {
    /* read-only */
  }
};

function get(path, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = httpGet(`${localUrl()}${path}`, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body: null });
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

const answering = async () => (await get('/healthz'))?.status === 200;

async function waitUntil(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function serverEnv() {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    FBRX_CP_DATA_DIR: join(HOME, 'data'),
    FBRX_ADMIN_CONSOLE_DIR: join(APP, 'admin-console'),
    FBRX_CP_PORT: String(config.port),
    FBRX_CP_HOST: config.mode === 'network' ? '0.0.0.0' : '127.0.0.1',
    FBRX_CP_PUBLIC_URL: config.publicUrl,
    FBRX_CP_LOG_LEVEL: config.logLevel ?? 'info',
  };
  if (config.setupToken) env.FBRX_CP_SETUP_TOKEN = config.setupToken;
  if (config.mode === 'network') {
    env.FBRX_CP_TLS = 'self-signed';
    env.FBRX_CP_TLS_NAMES = (config.names ?? []).join(',');
    env.FBRX_CP_LOCAL_PORT = String(config.localPort);
  }
  return env;
}

/** Runs FBRX Command in this process. */
async function serve() {
  Object.assign(process.env, serverEnv());
  process.chdir(APP);
  writeFileSync(PID, String(process.pid));
  const clear = () => {
    try {
      if (readFileSync(PID, 'utf8').trim() === String(process.pid)) rmSync(PID, { force: true });
    } catch {
      /* gone */
    }
  };
  process.on('exit', clear);
  log(`serving (pid ${process.pid})`);
  await import(pathToFileURL(join(APP, 'server.mjs')).href);
}

const macAgent = () => join(process.env.HOME ?? '', 'Library', 'LaunchAgents', `${AGENT}.plist`);

/** Starts FBRX Command in the background unless it already answers. */
async function start() {
  if (await answering()) return true;
  if (process.platform === 'darwin' && existsSync(macAgent())) {
    // The login item keeps it running; ask launchd to (re)start it.
    const uid = process.getuid();
    if (spawnSync('launchctl', ['kickstart', `gui/${uid}/${AGENT}`]).status !== 0) spawnSync('launchctl', ['bootstrap', `gui/${uid}`, macAgent()]);
    if (await waitUntil(answering, 15_000)) return true;
    log('the login item did not start it; starting it directly');
  }
  const out = openSync(join(LOGS, 'command.log'), 'a');
  const child = spawn(process.execPath, [join(APP, 'launcher.mjs'), 'serve'], { detached: true, stdio: ['ignore', out, out], windowsHide: true, cwd: APP });
  child.unref();
  const ok = await waitUntil(answering, 45_000);
  log(ok ? 'started' : 'did not answer within 45 s (see command.log)');
  return ok;
}

async function stop() {
  if (process.platform === 'darwin' && existsSync(macAgent())) spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${AGENT}`]);
  let pid = null;
  try {
    pid = Number(readFileSync(PID, 'utf8').trim());
  } catch {
    /* not running from here */
  }
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  const stopped = await waitUntil(async () => !(await answering()), 15_000);
  if (!stopped && pid) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  rmSync(PID, { force: true });
  return true;
}

function openBrowser(url) {
  if (process.platform === 'win32') spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref();
  else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
}

async function open() {
  if (!(await start())) {
    log('could not open: FBRX Command did not start');
    return false;
  }
  const setup = await get('/v1/setup/status');
  // First run: the setup page fills in the one-time setup token by itself.
  const url = setup?.body?.needsSetup && config.setupToken ? `${localUrl()}/#setup-token=${encodeURIComponent(config.setupToken)}` : `${localUrl()}/`;
  openBrowser(url);
  return true;
}

async function status() {
  const health = await get('/healthz');
  const setup = await get('/v1/setup/status');
  return { running: health?.status === 200, version: health?.body?.version ?? null, needsSetup: setup?.body?.needsSetup ?? null, local: localUrl(), network: config.mode === 'network' ? config.publicUrl : null, home: HOME };
}

const action = process.argv[2] ?? 'open';
try {
  if (action === 'serve') await serve();
  else if (action === 'start') process.exitCode = (await start()) ? 0 : 1;
  else if (action === 'stop') process.exitCode = (await stop()) ? 0 : 1;
  else if (action === 'status') console.log(JSON.stringify(await status(), null, 2));
  else process.exitCode = (await open()) ? 0 : 1;
} catch (err) {
  log(`${action} failed: ${err?.stack ?? err}`);
  console.error(err?.message ?? err);
  process.exitCode = 1;
}
