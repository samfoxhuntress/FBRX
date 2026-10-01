import type { ConnectorType } from '@fbrx/shared';
import type { ToolSpec } from '../tools/types';

export interface ConnectorRecord {
  id: string;
  name: string;
  slug: string;
  type: ConnectorType;
  enabled: boolean;
  config: Record<string, unknown>;
  managed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorDriver {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  tools(): ToolSpec[];
  test(): Promise<{ ok: boolean; message: string }>;
  /** Called for every core event; webhook connectors forward the ones they subscribe to. */
  onEvent?(event: string, payload: unknown): void;
}

export interface DriverContext {
  record: ConnectorRecord;
  secret: (name: string) => string | undefined;
  appVersion: string;
  log: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

/** Replaces `${secret:NAME}` placeholders with vault values. */
export function resolveSecretRefs(value: string, secret: (name: string) => string | undefined): string {
  return value.replace(/\$\{secret:([A-Za-z0-9_.-]+)\}/g, (_, name: string) => {
    const v = secret(name);
    if (v === undefined) throw new Error(`Vault secret "${name}" not found`);
    return v;
  });
}

export function authHeaders(cfg: Record<string, unknown>, secret: (name: string) => string | undefined): Record<string, string> {
  const type = String(cfg.authType ?? 'none');
  const ref = cfg.secretRef ? String(cfg.secretRef) : '';
  const value = () => {
    const v = secret(ref);
    if (!v) throw new Error(`Vault secret "${ref}" not found`);
    return v;
  };
  switch (type) {
    case 'bearer':
      return { authorization: `Bearer ${value()}` };
    case 'basic':
      return { authorization: `Basic ${Buffer.from(`${String(cfg.username ?? '')}:${value()}`).toString('base64')}` };
    case 'header':
      return { [String(cfg.headerName || 'x-api-key').toLowerCase()]: value() };
    default:
      return {};
  }
}

export function asToolSlug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
  return /^[a-z0-9]/.test(s) ? s : `t_${s}`;
}
