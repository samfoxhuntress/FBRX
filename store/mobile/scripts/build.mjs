// Builds www/ for the store app: the phone web app FBRX OS serves to paired phones (packages/core/mobile), plus the
// native glue (capacitor.js, native.js) and config.js with the FBRX account server and the editions sold in the app.
// It also writes package.json's version into the iOS and Android projects, so the app has one version everywhere.
//
//   FBRX_ACCOUNT_SERVER=https://command.example.com FBRX_TERMS_URL=… FBRX_PRIVACY_URL=… npm run sync
//
// Run with tsx (npm scripts do): the price list comes from packages/shared.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(here, '..', '..');
const www = join(here, 'www');
const require = createRequire(import.meta.url);
const { EDITION_PLANS, editionPoints } = await import(join(root, 'packages', 'shared', 'src', 'plans.ts'));
const version = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`The stores take versions like 2.0.0, not ${version} (store/mobile/package.json)`);

// ------------------------------------------------------------------------------------------------- www/
rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });
const mobile = join(root, 'packages', 'core', 'mobile');
for (const f of ['app.js', 'styles.css', 'manifest.webmanifest']) copyFileSync(join(mobile, f), join(www, f));
copyFileSync(join(root, 'node_modules', 'tweetnacl', 'nacl-fast.min.js'), join(www, 'nacl.min.js'));
copyFileSync(join(root, 'apps', 'desktop', 'build', 'icon.png'), join(www, 'icon.png'));
copyFileSync(require.resolve('@capacitor/core/dist/capacitor.js'), join(www, 'capacitor.js'));
copyFileSync(join(here, 'src', 'native.js'), join(www, 'native.js'));

const html = readFileSync(join(mobile, 'index.html'), 'utf8');
const glue = '<script src="capacitor.js"></script>\n    <script src="config.js"></script>\n    <script src="native.js"></script>\n    <script src="app.js"></script>';
if (!html.includes('<script src="app.js"></script>')) throw new Error('packages/core/mobile/index.html no longer loads app.js the way this script expects');
writeFileSync(join(www, 'index.html'), html.replace('<script src="app.js"></script>', glue).replace('<title>FBRX Mobile</title>', '<title>FBRX</title>'));

const accountServer = (process.env.FBRX_ACCOUNT_SERVER ?? '').replace(/\/+$/, '');
const products = ['basic', 'ultra'].map((tier) => {
  const { productId, monthly, summary } = EDITION_PLANS[tier];
  return { tier, productId, monthly, summary, points: editionPoints(tier) };
});
// The App Store wants the terms of use and the privacy policy one tap away from the subscriptions (docs/STORES.md).
const terms = process.env.FBRX_TERMS_URL ?? '';
const privacy = process.env.FBRX_PRIVACY_URL ?? '';
writeFileSync(join(www, 'config.js'), `window.FBRX_STORE_CONFIG = ${JSON.stringify({ version, accountServer, products, terms, privacy })};\n`);

// ------------------------------------------------------------------------------------- native versions
// The build number (the App Store's build, Google Play's version code) is major * 10000 + minor * 100 + patch, or
// FBRX_BUILD_NUMBER: each upload of the same version to a store needs a higher one.
const [major, minor, patch] = version.split('.').map(Number);
const build = Number(process.env.FBRX_BUILD_NUMBER) || major * 10000 + minor * 100 + patch;
rewrite(join(here, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'), [
  [/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`],
  [/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${build};`],
]);
rewrite(join(here, 'android', 'app', 'build.gradle'), [
  [/versionCode \d+/, `versionCode ${build}`],
  [/versionName "[^"]*"/, `versionName "${version}"`],
]);

console.log(`Built FBRX Mobile ${version} (build ${build})${accountServer ? `, accounts on ${accountServer}` : ': no FBRX_ACCOUNT_SERVER, so sign-in says accounts open soon'}`);

function rewrite(file, edits) {
  if (!existsSync(file)) return;
  const before = readFileSync(file, 'utf8');
  const after = edits.reduce((text, [pattern, to]) => text.replace(pattern, to), before);
  if (after !== before) writeFileSync(file, after);
}
