import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';

/**
 * The browser console for a virtual machine's screen: noVNC in the FBRX Virtual console talks VNC over a WebSocket,
 * relayed here to the machine's VNC port (which only listens on the server itself). A WebSocket cannot carry the
 * sign-in header, so the console first asks for a one-time ticket (valid 30 seconds, for one machine).
 */
export class ConsoleTickets {
  private readonly tickets = new Map<string, { vm: string; user: string; expires: number }>();

  issue(vm: string, user: string): string {
    this.sweep();
    const t = randomBytes(24).toString('base64url');
    this.tickets.set(t, { vm, user, expires: Date.now() + 30_000 });
    return t;
  }

  /** Uses up a ticket: who it was for, or null. */
  take(ticket: string, vm: string): string | null {
    const t = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!t || t.expires < Date.now() || t.vm !== vm) return null;
    return t.user;
  }

  private sweep() {
    const now = Date.now();
    for (const [k, v] of this.tickets) if (v.expires < now) this.tickets.delete(k);
  }
}

/** Relays a WebSocket to a TCP port, both ways, until either side closes. */
export function relay(ws: WebSocket, host: string, port: number): void {
  const sock = connect({ host, port });
  const pending: Buffer[] = [];
  let open = false;
  sock.on('connect', () => {
    open = true;
    for (const b of pending.splice(0)) sock.write(b);
  });
  sock.on('data', (d) => {
    if (ws.readyState === ws.OPEN) ws.send(d, { binary: true });
  });
  sock.on('error', () => ws.close(1011, 'Console connection failed'));
  sock.on('close', () => {
    if (ws.readyState === ws.OPEN) ws.close(1000, 'Console closed');
  });
  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    const b = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (open) sock.write(b);
    else pending.push(b);
  });
  ws.on('close', () => sock.destroy());
  ws.on('error', () => sock.destroy());
}
