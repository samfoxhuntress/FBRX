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
import type { MetaStore } from '../../storage/meta';
import { MODEL_CATALOG } from './catalog';
import { parseHfRef, partNames, resolveHfModel, type ModelFile } from './hf';

/** Where the models added from Hugging Face are kept (in the meta store), and how many may be. */
const ADDED_KEY = 'models.added';
const ADDED_MAX = 24;
const GB = (n: number) => `${Math.ceil(n / 1e9)} GB`;

interface ModelRow {
  id: string;
  name: string;
  file: string;
  size_bytes: number;
  sha256: string | null;
  source: 'catalog' | 'imported';
  installed_at: string;
}

/**
 * Downloads, verifies, imports and tracks GGUF model files under `<data>/models`. A big model can come in several
 * parts: the first part is the model's file (llama.cpp finds the others beside it) and every part is downloaded and
 * checked.
 */
export class ModelManager {
  private downloads = new Map<string, { controller: AbortController; progress: DownloadProgress }>();

  constructor(
    private readonly db: Db,
    private readonly dir: string,
    private readonly activeModelId: () => string,
    private readonly log: Logger,
    private readonly events?: EventBus,
    private readonly o: {
      /** Keeps the models added from Hugging Face. */
      meta?: MetaStore;
      /** Free space where the models go, to refuse a download that would fill the disk. */
      diskFree?: () => Promise<number>;
      /** Disk space to leave after a model (FBRX Server keeps more, for its virtual machines and backups). */
      spareBytes?: number;
      fetch?: typeof fetch;
    } = {},
  ) {}

  /** FBRX's own models, then the ones added from Hugging Face. */
  catalog(): CatalogModel[] {
    return [...MODEL_CATALOG, ...this.added()];
  }

  private added(): CatalogModel[] {
    return this.o.meta?.get<CatalogModel[]>(ADDED_KEY) ?? [];
  }

  private entry(id: string): CatalogModel | undefined {
    return this.catalog().find((m) => m.id === id);
  }

  /**
   * Adds a model on Hugging Face to the catalog ("owner/name", optionally ":QUANT"), once its files are found there; it
   * then downloads and is used like FBRX's own. One of FBRX's own, or one added before, is returned as it is.
   */
  async add(source: string, name?: string): Promise<CatalogModel> {
    const { repo, quant } = parseHfRef(source);
    const known = this.catalog().find((m) => m.hf && m.hf.repo.toLowerCase() === repo.toLowerCase() && (!quant || m.hf.quant.toLowerCase() === quant.toLowerCase()));
    if (known) return known;
    const found = await resolveHfModel(repo, quant, { fetch: this.o.fetch });
    const size = found.files.reduce((a, f) => a + f.sizeBytes, 0);
    const title = repo.split('/')[1].replace(/-GGUF$/i, '').replace(/^[A-Za-z0-9-]+_(?=[A-Za-z])/, '');
    const params = /(\d+(?:\.\d+)?)B(?:-A(\d+(?:\.\d+)?)B)?/i.exec(title);
    const entry: CatalogModel = {
      id: `hf-${slugify(`${title}-${found.quant}`, 60)}`,
      name: name?.trim().slice(0, 80) || `${title} ${found.quant}`,
      family: 'Hugging Face',
      parameters: params ? (params[2] ? `${params[1]}B (MoE, ${params[2]}B active)` : `${params[1]}B`) : '',
      quantization: found.quant,
      sizeBytes: size,
      // Read from the file itself once it is here.
      contextLength: 0,
      url: `https://huggingface.co/${repo}`,
      sha256: null,
      license: 'See its page on Hugging Face',
      description: `Added from Hugging Face (${repo})${found.files.length > 1 ? `, in ${found.files.length} parts` : ''}. Tools work when its chat template supports them.`,
      tier: size >= 16e9 ? 'server' : 'large',
      // Never picked for a computer on its own: only FBRX's tested models are.
      toolCalling: false,
      // Quick on processors: a mixture of experts with a few billion parameters at work.
      moe: !!params?.[2] && Number(params[2]) <= 6,
      hf: { repo, quant: found.quant },
      added: true,
    };
    const list = this.added().filter((m) => m.id !== entry.id);
    if (list.length >= ADDED_MAX) throw new CoreError('CONFLICT', `${ADDED_MAX} models are added already: take one off the list first`);
    this.o.meta?.set(ADDED_KEY, [...list, entry]);
    this.log.info('Model added from Hugging Face', { model: entry.id, repo, quant: found.quant, parts: found.files.length });
    return entry;
  }

  installed(): InstalledModel[] {
    const active = this.activeModelId();
    return this.db
      .all<ModelRow>('SELECT * FROM models ORDER BY installed_at DESC')
      .filter((r) => partNames(r.file).every((f) => existsSync(join(this.dir, f))))
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
    for (const entry of MODEL_CATALOG.filter((m) => !m.hf)) {
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

  /**
   * Starts a background download once its files are known and the disk has room for them. Progress is published on
   * the `runtime.download` event.
   */
  async download(modelId: string): Promise<void> {
    const entry = this.entry(modelId);
    if (!entry) throw new CoreError('NOT_FOUND', `Unknown catalog model ${modelId}`);
    if (this.downloads.has(modelId)) throw new CoreError('CONFLICT', 'Download already in progress');
    if (this.get(modelId)) throw new CoreError('ALREADY_EXISTS', 'Model is already installed');
    const controller = new AbortController();
    const progress: DownloadProgress = { modelId, receivedBytes: 0, totalBytes: entry.sizeBytes, state: 'downloading' };
    this.downloads.set(modelId, { controller, progress });
    let files: ModelFile[];
    try {
      files = await this.files(entry, controller.signal);
      const left = files.reduce((a, f) => a + Math.max(0, f.sizeBytes - this.have(f.name)), 0);
      const free = this.o.diskFree ? await this.o.diskFree() : Infinity;
      const spare = this.o.spareBytes ?? 0;
      if (left + spare > free) {
        throw new CoreError('UNAVAILABLE', `${entry.name} needs ${GB(left)} more of disk space${spare ? `, and ${GB(spare)} is kept free` : ''}: ${GB(free)} is free. Make room (or delete a model you no longer use), then try again.`);
      }
    } catch (err) {
      this.downloads.delete(modelId);
      throw err;
    }
    progress.totalBytes = files.reduce((a, f) => a + f.sizeBytes, 0) || entry.sizeBytes;
    void this.runDownload(entry, files, controller, progress);
  }

  /** The files a model is downloaded from: its one address, or what Hugging Face lists for it. */
  private async files(entry: CatalogModel, signal: AbortSignal): Promise<ModelFile[]> {
    if (entry.hf) return (await resolveHfModel(entry.hf.repo, entry.hf.quant, { fetch: this.o.fetch, signal })).files;
    return [{ url: entry.url, name: basename(new URL(entry.url).pathname), sizeBytes: entry.sizeBytes, sha256: entry.sha256 }];
  }

  /** How much of a file is here already: all of it when it finished, else what an interrupted download left. */
  private have(name: string): number {
    for (const f of [join(this.dir, name), join(this.dir, `${name}.part`)]) if (existsSync(f)) return statSync(f).size;
    return 0;
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

  private async runDownload(entry: CatalogModel, files: ModelFile[], controller: AbortController, progress: DownloadProgress) {
    try {
      let done = 0;
      let first: string | null = null;
      for (const [i, file] of files.entries()) {
        const final = join(this.dir, file.name);
        // A part that finished before an interruption is kept: it was checked then.
        if (files.length > 1 && existsSync(final)) {
          done += statSync(final).size;
          continue;
        }
        const sha256 = await this.fetchFile(file, final, controller, progress, done, files.length > 1 ? ` (part ${i + 1} of ${files.length})` : '');
        if (i === 0) first = sha256;
        done += (await stat(final)).size;
      }
      const size = files.reduce((a, f) => a + statSync(join(this.dir, f.name)).size, 0);
      this.db.run('INSERT OR REPLACE INTO models (id, name, file, size_bytes, sha256, source, installed_at) VALUES (?,?,?,?,?,?,?)', entry.id, entry.name, files[0].name, size, first ?? files[0].sha256, 'catalog', new Date().toISOString());
      progress.receivedBytes = size;
      progress.state = 'completed';
      // Over before anyone hears it is: the model can be used or deleted straight away.
      this.downloads.delete(entry.id);
      this.emit(progress);
      this.log.info('Model downloaded', { model: entry.id, parts: files.length });
    } catch (err) {
      progress.state = controller.signal.aborted ? 'cancelled' : 'failed';
      progress.error = controller.signal.aborted ? undefined : (err as Error).message;
      this.downloads.delete(entry.id);
      this.emit(progress);
      if (!controller.signal.aborted) this.log.error('Model download failed', { model: entry.id, error: (err as Error).message });
    }
  }

  /** Downloads one file (resuming a .part left by an interruption), checks it and puts it in place; its SHA-256. */
  private async fetchFile(file: ModelFile, final: string, controller: AbortController, progress: DownloadProgress, before: number, label: string): Promise<string> {
    const part = `${final}.part`;
    let offset = existsSync(part) ? statSync(part).size : 0;
    const res = await (this.o.fetch ?? fetch)(file.url, {
      headers: offset ? { range: `bytes=${offset}-` } : {},
      signal: controller.signal,
      redirect: 'follow',
    });
    if (res.status === 200) offset = 0;
    else if (res.status !== 206) throw new Error(`Download failed${label}: HTTP ${res.status}`);
    if (!res.body) throw new Error('Empty response');
    const len = Number(res.headers.get('content-length') ?? 0);
    // The server knows the size exactly; the catalog only roughly.
    if (len && len + offset !== file.sizeBytes) {
      progress.totalBytes += len + offset - file.sizeBytes;
      file.sizeBytes = len + offset;
    }
    progress.state = 'downloading';
    progress.receivedBytes = before + offset;
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
    if (len && got < len + offset) throw new Error(`The download stopped early${label} (${Math.round(got / 1e6)} of ${Math.round((len + offset) / 1e6)} MB). Download again to continue where it stopped.`);
    progress.state = 'verifying';
    this.emit(progress);
    const sha256 = await sha256File(part);
    if (file.sha256 && file.sha256 !== sha256) {
      await rm(part, { force: true });
      throw new Error(`Checksum mismatch${label}: the downloaded file is corrupt or was tampered with`);
    }
    await rename(part, final);
    return sha256;
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
    if (!this.entry(id)) throw new CoreError('INVALID_ARGUMENT', row ? 'Imported models cannot be downloaded again: import the file again' : `Unknown catalog model ${id}`);
    if (row) {
      await this.removeFiles(row.file);
      this.db.run('DELETE FROM models WHERE id = ?', id);
    }
    await this.download(id);
  }

  /** A model's file and, for a model in parts, every other part (and what unfinished downloads left). */
  private async removeFiles(first: string): Promise<void> {
    for (const f of partNames(first)) {
      await rm(join(this.dir, f), { force: true });
      await rm(join(this.dir, `${f}.part`), { force: true });
    }
  }

  /** Deletes a model's files; one added from Hugging Face also comes off the list. */
  async remove(id: string): Promise<boolean> {
    const row = this.db.get<ModelRow>('SELECT * FROM models WHERE id = ?', id);
    if (row && this.activeModelId() === id) throw new CoreError('CONFLICT', 'Select a different model before deleting the active one');
    if (this.downloads.has(id)) throw new CoreError('CONFLICT', 'Cancel its download first');
    if (row) {
      await this.removeFiles(row.file);
      this.db.run('DELETE FROM models WHERE id = ?', id);
    }
    const added = this.added();
    if (added.some((m) => m.id === id)) this.o.meta?.set(ADDED_KEY, added.filter((m) => m.id !== id));
    return !!row || added.some((m) => m.id === id);
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
