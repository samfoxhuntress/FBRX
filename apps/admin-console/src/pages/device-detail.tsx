import { useEffect, useState } from 'react';
import { DEFAULT_POLICY, UPDATE_CHANNELS } from '@fbrx/shared';
import {
  Button,
  Callout,
  Card,
  Empty,
  Field,
  Grid,
  Input,
  JsonEditor,
  KeyValue,
  LineChart,
  Meter,
  Modal,
  Page,
  Select,
  StatTile,
  Table,
  Tabs,
  Toggle,
  TextArea,
  formatBytes,
  formatDate,
  formatDuration,
  timeAgo,
  useAction,
  useConfirm,
} from '@fbrx/ui';
import { api, download } from '../api';
import { SettingsBuilder, type SettingsDraft } from './settings-builder';
import { useApp, useQuery } from '../state';
import { CommandComposer } from './command-composer';
import { CommandStatus, HealthStatus, audienceHelp, audienceOptions, OnlineStatus, PLATFORM_LABEL, ProtectionCell, ServiceState, SeverityStatus, type DeviceSummary } from './common';

interface Detail extends DeviceSummary {
  group: { id: string; name: string } | null;
  events: Array<{ id: string; ts: string; kind: string; severity: string; message: string }>;
  commands: Array<{ id: string; type: string; status: string; createdBy: string; createdAt: string; completedAt: string | null; result: unknown; error: string | null; payload: unknown }>;
  snapshots: Array<{ id: string; name: string; label: string | null; size: number; created_at: string }>;
  auditHead: { seq: number | null; hash: string | null };
}

type Tab = 'overview' | 'commands' | 'config' | 'events' | 'backups';

export function DeviceDetailPage({ id }: { id: string }) {
  const app = useApp();
  const [tab, setTab] = useState<Tab>('overview');
  const [composer, setComposer] = useState(false);
  const { confirm, dialog } = useConfirm();
  const { busy, run } = useAction();
  const { data: d, reload } = useQuery<Detail>(`/v1/admin/devices/${id}`, [id], (e) => ('deviceId' in e && e.deviceId === id) || (e.type === 'command.updated' && e.command?.deviceId === id));
  const metrics = useQuery<Array<{ ts: string; cpu: number; mem: number }>>(`/v1/admin/devices/${id}/metrics?hours=24`, [id], (e) => e.type === 'device.updated' && e.deviceId === id);
  if (!d) return <Page title="Device">{null}</Page>;

  const quick = async (type: string, payload: unknown = {}, label = type) => {
    await run(type, () => api('POST', `/v1/admin/devices/${id}/commands`, { type, payload }), `${label} sent to ${d.name}`);
    reload();
  };
  const h = d.health;
  const series = metrics.data ?? [];
  return (
    <Page
      title={
        <span style={{ display: 'inline-flex', gap: 12, alignItems: 'center' }}>
          {d.name} <OnlineStatus d={d} />
        </span>
      }
      description={`${d.hostname} · ${PLATFORM_LABEL[d.platform] ?? d.platform} ${d.arch} · FBRX OS ${d.appVersion}${d.group ? ` · ${d.group.name}` : ''}`}
      actions={
        app.can('commands.send') && d.status === 'active' ? (
          <>
            <Button icon="activity" loading={busy === 'ping'} onClick={() => void quick('ping', {}, 'Ping')}>
              Ping
            </Button>
            <Button icon="refresh" loading={busy === 'config.sync'} onClick={() => void quick('config.sync', {}, 'Config sync')}>
              Sync config
            </Button>
            {app.can('commands.privileged') && (
              <Button icon="archive" loading={busy === 'backup.create'} onClick={() => void quick('backup.create', { upload: true, label: 'Admin backup' }, 'Backup')}>
                Back up now
              </Button>
            )}
            <Button variant="primary" icon="send" onClick={() => setComposer(true)}>
              Send command
            </Button>
          </>
        ) : undefined
      }
    >
      {d.status !== 'active' && <Callout tone="warning">This device is {d.status}. It cannot connect or receive commands.</Callout>}
      <Tabs<Tab>
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'commands', label: `Commands (${d.commands.length})` },
          { id: 'config', label: 'Configuration' },
          { id: 'events', label: `Events (${d.events.length})` },
          { id: 'backups', label: `Backups (${d.snapshots.length})` },
        ]}
      />

      {tab === 'overview' && (
        <>
          <Grid cols={4}>
            <StatTile label="Health" value={<HealthStatus d={d} />} foot={h ? `Up ${formatDuration(h.uptimeSeconds)}` : 'Waiting for first heartbeat'} />
            <StatTile label="Agent runs (24h)" value={h?.agentRuns24h ?? '—'} foot={h ? `${h.toolCalls24h} tool calls` : undefined} />
            <StatTile label="Policy denials (24h)" value={h?.policyDenials24h ?? '—'} foot={h ? `${h.pendingApprovals} approvals pending` : undefined} />
            <StatTile label="Errors (24h)" value={h?.errors24h ?? '—'} foot={h?.lastBackupAt ? `Last backup ${timeAgo(h.lastBackupAt)}` : 'No backup yet'} />
          </Grid>
          <Grid cols={2}>
            <Card title="Resource usage" subtitle="CPU load and memory, % of capacity, last 24 hours">
              <LineChart
                height={210}
                yMax={100}
                yFormat={(n) => `${Math.round(n)}%`}
                series={[
                  { key: 'cpu', label: 'CPU load', slot: 0, points: series.map((p) => ({ t: new Date(p.ts).getTime(), v: p.cpu })) },
                  { key: 'mem', label: 'Memory', slot: 1, points: series.map((p) => ({ t: new Date(p.ts).getTime(), v: p.mem })) },
                ]}
              />
            </Card>
            <Card title="Workstation">
              <KeyValue
                items={[
                  ['Device ID', <span className="mono">{d.id}</span>],
                  ['Operating system', d.osVersion],
                  ['Last seen', d.online ? 'Connected now' : formatDate(d.lastSeenAt)],
                  ['Last IP', d.lastIp],
                  ['Enrolled', formatDate(d.enrolledAt)],
                  ['Antivirus', <ProtectionCell p={h?.protection} />],
                  ['Vault', h?.vaultState],
                  ['License', h ? `${h.licenseEdition} (${h.licenseState})` : null],
                  ['Local model', h?.runtimeModel ?? 'none'],
                  ['Disk free', h?.diskFreeGb !== null && h?.diskFreeGb !== undefined ? `${h.diskFreeGb} GB` : null],
                  ['Memory', h ? `${h.memUsedPct}% of ${formatBytes(h.memTotalMb * 1024 * 1024)}` : null],
                  ['Config version', d.configVersion],
                  ['Audit chain head', d.auditHead.seq ? <span className="mono">#{d.auditHead.seq} {d.auditHead.hash?.slice(0, 12)}…</span> : null],
                ]}
              />
              {h && (
                <div style={{ marginTop: 14 }}>
                  <div className="fx-label" style={{ marginBottom: 6 }}>Memory pressure</div>
                  <Meter value={h.memUsedPct} label="Memory used" />
                </div>
              )}
            </Card>
          </Grid>
          <Grid cols={2}>
            <Card title="Services" subtitle="Reported by the device's watchdog" flush>
              {h ? (
                <div className="fx-list">
                  {h.services.map((s) => (
                    <div className="fx-list-item" key={s.name}>
                      <span style={{ width: 110 }} className="fx-cell-title">
                        {s.name}
                      </span>
                      <ServiceState state={s.state} message={s.message} />
                    </div>
                  ))}
                </div>
              ) : (
                <Empty title="No heartbeat yet" />
              )}
            </Card>
            <Card title="Plugins" flush>
              {h?.plugins.length ? (
                <div className="fx-list">
                  {h.plugins.map((p) => (
                    <div className="fx-list-item" key={p.id}>
                      <span className="fx-cell-title" style={{ flex: 1 }}>
                        {p.id}
                      </span>
                      <span className="mono fx-muted">{p.version}</span>
                      <span className="fx-badge">{p.enabled ? 'enabled' : 'disabled'}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty title="No plugins installed">Deploy one from the Plugins page.</Empty>
              )}
            </Card>
          </Grid>
        </>
      )}

      {tab === 'commands' && <CommandsTab d={d} />}
      {tab === 'config' && <ConfigTab d={d} onSaved={reload} />}
      {tab === 'events' && (
        <Card flush>
          <Table
            rows={d.events}
            rowKey={(e) => e.id}
            empty={<Empty title="No events" />}
            columns={[
              { key: 'sev', header: 'Severity', render: (e) => <SeverityStatus severity={e.severity} /> },
              { key: 'kind', header: 'Kind', render: (e) => <span className="mono">{e.kind}</span> },
              { key: 'msg', header: 'Message', render: (e) => e.message },
              { key: 'ts', header: 'When', render: (e) => <span title={formatDate(e.ts)}>{timeAgo(e.ts)}</span> },
            ]}
          />
        </Card>
      )}
      {tab === 'backups' && (
        <Card
          flush
          subtitle="Snapshots are encrypted on the device with the organization backup passphrase; the control plane cannot read them."
          title="Backups"
          actions={
            app.can('commands.privileged') && d.status === 'active' ? (
              <Button size="sm" icon="archive" onClick={() => void quick('backup.create', { upload: true, label: 'Admin backup' }, 'Backup')}>
                Back up now
              </Button>
            ) : undefined
          }
        >
          <Table
            rows={d.snapshots}
            rowKey={(s) => s.id}
            empty={<Empty title="No backups uploaded">Use “Back up now”, or enable scheduled backups in a profile.</Empty>}
            columns={[
              { key: 'name', header: 'Snapshot', render: (s) => (<div><div className="fx-cell-title">{s.label ?? 'Backup'}</div><div className="fx-cell-sub mono">{s.name}</div></div>) },
              { key: 'size', header: 'Size', className: 'num', render: (s) => formatBytes(s.size) },
              { key: 'ts', header: 'Created', render: (s) => formatDate(s.created_at) },
              { key: 'dl', header: '', render: (s) => <Button size="sm" icon="download" onClick={() => void run('dl', () => download(`/v1/admin/snapshots/${s.id}/download`, s.name))}>Download</Button> },
            ]}
          />
        </Card>
      )}

      {app.can('devices.manage') && d.status !== 'retired' && (
        <Card title="Danger zone">
          <div className="fx-row" style={{ alignItems: 'center' }}>
            <div style={{ flex: 1 }} className="fx-secondary">
              Disabling blocks the device until re-enabled. Retiring revokes its credential permanently; reinstalling requires a new enrollment.
            </div>
            <Button
              variant="danger"
              onClick={() => void run('status', () => api('PATCH', `/v1/admin/devices/${id}`, { status: d.status === 'disabled' ? 'active' : 'disabled' }).then(reload), d.status === 'disabled' ? 'Device re-enabled' : 'Device disabled')}
            >
              {d.status === 'disabled' ? 'Re-enable' : 'Disable'}
            </Button>
            <Button
              variant="danger-solid"
              onClick={async () => {
                if (await confirm({ title: `Retire ${d.name}?`, body: 'The device is disconnected immediately and its credential revoked. Its data and backups are kept.', confirmLabel: 'Retire device', danger: true })) {
                  await run('retire', () => api('DELETE', `/v1/admin/devices/${id}`), 'Device retired');
                  location.hash = '#/devices';
                }
              }}
            >
              Retire device
            </Button>
          </div>
        </Card>
      )}
      {composer && <CommandComposer target={{ deviceId: id, label: d.name }} onClose={() => setComposer(false)} onSent={reload} />}
      {dialog}
    </Page>
  );
}

function CommandsTab({ d }: { d: Detail }) {
  const [view, setView] = useState<Detail['commands'][number] | null>(null);
  const { run } = useAction();
  return (
    <Card flush>
      <Table
        rows={d.commands}
        rowKey={(c) => c.id}
        onRowClick={setView}
        empty={<Empty title="No commands sent yet" />}
        columns={[
          { key: 'type', header: 'Command', render: (c) => <span className="mono">{c.type}</span> },
          { key: 'status', header: 'Status', render: (c) => <CommandStatus status={c.status} /> },
          { key: 'by', header: 'Sent by', render: (c) => c.createdBy },
          { key: 'at', header: 'Sent', render: (c) => <span title={formatDate(c.createdAt)}>{timeAgo(c.createdAt)}</span> },
          {
            key: 'x',
            header: '',
            render: (c) =>
              ['queued', 'sent'].includes(c.status) ? (
                <Button size="sm" variant="ghost" onClick={(e) => (e.stopPropagation(), void run('cancel', () => api('POST', `/v1/admin/commands/${c.id}/cancel`), 'Command canceled'))}>
                  Cancel
                </Button>
              ) : null,
          },
        ]}
      />
      {view && (
        <Modal title={`${view.type} · ${view.status}`} wide onClose={() => setView(null)} footer={<Button onClick={() => setView(null)}>Close</Button>}>
          <div className="fx-form">
            <Field label="Payload">
              <pre className="fx-code">{JSON.stringify(view.payload, null, 2)}</pre>
            </Field>
            {view.error && <Callout tone="critical" title="Error">{view.error}</Callout>}
            {view.result !== null && view.result !== undefined && (
              <Field label="Result">
                <pre className="fx-code">{typeof (view.result as any)?.answer === 'string' ? (view.result as any).answer : JSON.stringify(view.result, null, 2)}</pre>
              </Field>
            )}
          </div>
        </Modal>
      )}
    </Card>
  );
}

function ConfigTab({ d, onSaved }: { d: Detail; onSaved: () => void }) {
  const app = useApp();
  const groups = useQuery<Array<{ id: string; name: string }>>('/v1/admin/groups').data ?? [];
  const releases = useQuery<Array<{ version: string; published: boolean }>>('/v1/admin/releases').data ?? [];
  const [name, setName] = useState(d.name);
  const [groupId, setGroupId] = useState(d.groupId ?? '');
  const [tags, setTags] = useState(d.tags.join(', '));
  const [notes, setNotes] = useState(d.notes);
  const [channel, setChannel] = useState(d.updateChannel ?? '');
  const [pinned, setPinned] = useState(d.pinnedVersion ?? '');
  const [draft, setDraft] = useState<SettingsDraft>({ settings: d.settingsOverride, locked: d.lockedOverride });
  const [policy, setPolicy] = useState(d.policyOverride ? JSON.stringify(d.policyOverride, null, 2) : '');
  const [audience, setAudience] = useState<string>(d.audience ?? '');
  const [receiver, setReceiver] = useState(!!d.helpdeskReceiver);
  const [valid, setValid] = useState({ s: true, p: true });
  const { busy, run } = useAction();
  const canConfig = app.can('config.manage');
  useEffect(() => setName(d.name), [d.name]);
  const save = () =>
    run(
      'save',
      () =>
        api('PATCH', `/v1/admin/devices/${d.id}`, {
          name,
          tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
          notes,
          ...(canConfig
            ? {
                groupId: groupId || null,
                updateChannel: channel || null,
                pinnedVersion: pinned || null,
                settingsOverride: draft.settings,
                lockedOverride: draft.locked,
                policyOverride: policy.trim() ? JSON.parse(policy) : null,
                audience: audience || null,
                helpdeskReceiver: receiver,
              }
            : {}),
        }).then(onSaved),
      'Device configuration saved; the device re-syncs immediately',
    );
  return (
    <Grid cols={2}>
      <Card title="Identity">
        <div className="fx-form">
          <Field label="Display name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Tags" help="Comma-separated, searchable">
            <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="finance, floor-3" />
          </Field>
          <Field label="Notes">
            <TextArea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <Field label="Group" help="Groups apply a configuration profile and update channel">
            <Select disabled={!canConfig} value={groupId} onChange={(e) => setGroupId(e.target.value)} options={[{ value: '', label: 'No group' }, ...groups.map((g) => ({ value: g.id, label: g.name }))]} />
          </Field>
          <div className="fx-row">
            <Field label="Update channel">
              <Select disabled={!canConfig} value={channel} onChange={(e) => setChannel(e.target.value)} options={[{ value: '', label: 'Inherit' }, ...UPDATE_CHANNELS.map((c) => ({ value: c, label: c }))]} />
            </Field>
            <Field label="Pin version" help="Hold or roll back this device">
              <Select disabled={!canConfig} value={pinned} onChange={(e) => setPinned(e.target.value)} options={[{ value: '', label: 'Not pinned' }, ...releases.filter((r) => r.published).map((r) => ({ value: r.version, label: r.version }))]} />
            </Field>
          </div>
          <Field label="Used by" help={audienceHelp(app.kind)}>
            <Select disabled={!canConfig} value={audience} onChange={(e) => setAudience(e.target.value)} options={[{ value: '', label: 'Its group (or the organization default)' }, ...audienceOptions(app.kind)]} />
          </Field>
          <Toggle checked={receiver} disabled={!canConfig} onChange={setReceiver} label={app.kind === 'home' ? "Receives the family's requests for help (a parent's computer)" : 'Receives help desk tickets (the IT computer)'} />
        </div>
      </Card>
      <Card title="Overrides" subtitle="Applied on top of the tenant and group profiles, for this device only">
        <div className="fx-form">
          <SettingsBuilder value={draft} onChange={setDraft} disabled={!canConfig} onJsonValidity={(ok) => setValid((v) => (v.s === ok ? v : { ...v, s: ok }))} />
          <Field label="Governance policy override (JSON)" help="Leave empty to inherit the profile policy">
            <JsonEditor value={policy} onChange={setPolicy} rows={7} onValidity={(ok) => setValid((v) => (v.p === ok ? v : { ...v, p: ok }))} />
          </Field>
          {!policy.trim() && canConfig && (
            <Button size="sm" onClick={() => setPolicy(JSON.stringify(DEFAULT_POLICY, null, 2))}>
              Start from the default policy
            </Button>
          )}
        </div>
      </Card>
      <div>
        <Button variant="primary" loading={busy === 'save'} disabled={!valid.s || !valid.p} onClick={() => void save()}>
          Save configuration
        </Button>
      </div>
    </Grid>
  );
}
