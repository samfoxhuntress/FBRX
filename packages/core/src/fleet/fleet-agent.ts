import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import WebSocket from 'ws';
import {
  CommandPayloadSchemas,
  PROTOCOL_VERSION,
  isCommandType,
  type CommandResult,
  type DeviceCommand,
  type DeviceConfig,
  type DeviceEvent,
  type DeviceFacts,
  type EnrollResponse,
  type FleetStatus,
  type Heartbeat,
  type HeartbeatResponse,
  type Policy,
  type ServerToDeviceMessage,
  type DeviceToServerMessage,
} from '@fbrx/shared';
import { CoreError, errorMessage } from '../errors';
import type { AuditLog } from '../audit/audit-log';
import type { Db } from '../storage/db';
import type { MetaStore } from '../storage/meta';
import type { EventBus } from '../events';
import type { Logger } from '../logger';
import type { SettingsService } from '../settings/settings-service';
import type { PolicyEngine } from '../governance/policy-engine';
import type { LicenseService } from '../license/license-service';
import type { Vault } from '../vault/vault';
import type { UpdateController } from '../platform';
import { sleep } from '../util/misc';

const TOKEN_SECRET = 'fbrx.fleet.deviceToken';

export interface FleetDeps {
  db: Db;
  meta: MetaStore;
  vault: Vault;
  settings: SettingsService;
  policy: PolicyEngine;
  license: LicenseService;
  audit: AuditLog;
  events: EventBus;
  log: Logger;
  tmpDir: string;
  updates: UpdateController | null;
  facts: () => DeviceFacts;
  heartbeatStatus: () => Promise<Heartbeat['status']>;
  executeCommand: (cmd: DeviceCommand) => Promise<unknown>;
}

class UnauthorizedError extends Error {}

/**
 * The device side of fleet management. Enrolls with a control plane, keeps a WebSocket open for real-time
 * commands (falling back to HTTP polling), reports heartbeats/telemetry, and applies managed configuration:
 * settings + locks, governance policy, license, organisation secrets and the update channel.
 */
export class FleetAgent {
  private ws: WebSocket | null = null;
  private loopAbort: AbortController | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private state: FleetStatus['state'] = 'unenrolled';
  private message: string | null = null;
  private syncing: Promise<void> | null = null;

  constructor(private readonly d: FleetDeps) {}

  get enrolled(): boolean {
    return !!this.d.meta.get<string>('fleet.deviceId');
  }

  get serverUrl(): string | null {
    return this.d.meta.get<string>('fleet.serverUrl');
  }

  get deviceId(): string | null {
    return this.d.meta.get<string>('fleet.deviceId');
  }

  private token(): string {
    if (!this.d.vault.isUnlocked) throw new CoreError('LOCKED', 'Vault is locked; fleet connection paused');
    const t = this.d.vault.get(TOKEN_SECRET, { allowInternal: true });
    if (!t) throw new CoreError('UNAUTHENTICATED', 'Device credential missing; re-enroll this device');
    return t;
  }

  authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.token()}`, 'x-fbrx-device': this.deviceId ?? '', 'x-fbrx-protocol': String(PROTOCOL_VERSION) };
  }

  status(): FleetStatus {
    const m = this.d.meta;
    const eff = this.d.settings.effective();
    return {
      state: this.enrolled ? this.state : 'unenrolled',
      serverUrl: this.serverUrl,
      deviceId: this.deviceId,
      tenantId: m.get('fleet.tenantId'),
      tenantName: m.get('fleet.tenantName'),
      groupName: m.get('fleet.groupName'),
      configVersion: m.get<number>('fleet.configVersion') ?? 0,
      lastSyncAt: m.get('fleet.lastSyncAt'),
      lastHeartbeatAt: m.get('fleet.lastHeartbeatAt'),
      message: this.message,
      lockedSettings: eff.locked,
      policyManaged: this.d.policy.effective().source === 'managed',
      managedSecrets: this.d.vault.status().managedCount,
    };
  }

  private setState(state: FleetStatus['state'], message: string | null = null) {
    const changed = state !== this.state || message !== this.message;
    this.state = state;
    this.message = message;
    if (changed) this.d.events.emit('fleet.changed', this.status());
  }

  private url(path: string): string {
    return `${this.serverUrl!.replace(/\/+$/, '')}${path}`;
  }

  private async http<T>(method: string, path: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
    const res = await fetch(this.url(path), {
      method,
      headers: { ...this.authHeaders(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 || res.status === 403) throw new UnauthorizedError(`Control plane rejected this device (HTTP ${res.status})`);
    if (!res.ok) throw new Error(`Control plane error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  // ------------------------------------------------------------------------------------ enrollment

  async enroll(serverUrl: string, token: string, deviceName: string | undefined, actor: string): Promise<FleetStatus> {
    let base: URL;
    try {
      base = new URL(serverUrl);
      if (!/^https?:$/.test(base.protocol)) throw new Error();
    } catch {
      throw new CoreError('INVALID_ARGUMENT', 'Server URL must be an http(s) URL');
    }
    if (base.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(base.hostname) && process.env.FBRX_ALLOW_INSECURE_FLEET !== '1') {
      throw new CoreError('INVALID_ARGUMENT', 'Use https:// for remote control planes (set FBRX_ALLOW_INSECURE_FLEET=1 to override in labs)');
    }
    if (!this.d.vault.isUnlocked) throw new CoreError('LOCKED', 'Unlock the vault before enrolling');
    if (deviceName) this.d.settings.update({ general: { deviceName } });
    const facts = this.d.facts();
    const res = await fetch(new URL('/v1/enroll', base).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, protocolVersion: PROTOCOL_VERSION, device: facts, previousDeviceId: this.d.meta.get('fleet.previousDeviceId') ?? undefined }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as EnrollResponse & { error?: { message?: string } };
    if (!res.ok) {
      this.d.audit.append({ category: 'fleet', action: 'enroll', actor, target: base.origin, outcome: 'failure', details: { status: res.status, error: body.error?.message } });
      throw new CoreError('UNAUTHENTICATED', body.error?.message ?? `Enrollment failed (HTTP ${res.status})`);
    }
    await this.stop();
    this.d.vault.set({ name: TOKEN_SECRET, value: body.deviceToken, kind: 'token', description: 'FBRX fleet device credential' }, { internal: true });
    const m = this.d.meta;
    m.set('fleet.serverUrl', base.origin + base.pathname.replace(/\/+$/, ''));
    m.set('fleet.deviceId', body.deviceId);
    m.set('fleet.tenantId', body.tenantId);
    m.set('fleet.tenantName', body.tenantName);
    m.set('fleet.groupId', body.groupId);
    m.set('fleet.heartbeatSeconds', body.heartbeatSeconds);
    m.set('fleet.configVersion', 0);
    this.d.audit.append({ category: 'fleet', action: 'enrolled', actor, target: base.origin, outcome: 'success', details: { deviceId: body.deviceId, tenant: body.tenantName } });
    this.d.log.info('Enrolled with control plane', { server: base.origin, deviceId: body.deviceId });
    try {
      await this.sync();
    } catch (err) {
      this.d.log.warn('Initial config sync failed', { error: errorMessage(err) });
    }
    this.start();
    return this.status();
  }

  async unenroll(actor: string): Promise<FleetStatus> {
    if (!this.enrolled) return this.status();
    try {
      await this.http('POST', '/v1/device/unenroll', {});
    } catch {
      /* best effort: the server may already have revoked us */
    }
    await this.stop();
    const prev = this.deviceId;
    this.d.meta.deletePrefix('fleet.');
    if (prev) this.d.meta.set('fleet.previousDeviceId', prev);
    try {
      this.d.vault.delete(TOKEN_SECRET, { internal: true });
    } catch {
      /* locked */
    }
    this.d.settings.clearManaged();
    this.d.policy.applyManaged(null);
    this.d.license.applyManaged(null);
    if (this.d.vault.isUnlocked) this.d.vault.clearManaged();
    this.d.updates?.configure({ feedUrl: null, channel: this.d.settings.get().updates.channel, headers: {}, allowDowngrade: false });
    this.d.audit.append({ category: 'fleet', action: 'unenrolled', actor, target: prev, outcome: 'success' });
    this.setState('unenrolled');
    return this.status();
  }

  // ------------------------------------------------------------------------------------ config sync

  sync(): Promise<void> {
    if (!this.syncing) this.syncing = this.doSync().finally(() => (this.syncing = null));
    return this.syncing;
  }

  private async doSync(): Promise<void> {
    const cfg = await this.http<DeviceConfig>('GET', '/v1/device/config');
    const m = this.d.meta;
    const hasSettings = Object.keys(cfg.settings ?? {}).length > 0 || cfg.lockedSettings.length > 0;
    try {
      if (hasSettings) this.d.settings.applyManaged(cfg.settings, cfg.lockedSettings);
      else this.d.settings.clearManaged();
    } catch (err) {
      this.d.log.error('Managed settings rejected', { error: errorMessage(err) });
    }
    try {
      this.d.policy.applyManaged((cfg.policy as Policy | null) ?? null);
    } catch (err) {
      this.d.log.error('Managed policy rejected', { error: errorMessage(err) });
    }
    this.d.license.applyManaged(cfg.license);
    let secrets = { added: 0, updated: 0, removed: 0 };
    if (this.d.vault.isUnlocked) secrets = this.d.vault.applyManaged(cfg.secrets ?? []);
    m.set('fleet.configVersion', cfg.version);
    m.set('fleet.tenantName', cfg.tenantName);
    m.set('fleet.groupId', cfg.groupId);
    m.set('fleet.groupName', cfg.groupName);
    m.set('fleet.updateChannel', cfg.updateChannel);
    m.set('fleet.pinnedVersion', cfg.pinnedVersion);
    m.set('fleet.lastSyncAt', new Date().toISOString());
    this.configureUpdates();
    this.d.audit.append({
      category: 'fleet',
      action: 'config.applied',
      actor: 'control-plane',
      target: String(cfg.version),
      outcome: 'success',
      details: { lockedSettings: cfg.lockedSettings.length, policy: !!cfg.policy, license: !!cfg.license, secrets, channel: cfg.updateChannel, pinnedVersion: cfg.pinnedVersion },
    });
    this.d.events.emit('fleet.changed', this.status());
  }

  configureUpdates(): void {
    if (!this.d.updates || !this.enrolled) return;
    try {
      this.d.updates.configure({
        feedUrl: this.url('/v1/updates/feed'),
        channel: (this.d.meta.get<string>('fleet.updateChannel') ?? this.d.settings.get().updates.channel) as never,
        headers: this.authHeaders(),
        allowDowngrade: !!this.d.meta.get('fleet.pinnedVersion'),
      });
    } catch (err) {
      this.d.log.warn('Could not configure update feed', { error: errorMessage(err) });
    }
  }

  // ----------------------------------------------------------------------------------- connection

  start(): void {
    if (!this.enrolled || this.loopAbort) return;
    this.loopAbort = new AbortController();
    void this.loop(this.loopAbort.signal);
  }

  async stop(): Promise<void> {
    this.loopAbort?.abort();
    this.loopAbort = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000, 'stopping');
    if (this.enrolled) this.setState('offline', 'Stopped');
  }

  private async loop(signal: AbortSignal) {
    let backoff = 1000;
    this.configureUpdates();
    while (!signal.aborted) {
      try {
        this.setState('connecting');
        await this.connect(signal);
        backoff = 1000;
      } catch (err) {
        if (signal.aborted) break;
        if (err instanceof UnauthorizedError) {
          this.setState('error', `${err.message}. The device may have been revoked; re-enroll to reconnect.`);
          this.d.audit.append({ category: 'fleet', action: 'rejected', actor: 'control-plane', outcome: 'failure', details: { error: err.message } });
          return;
        }
        if (err instanceof CoreError && err.code === 'LOCKED') {
          this.setState('error', err.message);
          await sleep(15_000, signal).catch(() => undefined);
          continue;
        }
        this.setState('offline', errorMessage(err));
        // While the socket is down, fall back to an HTTP heartbeat so commands still flow.
        try {
          await this.httpHeartbeat();
        } catch (e) {
          if (e instanceof UnauthorizedError) {
            this.setState('error', e.message);
            return;
          }
        }
      }
      if (signal.aborted) break;
      await sleep(backoff + Math.random() * 500, signal).catch(() => undefined);
      backoff = Math.min(backoff * 2, 60_000);
    }
  }

  private connect(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.url('/v1/device/ws').replace(/^http/, 'ws');
      const ws = new WebSocket(wsUrl, { headers: this.authHeaders(), handshakeTimeout: 15_000 });
      this.ws = ws;
      let opened = false;
      const onAbort = () => ws.close(1000, 'stopping');
      signal.addEventListener('abort', onAbort, { once: true });
      ws.on('unexpected-response', (_req, res) => {
        const status = res.statusCode ?? 0;
        ws.terminate();
        reject(status === 401 || status === 403 ? new UnauthorizedError(`Control plane rejected this device (HTTP ${status})`) : new Error(`WebSocket upgrade failed (HTTP ${status})`));
      });
      ws.on('open', () => {
        opened = true;
        this.setState('online');
        void this.sendHeartbeat();
        const seconds = this.d.meta.get<number>('fleet.heartbeatSeconds') ?? this.d.settings.get().fleet.heartbeatSeconds;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), Math.max(10, seconds) * 1000);
      });
      ws.on('message', (raw) => {
        let msg: ServerToDeviceMessage;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        void this.onServerMessage(msg);
      });
      ws.on('error', (err) => {
        if (!opened) reject(err);
      });
      ws.on('close', () => {
        signal.removeEventListener('abort', onAbort);
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        if (this.ws === ws) this.ws = null;
        if (opened) resolve();
        else reject(new Error('Connection closed'));
      });
    });
  }

  private send(msg: DeviceToServerMessage): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  private async onServerMessage(msg: ServerToDeviceMessage) {
    switch (msg.type) {
      case 'hello':
      case 'config.changed': {
        const version = msg.type === 'hello' ? msg.configVersion : msg.version;
        if (version !== (this.d.meta.get<number>('fleet.configVersion') ?? 0)) {
          await this.sync().catch((err) => this.d.log.warn('Config sync failed', { error: errorMessage(err) }));
        }
        break;
      }
      case 'command':
        await this.handleCommand(msg.command);
        break;
      case 'ping':
        this.send({ type: 'pong', at: new Date().toISOString() });
        break;
    }
  }

  private async buildHeartbeat(): Promise<Heartbeat> {
    return {
      facts: this.d.facts(),
      configVersion: this.d.meta.get<number>('fleet.configVersion') ?? 0,
      status: await this.d.heartbeatStatus(),
    };
  }

  private async sendHeartbeat() {
    try {
      const hb = await this.buildHeartbeat();
      if (this.send({ type: 'heartbeat', heartbeat: hb })) this.d.meta.set('fleet.lastHeartbeatAt', new Date().toISOString());
    } catch (err) {
      this.d.log.warn('Heartbeat failed', { error: errorMessage(err) });
    }
  }

  private async httpHeartbeat() {
    const res = await this.http<HeartbeatResponse>('POST', '/v1/device/heartbeat', await this.buildHeartbeat());
    this.d.meta.set('fleet.lastHeartbeatAt', new Date().toISOString());
    if (res.configVersion !== (this.d.meta.get<number>('fleet.configVersion') ?? 0)) await this.sync();
    for (const c of res.commands) await this.handleCommand(c);
  }

  /** Emits an event (alert/audit/state) to the control plane. */
  reportEvent(event: DeviceEvent) {
    this.send({ type: 'event', event });
  }

  // -------------------------------------------------------------------------------------- commands

  private async report(commandId: string, result: CommandResult) {
    if (this.send({ type: 'command.result', commandId, result })) return;
    try {
      await this.http('POST', `/v1/device/commands/${encodeURIComponent(commandId)}/result`, result);
    } catch (err) {
      this.d.log.warn('Could not report command result', { commandId, error: errorMessage(err) });
    }
  }

  async handleCommand(cmd: DeviceCommand) {
    const prior = this.d.db.get<{ status: string; result: string | null }>('SELECT status, result FROM fleet_commands WHERE id = ?', cmd.id);
    if (prior && prior.status !== 'running') {
      await this.report(cmd.id, JSON.parse(prior.result ?? '{"status":"failed","error":"unknown"}'));
      return;
    }
    if (prior?.status === 'running') return;
    this.d.db.run(
      'INSERT INTO fleet_commands (id, type, payload, status, received_at) VALUES (?,?,?,?,?)',
      cmd.id,
      cmd.type,
      JSON.stringify(cmd.payload ?? {}),
      'running',
      new Date().toISOString(),
    );
    await this.report(cmd.id, { status: 'running' });
    let result: CommandResult;
    try {
      if (cmd.expiresAt && new Date(cmd.expiresAt).getTime() < Date.now()) throw new Error('Command expired before it was delivered');
      if (!isCommandType(cmd.type)) throw new Error(`Unsupported command ${cmd.type}`);
      const payload = CommandPayloadSchemas[cmd.type].parse(cmd.payload ?? {});
      const out = await this.d.executeCommand({ ...cmd, payload });
      result = { status: 'succeeded', result: out ?? null };
    } catch (err) {
      result = { status: 'failed', error: errorMessage(err).slice(0, 4000) };
    }
    this.d.db.run('UPDATE fleet_commands SET status = ?, result = ?, completed_at = ? WHERE id = ?', result.status, JSON.stringify(result), new Date().toISOString(), cmd.id);
    this.d.audit.append({
      category: 'fleet',
      action: `command.${cmd.type}`,
      actor: 'control-plane',
      target: cmd.id,
      outcome: result.status === 'succeeded' ? 'success' : 'failure',
      details: result.status === 'failed' ? { error: result.error } : undefined,
    });
    await this.report(cmd.id, result);
  }

  // ------------------------------------------------------------------------------------ transfers

  async uploadSnapshot(file: string, label: string | null): Promise<{ snapshotId: string }> {
    const size = statSync(file).size;
    const res = await fetch(this.url('/v1/device/snapshots'), {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        'content-type': 'application/octet-stream',
        'content-length': String(size),
        'x-fbrx-snapshot-name': encodeURIComponent(basename(file)),
        ...(label ? { 'x-fbrx-snapshot-label': encodeURIComponent(label) } : {}),
      },
      body: Readable.toWeb(createReadStream(file)) as unknown as BodyInit,
      duplex: 'half',
      signal: AbortSignal.timeout(60 * 60_000),
    } as RequestInit & { duplex: 'half' });
    if (!res.ok) throw new Error(`Snapshot upload failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as { snapshotId: string };
  }

  /** Downloads a file from the control plane (plugin package, template snapshot) and verifies its checksum. */
  async download(pathOrUrl: string, sha256: string | null, fileName: string): Promise<string> {
    const url = /^https?:/i.test(pathOrUrl) ? pathOrUrl : this.url(pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`);
    const sameOrigin = new URL(url).origin === new URL(this.serverUrl!).origin;
    const res = await fetch(url, { headers: sameOrigin ? this.authHeaders() : {}, signal: AbortSignal.timeout(30 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
    const dest = join(this.d.tmpDir, `${Date.now()}-${fileName.replace(/[^A-Za-z0-9._-]/g, '_')}`);
    const hash = createHash('sha256');
    await pipeline(
      Readable.fromWeb(res.body as never),
      async function* (src: AsyncIterable<Buffer>) {
        for await (const chunk of src) {
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(dest),
    );
    const digest = hash.digest('hex');
    if (sha256 && digest !== sha256.toLowerCase()) {
      await rm(dest, { force: true });
      throw new Error('Checksum mismatch on downloaded file');
    }
    return dest;
  }
}
