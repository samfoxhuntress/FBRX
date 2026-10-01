#!/usr/bin/env node
/**
 * Uploads packaged desktop builds to an FBRX control plane so enrolled devices can update to them.
 *
 *   FBRX_CP_URL=https://fleet.example.com FBRX_CP_API_KEY=fbrx_ak_... npm run release:publish -- \
 *     [--version 1.2.0] [--channel stable|beta|dev] [--notes "..."|--notes-file CHANGELOG.md] \
 *     [--dir apps/desktop/release/1.2.0] [--publish] [--rollout 25] [--dry-run]
 *
 * Releases are platform-wide, so the API key must have the `superadmin` role (Account → API keys in the admin console).
 * Re-running is safe: the release is reused and files with the same name are replaced. Without --publish the
 * release stays a draft you can review and publish from the admin console (Releases page).
 */
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const flag = (name) => args.includes(name);

const baseUrl = (opt('--url') ?? process.env.FBRX_CP_URL ?? '').replace(/\/+$/, '');
const apiKey = opt('--api-key') ?? process.env.FBRX_CP_API_KEY ?? '';
const version = opt('--version') ?? JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')).version;
const channel = opt('--channel') ?? (version.includes('-') ? 'beta' : 'stable');
const notesFile = opt('--notes-file');
const notes = notesFile ? readFileSync(resolve(notesFile), 'utf8') : opt('--notes') ?? '';
const dir = resolve(opt('--dir') ?? join(root, 'apps/desktop/release', version));
const rollout = opt('--rollout') === undefined ? undefined : Number(opt('--rollout'));
const dryRun = flag('--dry-run');

if (!dryRun && (!baseUrl || !apiKey)) {
  console.error('Set FBRX_CP_URL and FBRX_CP_API_KEY (or pass --url/--api-key).');
  process.exit(2);
}
if (!existsSync(dir)) {
  console.error(`No build output at ${dir}. Run "npm run package:mac" / "npm run package:win" first, or pass --dir.`);
  process.exit(2);
}

/** Maps electron-builder outputs to (platform, arch). Returns null for files that are not distributables. */
function classify(fileName) {
  const f = fileName.toLowerCase();
  if (/^(latest.*\.yml|builder-(debug|effective-config)\.ya?ml)$/.test(f)) return null; // the control plane generates feeds
  let platform = null;
  if (/\.(dmg|pkg|zip)(\.blockmap)?$/.test(f)) platform = 'darwin';
  if (/\.(exe|msi|appx)(\.blockmap)?$/.test(f)) platform = 'win32';
  if (/\.(appimage|deb|rpm)(\.blockmap)?$/.test(f)) platform = 'linux';
  if (!platform) return null;
  const arch = /arm64|aarch64/.test(f) ? 'arm64' : /universal/.test(f) ? 'universal' : /x64|x86_64|amd64/.test(f) ? 'x64' : platform === 'win32' ? 'universal' : 'x64';
  return { platform, arch };
}

async function api(method, path, body, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${apiKey}`, ...(body && !(body instanceof ReadableStream) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body instanceof ReadableStream ? body : body ? JSON.stringify(body) : undefined,
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { message: text };
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${json?.message ?? json?.error ?? text}`);
  return json;
}

const files = readdirSync(dir)
  .filter((n) => statSync(join(dir, n)).isFile())
  .map((n) => ({ name: n, ...classify(n) }))
  .filter((f) => f.platform);
if (!files.length) {
  console.error(`No installers or update packages found in ${dir}.`);
  process.exit(2);
}
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(`FBRX OS ${version} (${channel}) — ${files.length} file(s) from ${dir}`);
for (const f of files) console.log(`  ${f.platform.padEnd(6)} ${f.arch.padEnd(9)} ${f.name}  ${mb(statSync(join(dir, f.name)).size)}`);
if (dryRun) process.exit(0);

const existing = (await api('GET', '/v1/admin/releases')).find((r) => r.version === version);
const release = existing ?? (await api('POST', '/v1/admin/releases', { version, channel, notes }));
console.log(existing ? `Updating existing release ${release.id}` : `Created release ${release.id}`);

for (const f of files) {
  const path = join(dir, f.name);
  const q = new URLSearchParams({ platform: f.platform, arch: f.arch, fileName: f.name });
  process.stdout.write(`  ↑ ${f.name} … `);
  const body = Readable.toWeb(createReadStream(path));
  await api('POST', `/v1/admin/releases/${release.id}/files?${q}`, body, { 'content-type': 'application/octet-stream' });
  console.log('done');
}

const patch = {};
if (existing && notes) patch.notes = notes;
if (existing && opt('--channel')) patch.channel = channel;
if (rollout !== undefined) patch.rolloutPct = rollout;
if (flag('--publish')) patch.published = true;
if (Object.keys(patch).length) await api('PATCH', `/v1/admin/releases/${release.id}`, patch);

const final = (await api('GET', '/v1/admin/releases')).find((r) => r.id === release.id);
console.log(`\n${final.published ? 'Published' : 'Draft saved'}: ${version} on ${final.channel}, rollout ${final.rolloutPct}%`);
if (!final.published) console.log('Publish it from the admin console (Releases) or re-run with --publish.');
