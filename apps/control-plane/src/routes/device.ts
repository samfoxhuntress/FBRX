import { createReadStream, existsSync, openSync, readSync, closeSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Readable } from 'node:stream';
import { CommandResultSchema, DeviceEventSchema, EnrollRequestSchema, PROTOCOL_VERSION, featuresFor, type DeviceToServerMessage, type Edition, type EnrollResponse, type HeartbeatResponse } from '@fbrx/shared';
import { randomToken, sha256Hex } from '@fbrx/shared/node';
import type { AppContext } from '../context';
import { ids } from '../context';
import { actorOf, deviceAuth } from '../auth';
import { HttpError, badRequest, forbidden, notFound, unauthorized } from '../errors';
import { resolveDeviceConfig } from '../services/device-config';
import { parseJson } from './util';
import { commandView, processCommandResult, processHeartbeat, recordDeviceEvent, takePendingCommands } from '../services/devices';
import { storeStream } from '../services/storage';

/** Reads the plaintext, authenticated header of a .fbrxsnap without decrypting it. */
export function snapshotHeader(file: string): Record<string, unknown> | null {
  try {
    const fd = openSync(file, 'r');
    try {
      const pre = Buffer.alloc(12);
      readSync(fd, pre, 0, 12, 0);
      if (pre.subarray(0, 8).toString() !== 'FBRXSNAP') return null;
      const len = pre.readUInt32BE(8);
      if (len > 1_000_000) return null;
      const h = Buffer.alloc(len);
      readSync(fd, h, 0, len, 12);
      return JSON.parse(h.toString('utf8'));
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

export async function deviceRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = deviceAuth(ctx);

  app.post('/v1/enroll', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const body = EnrollRequestSchema.parse(req.body);
    if (body.protocolVersion > PROTOCOL_VERSION) throw badRequest('This control plane is older than the device; upgrade the control plane');
    const t = ctx.db.get<any>('SELECT * FROM enrollment_tokens WHERE token_hash = ?', sha256Hex(body.token));
    const now = new Date().toISOString();
    if (!t || t.revoked_at || (t.expires_at && t.expires_at < now) || (t.max_uses !== null && Number(t.uses) >= Number(t.max_uses))) {
      ctx.audit.record({ type: 'system', id: null, label: `enroll:${body.device.hostname}`, tenantId: t?.tenant_id ?? null, ip: req.ip }, 'device.enroll.rejected', {}, { reason: 'invalid token' });
      throw unauthorized('Enrollment token is invalid, expired or used up');
    }
    const tenant = ctx.db.get<any>('SELECT * FROM tenants WHERE id = ?', t.tenant_id);
    if (!tenant || tenant.status !== 'active') throw forbidden('Organisation is not active');
    const lic = ctx.db.get<{ seats: number; edition: Edition; features: string }>(
      'SELECT seats, edition, features FROM licenses WHERE tenant_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY issued_at DESC LIMIT 1',
      t.tenant_id,
      now,
    );
    // Tenants without a licence may enroll (trials, internal use; devices run Community features). A licensed tenant
    // needs fleet management in its edition or as an extra feature.
    if (lic && !featuresFor({ edition: lic.edition, features: parseJson<string[]>(lic.features, []) }).includes('fleet')) {
      ctx.audit.record({ type: 'system', id: null, label: `enroll:${body.device.hostname}`, tenantId: t.tenant_id, ip: req.ip }, 'device.enroll.rejected', {}, { reason: 'license lacks fleet' });
      throw forbidden(`The ${lic.edition} license for this organisation does not include fleet management`);
    }
    if (lic && Number(lic.seats) > 0) {
      const active = Number(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM devices WHERE tenant_id = ? AND status = 'active'", t.tenant_id)?.n ?? 0);
      if (active >= Number(lic.seats)) throw forbidden(`License seat limit reached (${lic.seats} devices)`);
    }
    const deviceId = ids.device();
    const deviceToken = randomToken('fbrx_dev');
    const f = body.device;
    ctx.db.tx(() => {
      ctx.db.run(
        `INSERT INTO devices (id, tenant_id, group_id, name, hostname, platform, arch, os_version, app_version, machine_id, token_hash, enrolled_at, enrolled_via, last_seen_at, last_ip, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        deviceId,
        t.tenant_id,
        t.group_id,
        f.name || f.hostname,
        f.hostname,
        f.platform,
        f.arch,
        f.osVersion,
        f.appVersion,
        f.machineId,
        sha256Hex(deviceToken),
        now,
        t.id,
        now,
        req.ip,
        now,
      );
      ctx.db.run('UPDATE enrollment_tokens SET uses = uses + 1 WHERE id = ?', t.id);
    });
    const group = t.group_id ? ctx.db.get<any>('SELECT name FROM groups WHERE id = ?', t.group_id) : null;
    ctx.audit.record(
      { type: 'device', id: deviceId, label: `device:${f.name || f.hostname}`, tenantId: t.tenant_id, ip: req.ip },
      'device.enrolled',
      { type: 'device', id: deviceId },
      { hostname: f.hostname, platform: f.platform, appVersion: f.appVersion, token: t.label, group: group?.name, previousDeviceId: body.previousDeviceId },
    );
    ctx.webhooks.emit(t.tenant_id, 'device.enrolled', { deviceId, name: f.name, hostname: f.hostname, platform: f.platform, appVersion: f.appVersion });
    ctx.realtime.emitAdmin({ type: 'device.online', deviceId, tenantId: t.tenant_id });
    const res: EnrollResponse = {
      deviceId,
      deviceToken,
      tenantId: t.tenant_id,
      tenantName: tenant.name,
      groupId: t.group_id,
      heartbeatSeconds: ctx.config.heartbeatSeconds,
      serverTime: now,
    };
    return res;
  });

  app.get('/v1/device/config', { preHandler: auth }, async (req) => resolveDeviceConfig(ctx.db, ctx.keys.master, req.device!.id));

  app.post('/v1/device/heartbeat', { preHandler: auth }, async (req) => {
    processHeartbeat(ctx, req.device!.id, req.body, req.ip);
    const tenant = ctx.db.get<{ v: number }>('SELECT config_version AS v FROM tenants WHERE id = ?', req.device!.tenant_id);
    const res: HeartbeatResponse = {
      serverTime: new Date().toISOString(),
      configVersion: Number(tenant?.v ?? 0),
      heartbeatSeconds: ctx.config.heartbeatSeconds,
      commands: takePendingCommands(ctx, req.device!.id) as HeartbeatResponse['commands'],
    };
    return res;
  });

  app.post('/v1/device/commands/:id/result', { preHandler: auth }, async (req) => {
    const { id } = req.params as { id: string };
    processCommandResult(ctx, req.device!.id, id, CommandResultSchema.parse(req.body));
    return { ok: true };
  });

  app.post('/v1/device/unenroll', { preHandler: auth }, async (req) => {
    const d = req.device!;
    ctx.db.run("UPDATE devices SET status = 'retired', token_hash = ?, updated_at = ? WHERE id = ?", `retired:${ids.device()}`, new Date().toISOString(), d.id);
    ctx.audit.record(actorOf(req), 'device.unenrolled', { type: 'device', id: d.id });
    ctx.webhooks.emit(d.tenant_id, 'device.retired', { deviceId: d.id, name: d.name, by: 'device' });
    return { ok: true };
  });

  app.post('/v1/device/snapshots', { preHandler: auth, bodyLimit: ctx.config.maxUploadBytes }, async (req) => {
    const d = req.device!;
    const id = ids.snapshot();
    const name = decodeURIComponent(String(req.headers['x-fbrx-snapshot-name'] ?? `${id}.fbrxsnap`)).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
    const label = req.headers['x-fbrx-snapshot-label'] ? decodeURIComponent(String(req.headers['x-fbrx-snapshot-label'])).slice(0, 120) : null;
    const dest = join(ctx.config.dataDir, 'snapshots', d.tenant_id, `${id}.fbrxsnap`);
    const stored = await storeStream(req.body as Readable, dest, ctx.config.maxUploadBytes);
    const header = snapshotHeader(dest);
    if (!header) {
      rmSync(dest, { force: true });
      throw badRequest('Upload is not an FBRX OS snapshot');
    }
    ctx.db.run(
      'INSERT INTO snapshots (id, tenant_id, device_id, device_name, name, label, size, sha256, header, storage_path, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id,
      d.tenant_id,
      d.id,
      d.name,
      name,
      label,
      stored.size,
      stored.sha256,
      JSON.stringify(header),
      dest,
      new Date().toISOString(),
    );
    // Retention: keep the newest N non-template snapshots per device.
    const old = ctx.db.all<{ id: string; storage_path: string }>(
      'SELECT id, storage_path FROM snapshots WHERE device_id = ? AND is_template = 0 ORDER BY created_at DESC LIMIT -1 OFFSET ?',
      d.id,
      ctx.config.snapshotRetentionPerDevice,
    );
    for (const o of old) {
      rmSync(o.storage_path, { force: true });
      ctx.db.run('DELETE FROM snapshots WHERE id = ?', o.id);
    }
    ctx.audit.record(actorOf(req), 'snapshot.uploaded', { type: 'snapshot', id }, { size: stored.size, label });
    ctx.webhooks.emit(d.tenant_id, 'snapshot.uploaded', { snapshotId: id, deviceId: d.id, deviceName: d.name, size: stored.size, label });
    return { snapshotId: id };
  });

  app.get('/v1/device/packages/:id', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = ctx.db.get<any>('SELECT * FROM packages WHERE id = ?', id);
    if (!p || (p.tenant_id && p.tenant_id !== req.device!.tenant_id)) throw notFound();
    if (!existsSync(p.storage_path)) throw notFound('Package file missing');
    reply.header('content-type', 'application/gzip').header('x-fbrx-sha256', p.sha256);
    return reply.send(createReadStream(p.storage_path));
  });

  app.get('/v1/device/ws', { websocket: true, preHandler: auth }, (socket, req) => {
    const d = req.device!;
    ctx.realtime.addDevice(d.id, d.tenant_id, socket);
    ctx.db.run('UPDATE devices SET last_seen_at = ?, last_ip = ? WHERE id = ?', new Date().toISOString(), req.ip, d.id);
    ctx.realtime.emitAdmin({ type: 'device.online', deviceId: d.id, tenantId: d.tenant_id });
    ctx.webhooks.emit(d.tenant_id, 'device.online', { deviceId: d.id, name: d.name });
    const tenant = ctx.db.get<{ v: number }>('SELECT config_version AS v FROM tenants WHERE id = ?', d.tenant_id);
    socket.send(JSON.stringify({ type: 'hello', serverTime: new Date().toISOString(), configVersion: Number(tenant?.v ?? 0) }));
    for (const command of takePendingCommands(ctx, d.id)) socket.send(JSON.stringify({ type: 'command', command }));

    let alive = true;
    socket.on('pong', () => (alive = true));
    const keepalive = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, 30_000);

    socket.on('message', (raw: Buffer) => {
      let msg: DeviceToServerMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      try {
        switch (msg.type) {
          case 'heartbeat':
            processHeartbeat(ctx, d.id, msg.heartbeat, req.ip);
            break;
          case 'command.result':
            processCommandResult(ctx, d.id, String(msg.commandId), CommandResultSchema.parse(msg.result));
            break;
          case 'event': {
            const ev = DeviceEventSchema.parse(msg.event);
            recordDeviceEvent(ctx, d, ev.kind, ev.severity, ev.message, ev.data);
            break;
          }
        }
      } catch (err) {
        ctx.log.warn({ err, device: d.id }, 'Invalid device message');
      }
    });
    socket.on('close', () => {
      clearInterval(keepalive);
      if (ctx.realtime.removeDevice(d.id, socket)) {
        ctx.realtime.emitAdmin({ type: 'device.offline', deviceId: d.id, tenantId: d.tenant_id });
        ctx.webhooks.emit(d.tenant_id, 'device.offline', { deviceId: d.id, name: d.name });
      }
    });
  });

  app.get('/v1/device/commands', { preHandler: auth }, async (req) => {
    return ctx.db.all<any>('SELECT * FROM commands WHERE device_id = ? ORDER BY created_at DESC LIMIT 50', req.device!.id).map(commandView);
  });

  void HttpError;
}
