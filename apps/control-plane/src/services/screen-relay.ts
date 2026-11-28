import { randomUUID } from 'node:crypto';
import type { ServerToDeviceMessage } from '@fbrx/shared';
import type { Realtime } from '../realtime';
import { HttpError } from '../errors';

type Op = Extract<ServerToDeviceMessage, { type: 'screen.call' }>['op'];

interface Pending {
  deviceId: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** A remote screen session FBRX Command started: whose it is, for which computer, with what ticket. */
export interface ScreenSessionInfo {
  id: string;
  deviceId: string;
  tenantId: string;
  adminId: string;
  admin: string;
  ticket: string;
  reason: string;
  mode: 'view' | 'control';
  startedAt: string;
}

/**
 * Remote screen between an administrator's browser and a computer: each call goes to the computer over its live
 * connection and waits for its screen.reply. Only the computer a call went to can answer it. Sessions are kept here
 * (in memory) so only the administrator who started one can use it.
 */
export class ScreenRelay {
  private readonly pending = new Map<string, Pending>();
  readonly sessions = new Map<string, ScreenSessionInfo>();

  constructor(private readonly realtime: Realtime) {}

  call<T = unknown>(deviceId: string, op: Op, params: Record<string, unknown>, timeoutMs = 20_000): Promise<T> {
    const callId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        reject(new HttpError(504, 'The computer did not answer in time', 'TIMEOUT'));
      }, timeoutMs);
      this.pending.set(callId, { deviceId, resolve: resolve as (v: unknown) => void, reject, timer });
      if (!this.realtime.sendToDevice(deviceId, { type: 'screen.call', callId, op, params })) {
        clearTimeout(timer);
        this.pending.delete(callId);
        reject(new HttpError(409, 'The computer is not connected to FBRX Command right now', 'CONFLICT'));
      }
    });
  }

  /** A computer's answer; a call it was not sent is ignored. */
  onReply(deviceId: string, msg: { callId: string; ok: boolean; result?: unknown; error?: { code: string; message: string } }): void {
    const p = this.pending.get(String(msg.callId));
    if (!p || p.deviceId !== deviceId) return;
    clearTimeout(p.timer);
    this.pending.delete(String(msg.callId));
    if (msg.ok) p.resolve(msg.result ?? null);
    else {
      const code = msg.error?.code;
      const status = code === 'NOT_FOUND' ? 404 : code === 'FORBIDDEN' ? 403 : code === 'INVALID_ARGUMENT' ? 400 : code === 'CONFLICT' ? 409 : 502;
      p.reject(new HttpError(status, String(msg.error?.message ?? 'The computer refused').slice(0, 300), code ?? 'ERROR'));
    }
  }
}
