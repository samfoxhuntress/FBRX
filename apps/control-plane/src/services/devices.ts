import { HeartbeatSchema, newId, type Heartbeat } from '@fbrx/shared';
import type { AppContext } from '../context';
import { parseJson } from '../routes/util';

export function deviceView(ctx: AppContext, d: any) {
  const hb = parseJson<Heartbeat | null>(d.heartbeat, null);
  const s = hb?.status;
  const failing = (s?.services ?? []).filter((x) => x.state === 'failed').map((x) => x.name);
  const degraded = (s?.services ?? []).filter((x) => x.state === 'degraded').map((x) => x.name);
  const lastSeenMs = d.last_seen_at ? Date.now() - new Date(d.last_seen_at).getTime() : Infinity;
  const online = ctx.realtime.isOnline(d.id) || lastSeenMs < ctx.config.heartbeatSeconds * 3000;
  return {
    id: d.id,
    tenantId: d.tenant_id,
    groupId: d.group_id,
    name: d.name,
    hostname: d.hostname,
    platform: d.platform,
    arch: d.arch,
    osVersion: d.os_version,
    appVersion: d.app_version,
    status: d.status,
    online,
    realtime: ctx.realtime.isOnline(d.id),
    enrolledAt: d.enrolled_at,
    lastSeenAt: d.last_seen_at,
    lastIp: d.last_ip,
    configVersion: Number(d.config_version),
    tags: parseJson<string[]>(d.tags, []),
    notes: d.notes,
    updateChannel: d.update_channel,
    pinnedVersion: d.pinned_version,
    audience: d.audience ?? null,
    helpdeskReceiver: Number(d.helpdesk_receiver ?? 0) === 1,
    settingsOverride: parseJson<Record<string, unknown>>(d.settings_override, {}),
    lockedOverride: parseJson<string[]>(d.locked_override, []),
    policyOverride: parseJson<unknown>(d.policy_override, null),
    health: s
      ? {
          state: failing.length || s.protection?.state === 'at-risk' ? 'critical' : degraded.length || s.vaultState !== 'unlocked' || s.protection?.state === 'attention' ? 'warning' : 'healthy',
          failingServices: failing,
          degradedServices: degraded,
          cpuLoad: s.cpuLoad,
          memUsedPct: s.memUsedPct,
          memTotalMb: s.memTotalMb,
          diskFreeGb: s.diskFreeGb,
          vaultState: s.vaultState,
          licenseEdition: s.licenseEdition,
          licenseState: s.licenseState,
          activeAgentRuns: s.activeAgentRuns,
          pendingApprovals: s.pendingApprovals,
          agentRuns24h: s.agentRuns24h,
          toolCalls24h: s.toolCalls24h,
          policyDenials24h: s.policyDenials24h,
          errors24h: s.errors24h,
          lastBackupAt: s.lastBackupAt,
          plugins: s.plugins,
          runtimeModel: s.runtimeModel,
          uptimeSeconds: s.uptimeSeconds,
          services: s.services,
          protection: s.protection ?? null,
        }
      : null,
  };
}

export function recordDeviceEvent(ctx: AppContext, device: { id: string; tenant_id: string; name: string }, kind: string, severity: 'info' | 'warning' | 'critical', message: string, data?: unknown) {
  const ev = { id: newId('evt'), tenantId: device.tenant_id, deviceId: device.id, deviceName: device.name, ts: new Date().toISOString(), kind, severity, message, data: data ?? null };
  ctx.db.run(
    'INSERT INTO device_events (id, tenant_id, device_id, ts, kind, severity, message, data) VALUES (?,?,?,?,?,?,?,?)',
    ev.id,
    ev.tenantId,
    ev.deviceId,
    ev.ts,
    kind,
    severity,
    message.slice(0, 2000),
    data === undefined ? null : JSON.stringify(data),
  );
  ctx.realtime.emitAdmin({ type: 'device.event', tenantId: device.tenant_id, event: ev });
  if (severity !== 'info') ctx.webhooks.emit(device.tenant_id, 'device.alert', ev);
  return ev;
}

/** Applies a heartbeat: facts, health, telemetry sample, identity/audit-anchor checks and alerts. */
export function processHeartbeat(ctx: AppContext, deviceId: string, raw: unknown, ip: string | null): void {
  const hb = HeartbeatSchema.parse(raw);
  const d = ctx.db.get<any>('SELECT * FROM devices WHERE id = ?', deviceId);
  if (!d) return;
  const now = new Date().toISOString();
  const prev = parseJson<Heartbeat | null>(d.heartbeat, null);

  if (hb.facts.machineId !== d.machine_id) {
    recordDeviceEvent(ctx, d, 'identity.changed', 'warning', `Device identity moved to different hardware (${hb.facts.hostname})`, { from: d.machine_id.slice(0, 12), to: hb.facts.machineId.slice(0, 12) });
  }
  if (d.audit_head_seq !== null && hb.status.auditHead.seq < Number(d.audit_head_seq)) {
    recordDeviceEvent(ctx, d, 'audit.rollback', 'warning', `Device audit log went backwards (#${d.audit_head_seq} → #${hb.status.auditHead.seq}); expected after a restore, otherwise investigate`);
  }
  const prevFailed = new Set((prev?.status.services ?? []).filter((s) => s.state === 'failed').map((s) => s.name));
  for (const s of hb.status.services) {
    if (s.state === 'failed' && !prevFailed.has(s.name)) recordDeviceEvent(ctx, d, 'service.failed', 'critical', `Service ${s.name} failed: ${s.message ?? 'no details'}`);
  }
  if (prev && prev.status.vaultState === 'unlocked' && hb.status.vaultState === 'locked') {
    recordDeviceEvent(ctx, d, 'vault.locked', 'warning', 'Credential vault is locked on this device');
  }

  ctx.db.run(
    `UPDATE devices SET hostname = ?, platform = ?, arch = ?, os_version = ?, app_version = ?, machine_id = ?, last_seen_at = ?, last_ip = ?,
       heartbeat = ?, config_version = ?, audit_head_seq = ?, audit_head_hash = ?, updated_at = ? WHERE id = ?`,
    hb.facts.hostname,
    hb.facts.platform,
    hb.facts.arch,
    hb.facts.osVersion,
    hb.facts.appVersion,
    hb.facts.machineId,
    now,
    ip,
    JSON.stringify(hb),
    hb.configVersion,
    hb.status.auditHead.seq,
    hb.status.auditHead.hash,
    now,
    deviceId,
  );
  const last = ctx.db.get<{ ts: string }>('SELECT ts FROM device_metrics WHERE device_id = ? ORDER BY ts DESC LIMIT 1', deviceId);
  if (!last || Date.now() - new Date(last.ts).getTime() > 55_000) {
    ctx.db.run(
      'INSERT INTO device_metrics (device_id, ts, cpu, mem, disk_free, agent_runs, tool_calls, denials, errors) VALUES (?,?,?,?,?,?,?,?,?)',
      deviceId,
      now,
      hb.status.cpuLoad,
      hb.status.memUsedPct,
      hb.status.diskFreeGb,
      hb.status.agentRuns24h,
      hb.status.toolCalls24h,
      hb.status.policyDenials24h,
      hb.status.errors24h,
    );
  }
  const updated = ctx.db.get<any>('SELECT * FROM devices WHERE id = ?', deviceId);
  ctx.realtime.emitAdmin({ type: 'device.updated', deviceId, tenantId: d.tenant_id, summary: deviceView(ctx, updated) });
}

export function commandView(c: any) {
  return {
    id: c.id,
    tenantId: c.tenant_id,
    deviceId: c.device_id,
    type: c.type,
    payload: parseJson(c.payload, {}),
    status: c.status,
    createdBy: c.created_by,
    createdAt: c.created_at,
    sentAt: c.sent_at,
    startedAt: c.started_at,
    completedAt: c.completed_at,
    expiresAt: c.expires_at,
    result: parseJson(c.result, null),
    error: c.error,
  };
}

export function processCommandResult(ctx: AppContext, deviceId: string, commandId: string, result: { status: string; result?: unknown; error?: string }) {
  const c = ctx.db.get<any>('SELECT * FROM commands WHERE id = ? AND device_id = ?', commandId, deviceId);
  if (!c || ['succeeded', 'failed', 'cancelled', 'expired'].includes(c.status)) return;
  const now = new Date().toISOString();
  if (result.status === 'running') {
    ctx.db.run("UPDATE commands SET status = 'running', started_at = ?, sent_at = COALESCE(sent_at, ?) WHERE id = ?", now, now, commandId);
  } else {
    ctx.db.run(
      'UPDATE commands SET status = ?, completed_at = ?, result = ?, error = ? WHERE id = ?',
      result.status === 'succeeded' ? 'succeeded' : 'failed',
      now,
      result.result === undefined ? null : JSON.stringify(result.result).slice(0, 2_000_000),
      result.error ?? null,
      commandId,
    );
  }
  const updated = commandView(ctx.db.get<any>('SELECT * FROM commands WHERE id = ?', commandId));
  ctx.realtime.emitAdmin({ type: 'command.updated', tenantId: c.tenant_id, command: updated });
  if (updated.status === 'succeeded') ctx.webhooks.emit(c.tenant_id, 'command.completed', updated);
  if (updated.status === 'failed') ctx.webhooks.emit(c.tenant_id, 'command.failed', updated);
}

/** Queued, unexpired commands for a device (marked as sent). */
export function takePendingCommands(ctx: AppContext, deviceId: string) {
  const now = new Date().toISOString();
  ctx.db.run("UPDATE commands SET status = 'expired', completed_at = ? WHERE device_id = ? AND status = 'queued' AND expires_at IS NOT NULL AND expires_at < ?", now, deviceId, now);
  const rows = ctx.db.all<any>("SELECT * FROM commands WHERE device_id = ? AND status = 'queued' ORDER BY created_at", deviceId);
  for (const r of rows) ctx.db.run("UPDATE commands SET status = 'sent', sent_at = ? WHERE id = ?", now, r.id);
  return rows.map((r) => ({ id: r.id, type: r.type, payload: JSON.parse(r.payload), createdAt: r.created_at, expiresAt: r.expires_at }));
}
