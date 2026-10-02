import { clipboard } from 'electron';

/**
 * Clipboard history for the Clipboard page: off unless turned on in Settings, kept in memory only (never written to
 * disk, gone when FBRX quits), text only, the last 50 copies. Copies that password managers mark as secret are skipped.
 */

export interface ClipEntry {
  id: number;
  text: string;
  at: string;
  pinned: boolean;
}

const MAX_ENTRIES = 50;
const MAX_TEXT = 100_000;
// Formats password managers and secure apps add so clipboard tools leave the copy alone.
const SECRET_FORMATS = ['ExcludeClipboardContentFromMonitorProcessing', 'CanIncludeInClipboardHistory', 'Clipboard Viewer Ignore', 'org.nspasteboard.ConcealedType', 'org.nspasteboard.TransientType', 'x-kde-passwordManagerHint'];

export class ClipHistory {
  private entries: ClipEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = '';
  private nextId = 1;
  private busy = false;

  constructor(private readonly changed: (entries: ClipEntry[]) => void) {}

  get enabled(): boolean {
    return this.timer !== null;
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    if (on) {
      // What is already on the clipboard when history is turned on is not recorded.
      void this.safeRead().then((t) => (this.last = t));
      this.timer = setInterval(() => void this.poll(), 1000);
      this.timer.unref?.();
    } else {
      clearInterval(this.timer!);
      this.timer = null;
      this.entries = [];
      this.changed(this.entries);
    }
  }

  list(): ClipEntry[] {
    return this.entries;
  }

  remove(id: number): void {
    this.entries = this.entries.filter((e) => e.id !== id);
    this.changed(this.entries);
  }

  pin(id: number, pinned: boolean): void {
    this.entries = this.entries.map((e) => (e.id === id ? { ...e, pinned } : e));
    this.changed(this.entries);
  }

  clear(): void {
    this.entries = this.entries.filter((e) => e.pinned);
    this.changed(this.entries);
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

  private async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const text = await this.safeRead();
      if (!this.enabled || !text || text === this.last) return;
      this.last = text;
      if (!text.trim() || text.length > MAX_TEXT || (await this.secret())) return;
      const existing = this.entries.find((e) => e.text === text);
      const rest = this.entries.filter((e) => e.text !== text);
      const entry: ClipEntry = { id: this.nextId++, text, at: new Date().toISOString(), pinned: existing?.pinned ?? false };
      const pinned = rest.filter((e) => e.pinned);
      const loose = rest.filter((e) => !e.pinned).slice(0, Math.max(0, MAX_ENTRIES - 1 - pinned.length));
      this.entries = [entry, ...rest.filter((e) => e.pinned || loose.includes(e))];
      this.changed(this.entries);
    } finally {
      this.busy = false;
    }
  }
}
