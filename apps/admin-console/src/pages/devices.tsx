import { useMemo, useState } from 'react';
import { AUDIENCE_NAMES } from '@fbrx/shared';
import { Button, Card, Empty, Icons, Input, Page, Select, Table, timeAgo, useAction, useConfirm } from '@fbrx/ui';
import { api } from '../api';
import { useApp, useQuery } from '../state';
import { CommandComposer } from './command-composer';
import { HealthStatus, OnlineStatus, PLATFORM_LABEL, type DeviceSummary } from './common';

export function DevicesPage() {
  const app = useApp();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [groupId, setGroupId] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [composer, setComposer] = useState(false);
  const { confirm, dialog } = useConfirm();
  const { run, busy } = useAction();
  // "Update now" for everyone: each computer installs the newest version from FBRX Command's releases or the repository.
  const updateAll = async () => {
    const ok = await confirm({
      title: 'Update every computer now?',
      body: 'Each online computer downloads the newest version and installs it, restarting FBRX (offline ones do it when they reconnect, within a day). Computers installed from the GitHub repository run the installer from it.',
      confirmLabel: 'Update all',
    });
    if (ok) await run('upd', () => api('POST', '/v1/admin/commands/bulk', { type: 'update.install', all: true, payload: { restartNow: true, source: 'auto' } }), 'Update sent to every computer');
  };
  const qs = new URLSearchParams({ ...(status ? { status } : {}), ...(groupId ? { groupId } : {}), ...(search ? { search } : {}) }).toString();
  const { data } = useQuery<DeviceSummary[]>(`/v1/admin/devices${qs ? `?${qs}` : ''}`, [], (e) => e.type.startsWith('device.'));
  const groups = useQuery<Array<{ id: string; name: string }>>(app.tenantId ? '/v1/admin/groups' : null).data ?? [];
  const groupName = useMemo(() => Object.fromEntries(groups.map((g) => [g.id, g.name])), [groups]);
  const rows = data ?? [];
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  return (
    <Page
      title="Devices"
      description="Every enrolled workstation, live. Select devices to send a command to all of them at once."
      actions={
        <>
          {app.can('commands.privileged') && app.tenantId && (
            <Button icon="download" loading={busy === 'upd'} onClick={() => void updateAll()}>
              Update everyone now
            </Button>
          )}
          {app.can('commands.send') && app.tenantId && (
            <Button icon="send" disabled={!selected.size} onClick={() => setComposer(true)}>
              Command {selected.size ? `${selected.size} selected` : ''}
            </Button>
          )}
          {app.can('enrollment.manage') && app.tenantId && (
            <Button variant="primary" icon="plus" onClick={() => (location.hash = '#/enrollment')}>
              Enroll devices
            </Button>
          )}
        </>
      }
    >
      <div className="fx-row">
        <div style={{ flex: 2, minWidth: 220 }}>
          <Input placeholder="Search name, hostname, tag or ID…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search devices" />
        </div>
        <div style={{ width: 180 }}>
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: '', label: 'Active & disabled' }, { value: 'active', label: 'Active' }, { value: 'disabled', label: 'Disabled' }, { value: 'retired', label: 'Retired' }]} />
        </div>
        {groups.length > 0 && (
          <div style={{ width: 200 }}>
            <Select aria-label="Group" value={groupId} onChange={(e) => setGroupId(e.target.value)} options={[{ value: '', label: 'All groups' }, ...groups.map((g) => ({ value: g.id, label: g.name }))]} />
          </div>
        )}
      </div>
      <Card flush>
        <Table
          rows={rows}
          rowKey={(d) => d.id}
          onRowClick={(d) => (location.hash = `#/device/${d.id}`)}
          empty={
            <Empty title="No devices yet" action={app.can('enrollment.manage') && app.tenantId ? <Button variant="primary" onClick={() => (location.hash = '#/enrollment')}>Create an enrollment token</Button> : undefined}>
              Install FBRX OS on a workstation and enroll it with a token from Deploy & enroll.
            </Empty>
          }
          columns={[
            {
              key: 'sel',
              header: <span className="sr-only">Select</span>,
              width: 36,
              render: (d) => <input type="checkbox" aria-label={`Select ${d.name}`} checked={selected.has(d.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(d.id)} disabled={d.status !== 'active'} />,
            },
            {
              key: 'name',
              header: 'Device',
              render: (d) => (
                <div>
                  <div className="fx-cell-title">
                    {d.name} {d.audience === 'student' && <span className="fx-badge accent">{AUDIENCE_NAMES.student}</span>} {d.helpdeskReceiver && <span title="Receives help desk tickets"><Icons.lifebuoy size={13} /></span>}
                  </div>
                  <div className="fx-cell-sub">{d.hostname}{d.tags.length ? ` · ${d.tags.join(', ')}` : ''}</div>
                </div>
              ),
            },
            { key: 'status', header: 'Connection', render: (d) => <OnlineStatus d={d} /> },
            { key: 'health', header: 'Health', render: (d) => <HealthStatus d={d} /> },
            { key: 'version', header: 'Version', render: (d) => <span className="mono">{d.appVersion}</span> },
            { key: 'platform', header: 'Platform', render: (d) => `${PLATFORM_LABEL[d.platform] ?? d.platform} · ${d.arch}` },
            { key: 'group', header: 'Group', render: (d) => (d.groupId ? groupName[d.groupId] ?? '—' : <span className="fx-muted">—</span>) },
            { key: 'seen', header: 'Last seen', render: (d) => <span className="fx-secondary">{d.online ? 'now' : timeAgo(d.lastSeenAt)}</span> },
          ]}
        />
      </Card>
      {dialog}
      {composer && (
        <CommandComposer
          target={{ deviceIds: [...selected], label: `${selected.size} selected device(s)` }}
          onClose={() => setComposer(false)}
          onSent={() => setSelected(new Set())}
        />
      )}
    </Page>
  );
}
