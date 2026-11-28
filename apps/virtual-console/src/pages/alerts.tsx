import { useEffect, useState } from 'react';
import { fbrxAlertDuration, type ServerAlertChannel, type ServerAlertRow, type ServerAlertSettings, type ServerAlertsList } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Field, Input, Page, Select, Status, timeAgo, Toggle, useAction, useToast } from '@fbrx/ui';
import { api } from '../api';
import { useApp, usePoll } from '../state';

const SEVERITY = [
  { value: 'info', label: 'Everything (information and up)' },
  { value: 'warning', label: 'Warnings and critical' },
  { value: 'critical', label: 'Critical only' },
];
type Severity = ServerAlertSettings['email']['min'];
const TONE = { info: 'neutral', warning: 'warning', critical: 'critical' } as const;
const CHANNEL_WORDS: Record<ServerAlertChannel, string> = { email: 'e-mail', webhook: 'webhook', syslog: 'syslog' };
const ROLE_WORDS: Record<string, string> = { gate: 'FBRX Gate', minidome: 'MiniDome', time: 'FBRX Time', files: 'File server' };

/** Where an alert went, in words: "e-mail, syslog" or what went wrong. */
function went(d: ServerAlertRow['deliveries']): string {
  const e = Object.entries(d);
  if (!e.length) return 'Shown here only';
  return e.map(([c, r]) => (r === 'ok' ? CHANNEL_WORDS[c as ServerAlertChannel] : `${CHANNEL_WORDS[c as ServerAlertChannel]} failed (${r})`)).join(', ');
}

function AlertLine({ row }: { row: ServerAlertRow }) {
  const a = row.alert;
  const lasted = fbrxAlertDuration(a);
  return (
    <div className="vt-alert">
      <div className="fx-row" style={{ gap: 8, alignItems: 'center' }}>
        {a.state === 'resolved' ? <Status tone="good">All clear</Status> : <Status tone={TONE[a.severity]}>{a.severity === 'info' ? 'Information' : a.severity === 'warning' ? 'Warning' : 'Critical'}</Status>}
        <b>{a.title}</b>
        <span className="fx-spacer" />
        <span className="fx-muted" style={{ fontSize: 12.5 }}>
          {a.source.role ? `${ROLE_WORDS[a.source.role] ?? a.source.role} · ` : ''}
          {a.state === 'open' ? `since ${timeAgo(a.startedAt)}` : a.state === 'resolved' ? `ended ${timeAgo(a.endedAt!)}${lasted ? `, after ${lasted}` : ''}` : timeAgo(a.startedAt)}
        </span>
      </div>
      {a.detail && a.state !== 'resolved' && <div className="fx-secondary" style={{ marginTop: 4 }}>{a.detail}</div>}
      {a.yours && a.state === 'open' && <div style={{ marginTop: 4 }}>What is left for you: {a.yours}</div>}
      <div className="fx-muted" style={{ fontSize: 12, marginTop: 4 }}>
        Sent to: {went(row.deliveries)}
        {a.state === 'resolved' && Object.keys(row.cleared).length ? ` · All-clear to: ${went(row.cleared)}` : ''}
      </div>
    </div>
  );
}

function Delivery() {
  const toast = useToast();
  const { busy, run } = useAction();
  const [s, setS] = useState<ServerAlertSettings | null>(null);
  const [password, setPassword] = useState('');
  const [secret, setSecret] = useState('');
  useEffect(() => {
    void api<{ settings: ServerAlertSettings }>('GET', '/v1/alerts/settings').then((r) => setS(r.settings), () => undefined);
  }, []);
  if (!s) return null;
  const save = (part: keyof ServerAlertSettings, extra: Record<string, unknown> = {}) =>
    run(`save-${part}`, async () => {
      const { passwordSet: _p, secretSet: _s, ...plain } = s[part] as unknown as Record<string, unknown>;
      const r = await api<{ settings: ServerAlertSettings }>('PUT', '/v1/alerts/settings', { [part]: { ...plain, ...extra } });
      setS(r.settings);
      setPassword('');
      setSecret('');
      toast.success('Saved');
    });
  const test = (c: ServerAlertChannel) =>
    run(`test-${c}`, async () => {
      const r = await api<{ ok: boolean; result: string }>('POST', '/v1/alerts/test', { channel: c });
      (r.ok ? toast.success : toast.error)(`Test ${CHANNEL_WORDS[c]}`, r.result);
    });
  const set = <K extends keyof ServerAlertSettings>(part: K, v: Partial<ServerAlertSettings[K]>) => setS({ ...s, [part]: { ...s[part], ...v } });
  const makeSecret = () => setSecret(Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join(''));
  return (
    <>
      <Card title="E-mail" subtitle="Through your mail server (SMTP)">
        <div className="fx-form">
          <Toggle checked={s.email.enabled} onChange={(v) => set('email', { enabled: v })} label="Send alerts by e-mail" />
          <div className="fx-row">
            <Field label="Send">
              <Select value={s.email.min} onChange={(e) => set('email', { min: e.target.value as Severity })} options={SEVERITY} />
            </Field>
            <Field label="To">
              <Input value={s.email.to} placeholder="it@example.com" onChange={(e) => set('email', { to: e.target.value })} />
            </Field>
            <Field label="From">
              <Input value={s.email.from} placeholder="FBRX Server <fbrx@example.com>" onChange={(e) => set('email', { from: e.target.value })} />
            </Field>
          </div>
          <div className="fx-row">
            <Field label="SMTP server">
              <Input value={s.email.host} placeholder="smtp.example.com" onChange={(e) => set('email', { host: e.target.value })} />
            </Field>
            <Field label="Port">
              <Input type="number" value={s.email.port} onChange={(e) => set('email', { port: Number(e.target.value) })} />
            </Field>
            <Field label="User name">
              <Input value={s.email.user} onChange={(e) => set('email', { user: e.target.value })} />
            </Field>
            <Field label="Password">
              <Input type="password" value={password} placeholder={s.email.passwordSet ? 'Saved (type to change)' : ''} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </div>
          <Toggle checked={s.email.secure} onChange={(v) => set('email', { secure: v })} label="TLS from the start (port 465)" />
          <div className="fx-actions">
            <Button variant="primary" loading={busy === 'save-email'} onClick={() => void save('email', password ? { password } : {})}>
              Save
            </Button>
            <Button loading={busy === 'test-email'} onClick={() => void test('email')}>
              Send a test
            </Button>
          </div>
        </div>
      </Card>
      <Card title="Webhook" subtitle="FBRX Alert v1 JSON, signed, for your own systems (ticketing, chat bots, a SIEM)">
        <div className="fx-form">
          <Toggle checked={s.webhook.enabled} onChange={(v) => set('webhook', { enabled: v })} label="Send alerts to a webhook" />
          <div className="fx-row">
            <Field label="Send">
              <Select value={s.webhook.min} onChange={(e) => set('webhook', { min: e.target.value as Severity })} options={SEVERITY} />
            </Field>
            <Field label="Address">
              <Input value={s.webhook.url} placeholder="https://alerts.example.com/fbrx" onChange={(e) => set('webhook', { url: e.target.value })} />
            </Field>
          </div>
          <Field label="Signing secret" help="Your system checks the FBRX-Signature header with the same secret. It is kept sealed on the server and not shown again: copy it before you save.">
            <div className="fx-row" style={{ flexWrap: 'nowrap' }}>
              <Input className="mono" style={{ flex: 1 }} value={secret} placeholder={s.webhook.secretSet ? 'Saved (type or make a new one to change)' : 'None yet'} onChange={(e) => setSecret(e.target.value)} />
              <Button onClick={makeSecret}>Make one</Button>
            </div>
          </Field>
          <div className="fx-actions">
            <Button variant="primary" loading={busy === 'save-webhook'} onClick={() => void save('webhook', secret ? { secret } : {})}>
              Save
            </Button>
            <Button loading={busy === 'test-webhook'} onClick={() => void test('webhook')}>
              Send a test
            </Button>
          </div>
        </div>
      </Card>
      <Card title="Syslog" subtitle="To a log server or SIEM, in the standard syslog format (RFC 5424)">
        <div className="fx-form">
          <Toggle checked={s.syslog.enabled} onChange={(v) => set('syslog', { enabled: v })} label="Send alerts to a syslog server" />
          <div className="fx-row">
            <Field label="Send">
              <Select value={s.syslog.min} onChange={(e) => set('syslog', { min: e.target.value as Severity })} options={SEVERITY} />
            </Field>
            <Field label="Server">
              <Input value={s.syslog.host} placeholder="logs.example.lan" onChange={(e) => set('syslog', { host: e.target.value })} />
            </Field>
            <Field label="Protocol">
              <Select
                value={s.syslog.protocol}
                onChange={(e) => {
                  const protocol = e.target.value as ServerAlertSettings['syslog']['protocol'];
                  set('syslog', { protocol, port: [514, 6514].includes(s.syslog.port) ? (protocol === 'tls' ? 6514 : 514) : s.syslog.port });
                }}
                options={[
                  { value: 'udp', label: 'UDP' },
                  { value: 'tcp', label: 'TCP' },
                  { value: 'tls', label: 'TLS' },
                ]}
              />
            </Field>
            <Field label="Port">
              <Input type="number" value={s.syslog.port} onChange={(e) => set('syslog', { port: Number(e.target.value) })} />
            </Field>
          </div>
          <div className="fx-actions">
            <Button variant="primary" loading={busy === 'save-syslog'} onClick={() => void save('syslog')}>
              Save
            </Button>
            <Button loading={busy === 'test-syslog'} onClick={() => void test('syslog')}>
              Send a test
            </Button>
          </div>
        </div>
      </Card>
    </>
  );
}

/**
 * The server's alerts: what is wrong now (each said once, then its all-clear), what was, and where they are sent.
 */
export function AlertsPage() {
  const app = useApp();
  const list = usePoll<ServerAlertsList>('/v1/alerts', 10_000);
  const admin = app.can('admin');
  return (
    <Page title="Alerts" description="What goes wrong on this server and its roles (its drives, FBRX Gate, MiniDome, FBRX Time) is said once, then its all-clear when it is over.">
      <Card title="Going on now">
        {list.data && !list.data.open.length ? (
          <Empty title="Nothing is wrong">When something goes wrong, it shows here until it is over.</Empty>
        ) : (
          <div className="vt-alerts">{list.data?.open.map((r) => <AlertLine key={r.alert.id} row={r} />)}</div>
        )}
      </Card>
      <Card title="Recently">
        {list.data && !list.data.recent.length ? <Empty title="No alerts yet" /> : <div className="vt-alerts">{list.data?.recent.map((r) => <AlertLine key={r.alert.id} row={r} />)}</div>}
      </Card>
      {admin ? (
        <>
          <h2 className="vt-section">Where alerts go</h2>
          <Callout tone="info">Each channel gets the alerts from the severity you choose; an all-clear goes wherever its alert went.</Callout>
          <Delivery />
        </>
      ) : null}
    </Page>
  );
}
