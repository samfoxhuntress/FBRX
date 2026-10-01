import { BarList, Button, Card, Grid, Meter, Page, StatTile, Status, formatNumber, timeAgo, Empty } from '@fbrx/ui';
import { useApp, useQuery } from '../state';
import { PLATFORM_LABEL, SeverityStatus } from './common';

interface Overview {
  devices: { total: number; online: number; offline: number; retired: number; disabled: number; critical: number; warning: number; outdated: number };
  latestStableVersion: string | null;
  versions: Record<string, number>;
  platforms: Record<string, number>;
  agent: { runs24h: number; toolCalls24h: number; denials24h: number; errors24h: number; pendingApprovals: number };
  commands24h: Record<string, number>;
  recentEvents: Array<{ id: string; deviceId: string; deviceName: string; ts: string; kind: string; severity: string; message: string }>;
  license: { edition: string; seats: number; used: number; expiresAt: string | null } | null;
  tenants?: number;
}

export function OverviewPage() {
  const app = useApp();
  const { data } = useQuery<Overview>('/v1/admin/overview', [], (e) => e.type !== 'audit' && e.type !== 'hello');
  const go = (to: string) => (location.hash = `#/${to}`);
  if (!data) return <Page title="Overview">{null}</Page>;
  const d = data.devices;
  const attention = d.critical + d.warning;
  const cmdTotal = Object.values(data.commands24h).reduce((a, b) => a + b, 0);
  return (
    <Page
      title="Fleet overview"
      description={app.tenantId ? `Real-time health of ${app.me.tenants.find((t) => t.id === app.tenantId)?.name ?? 'this organisation'}'s workstations.` : `Platform view across ${data.tenants ?? 0} tenants.`}
      actions={
        app.can('enrollment.manage') && app.tenantId ? (
          <Button variant="primary" icon="plus" onClick={() => go('enrollment')}>
            Deploy to a new machine
          </Button>
        ) : undefined
      }
    >
      <Grid cols={4}>
        <StatTile label="Devices online" value={`${d.online} / ${d.total}`} foot={<span>{d.offline} offline{d.disabled ? ` · ${d.disabled} disabled` : ''}</span>} />
        <StatTile
          label="Need attention"
          value={attention}
          foot={attention ? <Status tone={d.critical ? 'critical' : 'warning'}>{d.critical} critical · {d.warning} warning</Status> : <Status tone="good">All healthy</Status>}
        />
        <StatTile label="Behind latest release" value={d.outdated} foot={data.latestStableVersion ? `Latest stable ${data.latestStableVersion}` : 'No stable release published'} />
        <StatTile label="Agent runs (24h)" value={formatNumber(data.agent.runs24h)} foot={`${formatNumber(data.agent.toolCalls24h)} tool calls · ${data.agent.denials24h} denied`} />
      </Grid>
      <Grid cols={3}>
        <Card title="App versions" subtitle="Active devices by installed version">
          <BarList items={Object.entries(data.versions).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ key: k, label: `v${k}`, value: v }))} empty={<div className="fx-muted">No devices yet</div>} />
        </Card>
        <Card title="Platforms" subtitle="Active devices by operating system">
          <BarList items={Object.entries(data.platforms).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ key: k, label: PLATFORM_LABEL[k] ?? k, value: v }))} empty={<div className="fx-muted">No devices yet</div>} />
        </Card>
        <Card title="Remote commands (24h)" subtitle={`${cmdTotal} sent`}>
          <div className="fx-list" style={{ gap: 8 }}>
            {(['succeeded', 'running', 'queued', 'failed', 'expired'] as const).map((s) => (
              <div key={s} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Status tone={s === 'succeeded' ? 'good' : s === 'failed' ? 'critical' : s === 'expired' ? 'warning' : s === 'running' ? 'busy' : 'neutral'}>{s[0].toUpperCase() + s.slice(1)}</Status>
                <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{data.commands24h[s] ?? 0}</strong>
              </div>
            ))}
          </div>
        </Card>
      </Grid>
      <Grid cols={2}>
        <Card title="Recent alerts" subtitle="Service failures, identity changes and audit anomalies" actions={<Button size="sm" variant="ghost" onClick={() => go('events')}>View all</Button>} flush>
          {data.recentEvents.length ? (
            <div className="fx-list">
              {data.recentEvents.slice(0, 8).map((e) => (
                <a key={e.id} className="fx-list-item" href={`#/device/${e.deviceId}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                  <SeverityStatus severity={e.severity} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="fx-cell-title">{e.deviceName}</div>
                    <div className="fx-cell-sub" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.message}</div>
                  </div>
                  <span className="fx-muted" style={{ fontSize: 12 }}>{timeAgo(e.ts)}</span>
                </a>
              ))}
            </div>
          ) : (
            <Empty title="No alerts">Devices report service failures and security anomalies here.</Empty>
          )}
        </Card>
        <Card title="Governance" subtitle="Agent oversight across the fleet">
          <div className="fx-form">
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="fx-secondary">Pending approvals on devices</span>
              <strong>{data.agent.pendingApprovals}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="fx-secondary">Policy denials (24h)</span>
              <strong>{data.agent.denials24h}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="fx-secondary">Errors reported (24h)</span>
              <strong>{data.agent.errors24h}</strong>
            </div>
            {data.license && (
              <>
                <div className="fx-divider" />
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span className="fx-secondary">
                    License seats ({data.license.edition}){data.license.expiresAt ? ` · renews ${new Date(data.license.expiresAt).toLocaleDateString()}` : ''}
                  </span>
                  <strong>
                    {data.license.used} / {data.license.seats || '∞'}
                  </strong>
                </div>
                {data.license.seats > 0 && <Meter value={data.license.used} max={data.license.seats} label="License seats used" />}
              </>
            )}
          </div>
        </Card>
      </Grid>
    </Page>
  );
}
