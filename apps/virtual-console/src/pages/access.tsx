import { useState } from 'react';
import type { VirtualAuditEntry, VirtualRole, VirtualUser } from '@fbrx/shared';
import { Button, Card, Empty, Field, formatDate, Grid, Input, Modal, Page, Select, Status, Table, Tabs, timeAgo, useAction, useConfirm } from '@fbrx/ui';
import { api } from '../api';
import { useApp, usePoll } from '../state';

const ROLE_WORDS: Record<VirtualRole, string> = { admin: 'Administrator: everything, including the server, BIOS and users', operator: 'Operator: runs virtual machines (create, start, screens, snapshots, ISOs)', viewer: 'Viewer: looks only' };

export function AccessPage() {
  const [tab, setTab] = useState<'users' | 'audit' | 'me'>('users');
  return (
    <Page title="Users & audit" description="Who can sign in to FBRX Virtual, and everything they did.">
      <Tabs active={tab} onChange={setTab} tabs={[{ id: 'users', label: 'Users' }, { id: 'audit', label: 'Audit log' }, { id: 'me', label: 'My password' }]} />
      {tab === 'users' && <Users />}
      {tab === 'audit' && <Audit />}
      {tab === 'me' && <MyPassword />}
    </Page>
  );
}

function Users() {
  const app = useApp();
  const { busy, run } = useAction();
  const { confirm, dialog } = useConfirm();
  const users = usePoll<{ users: VirtualUser[] }>('/v1/users', 30000);
  const [editing, setEditing] = useState<VirtualUser | 'new' | null>(null);
  return (
    <Card title="Users" actions={<Button variant="primary" icon="plus" onClick={() => setEditing('new')}>Add user</Button>} flush>
      <Table
        rows={users.data?.users ?? []}
        rowKey={(u) => u.id}
        empty={<Empty title="Loading…" />}
        columns={[
          { key: 'u', header: 'User', render: (u) => <div><div className="fx-cell-title">{u.name}</div><div className="fx-cell-sub mono">{u.username}</div></div> },
          { key: 'r', header: 'Role', render: (u) => <span className="fx-badge">{u.role}</span> },
          { key: 'l', header: 'Last signed in', render: (u) => (u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'Never') },
          {
            key: 'x',
            header: '',
            render: (u) => (
              <span className="fx-row" style={{ gap: 6 }}>
                <Button size="sm" icon="edit" onClick={() => setEditing(u)}>
                  Edit
                </Button>
                {u.id !== app.me.user.id && (
                  <Button
                    size="sm"
                    variant="danger"
                    icon="trash"
                    aria-label={`Delete ${u.username}`}
                    loading={busy === u.id}
                    onClick={async () => {
                      if (await confirm({ title: `Delete ${u.username}?`, body: 'They are signed out and cannot sign in again.', confirmLabel: 'Delete', danger: true })) await run(u.id, async () => { await api('DELETE', `/v1/users/${u.id}`); await users.reload(); });
                    }}
                  />
                )}
              </span>
            ),
          },
        ]}
      />
      {editing && <UserModal user={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={() => void users.reload()} />}
      {dialog}
    </Card>
  );
}

function UserModal({ user, onClose, onDone }: { user: VirtualUser | null; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [username, setUsername] = useState(user?.username ?? '');
  const [name, setName] = useState(user?.name ?? '');
  const [role, setRole] = useState<VirtualRole>(user?.role ?? 'operator');
  const [password, setPassword] = useState('');
  const save = () =>
    run('save', async () => {
      if (user) await api('PATCH', `/v1/users/${user.id}`, { name, role, ...(password ? { password } : {}) });
      else await api('POST', '/v1/users', { username, name, role, password });
      onDone();
      onClose();
    }, user ? 'Saved' : `${username} added`);
  return (
    <Modal
      title={user ? `Edit ${user.username}` : 'Add a user'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 'save'} disabled={(!user && (!username || password.length < 10)) || (!!password && password.length < 10)} onClick={() => void save()}>
            {user ? 'Save' : 'Add user'}
          </Button>
        </>
      }
    >
      <div className="fx-form">
        {!user && (
          <Field label="Username">
            <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
          </Field>
        )}
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value as VirtualRole)} options={(['admin', 'operator', 'viewer'] as const).map((r) => ({ value: r, label: ROLE_WORDS[r] }))} />
        </Field>
        <Field label={user ? 'New password (leave empty to keep)' : 'Password'} help="At least 10 characters. Changing it signs them out everywhere.">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
      </div>
    </Modal>
  );
}

function Audit() {
  const log = usePoll<{ entries: VirtualAuditEntry[] }>('/v1/audit?limit=300', 15000);
  return (
    <Card flush>
      <Table
        rows={log.data?.entries ?? []}
        rowKey={(e) => e.id}
        empty={<Empty title="Nothing yet" />}
        columns={[
          { key: 'a', header: 'When', render: (e) => <span title={formatDate(e.at)}>{timeAgo(e.at)}</span> },
          { key: 'w', header: 'Who', render: (e) => e.actor },
          { key: 'd', header: 'What', render: (e) => <span className="mono">{e.action}</span> },
          { key: 't', header: 'On', render: (e) => e.target ?? '—' },
          { key: 'o', header: '', render: (e) => <Status tone={e.outcome === 'success' ? 'good' : 'critical'}>{e.outcome === 'success' ? 'Done' : 'Failed'}</Status> },
          { key: 'x', header: 'Details', render: (e) => <span className="fx-cell-sub mono vt-details">{e.details ?? ''}</span> },
        ]}
      />
    </Card>
  );
}

function MyPassword() {
  const { busy, run } = useAction();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  return (
    <Grid cols={2}>
      <Card title="Change my password" subtitle="Signs you out on every other browser.">
        <div className="fx-form">
          <Field label="Current password">
            <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          </Field>
          <Field label="New password" help="At least 10 characters.">
            <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </Field>
          <Button variant="primary" disabled={!current || next.length < 10} loading={busy === 'pw'} onClick={() => void run('pw', async () => { await api('POST', '/v1/auth/password', { current, next }); setCurrent(''); setNext(''); }, 'Password changed')}>
            Change password
          </Button>
        </div>
      </Card>
    </Grid>
  );
}
