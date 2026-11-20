import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FBRX_APPS, RELEASE_REPO, type AppId } from '@fbrx/shared';
import { CoreError } from '../errors';

/** The largest installer FBRX downloads (an app's installer is a few hundred MB at most). */
const MAX_BYTES = 800 * 1024 * 1024;

/** Where an installer may come from: GitHub's API and its release downloads. */
const ALLOWED_HOSTS = new Set(['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
  /** "sha256:<hex>" as GitHub gives it, when it does. */
  digest: string | null;
}

/**
 * The installer an app's release has for this computer: on Windows its setup program, on a Mac the disk image for the
 * processor, on Linux the AppImage for the processor (it runs as it is, without installing anything as root).
 */
export function pickInstaller(id: AppId, assets: ReleaseAsset[], platform: NodeJS.Platform = process.platform, arch: string = process.arch): ReleaseAsset | null {
  const stem = FBRX_APPS[id].name.replace(/\s+/g, '-');
  const mine = assets.filter((a) => a.name.startsWith(`${stem}-`));
  const archOf = (n: string) => (/(arm64|aarch64)/i.test(n) ? 'arm64' : /(x64|x86_64|amd64)/i.test(n) ? 'x64' : null);
  const fits = (n: string) => (archOf(n) ?? 'x64') === (arch === 'arm64' ? 'arm64' : 'x64');
  if (platform === 'win32') return mine.find((a) => /-Setup-[\d.]+\.exe$/i.test(a.name)) ?? null;
  if (platform === 'darwin') return mine.find((a) => /\.dmg$/i.test(a.name) && fits(a.name)) ?? null;
  if (platform === 'linux') return mine.find((a) => /\.AppImage$/.test(a.name) && fits(a.name)) ?? null;
  return null;
}

export interface InstallerDeps {
  /** The release's tag for the version wanted (digger-v1.3.0). */
  tag: string;
  /** Where the installer is saved: the person's Downloads folder (a Linux AppImage goes to ~/Applications). */
  downloads: string;
  home: string;
  fetch?: typeof fetch;
  /** Opens what was downloaded (tests pass a fake). */
  open?: (file: string) => void;
  platform?: NodeJS.Platform;
  arch?: string;
}

/** Opens a downloaded installer the way the system does: the setup program, the disk image, the AppImage itself. */
function openInstaller(file: string, platform: NodeJS.Platform): void {
  const [cmd, args] = platform === 'darwin' ? ['open', [file]] : [file, []];
  const child = spawn(cmd, args as string[], { detached: true, stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
}

/**
 * Gets an app (the person at the computer asked, with an edition that unlocks it): finds the installer for this
 * computer in the app's GitHub release, downloads it from GitHub only, checks it against the checksum GitHub publishes
 * for it, saves it and opens it. Returns where it is.
 */
export async function downloadAndOpen(id: AppId, d: InstallerDeps): Promise<{ file: string; name: string }> {
  const get = d.fetch ?? fetch;
  const platform = d.platform ?? process.platform;
  const fromGitHub = (u: string) => {
    const host = new URL(u).hostname;
    if (!ALLOWED_HOSTS.has(host)) throw new CoreError('FORBIDDEN', `Installers are only taken from GitHub (not ${host})`);
    return u;
  };
  const rel = await get(fromGitHub(`https://api.github.com/repos/${RELEASE_REPO}/releases/tags/${encodeURIComponent(d.tag)}`), { headers: { accept: 'application/vnd.github+json', 'user-agent': 'FBRX' }, signal: AbortSignal.timeout(20_000) });
  if (!rel.ok) throw new CoreError('NOT_FOUND', `${FBRX_APPS[id].name}'s release ${d.tag} was not found (GitHub answered ${rel.status})`);
  const body = (await rel.json()) as { assets?: Array<{ name?: unknown; browser_download_url?: unknown; size?: unknown; digest?: unknown }> };
  const assets: ReleaseAsset[] = (body.assets ?? [])
    .filter((a) => typeof a.name === 'string' && typeof a.browser_download_url === 'string')
    .map((a) => ({ name: a.name as string, url: a.browser_download_url as string, size: typeof a.size === 'number' ? a.size : 0, digest: typeof a.digest === 'string' ? a.digest : null }));
  const asset = pickInstaller(id, assets, platform, d.arch ?? process.arch);
  if (!asset) throw new CoreError('NOT_FOUND', `${FBRX_APPS[id].name} has no installer for this computer in ${d.tag}`);
  if (asset.size > MAX_BYTES) throw new CoreError('INVALID_ARGUMENT', 'That installer is larger than an FBRX app should be');
  const res = await get(fromGitHub(asset.url), { headers: { 'user-agent': 'FBRX' }, signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok) throw new CoreError('UNAVAILABLE', `The download answered ${res.status}`);
  if (res.url) fromGitHub(res.url);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES || (asset.size && bytes.length !== asset.size)) throw new CoreError('INVALID_ARGUMENT', 'The download is not the size GitHub lists for it');
  // The checksum GitHub lists for the file, or else the one in the release's SHA256SUMS.txt; without one it is not
  // opened.
  let want = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? '')?.[1]?.toLowerCase();
  const sums = assets.find((a) => a.name === 'SHA256SUMS.txt');
  if (!want && sums) {
    const r = await get(fromGitHub(sums.url), { headers: { 'user-agent': 'FBRX' }, signal: AbortSignal.timeout(30_000) });
    if (r.ok) want = new RegExp(`^([0-9a-f]{64})\\s+\\*?${asset.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'im').exec(await r.text())?.[1]?.toLowerCase();
  }
  if (!want) throw new CoreError('UNAVAILABLE', 'The release lists no checksum for that installer, so it was not opened');
  if (createHash('sha256').update(bytes).digest('hex') !== want) throw new CoreError('INVALID_ARGUMENT', 'The download does not match the checksum GitHub publishes for it: it was not opened');
  const dir = platform === 'linux' ? join(d.home, 'Applications') : d.downloads;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, asset.name);
  writeFileSync(file, bytes, { mode: platform === 'linux' ? 0o755 : 0o644 });
  if (platform === 'linux') chmodSync(file, 0o755);
  (d.open ?? ((f: string) => openInstaller(f, platform)))(file);
  return { file, name: asset.name };
}
