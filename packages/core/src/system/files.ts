import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { newId, type FileEntry, type FilePreview } from '@fbrx/shared';
import { CoreError } from '../errors';
import type { EventBus } from '../events';
import { IS_WIN } from '../windows/ps';
import { runShell } from '../tools/builtin/shell-tools';

const TEXT_EXT = new Set(
  'txt md markdown json jsonc yaml yml toml ini cfg conf log csv tsv xml html htm css scss less js mjs cjs ts tsx jsx py rb go rs java kt swift c h cpp hpp cs php sh bash zsh ps1 psm1 bat cmd sql env gitignore dockerfile makefile properties reg vbs lua r pl'.split(' '),
);
const IMAGE_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon' };
const MAX_TEXT = 512 * 1024;
const MAX_IMAGE = 8 * 1024 * 1024;

export function expandPath(p: string): string {
  const s = p.trim().replace(/^~(?=$|[\\/])/, homedir());
  if (!isAbsolute(s)) throw new CoreError('INVALID_ARGUMENT', 'Use a full path');
  return resolve(s);
}

/** File explorer back end for the person at the workstation. */
export class FileBrowser {
  constructor(private readonly specialDirs: () => { home: string; documents: string; desktop: string; downloads: string }) {}

  async home(): Promise<{ home: string; places: Array<{ name: string; path: string }>; drives: string[] }> {
    const d = this.specialDirs();
    const places = [
      { name: 'Home', path: d.home },
      { name: 'Desktop', path: d.desktop },
      { name: 'Documents', path: d.documents },
      { name: 'Downloads', path: d.downloads },
      { name: 'Pictures', path: join(d.home, 'Pictures') },
      { name: 'Music', path: join(d.home, 'Music') },
      { name: 'Videos', path: join(d.home, 'Videos') },
    ].filter((p) => existsSync(p.path));
    const drives = IS_WIN ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`).filter((p) => existsSync(p)) : ['/'];
    return { home: d.home, places, drives };
  }

  async list(path: string, hidden = false): Promise<{ path: string; parent: string | null; items: FileEntry[] }> {
    const dir = expandPath(path);
    let ents;
    try {
      ents = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      throw new CoreError('NOT_FOUND', `Cannot open ${dir}: ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
    }
    const items: FileEntry[] = [];
    for (const e of ents.slice(0, 5000)) {
      if (!hidden && (e.name.startsWith('.') || /^(desktop\.ini|thumbs\.db|\$recycle\.bin|system volume information)$/i.test(e.name))) continue;
      const p = join(dir, e.name);
      let size = 0;
      let modifiedAt: string | null = null;
      let isDir = e.isDirectory();
      try {
        const st = await stat(p);
        size = st.isDirectory() ? 0 : st.size;
        modifiedAt = st.mtime.toISOString();
        isDir = st.isDirectory();
      } catch {
        /* broken link or no access */
      }
      items.push({ name: e.name, path: p, dir: isDir, size, modifiedAt });
    }
    items.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
    const parent = dirname(dir);
    return { path: dir, parent: parent === dir ? null : parent, items };
  }

  async read(path: string): Promise<FilePreview> {
    const file = expandPath(path);
    const st = await stat(file).catch(() => null);
    if (!st) throw new CoreError('NOT_FOUND', 'File not found');
    if (st.isDirectory()) throw new CoreError('INVALID_ARGUMENT', 'That is a folder');
    const ext = extname(file).slice(1).toLowerCase() || basename(file).toLowerCase();
    if (IMAGE_EXT[ext]) {
      if (st.size > MAX_IMAGE) return { path: file, kind: 'binary', size: st.size, truncated: true, content: '' };
      const fh = await open(file, 'r');
      try {
        const buf = Buffer.alloc(st.size);
        await fh.read(buf, 0, st.size, 0);
        return { path: file, kind: 'image', size: st.size, truncated: false, content: `data:${IMAGE_EXT[ext]};base64,${buf.toString('base64')}` };
      } finally {
        await fh.close();
      }
    }
    const fh = await open(file, 'r');
    try {
      const n = Math.min(st.size, MAX_TEXT);
      const buf = Buffer.alloc(n);
      await fh.read(buf, 0, n, 0);
      const looksBinary = buf.subarray(0, 4096).includes(0);
      if (looksBinary && !TEXT_EXT.has(ext)) return { path: file, kind: 'binary', size: st.size, truncated: false, content: '' };
      return { path: file, kind: 'text', size: st.size, truncated: st.size > MAX_TEXT, content: buf.toString('utf8') };
    } finally {
      await fh.close();
    }
  }

  async write(path: string, content: string): Promise<void> {
    const file = expandPath(path);
    if (Buffer.byteLength(content) > 10 * 1024 * 1024) throw new CoreError('INVALID_ARGUMENT', 'File is too large to save from the editor');
    await writeFile(file, content, 'utf8');
  }

  /** Opens a file or folder with its default application. */
  open(path: string): void {
    const p = expandPath(path);
    if (!existsSync(p)) throw new CoreError('NOT_FOUND', 'Not found');
    const [cmd, args] = IS_WIN ? ['explorer.exe', [p]] : process.platform === 'darwin' ? ['open', [p]] : ['xdg-open', [p]];
    spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  }

  /** Name search below `root` (case-insensitive, `*` wildcards), bounded in time and results. */
  async search(root: string, pattern: string, budgetMs = 8000): Promise<FileEntry[]> {
    const base = expandPath(root);
    const q = pattern.trim().toLowerCase();
    if (!q) return [];
    const re = q.includes('*') ? new RegExp(`^${q.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`) : null;
    const t0 = Date.now();
    const out: FileEntry[] = [];
    const queue = [base];
    while (queue.length && out.length < 200 && Date.now() - t0 < budgetMs) {
      const dir = queue.shift()!;
      let ents;
      try {
        ents = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of ents) {
        if (e.name.startsWith('.') || e.name === 'node_modules' || /^(appdata|\$recycle\.bin|windows|program files.*)$/i.test(e.name)) continue;
        const p = join(dir, e.name);
        const n = e.name.toLowerCase();
        if (re ? re.test(n) : n.includes(q)) {
          let size = 0;
          let modifiedAt: string | null = null;
          try {
            const st = await stat(p);
            size = st.isDirectory() ? 0 : st.size;
            modifiedAt = st.mtime.toISOString();
          } catch {
            /* ignore */
          }
          out.push({ name: e.name, path: p, dir: e.isDirectory(), size, modifiedAt });
        }
        if (e.isDirectory() && !e.isSymbolicLink()) queue.push(p);
      }
    }
    return out;
  }
}

/** Interactive command sessions for the built-in terminal page (output streams as `terminal.output` events). */
export class TerminalSessions {
  private readonly sessions = new Map<string, AbortController>();

  constructor(
    private readonly events: EventBus,
    private readonly defaultCwd: () => string,
  ) {}

  run(command: string, cwd?: string): { sessionId: string } {
    if (!command.trim()) throw new CoreError('INVALID_ARGUMENT', 'Enter a command');
    if (this.sessions.size >= 8) throw new CoreError('CONFLICT', 'Too many commands running; stop one first');
    const dir = cwd ? expandPath(cwd) : this.defaultCwd();
    const sessionId = newId('term');
    const controller = new AbortController();
    this.sessions.set(sessionId, controller);
    const emitChunk = (stream: 'out' | 'err', text: string) => {
      if (text) this.events.emit('terminal.output', { sessionId, stream, text });
    };
    void runShell(command, dir, 30 * 60_000, controller.signal, (stream, text) => emitChunk(stream, text))
      .then((r) => this.events.emit('terminal.exit', { sessionId, code: r.timedOut ? null : r.code }))
      .catch((err) => {
        emitChunk('err', `${(err as Error).message}\n`);
        this.events.emit('terminal.exit', { sessionId, code: null });
      })
      .finally(() => this.sessions.delete(sessionId));
    return { sessionId };
  }

  kill(sessionId: string): boolean {
    const c = this.sessions.get(sessionId);
    if (!c) return false;
    c.abort();
    return true;
  }

  killAll(): void {
    for (const c of this.sessions.values()) c.abort();
  }
}
