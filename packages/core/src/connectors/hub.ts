import { CONNECTOR_TYPES, newId, type ConnectorInfo, type ConnectorInput, type ConnectorTypeInfo } from '@fbrx/shared';
import { CoreError, errorMessage } from '../errors';
import type { AuditLog } from '../audit/audit-log';
import type { Db } from '../storage/db';
import type { EventBus } from '../events';
import type { LicenseService } from '../license/license-service';
import type { Logger } from '../logger';
import type { ToolRegistry } from '../tools/registry';
import type { Vault } from '../vault/vault';
import { slugify } from '../util/misc';
import { McpConnector } from './mcp';
import { PeerConnector } from './peer';
import { RestConnector } from './rest';
import { WEBHOOK_EVENTS, WebhookConnector } from './webhook';
import type { ConnectorDriver, ConnectorRecord } from './types';

const RESERVED = new Set(['fs', 'shell', 'http', 'system', 'memory', 'time', 'fbrx']);

interface Row {
  id: string;
  name: string;
  slug: string;
  type: ConnectorRecord['type'];
  enabled: number;
  config: string;
  managed: number;
  created_at: string;
  updated_at: string;
}

export const CONNECTOR_TYPE_INFO: ConnectorTypeInfo[] = [
  {
    type: 'rest',
    title: 'REST / JSON API',
    description: 'Give the agent read (and optionally write) access to an HTTP API: CRMs, ticketing, internal services.',
    fields: [
      { key: 'baseUrl', label: 'Base URL', kind: 'url', required: true, placeholder: 'https://api.example.com/v1' },
      { key: 'authType', label: 'Authentication', kind: 'select', required: true, options: ['none', 'bearer', 'basic', 'header'] },
      { key: 'secretRef', label: 'Credential (vault secret)', kind: 'secret-ref', required: false },
      { key: 'username', label: 'Username (basic auth)', kind: 'text', required: false },
      { key: 'headerName', label: 'Header name (header auth)', kind: 'text', required: false, placeholder: 'x-api-key' },
      { key: 'allowWrite', label: 'Allow write requests (POST/PUT/PATCH/DELETE)', kind: 'boolean', required: false },
      { key: 'healthPath', label: 'Health check path', kind: 'text', required: false, placeholder: 'status' },
      { key: 'operations', label: 'Named operations (JSON)', kind: 'json', required: false, help: '[{"name":"get_order","method":"GET","path":"orders/{id}","description":"…"}]' },
    ],
  },
  {
    type: 'mcp-stdio',
    title: 'MCP server (local process)',
    description: 'Run a Model Context Protocol server on this workstation and expose its tools to the agent.',
    fields: [
      { key: 'command', label: 'Command', kind: 'text', required: true, placeholder: 'npx' },
      { key: 'args', label: 'Arguments (JSON array)', kind: 'json', required: false, placeholder: '["-y", "@modelcontextprotocol/server-github"]' },
      { key: 'env', label: 'Environment (JSON, ${secret:NAME} allowed)', kind: 'json', required: false, placeholder: '{"GITHUB_TOKEN": "${secret:GITHUB_TOKEN}"}' },
      { key: 'cwd', label: 'Working directory', kind: 'text', required: false },
      { key: 'defaultRisk', label: 'Default risk for tools', kind: 'select', required: false, options: ['read', 'network', 'write', 'execute', 'sensitive'] },
    ],
  },
  {
    type: 'mcp-http',
    title: 'MCP server (remote)',
    description: 'Connect to a remote MCP server over Streamable HTTP.',
    fields: [
      { key: 'url', label: 'Server URL', kind: 'url', required: true, placeholder: 'https://mcp.example.com/mcp' },
      { key: 'authType', label: 'Authentication', kind: 'select', required: true, options: ['none', 'bearer', 'header'] },
      { key: 'secretRef', label: 'Credential (vault secret)', kind: 'secret-ref', required: false },
      { key: 'headerName', label: 'Header name', kind: 'text', required: false },
      { key: 'defaultRisk', label: 'Default risk for tools', kind: 'select', required: false, options: ['read', 'network', 'write', 'execute', 'sensitive'] },
    ],
  },
  {
    type: 'webhook',
    title: 'Outgoing webhook',
    description: 'Send FBRX events (approvals, agent results, policy denials) to Slack, Teams, SIEM or any HTTP endpoint, HMAC-signed.',
    fields: [
      { key: 'url', label: 'Endpoint URL', kind: 'url', required: true },
      { key: 'secretRef', label: 'Signing secret (vault)', kind: 'secret-ref', required: false },
      { key: 'events', label: 'Events (JSON array)', kind: 'json', required: false, help: JSON.stringify(WEBHOOK_EVENTS) },
      { key: 'allowAgentSend', label: 'Let the agent send messages', kind: 'boolean', required: false },
    ],
  },
  {
    type: 'fbrx-peer',
    title: 'FBRX OS peer',
    description: "Delegate tasks to another FBRX OS workstation's agent through its Local API.",
    fields: [
      { key: 'url', label: 'Peer Local API URL', kind: 'url', required: true, placeholder: 'http://10.0.0.12:47821' },
      { key: 'tokenSecret', label: 'Peer API token (vault secret)', kind: 'secret-ref', required: true },
      { key: 'providerId', label: 'Peer AI provider (optional)', kind: 'text', required: false },
    ],
  },
];

/** Manages connections to other applications and exposes them as governed tools. */
export class ConnectorHub {
  private readonly drivers = new Map<string, ConnectorDriver>();
  private readonly status = new Map<string, { state: ConnectorInfo['state']; message: string | null }>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly d: {
      db: Db;
      registry: ToolRegistry;
      vault: Vault;
      audit: AuditLog;
      license: LicenseService;
      log: Logger;
      events: EventBus;
      appVersion: string;
    },
  ) {}

  types(): ConnectorTypeInfo[] {
    return CONNECTOR_TYPE_INFO;
  }

  private records(): ConnectorRecord[] {
    return this.d.db.all<Row>('SELECT * FROM connectors ORDER BY name COLLATE NOCASE').map(toRecord);
  }

  private record(id: string): ConnectorRecord {
    const row = this.d.db.get<Row>('SELECT * FROM connectors WHERE id = ?', id);
    if (!row) throw new CoreError('NOT_FOUND', `Connector ${id} not found`);
    return toRecord(row);
  }

  list(): ConnectorInfo[] {
    return this.records().map((r) => this.info(r));
  }

  private info(r: ConnectorRecord): ConnectorInfo {
    const st = this.status.get(r.id) ?? { state: r.enabled ? ('disconnected' as const) : ('idle' as const), message: null };
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      enabled: r.enabled,
      state: st.state,
      message: st.message,
      tools: this.d.registry
        .list()
        .filter((t) => t.source === 'connector' && t.sourceId === r.id)
        .map((t) => t.name),
      config: r.config,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  async startAll(): Promise<void> {
    this.unsubscribe = this.d.events.onAny((event, payload) => this.forward(event, payload));
    for (const r of this.records()) if (r.enabled) await this.activate(r);
  }

  async stopAll(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const id of [...this.drivers.keys()]) await this.deactivate(id);
  }

  /** Maps core events onto the stable webhook event names. */
  private forward(event: string, payload: unknown) {
    let name: string | null = null;
    let data = payload;
    if (event === 'approval.requested' || event === 'approval.resolved' || event === 'fleet.changed' || event === 'notification') name = event;
    else if (event === 'agent') {
      const e = payload as { type: string };
      if (e.type === 'run.completed') name = 'agent.run.completed';
      else if (e.type === 'run.failed') name = 'agent.run.failed';
    } else if (event === 'audit.appended') {
      const e = payload as { outcome: string; category: string; action: string };
      if (e.outcome === 'denied') name = 'policy.denied';
      else if (e.category === 'backup' && e.action === 'created') name = 'backup.completed';
    } else if (event === 'service.changed' && (payload as { state: string }).state === 'failed') name = 'service.failed';
    if (!name) return;
    for (const drv of this.drivers.values()) drv.onEvent?.(name, data);
  }

  private driverFor(r: ConnectorRecord): ConnectorDriver {
    const ctx = {
      record: r,
      appVersion: this.d.appVersion,
      secret: (name: string) => (name ? this.d.vault.get(name) : undefined),
      log: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => this.d.log[level](message, data),
    };
    switch (r.type) {
      case 'rest':
        return new RestConnector(ctx);
      case 'mcp-stdio':
        return new McpConnector(ctx, 'stdio');
      case 'mcp-http':
        return new McpConnector(ctx, 'http');
      case 'webhook':
        return new WebhookConnector(ctx);
      case 'fbrx-peer':
        return new PeerConnector(ctx);
    }
  }

  private featureFor(type: ConnectorRecord['type']) {
    return type.startsWith('mcp') ? ('connectors.mcp' as const) : ('connectors' as const);
  }

  private setStatus(id: string, state: ConnectorInfo['state'], message: string | null) {
    this.status.set(id, { state, message });
    this.d.events.emit('connectors.changed', this.list());
  }

  private async activate(r: ConnectorRecord): Promise<void> {
    await this.deactivate(r.id);
    if (!this.d.license.has(this.featureFor(r.type))) {
      this.setStatus(r.id, 'error', 'Not included in your license');
      return;
    }
    const drv = this.driverFor(r);
    try {
      await drv.connect();
      this.drivers.set(r.id, drv);
      this.d.registry.registerMany(drv.tools());
      this.setStatus(r.id, 'connected', null);
    } catch (err) {
      this.d.registry.unregisterSource('connector', r.id);
      this.setStatus(r.id, 'error', errorMessage(err));
      this.d.log.warn('Connector failed to connect', { connector: r.name, error: errorMessage(err) });
    }
  }

  private async deactivate(id: string): Promise<void> {
    const drv = this.drivers.get(id);
    this.drivers.delete(id);
    this.d.registry.unregisterSource('connector', id);
    if (drv) await drv.disconnect().catch(() => undefined);
    this.status.delete(id);
  }

  private validate(input: ConnectorInput) {
    if (!CONNECTOR_TYPES.includes(input.type)) throw new CoreError('INVALID_ARGUMENT', `Unknown connector type ${input.type}`);
    if (!input.name?.trim()) throw new CoreError('INVALID_ARGUMENT', 'Name is required');
    const info = CONNECTOR_TYPE_INFO.find((t) => t.type === input.type)!;
    for (const f of info.fields) {
      const v = input.config?.[f.key];
      if (f.required && (v === undefined || v === null || v === '')) throw new CoreError('INVALID_ARGUMENT', `${f.label} is required`);
      if (v !== undefined && v !== '' && f.kind === 'url') {
        try {
          const u = new URL(String(v));
          if (!/^https?:$/.test(u.protocol)) throw new Error();
        } catch {
          throw new CoreError('INVALID_ARGUMENT', `${f.label} must be an http(s) URL`);
        }
      }
    }
    const config = JSON.stringify(input.config ?? {});
    if (config.length > 100_000) throw new CoreError('INVALID_ARGUMENT', 'Connector configuration is too large');
    if (/"(password|token|apiKey|api_key|secret)"\s*:\s*"[^$"][^"]{6,}"/i.test(config)) {
      throw new CoreError('INVALID_ARGUMENT', 'Store credentials in the vault and reference them (secretRef or ${secret:NAME}) instead of inlining them');
    }
  }

  private uniqueSlug(name: string, exceptId?: string): string {
    const base = slugify(name, 24);
    let slug = RESERVED.has(base) ? `${base}_app` : base;
    let n = 2;
    while (this.d.db.get<{ id: string }>('SELECT id FROM connectors WHERE slug = ? AND id != ?', slug, exceptId ?? '')) slug = `${base}_${n++}`;
    return slug;
  }

  async create(input: ConnectorInput, actor: string, opts: { managed?: boolean } = {}): Promise<ConnectorInfo> {
    this.validate(input);
    this.d.license.require(this.featureFor(input.type));
    const id = newId('conn');
    const now = new Date().toISOString();
    this.d.db.run(
      'INSERT INTO connectors (id, name, slug, type, enabled, config, managed, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id,
      input.name.trim(),
      this.uniqueSlug(input.name),
      input.type,
      input.enabled === false ? 0 : 1,
      JSON.stringify(input.config ?? {}),
      opts.managed ? 1 : 0,
      now,
      now,
    );
    this.d.audit.append({ category: 'connector', action: 'created', actor, target: id, outcome: 'success', details: { name: input.name, type: input.type } });
    const r = this.record(id);
    if (r.enabled) await this.activate(r);
    this.d.events.emit('connectors.changed', this.list());
    return this.info(this.record(id));
  }

  async update(id: string, patch: Partial<ConnectorInput>, actor: string): Promise<ConnectorInfo> {
    const cur = this.record(id);
    if (cur.managed && actor !== 'control-plane') throw new CoreError('MANAGED', 'This connection is managed by your organization');
    const next: ConnectorInput = {
      name: patch.name ?? cur.name,
      type: cur.type,
      enabled: patch.enabled ?? cur.enabled,
      config: patch.config ?? cur.config,
    };
    this.validate(next);
    this.d.db.run(
      'UPDATE connectors SET name = ?, slug = ?, enabled = ?, config = ?, updated_at = ? WHERE id = ?',
      next.name.trim(),
      next.name === cur.name ? cur.slug : this.uniqueSlug(next.name, id),
      next.enabled ? 1 : 0,
      JSON.stringify(next.config),
      new Date().toISOString(),
      id,
    );
    this.d.audit.append({ category: 'connector', action: 'updated', actor, target: id, outcome: 'success', details: { fields: Object.keys(patch) } });
    const r = this.record(id);
    if (r.enabled) await this.activate(r);
    else await this.deactivate(id);
    this.d.events.emit('connectors.changed', this.list());
    return this.info(r);
  }

  async delete(id: string, actor: string): Promise<boolean> {
    const cur = this.record(id);
    if (cur.managed && actor !== 'control-plane') throw new CoreError('MANAGED', 'This connection is managed by your organization');
    await this.deactivate(id);
    this.d.db.run('DELETE FROM connectors WHERE id = ?', id);
    this.d.audit.append({ category: 'connector', action: 'deleted', actor, target: id, outcome: 'success' });
    this.d.events.emit('connectors.changed', this.list());
    return true;
  }

  async test(id: string): Promise<{ ok: boolean; message: string; tools: string[] }> {
    const r = this.record(id);
    const drv = this.driverFor(r);
    try {
      const res = await drv.test();
      return { ...res, tools: drv.tools().map((t) => t.name) };
    } catch (err) {
      return { ok: false, message: errorMessage(err), tools: [] };
    } finally {
      if (!this.drivers.has(id) || this.drivers.get(id) !== drv) await drv.disconnect().catch(() => undefined);
    }
  }
}

function toRecord(r: Row): ConnectorRecord {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    type: r.type,
    enabled: !!r.enabled,
    config: JSON.parse(r.config),
    managed: !!r.managed,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
