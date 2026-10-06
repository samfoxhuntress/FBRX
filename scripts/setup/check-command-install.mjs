#!/usr/bin/env node
/**
 * CI check for "Install FBRX Command" (installer workflow), run after each phase:
 *
 *   node scripts/setup/check-command-install.mjs installed   answers on this computer and the network, with its own
 *                                                            certificate, the shared signing key and its icons; then
 *                                                            completes first-run setup (as a person would)
 *   node scripts/setup/check-command-install.mjs updated     still answers, same certificate, same accounts
 *   node scripts/setup/check-command-install.mjs removed     stopped, program and icons gone, data kept
 */
import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';

const phase = process.argv[2];
const win = process.platform === 'win32';
const mac = process.platform === 'darwin';
const HOME = mac ? join(homedir(), 'Library', 'Application Support', 'FBRX Command') : win ? join(process.env.LOCALAPPDATA, 'FBRX Command') : join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'fbrx-command');
const STATE = join(process.cwd(), '.fbrx-setup', 'command-ci.json');
const PASSWORD = 'Ci-Runner-Command-Pass-1';
const fail = (msg) => {
  console.error(`✖ ${msg}`);
  process.exit(1);
};
const ok = (msg) => console.log(`✔ ${msg}`);

const local = async (path, init) => {
  const res = await fetch(`http://127.0.0.1:8788${path}`, { ...init, signal: AbortSignal.timeout(5000) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
/** HTTPS on the network port, reporting the certificate it presents (no authority vouches for it). */
const network = (path) =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: 8787, path, rejectUnauthorized: false, timeout: 5000 }, (res) => {
      const fingerprint = res.socket.getPeerCertificate().fingerprint256;
      const authorized = res.socket.authorized;
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, fingerprint, authorized }));
    });
    req.on('error', reject);
    req.end();
  });

const certFingerprint = () => new X509Certificate(readFileSync(join(HOME, 'data', 'tls', 'command.crt'))).fingerprint256;
const icons = () => {
  if (win) {
    const programs = join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    return [join(programs, 'FBRX Command.lnk'), join(programs, 'Startup', 'FBRX Command.lnk'), join(process.env.USERPROFILE, 'Desktop', 'FBRX Command.lnk')];
  }
  if (mac) return [join(homedir(), 'Applications', 'FBRX Command.app', 'Contents', 'MacOS', 'FBRX Command'), join(homedir(), 'Library', 'LaunchAgents', 'com.fbrx.command.plist')];
  const share = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return [join(share, 'applications', 'fbrx-command.desktop'), join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'autostart', 'fbrx-command.desktop')];
};

if (phase === 'installed') {
  const config = JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8'));
  if (config.mode !== 'network') fail(`expected network mode, got ${config.mode}`);
  if ((await local('/healthz')).status !== 200) fail('the console address on this computer does not answer');
  ok('answers on http://127.0.0.1:8788');
  const n = await network('/healthz');
  if (n.status !== 200) fail('the network address does not answer over HTTPS');
  if (n.authorized) fail('expected FBRX Command’s own certificate');
  if (n.fingerprint !== certFingerprint()) fail('the certificate served is not the one kept in the data folder');
  ok(`answers on https://…:8787 with its own certificate ${n.fingerprint.slice(0, 23)}…`);
  const key = readFileSync(join(HOME, 'data', 'keys', 'license-signing.pem'), 'utf8').trim();
  if (key !== readFileSync(join(homedir(), '.fbrx-keys', 'license-signing.pem'), 'utf8').trim()) fail('FBRX Command does not sign licenses with the key in ~/.fbrx-keys');
  ok('signs licenses with the same key as "Install FBRX OS"');
  for (const f of icons()) if (!existsSync(f)) fail(`missing ${f}`);
  ok('icons and the login item are in place');
  if (!(await local('/v1/setup/status')).body?.needsSetup) fail('expected first-run setup');
  const setup = await local('/v1/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupToken: config.setupToken, organization: 'CI Family', kind: 'home', name: 'CI Runner', email: 'ci@example.com', password: PASSWORD }) });
  if (setup.status !== 200) fail(`first-run setup with the installer's token failed: ${JSON.stringify(setup.body)}`);
  ok('first-run setup works with the token the installer made');
  writeFileSync(STATE, JSON.stringify({ fingerprint: n.fingerprint }));
} else if (phase === 'updated') {
  const before = JSON.parse(readFileSync(STATE, 'utf8'));
  const n = await network('/healthz');
  if (n.status !== 200) fail('the network address does not answer after the update');
  if (n.fingerprint !== before.fingerprint) fail('the update changed the certificate (computers that joined would stop working)');
  const login = await local('/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ci@example.com', password: PASSWORD }) });
  if (login.status !== 200 || !login.body?.token) fail('the account made before the update cannot sign in');
  ok('updated in place: same certificate, same accounts');
} else if (phase === 'removed') {
  const still = await local('/healthz').catch(() => null);
  if (still) fail('FBRX Command still answers after --uninstall');
  if (existsSync(join(HOME, 'app'))) fail('the program folder is still there');
  for (const f of icons()) if (existsSync(f)) fail(`still there: ${f}`);
  if (!existsSync(join(HOME, 'data', 'control-plane.db'))) fail('--uninstall deleted the data without being asked');
  ok('removed: stopped, program and icons gone, data kept');
} else {
  fail('usage: check-command-install.mjs installed|updated|removed');
}
