import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STARTER_MODEL_ID, type StarterAiStatus } from '@fbrx/shared';
import { MODEL_CATALOG } from '../src/ai/runtime/catalog';
import { makeKernel, USER } from './helpers';

const entry = MODEL_CATALOG.find((m) => m.id === STARTER_MODEL_ID)!;
const fileName = new URL(entry.url).pathname.split('/').pop()!;
const CATALOG_SIZE = entry.sizeBytes;
// A few megabytes stand in for the gigabyte: picking up a model reads all of it for its checksum, which takes a while
// on a CI computer (this test file runs on its own, so the catalog is changed for it alone).
entry.sizeBytes = 4_000_000;

/** A model file of the right size without writing a gigabyte (sparse). */
function placeModel(dir: string) {
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, fileName), 'w');
  ftruncateSync(fd, entry.sizeBytes);
  closeSync(fd);
}

describe('The AI ready before the first question', () => {
  it('picks up the model the installer downloaded and makes it the AI', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      expect(kernel.starter.status().state).toBe('idle');
      placeModel(kernel.paths.models);
      const st = await kernel.starter.prepare({ auto: true });
      expect(st).toMatchObject({ state: 'ready', modelId: STARTER_MODEL_ID });
      expect(kernel.models.get(STARTER_MODEL_ID)).toMatchObject({ source: 'catalog' });
      expect(kernel.settings.get().runtime.modelId).toBe(STARTER_MODEL_ID);
      const local = kernel.settings.get().ai.providers.find((p) => p.type === 'local-runtime')!;
      expect(kernel.settings.get().ai.defaultProvider).toBe(local.id);
      expect(((await kernel.call('ai.starter', undefined, USER)) as StarterAiStatus).state).toBe('ready');
    } finally {
      await cleanup();
    }
  }, 30_000);

  it('downloads the runtime and the starter model once, on a computer where nobody chose an AI', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const steps: string[] = [];
      kernel.events.on('ai.starter', (s) => s.step && !steps.includes(s.step) && steps.push(s.step));
      // Stand-ins for the two downloads: the runtime is "installed", the model file lands and is recorded.
      let runtimeInstalls = 0;
      let modelDownloads = 0;
      (kernel.runtime as any).status = () => ({ state: runtimeInstalls ? 'stopped' : 'not-installed' });
      kernel.runtime.install = () => {
        runtimeInstalls++;
        setTimeout(() => kernel.events.emit('runtime.download', { modelId: 'llama-runtime', receivedBytes: 1, totalBytes: 1, state: 'completed' }), 10);
      };
      kernel.models.download = (id: string) => {
        modelDownloads++;
        setTimeout(async () => {
          kernel.events.emit('runtime.download', { modelId: id, receivedBytes: 500, totalBytes: 1000, state: 'downloading' });
          placeModel(kernel.paths.models);
          await kernel.models.adopt();
          kernel.events.emit('runtime.download', { modelId: id, receivedBytes: 1000, totalBytes: 1000, state: 'completed' });
        }, 10);
      };
      const st = await kernel.starter.prepare({ auto: true });
      expect(st.state).toBe('ready');
      expect(steps).toEqual(['runtime', 'model', 'starting']);
      expect([runtimeInstalls, modelDownloads]).toEqual([1, 1]);
      expect(kernel.settings.get().runtime.modelId).toBe(STARTER_MODEL_ID);

      // Removed afterwards: not downloaded again by itself (only when asked).
      kernel.settings.update({ runtime: { modelId: '' } });
      await kernel.models.remove(STARTER_MODEL_ID);
      await kernel.starter.prepare({ auto: true });
      expect(modelDownloads).toBe(1);
      await kernel.starter.prepare({ auto: false });
      expect(modelDownloads).toBe(2);
    } finally {
      await cleanup();
    }
  }, 30_000);

  it('does not send a gigabyte unasked to a computer that was set up before', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      kernel.settings.update({ general: { onboardingComplete: true } });
      let downloads = 0;
      kernel.models.download = () => void downloads++;
      expect((await kernel.starter.prepare({ auto: true })).state).toBe('idle');
      expect(downloads).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('never overrules an AI someone chose', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      kernel.settings.update({ ai: { defaultProvider: 'anthropic' } });
      let downloads = 0;
      kernel.models.download = () => void downloads++;
      expect((await kernel.starter.prepare({ auto: true })).state).toBe('not-needed');
      expect(downloads).toBe(0);
      expect(kernel.settings.get().ai.defaultProvider).toBe('anthropic');
    } finally {
      await cleanup();
    }
  });

  it('says what went wrong, and tries again when asked', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      (kernel.runtime as any).status = () => ({ state: 'stopped' });
      kernel.models.download = (id: string) => void setTimeout(() => kernel.events.emit('runtime.download', { modelId: id, receivedBytes: 0, totalBytes: 0, state: 'failed', error: 'Download failed: HTTP 503' }), 10);
      expect(await kernel.starter.prepare({ auto: true })).toMatchObject({ state: 'failed', message: 'Download failed: HTTP 503' });
    } finally {
      await cleanup();
    }
  });

  it('"Install FBRX OS" downloads the same model, to where the app looks, and carries on after a broken-off download', async () => {
    const mod = await import(pathToFileURL(join(__dirname, '..', '..', '..', 'scripts', 'setup', 'starter-model.mjs')).href);
    expect(mod.STARTER_MODEL).toMatchObject({ url: entry.url, sizeBytes: CATALOG_SIZE });

    const body = randomBytes(300_000);
    const ranges: string[] = [];
    let first = true;
    const server = createServer((req, res) => {
      const range = /bytes=(\d+)-/.exec(req.headers.range ?? '');
      ranges.push(req.headers.range ?? 'none');
      const from = range ? Number(range[1]) : 0;
      res.writeHead(range ? 206 : 200, { 'content-length': body.length - from });
      if (first) {
        // This time the connection drops part of the way.
        first = false;
        res.write(body.subarray(from, from + 50_000), () => res.destroy());
        return;
      }
      res.end(body.subarray(from));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const dir = mkdtempSync(join(tmpdir(), 'fbrx-starter-'));
    try {
      // What an earlier run left: the first 100 000 bytes.
      const models = join(dir, 'models');
      mkdirSync(models, { recursive: true });
      writeFileSync(join(models, `${fileName}.part`), body.subarray(0, 100_000));
      const progress: { got?: number; total?: number } = {};
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.gguf`;
      const file = await mod.downloadStarterModel(models, progress, { url, retryMs: 10 });
      expect(file).toBe(join(models, fileName));
      expect(readFileSync(file).equals(body)).toBe(true);
      expect(existsSync(`${file}.part`)).toBe(false);
      // It carried on from what was there, and again after the dropped connection (from at least as far).
      expect(ranges.length).toBe(2);
      expect(ranges[0]).toBe('bytes=100000-');
      expect(ranges[1]).toMatch(/^bytes=\d+-$/);
      expect(Number(ranges[1].slice(6, -1))).toBeGreaterThanOrEqual(100_000);
      expect(progress).toMatchObject({ got: body.length, total: body.length });
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
