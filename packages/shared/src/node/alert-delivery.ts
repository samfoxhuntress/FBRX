import { createHmac, timingSafeEqual } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { isIPv6, connect as tcpConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { fbrxAlertSyslog, type FbrxAlert } from '../fbrx-alert';

/**
 * Sending FBRX Alerts out: signed webhooks and syslog. A webhook's body is the FBRX Alert v1 JSON, signed with a
 * secret both sides keep: the FBRX-Signature header is `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, so a
 * receiver can check who sent it and refuse an old message played again.
 */

export const FBRX_SIGNATURE_HEADER = 'FBRX-Signature';

export function signFbrxAlert(body: string, secret: string, at: number = Math.floor(Date.now() / 1000)): string {
  return `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')}`;
}

/** Whether a webhook body was signed with this secret, within the tolerance (five minutes unless set). */
export function verifyFbrxAlertSignature(body: string, header: string | null | undefined, secret: string, o: { now?: number; toleranceSeconds?: number } = {}): boolean {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=', 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !/^[a-f0-9]{64}$/.test(parts.v1 ?? '')) return false;
  const now = o.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (o.toleranceSeconds ?? 300)) return false;
  const want = Buffer.from(createHmac('sha256', secret).update(`${t}.${body}`).digest('hex'));
  const got = Buffer.from(parts.v1!);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Posts an alert to a webhook as FBRX Alert v1 JSON, signed when there is a secret. */
export async function postFbrxAlert(url: string, alert: FbrxAlert, secret?: string, o: { userAgent?: string; timeoutMs?: number } = {}): Promise<void> {
  if (!/^https?:\/\//i.test(url)) throw new Error('The webhook address must start with https://');
  const body = JSON.stringify(alert);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': o.userAgent ?? 'FBRX-Alert/1',
    'fbrx-alert-key': encodeURIComponent(alert.key),
    'fbrx-alert-state': alert.state,
  };
  if (secret) headers[FBRX_SIGNATURE_HEADER] = signFbrxAlert(body, secret);
  const r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) });
  if (!r.ok) throw new Error(`The webhook answered HTTP ${r.status}`);
}

export interface SyslogTarget {
  host: string;
  port: number;
  /** udp (514), tcp (514, octet-counted frames) or tls (6514). */
  protocol: 'udp' | 'tcp' | 'tls';
  facility?: number;
}

/** Sends an alert to a syslog server as one RFC 5424 message. */
export async function sendFbrxAlertSyslog(t: SyslogTarget, alert: FbrxAlert, o: { timeoutMs?: number } = {}): Promise<void> {
  if (!t.host.trim()) throw new Error('Set the syslog server first');
  const line = fbrxAlertSyslog(alert, { facility: t.facility });
  const timeout = o.timeoutMs ?? 10_000;
  if (t.protocol === 'udp') {
    const sock = createSocket(isIPv6(t.host) ? 'udp6' : 'udp4');
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The syslog server did not take the message in time')), timeout);
        sock.send(Buffer.from(line), t.port, t.host, (err) => {
          clearTimeout(timer);
          if (err) reject(err);
          else resolve();
        });
      });
    } finally {
      sock.close();
    }
    return;
  }
  // TCP and TLS: one octet-counted frame (RFC 6587), then the connection closes.
  const frame = `${Buffer.byteLength(line)} ${line}`;
  await new Promise<void>((resolve, reject) => {
    let sock: Socket;
    const fail = (err: Error) => {
      sock.destroy();
      reject(err);
    };
    const send = () => sock.end(frame, () => resolve());
    sock = t.protocol === 'tls' ? tlsConnect({ host: t.host, port: t.port, servername: isIPv6(t.host) || /^\d+\.\d+\.\d+\.\d+$/.test(t.host) ? undefined : t.host }, send) : tcpConnect({ host: t.host, port: t.port }, send);
    sock.setTimeout(timeout, () => fail(new Error('The syslog server did not answer in time')));
    sock.on('error', fail);
  });
}
