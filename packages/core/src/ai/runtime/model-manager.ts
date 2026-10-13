import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs';
import { copyFile, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { slugify } from '../../util/misc';
import type { CatalogModel, DownloadProgress, InstalledModel } from '@fbrx/shared';
import { CoreError } from '../../errors';
import type { Db } from '../../storage/db';
import type { EventBus } from '../../events';
import type { Logger } from '../../logger';
import { MODEL_CATALOG } from './catalog';

interface ModelRow {
  id: string;
  name: string;
  file: string;
  size_bytes: number;
  sha256: string | null;
  source: 'catalog' | 'imported';
  installed_at: string;
}

/** Downloads, verifies, imports and tracks GGUF model files under `<data>/models`. */
export class ModelManager {
  private downloads = new Map<string, { controller: AbortController; progress: DownloadProgress }>();

  constructor(
    private readonly db: Db,
    private readonly dir: string,
    private readonly activeModelId: () => string,
    private readonly log: Logger,
    private readonly events?: EventBus,
  ) {}

  catalog(): CatalogModel[] {
    return MODEL_CATALOG;
  }

  installed(): InstalledModel[] {
    const active = this.activeModelId();
    return this.db
      .all<ModelRow>('SELECT * FROM models ORDER BY installed_at DESC')
      .filter((r) => existsSync(join(this.dir, r.file)))
      .map((r) => ({
        id: r.id,
        name: r.name,
        file: join(this.dir, r.file),
        sizeBytes: Number(r.size_bytes),
        installedAt: r.installed_at,
        sha256: r.sha256,
        source: r.source,
        active: r.id === active,
      }));
  }

  /**
   * Catalog models whose file is already in the models folder but not recorded ("Install FBRX OS" downloads the
   * starter model there while it builds the app): recorded now, with their checksum. Unfinished (.part) files are not.
   */
  async adopt(): Promise<InstalledModel[]> {
    const adopted: InstalledModel[] = [];
    for (const entry of MODEL_CATALOG) {
      const fileName = basename(new URL(entry.url).pathname);
      const file = join(this.dir, fileName);
      if (!existsSync(file) || this.db.get('SELECT 1 FROM models WHERE id = ?', entry.id)) continue;
      const size = (await stat(file)).size;
      // Far smaller than the model: not a whole file.
      if (size < entry.sizeBytes * 0.9) continue;
      const sha256 = await sha256File(file);
      if (entry.sha256 && entry.sha256 !== sha256) {
        this.log.warn('A model file in the models folder does not match its checksum; left alone', { model: entry.id });
        continue;
      }
      this.db.run('INSERT OR REPLACE INTO models (id, name, file, size_bytes, sha256, source, installed_at) VALUES (?,?,?,?,?,?,?)', entry.id, entry.name, fileName, size, sha256, 'catalog', new Date().toISOString());
      adopted.push(this.get(entry.id)!);
    }
    return adopted;
  }

  get(id: string): InstalledModel | undefined {
    return this.installed().find((m) => m.id === id);
  }

  activeDownloads(): DownloadProgress[] {
    return [...this.downloads.values()].map((d) => d.progress);
  }

  /** Starts a background download. Progress is published on the `runtime.download` event. */
  download(modelId: string): void {
    const entry = MODEL_CATALOG.find((m) => m.id === modelId);
    if (!entry) throw new CoreError('NOT_FOUND', `Unknown catalog model ${modelId}`);
    if (this.downloads.has(modelId)) throw new CoreError('CONFLICT', 'Download already in progress');
    if (this.get(modelId)) throw new CoreError('ALREADY_EXISTS', 'Model is already installed');
    const controller = new AbortController();
    const progress: DownloadProgress = { modelId, receivedBytes: 0, totalBytes: entry.sizeBytes, state: 'downloading' };
    this.downloads.set(modelId, { controller, progress });
    void this.runDownload(entry, controller, progress).finally(() => this.downloads.delete(modelId));
  }

  cancel(modelId: string): boolean {
    const d = this.downloads.get(modelId);
    if (!d) return false;
    d.controller.abort();
    return true;
  }

  /** How the last downloads ended, kept a few minutes for screens that look now and then (FBRX Server's console). */
  private finished = new Map<string, { progress: DownloadProgress; at: number }>();

  private emit(p: DownloadProgress) {
    if (p.state === 'completed' || p.state === 'failed' || p.state === 'cancelled') this.finished.set(p.modelId, { progress: { ...p }, at: Date.now() });
    this.events?.emit('runtime.download', { ...p });
  }

  /** Downloads under way, and the ones that ended in the last ten minutes. */
  recentDownloads(): DownloadProgress[] {
    const since = Date.now() - 10 * 60_000;
    for (const [id, f] of this.finished) if (f.at < since) this.finished.delete(id);
    return [...this.activeDownloads(), ...[...this.finished.values()].filter((f) => !this.downloads.has(f.progress.modelId)).map((f) => f.progress)];
  }

  private async runDownload(entry: CatalogModel, controller: AbortController, progress: DownloadProgress) {
    const fileName = basename(new URL(entry.url).pathname);
    const final = join(this.dir, fileName);
    const part = `${final}.part`;
    try {
      let offset = existsSync(part) ? statSync(part).size : 0;
      const res = await fetch(entry.url, {
        headers: offset ? { range: `bytes=${offset}-` } : {},
        signal: controller.signal,
        redirect: 'follow',
      });
      if (res.status === 200) offset = 0;
      else if (res.status !== 206) throw new Error(`Download failed: HTTP ${res.status}`);
      if (!res.body) throw new Error('Empty response');
      const len = Number(res.headers.get('content-length') ?? 0);
      progress.totalBytes = len ? len + offset : entry.sizeBytes;
      progress.receivedBytes = offset;
      let lastEmit = 0;
      const counter = new Transform({
        transform: (chunk: Buffer, _enc, cb) => {
          progress.receivedBytes += chunk.length;
          const now = Date.now();
          if (now - lastEmit > 500) {
            lastEmit = now;
            this.emit(progress);
          }
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body as any), counter, createWriteStream(part, { flags: offset ? 'a' : 'w' }), { signal: controller.signal });
      // A connection that ends early leaves a short file the runtime cannot load: keep it to resume, and say so.
      const got = (await stat(part)).size;
      if (len && got < len + offset) throw new Error(`The download stopped early (${Math.round(got / 1e6)} of ${Math.round((len + offset) / 1e6)} MB). Download again to continue where it stopped.`);
      progress.state = 'verifying';
      this.emit(progress);
      const sha256 = await sha256File(part);
      if (entry.sha256 && entry.sha256 !== sha256) {
        await rm(part, { force: true });
        throw new Error('Checksum mismatch: the downloaded file is corrupt or was tampered with');
      }
      await rename(part, final);
      this.db.run(
        'INSERT OR REPLACE INTO models (id, name, file, size_bytes, sha256, source, installed_at) VALUES (?,?,?,?,?,?,?)',
        entry.id,
        entry.name,
        fileName,
        (await stat(final)).size,
        sha256,
        'catalog',
        new Date().toISOString(),
      );
      progress.state = 'completed';
      this.emit(progress);
      this.log.info('Model downloaded', { model: entry.id, sha256 });
    } catch (err) {
      progress.state = controller.signal.aborted ? 'cancelled' : 'failed';
      progress.error = controller.signal.aborted ? undefined : (err as Error).message;
      this.emit(progress);
      if (!controller.signal.aborted) this.log.error('Model download failed', { model: entry.id, error: (err as Error).message });
    }
  }

  async import(path: string, name?: string): Promise<InstalledModel> {
    if (!path.toLowerCase().endsWith('.gguf')) throw new CoreError('INVALID_ARGUMENT', 'Only .gguf model files can be imported');
    const s = await stat(path).catch(() => null);
    if (!s?.isFile()) throw new CoreError('NOT_FOUND', `File not found: ${path}`);
    const fileName = basename(path);
    const dest = join(this.dir, fileName);
    if (!existsSync(dest)) await copyFile(path, dest);
    const id = `imported-${slugify(fileName.replace(/\.gguf$/i, ''), 48)}`;
    this.db.run(
      'INSERT OR REPLACE INTO models (id, name, file, size_bytes, sha256, source, installed_at) VALUES (?,?,?,?,?,?,?)',
      id,
      name ?? fileName.replace(/\.gguf$/i, ''),
      fileName,
      s.size,
      await sha256File(dest),
      'imported',
      new Date().toISOString(),
    );
    return this.get(id)!;
  }

  /** A damaged download: the file goes (even for the model in use) and the same model downloads again. */
  async redownload(id: string): Promise<void> {
    const row = this.db.get<ModelRow>('SELECT * FROM models WHERE id = ?', id);
    if (!MODEL_CATALOG.some((m) => m.id === id)) throw new CoreError('INVALID_ARGUMENT', row ? 'Imported models cannot be downloaded again: import the file again' : `Unknown catalog model ${id}`);
    if (row) {
      await rm(join(this.dir, row.file), { force: true });
      await rm(join(this.dir, `${row.file}.part`), { force: true });
      this.db.run('DELETE FROM models WHERE id = ?', id);
    }
    this.download(id);
  }

  async remove(id: string): Promise<boolean> {
    const row = this.db.get<ModelRow>('SELECT * FROM models WHERE id = ?', id);
    if (!row) return false;
    if (this.activeModelId() === id) throw new CoreError('CONFLICT', 'Select a different model before deleting the active one');
    await rm(join(this.dir, row.file), { force: true });
    this.db.run('DELETE FROM models WHERE id = ?', id);
    return true;
  }
}

/** SHA-256 of a file. Resolves once the file is closed again, so Windows lets the caller move or delete it. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('close', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}
