import { describe, expect, it } from 'vitest';
import { ModelLine, type LineKind } from '../src/ai/model-line';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Requests that take their turn and note when they started. */
function harness(hostFirst: boolean) {
  let first = hostFirst;
  const line = new ModelLine({ capacity: () => 1, hostFirst: () => first });
  const order: string[] = [];
  const releases = new Map<string, () => void>();
  const ask = (name: string, kind: LineKind, signal?: AbortSignal) =>
    line.acquire(kind, signal).then((release) => {
      order.push(name);
      releases.set(name, release);
    });
  return { line, order, ask, done: async (name: string) => (releases.get(name)!(), await tick()), set: (v: boolean) => (first = v) };
}

describe('the line to this computer’s model', () => {
  it('lets this computer’s own requests go ahead of work for the mesh', async () => {
    const h = harness(true);
    await h.ask('mesh-1', 'mesh');
    const waiting = [h.ask('mesh-2', 'mesh'), h.ask('mesh-3', 'mesh'), h.ask('host-1', 'host'), h.ask('host-2', 'host')];
    await tick();
    expect(h.line.status()).toMatchObject({ host: { running: 0, waiting: 2 }, mesh: { running: 1, waiting: 2 } });
    // The mesh request that started finishes; then the server's own, in their order, then the mesh's.
    await h.done('mesh-1');
    await h.done('host-1');
    await h.done('host-2');
    await h.done('mesh-2');
    await Promise.all(waiting);
    expect(h.order).toEqual(['mesh-1', 'host-1', 'host-2', 'mesh-2', 'mesh-3']);
  });

  it('keeps a new mesh request behind a host one that is waiting, even when it arrives as the model frees up', async () => {
    const h = harness(true);
    await h.ask('host-1', 'host');
    const later = [h.ask('host-2', 'host')];
    await tick();
    await h.done('host-1');
    // host-2 runs now; a mesh request arriving waits, and so does it for a host request that comes after it.
    later.push(h.ask('mesh-1', 'mesh'), h.ask('host-3', 'host'));
    await tick();
    await h.done('host-2');
    await h.done('host-3');
    await Promise.all(later);
    expect(h.order).toEqual(['host-1', 'host-2', 'host-3', 'mesh-1']);
  });

  it('is first come, first served with the setting off, and lets a stopped request out of the line', async () => {
    const h = harness(false);
    await h.ask('mesh-1', 'mesh');
    const stop = new AbortController();
    const gone = h.ask('host-0', 'host', stop.signal).catch((e: Error) => e.message);
    const rest = [h.ask('mesh-2', 'mesh'), h.ask('host-1', 'host')];
    await tick();
    stop.abort();
    expect(await gone).toBe('Stopped');
    await h.done('mesh-1');
    await h.done('mesh-2');
    await Promise.all(rest);
    expect(h.order).toEqual(['mesh-1', 'mesh-2', 'host-1']);
    expect(h.line.status()).toMatchObject({ host: { running: 1, waiting: 0 }, mesh: { running: 0, waiting: 0 } });
  });
});
