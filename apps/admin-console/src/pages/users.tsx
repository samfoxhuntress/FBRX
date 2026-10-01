import { useState } from 'react';
import { Button, Callout, Card, CopyText, Empty, Field, Grid, Input, Modal, Page, Select, Status, Table, Toggle, formatDate, timeAgo, useAction, useConfirm } from '@fbrx/ui';
import { api } from '../api';
import { useApp, useQuery } from '../state';

interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  tenantId: string | null;
  status: string;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
}
interface Key {
  id: string;
  name: string;
  prefix: string;
  role: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

const ROLE_HELP: Record<string, string> = {
  superadmin: 'Platform operator: all tenants, releases and licensing',
  owner: 'Full control of this organization',
  admin: 'Configuration, credentials, users and privileged commands',
  operator: 'Manage devices and send routine commands',
  viewer: 'Read-only',
};

export function UsersPage() {
  const app = useApp();
  const users = useQuery<User[]>('/v1/admin/users');
  const keys = useQuery<Key[]>('/v1/admin/api-keys');
  const [edit, setEdit] = useState<Partial<User> | null>(null);
  const [newKey, setNewKey] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  const { run } = useAction();
  const roles = app.me.principal.role === 'superadmin' ? ['superadmin', 'owner', 'admin', 'operator', 'viewer'] : app.me.principal.role === 'owner' ? ['owner', 'admin', 'operator', 'viewer'] : ['admin', 'operator', 'viewer'];
  return (
    <Page title="Users & API keys" description="Role-based access for your team, and scoped API keys for automation and integrations (CI release publishing, ITSM, SIEM).">
      <Grid cols={2}>
        <Card title="Users" actions={<Button size="sm" icon="plus" onClick={() => setEdit({ role: 'operator' })}>Invite user</Button>} flush>
          <Table
            rows={users.data ?? []}
            rowKey={(u) => u.id}
            onRowClick={(u) => setEdit(u)}
            empty={<Empty title="No users" />}
            columns={[
              { key: 'n', header: 'User', render: (u) => (<div><div className="fx-cell-title">{u.name}</div><div className="fx-cell-sub">{u.email}</div></div>) },
              { key: 'r', header: 'Role', render: (u) => <span className="fx-badge">{u.role}</span> },
              { key: 'm', header: 'MFA', render: (u) => (u.mfaEnabled ? <Status tone="good">On</Status> : <Status tone="warning">Off</Status>) },
              { key: 's', header: 'Last sign-in', render: (u) => (u.status === 'disabled' ? <Status tone="neutral">Disabled</Status> : timeAgo(u.lastLoginAt)) },
            ]}
          />
        </Card>
        <Card title="API keys" actions={<Button size="sm" icon="plus" onClick={() => setNewKey(true)}>New key</Button>} flush>
          <Table
            rows={keys.data ?? []}
            rowKey={(k) => k.id}
            empty={<Empty title="No API keys" />}
            columns={[
              { key: 'n', header: 'Key', render: (k) => (<div><div className="fx-cell-title">{k.name}</div><div className="fx-cell-sub mono">{k.prefix}…</div></div>) },
              { key: 'r', header: 'Role', render: (k) => <span className="fx-badge">{k.role}</span> },
              { key: 'u', header: 'Last used', render: (k) => (k.revokedAt ? <Status tone="neutral">Revoked</Status> : timeAgo(k.lastUsedAt)) },
              {
                key: 'x',
                header: '',
                render: (k) =>
                  !k.revokedAt && (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={async () => {
                        if (await confirm({ title: `Revoke ${k.name}?`, body: 'Integrations using it stop working immediately.', danger: true, confirmLabel: 'Revoke' })) {
                          await run('r', () => api('DELETE', `/v1/admin/api-keys/${k.id}`), 'Key revoked');
                          keys.reload();
                        }
                      }}
                    >
                      Revoke
                    </Button>
                  ),
              },
            ]}
          />
        </Card>
      </Grid>
      {edit && <UserEditor user={edit} roles={roles} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), users.reload())} />}
      {newKey && (
        <KeyCreator
          roles={roles}
          onClose={() => setNewKey(false)}
          onCreated={(key) => {
            setNewKey(false);
            setCreated(key);
            keys.reload();
          }}
        />
      )}
      {created && (
        <Modal title="API key created" description="Copy it now; it will not be shown again." onClose={() => setCreated(null)} footer={<Button variant="primary" onClick={() => setCreated(null)}>Done</Button>}>
          <CopyText value={created} />
          <p className="fx-secondary">
            Use it as <code>Authorization: Bearer &lt;key&gt;</code> with the <code>/v1/admin/*</code> API.
          </p>
        </Modal>
      )}
      {dialog}
    </Page>
  );
}

function UserEditor({ user, roles, onClose, onSaved }: { user: Partial<User>; roles: string[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: user.name ?? '', email: user.email ?? '', role: user.role ?? 'operator', password: '', disabled: user.status === 'disabled', resetMfa: false });
  const { busy, run } = useAction();
  const save = () =>
    run(
      's',
      () =>
        user.id
          ? api('PATCH', `/v1/admin/users/${user.id}`, { name: f.name, role: f.role, status: f.disabled ? 'disabled' : 'active', password: f.password || undefined, resetMfa: f.resetMfa || undefined }).then(onSaved)
          : api('POST', '/v1/admin/users', { name: f.name, email: f.email, role: f.role, password: f.password }).then(onSaved),
      'User saved',
    );
  return (
    <Modal
      title={user.id ? user.name! : 'Invite user'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 's'} disabled={!f.name || (!user.id && (!f.email || f.password.length < 12))} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label="Name">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        {!user.id && (
          <Field label="Email">
            <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </Field>
        )}
        <Field label="Role" help={ROLE_HELP[f.role]}>
          <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} options={roles} />
        </Field>
        <Field label={user.id ? 'Set a new password (optional)' : 'Initial password'} help="At least 12 characters. Share it securely; the user can change it under Account.">
          <Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
        </Field>
        {user.id && (
          <>
            <Toggle checked={f.disabled} onChange={(v) => setF({ ...f, disabled: v })} label="Disable sign-in" />
            {user.mfaEnabled && <Toggle checked={f.resetMfa} onChange={(v) => setF({ ...f, resetMfa: v })} label="Reset MFA (user must enroll again)" />}
          </>
        )}
        {!user.id && <Callout tone="info">Ask the user to turn on two-factor authentication after their first sign-in.</Callout>}
      </div>
    </Modal>
  );
}

function KeyCreator({ roles, onClose, onCreated }: { roles: string[]; onClose: () => void; onCreated: (key: string) => void }) {
  const [f, setF] = useState({ name: '', role: 'operator', expiresInDays: '365' });
  const { busy, run } = useAction();
  return (
    <Modal
      title="New API key"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy === 'c'}
            disabled={!f.name}
            onClick={async () => {
              const r = await run('c', () => api<{ key: string }>('POST', '/v1/admin/api-keys', { name: f.name, role: f.role, expiresInDays: f.expiresInDays ? Number(f.expiresInDays) : undefined }));
              if (r) onCreated(r.key);
            }}
          >
            Create key
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label="Name">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="CI release publisher" />
        </Field>
        <Field label="Role" help={ROLE_HELP[f.role]}>
          <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} options={roles} />
        </Field>
        <Field label="Expires in (days)">
          <Input type="number" value={f.expiresInDays} onChange={(e) => setF({ ...f, expiresInDays: e.target.value })} />
        </Field>
        <div className="fx-muted" style={{ fontSize: 12 }}>Created {formatDate(new Date().toISOString())}</div>
      </div>
    </Modal>
  );
}
