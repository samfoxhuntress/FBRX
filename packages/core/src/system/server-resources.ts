import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import type { ServerResourceFile, ServerResourcesInfo } from '@fbrx/shared';
import { CoreError } from '../errors';

interface Manifest {
  version?: string;
  builtAt?: string;
  files?: Array<{ name: string; kind: string; title: string; description: string | null; size: number; sha256: string }>;
}

const KINDS = new Set(['iso', 'bundle', 'doc']);

/**
 * The FBRX Server resources that travel inside FBRX Endpoint for now (scripts/server/endpoint-resources.mjs): the
 * installer ISO, the server bundle and the guides, in the app's resources/server folder.
 */
export class ServerResources {
  constructor(
    private readonly resourcesDir: string | null,
    private readonly downloadsDir: () => string,
  ) {}

  private get dir(): string | null {
    return this.resourcesDir ? join(this.resourcesDir, 'server') : null;
  }

  private manifest(): Manifest | null {
    const dir = this.dir;
    if (!dir || !existsSync(join(dir, 'manifest.json'))) return null;
    try {
      return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
    } catch {
      return null;
    }
  }

  info(): ServerResourcesInfo {
    const m = this.manifest();
    const dir = this.dir;
    if (!m || !dir) return { available: false, version: null, builtAt: null, dir: null, iso: false, files: [] };
    const files: ServerResourceFile[] = (m.files ?? [])
      .filter((f) => typeof f.name === 'string' && this.inside(f.name, dir) && existsSync(this.pathOf(f.name, dir)))
      .map((f) => ({
        name: f.name,
        kind: (KINDS.has(f.kind) ? f.kind : 'other') as ServerResourceFile['kind'],
        title: String(f.title ?? f.name),
        description: f.description ?? null,
        size: statSync(this.pathOf(f.name, dir)).size,
        sha256: typeof f.sha256 === 'string' ? f.sha256 : null,
        path: this.pathOf(f.name, dir),
      }));
    return { available: true, version: m.version ?? null, builtAt: m.builtAt ?? null, dir, iso: files.some((f) => f.kind === 'iso'), files };
  }

  private inside(name: string, dir: string): boolean {
    return resolve(dir, name).startsWith(resolve(dir) + sep);
  }

  /** A file listed in the manifest (and only those). */
  private pathOf(name: string, dir = this.dir): string {
    if (!dir) throw new CoreError('NOT_FOUND', 'This copy of FBRX has no FBRX Server resources');
    const p = resolve(dir, name);
    if (!p.startsWith(resolve(dir) + sep)) throw new CoreError('INVALID_ARGUMENT', 'Not a server resource');
    return p;
  }

  private file(name: string): ServerResourceFile {
    const f = this.info().files.find((x) => x.name === name);
    if (!f) throw new CoreError('NOT_FOUND', `${name} is not among the FBRX Server resources`);
    return f;
  }

  /** Recomputes the fingerprint and compares it with the one recorded when the installer was made. */
  async verify(name: string): Promise<{ ok: boolean; sha256: string; expected: string | null }> {
    const f = this.file(name);
    const sha256 = await new Promise<string>((res, rej) => {
      const h = createHash('sha256');
      createReadStream(f.path)
        .on('data', (d) => h.update(d))
        .on('end', () => res(h.digest('hex')))
        .on('error', rej);
    });
    return { ok: !!f.sha256 && f.sha256 === sha256, sha256, expected: f.sha256 };
  }

  /** Copies a resource to Downloads (a new name when one is there already). */
  async copy(name: string): Promise<{ path: string }> {
    const f = this.file(name);
    const dest = this.downloadsDir();
    mkdirSync(dest, { recursive: true });
    const base = basename(f.name);
    const ext = extname(base);
    let target = join(dest, base);
    for (let i = 2; existsSync(target); i++) target = join(dest, `${base.slice(0, base.length - ext.length)} (${i})${ext}`);
    await copyFile(f.path, target);
    return { path: target };
  }

  /** A guide's text (Markdown). */
  readDoc(name: string): { text: string } {
    const f = this.file(name);
    if (f.kind !== 'doc') throw new CoreError('INVALID_ARGUMENT', 'Only guides can be read here');
    return { text: readFileSync(f.path, 'utf8') };
  }
}
