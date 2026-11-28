import { basename } from 'node:path';
import { CoreError } from '../../errors';

/**
 * Models on Hugging Face, by repository: which GGUF files make up one quantization of a model, how big they are and
 * their SHA-256 (Hugging Face publishes it for every large file), read from its public file list. A model too big for
 * one file comes in parts (name-00001-of-00003.gguf): llama.cpp loads the first and finds the rest beside it.
 */

const HF = 'https://huggingface.co';
/** A repository as on its page: owner/name. */
const REPO = /^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/;
/** One part of a model split into several files. */
const PART = /-(\d{5})-of-(\d{5})\.gguf$/i;
/** Files beside a model that are not one: image readers, draft models for faster answers, importance matrices. */
const HELPER = /mmproj|eagle|draft|imatrix/i;
/** The quantization picked when none is named: the usual balance of size and quality. */
export const DEFAULT_QUANT = 'Q4_K_M';

/** One file of a model to download: where from, its name in the models folder, its size and checksum when known. */
export interface ModelFile {
  url: string;
  name: string;
  sizeBytes: number;
  sha256: string | null;
}

interface TreeEntry {
  type: string;
  path: string;
  size?: number;
  lfs?: { oid?: string; size?: number };
}

/** "owner/name", "owner/name:Q4_K_M" or the repository's address, as someone would paste it. */
export function parseHfRef(ref: string): { repo: string; quant: string | null } {
  let repo = ref
    .trim()
    .replace(/^hf:/i, '')
    .replace(/^https?:\/\/(www\.)?huggingface\.co\//i, '')
    .replace(/\/(tree|blob|resolve)\/.*$/, '')
    .replace(/\/+$/, '');
  let quant: string | null = null;
  const colon = repo.lastIndexOf(':');
  if (colon > 0) [repo, quant] = [repo.slice(0, colon), repo.slice(colon + 1) || null];
  if (!REPO.test(repo)) throw new CoreError('INVALID_ARGUMENT', 'Name a Hugging Face model as owner/name (bartowski/Qwen_Qwen3-8B-GGUF, say), optionally with its quantization (:Q4_K_M)');
  if (quant !== null && !/^[\w.-]{1,32}$/.test(quant)) throw new CoreError('INVALID_ARGUMENT', `"${quant}" is not a quantization (Q4_K_M, Q8_0, MXFP4…)`);
  return { repo, quant };
}

/** A set's quantization as its file name gives it: the last part of the name (Q4_K_M, MXFP4, UD-Q4_K_XL → Q4_K_XL). */
const quantOf = (file: string) => basename(file).replace(/\.gguf$/i, '').split(/[-.]/).at(-1) ?? file;

/** The files of one quantization of a model on Hugging Face (all its parts, in order). */
export async function resolveHfModel(repo: string, quant: string | null, o: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<{ quant: string; files: ModelFile[] }> {
  const all = await listFiles(repo, o.fetch ?? fetch, o.signal);
  const ggufs = all.filter((e) => e.type === 'file' && /\.gguf$/i.test(e.path) && !HELPER.test(basename(e.path)));
  if (!ggufs.length) throw new CoreError('NOT_FOUND', `${repo} has no GGUF files (llama.cpp's format). Look for a repository whose name ends in -GGUF.`);
  // A set is one file, or the parts of one split file.
  const sets = new Map<string, TreeEntry[]>();
  for (const e of ggufs) {
    const key = e.path.replace(PART, '.gguf');
    sets.set(key, [...(sets.get(key) ?? []), e]);
  }
  const wanted = quant ?? DEFAULT_QUANT;
  const token = new RegExp(`(^|[-.])${wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[-.]|$)`, 'i');
  const matching = [...sets].filter(([key]) => token.test(basename(key).replace(/\.gguf$/i, '')));
  const options = () => [...new Set([...sets.keys()].map(quantOf))].sort().slice(0, 16).join(', ');
  let chosen: [string, TreeEntry[]];
  if (matching.length === 1) chosen = matching[0];
  else if (!quant && sets.size === 1) chosen = [...sets][0];
  else if (matching.length > 1) throw new CoreError('INVALID_ARGUMENT', `${repo} has several ${wanted} files (${matching.map(([k]) => basename(k)).join(', ')}): name the one you want more exactly`);
  else throw new CoreError('NOT_FOUND', `${repo} has no ${wanted} files. It has: ${options()}`);

  const [key, entries] = chosen;
  const parts = entries.map((e) => ({ e, m: PART.exec(e.path) }));
  if (parts.some((p) => p.m)) {
    const total = Number(parts.find((p) => p.m)!.m![2]);
    const numbers = new Set(parts.map((p) => (p.m ? Number(p.m[1]) : 0)));
    if (parts.length !== total || [...Array(total)].some((_, i) => !numbers.has(i + 1))) throw new CoreError('NOT_FOUND', `${basename(key)} on ${repo} is missing some of its ${total} parts`);
    parts.sort((a, b) => Number(a.m![1]) - Number(b.m![1]));
  }
  const files = parts.map(({ e }) => {
    const name = basename(e.path);
    if (!/^[\w.+-]+\.gguf$/i.test(name)) throw new CoreError('INVALID_ARGUMENT', `${repo} names its file in a way FBRX does not accept: ${name}`);
    const sha = e.lfs?.oid?.toLowerCase();
    return {
      url: `${HF}/${repo}/resolve/main/${e.path.split('/').map(encodeURIComponent).join('/')}`,
      name,
      sizeBytes: Number(e.lfs?.size ?? e.size ?? 0),
      sha256: sha && /^[0-9a-f]{64}$/.test(sha) ? sha : null,
    };
  });
  return { quant: quant ?? quantOf(key), files };
}

/** Every file in a repository, following the list's pages. */
async function listFiles(repo: string, f: typeof fetch, signal?: AbortSignal): Promise<TreeEntry[]> {
  const out: TreeEntry[] = [];
  let url: string | null = `${HF}/api/models/${repo}/tree/main?recursive=true`;
  for (let page = 0; url && page < 20; page++) {
    let res: Response;
    try {
      res = await f(url, { signal: signal ?? AbortSignal.timeout(30_000), headers: { accept: 'application/json' } });
    } catch (err) {
      throw new CoreError('UNAVAILABLE', `Hugging Face could not be reached: ${(err as Error).message}`);
    }
    // Hugging Face answers 401 for a repository that does not exist as well as for one that needs signing in.
    if (res.status === 401 || res.status === 404) throw new CoreError('NOT_FOUND', `Hugging Face has no public model ${repo} (FBRX does not sign in, so gated models are out of reach)`);
    if (!res.ok) throw new CoreError('UNAVAILABLE', `Hugging Face did not list ${repo} (HTTP ${res.status})`);
    const list = (await res.json()) as unknown;
    if (!Array.isArray(list)) throw new CoreError('UNAVAILABLE', `Hugging Face's file list for ${repo} was not understood`);
    out.push(...(list as TreeEntry[]));
    const next = res.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    url = next?.startsWith(`${HF}/api/`) ? next : null;
  }
  return out;
}

/** The names of every part of a model, from the first part's name (just the name itself for a model in one file). */
export function partNames(first: string): string[] {
  const m = PART.exec(first);
  if (!m) return [first];
  return Array.from({ length: Number(m[2]) }, (_, i) => first.replace(PART, `-${String(i + 1).padStart(5, '0')}-of-${m[2]}.gguf`));
}
