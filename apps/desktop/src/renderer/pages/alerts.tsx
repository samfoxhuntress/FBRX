import { useEffect, useState } from 'react';
import { ALERT_CHANNELS, type AlertChannel, type AlertSeverity, type Settings } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Field, Grid, Input, Page, Select, Status, Tabs, Toggle, timeAgo, useAction, useToast } from '@fbrx/ui';
import { call } from '../client';
import { isLocked, useCore } from '../hooks';
import { IS_WINDOWS, navigate } from '../app';
import { AskButton, askAgent } from '../widgets';

const CHANNEL_LABEL: Record<AlertChannel, string> = { inbox: 'Inbox', desktop: 'Desktop', mobile: 'Phone', organisation: 'Organization', webhook: 'Webhook', email: 'Email' };
const SEV: AlertSeverity[] = ['info', 'warning', 'critical'];
type Alerts = Settings['alerts'];

export function AlertsPage() {
  const [tab, setTab] = useState<'inbox' | 'rules' | 'delivery'>('inbox');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const inbox = useCore('alerts.inbox', { limit: 300, unreadOnly }, ['alerts.changed']);
  const rules = useCore('alerts.rules', undefined, ['settings.changed']);
  const settings = useCore('settings.get', undefined, ['settings.changed']);
  const [cfg, setCfg] = useState<Alerts | null>(null);
  const { run, busy } = useAction();
  const toast = useToast();
  const locked = settings.data?.locked;
  useEffect(() => {
    if (settings.data) setCfg(settings.data.settings.alerts);
  }, [settings.data]);

  const save = (patch: Partial<Alerts>) => run('save', () => call('settings.update', { patch: { alerts: patch } }), 'Alert settings saved');
  const setRule = (id: string, p: { enabled?: boolean; threshold?: number | null }) => {
    const r = rules.data?.find((x) => x.id === id);
    if (!r) return;
    void save({ rules: { [id]: { enabled: p.enabled ?? r.enabled, threshold: p.threshold === undefined ? r.threshold : p.threshold } } });
  };
  const test = async (channel: AlertChannel) => {
    const r = await run(`test-${channel}`, () => call('alerts.test', { channel }));
    if (r) (r.ok ? toast.success : toast.error)(`${CHANNEL_LABEL[channel]} test`, r.result);
  };
  const groups = [...new Set((rules.data ?? []).map((r) => r.group))];

  return (
    <Page
      title="Alerts"
      description="FBRX watches performance, storage, security, your network and your tasks in the background and tells you when something needs attention."
      actions={
        tab === 'inbox' && (
          <>
            <Toggle checked={unreadOnly} onChange={setUnreadOnly} label="Unread only" />
            {!!inbox.data?.length && (
              <Button
                icon="sparkles"
                className="ask-btn"
                onClick={() => askAgent('Summarize my recent FBRX alerts: group them, tell me which ones need action, the likely cause, and what to do first.', inbox.data!.slice(0, 40).map((a) => ({ when: a.createdAt, severity: a.severity, title: a.title, details: a.body, read: a.read })))}
              >
                Summarize my alerts
              </Button>
            )}
            <Button icon="check" onClick={() => void run('read', () => call('alerts.markRead', { id: '*' }))}>
              Mark all read
            </Button>
          </>
        )
      }
    >
      <Tabs
        tabs={[
          { id: 'inbox', label: 'Inbox' },
          { id: 'rules', label: 'Rules' },
          { id: 'delivery', label: 'Delivery' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'inbox' &&
        (inbox.data?.length ? (
          <Card flush>
            <div className="fx-list private">
              {inbox.data.map((a) => (
                <div key={a.id} className="fx-list-item" style={{ alignItems: 'flex-start', opacity: a.read ? 0.75 : 1 }}>
                  <Status tone={a.severity === 'critical' ? 'critical' : a.severity === 'warning' ? 'warning' : 'info'}>{a.severity}</Status>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="fx-cell-title" style={{ fontWeight: a.read ? 500 : 650 }}>
                      {a.title}
                    </div>
                    <div className="fx-cell-sub">{a.body}</div>
                    <div className="fx-muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                      {timeAgo(a.createdAt)} · sent to {Object.keys(a.deliveries).map((c) => CHANNEL_LABEL[c as AlertChannel] ?? c).join(', ') || 'inbox'}
                    </div>
                  </div>
                  <AskButton iconOnly prompt="Explain this alert from FBRX on my PC: what it means, the likely cause, and what I should do. Check the current state with your tools first." context={{ when: a.createdAt, severity: a.severity, title: a.title, details: a.body }} />
                  {!a.read && <Button size="sm" variant="ghost" icon="check" aria-label="Mark read" onClick={() => void run(a.id, () => call('alerts.markRead', { id: a.id }))} />}
                  <Button size="sm" variant="ghost" icon="trash" aria-label="Delete" onClick={() => void run(a.id, () => call('alerts.delete', { id: a.id }))} />
                </div>
              ))}
            </div>
          </Card>
        ) : (
          <Empty title="Nothing to report">You will see alerts here as they happen.</Empty>
        ))}

      {tab === 'rules' && (
        <Grid cols={2}>
          {groups.map((g) => (
            <Card key={g} title={g} flush>
              <div className="fx-list">
                {rules.data!
                  .filter((r) => r.group === g)
                  .map((r) => (
                    <div key={r.id} className="fx-list-item">
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="fx-cell-title">
                          {r.label} {r.windowsOnly && !IS_WINDOWS && <span className="fx-muted">(Windows)</span>}
                        </div>
                        <div className="fx-cell-sub">{r.help}</div>
                      </div>
                      {r.unit && (
                        <div style={{ width: 120, display: 'flex', alignItems: 'center', gap: 4 }}>
                          <Input type="number" aria-label={`${r.label} threshold`} defaultValue={r.threshold ?? ''} onBlur={(e) => setRule(r.id, { threshold: e.target.value === '' ? null : Number(e.target.value) })} disabled={isLocked(locked, `alerts.rules.${r.id}`)} />
                          <span className="fx-muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{r.unit}</span>
                        </div>
                      )}
                      <Status tone={r.severity === 'critical' ? 'critical' : r.severity === 'warning' ? 'warning' : 'info'}>{r.severity}</Status>
                      <Toggle checked={r.enabled} onChange={(v) => setRule(r.id, { enabled: v })} disabled={isLocked(locked, `alerts.rules.${r.id}`)} />
                    </div>
                  ))}
              </div>
            </Card>
          ))}
        </Grid>
      )}

      {tab === 'delivery' && cfg && (
        <>
          <Card title="Where alerts go" subtitle="Choose the channels for each severity. Quiet hours hold back desktop and e-mail alerts that are not critical.">
            <table className="fx-table">
              <thead>
                <tr>
                  <th>Severity</th>
                  {ALERT_CHANNELS.map((c) => (
                    <th key={c}>{CHANNEL_LABEL[c]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {SEV.map((sv) => (
                  <tr key={sv}>
                    <td>
                      <Status tone={sv === 'critical' ? 'critical' : sv === 'warning' ? 'warning' : 'info'}>{sv}</Status>
                    </td>
                    {ALERT_CHANNELS.map((c) => (
                      <td key={c}>
                        <input
                          type="checkbox"
                          aria-label={`${sv} to ${CHANNEL_LABEL[c]}`}
                          checked={cfg.routing[sv].includes(c)}
                          disabled={c === 'inbox' || isLocked(locked, 'alerts.routing')}
                          onChange={(e) => {
                            const next = e.target.checked ? [...cfg.routing[sv], c] : cfg.routing[sv].filter((x) => x !== c);
                            void save({ routing: { ...cfg.routing, [sv]: next } });
                          }}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="fx-row" style={{ marginTop: 14 }}>
              <Field label="Quiet hours">
                <Toggle checked={cfg.quietHours.enabled} onChange={(v) => void save({ quietHours: { ...cfg.quietHours, enabled: v } })} label="Hold non-critical alerts" />
              </Field>
              <Field label="From">
                <Input type="time" value={cfg.quietHours.start} onChange={(e) => setCfg({ ...cfg, quietHours: { ...cfg.quietHours, start: e.target.value } })} onBlur={() => void save({ quietHours: cfg.quietHours })} />
              </Field>
              <Field label="Until">
                <Input type="time" value={cfg.quietHours.end} onChange={(e) => setCfg({ ...cfg, quietHours: { ...cfg.quietHours, end: e.target.value } })} onBlur={() => void save({ quietHours: cfg.quietHours })} />
              </Field>
              <Field label="Repeat the same alert after (minutes)">
                <Input type="number" min={1} max={1440} value={cfg.cooldownMinutes} onChange={(e) => setCfg({ ...cfg, cooldownMinutes: Number(e.target.value) })} onBlur={() => void save({ cooldownMinutes: cfg.cooldownMinutes })} />
              </Field>
            </div>
          </Card>
          <Grid cols={2}>
            <Card title="Desktop, phone and organization" subtitle="Built-in channels">
              <div className="fx-grid" style={{ gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Toggle checked={cfg.channels.desktop} onChange={(v) => void save({ channels: { ...cfg.channels, desktop: v } })} label="Desktop notifications" />
                  <span className="fx-spacer" />
                  <Button size="sm" loading={busy === 'test-desktop'} onClick={() => void test('desktop')}>Test</Button>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Toggle checked={cfg.channels.mobile} onChange={(v) => void save({ channels: { ...cfg.channels, mobile: v } })} label="My paired phones (FBRX Mobile)" />
                  <span className="fx-spacer" />
                  <Button size="sm" variant="ghost" onClick={() => navigate('mesh')}>Pair a phone</Button>
                  <Button size="sm" loading={busy === 'test-mobile'} onClick={() => void test('mobile')}>Test</Button>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Toggle checked={cfg.channels.organisation} onChange={(v) => void save({ channels: { ...cfg.channels, organisation: v } })} label="My organization's admin console" />
                  <span className="fx-spacer" />
                  <Button size="sm" loading={busy === 'test-organisation'} onClick={() => void test('organisation')}>Test</Button>
                </div>
              </div>
            </Card>
            <Card title="Webhook" subtitle="Slack, Microsoft Teams, Discord, ntfy or any JSON endpoint">
              <div className="fx-grid" style={{ gap: 10 }}>
                <Toggle checked={cfg.channels.webhook.enabled} onChange={(v) => void save({ channels: { ...cfg.channels, webhook: { ...cfg.channels.webhook, enabled: v } } })} label="Send alerts to a webhook" />
                <div className="fx-row">
                  <Field label="Format">
                    <Select value={cfg.channels.webhook.format} onChange={(e) => void save({ channels: { ...cfg.channels, webhook: { ...cfg.channels.webhook, format: e.target.value as Alerts['channels']['webhook']['format'] } } })} options={['slack', 'teams', 'discord', 'ntfy', 'json']} />
                  </Field>
                  <Field label="URL">
                    <Input value={cfg.channels.webhook.url} placeholder="https://hooks.slack.com/…" onChange={(e) => setCfg({ ...cfg, channels: { ...cfg.channels, webhook: { ...cfg.channels.webhook, url: e.target.value } } })} onBlur={() => void save({ channels: cfg.channels })} />
                  </Field>
                </div>
                <div>
                  <Button size="sm" loading={busy === 'test-webhook'} onClick={() => void test('webhook')}>Send a test</Button>
                </div>
              </div>
            </Card>
          </Grid>
          <Card title="E-mail" subtitle="Through your own mail server (SMTP)">
            <div className="fx-grid" style={{ gap: 10 }}>
              <Toggle checked={cfg.channels.email.enabled} onChange={(v) => void save({ channels: { ...cfg.channels, email: { ...cfg.channels.email, enabled: v } } })} label="Send alerts by e-mail" />
              <div className="fx-row">
                {(
                  [
                    ['host', 'SMTP server', 'smtp.office365.com'],
                    ['user', 'User name', 'me@example.com'],
                    ['from', 'From', 'FBRX <me@example.com>'],
                    ['to', 'To', 'me@example.com'],
                  ] as const
                ).map(([k, label, ph]) => (
                  <Field key={k} label={label}>
                    <Input value={cfg.channels.email[k]} placeholder={ph} onChange={(e) => setCfg({ ...cfg, channels: { ...cfg.channels, email: { ...cfg.channels.email, [k]: e.target.value } } })} onBlur={() => void save({ channels: cfg.channels })} />
                  </Field>
                ))}
                <Field label="Port">
                  <Input type="number" value={cfg.channels.email.port} onChange={(e) => setCfg({ ...cfg, channels: { ...cfg.channels, email: { ...cfg.channels.email, port: Number(e.target.value) } } })} onBlur={() => void save({ channels: cfg.channels })} />
                </Field>
              </div>
              <Toggle checked={cfg.channels.email.secure} onChange={(v) => void save({ channels: { ...cfg.channels, email: { ...cfg.channels.email, secure: v } } })} label="Use TLS from the start (port 465)" />
              <Callout tone="info" actions={<Button size="sm" onClick={() => navigate('vault')}>Credentials</Button>}>
                The SMTP password is kept encrypted in Credentials under the name <code>{cfg.channels.email.passwordSecret}</code>.
              </Callout>
              <div>
                <Button size="sm" loading={busy === 'test-email'} onClick={() => void test('email')}>Send a test e-mail</Button>
              </div>
            </div>
          </Card>
        </>
      )}
    </Page>
  );
}
