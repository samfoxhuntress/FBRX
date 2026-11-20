import { createHash } from 'node:crypto';
import { clipboard, ClipboardItem, nativeImage } from 'electron';

/**
 * Clipboard history for the Clipboard page: off unless turned on in Settings, kept in memory only (never written to
 * disk, gone when FBRX quits), the last 50 copies of text and pictures. Copies that password managers mark as secret
 * are skipped, and so are the passwords and codes FBRX's own Vault copies.
 */

export interface ClipEntry {
  id: number;
  /** The copied text; empty for a picture. */
  text: string;
  /** A copied picture: a small preview and its size (the picture itself stays in the main process). */
  image?: { thumb: string; width: number; height: number };
  at: string;
  pinned: boolean;
}

const MAX_ENTRIES = 50;
const MAX_TEXT = 100_000;
/** Pictures take memory: the newest ones are kept, up to this many, each up to 50 megapixels. */
const MAX_IMAGES = 12;
const MAX_PIXELS = 50_000_000;
const THUMB_WIDTH = 360;
/** Pictures are looked at every other second: reading one makes a PNG of it, which takes longer than text. */
const IMAGE_EVERY = 2;
// Formats password managers and secure apps add so clipboard tools leave the copy alone.
const SECRET_FORMATS = ['ExcludeClipboardContentFromMonitorProcessing', 'CanIncludeInClipboardHistory', 'Clipboard Viewer Ignore', 'org.nspasteboard.ConcealedType', 'org.nspasteboard.TransientType', 'x-kde-passwordManagerHint'];

export class ClipHistory {
  private entries: ClipEntry[] = [];
  /** The pictures behind image entries (PNG), by entry id. */
  private images = new Map<number, Buffer>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = '';
  /** What the last picture on the clipboard looked like, so the same one is not added again. */
  private lastImage = '';
  private nextId = 1;
  private busy = false;
  private ticks = 0;
  /** A password or code FBRX itself just copied: never recorded. */
  private secretCopy = '';

  constructor(private readonly changed: (entries: ClipEntry[]) => void) {}

  get enabled(): boolean {
    return this.timer !== null;
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    if (on) {
      // What is already on the clipboard when history is turned on is not recorded.
      void this.safeRead().then((t) => (this.last = t));
      void this.readImage().then((png) => (this.lastImage = this.imageKey(png)));
      this.timer = setInterval(() => void this.poll(), 1000);
      this.timer.unref?.();
    } else {
      clearInterval(this.timer!);
      this.timer = null;
      this.entries = [];
      this.images.clear();
      this.changed(this.entries);
    }
  }

  list(): ClipEntry[] {
    return this.entries;
  }

  remove(id: number): void {
    this.set(this.entries.filter((e) => e.id !== id));
  }

  pin(id: number, pinned: boolean): void {
    this.entries = this.entries.map((e) => (e.id === id ? { ...e, pinned } : e));
    this.changed(this.entries);
  }

  clear(): void {
    this.set(this.entries.filter((e) => e.pinned));
  }

  /** Puts a copy from the history back on the clipboard (a picture as a picture); false when it is gone. */
  async restore(id: number): Promise<boolean> {
    const entry = this.entries.find((e) => e.id === id);
    const png = this.images.get(id);
    if (!entry) return false;
    if (entry.image && png) {
      this.lastImage = this.imageKey(png);
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]);
    } else if (entry.text) {
      this.last = entry.text;
      await clipboard.writeText(entry.text);
    } else return false;
    return true;
  }

  private set(entries: ClipEntry[]): void {
    this.entries = entries;
    for (const id of this.images.keys()) if (!entries.some((e) => e.id === id)) this.images.delete(id);
    this.changed(this.entries);
  }

  /** FBRX is copying a password or code: history skips it (other apps see the clipboard as usual). */
  skip(text: string): void {
    this.secretCopy = text;
  }

  private async secret(): Promise<boolean> {
    for (const f of SECRET_FORMATS) {
      try {
        if (await clipboard.has(`electron application/osclipboard;format="${f}"`)) return true;
      } catch {
        /* format unknown on this system */
      }
    }
    return false;
  }

  private async safeRead(): Promise<string> {
    try {
      return await clipboard.readText();
    } catch {
      return '';
    }
  }

  /** The picture on the clipboard as PNG, or null. */
  private async readImage(): Promise<Buffer | null> {
    try {
      if (!(await clipboard.has('image/png'))) return null;
      const item = (await clipboard.read()).find((i) => i.types.includes('image/png'));
      if (!item) return null;
      const blob = (await item.getType('image/png')) as Blob;
      return Buffer.from(await blob.arrayBuffer());
    } catch {
      return null;
    }
  }

  private imageKey(png: Buffer | null): string {
    return png ? createHash('sha1').update(png).digest('hex') : '';
  }

  private async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.enabled) return;
      if (await this.secret()) return;
      const text = await this.safeRead();
      // No text on the clipboard: the same text copied again later goes back to the top.
      if (!text) this.last = '';
      if (text) {
        if (text === this.last) return;
        this.last = text;
        if (!text.trim() || text.length > MAX_TEXT || text === this.secretCopy) return;
        const existing = this.entries.find((e) => e.text === text);
        this.add({ id: this.nextId++, text, at: new Date().toISOString(), pinned: existing?.pinned ?? false }, (e) => e.text === text);
        return;
      }
      if (this.ticks++ % IMAGE_EVERY) return;
      const png = await this.readImage();
      const key = this.imageKey(png);
      if (!png || key === this.lastImage) return;
      this.lastImage = key;
      const image = nativeImage.createFromBuffer(png);
      const { width, height } = image.getSize();
      if (image.isEmpty() || width * height > MAX_PIXELS) return;
      const id = this.nextId++;
      this.images.set(id, png);
      const thumb = (width > THUMB_WIDTH ? image.resize({ width: THUMB_WIDTH, quality: 'good' }) : image).toDataURL();
      this.add({ id, text: '', image: { thumb, width, height }, at: new Date().toISOString(), pinned: false }, () => false);
    } finally {
      this.busy = false;
    }
  }

  /** Adds a copy at the top (replacing the same copy further down), keeping the pinned ones and the limits. */
  private add(entry: ClipEntry, same: (e: ClipEntry) => boolean): void {
    const rest = this.entries.filter((e) => !same(e));
    const pinned = rest.filter((e) => e.pinned);
    const loose = rest.filter((e) => !e.pinned).slice(0, Math.max(0, MAX_ENTRIES - 1 - pinned.length));
    let images = entry.image ? 1 : 0;
    const kept = rest.filter((e) => {
      if (!e.pinned && !loose.includes(e)) return false;
      if (!e.image || e.pinned) return true;
      return ++images <= MAX_IMAGES;
    });
    this.set([entry, ...kept]);
  }
}
