import { describe, expect, it } from 'vitest';
import { modelFit } from '../src/api';

const GB = 1e9;

describe('which models fit', () => {
  it('prefers the graphics card, then memory, and leaves the server room', () => {
    // A server with 64 GB and no graphics card: a 30B mixture-of-experts model in memory, a 70B one does not fit.
    const server = { memoryBytes: 64 * GB, gpus: [], variant: 'cpu' as const };
    expect(modelFit(18.6 * GB, server)).toBe('memory');
    expect(modelFit(42.5 * GB, server)).toBe('tight');
    expect(modelFit(60 * GB, server)).toBe('too-big');
    // With a 24 GB card the 32B model runs on it.
    expect(modelFit(19.8 * GB, { memoryBytes: 64 * GB, gpus: [{ name: 'card', vramBytes: 24 * GB }], variant: 'vulkan' })).toBe('gpu');
    // A card the runtime does not use (CPU build) does not count.
    expect(modelFit(19.8 * GB, { memoryBytes: 32 * GB, gpus: [{ name: 'card', vramBytes: 24 * GB }], variant: 'cpu' })).toBe('memory');
    // A Mac shares its memory with the graphics.
    expect(modelFit(9 * GB, { memoryBytes: 32 * GB, gpus: [], variant: 'metal' })).toBe('gpu');
  });
});
