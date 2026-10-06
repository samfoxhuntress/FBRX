#!/usr/bin/env node
/**
 * FBRX Command setup: installs FBRX Command (the control plane and its console) on this computer so a company, school
 * or family can run its FBRX computers from it. Start it by double-clicking "Install FBRX Command.cmd" (Windows) or
 * "Install FBRX Command.command" (macOS); those fetch a private copy of Node.js first when needed. Running it again
 * updates FBRX Command and keeps all its data.
 *
 *   node scripts/setup/command.mjs [--yes] [--network | --local] [--port 8787] [--address 192.168.1.20] [--no-open]
 *   node scripts/setup/command.mjs --uninstall [--delete-data]
 *
 * --network (the default): other computers on this network join over HTTPS with FBRX Command's own certificate,
 * which they trust by its fingerprint (no domain name needed); the console opens on this computer at
 * http://127.0.0.1:<port + 1>. --local: only this computer, plain HTTP on localhost, to try it out.
 *
 * Steps: install dependencies → the license signing key (the same one "Install FBRX OS" uses, so licenses issued in
 * FBRX Command work on your FBRX OS computers) → build → install with its own Node.js → start at login, with a
 * "FBRX Command" icon → start it and open the setup page with the one-time setup token filled in.
 */
import { spawn, spawnSync } from 'node:child_process';
import { X509Certificate, createHash, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, hostname, networkInterfaces, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE = join(ROOT, '.fbrx-setup');
const LOG = join(STATE, 'command-setup.log');
const PRODUCT = 'FBRX Command';
const AGENT = 'com.fbrx.command';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => {
  const i = argv.indexOf(n);
  return i === -1 ? undefined : argv[i + 1];
};
const yes = flag('--yes') || flag('-y') || !process.stdin.isTTY;

// ------------------------------------------------------------------------------------------------ output
const win = process.platform === 'win32';
const mac = process.platform === 'darwin';
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
log(`\n===== ${new Date().toISOString()} FBRX Command setup (${process.platform}-${process.arch}, node ${process.version}) ${argv.join(' ')} =====`);
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
let STEPS = 6;
async function step(title, fn) {
  stepNo++;
  const label = `${dim(`[${stepNo}/${STEPS}]`)} ${title}`;
  const started = Date.now();
  let frame = 0;
  let detail = '';
  const draw = () => {
    const width = (process.stdout.columns || 80) - 1;
    let text = `${title}${detail ? `  ${detail}` : ''}`;
    if (text.length + 14 > width) text = text.slice(0, Math.max(0, width - 15));
    process.stdout.write(`\r\x1b[2K${cyan(FRAMES[frame++ % FRAMES.length])} ${dim(`[${stepNo}/${STEPS}]`)} ${text}${dim(` ${elapsed(started)}`)}`);
  };
  const timer = process.stdout.isTTY ? setInterval(draw, 120) : null;
  if (!process.stdout.isTTY) console.log(`... ${title}`);
  log(`--- step ${stepNo}: ${title}`);
  try {
    const result = await fn({ setDetail: (d) => (detail = d) });
    if (timer) clearInterval(timer);
    process.stdout.write(process.stdout.isTTY ? `\r\x1b[2K${OK} ${label} ${dim(elapsed(started))}${result?.note ? `  ${dim(result.note)}` : ''}\n` : `${OK} ${title}${result?.note ? ` (${result.note})` : ''}\n`);
    return result;
  } catch (err) {
    if (timer) clearInterval(timer);
    process.stdout.write(process.stdout.isTTY ? `\r\x1b[2K${FAIL} ${label}\n` : `${FAIL} ${title}\n`);
    throw err;
  }
}

// ------------------------------------------------------------------------------------------------ processes
const nodeDir = dirname(process.execPath);
const childEnv = { ...process.env, PATH: `${nodeDir}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}`, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' };
if (win) childEnv.Path = childEnv.PATH;

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
    child.on('close', (code) => (code === 0 ? resolvePromise(out) : reject(new SetupError(`${label ?? cmd} failed (exit code ${code})`, tail.join('\n')))));
  });
}
const node = (args, o) => run(process.execPath, args, o);
function npm(args, o) {
  const cli = [join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find((c) => existsSync(c));
  const opts = { label: `npm ${args[0]}`, ...o };
  return cli ? node([cli, ...args], opts) : run(win ? 'npm.cmd' : 'npm', args, opts);
}
/** PowerShell with values passed as environment variables (no quoting trouble with spaces or apostrophes in paths). */
function powershell(script, vars = {}) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { env: { ...process.env, ...vars }, encoding: 'utf8', windowsHide: true });
  log(`powershell: ${script.slice(0, 120)}… → ${r.status} ${r.stderr ?? ''}`);
  return r.status === 0;
}

// ------------------------------------------------------------------------------------------------ places
const version = JSON.parse(readFileSync(join(ROOT, 'apps', 'desktop', 'package.json'), 'utf8')).version;
const HOME = resolve(
  opt('--home') ??
    process.env.FBRX_COMMAND_HOME ??
    (mac ? join(homedir(), 'Library', 'Application Support', PRODUCT) : win ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), PRODUCT) : join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'fbrx-command')),
);
const APP = join(HOME, 'app');
const DATA = join(HOME, 'data');
const CONFIG = join(HOME, 'config.json');
const NODE_BIN = join(APP, win ? 'node.exe' : 'node');
const LAUNCHER = join(APP, 'launcher.mjs');
const winDirs = () => {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  const programs = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  return { startup: join(programs, 'Startup', `${PRODUCT}.lnk`), menu: join(programs, `${PRODUCT}.lnk`), desktop: join(process.env.USERPROFILE ?? homedir(), 'Desktop', `${PRODUCT}.lnk`) };
};
const macAgentFile = () => join(homedir(), 'Library', 'LaunchAgents', `${AGENT}.plist`);
const macApp = () => join(homedir(), 'Applications', `${PRODUCT}.app`);
const linuxFiles = () => ({
  autostart: join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'autostart', 'fbrx-command.desktop'),
  menu: join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'applications', 'fbrx-command.desktop'),
});

const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

/** This computer's address on the local network (a private IPv4, skipping VPN and virtual adapters). */
function networkAddresses() {
  const skip = /docker|veth|br-|vmnet|vbox|virtualbox|vmware|vethernet|hyper-v|utun|tun|tap|tailscale|zerotier|wsl/i;
  const out = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.internal || n.family !== 'IPv4' || n.address.startsWith('169.254.')) continue;
      const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(n.address);
      out.push({ address: n.address, score: (priv ? 2 : 0) + (skip.test(name) ? -3 : 0) });
    }
  }
  return out.sort((a, b) => b.score - a.score).map((a) => a.address);
}

function portFree(port, host = '0.0.0.0') {
  return new Promise((r) => {
    const s = createServer();
    s.once('error', () => r(false));
    s.listen(port, host, () => s.close(() => r(true)));
  });
}

function launcher(action, { wait = true } = {}) {
  if (!existsSync(LAUNCHER) || !existsSync(NODE_BIN)) return false;
  if (!wait) {
    spawn(NODE_BIN, [LAUNCHER, action], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  }
  const r = spawnSync(NODE_BIN, [LAUNCHER, action], { encoding: 'utf8', timeout: 90_000, windowsHide: true });
  log(`launcher ${action} → ${r.status} ${r.stdout ?? ''}${r.stderr ?? ''}`);
  return r.status === 0 ? r.stdout || true : false;
}

// ------------------------------------------------------------------------------------------------ steps
async function installDependencies(ui) {
  const digest = createHash('sha256').update(readFileSync(join(ROOT, 'package-lock.json'))).update(process.version).digest('hex');
  const full = join(STATE, 'dependencies.sha256'); // "Install FBRX OS" (everything, Electron included)
  const mine = join(STATE, 'command-dependencies.sha256');
  const installed = existsSync(join(ROOT, 'node_modules', '.package-lock.json'));
  const same = (f) => existsSync(f) && readFileSync(f, 'utf8') === digest;
  if (installed && (same(full) || same(mine))) return { note: 'already up to date' };
  let downloads = 0;
  // FBRX Command needs no Electron: skip its download (about 100 MB).
  await npm(['ci', '--no-audit', '--no-fund', '--loglevel=http'], { env: { ...childEnv, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' }, onLine: (l) => /GET 200|fetch GET/.test(l) && ui.setDetail(`${++downloads} downloads`) });
  writeFileSync(mine, digest);
  // Without Electron the dependencies are not enough for "Install FBRX OS", which then installs them again.
  rmSync(full, { force: true });
}

/** The same license signing key "Install FBRX OS" uses (kept in ~/.fbrx-keys), so FBRX Command's licenses work on your computers. */
async function signingKey() {
  const backup = join(homedir(), '.fbrx-keys', 'license-signing.pem');
  const local = join(ROOT, '.fbrx-keys', 'license-signing.pem');
  const target = join(DATA, 'keys', 'license-signing.pem');
  if (existsSync(target)) {
    const same = existsSync(backup) && readFileSync(backup, 'utf8').trim() === readFileSync(target, 'utf8').trim();
    return { note: same ? 'the key your FBRX OS computers trust' : 'kept FBRX Command’s existing key' };
  }
  let source = existsSync(backup) ? backup : existsSync(local) ? local : null;
  let note = 'the key your FBRX OS computers trust';
  if (!source) {
    await node([join(ROOT, 'scripts', 'generate-license-keys.mjs')], { label: 'Generating keys' });
    source = local;
    note = 'a new key, also used by "Install FBRX OS"';
  }
  if (!existsSync(backup)) {
    mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
    copyFileSync(source, backup);
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(source, target);
  for (const f of [backup, target]) {
    try {
      chmodSync(f, 0o600);
    } catch {
      /* Windows */
    }
  }
  return { note };
}

async function build(ui) {
  ui.setDetail('the console');
  await npm(['run', 'build', '-w', '@fbrx/admin-console'], { label: 'Building the console' });
  ui.setDetail('the server');
  await npm(['run', 'build', '-w', '@fbrx/control-plane'], { label: 'Building the server', env: { ...childEnv, FBRX_CP_VERSION: version } });
  const dist = join(ROOT, 'apps', 'control-plane', 'dist');
  if (!existsSync(join(dist, 'server.mjs')) || !existsSync(join(dist, 'admin-console', 'index.html'))) throw new SetupError(`The build finished but FBRX Command was not found in ${dist}`);
  return { dist };
}

function newConfig(previous, mode, port, address) {
  const localPort = mode === 'network' ? (previous?.localPort && previous.port === port ? previous.localPort : port + 1) : null;
  const host = hostname().replace(/\.local$/i, '');
  return {
    version,
    mode,
    port,
    localPort,
    publicUrl: mode === 'network' ? `https://${address}:${port}` : `http://localhost:${port}`,
    // Extra names for the certificate (browsers check them; computers check the fingerprint).
    names: mode === 'network' ? [...new Set([address, host, `${host}.local`])] : [],
    setupToken: previous?.setupToken ?? randomBytes(18).toString('base64url'),
    logLevel: previous?.logLevel ?? 'info',
    installedFrom: ROOT,
    installedAt: new Date().toISOString(),
  };
}

async function installFiles(dist, config) {
  const wasRunning = !!launcher('stop');
  rmSync(APP, { recursive: true, force: true });
  mkdirSync(APP, { recursive: true });
  for (const f of ['server.mjs', 'package.json']) copyFileSync(join(dist, f), join(APP, f));
  cpSync(join(dist, 'admin-console'), join(APP, 'admin-console'), { recursive: true });
  copyFileSync(join(ROOT, 'scripts', 'setup', 'command-launcher.mjs'), LAUNCHER);
  // Its own Node.js: keeps working when the system's Node.js changes or this folder is deleted.
  copyFileSync(process.execPath, NODE_BIN);
  if (!win) chmodSync(NODE_BIN, 0o755);
  copyFileSync(join(ROOT, 'apps', 'desktop', 'build', 'icon.png'), join(APP, 'icon.png'));
  mkdirSync(DATA, { recursive: true });
  writeFileSync(join(APP, 'install.json'), JSON.stringify({ home: HOME, version, installedAt: config.installedAt }, null, 2));
  writeFileSync(CONFIG, JSON.stringify(config, null, 2));
  return { note: HOME, wasRunning };
}

function windowsIcon() {
  // A 256 px PNG inside an .ico (Windows Vista and later), made from the app icon with System.Drawing.
  const ico = join(APP, 'fbrx-command.ico');
  const ok = powershell(
    `Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($env:FBRX_PNG)
$bmp = New-Object System.Drawing.Bitmap 256, 256
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($src, 0, 0, 256, 256)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$png = $ms.ToArray()
$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]1)
$w.Write([Byte]0); $w.Write([Byte]0); $w.Write([Byte]0); $w.Write([Byte]0)
$w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]$png.Length); $w.Write([UInt32]22)
$w.Write($png)
[IO.File]::WriteAllBytes($env:FBRX_ICO, $out.ToArray())`,
    { FBRX_PNG: join(APP, 'icon.png'), FBRX_ICO: ico },
  );
  return ok && existsSync(ico) ? ico : null;
}

function macAppBundle() {
  const app = macApp();
  rmSync(app, { recursive: true, force: true });
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true });
  const exe = join(app, 'Contents', 'MacOS', PRODUCT);
  writeFileSync(exe, `#!/bin/bash\n# Opens FBRX Command (starting it first if needed).\nexec "${NODE_BIN}" "${LAUNCHER}" open\n`);
  chmodSync(exe, 0o755);
  writeFileSync(
    join(app, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${PRODUCT}</string>
  <key>CFBundleDisplayName</key><string>${PRODUCT}</string>
  <key>CFBundleIdentifier</key><string>${AGENT}.launcher</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleExecutable</key><string>${PRODUCT}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`,
  );
  // An .icns from the app icon (sips and iconutil come with macOS).
  const set = join(mkdtempSync(join(tmpdir(), 'fbrx-icon-')), 'AppIcon.iconset');
  mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) {
    spawnSync('sips', ['-z', String(s), String(s), join(APP, 'icon.png'), '--out', join(set, `icon_${s}x${s}.png`)]);
    spawnSync('sips', ['-z', String(s * 2), String(s * 2), join(APP, 'icon.png'), '--out', join(set, `icon_${s}x${s}@2x.png`)]);
  }
  spawnSync('iconutil', ['-c', 'icns', set, '-o', join(app, 'Contents', 'Resources', 'AppIcon.icns')]);
  rmSync(dirname(set), { recursive: true, force: true });
  return app;
}

/** Starts FBRX Command when you log in, and puts an "FBRX Command" icon where apps live. */
async function startAtLogin() {
  if (win) {
    const vbs = join(APP, `${PRODUCT}.vbs`);
    writeFileSync(
      vbs,
      [
        "' Runs FBRX Command's launcher without a console window. Argument: open (default) or start.",
        'Set sh = CreateObject("WScript.Shell")',
        'dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)',
        'action = "open"',
        'If WScript.Arguments.Count > 0 Then action = WScript.Arguments(0)',
        'sh.Run """" & dir & "\\node.exe"" """ & dir & "\\launcher.mjs"" " & action, 0, False',
        '',
      ].join('\r\n'),
    );
    const ico = windowsIcon();
    const d = winDirs();
    const made = [];
    for (const [file, action] of [
      [d.startup, 'start'],
      [d.menu, 'open'],
      [d.desktop, 'open'],
    ]) {
      mkdirSync(dirname(file), { recursive: true });
      const ok = powershell(
        `$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:FBRX_LNK)
$s.TargetPath = Join-Path $env:SystemRoot 'System32\\wscript.exe'
$s.Arguments = '"' + $env:FBRX_VBS + '" ' + $env:FBRX_ACTION
$s.WorkingDirectory = $env:FBRX_APP
$s.Description = 'FBRX Command'
if ($env:FBRX_ICON) { $s.IconLocation = $env:FBRX_ICON }
$s.Save()`,
        { FBRX_LNK: file, FBRX_VBS: vbs, FBRX_ACTION: action, FBRX_APP: APP, FBRX_ICON: ico ?? '' },
      );
      if (ok) made.push(file);
    }
    if (made.length < 3) throw new SetupError('Could not create the FBRX Command shortcuts', `Made: ${made.join(', ') || 'none'}. See ${LOG}.`);
    return { note: 'Start menu, desktop and Startup folder' };
  }
  if (mac) {
    const plist = macAgentFile();
    mkdirSync(dirname(plist), { recursive: true });
    const logs = join(HOME, 'logs');
    mkdirSync(logs, { recursive: true });
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(NODE_BIN)}</string><string>${esc(LAUNCHER)}</string><string>serve</string></array>
  <key>WorkingDirectory</key><string>${esc(APP)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${esc(join(logs, 'command.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(join(logs, 'command.log'))}</string>
</dict>
</plist>
`,
    );
    const app = macAppBundle();
    return { note: `login item and ${app.replace(homedir(), '~')}` };
  }
  const f = linuxFiles();
  const exec = (action) => `"${NODE_BIN}" "${LAUNCHER}" ${action}`;
  const entry = (action, extra = '') => `[Desktop Entry]\nType=Application\nName=${PRODUCT}\nComment=Run your FBRX computers\nExec=${exec(action)}\nIcon=${join(APP, 'icon.png')}\nTerminal=false\nCategories=Network;System;\n${extra}`;
  mkdirSync(dirname(f.autostart), { recursive: true });
  mkdirSync(dirname(f.menu), { recursive: true });
  writeFileSync(f.autostart, entry('start', 'X-GNOME-Autostart-enabled=true\nHidden=false\n'));
  writeFileSync(f.menu, entry('open'));
  return { note: 'autostart and the applications menu' };
}

async function startNow() {
  if (mac && existsSync(macAgentFile())) {
    const uid = process.getuid();
    spawnSync('launchctl', ['bootout', `gui/${uid}/${AGENT}`]);
    const r = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, macAgentFile()], { encoding: 'utf8' });
    log(`launchctl bootstrap → ${r.status} ${r.stderr}`);
  }
  if (!launcher('start')) throw new SetupError('FBRX Command did not start', `See ${join(HOME, 'logs', 'command.log')}`);
  return { note: 'running' };
}

const fingerprint = () => {
  try {
    return new X509Certificate(readFileSync(join(DATA, 'tls', 'command.crt'))).fingerprint256;
  } catch {
    return null;
  }
};

async function uninstall() {
  const deleteData = flag('--delete-data');
  console.log(`\n${bold(`Removing ${PRODUCT}`)}${deleteData ? red(' and all its data') : dim(' (its data is kept)')}\n`);
  STEPS = 3;
  await step(`Stopping ${PRODUCT}`, async () => (launcher('stop') ? undefined : { note: 'it was not running' }));
  await step('Removing the icons and the login item', async () => {
    if (win) for (const f of Object.values(winDirs())) rmSync(f, { force: true });
    else if (mac) {
      spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${AGENT}`]);
      rmSync(macAgentFile(), { force: true });
      rmSync(macApp(), { recursive: true, force: true });
    } else for (const f of Object.values(linuxFiles())) rmSync(f, { force: true });
  });
  await step(deleteData ? 'Deleting FBRX Command and its data' : 'Deleting the program', async () => {
    rmSync(deleteData ? HOME : APP, { recursive: true, force: true });
    return { note: deleteData ? HOME : `data kept in ${DATA}` };
  });
  console.log(`\n${green(bold(`${PRODUCT} is removed.`))}${deleteData ? '' : ` Run the installer again to bring it back with everything as it was.`}\n`);
  return 0;
}

// ------------------------------------------------------------------------------------------------ main
async function main() {
  if (!['darwin', 'win32', 'linux'].includes(process.platform)) throw new SetupError(`${process.platform} is not supported.`);
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 15)) throw new SetupError(`Node.js ${process.version} is too old; 22.15 or newer is needed.`, 'Start the setup with the "Install FBRX Command" launcher, which downloads a suitable Node.js automatically.');
  if (!existsSync(join(ROOT, 'apps', 'control-plane', 'package.json'))) throw new SetupError('This does not look like the FBRX folder.', 'Keep the installer inside the downloaded FBRX folder and run it from there.');
  if (flag('--uninstall')) return uninstall();

  console.log(`\n${bold(`${PRODUCT} setup`)}  ${dim(`· ${version}`)}\n`);
  const previous = readJson(CONFIG);
  const rl = yes ? null : createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q) => (await rl.question(q)).trim();

  let mode = flag('--local') ? 'local' : flag('--network') ? 'network' : (previous?.mode ?? null);
  if (previous) console.log(`${PRODUCT} is already installed on this computer: this updates it and keeps all its data.\n`);
  else console.log(`This installs ${PRODUCT} on this computer, where you run your company's, school's or family's FBRX\ncomputers from your browser. It takes about 5 minutes and downloads around 300 MB.\n`);
  if (!mode && rl) {
    console.log(bold('Who will connect to FBRX Command?'));
    console.log(`  1  Computers on this network: a family, a school or an office ${dim('(recommended)')}`);
    console.log(`  2  Only this computer, to try it out`);
    mode = (await ask('Choose [1]: ')) === '2' ? 'local' : 'network';
    console.log('');
  }
  mode ??= 'network';
  const port = Number(opt('--port') ?? previous?.port ?? 8787);
  if (!Number.isInteger(port) || port < 1024 || port > 65000) throw new SetupError('The port must be a number between 1024 and 65000.');
  const addresses = networkAddresses();
  let address = opt('--address') ?? (previous?.mode === 'network' && previous.publicUrl ? new URL(previous.publicUrl).hostname : null) ?? addresses[0] ?? null;
  if (mode === 'network' && !address) {
    console.log(`${yellow('!')} No network connection was found, so FBRX Command answers on this computer only for now.\n`);
    address = 'localhost';
  }
  if (mode === 'network' && opt('--address') == null && previous?.publicUrl && addresses.length && !addresses.includes(address)) {
    console.log(`${yellow('!')} This computer's address changed from ${address} to ${addresses[0]}. Computers that already joined use the old one;`);
    console.log(`  a fixed address for this computer in your router avoids this. Using ${addresses[0]} for new computers.\n`);
    address = addresses[0];
  }
  if (rl) {
    const go = (await ask(`${bold(previous ? 'Update FBRX Command now?' : 'Ready to install?')} [Y/n]: `)).toLowerCase();
    rl.close();
    if (go.startsWith('n')) {
      console.log('\nNothing was changed.');
      return 0;
    }
    console.log('');
  }

  const started = Date.now();
  await step('Installing dependencies', installDependencies);
  await step('Setting up the license signing key', signingKey);
  const { dist } = await step(`Building ${PRODUCT}`, build);
  const config = newConfig(previous, mode, port, address);
  await step(`Installing ${PRODUCT}`, async () => {
    const r = await installFiles(dist, config);
    for (const p of [config.port, config.localPort].filter(Boolean)) {
      if (!(await portFree(p))) throw new SetupError(`Port ${p} is in use by another program.`, `Run the installer again with another port, for example --port ${config.port + 10}.`);
    }
    return r;
  });
  await step('Starting it when you log in', startAtLogin);
  await step(`Starting ${PRODUCT}`, startNow);
  const status = (() => {
    const out = launcher('status');
    try {
      return typeof out === 'string' ? JSON.parse(out) : null;
    } catch {
      return null;
    }
  })();
  if (!flag('--no-open')) launcher('open', { wait: false });

  const fp = mode === 'network' ? fingerprint() : null;
  const local = `http://127.0.0.1:${mode === 'network' ? config.localPort : config.port}`;
  console.log(`\n${green(bold(`${PRODUCT} is running`))} ${dim(`in ${elapsed(started)}`)}\n`);
  console.log(`  ${bold('On this computer')}  ${local}  ${dim(`(the "${PRODUCT}" icon opens it)`)}`);
  if (mode === 'network') {
    console.log(`  ${bold('Other computers')}   join at ${config.publicUrl}`);
    if (fp) console.log(`  ${bold('Certificate')}       ${fp}\n                    ${dim('Computers show this when they join; it must match. Deploy & enroll shows it too.')}`);
  } else {
    console.log(`  ${bold('Other computers')}   cannot join yet: run the installer again with --network when you are ready`);
  }
  if (status?.needsSetup !== false) console.log(`  ${bold('First sign-in')}     the setup page fills in your one-time setup token: ${config.setupToken}`);
  console.log(`  ${bold('Data')}              ${DATA} ${dim('(kept when you update or remove FBRX Command)')}`);
  console.log(`  ${bold('Update')}            download the new FBRX folder and run this installer again`);
  console.log(`  ${bold('Remove')}            run it with --uninstall ${dim('(add --delete-data to erase everything)')}`);
  if (mode === 'network') {
    console.log(`\n  ${yellow('!')} Give this computer a fixed address in your router, so ${address} keeps working.`);
    if (win) console.log(`  ${yellow('!')} If Windows asks whether Node.js may use private networks, choose Allow: that is FBRX Command.`);
    if (mac) console.log(`  ${yellow('!')} If macOS asks whether "node" may accept incoming connections, choose Allow: that is FBRX Command.`);
  }
  console.log(`\n  ${dim(`Your license signing key is backed up in ${join(homedir(), '.fbrx-keys')}. Keep a copy somewhere safe.`)}\n`);
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
