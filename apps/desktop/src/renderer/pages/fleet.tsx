import { useState } from 'react';
import { Button, Callout, Card, Field, Grid, Input, KeyValue, Page, Status, formatDate, timeAgo, useAction, useConfirm } from '@fbrx/ui';
import { call } from '../client';
import { useCore } from '../hooks';

export function FleetPage() {
  const { data: f } = useCore('fleet.status', undefined, ['fleet.changed', 'settings.changed', 'policy.changed', 'vault.changed']);
  const [form, setForm] = useState({ serverUrl: '', token: '', deviceName: '' });
  const { confirm, dialog } = useConfirm();
  const { run, busy } = useAction();
  if (!f) return null;
  const enrolled = f.state !== 'unenrolled';
  return (
    <Page title="Organisation" description="Connect this workstation to your FBRX control plane so administrators can see its health, push configuration, credentials and policies, send commands, back it up and update it remotely.">
      {!enrolled ? (
        <Grid cols={2}>
          <Card title="Connect to your organisation">
            <div className="fx-form">
              <Field label="Control plane URL" help="Provided by your administrator, e.g. https://fbrx.yourcompany.com">
                <Input value={form.serverUrl} onChange={(e) => setForm({ ...form, serverUrl: e.target.value })} placeholder="https://" />
              </Field>
              <Field label="Enrollment token">
                <Input value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value.trim() })} placeholder="fbrx_enr_…" />
              </Field>
              <Field label="Device name (optional)">
                <Input value={form.deviceName} onChange={(e) => setForm({ ...form, deviceName: e.target.value })} />
              </Field>
              <div>
                <Button variant="primary" icon="globe" loading={busy === 'e'} disabled={!form.serverUrl || !form.token} onClick={() => void run('e', () => call('fleet.enroll', { serverUrl: form.serverUrl, token: form.token, deviceName: form.deviceName || undefined }), 'Connected to your organisation')}>
                  Connect
                </Button>
              </div>
            </div>
          </Card>
          <Card title="What your organisation can do">
            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
              <li>See this device's health, version and agent activity (not your conversations or files)</li>
              <li>Apply settings, lock some of them, and set the governance policy</li>
              <li>Provide shared credentials into your vault</li>
              <li>Send commands: sync, back up, update, run an agent task (subject to your approvals)</li>
              <li>Deliver your license and plugins</li>
            </ul>
            <p className="fx-secondary">Every remote action is recorded in this device's audit log.</p>
          </Card>
        </Grid>
      ) : (
        <>
          {f.state === 'error' && <Callout tone="critical" title="Connection problem">{f.message}</Callout>}
          <Grid cols={2}>
            <Card
              title={f.tenantName ?? 'Organisation'}
              subtitle={f.serverUrl ?? undefined}
              actions={
                <Button size="sm" icon="refresh" loading={busy === 's'} onClick={() => void run('s', () => call('fleet.sync'), 'Configuration synced')}>
                  Sync now
                </Button>
              }
            >
              <KeyValue
                items={[
                  ['Connection', <Status tone={f.state === 'online' ? 'good' : f.state === 'error' ? 'critical' : f.state === 'connecting' ? 'busy' : 'warning'}>{f.state}</Status>],
                  ['Group', f.groupName ?? '—'],
                  ['Device ID', <span className="mono">{f.deviceId}</span>],
                  ['Last heartbeat', timeAgo(f.lastHeartbeatAt)],
                  ['Last config sync', formatDate(f.lastSyncAt)],
                  ['Config version', f.configVersion],
                ]}
              />
            </Card>
            <Card title="Managed by your organisation">
              <KeyValue
                items={[
                  ['Governance policy', f.policyManaged ? 'Managed' : 'Local'],
                  ['Credentials provided', f.managedSecrets],
                  ['Locked settings', f.lockedSettings.length ? f.lockedSettings.map((l) => <code key={l} style={{ marginRight: 6 }}>{l}</code>) : 'None'],
                ]}
              />
            </Card>
          </Grid>
          <Card title="Disconnect">
            <div className="fx-row" style={{ alignItems: 'center' }}>
              <span className="fx-secondary" style={{ flex: 1 }}>
                Removes organisation-managed settings, policy, license and credentials from this device. Your own data stays.
              </span>
              <Button
                variant="danger"
                onClick={async () => {
                  if (await confirm({ title: 'Disconnect from your organisation?', body: 'Your administrator will see the device as retired. You can enroll again with a new token.', danger: true, confirmLabel: 'Disconnect' })) await run('u', () => call('fleet.unenroll'), 'Disconnected');
                }}
              >
                Disconnect
              </Button>
            </div>
          </Card>
        </>
      )}
      {dialog}
    </Page>
  );
}
