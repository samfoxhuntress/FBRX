import { createSocket, type Socket } from 'node:dgram';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIPv4 } from 'node:net';
import type { HaBeat } from '@fbrx/shared';

/**
 * The pair's heartbeat: a small signed UDP message several times a second, sent on every path (the dedicated link
 * and the network). A message that is not signed with the pair's secret, or that comes from an older run or count
 * than the last one heard, is dropped.
 */

export type HaPathName = 'link' | 'network';

/** A heartbeat, with the path it was sent on. */
export interface Beat extends HaBeat {
  pa: HaPathName;
}

const MAX = 1024;
const STATES = new Set(['single', 'starting', 'active', 'standby', 'stopped']);

export function encodeBeat(b: Beat, secret: string): Buffer {
  const body = Buffer.from(JSON.stringify(b)).toString('base64url');
  return Buffer.from(`${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`);
}

export function decodeBeat(msg: Buffer, secret: string): Beat | null {
  if (msg.length > MAX) return null;
  const s = msg.toString('latin1');
  const i = s.lastIndexOf('.');
  if (i < 1) return null;
  const body = s.slice(0, i);
  const want = Buffer.from(createHmac('sha256', secret).update(body).digest('base64url'));
  const got = Buffer.from(s.slice(i + 1));
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const b = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Beat;
    const ok =
      typeof b.p === 'string' &&
      typeof b.n === 'string' &&
      typeof b.b === 'string' &&
      Number.isInteger(b.s) &&
      Number.isInteger(b.t) &&
      STATES.has(b.st) &&
      (b.pr === 'primary' || b.pr === 'standby') &&
      typeof b.h === 'boolean' &&
      Number.isFinite(b.ts) &&
      (b.pa === 'link' || b.pa === 'network');
    return ok ? b : null;
  } catch {
    return null;
  }
}

/** "host:port" (IPv4 or a name), as the pair keeps its partner's heartbeat addresses. */
export function splitHostPort(s: string): { host: string; port: number } | null {
  const m = /^([^:\s]+):(\d{1,5})$/.exec(s.trim());
  if (!m) return null;
  const port = Number(m[2]);
  return port > 0 && port < 65536 ? { host: m[1]!, port } : null;
}

export interface HeartbeatOptions {
  port: number;
  bind: string;
  /** Called with each heartbeat that is signed right (the secret is asked for each message, as it can change). */
  secret: () => string | null;
  onBeat: (b: Beat) => void;
  log: (level: 'info' | 'warn', msg: string) => void;
}

export class Heartbeat {
  private sock: Socket | null = null;

  constructor(private readonly o: HeartbeatOptions) {}

  start(): Promise<void> {
    if (this.sock) return Promise.resolve();
    const sock = createSocket({ type: 'udp4', reuseAddr: true });
    this.sock = sock;
    sock.on('message', (msg) => {
      const secret = this.o.secret();
      if (!secret) return;
      const b = decodeBeat(msg, secret);
      if (b) this.o.onBeat(b);
    });
    return new Promise((resolve) => {
      sock.once('error', (e) => {
        this.o.log('warn', `High availability: the heartbeat cannot listen on UDP ${this.o.port}: ${e.message}`);
        resolve();
      });
      sock.bind(this.o.port, this.o.bind, () => {
        sock.removeAllListeners('error');
        sock.on('error', (e) => this.o.log('warn', `High availability: heartbeat: ${e.message}`));
        resolve();
      });
    });
  }

  send(b: Beat, to: string, secret: string): void {
    const a = splitHostPort(to);
    if (!this.sock || !a || !isIPv4(a.host)) return;
    this.sock.send(encodeBeat(b, secret), a.port, a.host, () => undefined);
  }

  stop(): void {
    try {
      this.sock?.close();
    } catch {
      /* closed */
    }
    this.sock = null;
  }
}
