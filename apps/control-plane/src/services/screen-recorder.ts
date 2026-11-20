import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '@fbrx/shared/node';

/**
 * Recordings of FBRX Command's remote screen sessions, for organizations that turn them on: the pictures the
 * administrator saw, at most one a second, and when the mouse and keyboard were used (never what was typed). Each
 * recording is one file in the data folder: records of [kind u8][ms since start u32][width u16][height u16][length u32]
 * then the JPEG; kind 1 is a picture, 2 a moment the mouse or keyboard was used (no picture). A recording stops at
 * MAX_BYTES or MAX_MS, and is deleted after the days the organization keeps them.
 */

export const RECORDING_LIMITS = { everyMs: 1000, maxBytes: 512 << 20, maxMs: 4 * 3600_000, maxFrame: 4 << 20 } as const;
const HEAD = 13;
const KIND = { frame: 1, input: 2 } as const;

export interface RecordingStart {
  sessionId: string;
  tenantId: string;
  deviceId: string;
  deviceName: string;
  adminId: string;
  admin: string;
  ticket: string;
  reason: string;
  mode: 'view' | 'control';
}

export interface RecordingRow {
  id: string;
  tenant_id: string;
  session_id: string;
  device_id: string;
  device_name: string;
  admin_id: string;
  admin: string;
  ticket: string;
  reason: string;
  mode: string;
  started_at: string;
  ended_at: string | null;
  frames: number;
  bytes: number;
  input_used: number;
  cut: string | null;
}

/** One record of a recording, as the player walks it. */
export interface RecordingMark {
  kind: 'frame' | 'input';
  t: number;
  width: number;
  height: number;
  offset: number;
  length: number;
}

interface Open {
  id: string;
  fd: number;
  started: number;
  lastFrameAt: number;
  lastSeq: number;
  lastInputAt: number;
  frames: number;
  bytes: number;
  inputUsed: boolean;
  cut: string | null;
}

export class ScreenRecorder {
  private readonly open = new Map<string, Open>();
  /** Finished recordings' indexes, so a player's picture requests do not walk the file each time. */
  private readonly index = new Map<string, RecordingMark[]>();
  readonly dir: string;

  constructor(
    private readonly db: Db,
    dataDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.dir = join(dataDir, 'recordings');
  }

  /** Recordings a restart left open are closed at their file's last change. */
  recover(): void {
    for (const r of this.db.all<{ id: string; started_at: string }>('SELECT id, started_at FROM screen_recordings WHERE ended_at IS NULL')) {
      const f = this.file(r.id);
      const at = existsSync(f) ? statSync(f).mtime.toISOString() : r.started_at;
      this.db.run("UPDATE screen_recordings SET ended_at = ?, cut = COALESCE(cut, 'restart') WHERE id = ?", at, r.id);
    }
  }

  file(id: string): string {
    if (!/^rec_[0-9a-f-]{36}$/.test(id)) throw new Error('Not a recording id');
    return join(this.dir, `${id}.rec`);
  }

  /** Whether the organization records its remote screen sessions. */
  on(tenantId: string): boolean {
    return Number(this.db.get<{ screen_recording: number }>('SELECT screen_recording FROM tenants WHERE id = ?', tenantId)?.screen_recording ?? 0) === 1;
  }

  start(s: RecordingStart): string {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const id = `rec_${randomUUID()}`;
    const fd = openSync(this.file(id), 'wx', 0o600);
    this.db.run(
      'INSERT INTO screen_recordings (id, tenant_id, session_id, device_id, device_name, admin_id, admin, ticket, reason, mode, started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id,
      s.tenantId,
      s.sessionId,
      s.deviceId,
      s.deviceName,
      s.adminId,
      s.admin,
      s.ticket,
      s.reason,
      s.mode,
      new Date(this.now()).toISOString(),
    );
    this.open.set(s.sessionId, { id, fd, started: this.now(), lastFrameAt: -Infinity, lastSeq: -1, lastInputAt: -Infinity, frames: 0, bytes: 0, inputUsed: false, cut: null });
    return id;
  }

  recording(sessionId: string): boolean {
    return this.open.has(sessionId);
  }

  private write(o: Open, kind: number, width: number, height: number, body: Buffer | null) {
    const t = this.now() - o.started;
    if (t > RECORDING_LIMITS.maxMs) o.cut = 'length';
    if (o.bytes + HEAD + (body?.length ?? 0) > RECORDING_LIMITS.maxBytes) o.cut = 'size';
    if (o.cut) return false;
    const head = Buffer.alloc(HEAD);
    head.writeUInt8(kind, 0);
    head.writeUInt32BE(Math.max(0, Math.round(t)), 1);
    head.writeUInt16BE(Math.min(width, 0xffff), 5);
    head.writeUInt16BE(Math.min(height, 0xffff), 7);
    head.writeUInt32BE(body?.length ?? 0, 9);
    writeSync(o.fd, head);
    if (body) writeSync(o.fd, body);
    o.bytes += HEAD + (body?.length ?? 0);
    return true;
  }

  /** A picture the administrator was sent; kept when a second has passed since the last one kept. */
  frame(sessionId: string, f: { seq?: unknown; width?: unknown; height?: unknown; jpeg?: unknown } | null): void {
    const o = this.open.get(sessionId);
    if (!o || !f || typeof f.jpeg !== 'string') return;
    const seq = Number(f.seq);
    if (seq === o.lastSeq || this.now() - o.lastFrameAt < RECORDING_LIMITS.everyMs) return;
    const jpeg = Buffer.from(f.jpeg, 'base64');
    // Only pictures: a JPEG starts FF D8 FF.
    if (jpeg.length < 3 || jpeg.length > RECORDING_LIMITS.maxFrame || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) return;
    if (!this.write(o, KIND.frame, Number(f.width) || 0, Number(f.height) || 0, jpeg)) return;
    o.lastSeq = seq;
    o.lastFrameAt = this.now();
    o.frames++;
  }

  /** The mouse or keyboard was used (at most one mark a second); what was typed is never kept. */
  input(sessionId: string): void {
    const o = this.open.get(sessionId);
    if (!o) return;
    o.inputUsed = true;
    if (this.now() - o.lastInputAt < 1000) return;
    if (this.write(o, KIND.input, 0, 0, null)) o.lastInputAt = this.now();
  }

  /** The session is over: the recording is closed, or deleted when nothing was seen (the person said no). */
  end(sessionId: string): void {
    const o = this.open.get(sessionId);
    if (!o) return;
    this.open.delete(sessionId);
    closeSync(o.fd);
    if (o.frames === 0) {
      this.remove(o.id);
      return;
    }
    this.db.run('UPDATE screen_recordings SET ended_at = ?, frames = ?, bytes = ?, input_used = ?, cut = ? WHERE id = ?', new Date(this.now()).toISOString(), o.frames, o.bytes, o.inputUsed ? 1 : 0, o.cut, o.id);
  }

  /** Where each record of a recording is, for the player (the file is walked by its headers, never trusted). */
  marks(id: string): RecordingMark[] {
    const cached = this.index.get(id);
    if (cached) return cached;
    const f = this.file(id);
    if (!existsSync(f)) return [];
    const fd = openSync(f, 'r');
    try {
      const size = fstatSync(fd).size;
      const out: RecordingMark[] = [];
      const head = Buffer.alloc(HEAD);
      let at = 0;
      while (at + HEAD <= size && out.length < 100_000) {
        readSync(fd, head, 0, HEAD, at);
        const kind = head.readUInt8(0);
        const length = head.readUInt32BE(9);
        if ((kind !== KIND.frame && kind !== KIND.input) || at + HEAD + length > size) break;
        out.push({ kind: kind === KIND.frame ? 'frame' : 'input', t: head.readUInt32BE(1), width: head.readUInt16BE(5), height: head.readUInt16BE(7), offset: at + HEAD, length });
        at += HEAD + length;
      }
      // Only finished recordings are kept (a few at a time): an open one still grows.
      if (![...this.open.values()].some((o) => o.id === id)) {
        if (this.index.size >= 8) this.index.delete(this.index.keys().next().value!);
        this.index.set(id, out);
      }
      return out;
    } finally {
      closeSync(fd);
    }
  }

  /** One picture of a recording. */
  picture(id: string, mark: RecordingMark): Buffer {
    const fd = openSync(this.file(id), 'r');
    try {
      const b = Buffer.alloc(mark.length);
      readSync(fd, b, 0, mark.length, mark.offset);
      return b;
    } finally {
      closeSync(fd);
    }
  }

  remove(id: string): void {
    this.index.delete(id);
    rmSync(this.file(id), { force: true });
    this.db.run('DELETE FROM screen_recordings WHERE id = ?', id);
  }

  /** Recordings older than their organization keeps them go. */
  sweep(): number {
    let n = 0;
    for (const r of this.db.all<{ id: string; started_at: string; days: number }>('SELECT r.id, r.started_at, t.screen_recording_days AS days FROM screen_recordings r JOIN tenants t ON t.id = r.tenant_id WHERE r.ended_at IS NOT NULL')) {
      if (this.now() - Date.parse(r.started_at) > Math.max(1, Number(r.days) || 30) * 86400_000) {
        this.remove(r.id);
        n++;
      }
    }
    return n;
  }

  /** On shutdown: every open recording is closed as it stands. */
  closeAll(): void {
    for (const s of [...this.open.keys()]) this.end(s);
  }
}
