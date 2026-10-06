import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IsoDownload, IsoImage } from '@fbrx/shared';
import { badRequest, conflict, errorMessage, notFound, VirtualError } from './errors';

export const ISO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+()-]{0,150}\.(?:iso|img)$/i;

/** The ISO library: installer images people upload or have the server download, for virtual CD drives. */
export class IsoLibrary {
  private readonly downloads = new Map<string, IsoDownload & { abort: AbortController }>();

  constructor(
    readonly dir: string,
    private readonly maxBytes: number,
    private readonly onChange: () => Promise<void> = async () => undefined,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  list(): IsoImage[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => ISO_NAME_RE.test(f))
        .map((name) => {
          const st = statSync(join(this.dir, name));
          return { name, path: join(this.dir, name), sizeBytes: st.size, modifiedAt: st.mtime.toISOString() };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  /** The full path of a library ISO (it must exist). */
  path(name: string): string {
    if (!ISO_NAME_RE.test(name)) throw badRequest('ISO names end in .iso or .img and use letters, digits, dots, dashes, underscores, plus signs and brackets');
    const p = join(this.dir, name);
    if (!existsSync(p)) throw notFound(`${name} is not in the ISO library`);
    return p;
  }

  /** Library names of a full path (null when it is not in the library). */
  nameOf(path: string | null): string | null {
    if (!path) return null;
    const rel = relative(this.dir, path);
    return rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(sep) && !rel.includes('/') ? rel : null;
  }

  private checkNew(name: string) {
    if (!ISO_NAME_RE.test(name)) throw badRequest('ISO names end in .iso or .img and use letters, digits, dots, dashes, underscores, plus signs and brackets');
    if (existsSync(join(this.dir, name))) throw conflict(`${name} is already in the library`);
    if ([...this.downloads.values()].some((d) => d.name === name && d.state === 'running')) throw conflict(`${name} is already downloading`);
  }

  private limiter(onBytes: (n: number) => void) {
    let total = 0;
    const max = this.maxBytes;
    return new Transform({
      transform(chunk: Buffer, _enc, cb) {
        total += chunk.length;
        onBytes(total);
        if (total > max) cb(new VirtualError(413, `ISO images up to ${Math.round(max / 1024 ** 3)} GB`));
        else cb(null, chunk);
      },
    });
  }

  /** Saves an uploaded image (streamed to disk under a temporary name, renamed when complete). */
  async upload(name: string, body: NodeJS.ReadableStream): Promise<IsoImage> {
    this.checkNew(name);
    const part = join(this.dir, `.${name}.part`);
    try {
      await pipeline(body, this.limiter(() => undefined), createWriteStream(part));
      renameSync(part, join(this.dir, name));
    } catch (e) {
      rmSync(part, { force: true });
      throw e;
    }
    await this.onChange();
    return this.list().find((i) => i.name === name)!;
  }

  /** Starts downloading an image from the internet in the background. */
  download(url: string, name: string, fetcher: typeof fetch = fetch): IsoDownload {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw badRequest('That is not a web address');
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw badRequest('Downloads use http:// or https://');
    this.checkNew(name);
    const abort = new AbortController();
    const d: IsoDownload & { abort: AbortController } = { id: randomUUID(), name, url: u.toString(), received: 0, total: null, state: 'running', error: null, abort };
    this.downloads.set(d.id, d);
    const part = join(this.dir, `.${name}.part`);
    void (async () => {
      try {
        const res = await fetcher(u, { signal: abort.signal, redirect: 'follow' });
        if (!res.ok || !res.body) throw new Error(`The server answered ${res.status}`);
        const len = Number(res.headers.get('content-length'));
        d.total = Number.isFinite(len) && len > 0 ? len : null;
        if (d.total && d.total > this.maxBytes) throw new Error(`It is ${Math.round(d.total / 1024 ** 3)} GB; the limit is ${Math.round(this.maxBytes / 1024 ** 3)} GB`);
        await pipeline(Readable.fromWeb(res.body as never), this.limiter((n) => (d.received = n)), createWriteStream(part), { signal: abort.signal });
        renameSync(part, join(this.dir, name));
        d.state = 'done';
        await this.onChange().catch(() => undefined);
      } catch (e) {
        rmSync(part, { force: true });
        d.state = abort.signal.aborted ? 'cancelled' : 'failed';
        d.error = abort.signal.aborted ? null : errorMessage(e);
      }
    })();
    return this.view(d);
  }

  private view(d: IsoDownload & { abort?: AbortController }): IsoDownload {
    const { abort: _a, ...rest } = d;
    return { ...rest };
  }

  listDownloads(): IsoDownload[] {
    return [...this.downloads.values()].map((d) => this.view(d)).reverse();
  }

  cancelDownload(id: string): void {
    const d = this.downloads.get(id);
    if (!d) throw notFound('No such download');
    if (d.state === 'running') d.abort.abort();
    else this.downloads.delete(id);
  }

  async remove(name: string): Promise<void> {
    rmSync(this.path(name));
    await this.onChange();
  }

  stop(): void {
    for (const d of this.downloads.values()) if (d.state === 'running') d.abort.abort();
  }
}
