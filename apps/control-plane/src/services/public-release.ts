import { RELEASE_MANIFEST_URL, RELEASE_REPO, ReleaseManifestSchema } from '@fbrx/shared';

/**
 * The FBRX OS release everyone can download: the version in the repository's release.json and the installers on its
 * GitHub release. Deploy & enroll offers it (and the Windows script installs it) when it is newer than the newest
 * stable release uploaded to this FBRX Command, so a computer set up today never gets an old version just because
 * nobody uploaded the new one here. Looked up at most every six hours; offline, there is simply none.
 */
export interface PublicRelease {
  version: string;
  page: string;
  files: Array<{ fileName: string; platform: 'win32' | 'darwin' | 'linux'; url: string; size: number }>;
}

const EVERY_MS = 6 * 60 * 60_000;
const AFTER_FAILURE_MS = 10 * 60_000;
let cached: { at: number; ttl: number; value: PublicRelease | null } | null = null;

/** The installers among a release's files, by the names the Release workflow gives them. */
export function installersOf(assets: Array<{ name: string; browser_download_url: string; size?: number }>): PublicRelease['files'] {
  const platformOf = (n: string): PublicRelease['files'][number]['platform'] | null =>
    /^FBRX-OS-.*\.exe$/i.test(n) ? 'win32' : /^FBRX-OS-.*\.dmg$/i.test(n) ? 'darwin' : /^FBRX-OS-.*\.(AppImage|deb)$/i.test(n) ? 'linux' : null;
  return assets.flatMap((a) => {
    const platform = platformOf(a.name);
    return platform ? [{ fileName: a.name, platform, url: a.browser_download_url, size: Number(a.size ?? 0) }] : [];
  });
}

export async function publicRelease(fetchImpl: typeof fetch = fetch): Promise<PublicRelease | null> {
  if (cached && Date.now() - cached.at < cached.ttl) return cached.value;
  try {
    const manifest = ReleaseManifestSchema.parse(await (await fetchImpl(RELEASE_MANIFEST_URL, { signal: AbortSignal.timeout(10_000) })).json());
    const res = await fetchImpl(`https://api.github.com/repos/${RELEASE_REPO}/releases/tags/v${manifest.version}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'FBRX-Command' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const body = (await res.json()) as { assets?: Array<{ name: string; browser_download_url: string; size?: number }> };
    const files = installersOf(body.assets ?? []);
    const value = files.length ? { version: manifest.version, page: manifest.page, files } : null;
    cached = { at: Date.now(), ttl: EVERY_MS, value };
    return value;
  } catch {
    cached = { at: Date.now(), ttl: AFTER_FAILURE_MS, value: cached?.value ?? null };
    return cached.value;
  }
}

/** Tests start from nothing. */
export function forgetPublicRelease(): void {
  cached = null;
}
