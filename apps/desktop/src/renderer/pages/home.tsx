import type { SystemStatus } from '@fbrx/shared';
import { Button, Callout, Card, Grid, KeyValue, Page, StatTile, Status, formatDuration, formatNumber, timeAgo, useAction } from '@fbrx/ui';
import { call } from '../client';
import { useCore } from '../hooks';
import { navigate } from '../app';

function serviceTone(state: string) {
  return state === 'running' ? 'good' : state === 'failed' ? 'critical' : state === 'degraded' ? 'warning' : 'neutral';
}

export function HomePage({ status }: { status: SystemStatus }) {
  const { run, busy } = useAction();
  const audit = useCore('audit.query', { limit: 8 }, ['audit.appended']);
  const providers = useCore('ai.providers', undefined, ['settings.changed', 'runtime.changed', 'policy.changed']);
  const updates = useCore('updates.status', undefined, ['updates.changed']);
  const aiReady = providers.data?.some((p) => p.available);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const s = status.stats;
  return (
    <Page
      title={greeting}
      description={`${status.deviceName} · ${status.product} ${status.version} · up ${formatDuration(status.uptimeSeconds)}`}
      actions={
        <>
          <Button icon="archive" onClick={() => navigate('backup')}>
            Back up
          </Button>
          <Button variant="primary" icon="sparkles" onClick={() => navigate('agent')}>
            New agent task
          </Button>
        </>
      }
    >
      {status.vault.state === 'locked' && (
        <Callout tone="warning" title="Your vault is locked" actions={<Button size="sm" onClick={() => navigate('vault')}>Unlock</Button>}>
          This machine's keychain could not unlock your credentials (for example after copying the data folder). Enter your recovery passphrase to unlock.
        </Callout>
      )}
      {providers.data && !aiReady && (
        <Callout tone="info" title="Set up an AI model" actions={<Button size="sm" onClick={() => navigate('runtime')}>Choose a model</Button>}>
          Download a local model to run the agent fully offline, connect Ollama, or add a Claude API key.
        </Callout>
      )}
      {status.pendingApprovals > 0 && (
        <Callout tone="warning" title={`${status.pendingApprovals} action(s) need your approval`} actions={<Button size="sm" variant="primary" onClick={() => navigate('approvals')}>Review</Button>}>
          The agent is waiting for you before it changes files, runs commands or contacts other systems.
        </Callout>
      )}
      {updates.data?.state === 'downloaded' && (
        <Callout tone="good" title={`FBRX OS ${updates.data.availableVersion} is ready`} actions={<Button size="sm" onClick={() => void run('u', () => call('updates.install'))}>Restart to update</Button>}>
          The update was downloaded from your organisation's control plane.
        </Callout>
      )}
      <Grid cols={4}>
        <StatTile label="Agent tasks (24h)" value={formatNumber(s.agentRuns24h)} foot={status.activeRuns ? <Status tone="busy">{status.activeRuns} running</Status> : 'Idle'} />
        <StatTile label="Tool calls (24h)" value={formatNumber(s.toolCalls24h)} foot="Every call checked by governance" />
        <StatTile label="Blocked by policy (24h)" value={formatNumber(s.policyDenials24h)} foot={<a href="#/governance">Review in governance</a>} />
        <StatTile label="Last backup" value={s.lastBackupAt ? timeAgo(s.lastBackupAt) : 'Never'} foot={s.errors24h ? <Status tone="warning">{s.errors24h} errors in 24h</Status> : <Status tone="good">No errors in 24h</Status>} />
      </Grid>
      <Grid cols={2}>
        <Card title="Services" subtitle="Supervised by the watchdog; failed services restart automatically" flush>
          <div className="fx-list">
            {status.services.map((sv) => (
              <div className="fx-list-item" key={sv.name}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="fx-cell-title">{sv.title}</div>
                  <div className="fx-cell-sub" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sv.message ?? sv.description}</div>
                </div>
                <Status tone={serviceTone(sv.state)}>{sv.state}</Status>
                {sv.state !== 'disabled' && (
                  <Button size="sm" variant="ghost" icon="refresh" title={`Restart ${sv.title}`} aria-label={`Restart ${sv.title}`} loading={busy === sv.name} onClick={() => void run(sv.name, () => call('system.restartService', { name: sv.name }), `${sv.title} restarted`)} />
                )}
              </div>
            ))}
          </div>
        </Card>
        <div className="fx-grid">
          <Card title="This workstation">
            <KeyValue
              items={[
                ['Device', status.deviceName],
                ['System', `${status.platform} · ${status.arch}`],
                ['License', `${status.license.edition} (${status.license.state})`],
                ['Organisation', status.fleet.state === 'unenrolled' ? 'Not connected' : `${status.fleet.tenantName} · ${status.fleet.state}`],
                ['AI runtime', status.runtime.state === 'running' ? `Running ${status.runtime.modelId}` : status.runtime.state],
                ['Vault', `${status.vault.state} · ${status.vault.secretCount} credentials`],
                ['Data folder', <span className="mono" style={{ fontSize: 12 }}>{status.dataDir}</span>],
              ]}
            />
          </Card>
          <Card title="Recent activity" actions={<Button size="sm" variant="ghost" onClick={() => navigate('governance')}>Audit log</Button>} flush>
            <div className="fx-list">
              {(audit.data ?? []).map((e) => (
                <div className="fx-list-item" key={e.seq} style={{ fontSize: 13 }}>
                  <Status tone={e.outcome === 'success' ? 'good' : e.outcome === 'denied' ? 'serious' : e.outcome === 'failure' ? 'critical' : 'neutral'}>{e.outcome}</Status>
                  <span className="mono" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.category}/{e.action}
                  </span>
                  <span className="fx-muted" style={{ fontSize: 12 }}>{timeAgo(e.ts)}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </Grid>
    </Page>
  );
}
