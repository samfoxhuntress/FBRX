import { useState } from 'react';
import { AUDIENCE_NAMES, VERTICAL_NAMES } from '@fbrx/shared';
import { Button, Callout, Card, Field, Grid, Input, KeyValue, Page, Status, Toggle, formatDate, timeAgo, useAction, useConfirm } from '@fbrx/ui';
import { call } from '../client';
import { useVertical } from '../edition';
import { useCore } from '../hooks';

export function FleetPage() {
  const { data: f } = useCore('fleet.status', undefined, ['fleet.changed', 'settings.changed', 'policy.changed', 'vault.changed']);
  const edition = useCore('edition.status', undefined, ['fleet.changed', 'license.changed']).data;
  const [form, setForm] = useState({ serverUrl: '', token: '', deviceName: '', student: false });
  const { confirm, dialog } = useConfirm();
  const { run, busy } = useAction();
  const vertical = useVertical();
  if (!f) return null;
  const enrolled = f.state !== 'unenrolled';
  return (
    <Page
      title={enrolled && vertical === 'home' ? 'Family' : 'Organization'}
      description={
        enrolled && vertical === 'home'
          ? "This computer belongs to your family's FBRX Command: a parent can see its health, send settings and updates, back it up, and answer your requests for help."
          : "Connect this computer to your company's, school's or family's FBRX Command so it can see its health, send settings and updates, back it up, and answer your requests for help."
      }
    >
      {!enrolled ? (
        <Grid cols={2}>
          <Card title="Connect to your organization">
            <div className="fx-form">
              <Field label="FBRX Command address" help="From whoever runs FBRX Command for you (IT, the school office or a parent), e.g. https://command.example.org">
                <Input value={form.serverUrl} onChange={(e) => setForm({ ...form, serverUrl: e.target.value })} placeholder="https://" />
              </Field>
              <Field label="Enrollment token">
                <Input value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value.trim() })} placeholder="fbrx_enr_…" />
              </Field>
              <Field label="Device name (optional)">
                <Input value={form.deviceName} onChange={(e) => setForm({ ...form, deviceName: e.target.value })} />
              </Field>
              <Toggle checked={form.student} onChange={(v) => setForm({ ...form, student: v })} label="This computer is for a student or a child" />
              {form.student && <p className="fx-muted" style={{ margin: 0, fontSize: 12.5 }}>It becomes FBRX OS Education (at a school) or FBRX OS Home (in a family): a simpler set of tools and a safe learning helper. Only FBRX Command can turn it back.</p>}
              <div>
                <Button variant="primary" icon="globe" loading={busy === 'e'} disabled={!form.serverUrl || !form.token} onClick={() => void run('e', () => call('fleet.enroll', { serverUrl: form.serverUrl, token: form.token, deviceName: form.deviceName || undefined, ...(form.student ? { audience: 'student' as const } : {}) }), 'Connected to your organization')}>
                  Connect
                </Button>
              </div>
            </div>
          </Card>
          <Card title="What your organization can do">
            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
              <li>See this device's health, version and agent activity (not your conversations or files)</li>
              <li>Apply settings, lock some of them, and set the governance policy</li>
              <li>Provide shared credentials into your vault</li>
              <li>Send commands: sync, back up, update, run an agent task (subject to your approvals)</li>
              <li>Deliver your license and plugins, and push new versions</li>
              <li>Answer your help desk tickets (a Help desk tab appears once you join)</li>
            </ul>
            <p className="fx-secondary">Every remote action is recorded in this device's audit log.</p>
          </Card>
        </Grid>
      ) : (
        <>
          {f.state === 'error' && <Callout tone="critical" title="Connection problem">{f.message}</Callout>}
          <Grid cols={2}>
            <Card
              title={f.tenantName ?? 'Organization'}
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
                  ...(edition ? ([['This computer', `${edition.productName} · ${VERTICAL_NAMES[edition.vertical]} · ${AUDIENCE_NAMES[edition.audience]}`]] as Array<[string, string]>) : []),
                  ['Device ID', <span className="mono">{f.deviceId}</span>],
                  ['Last heartbeat', timeAgo(f.lastHeartbeatAt)],
                  ['Last config sync', formatDate(f.lastSyncAt)],
                  ['Config version', f.configVersion],
                ]}
              />
            </Card>
            <Card title="Managed by your organization">
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
                Removes organization-managed settings, policy, license and credentials from this device. Your own data stays.
              </span>
              <Button
                variant="danger"
                onClick={async () => {
                  if (await confirm({ title: 'Disconnect from your organization?', body: 'Your administrator will see the device as retired. You can enroll again with a new token.', danger: true, confirmLabel: 'Disconnect' })) await run('u', () => call('fleet.unenroll'), 'Disconnected');
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
