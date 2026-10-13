#!/usr/bin/env node
/**
 * FBRX OS setup wizard: turns the downloaded source folder into an installed, licensed app on this computer, with its
 * AI ready. Start it by double-clicking "Install FBRX OS.command" (macOS) or "Install FBRX OS.cmd" (Windows); those
 * launchers fetch a private copy of Node.js first when needed. Running it again updates the app and keeps all data.
 *
 *   node scripts/setup/wizard.mjs [--name "Your Name"] [--no-launch] [--no-ai] [--allow-downgrade]
 *   node scripts/setup/wizard.mjs --share [--for "Their Name"] [--days 30] [--yes]        (Windows)
 *
 * There is nothing to answer: the license goes to --name (or this computer's user). Steps: download what the app is
 * made of → build it for this machine (license signing keys, the FBRX Server installer and guides, the built-in AI
 * runtime, the app) → get the AI ready → install and license it → open it. On a computer without FBRX OS the starter
 * model (Qwen2.5 1.5B Instruct, about 1 GB) downloads into the app's models folder meanwhile, so the first thing the app
 * does is answer; --no-ai leaves that to the app. Dependency-free on purpose: it runs before `npm install`.
 *
 * The FBRX Server resources (installer ISO, server bundle, guides) ride along inside the app for now; the ISO is taken
 * from the "fbrx-server-iso" download in Downloads when there is one. --no-server leaves them out.
 *
 * Share mode builds the same Windows installer without installing it here, optionally with a trial license for the
 * recipient built in, and puts it in the Share folder. The recipient double-clicks it (no terminal, no build); on a
 * computer that already has FBRX OS it offers Upgrade / Repair / Uninstall and closes the running app itself
 * (build/installer.nsh). Their FBRX OS downloads its AI when it first opens.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, appendFileSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { downloadStarterModel, STARTER_MODEL, starterModelFile } from './starter-model.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = join(ROOT, 'apps', 'desktop');
const STATE = join(ROOT, '.fbrx-setup');
const LOG = join(STATE, 'setup.log');
const PRODUCT = 'FBRX OS';
const LICENSE_FILE = 'fbrx-license.key';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => {
  const i = argv.indexOf(n);
  return i === -1 ? undefined : argv[i + 1];
};
const yes = flag('--yes') || flag('-y') || !process.stdin.isTTY;
const launch = !flag('--no-launch');
const noAi = flag('--no-ai') || !!process.env.FBRX_NO_AI;
const allowDowngrade = flag('--allow-downgrade');

// ------------------------------------------------------------------------------------------------ output
const win = process.platform === 'win32';
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = paint('1');
const dim = paint('2');
const green = paint('32');
const red = paint('31');
const yellow = paint('33');
const cyan = paint('36');
const OK = win ? green('[OK]') : green('✔');
const FAIL = win ? red('[X]') : red('✖');
const FRAMES = win ? ['|', '/', '-', '\\'] : ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

mkdirSync(STATE, { recursive: true });
const log = (s) => appendFileSync(LOG, s.endsWith('\n') ? s : `${s}\n`);
log(`\n===== ${new Date().toISOString()} setup started (${process.platform}-${process.arch}, node ${process.version}) =====`);

const elapsed = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

class SetupError extends Error {
  constructor(message, hint, code) {
    super(message);
    this.hint = hint;
    this.code = code;
  }
}

let stepNo = 0;
let STEPS = 5;
async function step(title, fn) {
  stepNo++;
  const label = `${dim(`[${stepNo}/${STEPS}]`)} ${title}`;
  const started = Date.now();
  let frame = 0;
  let detail = '';
  // Redraw in place. The line must fit the window (Terminal opens 80 columns wide), or each redraw wraps and
  // leaves a trail of half-lines behind.
  const draw = () => {
    if (!process.stdout.isTTY) return;
    const width = (process.stdout.columns || 80) - 1;
    const prefix = `X [${stepNo}/${STEPS}] `;
    const time = ` ${elapsed(started)}`;
    let text = title;
    let extra = detail ? `  ${detail}` : '';
    if (prefix.length + text.length + time.length + extra.length > width) extra = '';
    if (prefix.length + text.length + time.length > width) text = `${text.slice(0, Math.max(0, width - prefix.length - time.length - 1))}…`;
    process.stdout.write(`\r\x1b[2K${cyan(FRAMES[frame++ % FRAMES.length])} ${dim(`[${stepNo}/${STEPS}]`)} ${text}${dim(`${time}${extra}`)}`);
  };
  const timer = process.stdout.isTTY ? setInterval(draw, 120) : null;
  if (!process.stdout.isTTY) console.log(`... ${title}`);
  log(`--- step ${stepNo}: ${title}`);
  try {
    const result = await fn({ setDetail: (d) => (detail = d) });
    if (timer) clearInterval(timer);
    process.stdout.write(process.stdout.isTTY ? `\r\x1b[2K${OK} ${label} ${dim(elapsed(started))}${result?.note ? `  ${dim(result.note)}` : ''}\n` : `${OK} ${title}${result?.note ? `  (${result.note})` : ''}\n`);
    return result;
  } catch (err) {
    if (timer) clearInterval(timer);
    process.stdout.write(process.stdout.isTTY ? `\r\x1b[2K${FAIL} ${label}\n` : `${FAIL} ${title}\n`);
    throw err;
  }
}

// ------------------------------------------------------------------------------------------------ processes
const nodeDir = dirname(process.execPath);
const childEnv = {
  ...process.env,
  // The Node.js running this wizard (possibly a private copy) must also run every build script.
  PATH: `${nodeDir}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}`,
  npm_config_update_notifier: 'false',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
};
if (win) childEnv.Path = childEnv.PATH;

function npmCli() {
  const candidates = [join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/** Runs a command, streaming its output to the log file. Resolves with captured stdout. */
function run(cmd, args, { cwd = ROOT, env = childEnv, onLine, label } = {}) {
  log(`$ ${cmd} ${args.join(' ')}`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    const tail = [];
    const onData = (buf) => {
      const text = buf.toString();
      log(text);
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 25) tail.shift();
        onLine?.(line);
      }
    };
    child.stdout.on('data', (b) => {
      out += b.toString();
      onData(b);
    });
    child.stderr.on('data', onData);
    child.on('error', (err) => reject(new SetupError(`Could not start ${cmd}: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolvePromise(out);
      else reject(new SetupError(`${label ?? basename(cmd)} failed (exit code ${code})`, tail.join('\n'), code));
    });
  });
}

const node = (args, o) => run(process.execPath, args, o);
function npm(args, o) {
  const cli = npmCli();
  const opts = { label: `npm ${args[0]}`, ...o };
  if (cli) return node([cli, ...args], opts);
  return run(win ? 'npm.cmd' : 'npm', args, opts);
}

// ------------------------------------------------------------------------------------------------ platform
const version = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8')).version;
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const platformName = { darwin: 'Mac', win32: 'Windows PC', linux: 'Linux computer' }[process.platform];

function dataRoot() {
  if (process.env.FBRX_HOME) return resolve(process.env.FBRX_HOME);
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', PRODUCT);
  if (win) return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), PRODUCT);
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), PRODUCT);
}

function freeGb(path) {
  try {
    const s = statfsSync(path);
    return (Number(s.bavail) * Number(s.bsize)) / 1024 ** 3;
  } catch {
    return Infinity;
  }
}

function writable(dir) {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function isRunning() {
  if (process.platform === 'darwin') return spawnSync('pgrep', ['-x', PRODUCT]).status === 0;
  if (win) return (spawnSync('tasklist', ['/FI', `IMAGENAME eq ${PRODUCT}.exe`, '/NH'], { encoding: 'utf8' }).stdout ?? '').includes(`${PRODUCT}.exe`);
  return spawnSync('pgrep', ['-f', 'linux-unpacked/fbrx-os']).status === 0;
}

async function quitRunningApp() {
  if (!isRunning()) return false;
  if (process.platform === 'darwin') spawnSync('osascript', ['-e', `if application "${PRODUCT}" is running then tell application "${PRODUCT}" to quit`]);
  else if (win) spawnSync('taskkill', ['/IM', `${PRODUCT}.exe`]);
  else spawnSync('pkill', ['-f', 'linux-unpacked/fbrx-os']);
  for (let i = 0; i < 40 && isRunning(); i++) await new Promise((r) => setTimeout(r, 250));
  if (isRunning()) {
    if (process.platform === 'darwin') spawnSync('pkill', ['-x', PRODUCT]);
    else if (win) spawnSync('taskkill', ['/F', '/IM', `${PRODUCT}.exe`]);
    else spawnSync('pkill', ['-9', '-f', 'linux-unpacked/fbrx-os']);
    for (let i = 0; i < 20 && isRunning(); i++) await new Promise((r) => setTimeout(r, 250));
  }
  return true;
}

// ------------------------------------------------------------------------------------------------ steps
async function installDependencies(ui) {
  const lock = join(ROOT, 'package-lock.json');
  const marker = join(STATE, 'dependencies.sha256');
  const digest = createHash('sha256').update(readFileSync(lock)).update(process.version).digest('hex');
  if (existsSync(join(ROOT, 'node_modules', '.package-lock.json')) && existsSync(marker) && readFileSync(marker, 'utf8') === digest) {
    return { note: 'already up to date' };
  }
  let packages = 0;
  await npm(['ci', '--no-audit', '--no-fund', '--loglevel=http'], {
    onLine: (l) => {
      if (/GET 200|fetch GET/.test(l)) ui.setDetail(`${++packages} downloads`);
      else if (/electron/i.test(l) && /postinstall|install/i.test(l)) ui.setDetail('downloading Electron');
    },
  });
  writeFileSync(marker, digest);
}

// The signing key also lives in ~/.fbrx-keys so a fresh download of the folder keeps signing with the same key
// (licenses you already issued keep working with new builds).
const KEY_BACKUP = join(homedir(), '.fbrx-keys', 'license-signing.pem');

async function createKeys() {
  const priv = join(ROOT, '.fbrx-keys', 'license-signing.pem');
  let note = 'using your existing keys';
  if (!existsSync(priv) && existsSync(KEY_BACKUP)) {
    mkdirSync(dirname(priv), { recursive: true, mode: 0o700 });
    copyFileSync(KEY_BACKUP, priv);
    note = 'restored your keys from ~/.fbrx-keys';
  }
  if (existsSync(priv)) {
    // Re-export the public half so the build embeds the key that matches your existing licenses.
    await node([join(ROOT, 'scripts', 'generate-license-keys.mjs'), '--from', priv], { label: 'Exporting your public key' });
  } else {
    await node([join(ROOT, 'scripts', 'generate-license-keys.mjs')], { label: 'Generating keys' });
    note = 'saved in .fbrx-keys';
  }
  if (!existsSync(KEY_BACKUP)) {
    mkdirSync(dirname(KEY_BACKUP), { recursive: true, mode: 0o700 });
    copyFileSync(priv, KEY_BACKUP);
    try {
      chmodSync(KEY_BACKUP, 0o600);
    } catch {
      /* windows */
    }
  }
  return { note };
}

/**
 * The FBRX Server installer ISO, server bundle and guides travel inside FBRX Endpoint for now. The ISO comes from the
 * "fbrx-server-iso" download (GitHub Actions) in Downloads, if there is one. Never stops the setup: without it the app
 * is simply built without them.
 */
async function gatherServerResources(ui) {
  if (flag('--no-server')) return { note: 'skipped (--no-server)' };
  let iso = false;
  try {
    await node([join(ROOT, 'scripts', 'server', 'endpoint-resources.mjs')], {
      label: 'Gathering the FBRX Server resources',
      onLine: (l) => {
        if (/Building the FBRX Server bundle/.test(l)) ui.setDetail('building the server bundle');
        else if (/^Adding fbrx-server/.test(l)) {
          iso = true;
          ui.setDetail('adding the installer ISO');
        }
      },
    });
  } catch (err) {
    log(`FBRX Server resources skipped: ${err.message}`);
    return { note: 'skipped (see .fbrx-setup/setup.log); the app works without them' };
  }
  return { note: iso ? 'with the installer ISO' : 'bundle and guides (no ISO in Downloads)' };
}

// ------------------------------------------------------------------------------------------------ the AI
const mb = (n) => `${Math.round(n / 1024 ** 2)} MB`;

function findFile(dir, names, depth = 4) {
  if (!existsSync(dir)) return null;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && names.includes(e.name)) return join(dir, e.name);
    if (e.isDirectory() && depth > 0) {
      const hit = findFile(join(dir, e.name), names, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * The built-in AI runtime (llama.cpp's llama-server) goes inside the app, so the AI starts without another download.
 * Never stops the setup: without it the app downloads the runtime itself.
 */
async function fetchRuntime(ui) {
  const dir = join(DESKTOP, 'resources', 'runtime', `${process.platform}-${arch}`);
  if (findFile(dir, ['llama-server', 'llama-server.exe'])) return true;
  try {
    ui.setDetail('the AI runtime');
    await node(['--import', 'tsx', join(ROOT, 'scripts', 'fetch-llama-runtime.ts'), '--platform', process.platform, '--arch', arch], { label: 'Downloading the AI runtime' });
    return true;
  } catch (err) {
    log(`AI runtime not bundled: ${err.message}`);
    rmSync(dir, { recursive: true, force: true });
    return false;
  }
}

/**
 * Downloads the starter model into the app's models folder while the rest of the setup runs. Only on a computer
 * without FBRX OS data (an update leaves the AI as it is) and not with --no-ai. Never stops the setup: without it the
 * app downloads the model when it first opens.
 */
function startAiDownload() {
  const ai = { state: 'off', got: 0, total: STARTER_MODEL.sizeBytes, error: null, done: Promise.resolve() };
  if (noAi) return { ...ai, note: 'skipped (--no-ai): FBRX OS gets it when it opens' };
  const data = dataRoot();
  if (existsSync(join(data, 'fbrx.db'))) return { ...ai, note: 'kept as it is' };
  const models = join(data, 'models');
  if (existsSync(starterModelFile(models))) return { ...ai, state: 'done', note: `${STARTER_MODEL.name}, downloaded earlier` };
  if (freeGb(existsSync(data) ? data : homedir()) < 2) return { ...ai, note: 'not enough free space; FBRX OS asks when it opens' };
  ai.state = 'downloading';
  ai.done = downloadStarterModel(models, ai, { log }).then(
    (file) => {
      ai.state = 'done';
      log(`starter model downloaded: ${file}`);
    },
    (err) => {
      ai.state = 'failed';
      ai.error = err.message;
    },
  );
  return ai;
}

async function waitForAi(ai, ui) {
  if (ai.note) return { note: ai.note };
  const timer = setInterval(() => ui.setDetail(`${mb(ai.got)} of ${mb(ai.total)}`), 500);
  try {
    await ai.done;
  } finally {
    clearInterval(timer);
  }
  if (ai.state === 'done') return { note: `${STARTER_MODEL.name} (${mb(ai.total)}), runs on this computer` };
  return { note: `not downloaded (${ai.error}); FBRX OS gets it when it opens` };
}

async function buildApp(ui) {
  const target = process.platform === 'darwin' ? ['--mac', 'dir'] : win ? ['--win', 'nsis'] : ['--linux', 'dir'];
  await node([join(DESKTOP, 'scripts', 'package.mjs'), ...target, `--${arch}`], {
    cwd: DESKTOP,
    label: 'The build',
    onLine: (l) => {
      if (/vite|transforming|rendering chunks/i.test(l)) ui.setDetail('compiling the interface');
      else if (/downloading/i.test(l)) ui.setDetail('downloading Electron');
      else if (/packaging/i.test(l)) ui.setDetail('packaging');
      else if (/signing/i.test(l)) ui.setDetail('signing');
      else if (/building\s+target=nsis|nsis/i.test(l)) ui.setDetail('creating the installer');
    },
  });
  const out = join(DESKTOP, 'release', version);
  if (process.platform === 'darwin') {
    const dir = readdirSync(out).find((d) => d.startsWith('mac') && existsSync(join(out, d, `${PRODUCT}.app`)));
    if (!dir) throw new SetupError(`The build finished but ${PRODUCT}.app was not found in ${out}`);
    return { artifact: join(out, dir, `${PRODUCT}.app`) };
  }
  if (win) {
    const exe = join(out, `FBRX-OS-Setup-${version}.exe`);
    if (!existsSync(exe)) throw new SetupError(`The build finished but the installer was not found at ${exe}`);
    return { artifact: exe };
  }
  const bin = join(out, arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked', 'fbrx-os');
  if (!existsSync(bin)) throw new SetupError(`The build finished but ${bin} was not found`);
  return { artifact: bin };
}

async function installApp(artifact) {
  // On Windows the installer closes a running copy itself, asking it to quit properly first.
  const wasRunning = win ? false : await quitRunningApp();
  if (process.platform === 'darwin') {
    const dest = writable('/Applications') ? '/Applications' : join(homedir(), 'Applications');
    mkdirSync(dest, { recursive: true });
    const target = join(dest, `${PRODUCT}.app`);
    rmSync(target, { recursive: true, force: true });
    await run('ditto', [artifact, target], { label: 'Copying the app' });
    return { path: target, note: target, wasRunning };
  }
  if (win) {
    // Silent mode upgrades or reinstalls over an existing copy and closes it first (build/installer.nsh).
    try {
      await run(artifact, allowDowngrade ? ['/S', '/ALLOWDOWNGRADE'] : ['/S'], { label: 'The installer' });
    } catch (err) {
      if (err.code === 3) {
        throw new SetupError(
          `A newer version of ${PRODUCT} is already installed on this PC than the ${version} in this folder.`,
          'Download the latest FBRX folder, or run the installer with --allow-downgrade to replace it with this older version.',
        );
      }
      throw err;
    }
    const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    const exe = [join(local, 'Programs', PRODUCT, `${PRODUCT}.exe`), join(local, 'Programs', 'fbrx-os', `${PRODUCT}.exe`)].find((p) => existsSync(p));
    if (!exe) throw new SetupError('The installer finished but FBRX OS could not be found under %LOCALAPPDATA%\\Programs', 'Try running apps\\desktop\\release\\' + version + '\\FBRX-OS-Setup-' + version + '.exe yourself.');
    return { path: exe, note: dirname(exe), wasRunning };
  }
  return { path: artifact, note: 'runs from the build folder on Linux', wasRunning };
}

/**
 * Tells the app which folder it was installed from, so it can offer to update itself from a newer download, and with
 * --no-ai that it should not get the starter AI by itself either.
 */
function rememberSource() {
  try {
    const dir = dataRoot();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'install-source.json'), JSON.stringify({ root: ROOT, version, installedAt: new Date().toISOString(), ...(noAi ? { starterAi: false } : {}) }, null, 2));
  } catch (err) {
    log(`could not record the install folder: ${err.message}`);
  }
}

/** Signs an Enterprise license key with your signing key. `expires` is YYYY-MM-DD or undefined (no expiry). */
async function issueKey(customer, expires) {
  const args = ['--import', 'tsx', join(ROOT, 'scripts', 'issue-license.ts'), '--customer', customer, '--edition', 'enterprise'];
  if (expires) args.push('--expires', expires);
  const out = await node(args, { label: 'Issuing the license' });
  const key = out.split(/\r?\n/).find((l) => l.startsWith('FBRX1.'));
  if (!key) throw new SetupError('The license key could not be created');
  return key.trim();
}

async function issueLicense(name) {
  const key = await issueKey(name);
  const dir = dataRoot();
  mkdirSync(dir, { recursive: true });
  // FBRX OS activates this file the next time it starts and then deletes it.
  writeFileSync(join(dir, LICENSE_FILE), `${key}\n`, { mode: 0o600 });
  writeFileSync(join(ROOT, '.fbrx-keys', 'my-license.txt'), `${key}\n`, { mode: 0o600 });
  return { note: `Enterprise · ${name}` };
}

const SHARE = join(ROOT, 'Share');
const expiryDate = (days) => (days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10) : undefined);

/**
 * Puts a Windows installer for someone else in the Share folder. With a recipient, a trial license for them is built
 * into the installer (FBRX_SHARE_LICENSE, read by build/installer.nsh), so they do not have to enter a key.
 */
async function makeSharePackage(installer, recipient, days, ui) {
  mkdirSync(SHARE, { recursive: true });
  const slug = recipient
    ? recipient
        .normalize('NFKD')
        .replace(/[^\w-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'guest'
    : '';
  const name = `FBRX-OS-Setup-${version}${slug ? `-for-${slug}` : ''}.exe`;
  const target = join(SHARE, name);
  let expires;
  if (!recipient) {
    copyFileSync(installer, target);
  } else {
    expires = expiryDate(days);
    const key = await issueKey(recipient, expires);
    const tmp = mkdtempSync(join(tmpdir(), 'fbrx-share-'));
    const keyFile = join(tmp, 'license.key');
    writeFileSync(keyFile, key, { mode: 0o600 });
    const outDir = join('release', `share-${version}`);
    try {
      ui.setDetail('adding the license to the installer');
      // Rebuild only the installer around the app that was just packaged.
      const unpacked = join(DESKTOP, 'release', version, arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked');
      const builder = join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
      await node(
        [builder, '--config', 'electron-builder.yml', '--publish', 'never', '--win', 'nsis', `--${arch}`, '--prepackaged', unpacked, `-c.nsis.artifactName=${name}`, `-c.directories.output=${outDir}`],
        { cwd: DESKTOP, env: { ...childEnv, FBRX_SHARE_LICENSE: keyFile }, label: 'Building the installer' },
      );
      copyFileSync(join(DESKTOP, outDir, name), target);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(join(DESKTOP, outDir), { recursive: true, force: true });
    }
  }
  writeFileSync(
    join(SHARE, 'How to install FBRX OS.txt'),
    [
      'Installing or updating FBRX OS on Windows',
      '',
      '1. Double-click the FBRX-OS-Setup file.',
      '2. If Windows says "Windows protected your PC", click "More info", then "Run anyway".',
      '   (The installer is not signed with a purchased code-signing certificate.)',
      '3. New install: follow the steps. Already installed: choose Upgrade (keeps all your data),',
      '   Repair (reinstall if something is wrong) or Uninstall. If FBRX OS is open, Setup closes it for you.',
      '',
      'A license is built in when the file name ends in "-for-<your name>"; FBRX OS activates it on its first start.',
      'To remove FBRX OS later: Windows Settings > Apps > FBRX OS > Uninstall, or run the Setup file again.',
      '',
    ].join('\r\n'),
  );
  return { path: target, expires, note: `Share${win ? '\\' : '/'}${name}` };
}

function openApp(path) {
  if (process.platform === 'darwin') return spawnSync('open', [path]).status === 0;
  const args = !win && process.getuid?.() === 0 ? ['--no-sandbox'] : [];
  const child = spawn(path, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => undefined);
  child.unref();
  return true;
}

// ------------------------------------------------------------------------------------------------ main
/** Everything the app is built from, made into the app for this computer (one step on screen). */
async function buildAll(ui) {
  ui.setDetail('license signing keys');
  await createKeys();
  ui.setDetail('FBRX Server installer and guides');
  await gatherServerResources(ui);
  const runtime = await fetchRuntime(ui);
  ui.setDetail('');
  const { artifact } = await buildApp(ui);
  return { artifact, note: runtime ? 'with the AI runtime built in' : 'the AI runtime downloads when FBRX OS opens' };
}

/** The name on the license: --name, FBRX_LICENSE_NAME, or this computer's user (their full name on a Mac). */
function licenseName() {
  const given = (opt('--name') ?? process.env.FBRX_LICENSE_NAME ?? '').trim();
  if (given) return given;
  if (process.platform === 'darwin') {
    const full = (spawnSync('id', ['-F'], { encoding: 'utf8' }).stdout ?? '').trim();
    if (full) return full;
  }
  try {
    return userInfo().username || 'FBRX Owner';
  } catch {
    return 'FBRX Owner';
  }
}

async function main() {
  console.log(`\n${bold(`${PRODUCT} setup`)}  ${dim(`· Fabrics Operating System ${version}`)}\n`);
  if (!['darwin', 'win32', 'linux'].includes(process.platform)) throw new SetupError(`${process.platform} is not supported.`);
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 15)) throw new SetupError(`Node.js ${process.version} is too old; 22.15 or newer is needed.`, 'Start the setup with the "Install FBRX OS" launcher, which downloads a suitable Node.js automatically.');
  if (!existsSync(join(ROOT, 'package-lock.json')) || !existsSync(DESKTOP)) throw new SetupError('This does not look like the FBRX OS folder.', 'Keep the installer inside the downloaded FBRX folder and run it from there.');

  const share = flag('--share');
  if (share && !win) throw new SetupError('Making an installer to send is available on Windows for now.', 'Run this from the FBRX folder on a Windows PC.');

  if (share) {
    console.log(`This builds a ${PRODUCT} installer for someone else, without installing anything on this PC. It takes`);
    console.log(`about 10 minutes the first time. The installer upgrades, repairs or removes an existing copy on their PC.\n`);
  } else {
    console.log(`There is nothing to answer. Setup installs ${PRODUCT} on this ${platformName}, gets its AI ready and opens it,`);
    console.log(`so the first thing you see is a chat with your own AI. The first time takes about 15–20 minutes and`);
    console.log(`downloads about 2 GB. Leave this window open; you can use the computer meanwhile.\n`);
  }
  const free = freeGb(ROOT);
  if (free < 4) console.log(`${yellow('!')} Only ${free.toFixed(1)} GB free here; about 4 GB is needed while building.\n`);
  if (/onedrive|icloud|dropbox|google drive/i.test(ROOT)) {
    console.log(`${yellow('!')} This folder is inside a synced folder (${ROOT}).`);
    console.log(`  Syncing thousands of build files is slow and can break the build. Moving the folder somewhere`);
    console.log(`  unsynced first (for example ${win ? 'C:\\FBRX' : '~/FBRX'}) is recommended.\n`);
  } else if (win && ROOT.length > 80) {
    console.log(`${yellow('!')} This folder path is long; if the build fails, move the folder to C:\\FBRX and run the installer again.\n`);
  }

  if (share) {
    const rl = yes ? null : createInterface({ input: process.stdin, output: process.stdout });
    return shareMain(rl, async (q) => (await rl.question(q)).trim());
  }

  const name = licenseName();
  const started = Date.now();
  // The AI downloads while everything else happens.
  const ai = startAiDownload();
  await step(`Downloading what ${PRODUCT} is made of`, installDependencies);
  const { artifact } = await step(`Building ${PRODUCT} for this ${platformName}`, buildAll);
  await step('Getting your AI ready', (ui) => waitForAi(ai, ui));
  const installed = await step(`Installing ${PRODUCT}`, async () => {
    const r = await installApp(artifact);
    rememberSource();
    await issueLicense(name);
    return r;
  });
  await step(launch ? `Opening ${PRODUCT}` : `Ready to open`, async () => {
    if (!launch) return { note: 'skipped (--no-launch)' };
    return openApp(installed.path) ? undefined : { note: 'open it from your Applications / Start menu' };
  });

  const where = process.platform === 'darwin' ? 'Applications folder and Launchpad' : win ? 'Start menu and on your desktop' : installed.path;
  console.log(`\n${green(bold(`${PRODUCT} is ready`))} ${dim(`in ${elapsed(started)}`)}\n`);
  console.log(`  ${bold('Find it')}        in your ${where}`);
  console.log(`  ${bold('Your AI')}        ${ai.state === 'done' ? `${STARTER_MODEL.name}, on this ${platformName}: say hello in the chat` : 'FBRX OS shows its progress in the chat'}`);
  console.log(`  ${bold('Update later')}   download the new FBRX folder and run this installer again; your data stays`);
  console.log(`\n  ${dim(`Licensed to ${name}. Your license signing key is in ${dirname(KEY_BACKUP)}: keep a copy somewhere safe.`)}`);
  console.log(`  ${dim('You can close this window.')}\n`);
  return 0;
}

async function shareMain(rl, ask) {
  let recipient = (opt('--for') ?? '').trim();
  let days = Number(opt('--days') ?? 30);
  if (rl) {
    console.log(`${bold('Who is it for?')} Their name goes on a trial license built into the installer.`);
    recipient = await ask(`${dim('Leave blank for no license, for example to send an update to someone already set up')}: `);
    if (recipient) {
      const d = await ask(`${bold('Trial length in days')} ${dim('(0 = no expiry)')} [30]: `);
      days = d ? Number(d) : 30;
    }
    const go = (await ask(`${bold('Ready to build?')} [Y/n]: `)).toLowerCase();
    rl.close();
    if (go.startsWith('n')) {
      console.log('\nNothing was changed.');
      return 0;
    }
    console.log('');
  }
  if (recipient.length > 80) throw new SetupError('The name is too long (80 characters at most).');
  if (!Number.isInteger(days) || days < 0 || days > 3650) throw new SetupError('The trial length must be a whole number of days between 0 and 3650.');

  STEPS = 5;
  const started = Date.now();
  await step('Installing dependencies', installDependencies);
  await step('Creating your license signing keys', createKeys);
  await step('Adding the FBRX Server installer and guides', gatherServerResources);
  const { artifact } = await step(`Building ${PRODUCT} for Windows`, buildApp);
  const pkg = await step(recipient ? `Making the installer for ${recipient}` : 'Making the installer', (ui) => makeSharePackage(artifact, recipient, days, ui));

  const mb = Math.round(statSync(pkg.path).size / 1024 ** 2);
  console.log(`\n${green(bold('The installer is ready'))} ${dim(`in ${elapsed(started)}`)}\n`);
  console.log(`  ${bold('File')}           ${pkg.path} ${dim(`(${mb} MB)`)}`);
  if (recipient) {
    console.log(`  ${bold('License')}        Enterprise trial for ${recipient}, ${pkg.expires ? `until ${pkg.expires}` : 'no expiry'} (built in; activates on first start;`);
    console.log(`                 afterwards ${PRODUCT} keeps working with the free Community features)`);
  } else {
    console.log(`  ${bold('License')}        none built in: their existing license is kept; a new user can paste a key in Settings`);
  }
  console.log(`  ${bold('Send it')}        with OneDrive, Google Drive, WeTransfer or a USB stick (too big for most e-mail)`);
  console.log(`  ${bold('On their PC')}    they double-click it. If ${PRODUCT} is already installed it offers Upgrade, Repair or`);
  console.log(`                 Uninstall and closes the app for them; their data is kept`);
  console.log(`  ${bold('Windows warning')} "Windows protected your PC" appears for installers without a purchased signing`);
  console.log(`                 certificate: More info > Run anyway (see Share\\How to install FBRX OS.txt)\n`);
  if (process.stdout.isTTY) {
    const child = spawn('explorer.exe', [`/select,"${pkg.path}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
    child.on('error', () => undefined);
    child.unref();
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log(`FAILED: ${err.stack ?? err}`);
    console.log(`\n${red(bold('Setup did not finish.'))} ${err.message}`);
    if (err.hint) console.log(`\n${dim(err.hint.split('\n').map((l) => `  ${l}`).join('\n'))}`);
    console.log(`\nFull log: ${LOG}`);
    console.log('Fix the problem above (often a dropped internet connection) and run the installer again; anything already downloaded is reused.\n');
    process.exit(1);
  });
