import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeClosing } from '@fbrx/shared';
import type { Kernel } from '../src/kernel';
import { makeKernel, tempDir } from './helpers';

/**
 * A stand-in for llama-server: it answers /health with the model it was started for, after a while for a "slow" model,
 * and a "stubborn" one ignores being asked to stop (only force ends it).
 */
const FAKE = `#!/usr/bin/env node
const http = require('http');
const a = process.argv.slice(2);
const arg = (k) => a[a.indexOf(k) + 1];
const model = arg('--model');
if (model.includes('stubborn')) process.on('SIGTERM', () => {});
setTimeout(() => {
  http.createServer((req, res) => res.end(JSON.stringify({ status: 'ok', alias: arg('--alias') }))).listen(Number(arg('--port')), '127.0.0.1');
}, model.includes('slow') ? 4000 : 50);
setInterval(() => {}, 1 << 30);
`;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (ok: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

let done: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const d of done) await d().catch(() => undefined);
  done = [];
});

async function setup() {
  const dir = tempDir('fbrx-fake-llama-');
  const binary = join(dir, 'llama-server');
  writeFileSync(binary, FAKE);
  chmodSync(binary, 0o755);
  const { kernel, cleanup } = await makeKernel();
  const port = 42000 + Math.floor(Math.random() * 8000);
  const ids: Record<string, string> = {};
  for (const name of ['quick', 'slow', 'stubborn']) {
    const file = join(dir, `${name}.gguf`);
    writeFileSync(file, '');
    ids[name] = (await kernel.models.import(file)).id;
  }
  kernel.settings.update({ runtime: { enabled: true, autoStart: false, binaryPath: binary, port, gpuLayers: 0, threads: 1, modelId: ids.quick } });
  done.push(async () => {
    await kernel.runtime.forceStop();
    await kernel.runtime.stop();
    await kernel.stop();
    await cleanup();
  });
  const answering = async () => ((await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { alias: string }).alias;
  return { kernel, ids, port, answering, runtimeDir: kernel.paths.runtime };
}

const use = (k: Kernel, modelId: string) => k.call('runtime.useModel', { modelId }, { origin: 'user', actor: 't' });

describe.skipIf(process.platform === 'win32')('closing the local model', () => {
  it('stops a model still loading when another is chosen, and runs only the new one', async () => {
    const { kernel, ids, answering } = await setup();
    kernel.settings.update({ runtime: { modelId: ids.slow } });
    const first = kernel.runtime.start().catch((e: Error) => e);
    await until(() => !!kernel.runtime.status().pid);
    const slowPid = kernel.runtime.status().pid!;
    expect(kernel.runtime.status().state).toBe('starting');

    await use(kernel, ids.quick);
    expect(((await first) as Error).message).toMatch(/stopped while it was loading/);
    expect(alive(slowPid)).toBe(false);
    expect(kernel.runtime.status().state).toBe('running');
    expect(await answering()).toBe(ids.quick);
  }, 30_000);

  it('stops a model that does not stop when asked, by force, and says how far it got', async () => {
    const { kernel, ids } = await setup();
    kernel.runtime.timing.graceMs = 300;
    kernel.settings.update({ runtime: { modelId: ids.stubborn } });
    await kernel.runtime.start();
    const pid = kernel.runtime.status().pid!;
    const stages: Array<RuntimeClosing | null | undefined> = [];
    kernel.events.on('runtime.changed', (s) => stages.push(s.closing));
    await kernel.runtime.stop();
    expect(alive(pid)).toBe(false);
    expect(stages.map((c) => c?.stage ?? null)).toEqual(expect.arrayContaining(['stopping', 'forcing', null]));
    expect(stages.find((c) => c)?.modelName).toBe('stubborn');
    expect(kernel.runtime.status()).toMatchObject({ state: 'stopped', closing: null, pid: null });
  }, 30_000);

  it('Stop it now does not wait for the model to finish', async () => {
    const { kernel, ids } = await setup();
    kernel.runtime.timing.graceMs = 60_000;
    kernel.settings.update({ runtime: { modelId: ids.stubborn } });
    await kernel.runtime.start();
    const closing = kernel.runtime.stop();
    await until(() => kernel.runtime.status().closing?.stage === 'stopping');
    const started = Date.now();
    const now = (await kernel.call('runtime.forceStop', {}, { origin: 'user', actor: 't' })) as { closing: RuntimeClosing };
    expect(now.closing).toMatchObject({ forced: true, stage: 'forcing' });
    await closing;
    expect(Date.now() - started).toBeLessThan(3000);
    expect(kernel.runtime.status().pid).toBeNull();
  }, 30_000);

  it('can go on without waiting, and the model left behind is stopped at the next start', async () => {
    const { kernel, ids, answering, runtimeDir } = await setup();
    kernel.runtime.timing.graceMs = 60_000;
    kernel.settings.update({ runtime: { modelId: ids.stubborn } });
    await kernel.runtime.start();
    const pid = kernel.runtime.status().pid!;
    const closing = kernel.runtime.stop();
    await until(() => !!kernel.runtime.status().closing);
    expect(kernel.runtime.giveUpClosing()).toBe(true);
    await closing;
    // Still there, and written down.
    expect(alive(pid)).toBe(true);
    expect(existsSync(join(runtimeDir, 'llama-server.pid'))).toBe(true);

    await use(kernel, ids.quick);
    expect(alive(pid)).toBe(false);
    expect(await answering()).toBe(ids.quick);
  }, 30_000);

  it('names another program on the model port instead of taking it for the model', async () => {
    const { kernel, port } = await setup();
    const other: Server = createServer((_q, r) => r.end('hello'));
    await new Promise<void>((r) => other.listen(port, '127.0.0.1', () => r()));
    try {
      await expect(kernel.runtime.start()).rejects.toThrow(`Another program is already using port ${port}`);
      expect(kernel.runtime.status().state).toBe('failed');
    } finally {
      other.close();
    }
  }, 30_000);
});
