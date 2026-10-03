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
  sso: boolean;
  hasPassword: boolean;
  lastLoginAt: string | null;
}
type Provider = 'google' | 'microsoft' | 'oidc';
interface SsoConnection {
  id: string;
  provider: Provider;
  name: string;
  issuer: string;
  clientId: string;
  domains: string[];
  autoProvision: boolean;
  defaultRole: string;
  requireSso: boolean;
  enabled: boolean;
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
  const canSso = app.can('sso.manage') || app.can('users.manage');
  const sso = useQuery<{ callbackUrl: string; connections: SsoConnection[] }>(canSso && app.tenantId ? '/v1/admin/sso' : null, [app.tenantId]);
  const hasSso = !!sso.data?.connections.some((c) => c.enabled);
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
              { key: 'm', header: 'Sign-in', render: (u) => (u.sso || !u.hasPassword ? <Status tone="good">Single sign-on</Status> : u.mfaEnabled ? <Status tone="good">Password + MFA</Status> : <Status tone="warning">Password, no MFA</Status>) },
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
      {app.tenantId && sso.data && <SsoCard data={sso.data} canManage={app.can('sso.manage')} onChanged={sso.reload} />}
      {edit && <UserEditor user={edit} roles={roles} hasSso={hasSso} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), users.reload())} />}
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

function UserEditor({ user, roles, hasSso, onClose, onSaved }: { user: Partial<User>; roles: string[]; hasSso: boolean; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: user.name ?? '', email: user.email ?? '', role: user.role ?? 'operator', password: '', disabled: user.status === 'disabled', resetMfa: false });
  const { busy, run } = useAction();
  const save = () =>
    run(
      's',
      () =>
        user.id
          ? api('PATCH', `/v1/admin/users/${user.id}`, { name: f.name, role: f.role, status: f.disabled ? 'disabled' : 'active', password: f.password || undefined, resetMfa: f.resetMfa || undefined }).then(onSaved)
          : api('POST', '/v1/admin/users', { name: f.name, email: f.email, role: f.role, password: f.password || undefined }).then(onSaved),
      'User saved',
    );
  return (
    <Modal
      title={user.id ? user.name! : 'Invite user'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 's'} disabled={!f.name || (!user.id && (!f.email || (f.password ? f.password.length < 12 : !hasSso)))} onClick={() => void save()}>
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
        <Field
          label={user.id ? 'Set a new password (optional)' : hasSso ? 'Initial password (optional)' : 'Initial password'}
          help={hasSso && !user.id ? 'Leave it empty and they sign in with Google or Microsoft. Or set one (at least 12 characters) to let them use a password too.' : 'At least 12 characters. Share it securely; the user can change it under Account.'}
        >
          <Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
        </Field>
        {user.id && (
          <>
            <Toggle checked={f.disabled} onChange={(v) => setF({ ...f, disabled: v })} label="Disable sign-in" />
            {user.mfaEnabled && <Toggle checked={f.resetMfa} onChange={(v) => setF({ ...f, resetMfa: v })} label="Reset MFA (user must enroll again)" />}
          </>
        )}
        {!user.id && !(hasSso && !f.password) && <Callout tone="info">Ask the user to turn on two-factor authentication after their first sign-in.</Callout>}
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

const PROVIDER_NAMES: Record<Provider, string> = { google: 'Google Workspace', microsoft: 'Microsoft 365', oidc: 'Other (OpenID Connect)' };

/** Sign in with Google or Microsoft: the organization's connections, and adding one with a guide for each provider. */
function SsoCard({ data, canManage, onChanged }: { data: { callbackUrl: string; connections: SsoConnection[] }; canManage: boolean; onChanged: () => void }) {
  const [edit, setEdit] = useState<Partial<SsoConnection> & { provider: Provider } | null>(null);
  const { confirm, dialog } = useConfirm();
  const { run } = useAction();
  return (
    <Card
      title="Sign in with Google or Microsoft"
      subtitle="Single sign-on for this organization's FBRX Command users. Staff click the button on the sign-in page and use their school or work account; Google or Microsoft handles their password and two-step verification."
      actions={
        canManage ? (
          <>
            <Button size="sm" icon="plus" onClick={() => setEdit({ provider: 'google' })}>
              Google Workspace
            </Button>
            <Button size="sm" icon="plus" onClick={() => setEdit({ provider: 'microsoft' })}>
              Microsoft 365
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEdit({ provider: 'oidc' })}>
              Other
            </Button>
          </>
        ) : undefined
      }
      flush
    >
      <Table
        rows={data.connections}
        rowKey={(c) => c.id}
        onRowClick={canManage ? (c) => setEdit(c) : undefined}
        empty={<Empty title="No single sign-on yet">{canManage ? 'Add Google Workspace or Microsoft 365. Until then, everyone signs in with email, password and two-step codes.' : 'An owner can set it up.'}</Empty>}
        columns={[
          { key: 'p', header: 'Provider', render: (c) => (<div><div className="fx-cell-title">{c.name}</div><div className="fx-cell-sub">{PROVIDER_NAMES[c.provider]}</div></div>) },
          { key: 'd', header: 'Domains', render: (c) => c.domains.join(', ') },
          { key: 'n', header: 'New people', render: (c) => (c.autoProvision ? `Join as ${c.defaultRole}` : 'Invite only') },
          { key: 'r', header: 'Passwords', render: (c) => (c.requireSso ? 'Owners only' : 'Allowed') },
          { key: 's', header: 'Status', render: (c) => (c.enabled ? <Status tone="good">On</Status> : <Status tone="neutral">Off</Status>) },
          {
            key: 'x',
            header: '',
            render: (c) =>
              canManage && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  aria-label={`Remove ${c.name}`}
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (await confirm({ title: `Remove ${c.name}?`, body: 'People who only sign in this way cannot sign in until it is set up again or they get a password.', danger: true, confirmLabel: 'Remove' })) {
                      await run('d', () => api('DELETE', `/v1/admin/sso/${c.id}`), 'Removed');
                      onChanged();
                    }
                  }}
                />
              ),
          },
        ]}
      />
      {edit && <SsoEditor connection={edit} callbackUrl={data.callbackUrl} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), onChanged())} />}
      {dialog}
    </Card>
  );
}

const GUIDES: Record<Provider, { steps: string[]; idLabel: string; secretLabel: string }> = {
  google: {
    steps: [
      'Open the Google Cloud console (console.cloud.google.com) with a Google Workspace admin account and pick or create a project for FBRX Command.',
      'APIs & Services → OAuth consent screen: choose Internal (only your Workspace accounts), add an app name like FBRX Command, and save.',
      'APIs & Services → Credentials → Create credentials → OAuth client ID → Web application.',
      'Under Authorized redirect URIs, add the address below, then Create.',
      'Copy the Client ID and Client secret into this form, and enter your Workspace domain (like school.org).',
    ],
    idLabel: 'Client ID',
    secretLabel: 'Client secret',
  },
  microsoft: {
    steps: [
      'Open the Microsoft Entra admin center (entra.microsoft.com) as an administrator → Applications → App registrations → New registration.',
      'Name it FBRX Command, choose "Accounts in this organizational directory only", and under Redirect URI pick Web and paste the address below. Register.',
      'On the app\'s Overview, copy the Application (client) ID and the Directory (tenant) ID into this form.',
      'Certificates & secrets → New client secret → copy its Value (not the Secret ID) into this form. Note when it expires.',
      'Enter your email domain (like school.org). Optional: Token configuration → Add optional claim → ID → email.',
    ],
    idLabel: 'Application (client) ID',
    secretLabel: 'Client secret (Value)',
  },
  oidc: {
    steps: ['Create an OpenID Connect web application in your identity provider.', 'Use the redirect address below.', 'Enter its issuer URL, client ID and secret, and the email domains it vouches for.'],
    idLabel: 'Client ID',
    secretLabel: 'Client secret',
  },
};

function SsoEditor({ connection, callbackUrl, onClose, onSaved }: { connection: Partial<SsoConnection> & { provider: Provider }; callbackUrl: string; onClose: () => void; onSaved: () => void }) {
  const p = connection.provider;
  const existing = !!connection.id;
  const msDirectory = p === 'microsoft' && connection.issuer ? decodeURIComponent(connection.issuer.split('/')[3] ?? '') : '';
  const [f, setF] = useState({
    name: connection.name ?? '',
    directory: msDirectory,
    issuer: p === 'oidc' ? connection.issuer ?? '' : '',
    clientId: connection.clientId ?? '',
    clientSecret: '',
    domains: (connection.domains ?? []).join(', '),
    autoProvision: connection.autoProvision ?? false,
    defaultRole: connection.defaultRole ?? 'viewer',
    requireSso: connection.requireSso ?? false,
    enabled: connection.enabled ?? true,
  });
  const { busy, run } = useAction();
  const guide = GUIDES[p];
  const body = {
    provider: p,
    name: f.name || undefined,
    directory: p === 'microsoft' ? f.directory.trim() : undefined,
    issuer: p === 'oidc' ? f.issuer.trim() : undefined,
    clientId: f.clientId.trim(),
    clientSecret: f.clientSecret.trim() || undefined,
    domains: f.domains.split(/[\s,]+/).filter(Boolean),
    autoProvision: f.autoProvision,
    defaultRole: f.defaultRole,
    requireSso: f.requireSso,
    enabled: f.enabled,
  };
  const save = () => run('s', () => (existing ? api('PATCH', `/v1/admin/sso/${connection.id}`, body) : api('POST', '/v1/admin/sso', body)).then(onSaved), 'Single sign-on saved');
  const test = () =>
    run('t', async () => {
      const r = await api<{ url: string }>('POST', '/v1/auth/sso/start', { connectionId: connection.id });
      window.open(r.url, '_blank', 'noopener');
    });
  return (
    <Modal
      wide
      title={existing ? connection.name! : `Sign in with ${PROVIDER_NAMES[p]}`}
      onClose={onClose}
      footer={
        <>
          {existing && (
            <Button variant="ghost" style={{ marginRight: 'auto' }} loading={busy === 't'} onClick={() => void test()} title="Opens the provider's sign-in in a new tab">
              Test sign-in
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 's'} disabled={!f.clientId || (!existing && !f.clientSecret) || !f.domains.trim() || (p === 'microsoft' && !f.directory) || (p === 'oidc' && !f.issuer)} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Callout tone="info" title={`Set it up in ${p === 'google' ? 'Google' : p === 'microsoft' ? 'Microsoft Entra' : 'your provider'} (about five minutes)`}>
          <ol style={{ margin: '4px 0 0', paddingLeft: 18, display: 'grid', gap: 4 }}>
            {guide.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </Callout>
        <Field label="Redirect address" help="Paste exactly this into the provider. It must match FBRX Command's public https:// address.">
          <CopyText value={callbackUrl} />
        </Field>
        {p === 'microsoft' && (
          <Field label="Directory (tenant) ID">
            <Input className="mono" value={f.directory} onChange={(e) => setF({ ...f, directory: e.target.value })} placeholder="00000000-0000-0000-0000-000000000000" />
          </Field>
        )}
        {p === 'oidc' && (
          <Field label="Issuer URL">
            <Input className="mono" value={f.issuer} onChange={(e) => setF({ ...f, issuer: e.target.value })} placeholder="https://id.example.com" />
          </Field>
        )}
        <div className="fx-row">
          <Field label={guide.idLabel}>
            <Input className="mono" value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })} />
          </Field>
          <Field label={guide.secretLabel} help={existing ? 'Leave empty to keep the current secret' : 'Stored encrypted; never shown again'}>
            <Input type="password" className="mono" value={f.clientSecret} onChange={(e) => setF({ ...f, clientSecret: e.target.value })} autoComplete="off" />
          </Field>
        </div>
        <div className="fx-row">
          <Field label="Email domains" help="Only addresses at these domains can sign in this way. Separate several with commas.">
            <Input value={f.domains} onChange={(e) => setF({ ...f, domains: e.target.value })} placeholder="school.org" />
          </Field>
          <Field label="Button name (optional)">
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={PROVIDER_NAMES[p]} />
          </Field>
        </div>
        <Toggle checked={f.autoProvision} onChange={(v) => setF({ ...f, autoProvision: v })} label="Let new people in on their first sign-in (otherwise invite them under Users first)" />
        {f.autoProvision && (
          <Field label="Their role" help={ROLE_HELP[f.defaultRole]}>
            <Select value={f.defaultRole} onChange={(e) => setF({ ...f, defaultRole: e.target.value })} options={['viewer', 'operator', 'admin']} />
          </Field>
        )}
        <Toggle checked={f.requireSso} onChange={(v) => setF({ ...f, requireSso: v })} label="Require single sign-on (passwords stop working, except for owners, so there is always a way back in)" />
        {existing && <Toggle checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label="Turned on" />}
      </div>
    </Modal>
  );
}
