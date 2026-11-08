import { CoreError } from '../errors';

/**
 * The line in front of this computer's own AI model (the built-in runtime answers one request at a time). Requests
 * from this computer itself (its person, its console, its automations) are "host"; work done for other computers on
 * FBRX Mesh (Mesh Assist, a lent model) is "mesh". With host first on, a host request starts as soon as the model is
 * free and mesh requests wait while any host request is waiting, so the server's own people never queue behind the
 * mesh. A mesh request that already started finishes first; nothing is cut off mid-answer. Off, it is first come,
 * first served.
 */
export type LineKind = 'host' | 'mesh';

export interface ModelLineStatus {
  capacity: number;
  hostFirst: boolean;
  host: { running: number; waiting: number };
  mesh: { running: number; waiting: number };
}

interface Waiter {
  kind: LineKind;
  start: () => void;
}

export class ModelLine {
  private readonly running: Record<LineKind, number> = { host: 0, mesh: 0 };
  private readonly waiting: Waiter[] = [];

  constructor(private readonly o: { capacity: () => number; hostFirst: () => boolean; changed?: (s: ModelLineStatus) => void }) {}

  status(): ModelLineStatus {
    return {
      capacity: this.capacity(),
      hostFirst: this.o.hostFirst(),
      host: { running: this.running.host, waiting: this.waiting.filter((w) => w.kind === 'host').length },
      mesh: { running: this.running.mesh, waiting: this.waiting.filter((w) => w.kind === 'mesh').length },
    };
  }

  private capacity() {
    return Math.max(1, Math.floor(this.o.capacity()));
  }

  private free() {
    return this.running.host + this.running.mesh < this.capacity();
  }

  /** The next request to start, when the model is free: a host one first (with host first on), else the oldest. */
  private next(): number {
    if (!this.free() || !this.waiting.length) return -1;
    if (this.o.hostFirst()) {
      const host = this.waiting.findIndex((w) => w.kind === 'host');
      if (host >= 0) return host;
    }
    return 0;
  }

  private pump() {
    for (let i = this.next(); i >= 0; i = this.next()) {
      const [w] = this.waiting.splice(i, 1);
      this.running[w.kind]++;
      w.start();
    }
    this.o.changed?.(this.status());
  }

  /** Waits for a turn with the model; call the returned function when the request is over (it is safe to call twice). */
  async acquire(kind: LineKind, signal?: AbortSignal): Promise<() => void> {
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      this.running[kind]--;
      this.pump();
    };
    // Straight in when the model is free and nobody is ahead (no one at all, or for a host request no host one).
    const ahead = this.waiting.some((w) => w.kind === 'host' || !this.o.hostFirst() || kind === 'mesh');
    if (this.free() && !ahead) {
      this.running[kind]++;
      this.o.changed?.(this.status());
      return release;
    }
    if (signal?.aborted) throw new CoreError('CANCELLED', 'Stopped');
    await new Promise<void>((resolve, reject) => {
      const w: Waiter = {
        kind,
        start: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        const i = this.waiting.indexOf(w);
        if (i >= 0) this.waiting.splice(i, 1);
        this.o.changed?.(this.status());
        reject(new CoreError('CANCELLED', 'Stopped'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(w);
      this.o.changed?.(this.status());
    });
    return release;
  }
}
