import { AUDIENCES, AUDIENCE_NAMES, VERTICALS, VERTICAL_AUDIENCES, VERTICAL_INFO, VERTICAL_NAMES, isLearner, type Audience, type Vertical } from '@fbrx/shared';
import { ChoiceCards, Status, timeAgo, type IconName } from '@fbrx/ui';

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
    protection: { provider: string; name: string; state: 'protected' | 'attention' | 'at-risk' | 'unknown'; realtime: boolean | null; threats: number } | null;
  };
}

const PROTECTION_LABEL = { protected: 'Protected', attention: 'Needs attention', 'at-risk': 'At risk', unknown: 'Status unknown' } as const;
const PROTECTION_TONE = { protected: 'good', attention: 'warning', 'at-risk': 'critical', unknown: 'neutral' } as const;

/** The antivirus on a computer, as its last heartbeat reported it. */
export function ProtectionCell({ p }: { p: NonNullable<DeviceSummary['health']>['protection'] | undefined }) {
  if (!p) return <span className="fx-muted">Not reported</span>;
  return (
    <span>
      {p.name} <Status tone={PROTECTION_TONE[p.state]}>{p.threats ? `${p.threats} threat${p.threats === 1 ? '' : 's'}` : PROTECTION_LABEL[p.state]}</Status>
    </span>
  );
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
  if (d.health.protection?.state === 'at-risk') return <Status tone="critical">Antivirus at risk</Status>;
  if (d.health.state === 'warning') return <Status tone="warning">{d.health.vaultState !== 'unlocked' ? 'Vault locked' : d.health.protection?.state === 'attention' ? 'Antivirus needs attention' : 'Degraded'}</Status>;
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

export const KIND_ICONS: Record<Vertical, IconName> = { business: 'briefcase', education: 'school', home: 'house' };

/** "Work", "School", "Home": the kind of tenant, as people pick it. */
export function KindPicker({ value, onChange }: { value: Vertical; onChange: (v: Vertical) => void }) {
  return (
    <ChoiceCards
      label="Kind of tenant"
      value={value}
      onChange={onChange}
      options={VERTICALS.map((v) => ({ value: v, icon: KIND_ICONS[v], title: VERTICAL_NAMES[v], description: VERTICAL_INFO[v].tagline, detail: VERTICAL_INFO[v].computers }))}
    />
  );
}

/** Who can use a computer in this kind of tenant (every audience in the platform view). */
export function audienceOptions(kind: Vertical | null): Array<{ value: Audience; label: string }> {
  return (kind ? VERTICAL_AUDIENCES[kind] : AUDIENCES).map((a) => ({ value: a, label: AUDIENCE_NAMES[a] }));
}

export function audienceHelp(kind: Vertical | null): string | undefined {
  if (kind === 'education') return 'Student computers run FBRX OS Education';
  if (kind === 'home') return "Children's computers run FBRX OS Home";
  if (kind === 'business') return undefined;
  return 'Student computers run FBRX OS Education (School tenants), child computers FBRX OS Home (Home tenants)';
}

/** "Student" or "Child" next to a learner computer or token. */
export function LearnerBadge({ audience, plural }: { audience: Audience | null | undefined; plural?: boolean }) {
  if (!isLearner(audience)) return null;
  const label = audience === 'child' ? (plural ? 'Children' : 'Child') : plural ? 'Students' : 'Student';
  return (
    <span className="fx-badge accent" style={{ marginLeft: 6 }}>
      {label}
    </span>
  );
}
