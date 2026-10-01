import type { WebSocket } from 'ws';
import type { ServerToDeviceMessage } from '@fbrx/shared';

interface DeviceConn {
  socket: WebSocket;
  tenantId: string;
  connectedAt: string;
}

interface AdminConn {
  socket: WebSocket;
  /** null = platform-wide (superadmin). */
  tenantId: string | null;
}

export type AdminEvent =
  | { type: 'device.online' | 'device.offline'; deviceId: string; tenantId: string }
  | { type: 'device.updated'; deviceId: string; tenantId: string; summary: unknown }
  | { type: 'command.updated'; tenantId: string; command: unknown }
  | { type: 'device.event'; tenantId: string; event: unknown }
  | { type: 'audit'; tenantId: string | null; entry: unknown };

/** In-memory registry of live device and admin-console WebSocket connections. */
export class Realtime {
  private readonly devices = new Map<string, DeviceConn>();
  private readonly admins = new Set<AdminConn>();

  addDevice(deviceId: string, tenantId: string, socket: WebSocket): void {
    const prev = this.devices.get(deviceId);
    if (prev && prev.socket !== socket) prev.socket.close(4000, 'replaced by a newer connection');
    this.devices.set(deviceId, { socket, tenantId, connectedAt: new Date().toISOString() });
  }

  removeDevice(deviceId: string, socket: WebSocket): boolean {
    const cur = this.devices.get(deviceId);
    if (cur?.socket !== socket) return false;
    this.devices.delete(deviceId);
    return true;
  }

  isOnline(deviceId: string): boolean {
    return this.devices.has(deviceId);
  }

  onlineCount(tenantId?: string | null): number {
    if (!tenantId) return this.devices.size;
    let n = 0;
    for (const d of this.devices.values()) if (d.tenantId === tenantId) n++;
    return n;
  }

  sendToDevice(deviceId: string, msg: ServerToDeviceMessage): boolean {
    const d = this.devices.get(deviceId);
    if (!d || d.socket.readyState !== d.socket.OPEN) return false;
    d.socket.send(JSON.stringify(msg));
    return true;
  }

  broadcastToTenantDevices(tenantId: string, msg: ServerToDeviceMessage): number {
    let n = 0;
    for (const [id, d] of this.devices) if (d.tenantId === tenantId && this.sendToDevice(id, msg)) n++;
    return n;
  }

  disconnectDevice(deviceId: string, reason: string): void {
    this.devices.get(deviceId)?.socket.close(4001, reason);
  }

  addAdmin(socket: WebSocket, tenantId: string | null): () => void {
    const conn = { socket, tenantId };
    this.admins.add(conn);
    return () => this.admins.delete(conn);
  }

  emitAdmin(event: AdminEvent): void {
    const data = JSON.stringify(event);
    for (const a of this.admins) {
      if (a.tenantId !== null && a.tenantId !== event.tenantId) continue;
      if (a.socket.readyState === a.socket.OPEN) a.socket.send(data);
    }
  }

  closeAll(): void {
    for (const d of this.devices.values()) d.socket.close(1001, 'server shutting down');
    for (const a of this.admins) a.socket.close(1001, 'server shutting down');
    this.devices.clear();
    this.admins.clear();
  }
}
