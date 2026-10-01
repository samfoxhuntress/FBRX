// Builds the app and packages it with electron-builder. Extra arguments are passed through
// (e.g. `node scripts/package.mjs --mac`, `--win`, `--linux --dir`).
//
// macOS signing: with CSC_LINK/CSC_NAME set, or a "Developer ID Application" certificate in the keychain,
// electron-builder signs normally. Otherwise the app is ad-hoc signed so it still launches on the Mac that built it
// (an unsigned Apple silicon app does not start at all). Ad-hoc builds are for your own machines; distributing to
// other Macs needs a Developer ID certificate and notarization (docs/DEPLOYMENT.md).
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);

execFileSync(process.execPath, [join(app, 'scripts/build.mjs')], { stdio: 'inherit' });

function hasDeveloperIdCertificate() {
  try {
    return /Developer ID Application/.test(execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }));
  } catch {
    return false;
  }
}

const buildsMac = args.includes('--mac') || args.includes('-m') || (process.platform === 'darwin' && !args.some((a) => ['--win', '-w', '--linux', '-l'].includes(a)));
const signingConfigured = Boolean(process.env.CSC_LINK || process.env.CSC_NAME) || args.some((a) => a.startsWith('-c.mac.identity') || a.startsWith('--config.mac.identity'));
if (buildsMac && process.platform === 'darwin' && !signingConfigured && !hasDeveloperIdCertificate()) {
  console.log('\nNo Developer ID certificate found: ad-hoc signing so the app runs on this Mac. Other Macs will block it.\n');
  args.push('-c.mac.identity=-');
}

const cli = require.resolve('electron-builder/cli.js');
const r = spawnSync(process.execPath, [cli, '--config', 'electron-builder.yml', '--publish', 'never', ...args], { cwd: app, stdio: 'inherit' });
process.exit(r.status ?? 1);
