import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { compareSemver, isValidSemver, RELEASE_MANIFEST_URL } from '@fbrx/shared';

/**
 * FBRX Server updating itself (sudo fbrx-server update check, then update commit): the release manifest names the
 * newest server bundle; check downloads it, verifies it and unpacks it next to the running one, ready to install.
 * Installing (commit) and going back (rollback) are fbrx-server's own, in bash, because they replace this program.
 */

/** The server's entry in release.json. */
export interface ServerRelease {
  version: string;
  released?: string;
  summary?: string;
  notes?: string[];
  /** The bundle (fbrx-server-<version>.tar.gz), from the GitHub release. */
  bundle: string;
  /** Its SHA-256; without it, the checksum published next to the bundle (<bundle>.sha256). */
  sha256?: string;
  page?: string;
}

export interface UpdatePaths {
  /** Where updates are downloaded, staged, and the previous version kept (/var/lib/fbrx-server-update). */
  dir: string;
  /** VERSION= and ROLES= of what runs (/etc/fbrx-server-release). */
  releaseFile: string;
}

export const DEFAULT_UPDATE_PATHS: UpdatePaths = {
  dir: process.env.FBRX_SERVER_UPDATE_DIR || '/var/lib/fbrx-server-update',
  releaseFile: process.env.FBRX_SERVER_RELEASE_FILE || '/etc/fbrx-server-release',
};

/** What is staged, as KEY=value lines fbrx-server (bash) reads. */
export interface StagedUpdate {
  version: string;
  /** The unpacked bundle: install.sh, fbrx-virtual/, fbrx-core/ … */
  bundleDir: string;
  from: string;
  sha256: string;
  summary: string;
  notes: string[];
  stagedAt: string;
}

export function installedVersion(p: UpdatePaths): string {
  try {
    const m = /^VERSION="?([^"\n]+)"?/m.exec(readFileSync(p.releaseFile, 'utf8'));
    return m?.[1] ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const isUrl = (s: string) => /^https?:\/\//i.test(s);
const hexOf = (text: string) => /\b([a-f0-9]{64})\b/i.exec(text)?.[1]?.toLowerCase() ?? null;

async function getText(source: string, fetchImpl: typeof fetch): Promise<string> {
  if (!isUrl(source)) return readFileSync(source, 'utf8');
  const r = await fetchImpl(source, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw Object.assign(new Error(`${source}: HTTP ${r.status}`), { status: r.status });
  return r.text();
}

/** The newest server release the manifest offers (release.json, or a copy given as a file). */
export async function readServerRelease(source: string = RELEASE_MANIFEST_URL, fetchImpl: typeof fetch = fetch): Promise<ServerRelease> {
  let manifest: { server?: ServerRelease };
  try {
    manifest = JSON.parse(await getText(source, fetchImpl)) as { server?: ServerRelease };
  } catch (e) {
    throw new Error(`Could not read the release list (${source}): ${(e as Error).message}`);
  }
  const s = manifest.server;
  if (!s || typeof s.version !== 'string' || !isValidSemver(s.version) || typeof s.bundle !== 'string') throw new Error(`The release list (${source}) names no FBRX Server release yet`);
  if (s.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(s.sha256)) throw new Error('The release list has a malformed checksum for the server bundle');
  return s;
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

async function download(url: string, to: string, fetchImpl: typeof fetch, progress?: (received: number, total: number | null) => void): Promise<void> {
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(30 * 60_000) });
  if (!r.ok || !r.body) throw new Error(`Download failed (${url}): HTTP ${r.status}`);
  const total = Number(r.headers.get('content-length')) || null;
  let received = 0;
  const body = Readable.fromWeb(r.body as never);
  body.on('data', (c: Buffer) => {
    received += c.length;
    progress?.(received, total);
  });
  await pipeline(body, createWriteStream(`${to}.part`));
  renameSync(`${to}.part`, to);
}

/** The folder inside an unpacked bundle that holds install.sh and FBRX Virtual. */
function bundleRoot(dir: string): string | null {
  const ok = (d: string) => existsSync(join(d, 'install.sh')) && existsSync(join(d, 'fbrx-virtual', 'server.mjs')) && existsSync(join(d, 'VERSION'));
  if (ok(dir)) return dir;
  for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && ok(join(dir, e.name))) return join(dir, e.name);
  return null;
}

export function readStaged(p: UpdatePaths): StagedUpdate | null {
  try {
    const text = readFileSync(join(p.dir, 'staged.env'), 'utf8');
    const v = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(text)?.[1] ?? '';
    const bundleDir = v('BUNDLE');
    if (!bundleDir || !existsSync(join(bundleDir, 'install.sh'))) return null;
    let notes: string[] = [];
    try {
      notes = JSON.parse(readFileSync(join(p.dir, 'staged-notes.json'), 'utf8')) as string[];
    } catch {
      /* none */
    }
    return { version: v('VERSION'), bundleDir, from: v('FROM'), sha256: v('SHA256'), summary: v('SUMMARY'), notes, stagedAt: v('STAGED_AT') };
  } catch {
    return null;
  }
}

export interface CheckOptions {
  paths?: UpdatePaths;
  /** A manifest URL or file (default: release.json in the FBRX repository, or FBRX_SERVER_UPDATE_URL). */
  manifest?: string;
  /** A bundle brought along instead (a USB stick, FBRX Endpoint's copy): no manifest. */
  file?: string;
  /** Stage it even when it is not newer (to repair, or to go back to it on purpose). */
  force?: boolean;
  /**
   * Bundles may come from anywhere the release list says (a mirror named with --from or FBRX_SERVER_UPDATE_URL);
   * otherwise only from GitHub releases, like FBRX Endpoint's own updates.
   */
  anyHost?: boolean;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  progress?: (received: number, total: number | null) => void;
}

export type CheckResult =
  | { state: 'current'; installed: string; latest: string }
  | { state: 'staged'; installed: string; staged: StagedUpdate; already: boolean };

/**
 * Looks for a newer FBRX Server and gets it ready: downloaded (once), its checksum compared, unpacked into
 * <dir>/staged. Nothing that runs changes; update commit installs it.
 */
export async function checkForUpdate(o: CheckOptions = {}): Promise<CheckResult> {
  const p = o.paths ?? DEFAULT_UPDATE_PATHS;
  const fetchImpl = o.fetchImpl ?? fetch;
  const log = o.log ?? (() => undefined);
  const installed = installedVersion(p);
  mkdirSync(join(p.dir, 'downloads'), { recursive: true, mode: 0o700 });

  let release: ServerRelease;
  let tarball: string;
  let expected: string | null;
  if (o.file) {
    if (!existsSync(o.file) || !statSync(o.file).isFile()) throw new Error(`There is no file ${o.file}`);
    tarball = o.file;
    release = { version: '', bundle: o.file };
    // A checksum file next to it is used when there is one; a bundle brought by hand may come without.
    expected = existsSync(`${o.file}.sha256`) ? hexOf(readFileSync(`${o.file}.sha256`, 'utf8')) : null;
  } else {
    release = await readServerRelease(o.manifest, fetchImpl);
    if (compareSemver(release.version, installed) <= 0 && !o.force) return { state: 'current', installed, latest: release.version };
    const staged = readStaged(p);
    if (staged && staged.version === release.version && !o.force) return { state: 'staged', installed, staged, already: true };
    if (isUrl(release.bundle) && !o.anyHost && !/^https:\/\/github\.com\//i.test(release.bundle)) throw new Error(`The release list points the update at ${new URL(release.bundle).host}, not github.com: refused`);
    expected = release.sha256?.toLowerCase() ?? null;
    if (!expected && isUrl(release.bundle)) {
      try {
        expected = hexOf(await getText(`${release.bundle}.sha256`, fetchImpl));
      } catch {
        expected = null;
      }
    }
    if (!expected) throw new Error(`FBRX Server ${release.version} has no published checksum, so it is not installed. Download the bundle yourself and use update check --file <bundle>.`);
    tarball = join(p.dir, 'downloads', basename(new URL(release.bundle, 'file:///').pathname) || `fbrx-server-${release.version}.tar.gz`);
    if (!existsSync(tarball) || (await sha256File(tarball)) !== expected) {
      rmSync(tarball, { force: true });
      log(`Downloading FBRX Server ${release.version} (${release.bundle})`);
      if (isUrl(release.bundle)) await download(release.bundle, tarball, fetchImpl, o.progress);
      else writeFileSync(tarball, readFileSync(release.bundle));
    }
  }

  const sum = await sha256File(tarball);
  if (expected && sum !== expected) {
    if (!o.file) rmSync(tarball, { force: true });
    throw new Error(`The download does not match its checksum (got ${sum.slice(0, 16)}…, expected ${expected.slice(0, 16)}…): it was damaged or changed on the way. Nothing was changed; try again.`);
  }
  log(expected ? 'Checksum matches.' : `No checksum file next to it: SHA-256 ${sum} (compare it with the one published with the release).`);

  // Unpacked next to the running version, then swapped in whole: a half-unpacked bundle is never staged.
  const fresh = join(p.dir, 'staged.new');
  rmSync(fresh, { recursive: true, force: true });
  mkdirSync(fresh, { recursive: true });
  let root: string;
  let version: string;
  try {
    const tar = spawnSync('tar', ['-xzf', tarball, '-C', fresh, '--no-same-owner'], { encoding: 'utf8' });
    if (tar.status !== 0) throw new Error(`The bundle could not be unpacked: ${(tar.stderr || tar.error?.message || 'tar failed').trim().split('\n').slice(-2).join(' ')}`);
    const found = bundleRoot(fresh);
    if (!found) throw new Error('That is not an FBRX Server bundle (no install.sh, fbrx-virtual/server.mjs and VERSION inside)');
    root = found;
    version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
    if (!isValidSemver(version)) throw new Error(`The bundle has no proper version (${version || 'empty'})`);
    if (release.version && version !== release.version) throw new Error(`The bundle is FBRX Server ${version}, not ${release.version} as the release list says`);
  } catch (e) {
    rmSync(fresh, { recursive: true, force: true });
    throw e;
  }
  if (o.file && compareSemver(version, installed) <= 0 && !o.force) {
    rmSync(fresh, { recursive: true, force: true });
    return { state: 'current', installed, latest: version };
  }

  const stagedDir = join(p.dir, 'staged');
  rmSync(stagedDir, { recursive: true, force: true });
  renameSync(fresh, stagedDir);
  const bundleDir = join(stagedDir, root.slice(fresh.length + 1));
  const staged: StagedUpdate = {
    version,
    bundleDir,
    from: o.file ? tarball : release.bundle,
    sha256: sum,
    summary: (release.summary ?? '').replace(/\s+/g, ' ').trim(),
    notes: release.notes ?? [],
    stagedAt: new Date().toISOString(),
  };
  writeFileSync(
    join(p.dir, 'staged.env'),
    [`VERSION=${staged.version}`, `BUNDLE=${staged.bundleDir}`, `FROM=${staged.from}`, `SHA256=${staged.sha256}`, `SUMMARY=${staged.summary}`, `STAGED_AT=${staged.stagedAt}`, ''].join('\n'),
    { mode: 0o600 },
  );
  writeFileSync(join(p.dir, 'staged-notes.json'), JSON.stringify(staged.notes, null, 2), { mode: 0o600 });
  return { state: 'staged', installed, staged, already: false };
}
