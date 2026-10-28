// Builds the app and packages it with electron-builder. Extra arguments are passed through
// (e.g. `node scripts/package.mjs --mac`, `--win`, `--linux --dir`). `--store` makes the Microsoft Store package
// (MSIX) with the identity Partner Center gives the app (FBRX_STORE_IDENTITY_NAME, FBRX_STORE_PUBLISHER).
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
let args = process.argv.slice(2);

if (args.includes('--store')) {
  const name = process.env.FBRX_STORE_IDENTITY_NAME;
  const publisher = process.env.FBRX_STORE_PUBLISHER;
  if (!name || !publisher) {
    console.error('The Store package needs the identity from Partner Center (Product identity):\n  FBRX_STORE_IDENTITY_NAME (Package/Identity/Name) and FBRX_STORE_PUBLISHER (Package/Identity/Publisher, "CN=…").');
    process.exit(1);
  }
  args = [...args.filter((a) => a !== '--store'), '--win', 'appx', '--x64', '--arm64', `-c.appx.identityName=${name}`, `-c.appx.publisher=${publisher}`];
}

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
