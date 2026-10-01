import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { unzip } from '../../util/unzip';

export interface RuntimeInstallOptions {
  /** Install root; files land in `<destDir>/<platform>-<arch>/`. */
  destDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** llama.cpp release tag (e.g. b6600); latest when omitted. */
  tag?: string;
  githubToken?: string;
  /** Windows/Linux: `cpu` (portable) or `vulkan` (GPU acceleration on most hardware). */
  variant?: 'cpu' | 'vulkan';
  onProgress?: (received: number, total: number, phase: 'downloading' | 'extracting') => void;
  signal?: AbortSignal;
}

const EXE = (platform: string) => (platform === 'win32' ? 'llama-server.exe' : 'llama-server');

/** Picks the official llama.cpp release asset for an OS/CPU. */
export function selectRuntimeAsset(assets: Array<{ name: string; browser_download_url: string; size: number }>, platform: string, arch: string, variant: 'cpu' | 'vulkan' = 'cpu') {
  const a = arch === 'arm64' ? 'arm64' : 'x64';
  const ext = String.raw`\.(zip|tar\.gz)$`;
  const patterns: RegExp[] =
    platform === 'darwin'
      ? [new RegExp(`bin-macos-${a}${ext}`)]
      : platform === 'win32'
        ? [new RegExp(`bin-win-${variant}-${a}${ext}`), new RegExp(`bin-win-cpu-${a}${ext}`)]
        : [new RegExp(`bin-ubuntu-${variant === 'vulkan' ? 'vulkan-' : ''}${a}${ext}`), new RegExp(`bin-ubuntu-${a}${ext}`)];
  for (const re of patterns) {
    const hit = assets.find((x) => re.test(x.name));
    if (hit) return hit;
  }
  return null;
}

function findBinary(dir: string, exe: string, depth = 4): string | null {
  if (!existsSync(dir)) return null;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name === exe) return p;
    if (e.isDirectory() && depth > 0) {
      const hit = findBinary(p, exe, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** Downloads and installs llama.cpp's `llama-server` for the current (or given) platform. */
export async function installLlamaRuntime(o: RuntimeInstallOptions): Promise<{ binary: string; tag: string; asset: string }> {
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'fbrx-os-runtime-installer' };
  if (o.githubToken) headers.authorization = `Bearer ${o.githubToken}`;
  const releaseUrl = `https://api.github.com/repos/ggml-org/llama.cpp/releases/${o.tag ? `tags/${o.tag}` : 'latest'}`;
  const rel = await fetch(releaseUrl, { headers, signal: o.signal ?? AbortSignal.timeout(30_000) });
  if (!rel.ok) throw new Error(`Could not query llama.cpp releases (HTTP ${rel.status})${rel.status === 403 ? ' — GitHub rate limit; try again later or set GITHUB_TOKEN' : ''}`);
  const release = (await rel.json()) as { tag_name: string; assets: Array<{ name: string; browser_download_url: string; size: number }> };
  const asset = selectRuntimeAsset(release.assets, platform, arch, o.variant);
  if (!asset) throw new Error(`No llama.cpp build for ${platform}-${arch} in release ${release.tag_name}`);

  const target = join(o.destDir, `${platform}-${arch}`);
  const tmp = join(o.destDir, `.download-${Date.now()}-${asset.name}`);
  mkdirSync(o.destDir, { recursive: true });
  try {
    const res = await fetch(asset.browser_download_url, { headers: { 'user-agent': headers['user-agent'] }, signal: o.signal });
    if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
    const total = Number(res.headers.get('content-length') ?? asset.size ?? 0);
    let received = 0;
    let last = 0;
    await pipeline(
      Readable.fromWeb(res.body as never),
      async function* (src: AsyncIterable<Buffer>) {
        for await (const chunk of src) {
          received += chunk.length;
          if (Date.now() - last > 300) {
            last = Date.now();
            o.onProgress?.(received, total, 'downloading');
          }
          yield chunk;
        }
      },
      createWriteStream(tmp),
    );
    o.onProgress?.(received, total, 'extracting');
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    if (asset.name.endsWith('.zip')) unzip(tmp, target);
    else await tar.x({ file: tmp, cwd: target, strict: true });
    const binary = findBinary(target, EXE(platform));
    if (!binary || statSync(binary).size < 1024) throw new Error('llama-server was not found in the downloaded archive');
    if (platform !== 'win32') chmodSync(binary, 0o755);
    return { binary, tag: release.tag_name, asset: asset.name };
  } finally {
    rmSync(tmp, { force: true });
  }
}
