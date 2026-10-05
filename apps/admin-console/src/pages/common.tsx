import { Status, timeAgo } from '@fbrx/ui';

export interface DeviceSummary {
  id: string;
  tenantId: string;
  groupId: string | null;
  name: string;
  hostname: string;
  platform: string;
  arch: string;
  osVersion: string;
  appVersion: string;
  status: string;
  online: boolean;
  realtime: boolean;
  enrolledAt: string;
  lastSeenAt: string | null;
  lastIp: string | null;
  configVersion: number;
  tags: string[];
  notes: string;
  updateChannel: string | null;
  pinnedVersion: string | null;
  /** Who uses it (null = its group's or the organization's default). */
  audience: 'staff' | 'student' | 'parent' | 'child' | null;
  helpdeskReceiver: boolean;
  settingsOverride: Record<string, unknown>;
  lockedOverride: string[];
  policyOverride: unknown;
  health: null | {
    state: 'healthy' | 'warning' | 'critical';
    failingServices: string[];
    degradedServices: string[];
    cpuLoad: number;
    memUsedPct: number;
    memTotalMb: number;
    diskFreeGb: number | null;
    vaultState: string;
    licenseEdition: string;
    licenseState: string;
    activeAgentRuns: number;
    pendingApprovals: number;
    agentRuns24h: number;
    toolCalls24h: number;
    policyDenials24h: number;
    errors24h: number;
    lastBackupAt: string | null;
    plugins: Array<{ id: string; version: string; enabled: boolean }>;
    runtimeModel: string | null;
    uptimeSeconds: number;
    services: Array<{ name: string; state: string; message?: string | null }>;
  };
}

export const PLATFORM_LABEL: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

export function OnlineStatus({ d }: { d: Pick<DeviceSummary, 'online' | 'status' | 'lastSeenAt'> }) {
  if (d.status === 'retired') return <Status tone="neutral">Retired</Status>;
  if (d.status === 'disabled') return <Status tone="serious">Disabled</Status>;
  return d.online ? <Status tone="good">Online</Status> : <Status tone="neutral">Offline · {timeAgo(d.lastSeenAt)}</Status>;
}

export function HealthStatus({ d }: { d: Pick<DeviceSummary, 'health'> }) {
  if (!d.health) return <Status tone="neutral">No data</Status>;
  if (d.health.state === 'critical') return <Status tone="critical">{d.health.failingServices.length} failing</Status>;
  if (d.health.state === 'warning') return <Status tone="warning">{d.health.vaultState !== 'unlocked' ? 'Vault locked' : 'Degraded'}</Status>;
  return <Status tone="good">Healthy</Status>;
}

export function CommandStatus({ status }: { status: string }) {
  switch (status) {
    case 'succeeded':
      return <Status tone="good">Succeeded</Status>;
    case 'failed':
      return <Status tone="critical">Failed</Status>;
    case 'running':
      return <Status tone="busy">Running</Status>;
    case 'sent':
      return <Status tone="info">Delivered</Status>;
    case 'queued':
      return <Status tone="neutral">Queued</Status>;
    case 'expired':
      return <Status tone="warning">Expired</Status>;
    default:
      return <Status tone="neutral">{status}</Status>;
  }
}

export function SeverityStatus({ severity }: { severity: string }) {
  return severity === 'critical' ? <Status tone="critical">Critical</Status> : severity === 'warning' ? <Status tone="warning">Warning</Status> : <Status tone="info">Info</Status>;
}

export function ServiceState({ state, message }: { state: string; message?: string | null }) {
  const tone = state === 'running' ? 'good' : state === 'failed' ? 'critical' : state === 'degraded' ? 'warning' : 'neutral';
  return <Status tone={tone}>{message ? `${state} — ${message}` : state}</Status>;
}
