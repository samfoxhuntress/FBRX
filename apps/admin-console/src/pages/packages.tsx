import { useRef, useState } from 'react';
import { Button, Callout, Card, Empty, Field, Modal, Page, Select, Table, formatBytes, formatDate, useAction, useConfirm } from '@fbrx/ui';
import { api } from '../api';
import { useApp, useQuery } from '../state';

interface Pkg {
  id: string;
  tenantId: string | null;
  pluginId: string;
  name: string;
  version: string;
  description: string;
  permissions: string[];
  sha256: string;
  size: number;
  createdAt: string;
}

export function PackagesPage() {
  const app = useApp();
  const pkgs = useQuery<Pkg[]>('/v1/admin/packages');
  const groups = useQuery<Array<{ id: string; name: string }>>(app.tenantId ? '/v1/admin/groups' : null).data ?? [];
  const fileRef = useRef<HTMLInputElement>(null);
  const [deploy, setDeploy] = useState<Pkg | null>(null);
  const { confirm, dialog } = useConfirm();
  const { busy, run } = useAction();
  const upload = async (file: File | undefined) => {
    if (!file) return;
    await run('up', () => api('POST', '/v1/admin/packages', undefined, { raw: file, contentType: 'application/gzip' }), `Uploaded ${file.name}`);
    pkgs.reload();
  };
  return (
    <Page
      title="Plugins"
      description="Extend every workstation with new tools. Upload a plugin package (.tgz with an fbrx-plugin.json manifest) and deploy it to devices; each device verifies the checksum and runs it in a sandbox, governed by its policy."
      actions={
        app.can('packages.manage') && app.tenantId ? (
          <>
            <input ref={fileRef} type="file" accept=".tgz,.gz" hidden onChange={(e) => void upload(e.target.files?.[0])} />
            <Button variant="primary" icon="upload" loading={busy === 'up'} onClick={() => fileRef.current?.click()}>
              Upload plugin
            </Button>
          </>
        ) : undefined
      }
    >
      <Callout tone="info">
        Build plugins with <code>@fbrx/plugin-sdk</code>; <code>npm run pack:plugin</code> produces the .tgz. See <code>docs/PLUGINS.md</code>.
      </Callout>
      <Card flush>
        <Table
          rows={pkgs.data ?? []}
          rowKey={(p) => p.id}
          empty={<Empty title="No plugin packages" />}
          columns={[
            { key: 'n', header: 'Plugin', render: (p) => (<div><div className="fx-cell-title">{p.name} <span className="mono fx-muted">{p.version}</span></div><div className="fx-cell-sub">{p.description || p.pluginId}</div></div>) },
            { key: 'p', header: 'Permissions', render: (p) => (p.permissions.length ? p.permissions.map((x) => <span key={x} className="fx-badge" style={{ marginRight: 4 }}>{x}</span>) : <span className="fx-muted">none</span>) },
            { key: 's', header: 'Size', className: 'num', render: (p) => formatBytes(p.size) },
            { key: 'sc', header: 'Scope', render: (p) => (p.tenantId ? 'Organisation' : <span className="fx-badge accent">Global</span>) },
            { key: 'd', header: 'Uploaded', render: (p) => formatDate(p.createdAt) },
            {
              key: 'x',
              header: '',
              render: (p) => (
                <div className="fx-actions">
                  {app.can('commands.privileged') && app.tenantId && (
                    <Button size="sm" icon="send" onClick={() => setDeploy(p)}>
                      Deploy
                    </Button>
                  )}
                  {app.can('packages.manage') && (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={async () => {
                        if (await confirm({ title: `Delete ${p.name} ${p.version}?`, body: 'Installed copies on devices are not removed; send plugin.uninstall for that.', danger: true, confirmLabel: 'Delete' })) {
                          await run('d', () => api('DELETE', `/v1/admin/packages/${p.id}`), 'Package deleted');
                          pkgs.reload();
                        }
                      }}
                    >
                      Delete
                    </Button>
                  )}
                </div>
              ),
            },
          ]}
        />
      </Card>
      {deploy && <DeployModal pkg={deploy} groups={groups} onClose={() => setDeploy(null)} />}
      {dialog}
    </Page>
  );
}

function DeployModal({ pkg, groups, onClose }: { pkg: Pkg; groups: Array<{ id: string; name: string }>; onClose: () => void }) {
  const [target, setTarget] = useState('all');
  const { busy, run } = useAction();
  return (
    <Modal
      title={`Deploy ${pkg.name} ${pkg.version}`}
      description="Devices download the package from the control plane, verify its SHA-256 and install it. Offline devices install when they reconnect."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy === 'd'}
            onClick={async () => {
              const r = await run('d', () => api<{ queued: number }>('POST', `/v1/admin/packages/${pkg.id}/deploy`, target === 'all' ? { all: true } : { groupId: target }));
              if (r) onClose();
            }}
          >
            Deploy
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label="Target">
          <Select value={target} onChange={(e) => setTarget(e.target.value)} options={[{ value: 'all', label: 'All active devices' }, ...groups.map((g) => ({ value: g.id, label: `Group: ${g.name}` }))]} />
        </Field>
        {pkg.permissions.length > 0 && <Callout tone="warning" title="This plugin requests">{pkg.permissions.join(', ')}</Callout>}
      </div>
    </Modal>
  );
}
