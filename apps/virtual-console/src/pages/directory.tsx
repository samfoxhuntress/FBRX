import { useState } from 'react';
import {
  DIRECTORY_ADMINS,
  directoryPasswordProblem,
  directoryRulesWords,
  directoryUserProblem,
  type DirectoryComputer,
  type DirectoryGroup,
  type DirectoryJoinCode,
  type DirectoryRules,
  type DirectoryStatus,
  type DirectoryUser,
} from '@fbrx/shared';
import { Button, Callout, Card, CopyText, Empty, Field, formatDate, Input, Modal, Page, Status, Table, timeAgo, Toggle, useAction, useConfirm } from '@fbrx/ui';
import { api } from '../api';
import { useApp, usePoll, useRoute } from '../state';

const OS_WORDS: Record<DirectoryComputer['os'], string> = { windows: 'Windows', mac: 'macOS', linux: 'Linux' };

/**
 * The FBRX directory (the directory role): the same accounts on every computer that joins. People, their groups
 * (administrators makes them administrators of their computers), which computers they get an account on, the
 * password rules, and the computers that joined with their join codes.
 */
export function DirectoryPage() {
  const [, go] = useRoute();
  const st = usePoll<DirectoryStatus | { enabled: false }>('/v1/directory', 5000);
  if (st.data && !st.data.enabled)
    return (
      <Page title="Directory">
        <Card title="The FBRX directory is not on this server">
          <p className="fx-secondary">Keep the same accounts on every computer: who has one, who is an administrator, and the password rules. Computers join with a code, and FBRX OS on each applies the changes.</p>
          <div className="fx-actions">
            <Button variant="primary" icon="layers" onClick={() => go('roles')}>
              Add it in Roles
            </Button>
          </div>
        </Card>
      </Page>
    );
  const s = st.data as DirectoryStatus | null;
  return (
    <Page title="Directory" description="The same accounts on every computer that joins: people, groups, administrators and password rules.">
      {!s ? (
        st.error ? <Callout tone="critical" title="The directory does not answer">{st.error}</Callout> : <Empty title="Loading…" />
      ) : (
        <>
          <People s={s} reload={st.reload} />
          <Groups s={s} reload={st.reload} />
          <Computers s={s} reload={st.reload} />
          <Rules s={s} reload={st.reload} />
        </>
      )}
    </Page>
  );
}

function computersWords(u: DirectoryUser, s: DirectoryStatus): string {
  if (u.computers === 'all') return 'Every computer';
  const names = u.computers.map((id) => s.computers.find((c) => c.id === id)?.name).filter(Boolean);
  return names.length ? names.join(', ') : 'None yet';
}

function People({ s, reload }: { s: DirectoryStatus; reload: () => Promise<void> }) {
  const app = useApp();
  const [editing, setEditing] = useState<DirectoryUser | 'new' | null>(null);
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  return (
    <Card
      title="People"
      subtitle="Each gets an account on the computers you pick. Computers set the first password once; the person changes it when they first sign in, and from then on it is that computer's own."
      flush
      actions={
        app.can('admin') ? (
          <Button size="sm" variant="primary" icon="plus" onClick={() => setEditing('new')}>
            Add a person
          </Button>
        ) : undefined
      }
    >
      <Table<DirectoryUser>
        rows={s.users}
        rowKey={(u) => u.username}
        columns={[
          { key: 'n', header: 'Account', render: (u) => <span className="time-job-name"><b>{u.username}</b>{u.fullName && <small className="fx-muted">{u.fullName}</small>}</span> },
          { key: 'g', header: 'Groups', render: (u) => (u.groups.length ? u.groups.map((g) => (g === DIRECTORY_ADMINS ? 'Administrators' : g)).join(', ') : <span className="fx-muted">None</span>) },
          { key: 'c', header: 'Computers', render: (u) => computersWords(u, s) },
          { key: 's', header: 'State', render: (u) => (u.enabled ? <Status tone="good">Can sign in</Status> : <Status tone="warning">Disabled</Status>) },
          {
            key: 'a',
            header: '',
            width: 96,
            render: (u) =>
              app.can('admin') && (
                <div className="fx-actions" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                  <Button size="sm" variant="ghost" icon="edit" aria-label={`Change ${u.username}`} onClick={() => setEditing(u)} />
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    aria-label={`Remove ${u.username}`}
                    loading={busy === `d:${u.username}`}
                    onClick={async () => {
                      if (await confirm({ title: `Remove ${u.username} from the directory?`, body: 'Computers disable the account and keep it, with its files. Nothing is deleted.', confirmLabel: 'Remove', danger: true }))
                        void run(`d:${u.username}`, () => api('DELETE', `/v1/directory/users/${u.username}`).then(reload), 'Removed: computers disable the account');
                    }}
                  />
                </div>
              ),
          },
        ]}
        empty={<Empty title="Nobody yet">Add each person who signs in to your computers.</Empty>}
      />
      {editing && <PersonDialog user={editing === 'new' ? null : editing} s={s} onClose={() => setEditing(null)} reload={reload} />}
      {dialog}
    </Card>
  );
}

function PersonDialog({ user, s, onClose, reload }: { user: DirectoryUser | null; s: DirectoryStatus; onClose: () => void; reload: () => Promise<void> }) {
  const [username, setUsername] = useState(user?.username ?? '');
  const [fullName, setFullName] = useState(user?.fullName ?? '');
  const [groups, setGroups] = useState<string[]>(user?.groups ?? []);
  const [all, setAll] = useState(user ? user.computers === 'all' : true);
  const [picked, setPicked] = useState<string[]>(user && user.computers !== 'all' ? user.computers : []);
  const [enabled, setEnabled] = useState(user?.enabled ?? true);
  const [password, setPassword] = useState('');
  const { run, busy } = useAction();
  const name = username.trim().toLowerCase();
  const nameProblem = user ? null : name ? directoryUserProblem(name) : null;
  const pwProblem = password ? directoryPasswordProblem(password, s.rules) : user ? null : 'Give a first password';
  const save = () =>
    void run(
      'save',
      () =>
        (user
          ? api('PUT', `/v1/directory/users/${user.username}`, { fullName, groups, computers: all ? 'all' : picked, enabled, ...(password ? { password } : {}) })
          : api('POST', '/v1/directory/users', { username: name, fullName, groups, computers: all ? 'all' : picked, enabled, password })
        ).then(() => (onClose(), reload())),
      user ? 'Saved: computers apply it' : 'Added: computers make the account',
    );
  return (
    <Modal
      title={user ? `Change ${user.username}` : 'Add a person'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 'save'} disabled={!!nameProblem || !name || !!pwProblem} onClick={save}>
            {user ? 'Save' : 'Add'}
          </Button>
        </>
      }
    >
      <div className="fx-form">
        {!user && (
          <Field label="Account name" error={nameProblem ?? undefined} help="What they type to sign in: small letters, numbers, - or _ (up to 20).">
            <Input value={username} maxLength={20} autoFocus onChange={(e) => setUsername(e.target.value)} placeholder="jane" />
          </Field>
        )}
        <Field label="Full name">
          <Input value={fullName} maxLength={64} onChange={(e) => setFullName(e.target.value)} placeholder="Jane Doe" />
        </Field>
        <Field
          label={user ? 'New first password' : 'First password'}
          error={password && pwProblem ? pwProblem : undefined}
          help={user ? (user.passwordWaiting ? 'Leave it empty to keep the one waiting. A new one is set on each computer, and they change it at their next sign-in.' : 'Leave it empty to keep theirs.') : `Each computer sets it once and asks them to change it. ${directoryRulesWords(s.rules)[0]}.`}
        >
          <Input type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Groups" help="Administrators makes them an administrator of their computers.">
          <div className="files-who">
            {s.groups.map((g) => (
              <Toggle key={g.name} checked={groups.includes(g.name)} onChange={(on) => setGroups(on ? [...groups, g.name] : groups.filter((x) => x !== g.name))} label={g.builtIn ? 'Administrators' : g.name} />
            ))}
          </div>
        </Field>
        <Field label="Computers">
          <Toggle checked={all} onChange={setAll} label="Every computer in the directory, and those that join later" />
          {!all && (
            <div className="files-who" style={{ marginTop: 8 }}>
              {s.computers.length ? s.computers.map((c) => <Toggle key={c.id} checked={picked.includes(c.id)} onChange={(on) => setPicked(on ? [...picked, c.id] : picked.filter((x) => x !== c.id))} label={c.name} />) : <span className="fx-muted">No computer has joined yet.</span>}
            </div>
          )}
        </Field>
        {user && <Toggle checked={enabled} onChange={setEnabled} label={enabled ? 'Can sign in' : 'Disabled: the account and its files stay, nobody can sign in'} />}
      </div>
    </Modal>
  );
}

function Groups({ s, reload }: { s: DirectoryStatus; reload: () => Promise<void> }) {
  const app = useApp();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  return (
    <Card title="Groups" subtitle="Each group is made on the computers, with its members in it, for folders and apps that go by group. Administrators is built in." flush>
      <Table<DirectoryGroup>
        rows={s.groups}
        rowKey={(g) => g.name}
        columns={[
          { key: 'n', header: 'Group', render: (g) => <span className="time-job-name"><b>{g.builtIn ? 'Administrators' : g.name}</b>{g.description && <small className="fx-muted">{g.description}</small>}</span> },
          { key: 'm', header: 'Members', render: (g) => s.users.filter((u) => u.groups.includes(g.name)).map((u) => u.username).join(', ') || <span className="fx-muted">Nobody</span> },
          {
            key: 'a',
            header: '',
            width: 60,
            render: (g) =>
              app.can('admin') &&
              !g.builtIn && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  aria-label={`Remove ${g.name}`}
                  loading={busy === `g:${g.name}`}
                  onClick={async () => {
                    if (await confirm({ title: `Remove the group ${g.name}?`, body: 'Its members leave it on their computers. The group itself stays on them, with whatever permissions it has.', confirmLabel: 'Remove', danger: true }))
                      void run(`g:${g.name}`, () => api('DELETE', `/v1/directory/groups/${g.name}`).then(reload), 'Group removed');
                  }}
                />
              ),
          },
        ]}
      />
      {app.can('admin') && (
        <div className="fx-actions files-add">
          <Input value={name} placeholder="Group name" aria-label="Group name" maxLength={32} onChange={(e) => setName(e.target.value)} style={{ width: 180 }} />
          <Input value={description} placeholder="What it is for (optional)" aria-label="Description" maxLength={64} onChange={(e) => setDescription(e.target.value)} style={{ width: 260 }} />
          <Button icon="plus" loading={busy === 'add'} disabled={!name.trim()} onClick={() => void run('add', () => api('POST', '/v1/directory/groups', { name: name.trim().toLowerCase(), description }).then(() => (setName(''), setDescription(''), reload())), 'Group added')}>
            Add group
          </Button>
        </div>
      )}
      {dialog}
    </Card>
  );
}

function appliedWords(c: DirectoryComputer, version: number) {
  if (!c.applied) return <Status tone="warning">Not applied yet</Status>;
  if (!c.applied.ok) return <span title={c.applied.problems.join('\n')}><Status tone="critical">{c.applied.problems[0] ?? 'Did not apply'}</Status></span>;
  if (c.applied.version < version) return <Status tone="warning">Changes waiting</Status>;
  return c.applied.problems.length ? <span title={c.applied.problems.join('\n')}><Status tone="warning">Up to date, with {c.applied.problems.length} note{c.applied.problems.length === 1 ? '' : 's'}</Status></span> : <Status tone="good">Up to date</Status>;
}

function Computers({ s, reload }: { s: DirectoryStatus; reload: () => Promise<void> }) {
  const app = useApp();
  const [code, setCode] = useState<{ code: DirectoryJoinCode; value: string } | null>(null);
  const [making, setMaking] = useState(false);
  const [label, setLabel] = useState('');
  const [uses, setUses] = useState('1');
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  return (
    <Card
      title="Computers"
      subtitle="A computer joins with a join code, in FBRX OS: Settings, Directory. Someone with administrator rights on it applies the directory's changes there (the system asks for their password)."
      flush
      actions={
        app.can('admin') ? (
          <Button size="sm" variant="primary" icon="key" onClick={() => (setMaking(true), setLabel(''), setUses('1'))}>
            New join code
          </Button>
        ) : undefined
      }
    >
      <Table<DirectoryComputer>
        rows={s.computers}
        rowKey={(c) => c.id}
        columns={[
          { key: 'n', header: 'Computer', render: (c) => <span className="time-job-name"><b>{c.name}</b><small className="fx-muted">{OS_WORDS[c.os]}</small></span> },
          { key: 'a', header: 'Accounts', render: (c) => appliedWords(c, s.version) },
          { key: 'l', header: 'Last seen', render: (c) => (c.lastSeenAt ? <span title={formatDate(c.lastSeenAt)}>{timeAgo(c.lastSeenAt)}</span> : '—') },
          {
            key: 'x',
            header: '',
            width: 60,
            render: (c) =>
              app.can('admin') && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  aria-label={`Remove ${c.name}`}
                  loading={busy === `c:${c.id}`}
                  onClick={async () => {
                    if (await confirm({ title: `Remove ${c.name} from the directory?`, body: 'It stops getting changes. The accounts on it stay as they are.', confirmLabel: 'Remove', danger: true }))
                      void run(`c:${c.id}`, () => api('DELETE', `/v1/directory/computers/${c.id}`).then(reload), 'Computer removed');
                  }}
                />
              ),
          },
        ]}
        empty={<Empty title="No computers yet">Make a join code, then join each computer with it in FBRX OS (Settings, Directory).</Empty>}
      />
      {s.codes.length > 0 && (
        <div className="files-add">
          <b>Join codes</b>
          {s.codes.map((c) => (
            <div key={c.id} className="fx-actions" style={{ justifyContent: 'space-between' }}>
              <span>
                {c.label || 'Join code'} <span className="fx-muted">· {c.usesLeft} use{c.usesLeft === 1 ? '' : 's'} left · until {formatDate(c.expiresAt)}</span>
              </span>
              {app.can('admin') && (
                <Button size="sm" variant="ghost" icon="trash" aria-label="Remove this join code" loading={busy === `k:${c.id}`} onClick={() => void run(`k:${c.id}`, () => api('DELETE', `/v1/directory/codes/${c.id}`).then(reload), 'Join code removed')} />
              )}
            </div>
          ))}
        </div>
      )}
      {making && (
        <Modal
          title="New join code"
          onClose={() => setMaking(false)}
          footer={
            <>
              <Button onClick={() => setMaking(false)}>Cancel</Button>
              <Button
                variant="primary"
                loading={busy === 'code'}
                onClick={() =>
                  void run('code', async () => {
                    const made = await api<{ code: DirectoryJoinCode; value: string }>('POST', '/v1/directory/codes', { label, uses: Math.min(Math.max(Number(uses) || 1, 1), 500), days: 7 });
                    setMaking(false);
                    setCode(made);
                    await reload();
                  })
                }
              >
                Make it
              </Button>
            </>
          }
        >
          <div className="fx-form">
            <Field label="Label" help="Where it is for, so you know it in the list.">
              <Input value={label} maxLength={64} onChange={(e) => setLabel(e.target.value)} placeholder="Front office" />
            </Field>
            <Field label="Computers it joins" help="It works for a week.">
              <Input value={uses} inputMode="numeric" onChange={(e) => setUses(e.target.value.replace(/\D/g, '').slice(0, 3))} style={{ width: 90 }} />
            </Field>
          </div>
        </Modal>
      )}
      {code && (
        <Modal title="Join code" onClose={() => setCode(null)} footer={<Button variant="primary" onClick={() => setCode(null)}>Done</Button>}>
          <p className="fx-secondary">In FBRX OS on each computer: Settings, Directory. Pick this server (save it there first and trust its certificate), then type this code. It is shown only now.</p>
          <CopyText value={code.value} />
          {s.certificate && (
            <p className="fx-secondary">
              When the computer saves this server, it shows a certificate fingerprint: it must be this one.
              <br />
              <span className="mono" style={{ wordBreak: 'break-all' }}>{s.certificate}</span>
            </p>
          )}
          <p className="fx-muted">
            Joins {code.code.usesLeft} computer{code.code.usesLeft === 1 ? '' : 's'}, until {formatDate(code.code.expiresAt)}.
          </p>
        </Modal>
      )}
      {dialog}
    </Card>
  );
}

function Rules({ s, reload }: { s: DirectoryStatus; reload: () => Promise<void> }) {
  const app = useApp();
  const [name, setName] = useState(s.name);
  const [r, setR] = useState<DirectoryRules>(s.rules);
  const { run, busy } = useAction();
  const num = (k: keyof DirectoryRules, v: string) => setR({ ...r, [k]: Number(v.replace(/\D/g, '').slice(0, 4)) || 0 });
  const changed = name !== s.name || JSON.stringify(r) !== JSON.stringify(s.rules);
  return (
    <Card title="Password rules" subtitle="Each computer applies them as its own rules. Windows keeps at most 14 as its fewest characters; a computer that is also in a Windows domain follows the domain's.">
      <div className="fx-form">
        <Field label="The directory's name" help="Shown on the computers that join.">
          <Input value={name} maxLength={80} disabled={!app.can('admin')} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 320 }} />
        </Field>
        <Field label="Fewest characters">
          <Input value={String(r.minLength)} inputMode="numeric" disabled={!app.can('admin')} onChange={(e) => num('minLength', e.target.value)} style={{ width: 90 }} />
        </Field>
        <Toggle checked={r.complex} disabled={!app.can('admin')} onChange={(complex) => setR({ ...r, complex })} label="Capitals, small letters and numbers" />
        <Field label="Days before a password must change" help="0: never. Forced changes make people pick weaker passwords; most advice is to change only after a leak.">
          <Input value={String(r.maxAgeDays)} inputMode="numeric" disabled={!app.can('admin')} onChange={(e) => num('maxAgeDays', e.target.value)} style={{ width: 90 }} />
        </Field>
        <Field label="Wrong passwords in a row before the account waits" help="0: no lockout.">
          <Input value={String(r.lockoutAttempts)} inputMode="numeric" disabled={!app.can('admin')} onChange={(e) => num('lockoutAttempts', e.target.value)} style={{ width: 90 }} />
        </Field>
        {r.lockoutAttempts > 0 && (
          <Field label="Minutes it waits">
            <Input value={String(r.lockoutMinutes)} inputMode="numeric" disabled={!app.can('admin')} onChange={(e) => num('lockoutMinutes', e.target.value)} style={{ width: 90 }} />
          </Field>
        )}
        {app.can('admin') && changed && (
          <div className="fx-actions">
            <Button variant="primary" loading={busy === 'rules'} onClick={() => void run('rules', () => api('PUT', '/v1/directory/settings', { name, rules: r }).then(reload), 'Saved: computers apply it')}>
              Save
            </Button>
            <Button variant="ghost" onClick={() => (setName(s.name), setR(s.rules))}>
              Cancel
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
