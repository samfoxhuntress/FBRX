import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DownloadProgress } from '@fbrx/shared';
import { parseHfRef, partNames, resolveHfModel } from '../src/ai/runtime/hf';
import { ModelManager } from '../src/ai/runtime/model-manager';
import { makeKernel } from './helpers';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const API = 'https://huggingface.co/api/models';

/** Hugging Face as far as the tests need it: a repository's file list (in pages) and its files. */
function huggingFace(repos: Record<string, Record<string, Buffer>>, o: { pageSize?: number; badSha?: string } = {}) {
  const asked: string[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push(url);
    const list = /^https:\/\/huggingface\.co\/api\/models\/([^/]+\/[^/]+)\/tree\/main\?recursive=true(?:&cursor=(\d+))?$/.exec(url);
    if (list) {
      const files = repos[list[1]];
      if (!files) return new Response('{"error":"Repository not found"}', { status: 401 });
      const all = [{ type: 'file', path: 'README.md', size: 10 }, ...Object.entries(files).map(([path, body]) => ({ type: 'file', path, size: body.length, lfs: { oid: path === o.badSha ? '0'.repeat(64) : sha(body), size: body.length } }))];
      const from = Number(list[2] ?? 0);
      const size = o.pageSize ?? all.length;
      const next = from + size < all.length ? `<${API}/${list[1]}/tree/main?recursive=true&cursor=${from + size}>; rel="next"` : null;
      return new Response(JSON.stringify(all.slice(from, from + size)), { headers: next ? { link: next } : {} });
    }
    const file = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/main\/(.+)$/.exec(url);
    const body = file && repos[file[1]]?.[file[2].split('/').map(decodeURIComponent).join('/')];
    if (!body) return new Response('not found', { status: 404 });
    const from = Number(/bytes=(\d+)-/.exec(new Headers(init?.headers).get('range') ?? '')?.[1] ?? 0);
    return new Response(new Uint8Array(body.subarray(from)), { status: from ? 206 : 200, headers: { 'content-length': String(body.length - from) } });
  }) as typeof fetch;
  return { fetch: fake, asked };
}

const bytes = (n: number, fill: number) => Buffer.alloc(n, fill);

describe('models from Hugging Face', () => {
  it('reads a model as people write it: owner/name, a quantization, or its address', () => {
    expect(parseHfRef('bartowski/Qwen_Qwen3-8B-GGUF')).toEqual({ repo: 'bartowski/Qwen_Qwen3-8B-GGUF', quant: null });
    expect(parseHfRef(' hf:bartowski/Qwen_Qwen3-8B-GGUF:Q8_0 ')).toEqual({ repo: 'bartowski/Qwen_Qwen3-8B-GGUF', quant: 'Q8_0' });
    expect(parseHfRef('https://huggingface.co/ggml-org/gpt-oss-120b-GGUF/tree/main')).toEqual({ repo: 'ggml-org/gpt-oss-120b-GGUF', quant: null });
    for (const bad of ['gpt-oss', '../etc/passwd', 'a/b/c', 'owner/name:Q4 K']) expect(() => parseHfRef(bad)).toThrow();
  });

  it('finds every part of a quantization, in order, with the checksums Hugging Face publishes', async () => {
    const hf = huggingFace(
      {
        'bartowski/Big-GGUF': {
          'Big-Q4_K_M/Big-Q4_K_M-00002-of-00002.gguf': bytes(10, 2),
          'Big-Q4_K_M/Big-Q4_K_M-00001-of-00002.gguf': bytes(20, 1),
          'Big-Q4_K_L.gguf': bytes(5, 3),
          'Big-Q8_0.gguf': bytes(40, 4),
          'mmproj-Big-f16.gguf': bytes(5, 5),
          'Big-imatrix.gguf': bytes(5, 6),
        },
      },
      { pageSize: 2 },
    );
    const r = await resolveHfModel('bartowski/Big-GGUF', null, { fetch: hf.fetch });
    expect(r.quant).toBe('Q4_K_M');
    expect(r.files).toEqual([
      { url: 'https://huggingface.co/bartowski/Big-GGUF/resolve/main/Big-Q4_K_M/Big-Q4_K_M-00001-of-00002.gguf', name: 'Big-Q4_K_M-00001-of-00002.gguf', sizeBytes: 20, sha256: sha(bytes(20, 1)) },
      { url: 'https://huggingface.co/bartowski/Big-GGUF/resolve/main/Big-Q4_K_M/Big-Q4_K_M-00002-of-00002.gguf', name: 'Big-Q4_K_M-00002-of-00002.gguf', sizeBytes: 10, sha256: sha(bytes(10, 2)) },
    ]);
    // The list came in pages.
    expect(hf.asked.filter((u) => u.includes('/api/'))).toHaveLength(4);
    // Named exactly, never a near miss (Q4_K is not Q4_K_M or Q4_K_L); what there is, when it is not there.
    expect((await resolveHfModel('bartowski/Big-GGUF', 'q8_0', { fetch: hf.fetch })).files.map((f) => f.name)).toEqual(['Big-Q8_0.gguf']);
    await expect(resolveHfModel('bartowski/Big-GGUF', 'Q4_K', { fetch: hf.fetch })).rejects.toThrow(/has no Q4_K files\. It has: Q4_K_L, Q4_K_M, Q8_0/);
    await expect(resolveHfModel('someone/missing', null, { fetch: hf.fetch })).rejects.toThrow(/no public model someone\/missing/);
  });

  it('says so when a part is missing, and names every part from the first', async () => {
    const hf = huggingFace({ 'o/Split-GGUF': { 'Split-MXFP4-00001-of-00003.gguf': bytes(3, 1), 'Split-MXFP4-00003-of-00003.gguf': bytes(3, 3) } });
    await expect(resolveHfModel('o/Split-GGUF', 'MXFP4', { fetch: hf.fetch })).rejects.toThrow(/missing some of its 3 parts/);
    expect(partNames('m-00001-of-00003.gguf')).toEqual(['m-00001-of-00003.gguf', 'm-00002-of-00003.gguf', 'm-00003-of-00003.gguf']);
    expect(partNames('m-Q4_K_M.gguf')).toEqual(['m-Q4_K_M.gguf']);
  });

  it('adds a model, downloads all its parts and checks them, and takes it away again', async () => {
    const { kernel, cleanup } = await makeKernel({ start: false });
    const dir = mkdtempSync(join(tmpdir(), 'fbrx-hf-'));
    try {
      const one = bytes(300_000, 1);
      const two = bytes(200_000, 2);
      const hf = huggingFace({ 'bartowski/zai-org_Tiny-12B-A3B-GGUF': { 'Tiny-Q4_K_M/Tiny-Q4_K_M-00001-of-00002.gguf': one, 'Tiny-Q4_K_M/Tiny-Q4_K_M-00002-of-00002.gguf': two } });
      let free = 1e9;
      const models = new ModelManager(kernel.db, dir, () => '', kernel.log, kernel.events, { meta: kernel.meta, fetch: hf.fetch, diskFree: async () => free, spareBytes: 600_000 });
      const added = await models.add('https://huggingface.co/bartowski/zai-org_Tiny-12B-A3B-GGUF');
      expect(added).toMatchObject({ id: 'hf-tiny_12b_a3b_q4_k_m', name: 'Tiny-12B-A3B Q4_K_M', parameters: '12B (MoE, 3B active)', moe: true, sizeBytes: 500_000, added: true, toolCalling: false, hf: { repo: 'bartowski/zai-org_Tiny-12B-A3B-GGUF', quant: 'Q4_K_M' } });
      expect(models.catalog().at(-1)).toEqual(added);
      // Added once: asking again gives the same one.
      expect(await models.add('bartowski/zai-org_Tiny-12B-A3B-GGUF:Q4_K_M')).toEqual(added);

      // Not without room on the disk for it and what is kept free.
      free = 1_000_000;
      await expect(models.download(added.id)).rejects.toThrow(/needs 1 GB more of disk space, and 1 GB is kept free: 1 GB is free/);
      free = 1e9;
      const done = new Promise<DownloadProgress>((resolve) => kernel.events.on('runtime.download', (p) => p.state !== 'downloading' && p.state !== 'verifying' && resolve(p)));
      await models.download(added.id);
      expect(await done).toMatchObject({ state: 'completed', receivedBytes: 500_000, totalBytes: 500_000 });
      const installed = models.get(added.id)!;
      expect(installed).toMatchObject({ file: join(dir, 'Tiny-Q4_K_M-00001-of-00002.gguf'), sizeBytes: 500_000, sha256: sha(one) });
      expect(readFileSync(join(dir, 'Tiny-Q4_K_M-00002-of-00002.gguf')).equals(two)).toBe(true);

      // A part gone: the model is not there any more.
      rmSync(join(dir, 'Tiny-Q4_K_M-00002-of-00002.gguf'));
      expect(models.get(added.id)).toBeUndefined();
      expect(await models.remove(added.id)).toBe(true);
      expect(existsSync(join(dir, 'Tiny-Q4_K_M-00001-of-00002.gguf'))).toBe(false);
      expect(models.catalog().some((m) => m.id === added.id)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await cleanup();
    }
  });

  it('refuses a part whose checksum does not match, and keeps the parts already checked', async () => {
    const { kernel, cleanup } = await makeKernel({ start: false });
    const dir = mkdtempSync(join(tmpdir(), 'fbrx-hf-'));
    try {
      const hf = huggingFace({ 'o/Two-GGUF': { 'Two-Q4_K_M-00001-of-00002.gguf': bytes(1000, 1), 'Two-Q4_K_M-00002-of-00002.gguf': bytes(1000, 2) } }, { badSha: 'Two-Q4_K_M-00002-of-00002.gguf' });
      const models = new ModelManager(kernel.db, dir, () => '', kernel.log, kernel.events, { meta: kernel.meta, fetch: hf.fetch });
      const added = await models.add('o/Two-GGUF');
      const done = new Promise<DownloadProgress>((resolve) => kernel.events.on('runtime.download', (p) => p.state === 'failed' && resolve(p)));
      await models.download(added.id);
      expect((await done).error).toMatch(/Checksum mismatch \(part 2 of 2\)/);
      expect(existsSync(join(dir, 'Two-Q4_K_M-00001-of-00002.gguf'))).toBe(true);
      expect(existsSync(join(dir, 'Two-Q4_K_M-00002-of-00002.gguf.part'))).toBe(false);
      expect(models.get(added.id)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await cleanup();
    }
  });
});
