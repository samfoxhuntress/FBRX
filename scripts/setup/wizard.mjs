#!/usr/bin/env node
/**
 * FBRX OS setup wizard: turns the downloaded source folder into an installed, licensed app on this computer.
 * Start it by double-clicking "Install FBRX OS.command" (macOS) or "Install FBRX OS.cmd" (Windows); those launchers
 * fetch a private copy of Node.js first when needed. Running it again updates the app and keeps all data.
 *
 *   node scripts/setup/wizard.mjs [--yes] [--name "Your Name"] [--no-launch]
 *
 * Steps: install dependencies → create license signing keys → build the app for this machine → install it →
 * issue a license for it → open it. Dependency-free on purpose: it runs before `npm install`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, appendFileSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

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
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

let stepNo = 0;
const STEPS = 6;
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
    process.stdout.write(process.stdout.isTTY ? `\r\x1b[2K${OK} ${label} ${dim(elapsed(started))}${result?.note ? `  ${dim(result.note)}` : ''}\n` : `${OK} ${title}\n`);
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
      else reject(new SetupError(`${label ?? basename(cmd)} failed (exit code ${code})`, tail.join('\n')));
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
  const wasRunning = await quitRunningApp();
  if (process.platform === 'darwin') {
    const dest = writable('/Applications') ? '/Applications' : join(homedir(), 'Applications');
    mkdirSync(dest, { recursive: true });
    const target = join(dest, `${PRODUCT}.app`);
    rmSync(target, { recursive: true, force: true });
    await run('ditto', [artifact, target], { label: 'Copying the app' });
    return { path: target, note: target, wasRunning };
  }
  if (win) {
    await run(artifact, ['/S'], { label: 'The installer' });
    const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    const exe = [join(local, 'Programs', PRODUCT, `${PRODUCT}.exe`), join(local, 'Programs', 'fbrx-os', `${PRODUCT}.exe`)].find((p) => existsSync(p));
    if (!exe) throw new SetupError('The installer finished but FBRX OS could not be found under %LOCALAPPDATA%\\Programs', 'Try running apps\\desktop\\release\\' + version + '\\FBRX-OS-Setup-' + version + '.exe yourself.');
    return { path: exe, note: dirname(exe), wasRunning };
  }
  return { path: artifact, note: 'runs from the build folder on Linux', wasRunning };
}

async function issueLicense(name) {
  const out = await node(['--import', 'tsx', join(ROOT, 'scripts', 'issue-license.ts'), '--customer', name, '--edition', 'enterprise'], { label: 'Issuing the license' });
  const key = out.split(/\r?\n/).find((l) => l.startsWith('FBRX1.'));
  if (!key) throw new SetupError('The license key could not be created');
  const dir = dataRoot();
  mkdirSync(dir, { recursive: true });
  // FBRX OS activates this file the next time it starts and then deletes it.
  writeFileSync(join(dir, LICENSE_FILE), `${key.trim()}\n`, { mode: 0o600 });
  writeFileSync(join(ROOT, '.fbrx-keys', 'my-license.txt'), `${key.trim()}\n`, { mode: 0o600 });
  return { note: `Enterprise · ${name}` };
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
async function main() {
  console.log(`\n${bold(`${PRODUCT} setup`)}  ${dim(`· Fabrics Operating System ${version}`)}\n`);
  if (!['darwin', 'win32', 'linux'].includes(process.platform)) throw new SetupError(`${process.platform} is not supported.`);
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 15)) throw new SetupError(`Node.js ${process.version} is too old; 22.15 or newer is needed.`, 'Start the setup with the "Install FBRX OS" launcher, which downloads a suitable Node.js automatically.');
  if (!existsSync(join(ROOT, 'package-lock.json')) || !existsSync(DESKTOP)) throw new SetupError('This does not look like the FBRX OS folder.', 'Keep the installer inside the downloaded FBRX folder and run it from there.');

  console.log(`This installs ${PRODUCT} on this ${platformName}, licensed to you. The first run takes about`);
  console.log(`10–20 minutes and downloads around 1 GB. Run it again any time to update; your data is kept.\n`);
  const free = freeGb(ROOT);
  if (free < 3) console.log(`${yellow('!')} Only ${free.toFixed(1)} GB free here; about 3 GB is needed while building.\n`);
  if (/onedrive|icloud|dropbox|google drive/i.test(ROOT)) {
    console.log(`${yellow('!')} This folder is inside a synced folder (${ROOT}).`);
    console.log(`  Syncing thousands of build files is slow and can break the build. Moving the folder somewhere`);
    console.log(`  unsynced first (for example ${win ? 'C:\\FBRX' : '~/FBRX'}) is recommended.\n`);
  } else if (win && ROOT.length > 80) {
    console.log(`${yellow('!')} This folder path is long; if the build fails, move the folder to C:\\FBRX and run the installer again.\n`);
  }

  let name = opt('--name') ?? process.env.FBRX_LICENSE_NAME;
  const fallback = (() => {
    try {
      return userInfo().username;
    } catch {
      return 'FBRX Owner';
    }
  })();
  if (!name && !yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    name = (await rl.question(`${bold('Your name or company')} ${dim('(shown on your license)')} [${fallback}]: `)).trim();
    const go = (await rl.question(`${bold('Ready to install?')} [Y/n]: `)).trim().toLowerCase();
    rl.close();
    if (go.startsWith('n')) {
      console.log('\nNothing was changed.');
      return 0;
    }
    console.log('');
  }
  name ||= fallback;

  const started = Date.now();
  await step('Installing dependencies', installDependencies);
  await step('Creating your license signing keys', createKeys);
  const { artifact } = await step(`Building ${PRODUCT} for this ${platformName}`, buildApp);
  const installed = await step(`Installing ${PRODUCT}`, () => installApp(artifact));
  await step('Licensing this computer', () => issueLicense(name));
  await step(launch ? `Opening ${PRODUCT}` : `Ready to open`, async () => {
    if (!launch) return { note: 'skipped (--no-launch)' };
    return openApp(installed.path) ? undefined : { note: 'open it from your Applications / Start menu' };
  });

  const where = process.platform === 'darwin' ? 'Applications folder and Launchpad' : win ? 'Start menu and on your desktop' : installed.path;
  console.log(`\n${green(bold(`${PRODUCT} is installed`))} ${dim(`in ${elapsed(started)}`)}\n`);
  console.log(`  ${bold('Find it')}        in your ${where}`);
  console.log(`  ${bold('License')}        Enterprise, licensed to ${name} (activates when the app opens;`);
  console.log(`                 a copy of the key is in .fbrx-keys${win ? '\\' : '/'}my-license.txt)`);
  console.log(`  ${bold('Update later')}   download the new version and run this installer again; your data stays`);
  console.log(`\n  ${yellow(bold('Back up your license signing key'))}  ${dirname(KEY_BACKUP)}`);
  console.log(`  It signs every license you issue. Keep a copy somewhere safe (not just this computer) and never share it.\n`);
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
