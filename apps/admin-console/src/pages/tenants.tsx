import { useState } from 'react';
import { Button, Card, Empty, Field, Input, Modal, Page, Status, Table, TextArea, formatDate, useAction } from '@fbrx/ui';
import { api } from '../api';
import { useApp, useQuery } from '../state';

interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: string;
  contactEmail: string | null;
  notes: string;
  deviceCount: number;
  onlineCount: number;
  createdAt: string;
}

export function TenantsPage() {
  const app = useApp();
  const tenants = useQuery<Tenant[]>('/v1/admin/tenants', [], (e) => e.type === 'device.online' || e.type === 'device.offline');
  const [edit, setEdit] = useState<Partial<Tenant> | null>(null);
  return (
    <Page
      title="Tenants"
      description="Each customer or business unit you sell to is a tenant with its own devices, users, configuration, credentials and license."
      actions={
        <Button variant="primary" icon="plus" onClick={() => setEdit({})}>
          New tenant
        </Button>
      }
    >
      <Card flush>
        <Table
          rows={tenants.data ?? []}
          rowKey={(t) => t.id}
          onRowClick={(t) => setEdit(t)}
          empty={<Empty title="No tenants" />}
          columns={[
            { key: 'n', header: 'Tenant', render: (t) => (<div><div className="fx-cell-title">{t.name}</div><div className="fx-cell-sub">{t.contactEmail ?? t.slug}</div></div>) },
            { key: 's', header: 'Status', render: (t) => (t.status === 'active' ? <Status tone="good">Active</Status> : <Status tone="serious">Suspended</Status>) },
            { key: 'd', header: 'Devices', className: 'num', render: (t) => t.deviceCount },
            { key: 'o', header: 'Online', className: 'num', render: (t) => t.onlineCount },
            { key: 'c', header: 'Created', render: (t) => formatDate(t.createdAt) },
            { key: 'x', header: '', render: (t) => <Button size="sm" onClick={(e) => (e.stopPropagation(), app.setTenant(t.id), (location.hash = '#/overview'))}>Open</Button> },
          ]}
        />
      </Card>
      {edit && <TenantEditor t={edit} onClose={() => setEdit(null)} onSaved={async () => (setEdit(null), tenants.reload(), await app.refreshMe())} />}
    </Page>
  );
}

function TenantEditor({ t, onClose, onSaved }: { t: Partial<Tenant>; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: t.name ?? '', contactEmail: t.contactEmail ?? '', notes: t.notes ?? '' });
  const { busy, run } = useAction();
  const save = (extra: Record<string, unknown> = {}) =>
    run('s', () => api(t.id ? 'PATCH' : 'POST', t.id ? `/v1/admin/tenants/${t.id}` : '/v1/admin/tenants', { ...f, contactEmail: f.contactEmail || null, ...extra }).then(onSaved), 'Tenant saved');
  return (
    <Modal
      title={t.id ? t.name! : 'New tenant'}
      onClose={onClose}
      footer={
        <>
          {t.id && (
            <Button variant="danger" style={{ marginRight: 'auto' }} onClick={() => void save({ status: t.status === 'active' ? 'suspended' : 'active' })}>
              {t.status === 'active' ? 'Suspend tenant' : 'Reactivate'}
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 's'} disabled={!f.name.trim()} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label="Name">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />
        </Field>
        <Field label="Contact email">
          <Input type="email" value={f.contactEmail} onChange={(e) => setF({ ...f, contactEmail: e.target.value })} />
        </Field>
        <Field label="Notes">
          <TextArea rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}
