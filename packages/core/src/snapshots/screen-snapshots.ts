import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync, type Stats } from 'node:fs';
import { basename, join } from 'node:path';
import { SNAPSHOT_LIST_LIMIT, SNAPSHOT_MAX_BYTES, snapshotName, type ScreenSnapshot } from '@fbrx/shared';
import { CoreError } from '../errors';
import type { EventBus } from '../events';
import type { Logger } from '../logger';
import type { ImageTools } from '../platform';
import { formatBytes } from '../util/misc';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const view = (dir: string, id: string, st: Stats): ScreenSnapshot => ({ id, path: join(dir, id), size: st.size, createdAt: st.mtime.toISOString() });

/**
 * FBRX Snapshot's folder: the PNG files of the screen snapshots the desktop app takes and the person marks up. Only the
 * person reaches them (the agent sees one when it is attached to a chat), and a name is only ever a file in the folder.
 */
export class ScreenSnapshots {
  constructor(private readonly d: { folder: () => string; events: EventBus; log: Logger; images: () => ImageTools | null | undefined }) {}

  folder(): string {
    return this.d.folder();
  }

  /** The newest snapshots first. */
  async list(): Promise<ScreenSnapshot[]> {
    const dir = this.folder();
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => /\.png$/i.test(n));
    const found = await Promise.all(
      names.map(async (n) => {
        const st = await stat(join(dir, n)).catch(() => null);
        return st?.isFile() ? view(dir, n, st) : null;
      }),
    );
    return found
      .filter((s): s is ScreenSnapshot => !!s)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, SNAPSHOT_LIST_LIMIT);
  }

  /** The path of a snapshot in the folder; a name that reaches outside it, or is not a PNG, is refused. */
  private file(id: string): string {
    if (!id || basename(id) !== id || !/\.png$/i.test(id)) throw new CoreError('INVALID_ARGUMENT', 'That is not a snapshot');
    const file = join(this.folder(), id);
    if (!existsSync(file)) throw new CoreError('NOT_FOUND', 'That snapshot is gone');
    return file;
  }

  /** A snapshot's picture: the PNG itself, or a small JPEG of it (`size` pixels at most) where the app can make one. */
  async read(id: string, size?: number): Promise<{ mime: string; data: string }> {
    const data = await readFile(this.file(id));
    const images = size ? this.d.images() : null;
    if (images && size) return { mime: 'image/jpeg', data: images.thumbnail(data, size).toString('base64') };
    return { mime: 'image/png', data: data.toString('base64') };
  }

  /** Saves a PNG: over the snapshot `id` (marked up), or as a new one named for when it was taken. */
  async save(data: Buffer, id?: string): Promise<ScreenSnapshot> {
    if (!data.subarray(0, 8).equals(PNG_SIGNATURE)) throw new CoreError('INVALID_ARGUMENT', 'A snapshot is a PNG picture');
    if (data.length > SNAPSHOT_MAX_BYTES) throw new CoreError('INVALID_ARGUMENT', `A snapshot is at most ${formatBytes(SNAPSHOT_MAX_BYTES)}`);
    const dir = this.folder();
    let file: string;
    if (id) file = this.file(id);
    else {
      await mkdir(dir, { recursive: true });
      const base = snapshotName(new Date());
      file = join(dir, `${base}.png`);
      for (let n = 2; existsSync(file); n++) file = join(dir, `${base} (${n}).png`);
    }
    // Written beside it, then moved over it: a snapshot is never left half-written.
    const part = `${file}.part`;
    await writeFile(part, data);
    await rename(part, file);
    const saved = view(dir, basename(file), await stat(file));
    this.d.log.info(id ? 'Snapshot saved' : 'Snapshot taken', { file: saved.id, size: saved.size });
    this.d.events.emit('snapshots.changed', { id: saved.id });
    return saved;
  }

  async remove(id: string): Promise<{ removed: boolean }> {
    await unlink(this.file(id));
    this.d.events.emit('snapshots.changed', { id });
    return { removed: true };
  }
}
