import { Button, Callout, Card, Empty, Page, Table, formatBytes, formatDate, useAction, useConfirm } from '@fbrx/ui';
import { api, download } from '../api';
import { useQuery } from '../state';

interface Snap {
  id: string;
  deviceId: string | null;
  deviceName: string;
  name: string;
  label: string | null;
  size: number;
  header: { appVersion?: string; includesModels?: boolean; platform?: string } | null;
  isTemplate: boolean;
  createdAt: string;
}

export function SnapshotsPage() {
  const snaps = useQuery<Snap[]>('/v1/admin/snapshots');
  const { confirm, dialog } = useConfirm();
  const { run } = useAction();
  return (
    <Page
      title="Backups"
      description="Encrypted workstation snapshots uploaded by devices. Restore one onto a replacement machine (FBRX OS → Backup & Restore → Restore, “migrate”), or mark it as a golden image and attach it to an enrollment token to clone a configured workstation onto new machines."
    >
      <Callout tone="info" title="Zero-knowledge">
        Snapshots are encrypted on the device with the organization backup passphrase (credential <code>FBRX_BACKUP_PASSPHRASE</code>). The control plane stores them but cannot decrypt them.
      </Callout>
      <Card flush>
        <Table
          rows={snaps.data ?? []}
          rowKey={(s) => s.id}
          empty={<Empty title="No backups uploaded">Trigger one from a device page, or send backup.create to a group.</Empty>}
          columns={[
            { key: 'd', header: 'Device', render: (s) => (<div><div className="fx-cell-title">{s.deviceName}</div><div className="fx-cell-sub">{s.label ?? 'Backup'}{s.isTemplate ? ' · golden image' : ''}</div></div>) },
            { key: 'v', header: 'App version', render: (s) => <span className="mono">{s.header?.appVersion ?? '—'}</span> },
            { key: 'm', header: 'Models', render: (s) => (s.header?.includesModels ? 'included' : '—') },
            { key: 's', header: 'Size', className: 'num', render: (s) => formatBytes(s.size) },
            { key: 'c', header: 'Created', render: (s) => formatDate(s.createdAt) },
            {
              key: 'x',
              header: '',
              render: (s) => (
                <div className="fx-actions">
                  <Button size="sm" icon="download" onClick={() => void run('dl', () => download(`/v1/admin/snapshots/${s.id}/download`, s.name))}>
                    Download
                  </Button>
                  <Button size="sm" onClick={() => void run('t', () => api('PATCH', `/v1/admin/snapshots/${s.id}`, { isTemplate: !s.isTemplate }).then(snaps.reload), s.isTemplate ? 'No longer a golden image' : 'Marked as golden image')}>
                    {s.isTemplate ? 'Unmark image' : 'Use as golden image'}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={async () => {
                      if (await confirm({ title: 'Delete this backup?', body: 'This cannot be undone.', danger: true, confirmLabel: 'Delete' })) {
                        await run('d', () => api('DELETE', `/v1/admin/snapshots/${s.id}`), 'Backup deleted');
                        snaps.reload();
                      }
                    }}
                  >
                    Delete
                  </Button>
                </div>
              ),
            },
          ]}
        />
      </Card>
      {dialog}
    </Page>
  );
}
