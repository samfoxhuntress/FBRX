import { VirtualError, notFound } from './errors';

/**
 * Quick downloads for the ISO library: the major operating systems' installers, one click each. The server reads the
 * publisher's SHA256SUMS each time, so it takes the newest point release (26.04.1, then 26.04.2…) without a FBRX
 * update, and checks the image it downloaded against the checksum listed there.
 */
export interface IsoCatalogEntry {
  id: string;
  name: string;
  note: string;
  arch: 'amd64' | 'arm64';
  /** The publisher's SHA256SUMS; the image is in the same folder. */
  sums: string;
  /** The image's file name in SHA256SUMS; the first group is the point release (none: the first release). */
  file: RegExp;
}

const UBUNTU = 'https://releases.ubuntu.com/26.04/SHA256SUMS';
// Ubuntu's ARM images are on its cdimage server.
const UBUNTU_ARM = 'https://cdimage.ubuntu.com/ubuntu/releases/26.04/release/SHA256SUMS';

export const ISO_CATALOG: IsoCatalogEntry[] = [
  { id: 'ubuntu-26.04-desktop', name: 'Ubuntu 26.04 LTS Desktop', note: 'Ubuntu with its desktop, for a VM you use on screen', arch: 'amd64', sums: UBUNTU, file: /^ubuntu-26\.04(?:\.(\d+))?-desktop-amd64\.iso$/ },
  { id: 'ubuntu-26.04-server', name: 'Ubuntu 26.04 LTS Server', note: 'Ubuntu without a desktop, for servers and services', arch: 'amd64', sums: UBUNTU, file: /^ubuntu-26\.04(?:\.(\d+))?-live-server-amd64\.iso$/ },
  { id: 'ubuntu-26.04-desktop', name: 'Ubuntu 26.04 LTS Desktop', note: 'Ubuntu with its desktop, for a VM you use on screen', arch: 'arm64', sums: UBUNTU_ARM, file: /^ubuntu-26\.04(?:\.(\d+))?-desktop-arm64\.iso$/ },
  { id: 'ubuntu-26.04-server', name: 'Ubuntu 26.04 LTS Server', note: 'Ubuntu without a desktop, for servers and services', arch: 'arm64', sums: UBUNTU_ARM, file: /^ubuntu-26\.04(?:\.(\d+))?-live-server-arm64\.iso$/ },
];

/** The quick downloads for this server's processor (a VM runs the same kind). */
export function isoCatalog(arch: string = process.arch): IsoCatalogEntry[] {
  const a = arch === 'arm64' ? 'arm64' : 'amd64';
  return ISO_CATALOG.filter((e) => e.arch === a);
}

/** Where the newest image of an entry is, and its checksum, from the publisher's SHA256SUMS. */
export async function resolveIso(e: IsoCatalogEntry, fetcher: typeof fetch = fetch): Promise<{ url: string; name: string; sha256: string }> {
  const res = await fetcher(e.sums, { signal: AbortSignal.timeout(20_000), redirect: 'follow' }).catch(() => null);
  if (!res?.ok) throw new VirtualError(502, `Could not reach ${new URL(e.sums).host} to find the newest ${e.name}`);
  const text = (await res.text()).slice(0, 256 * 1024);
  let best: { name: string; sha256: string; point: number } | null = null;
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64}) [ *](\S+)\s*$/i.exec(line.trim());
    const f = m ? e.file.exec(m[2]) : null;
    if (!m || !f) continue;
    const point = Number(f[1] ?? 0);
    if (!best || point > best.point) best = { name: m[2], sha256: m[1].toLowerCase(), point };
  }
  if (!best) throw notFound(`${e.name} is not listed at ${new URL(e.sums).host} right now`);
  return { url: new URL(best.name, e.sums).toString(), name: best.name, sha256: best.sha256 };
}
