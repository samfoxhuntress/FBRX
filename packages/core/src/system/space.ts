import { createHash } from 'node:crypto';
import { createReadStream, existsSync, type Dirent } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { SPACE_KINDS, type SpaceDuplicates, type SpaceHog, type SpaceKind, type SpaceMap, type SpaceNode } from '@fbrx/shared';
import { CoreError } from '../errors';

/**
 * The space map: where the space in a folder (or a whole drive) goes, as a tree for the treemap, by kind of file, with
 * the largest files, the space hogs it found inside (node_modules, Python environments, build folders, game and photo
 * libraries) and files not touched for two years. Folders are read a batch of entries at a time, within a time
 * budget; what did not fit is reported as partial.
 */

const KIND_OF: Record<string, SpaceKind> = {};
const kinds: Record<SpaceKind, string> = {
  videos: 'mp4 mov mkv avi wmv m4v webm flv mpg mpeg 3gp mts m2ts vob',
  pictures: 'jpg jpeg png gif heic heif webp bmp tif tiff raw cr2 cr3 nef arw dng orf rw2 psd svg ico avif',
  music: 'mp3 m4a aac flac wav aif aiff ogg opus wma alac mid midi',
  documents: 'pdf doc docx xls xlsx ppt pptx odt ods odp rtf txt md csv pages numbers key epub one msg eml',
  archives: 'zip rar 7z tar gz tgz bz2 xz zst iso img vhd vhdx vmdk qcow2 vdi cab',
  apps: 'exe msi msix appx dmg pkg app deb rpm appimage dll so dylib sys apk ipa gguf safetensors bin',
  code: 'js ts tsx jsx mjs cjs json py rb go rs java kt c h cpp hpp cs php swift sh ps1 lock map wasm pyc class o obj pdb',
  other: '',
};
for (const k of SPACE_KINDS) for (const e of kinds[k].split(' ').filter(Boolean)) KIND_OF[e] = k;
const kindIndex = (name: string) => SPACE_KINDS.indexOf(KIND_OF[extname(name).slice(1).toLowerCase()] ?? 'other');

/** Folders and files on the map: this many per folder, this many levels down; the rest is folded into "smaller". */
const MAP_CHILDREN = 24;
const MAP_DEPTH = 5;
/** A file this big shows on the map by itself. */
const BIG_FILE = 64 * 1024 * 1024;
const LARGEST = 40;
const OLD_MS = 2 * 365 * 86_400_000;
/** Entries stat'ed at once while reading a folder. */
const BATCH = 64;
/** What the system makes up on the fly (Linux's /proc and /sys) or mounts twice (macOS's data volume): never walked. */
const SKIP = new Set(['/proc', '/sys', '/dev', '/run', '/System/Volumes']);

/** Folders inside a scan that are known space hogs, by name. */
const FOUND: Array<{ id: string; test: (name: string, path: string) => boolean; label: string; what: string; action: SpaceHog['action'] }> = [
  { id: 'node_modules', test: (n) => n === 'node_modules', label: 'node_modules', what: 'JavaScript packages for a project. Deleting is safe: "npm install" in the project brings them back.', action: 'remove' },
  { id: 'venv', test: (n, p) => (n === '.venv' || n === 'venv' || n === 'env') && existsSync(join(p, 'pyvenv.cfg')), label: 'Python environment', what: 'Packages installed for a Python project. Deleting is safe: the project can make it again.', action: 'remove' },
  { id: 'derived-data', test: (n) => n === 'DerivedData', label: 'Xcode build files', what: 'What Xcode built. Deleting is safe: Xcode builds it again.', action: 'remove' },
  { id: 'gradle-build', test: (n, p) => n === 'build' && (existsSync(join(p, '..', 'build.gradle')) || existsSync(join(p, '..', 'build.gradle.kts'))), label: 'Gradle build folder', what: 'What Gradle built for a project. Deleting is safe: it is built again.', action: 'remove' },
  { id: 'rust-target', test: (n, p) => n === 'target' && existsSync(join(p, '..', 'Cargo.toml')), label: 'Rust build folder', what: 'What Cargo built for a project. Deleting is safe: "cargo build" makes it again.', action: 'remove' },
  { id: 'photos', test: (n) => n.endsWith('.photoslibrary'), label: 'Photos library', what: 'Your photos. Look through it in Photos; turn on "Optimize Mac Storage" to keep the originals in iCloud only.', action: 'review' },
  { id: 'steamapps', test: (n) => n === 'steamapps', label: 'Steam games', what: 'Installed games. Uninstall the ones you do not play from Steam.', action: 'review' },
  { id: 'trash', test: (n) => n === '$RECYCLE.BIN' || n === '.Trash' || n === '.Trashes', label: 'Trash', what: 'Deleted files still taking space until the Trash (Recycle Bin) is emptied.', action: 'review' },
];
/** Names of folders whose space hogs can be removed in one click (and nothing else is removed that way). */
export const REMOVABLE = new Set(FOUND.filter((f) => f.action === 'remove').map((f) => f.id));

interface Walk {
  t0: number;
  budget: number;
  files: number;
  partial: boolean;
  largest: Array<{ path: string; size: number; modified: string }>;
  found: SpaceHog[];
  old: { size: number; files: number };
  /** Files per kind, in SPACE_KINDS order. */
  kindFiles: number[];
}

const fileEntry = async (dir: string, e: Dirent) => {
  try {
    return { e, st: await stat(join(dir, e.name)) };
  } catch {
    return { e, st: null };
  }
};

/** Reads a folder into a node: its size by kind, and (to MAP_DEPTH) its biggest folders and files. */
async function walk(w: Walk, dir: string, name: string, depth: number, inHog: boolean): Promise<SpaceNode> {
  const node: SpaceNode = { name, path: dir, size: 0, files: 0, dir: true, kinds: SPACE_KINDS.map(() => 0) };
  let ents: Dirent[];
  try {
    ents = await readdir(dir, { withFileTypes: true });
  } catch {
    return node;
  }
  const children: SpaceNode[] = [];
  let small = 0;
  const now = Date.now();
  const files = ents.filter((e) => e.isFile());
  for (let i = 0; i < files.length; i += BATCH) {
    if (Date.now() - w.t0 > w.budget) {
      w.partial = true;
      break;
    }
    for (const { e, st } of await Promise.all(files.slice(i, i + BATCH).map((e) => fileEntry(dir, e)))) {
      if (!st) continue;
      const k = kindIndex(e.name);
      node.size += st.size;
      node.files++;
      node.kinds[k] += st.size;
      w.kindFiles[k]++;
      w.files++;
      const path = join(dir, e.name);
      if (now - st.mtimeMs > OLD_MS) {
        w.old.size += st.size;
        w.old.files++;
      }
      if (w.largest.length < LARGEST || st.size > w.largest[w.largest.length - 1].size) {
        w.largest.push({ path, size: st.size, modified: st.mtime.toISOString() });
        w.largest.sort((a, b) => b.size - a.size);
        if (w.largest.length > LARGEST) w.largest.pop();
      }
      if (st.size >= BIG_FILE && depth < MAP_DEPTH) {
        const kinds = SPACE_KINDS.map(() => 0);
        kinds[k] = st.size;
        children.push({ name: e.name, path, size: st.size, files: 1, dir: false, kinds });
      } else small += st.size;
    }
  }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    if (Date.now() - w.t0 > w.budget) {
      w.partial = true;
      break;
    }
    const path = join(dir, e.name);
    if (SKIP.has(path)) continue;
    const hog = inHog ? undefined : FOUND.find((f) => f.test(e.name, path));
    const child = await walk(w, path, e.name, depth + 1, inHog || !!hog);
    if (hog && child.size > 0) w.found.push({ id: hog.id, label: hog.label, what: hog.what, path, size: child.size, action: hog.action });
    node.size += child.size;
    node.files += child.files;
    child.kinds.forEach((b, k) => (node.kinds[k] += b));
    children.push(child);
  }
  children.sort((a, b) => b.size - a.size);
  const shown = depth < MAP_DEPTH ? children.slice(0, MAP_CHILDREN) : [];
  const folded = children.slice(shown.length).reduce((a, c) => a + c.size, 0);
  if (shown.length) node.children = shown;
  node.rest = small + folded;
  return node;
}

/** Drops what is too small to see on the map (under 0.2% of all), folding it into its folder's "smaller" part. */
function prune(node: SpaceNode, min: number): void {
  if (!node.children) return;
  const keep = node.children.filter((c) => c.size >= min);
  node.rest = (node.rest ?? 0) + node.children.filter((c) => c.size < min).reduce((a, c) => a + c.size, 0);
  node.children = keep.length ? keep : undefined;
  keep.forEach((c) => prune(c, min));
}

/** Maps where the space in a folder goes. A deep scan (Endpoint Ultra) gets more time for a whole drive. */
export async function spaceMap(path: string, o: { deep?: boolean } = {}): Promise<Omit<SpaceMap, 'ultra' | 'changes' | 'since'>> {
  const st = await stat(path).catch(() => null);
  if (!st?.isDirectory()) throw new CoreError('NOT_FOUND', `Cannot open ${path}`);
  const w: Walk = { t0: Date.now(), budget: o.deep ? 180_000 : 30_000, files: 0, partial: false, largest: [], found: [], old: { size: 0, files: 0 }, kindFiles: SPACE_KINDS.map(() => 0) };
  const tree = await walk(w, path, basename(path) || path, 0, false);
  prune(tree, tree.size * 0.002);
  return {
    path,
    total: tree.size,
    files: w.files,
    tree,
    kinds: SPACE_KINDS.map((kind, i) => ({ kind, size: tree.kinds[i], files: w.kindFiles[i] })).filter((k) => k.size > 0),
    largest: w.largest,
    found: w.found.sort((a, b) => b.size - a.size).slice(0, 40),
    old: w.old,
    partial: w.partial,
    ms: Date.now() - w.t0,
  };
}

/** What a folder holds now, by its top-level folders: kept to show what grew since the last map. */
export function spaceSummary(m: Pick<SpaceMap, 'total' | 'tree'>): { total: number; children: Record<string, number> } {
  return { total: m.total, children: Object.fromEntries((m.tree.children ?? []).map((c) => [c.name, c.size])) };
}

/** What grew or shrank by at least 1% of the folder (or 100 MB), the biggest change first. */
export function spaceChanges(before: { children: Record<string, number> }, m: Pick<SpaceMap, 'total' | 'tree' | 'path'>): SpaceMap['changes'] {
  const now = Object.fromEntries((m.tree.children ?? []).map((c) => [c.name, c]));
  const names = new Set([...Object.keys(before.children), ...Object.keys(now)]);
  const min = Math.min(100 * 1024 * 1024, m.total * 0.01);
  return [...names]
    .map((name) => ({ name, path: now[name]?.path ?? join(m.path, name), before: before.children[name] ?? 0, after: now[name]?.size ?? 0 }))
    .filter((c) => Math.abs(c.after - c.before) >= min)
    .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before))
    .slice(0, 12);
}

// -------------------------------------------------------------------------------------------- known places

const H = homedir();
const LOCAL = process.env.LOCALAPPDATA ?? join(H, 'AppData', 'Local');
const ROAMING = process.env.APPDATA ?? join(H, 'AppData', 'Roaming');
const LIB = join(H, 'Library');

/** Places on any computer known to grow large: caches that come back by themselves, and libraries to look through. */
const KNOWN: Array<{ id: string; label: string; what: string; action: 'clear' | 'review'; paths: string[] }> = [
  { id: 'npm', label: 'npm cache', what: 'Packages npm downloaded before. It downloads them again when a project needs them.', action: 'clear', paths: [join(H, '.npm', '_cacache'), join(LOCAL, 'npm-cache', '_cacache')] },
  { id: 'yarn', label: 'Yarn cache', what: 'Packages Yarn downloaded before. It downloads them again when needed.', action: 'clear', paths: [join(LOCAL, 'Yarn', 'Cache'), join(LIB, 'Caches', 'Yarn'), join(H, '.cache', 'yarn')] },
  { id: 'pip', label: 'pip cache', what: 'Python packages pip downloaded before. It downloads them again when needed.', action: 'clear', paths: [join(LOCAL, 'pip', 'Cache'), join(LIB, 'Caches', 'pip'), join(H, '.cache', 'pip')] },
  { id: 'gradle', label: 'Gradle caches', what: 'Libraries and builds Gradle keeps. Gradle downloads what a project needs again.', action: 'clear', paths: [join(H, '.gradle', 'caches')] },
  { id: 'homebrew', label: 'Homebrew downloads', what: 'Installers Homebrew kept after installing. Safe to clear.', action: 'clear', paths: [join(LIB, 'Caches', 'Homebrew'), join(H, '.cache', 'Homebrew')] },
  { id: 'xcode', label: 'Xcode build files', what: 'What Xcode built (DerivedData). Xcode builds it again when needed.', action: 'clear', paths: [join(LIB, 'Developer', 'Xcode', 'DerivedData')] },
  { id: 'chrome', label: 'Chrome cache', what: 'Copies of web pages Chrome keeps to load them faster. Pages load again from the web.', action: 'clear', paths: [join(LOCAL, 'Google', 'Chrome', 'User Data', 'Default', 'Cache'), join(LIB, 'Caches', 'Google', 'Chrome'), join(H, '.cache', 'google-chrome')] },
  { id: 'edge', label: 'Edge cache', what: 'Copies of web pages Edge keeps to load them faster. Pages load again from the web.', action: 'clear', paths: [join(LOCAL, 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache'), join(LIB, 'Caches', 'Microsoft Edge')] },
  { id: 'maven', label: 'Maven repository', what: 'Java libraries Maven downloaded. Look through it, or clear it and let Maven download what projects use.', action: 'review', paths: [join(H, '.m2', 'repository')] },
  { id: 'cargo', label: 'Rust downloads', what: 'Crates Cargo downloaded. "cargo cache --autoclean" (cargo-cache) trims it.', action: 'review', paths: [join(H, '.cargo', 'registry')] },
  { id: 'go', label: 'Go modules', what: 'Modules Go downloaded. "go clean -modcache" clears them.', action: 'review', paths: [join(H, 'go', 'pkg', 'mod')] },
  { id: 'nuget', label: 'NuGet packages', what: '.NET packages. "dotnet nuget locals all --clear" clears them.', action: 'review', paths: [join(H, '.nuget', 'packages')] },
  { id: 'simulators', label: 'iOS Simulators', what: 'Simulated iPhones and iPads. "xcrun simctl delete unavailable" removes old ones.', action: 'review', paths: [join(LIB, 'Developer', 'CoreSimulator', 'Devices')] },
  { id: 'ollama', label: 'Ollama models', what: 'AI models Ollama downloaded. Remove the ones you do not use with "ollama rm".', action: 'review', paths: [join(H, '.ollama', 'models')] },
  { id: 'lmstudio', label: 'LM Studio models', what: 'AI models LM Studio downloaded. Remove the ones you do not use in LM Studio.', action: 'review', paths: [join(H, '.lmstudio', 'models'), join(H, '.cache', 'lm-studio', 'models')] },
  { id: 'huggingface', label: 'Hugging Face models', what: 'Models and datasets downloaded by AI tools. "huggingface-cli delete-cache" picks what goes.', action: 'review', paths: [join(H, '.cache', 'huggingface')] },
  { id: 'docker', label: 'Docker disk', what: 'Docker images, containers and volumes. "docker system prune" removes what is not in use.', action: 'review', paths: [join(LOCAL, 'Docker', 'wsl'), join(LIB, 'Containers', 'com.docker.docker', 'Data', 'vms')] },
  { id: 'steam', label: 'Steam games', what: 'Installed games. Uninstall the ones you do not play from Steam.', action: 'review', paths: ['C:\\Program Files (x86)\\Steam\\steamapps', join(LIB, 'Application Support', 'Steam', 'steamapps'), join(H, '.local', 'share', 'Steam', 'steamapps')] },
  { id: 'phone-backups', label: 'iPhone and iPad backups', what: 'Backups of your devices. Delete old ones from Finder or iTunes (Manage Backups).', action: 'review', paths: [join(ROAMING, 'Apple Computer', 'MobileSync', 'Backup'), join(H, 'Apple', 'MobileSync', 'Backup'), join(LIB, 'Application Support', 'MobileSync', 'Backup')] },
  { id: 'temp', label: 'Temporary files', what: 'Files apps left behind. Files in use are skipped.', action: 'clear', paths: [tmpdir()] },
];

/** How much a folder holds, within a time budget. */
async function sizeOf(dir: string, budgetMs: number): Promise<number> {
  const t0 = Date.now();
  let total = 0;
  const stack = [dir];
  while (stack.length && Date.now() - t0 < budgetMs) {
    const d = stack.pop()!;
    let ents: Dirent[];
    try {
      ents = await readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) if (e.isDirectory()) stack.push(join(d, e.name));
    const files = ents.filter((e) => e.isFile());
    for (let i = 0; i < files.length; i += BATCH) {
      for (const { st } of await Promise.all(files.slice(i, i + BATCH).map((e) => fileEntry(d, e)))) total += st?.size ?? 0;
    }
  }
  return total;
}

/** The known places on this computer and how much each holds, biggest first (those under 50 MB left out). */
export async function spaceHogs(): Promise<SpaceHog[]> {
  const places = KNOWN.flatMap((k) => k.paths.filter((p) => existsSync(p)).map((path) => ({ ...k, path })));
  const sized = await Promise.all(places.map(async (p) => ({ id: p.id, label: p.label, what: p.what, action: p.action, path: p.path, size: await sizeOf(p.path, 10_000) })));
  return sized.filter((h) => h.size >= 50 * 1024 * 1024).sort((a, b) => b.size - a.size);
}

/** Empties a contents-only space hog (a cache), or removes a found one (node_modules…); what is in use stays. */
export async function clearHog(id: string, path?: string): Promise<{ freed: number; skipped: number }> {
  const known = KNOWN.find((k) => k.id === id && k.action === 'clear');
  if (known) {
    let freed = 0;
    let skipped = 0;
    const minAge = id === 'temp' ? 86_400_000 : 0;
    for (const dir of known.paths.filter((p) => existsSync(p))) {
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[])) {
        const p = join(dir, e.name);
        try {
          const st = await stat(p);
          if (minAge && Date.now() - st.mtimeMs < minAge) continue;
          const size = e.isDirectory() ? await sizeOf(p, 5000) : st.size;
          await rm(p, { recursive: true, force: true, maxRetries: 1 });
          freed += size;
        } catch {
          skipped++;
        }
      }
    }
    return { freed, skipped };
  }
  const found = FOUND.find((f) => f.id === id && f.action === 'remove');
  if (!found || !path || !found.test(basename(path), path)) throw new CoreError('INVALID_ARGUMENT', 'Only caches and build folders FBRX recognizes are cleared this way');
  const size = await sizeOf(path, 20_000);
  await rm(path, { recursive: true, force: true, maxRetries: 2 });
  return { freed: size, skipped: 0 };
}

// -------------------------------------------------------------------------------------------- duplicates

const hashOf = (path: string, bytes?: number) =>
  new Promise<string>((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path, bytes ? { start: 0, end: bytes - 1 } : {})
      .on('data', (b) => h.update(b))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });

/** Files with the same contents (1 MB and up): grouped by size, then by their first 64 KB, then by all of it. */
export async function duplicates(root: string, budgetMs = 90_000): Promise<SpaceDuplicates> {
  const t0 = Date.now();
  const bySize = new Map<number, string[]>();
  let checked = 0;
  let partial = false;
  const stack = [root];
  while (stack.length) {
    if (Date.now() - t0 > budgetMs / 2) {
      partial = true;
      break;
    }
    const d = stack.pop()!;
    const ents = await readdir(d, { withFileTypes: true }).catch(() => [] as Dirent[]);
    for (const e of ents) if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.') && !SKIP.has(join(d, e.name))) stack.push(join(d, e.name));
    const files = ents.filter((e) => e.isFile());
    for (let i = 0; i < files.length; i += BATCH) {
      for (const { e, st } of await Promise.all(files.slice(i, i + BATCH).map((e) => fileEntry(d, e)))) {
        if (!st || st.size < 1024 * 1024) continue;
        checked++;
        const list = bySize.get(st.size) ?? [];
        list.push(join(d, e.name));
        bySize.set(st.size, list);
      }
    }
  }
  const groups: SpaceDuplicates['groups'] = [];
  const candidates = [...bySize.entries()].filter(([, l]) => l.length > 1).sort((a, b) => b[0] * (b[1].length - 1) - a[0] * (a[1].length - 1));
  for (const [size, paths] of candidates) {
    if (Date.now() - t0 > budgetMs) {
      partial = true;
      break;
    }
    const byHead = new Map<string, string[]>();
    for (const p of paths) {
      const key = await hashOf(p, 65_536).catch(() => null);
      if (key) byHead.set(key, [...(byHead.get(key) ?? []), p]);
    }
    for (const same of byHead.values()) {
      if (same.length < 2) continue;
      const byAll = new Map<string, string[]>();
      for (const p of same) {
        const key = size <= 65_536 ? 'head' : await hashOf(p).catch(() => null);
        if (key) byAll.set(key, [...(byAll.get(key) ?? []), p]);
      }
      for (const g of byAll.values()) if (g.length > 1) groups.push({ size, paths: g });
    }
  }
  groups.sort((a, b) => b.size * (b.paths.length - 1) - a.size * (a.paths.length - 1));
  return { groups: groups.slice(0, 60), wasted: groups.reduce((a, g) => a + g.size * (g.paths.length - 1), 0), checked, partial };
}
