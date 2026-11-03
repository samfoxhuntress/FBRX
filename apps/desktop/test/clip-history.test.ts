import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A clipboard in memory: one item of text or a PNG, like the system clipboard behind Electron's async API. */
const board = vi.hoisted(() => ({ text: '', png: null as Buffer | null, secret: false }));

vi.mock('electron', () => {
  class ClipboardItem {
    constructor(readonly data: Record<string, Blob | string>) {}
    get types() {
      return Object.keys(this.data);
    }
    async getType(t: string) {
      return this.data[t];
    }
  }
  const clipboard = {
    has: async (t: string) => (t === 'image/png' ? !!board.png : board.secret && t.includes('ConcealedType')),
    readText: async () => board.text,
    writeText: async (t: string) => {
      board.text = t;
      board.png = null;
    },
    read: async () => (board.png ? [new ClipboardItem({ 'image/png': new Blob([new Uint8Array(board.png)], { type: 'image/png' }) })] : []),
    write: async (items: ClipboardItem[]) => {
      board.text = '';
      board.png = Buffer.from(await (items[0].data['image/png'] as Blob).arrayBuffer());
    },
  };
  // A picture's size is read from its first bytes here; FBRX only needs the size and a preview.
  const nativeImage = {
    createFromBuffer: (b: Buffer) => {
      const [width, height] = (/^(\d+)x(\d+)/.exec(b.toString()) ?? []).slice(1).map(Number);
      const image = { isEmpty: () => !width, getSize: () => ({ width, height }), resize: () => image, toDataURL: () => `data:image/png;base64,${b.toString('base64')}` };
      return image;
    },
  };
  return { clipboard, ClipboardItem, nativeImage };
});

const { ClipHistory } = await import('../src/main/clip-history');

describe('clipboard history', () => {
  let history: InstanceType<typeof ClipHistory>;
  const tick = () => vi.advanceTimersByTimeAsync(1000);

  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(board, { text: 'already there', png: null, secret: false });
    history = new ClipHistory(() => undefined);
    history.setEnabled(true);
  });
  afterEach(() => {
    history.setEnabled(false);
    vi.useRealTimers();
  });

  it('keeps text exactly as copied, and pictures with a preview, newest first', async () => {
    await tick();
    expect(history.list()).toEqual([]); // what was on the clipboard before is not recorded

    board.text = 'Tr0ub4dor&3|>';
    await tick();
    Object.assign(board, { text: '', png: Buffer.from('1920x1080 screenshot') });
    await tick();
    await tick();
    await tick(); // the same picture is not added twice
    const [picture, password] = history.list();
    expect(password.text).toBe('Tr0ub4dor&3|>');
    expect(picture).toMatchObject({ text: '', image: { width: 1920, height: 1080 } });
    expect(picture.image!.thumb).toMatch(/^data:image\/png;base64,/);
    expect(history.list()).toHaveLength(2);
  });

  it('puts a picture back on the clipboard as a picture', async () => {
    board.png = Buffer.from('800x600 diagram');
    board.text = '';
    await tick();
    await tick();
    board.text = 'something else';
    board.png = null;
    await tick();
    const picture = history.list().find((e) => e.image)!;
    expect(await history.restore(picture.id)).toBe(true);
    expect(board.png?.toString()).toBe('800x600 diagram');
    await tick();
    await tick();
    expect(history.list().filter((e) => e.image)).toHaveLength(1); // putting it back does not add it again
  });

  it('skips copies password managers mark as secret', async () => {
    Object.assign(board, { text: 'hunter2', secret: true });
    await tick();
    expect(history.list()).toEqual([]);
  });
});
