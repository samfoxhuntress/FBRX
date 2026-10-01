import { appendFile, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { ToolSpec } from '../types';
import { globToRegExp } from '../../util/misc';

export interface FsToolDeps {
  workspace: string;
  maxFileBytes: () => number;
}

export function resolveToolPath(p: string, workspace: string): string {
  const s = String(p ?? '').trim();
  if (!s) throw new Error('path is required');
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) return resolve(homedir(), s.slice(2));
  return isAbsolute(s) ? resolve(s) : resolve(workspace, s);
}

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function fsTools(d: FsToolDeps): ToolSpec[] {
  const P = (p: string) => resolveToolPath(p, d.workspace);
  return [
    {
      name: 'fs.list_dir',
      title: 'List folder',
      description: 'List files and folders in a directory (relative paths resolve against the FBRX workspace; ~ is the home folder).',
      risk: 'read',
      source: 'builtin',
      sourceId: null,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Folder to list' },
          showHidden: { type: 'boolean', default: false },
        },
        required: ['path'],
      },
      resources: (i) => ({ paths: [{ path: P(i.path), access: 'read' }] }),
      async run(i) {
        const dir = P(i.path);
        const entries = await readdir(dir, { withFileTypes: true });
        const rows: Array<{ name: string; type: string; size: number | null; modified: string | null }> = [];
        for (const e of entries.slice(0, 500)) {
          if (!i.showHidden && e.name.startsWith('.')) continue;
          let size: number | null = null;
          let modified: string | null = null;
          try {
            const s = await stat(join(dir, e.name));
            size = e.isDirectory() ? null : s.size;
            modified = s.mtime.toISOString();
          } catch {
            /* broken link */
          }
          rows.push({ name: e.name, type: e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'link' : 'file', size, modified });
        }
        rows.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
        const text = rows.map((r) => `${r.type === 'dir' ? '[dir] ' : '      '}${r.name}${r.size !== null ? `  (${fmtSize(r.size)})` : ''}`).join('\n');
        return { output: `${dir}\n${text || '(empty)'}${entries.length > 500 ? `\n… ${entries.length - 500} more` : ''}`, data: rows };
      },
    },
    {
      name: 'fs.read_file',
      title: 'Read file',
      description: 'Read a UTF-8 text file. Large files are truncated.',
      risk: 'read',
      source: 'builtin',
      sourceId: null,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: { type: 'integer', minimum: 0, default: 0, description: 'Byte offset to start reading from' },
          maxBytes: { type: 'integer', minimum: 1, maximum: 2000000, default: 100000 },
        },
        required: ['path'],
      },
      resources: (i) => ({ paths: [{ path: P(i.path), access: 'read' }] }),
      async run(i) {
        const file = P(i.path);
        const s = await stat(file);
        if (s.isDirectory()) throw new Error('Path is a directory; use fs.list_dir');
        if (s.size > d.maxFileBytes()) throw new Error(`File is larger than the policy limit (${fmtSize(d.maxFileBytes())})`);
        const buf = await readFile(file);
        const slice = buf.subarray(i.offset, i.offset + i.maxBytes);
        if (slice.includes(0)) throw new Error('File appears to be binary');
        const more = buf.length > i.offset + i.maxBytes ? `\n… [${buf.length - i.offset - i.maxBytes} more bytes; use offset to continue]` : '';
        return { output: slice.toString('utf8') + more, data: { path: file, size: s.size } };
      },
    },
    {
      name: 'fs.write_file',
      title: 'Write file',
      description: 'Create or overwrite a text file (or append to it). Parent folders are created as needed.',
      risk: 'write',
      source: 'builtin',
      sourceId: null,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          append: { type: 'boolean', default: false },
        },
        required: ['path', 'content'],
      },
      resources: (i) => ({ paths: [{ path: P(i.path), access: 'write' }] }),
      async run(i) {
        const file = P(i.path);
        if (Buffer.byteLength(i.content) > d.maxFileBytes()) throw new Error('Content exceeds the policy file size limit');
        await mkdir(dirname(file), { recursive: true });
        if (i.append) await appendFile(file, i.content, 'utf8');
        else await writeFile(file, i.content, 'utf8');
        return { output: `${i.append ? 'Appended' : 'Wrote'} ${Buffer.byteLength(i.content)} bytes to ${file}`, data: { path: file } };
      },
    },
    {
      name: 'fs.make_dir',
      title: 'Create folder',
      description: 'Create a folder (and any missing parents).',
      risk: 'write',
      source: 'builtin',
      sourceId: null,
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      resources: (i) => ({ paths: [{ path: P(i.path), access: 'write' }] }),
      async run(i) {
        const dir = P(i.path);
        await mkdir(dir, { recursive: true });
        return { output: `Created ${dir}` };
      },
    },
    {
      name: 'fs.delete_file',
      title: 'Delete file',
      description: 'Delete a single file (folders are not deleted).',
      risk: 'write',
      source: 'builtin',
      sourceId: null,
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      resources: (i) => ({ paths: [{ path: P(i.path), access: 'write' }] }),
      async run(i) {
        const file = P(i.path);
        const s = await stat(file);
        if (s.isDirectory()) throw new Error('Refusing to delete a folder');
        await unlink(file);
        return { output: `Deleted ${file}` };
      },
    },
    {
      name: 'fs.search',
      title: 'Find files',
      description: 'Recursively find files under a folder whose relative path matches a glob (e.g. **/*.pdf) and optionally contain text.',
      risk: 'read',
      source: 'builtin',
      sourceId: null,
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string' },
          pattern: { type: 'string', default: '**/*' },
          contains: { type: 'string', description: 'Only files containing this text (case-insensitive)' },
          maxResults: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
        },
        required: ['root'],
      },
      resources: (i) => ({ paths: [{ path: P(i.root), access: 'read' }] }),
      async run(i, ctx) {
        const root = P(i.root);
        const re = globToRegExp(i.pattern, process.platform !== 'linux');
        const needle = i.contains ? String(i.contains).toLowerCase() : null;
        const out: string[] = [];
        let scanned = 0;
        const walk = async (dir: string, depth: number): Promise<void> => {
          if (depth > 12 || out.length >= i.maxResults || scanned > 50_000 || ctx.signal.aborted) return;
          let entries;
          try {
            entries = await readdir(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            if (out.length >= i.maxResults) return;
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            const full = join(dir, e.name);
            scanned++;
            if (e.isDirectory()) await walk(full, depth + 1);
            else if (e.isFile()) {
              const rel = relative(root, full).replace(/\\/g, '/');
              if (!re.test(rel)) continue;
              if (needle) {
                try {
                  const s = await stat(full);
                  if (s.size > 2_000_000) continue;
                  const text = await readFile(full, 'utf8');
                  if (!text.toLowerCase().includes(needle)) continue;
                } catch {
                  continue;
                }
              }
              out.push(full);
            }
          }
        };
        await walk(root, 0);
        return { output: out.length ? out.join('\n') : 'No matching files', data: out };
      },
    },
  ];
}
