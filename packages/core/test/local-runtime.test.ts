import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RuntimeStatus } from '@fbrx/shared';
import { explainLoadFailure } from '../src/ai/runtime/load-failure';
import { parseGgufHeader, readGgufInfo } from '../src/ai/runtime/gguf';
import { makeKernel, tempDir, USER } from './helpers';

/** A small GGUF header with the keys llama.cpp writes first. */
function gguf(kv: Array<[string, 'str' | 'u32', string | number]>): Buffer {
  const parts: Buffer[] = [];
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const u64 = (n: number) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    return b;
  };
  const str = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
  parts.push(Buffer.from('GGUF'), u32(3), u64(0), u64(kv.length + 1));
  // An array before the keys we want, like the real files' general.tags.
  parts.push(str('general.tags'), u32(9), u32(8), u64(2), str('text-generation'), str('chat'));
  for (const [k, t, v] of kv) parts.push(str(k), u32(t === 'str' ? 8 : 4), t === 'str' ? str(String(v)) : u32(Number(v)));
  return Buffer.concat(parts);
}

// What llama.cpp prints when a model does not fit on a Vulkan graphics card (Windows laptop, 14B model).
const VULKAN_OOM = [
  'load_tensors: offloading 40 repeating layers to GPU',
  'ggml_vulkan: Device memory allocation of size 4831838208 failed.',
  'ggml_vulkan: Requested buffer size exceeds device memory allocation limit: ErrorOutOfDeviceMemory',
  'alloc_tensor_range: failed to allocate Vulkan0 buffer of size 4831838208',
  'llama_model_load: error loading model: unable to allocate Vulkan0 buffer',
  'llama_model_load_from_file_impl: failed to load model',
  "common_init_from_params: failed to load model 'C:\\Users\\sam\\AppData\\Roaming\\FBRX OS\\models\\Qwen_Qwen3-14B-Q4_K_M.gguf'",
  "srv    load_model: failed to load model, 'C:\\Users\\sam\\AppData\\Roaming\\FBRX OS\\models\\Qwen_Qwen3-14B-Q4_K_M.gguf'",
  'main: exiting due to model loading error',
];

describe('why a model does not load', () => {
  it('reads the reason from above the last line', () => {
    expect(explainLoadFailure(VULKAN_OOM, 'Qwen3 14B', true)).toMatchObject({ kind: 'gpu-memory', message: "Qwen3 14B does not fit in the graphics card's memory.", detail: expect.stringContaining('Vulkan0 buffer') });
    expect(explainLoadFailure(['llama_model_load: error loading model: tensor \'blk.39.ffn_down.weight\' data is not within the file bounds, model is corrupted or incomplete', 'main: exiting due to model loading error'], 'Qwen3 14B', true)).toMatchObject({
      kind: 'damaged',
      message: expect.stringContaining('Download it again'),
    });
    expect(explainLoadFailure(["llama_model_load: error loading model: error loading model architecture: unknown model architecture: 'qwen3'", 'main: exiting due to model loading error'], 'Qwen3 14B', false)).toMatchObject({
      kind: 'unsupported',
      message: expect.stringContaining('Update the runtime'),
    });
    expect(explainLoadFailure(['ggml_backend_cpu_buffer_type_alloc_buffer: failed to allocate buffer of size 9000000000', 'llama_model_load: error loading model: failed to allocate CPU buffer'], 'Qwen3 14B', false).kind).toBe('memory');
    expect(explainLoadFailure(['llama_model_load: error loading model: something new', 'main: exiting due to model loading error'], 'Qwen3 14B', false)).toMatchObject({ kind: 'other', message: 'Qwen3 14B could not be loaded: something new' });
  });

  it('reads a GGUF header: architecture and layers, and tells a non-model apart', () => {
    const buf = gguf([
      ['general.architecture', 'str', 'qwen3'],
      ['general.name', 'str', 'Qwen3 14B'],
      ['qwen3.block_count', 'u32', 40],
    ]);
    expect(parseGgufHeader(buf)).toEqual({ version: 3, architecture: 'qwen3', blockCount: 40, name: 'Qwen3 14B' });
    // Cut short: what was read is kept.
    expect(parseGgufHeader(buf.subarray(0, buf.length - 6))).toMatchObject({ architecture: 'qwen3', blockCount: null });
    expect(parseGgufHeader(Buffer.from('<!DOCTYPE html><html>Too many requests</html>'))).toBeNull();
    const dir = tempDir('fbrx-gguf-');
    writeFileSync(join(dir, 'm.gguf'), buf);
    expect(readGgufInfo(join(dir, 'm.gguf'))?.blockCount).toBe(40);
    expect(readGgufInfo(join(dir, 'missing.gguf'))).toBeNull();
  });
});

describe.skipIf(process.platform === 'win32')('the built-in runtime on a small graphics card', () => {
  it('loads part of the model on the card when all of it does not fit, and remembers', async () => {
    const dir = tempDir('fbrx-rt-');
    const calls = join(dir, 'calls.log');
    // A stand-in llama-server: more than 20 layers on the "graphics card" fails like Vulkan does; otherwise it serves.
    const fake = join(dir, 'llama-server');
    writeFileSync(
      fake,
      `#!/usr/bin/env node
const a = process.argv.slice(2);
const arg = (n) => a[a.indexOf(n) + 1];
const layers = Number(arg('--n-gpu-layers'));
require('fs').appendFileSync(${JSON.stringify(calls)}, layers + '\\n');
if (layers > 20) {
  for (const l of ${JSON.stringify(VULKAN_OOM)}) console.error(l);
  process.exit(1);
}
require('http').createServer((q, s) => { s.writeHead(200); s.end('{"status":"ok"}'); }).listen(Number(arg('--port')), '127.0.0.1');
`,
    );
    chmodSync(fake, 0o755);
    const modelFile = join(dir, 'Qwen_Qwen3-14B-Q4_K_M.gguf');
    writeFileSync(modelFile, gguf([['general.architecture', 'str', 'qwen3'], ['qwen3.block_count', 'u32', 40]]));
    const notGguf = join(dir, 'broken.gguf');
    writeFileSync(notGguf, '<html>error</html>');

    const { kernel, cleanup } = await makeKernel();
    try {
      const m = await kernel.models.import(modelFile, 'Qwen3 14B');
      kernel.settings.update({ runtime: { enabled: true, binaryPath: fake, modelId: m.id, port: 47973, gpuLayers: -1, idleStopMinutes: 0 } });
      const st = (await kernel.call('runtime.start', undefined, USER)) as RuntimeStatus;
      expect(st.state).toBe('running');
      expect(st.message).toBe("Qwen3 14B did not all fit in the graphics card's memory: 20 of its 40 layers run there and the rest on the processor. Answers come a little slower.");
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['999', '20']);

      // Next time it goes straight to what fits.
      await kernel.call('runtime.stop', undefined, USER);
      expect(((await kernel.call('runtime.start', undefined, USER)) as RuntimeStatus).state).toBe('running');
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['999', '20', '20']);
      await kernel.call('runtime.stop', undefined, USER);

      // A file that is not a model is caught before the runtime starts, with the fix to offer.
      const bad = await kernel.models.import(notGguf, 'Broken');
      kernel.settings.update({ runtime: { modelId: bad.id } });
      await expect(kernel.call('runtime.start', undefined, USER)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      expect((await kernel.call('runtime.status', undefined, USER)) as RuntimeStatus).toMatchObject({ state: 'failed', problem: 'damaged', message: expect.stringContaining('Download it again') });
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(3);
    } finally {
      await kernel.runtime.stop().catch(() => undefined);
      await cleanup();
    }
  }, 60_000);
});
