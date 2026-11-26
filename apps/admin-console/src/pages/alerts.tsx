import { useEffect, useState } from 'react';
import { FBRX_ALERT_APPS, fbrxAlertDuration, fbrxAlertRoleName, type FbrxAlertApp, type OrgAlertInbound, type OrgAlertRow, type OrgAlertRule, type OrgAlertsList } from '@fbrx/shared';
import { Button, Callout, Card, CopyText, Empty, Field, Input, Page, Select, Status, Toggle, formatDate, timeAgo, useAction, useToast } from '@fbrx/ui';
import { api } from '../api';
import { useApp, useQuery } from '../state';

const SEVERITY = [
  { value: 'info', label: 'Everything (information and up)' },
  { value: 'warning', label: 'Warnings and critical' },
  { value: 'critical', label: 'Critical only' },
];
const APP_NAMES: Record<FbrxAlertApp, string> = {
  'fbrx-os': 'FBRX OS',
  'fbrx-digger': 'FBRX Digger',
  'fbrx-server': 'FBRX Server',
  'fbrx-gate': 'FBRX Gate',
  'fbrx-minidome': 'MiniDome',
  'fbrx-command': 'FBRX Command',
};
const TONE = { info: 'neutral', warning: 'warning', critical: 'critical' } as const;

const list = (v: string) =>
  v
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

const blank = (): Omit<OrgAlertRule, 'id'> & { id?: string } => ({
  name: 'IT team',
  enabled: true,
  min: 'warning',
  apps: [],
  tags: [],
  emails: [],
  computerTags: [],
  helpdeskComputers: true,
  quiet: { enabled: false, from: '22:00', to: '07:00', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' },
  escalateAfterMinutes: 30,
  escalateEmails: [],
  escalateComputerTags: [],
});

function AlertLine({ row, onAck }: { row: OrgAlertRow; onAck?: () => void }) {
  const a = row.alert;
  const where = [row.deviceName ?? a.source.computer ?? a.source.host, a.source.role ? fbrxAlertRoleName(a.source.role) : null].filter(Boolean).join(' · ');
  const lasted = fbrxAlertDuration(a);
  return (
    <div className="cp-alert">
      <div className="fx-row" style={{ gap: 8, alignItems: 'center', flexWrap: 'nowrap' }}>
        {a.state === 'resolved' ? <Status tone="good">All clear</Status> : <Status tone={TONE[a.severity]}>{a.severity === 'info' ? 'Information' : a.severity === 'warning' ? 'Warning' : 'Critical'}</Status>}
        <b style={{ minWidth: 0 }}>{a.title}</b>
        <span className="fx-spacer" />
        <span className="fx-muted" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }} title={formatDate(a.startedAt)}>
          {APP_NAMES[a.source.app]}
          {where ? ` · ${where}` : ''} · {a.state === 'open' ? `since ${timeAgo(a.startedAt)}` : a.state === 'resolved' ? `ended ${timeAgo(a.endedAt ?? a.sentAt)}${lasted ? `, after ${lasted}` : ''}` : timeAgo(a.startedAt)}
        </span>
      </div>
      {a.detail && a.state !== 'resolved' && <div className="fx-secondary" style={{ marginTop: 4 }}>{a.detail}</div>}
      {a.done && <div style={{ marginTop: 4 }}>What FBRX did: {a.done}</div>}
      {a.yours && a.state === 'open' && <div style={{ marginTop: 4 }}>What is left for you: {a.yours}</div>}
      <div className="fx-row fx-muted" style={{ fontSize: 12, marginTop: 6, gap: 8, alignItems: 'center' }}>
        <span>
          {row.notified.length ? `Told: ${row.notified.slice(-6).join(', ')}` : 'Shown here only (no rule takes it)'}
          {row.count > 1 ? ` · said ${row.count} times` : ''}
          {row.escalatedAt ? ` · escalated ${timeAgo(row.escalatedAt)}` : ''}
        </span>
        <span className="fx-spacer" />
        {row.acknowledged ? (
          <span title={row.acknowledged.note ?? undefined}>
            Acknowledged by {row.acknowledged.by}, {timeAgo(row.acknowledged.at)}
            {row.acknowledged.note ? `: ${row.acknowledged.note}` : ''}
          </span>
        ) : onAck && a.state !== 'resolved' ? (
          <Button size="sm" icon="check" onClick={onAck}>
            Acknowledge
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function RuleCard({ rule, set, remove, locked }: { rule: Omit<OrgAlertRule, 'id'> & { id?: string }; set: (r: Partial<OrgAlertRule>) => void; remove: () => void; locked: boolean }) {
  const [emails, setEmails] = useState(rule.emails.join(', '));
  const [tags, setTags] = useState(rule.computerTags.join(', '));
  const [about, setAbout] = useState(rule.tags.join(', '));
  const [next, setNext] = useState(rule.escalateEmails.join(', '));
  const [nextTags, setNextTags] = useState(rule.escalateComputerTags.join(', '));
  const toggleApp = (app: FbrxAlertApp) => set({ apps: rule.apps.includes(app) ? rule.apps.filter((x) => x !== app) : [...rule.apps, app] });
  return (
    <Card
      title={
        <span className="fx-row" style={{ gap: 10, alignItems: 'center' }}>
          <Input aria-label="Rule name" value={rule.name} disabled={locked} onChange={(e) => set({ name: e.target.value })} style={{ width: 220 }} />
          <Toggle checked={rule.enabled} disabled={locked} onChange={(v) => set({ enabled: v })} label={rule.enabled ? 'On' : 'Off'} />
        </span>
      }
      actions={
        !locked ? (
          <Button size="sm" variant="ghost" icon="trash" onClick={remove}>
            Remove
          </Button>
        ) : undefined
      }
    >
      <div className="fx-form">
        <div className="fx-row">
          <Field label="Takes">
            <Select value={rule.min} disabled={locked} onChange={(e) => set({ min: e.target.value as OrgAlertRule['min'] })} options={SEVERITY} />
          </Field>
          <Field label="About computers tagged" help="Empty: every computer, and the servers.">
            <Input value={about} disabled={locked} placeholder="any" onChange={(e) => setAbout(e.target.value)} onBlur={() => set({ tags: list(about) })} />
          </Field>
        </div>
        <Field label="From" help={rule.apps.length ? undefined : 'None chosen: from every app.'}>
          <div className="fx-row" style={{ gap: 6 }}>
            {FBRX_ALERT_APPS.map((app) => (
              <Button key={app} size="sm" variant={rule.apps.includes(app) ? 'primary' : undefined} disabled={locked} onClick={() => toggleApp(app)}>
                {APP_NAMES[app]}
              </Button>
            ))}
          </div>
        </Field>
        <div className="fx-row">
          <Field label="E-mail" help="Each alert, then its all-clear.">
            <Input value={emails} disabled={locked} placeholder="it@example.com" onChange={(e) => setEmails(e.target.value)} onBlur={() => set({ emails: list(emails) })} />
          </Field>
          <Field label="Shows in FBRX OS on computers tagged" help="With Acknowledge.">
            <Input value={tags} disabled={locked} placeholder="it-desk" onChange={(e) => setTags(e.target.value)} onBlur={() => set({ computerTags: list(tags) })} />
          </Field>
        </div>
        <Toggle checked={rule.helpdeskComputers} disabled={locked} onChange={(v) => set({ helpdeskComputers: v })} label="And on the help desk computers" />
        <div className="fx-row" style={{ alignItems: 'flex-end' }}>
          <Toggle checked={rule.quiet.enabled} disabled={locked} onChange={(v) => set({ quiet: { ...rule.quiet, enabled: v } })} label="Quiet hours (critical alerts come through)" />
          {rule.quiet.enabled && (
            <>
              <Field label="From">
                <Input type="time" value={rule.quiet.from} disabled={locked} onChange={(e) => set({ quiet: { ...rule.quiet, from: e.target.value } })} />
              </Field>
              <Field label="To">
                <Input type="time" value={rule.quiet.to} disabled={locked} onChange={(e) => set({ quiet: { ...rule.quiet, to: e.target.value } })} />
              </Field>
              <Field label="Time zone">
                <Input value={rule.quiet.timeZone} disabled={locked} onChange={(e) => set({ quiet: { ...rule.quiet, timeZone: e.target.value } })} />
              </Field>
            </>
          )}
        </div>
        <div className="fx-row">
          <Field label="Nobody acknowledged it within (minutes)" help="0: never escalate.">
            <Input type="number" min={0} value={rule.escalateAfterMinutes} disabled={locked} onChange={(e) => set({ escalateAfterMinutes: Math.max(0, Number(e.target.value) || 0) })} />
          </Field>
          <Field label="Then also e-mail">
            <Input value={next} disabled={locked || !rule.escalateAfterMinutes} placeholder="manager@example.com" onChange={(e) => setNext(e.target.value)} onBlur={() => set({ escalateEmails: list(next) })} />
          </Field>
          <Field label="And computers tagged">
            <Input value={nextTags} disabled={locked || !rule.escalateAfterMinutes} placeholder="on-call" onChange={(e) => setNextTags(e.target.value)} onBlur={() => set({ escalateComputerTags: list(nextTags) })} />
          </Field>
        </div>
      </div>
    </Card>
  );
}

function WhoGetsWhat() {
  const app = useApp();
  const toast = useToast();
  const { run, busy } = useAction();
  const saved = useQuery<{ rules: OrgAlertRule[] }>('/v1/admin/alerts/rules');
  const [rules, setRules] = useState<Array<Omit<OrgAlertRule, 'id'> & { id?: string; key: string }> | null>(null);
  useEffect(() => {
    if (saved.data) setRules(saved.data.rules.map((r) => ({ ...r, key: r.id })));
  }, [saved.data]);
  const locked = !app.can('alerts.manage');
  if (!rules) return null;
  const save = () =>
    run('save', async () => {
      const r = await api<{ rules: OrgAlertRule[] }>('PUT', '/v1/admin/alerts/rules', { rules: rules.map(({ key: _k, ...rest }) => rest) });
      setRules(r.rules.map((x) => ({ ...x, key: x.id })));
      toast.success('Saved');
    });
  return (
    <>
      <h2 className="cp-section">Who gets what</h2>
      <Callout tone="info">
        Every alert shows on this page. A rule also tells people: by e-mail, and as a notification in FBRX OS on the computers you tag, with Acknowledge. Acknowledging, here or there, stops the escalation; the all-clear reaches whoever heard the alert.
      </Callout>
      {rules.length === 0 && <Empty title="No rules yet">Alerts show here only. Add a rule to tell people.</Empty>}
      {rules.map((r, i) => (
        <RuleCard
          key={r.key}
          rule={r}
          locked={locked}
          set={(v) => setRules(rules.map((x, j) => (j === i ? { ...x, ...v } : x)))}
          remove={() => setRules(rules.filter((_, j) => j !== i))}
        />
      ))}
      {!locked && (
        <div className="fx-actions">
          <Button icon="plus" onClick={() => setRules([...rules, { ...blank(), key: `new-${Date.now()}` }])}>
            Add a rule
          </Button>
          <Button variant="primary" loading={busy === 'save'} onClick={() => void save()}>
            Save
          </Button>
          <Button loading={busy === 'test'} onClick={() => void run('test', () => api('POST', '/v1/admin/alerts/test').then(() => toast.success('Test alert sent', 'It goes through the saved rules.')))}>
            Send a test alert
          </Button>
        </div>
      )}
    </>
  );
}

function FromServers() {
  const app = useApp();
  const { run, busy } = useAction();
  const inbound = useQuery<OrgAlertInbound>('/v1/admin/alerts/inbound');
  const [secret, setSecret] = useState<string | null>(null);
  if (!inbound.data) return null;
  return (
    <Card title="From FBRX Servers" subtitle="Their alerts (drives, FBRX Gate, MiniDome, FBRX Time) come here too, signed with this organization's secret">
      <div className="fx-form">
        <Field label="Address">
          <CopyText value={inbound.data.url} />
        </Field>
        {secret ? (
          <Field label="Signing secret" help="Shown once: copy it now. Making a new one stops the old one.">
            <CopyText value={secret} secret />
          </Field>
        ) : (
          <div className="fx-muted">{inbound.data.secretSet ? 'A signing secret is set.' : 'No signing secret yet: make one to let servers send alerts here.'}</div>
        )}
        <div className="fx-muted" style={{ fontSize: 12.5 }}>
          In each FBRX Server's console: Alerts → Webhook, paste this address and the secret, and choose which alerts to send.
        </div>
        {app.can('alerts.manage') && (
          <div className="fx-actions">
            <Button loading={busy === 'secret'} onClick={() => void run('secret', () => api<OrgAlertInbound & { secret: string }>('POST', '/v1/admin/alerts/inbound/secret').then((r) => (setSecret(r.secret), inbound.reload())))}>
              {inbound.data.secretSet ? 'Make a new secret' : 'Make a secret'}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

/** FBRX Command → Alerts: the organization's alerts, who gets what, and FBRX Servers' alerts. */
export function AlertsPage() {
  const app = useApp();
  const { run } = useAction();
  const alerts = useQuery<OrgAlertsList>('/v1/admin/alerts', [], (e) => e.type === 'alert.updated');
  const ack = (row: OrgAlertRow) => () => void run(`ack-${row.id}`, () => api('POST', `/v1/admin/alerts/${row.id}/acknowledge`, {}).then(alerts.reload));
  const canAck = app.can('alerts.acknowledge');
  return (
    <Page title="Alerts" description="What goes wrong across the organization (its computers, FBRX Servers and FBRX Command itself) is said once, then its all-clear when it is over. You decide who hears it.">
      <Card title="Going on now">
        {alerts.data && !alerts.data.open.length ? (
          <Empty title="Nothing is wrong">When something goes wrong, it shows here until it is over.</Empty>
        ) : (
          <div className="cp-alerts">{alerts.data?.open.map((r) => <AlertLine key={r.id} row={r} onAck={canAck ? ack(r) : undefined} />)}</div>
        )}
      </Card>
      <Card title="Recently">
        {alerts.data && !alerts.data.recent.length ? <Empty title="No alerts yet" /> : <div className="cp-alerts">{alerts.data?.recent.map((r) => <AlertLine key={r.id} row={r} onAck={canAck && r.alert.state === 'event' ? ack(r) : undefined} />)}</div>}
      </Card>
      {app.tenantId && (
        <>
          <WhoGetsWhat />
          <FromServers />
        </>
      )}
    </Page>
  );
}
