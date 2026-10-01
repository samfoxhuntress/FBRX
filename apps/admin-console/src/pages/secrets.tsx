import { useState } from 'react';
import { Button, Callout, Card, Empty, Field, Input, Modal, Page, Select, Table, timeAgo, useAction, useConfirm } from '@fbrx/ui';
import { api } from '../api';
import { useQuery } from '../state';
import type { DeviceSummary } from './common';

interface Secret {
  id: string;
  scope: 'tenant' | 'group' | 'device';
  scopeId: string;
  name: string;
  description: string;
  version: number;
  createdBy: string;
  updatedAt: string;
}

export function SecretsPage() {
  const secrets = useQuery<Secret[]>('/v1/admin/secrets');
  const groups = useQuery<Array<{ id: string; name: string }>>('/v1/admin/groups').data ?? [];
  const devices = useQuery<DeviceSummary[]>('/v1/admin/devices').data ?? [];
  const [edit, setEdit] = useState<Partial<Secret> | null>(null);
  const { confirm, dialog } = useConfirm();
  const { run } = useAction();
  const scopeLabel = (s: Secret) =>
    s.scope === 'tenant' ? 'All devices' : s.scope === 'group' ? `Group: ${groups.find((g) => g.id === s.scopeId)?.name ?? s.scopeId}` : `Device: ${devices.find((d) => d.id === s.scopeId)?.name ?? s.scopeId}`;
  return (
    <Page
      title="Organization credentials"
      description="API keys, tokens and passwords pushed into device vaults. Encrypted at rest on the control plane and delivered over the device's authenticated channel; users can use but not edit them. Device-scoped values override group values, which override organization-wide ones."
      actions={
        <Button variant="primary" icon="plus" onClick={() => setEdit({ scope: 'tenant' })}>
          Add credential
        </Button>
      }
    >
      <Callout tone="info" title="Tip">
        Add <code>FBRX_BACKUP_PASSPHRASE</code> to enable unattended scheduled and remote backups; add <code>ANTHROPIC_API_KEY</code> to give every workstation access to Claude without sharing the key with users.
      </Callout>
      <Card flush>
        <Table
          rows={secrets.data ?? []}
          rowKey={(s) => s.id}
          empty={<Empty title="No credentials yet" />}
          columns={[
            { key: 'n', header: 'Name', render: (s) => (<div><div className="fx-cell-title mono">{s.name}</div><div className="fx-cell-sub">{s.description}</div></div>) },
            { key: 's', header: 'Scope', render: scopeLabel },
            { key: 'v', header: 'Version', className: 'num', render: (s) => s.version },
            { key: 'u', header: 'Updated', render: (s) => `${timeAgo(s.updatedAt)} by ${s.createdBy}` },
            {
              key: 'x',
              header: '',
              render: (s) => (
                <div className="fx-actions">
                  <Button size="sm" onClick={() => setEdit(s)}>
                    Rotate
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={async () => {
                      if (await confirm({ title: `Delete ${s.name}?`, body: 'It is removed from every device vault on their next sync (seconds for online devices).', danger: true, confirmLabel: 'Delete' })) {
                        await run('d', () => api('DELETE', `/v1/admin/secrets/${s.id}`), 'Credential deleted');
                        secrets.reload();
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
      {edit && <SecretEditor secret={edit} groups={groups} devices={devices} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), secrets.reload())} />}
      {dialog}
    </Page>
  );
}

function SecretEditor({ secret, groups, devices, onClose, onSaved }: { secret: Partial<Secret>; groups: Array<{ id: string; name: string }>; devices: DeviceSummary[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ scope: secret.scope ?? 'tenant', scopeId: secret.scopeId ?? '', name: secret.name ?? '', value: '', description: secret.description ?? '' });
  const { busy, run } = useAction();
  const rotating = !!secret.id;
  return (
    <Modal
      title={rotating ? `Rotate ${secret.name}` : 'Add organization credential'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy === 's'}
            disabled={!f.name || !f.value || (f.scope !== 'tenant' && !f.scopeId)}
            onClick={() => void run('s', () => api('POST', '/v1/admin/secrets', { ...f, scopeId: f.scope === 'tenant' ? undefined : f.scopeId }).then(onSaved), rotating ? 'Credential rotated' : 'Credential added')}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label="Name" help="Letters, digits, . _ -">
          <Input className="mono" value={f.name} disabled={rotating} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="ANTHROPIC_API_KEY" />
        </Field>
        <Field label="Value">
          <Input type="password" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} autoComplete="off" />
        </Field>
        <Field label="Description">
          <Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <div className="fx-row">
          <Field label="Scope">
            <Select disabled={rotating} value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value as Secret['scope'], scopeId: '' })} options={[{ value: 'tenant', label: 'All devices' }, { value: 'group', label: 'A group' }, { value: 'device', label: 'One device' }]} />
          </Field>
          {f.scope === 'group' && (
            <Field label="Group">
              <Select disabled={rotating} value={f.scopeId} onChange={(e) => setF({ ...f, scopeId: e.target.value })} options={[{ value: '', label: 'Choose…' }, ...groups.map((g) => ({ value: g.id, label: g.name }))]} />
            </Field>
          )}
          {f.scope === 'device' && (
            <Field label="Device">
              <Select disabled={rotating} value={f.scopeId} onChange={(e) => setF({ ...f, scopeId: e.target.value })} options={[{ value: '', label: 'Choose…' }, ...devices.map((d) => ({ value: d.id, label: d.name }))]} />
            </Field>
          )}
        </div>
      </div>
    </Modal>
  );
}
