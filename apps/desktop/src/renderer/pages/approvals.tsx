import { useEffect, useState } from 'react';
import type { ApprovalRequest } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Grid, KeyValue, Page, Status, useAction } from '@fbrx/ui';
import { call } from '../client';
import { useCore } from '../hooks';

function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);
  const s = Math.max(0, Math.round((new Date(until).getTime() - now) / 1000));
  return <span className="fx-muted">expires in {s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`}</span>;
}

export function ApprovalsPage() {
  const { data } = useCore('approvals.list', undefined, ['approval.requested', 'approval.resolved']);
  const policy = useCore('governance.policy', undefined, ['policy.changed']);
  const { run, busy } = useAction();
  const items = data ?? [];
  const decide = (a: ApprovalRequest, decision: 'approve' | 'deny', remember = false) =>
    run(`${a.id}:${decision}${remember}`, () => call('approvals.resolve', { id: a.id, decision, remember }), decision === 'approve' ? 'Approved' : 'Denied');
  return (
    <Page title="Approvals" description="Actions the agent (or an automation) wants to take that your policy says a person must approve. Nothing happens until you decide; requests expire automatically.">
      {!items.length && (
        <Card>
          <Empty title="Nothing waiting">When the agent wants to write files, run commands or change other systems, the request appears here and in the conversation.</Empty>
        </Card>
      )}
      <Grid cols={2}>
        {items.map((a) => (
          <Card
            key={a.id}
            title={a.toolTitle}
            subtitle={<span className="mono">{a.tool}</span>}
            actions={<Status tone={a.risk === 'execute' || a.risk === 'sensitive' ? 'serious' : 'warning'}>{a.risk} risk</Status>}
          >
            <div className="fx-form">
              <KeyValue
                items={[
                  ['Why approval', a.reason],
                  ['Requested by', a.origin === 'remote' ? 'Your organisation (remote task)' : a.origin === 'api' ? 'Local API automation' : 'AI agent'],
                  ['Time left', <Countdown until={a.expiresAt} />],
                ]}
              />
              {a.findings.length > 0 && (
                <Callout tone={a.findings.some((f) => f.severity === 'critical') ? 'critical' : 'warning'} title="Guardian review">
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {a.findings.map((f) => (
                      <li key={f.code}>{f.message}</li>
                    ))}
                  </ul>
                </Callout>
              )}
              <div>
                <div className="fx-label">What it will do</div>
                <pre className="fx-code" style={{ maxHeight: 220 }}>{JSON.stringify(a.input, null, 2)}</pre>
              </div>
              <div className="fx-actions" style={{ justifyContent: 'flex-end' }}>
                <Button variant="danger" loading={busy === `${a.id}:denyfalse`} onClick={() => void decide(a, 'deny')}>
                  Deny
                </Button>
                {policy.data?.policy.approvals.allowRemember && !a.findings.length && (
                  <Button loading={busy === `${a.id}:approvetrue`} onClick={() => void decide(a, 'approve', true)} title="Approve and stop asking for this tool">
                    Always allow
                  </Button>
                )}
                <Button variant="primary" loading={busy === `${a.id}:approvefalse`} onClick={() => void decide(a, 'approve')}>
                  Approve once
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </Grid>
    </Page>
  );
}
