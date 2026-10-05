import { useState } from 'react';
import { VERTICAL_INFO, VERTICAL_NAMES, type Vertical } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Field, Icon, Input, Modal, Page, Status, Table, TextArea, formatDate, useAction } from '@fbrx/ui';
import { api } from '../api';
import { useApp, useQuery } from '../state';
import { KIND_ICONS, KindPicker } from './common';
import { QUICK_SETUP_TITLE, QuickSetup } from './quick-setup';

interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: string;
  vertical: Vertical;
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
      description="Each company, school or family you look after is a tenant with its own computers, users, configuration, credentials and license. Pick Work, School or Home when you create one."
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
            { key: 'k', header: 'Kind', render: (t) => (<span className="fx-kind"><Icon name={KIND_ICONS[t.vertical ?? 'business']} size={14} /> {VERTICAL_NAMES[t.vertical ?? 'business']}</span>) },
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
  const app = useApp();
  const [f, setF] = useState({ name: t.name ?? '', contactEmail: t.contactEmail ?? '', notes: t.notes ?? '', vertical: (t.vertical ?? 'business') as Vertical });
  const [created, setCreated] = useState<{ id: string; name: string; vertical: Vertical } | null>(null);
  const [kindChosen, setKindChosen] = useState(!!t.id);
  const { busy, run } = useAction();
  const info = VERTICAL_INFO[f.vertical];
  const save = (extra: Record<string, unknown> = {}) =>
    run(
      's',
      async () => {
        const r = await api<{ id: string }>(t.id ? 'PATCH' : 'POST', t.id ? `/v1/admin/tenants/${t.id}` : '/v1/admin/tenants', { ...f, contactEmail: f.contactEmail || null, ...extra });
        if (t.id) return onSaved();
        setCreated({ id: r.id, name: f.name, vertical: f.vertical });
      },
      'Tenant saved',
    );

  if (created) {
    return (
      <Modal
        title={`${created.name} is ready`}
        description={`${VERTICAL_NAMES[created.vertical]} tenant. ${QUICK_SETUP_TITLE[created.vertical]} now, or later from Profiles & groups.`}
        onClose={onSaved}
        wide
        footer={
          <>
            <span className="fx-spacer" />
            <Button onClick={onSaved}>Done</Button>
            <Button variant="primary" icon="chevronRight" onClick={() => (onSaved(), app.setTenant(created.id), (location.hash = '#/overview'))}>
              Open {created.name}
            </Button>
          </>
        }
      >
        <QuickSetup tenantId={created.id} vertical={created.vertical} />
      </Modal>
    );
  }

  if (!kindChosen) {
    return (
      <Modal
        title="New tenant"
        description="What kind of tenant is it? This sets the wording, the groups made for you and what each computer gets. You can change it later."
        onClose={onClose}
        wide
        footer={
          <>
            <span className="fx-spacer" />
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" icon="chevronRight" onClick={() => setKindChosen(true)}>
              Continue as {VERTICAL_NAMES[f.vertical]}
            </Button>
          </>
        }
      >
        <KindPicker value={f.vertical} onChange={(vertical) => setF({ ...f, vertical })} />
      </Modal>
    );
  }

  return (
    <Modal
      title={t.id ? t.name! : `New ${VERTICAL_NAMES[f.vertical]} tenant`}
      onClose={onClose}
      wide={!!t.id}
      footer={
        <>
          {t.id ? (
            <Button variant="danger" style={{ marginRight: 'auto' }} onClick={() => void save({ status: t.status === 'active' ? 'suspended' : 'active' })}>
              {t.status === 'active' ? 'Suspend tenant' : 'Reactivate'}
            </Button>
          ) : (
            <Button style={{ marginRight: 'auto' }} onClick={() => setKindChosen(false)}>
              Back
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 's'} disabled={!f.name.trim()} onClick={() => void save()}>
            {t.id ? 'Save' : 'Create tenant'}
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label={f.vertical === 'home' ? 'Family name' : f.vertical === 'education' ? 'School name' : 'Name'}>
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={info.example} autoFocus />
        </Field>
        {t.id && (
          <Field label="Kind">
            <KindPicker value={f.vertical} onChange={(vertical) => setF({ ...f, vertical })} />
          </Field>
        )}
        {t.id && f.vertical !== t.vertical && <Callout tone="info">Changing the kind changes the wording and defaults on every computer in {t.name}. Groups and computers stay as they are; set who uses each group under Profiles & groups.</Callout>}
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
