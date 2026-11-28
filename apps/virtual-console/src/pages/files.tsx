import { useState } from 'react';
import { describeSchedule, MESH_TRAFFIC_CLASS_WORDS, MESH_TRAFFIC_CLASSES, placeWords, WEEKDAYS, type FilesBackup, type FilesMode, type FilesPlace, type FilesStatus, type FileShare, type MeshTrafficClass, type VmSummary } from '@fbrx/shared';
import { Button, Callout, Card, CopyText, Empty, Field, formatBytes, formatDate, Input, KeyValue, Modal, Page, Select, Status, Table, timeAgo, Toggle, useAction, useConfirm } from '@fbrx/ui';
import { api } from '../api';
import { useApp, usePoll, useRoute } from '../state';
import { AskAiButton, describeFor } from '../ask-ai';

const MODE_WORDS: Record<FilesMode, string> = { off: 'Off', host: 'This server', vm: 'A virtual machine' };
const unc = (host: string, share: string) => `\\\\${host}\\${share}`;

/**
 * The file server (the files role): shared folders for your network, served by this server itself or by one of its
 * virtual machines, with priority for their traffic and backups to another device such as a NAS.
 */
export function FilesPage() {
  const [, go] = useRoute();
  const st = usePoll<FilesStatus | { enabled: false }>('/v1/files', 4000);
  if (st.data && !st.data.enabled)
    return (
      <Page title="File server">
        <Card title="The file server is not on this server">
          <p className="fx-secondary">Share folders with your network from this server, or make one of its virtual machines the file server. Either way its traffic can go first, and its files are backed up to a NAS or another server on a schedule.</p>
          <div className="fx-actions">
            <Button variant="primary" icon="layers" onClick={() => go('roles')}>
              Add it in Roles
            </Button>
          </div>
        </Card>
      </Page>
    );
  const s = st.data as FilesStatus | null;
  return (
    <Page title="File server" description="Shared folders for your network, priority for their traffic, and backups to another device.">
      {!s ? (
        st.error ? <Callout tone="critical" title="The file server does not answer">{st.error}</Callout> : <Empty title="Loading…" />
      ) : (
        <>
          {s.simulated && <Callout tone="info" title="Simulated">This computer pretends: shares and backups are folders in FBRX Virtual’s data folder, and nothing is shared on the network.</Callout>}
          <Where s={s} reload={st.reload} />
          {s.mode === 'host' && <Shares s={s} reload={st.reload} />}
          {s.mode === 'host' && <Accounts s={s} reload={st.reload} />}
          {s.mode !== 'off' && <Priority s={s} reload={st.reload} />}
          <Backups s={s} reload={st.reload} />
        </>
      )}
    </Page>
  );
}

function Where({ s, reload }: { s: FilesStatus; reload: () => Promise<void> }) {
  const app = useApp();
  const [, go] = useRoute();
  const vms = usePoll<{ vms: VmSummary[] }>(app.has('virtual') ? '/v1/vms' : null, 30000);
  const [mode, setMode] = useState<FilesMode>(s.mode);
  const [vmId, setVmId] = useState(s.vm?.vmId ?? '');
  const [address, setAddress] = useState(s.vm?.addressSet ? (s.vm.address ?? '') : '');
  const { run, busy } = useAction();
  const machines = vms.data?.vms ?? [];
  const changed = mode !== s.mode || (mode === 'vm' && (vmId !== (s.vm?.vmId ?? '') || address !== (s.vm?.addressSet ? (s.vm.address ?? '') : '')));
  const save = () => void run('mode', () => api('PUT', '/v1/files/mode', { mode, ...(mode === 'vm' ? { vmId: vmId || machines[0]?.id, address: address.trim() || null } : {}) }).then(reload), mode === 'off' ? 'The file server is off' : 'Saved');
  return (
    <Card
      title="Where it serves from"
      subtitle="This server shares folders itself, or one of its virtual machines is the file server (a NAS system, Windows Server, any machine that shares folders): FBRX gives its traffic priority and backs it up."
      actions={
        <AskAiButton
          what="this server's file server"
          question="Here is how the file server on my FBRX Server is set up. Is anything wrong or missing, and what would you change?"
          details={() =>
            describeFor({
              mode: MODE_WORDS[s.mode],
              samba: s.mode === 'host' ? (s.host.ready ? 'running' : s.host.why) : undefined,
              vm: s.vm ? `${s.vm.name}, ${s.vm.running ? 'running' : 'not running'}, address ${s.vm.address ?? 'unknown'}, starts with the server: ${s.vm.autostart ? 'yes' : 'no'}` : undefined,
              shares: s.shares.map((x) => `${x.name}${x.readOnly ? ' (read only)' : ''}: ${x.accounts.length ? x.accounts.join(', ') : 'every account'}`),
              accounts: s.accounts.map((a) => a.name),
              priority: s.priority.enabled ? `${s.priority.trafficClass}, ${s.priority.applied ? 'in place' : 'not in place'}` : 'off',
              backups: s.backups.map((b) => `${b.name}: ${b.enabled ? describeSchedule(b.schedule, b.time, b.day) : 'paused'} to ${placeWords(b.destination)}, last ${b.last ? `${b.last.state} (${b.last.detail})` : 'never'}`),
              gate: s.gate.present ? (s.gate.open === false ? 'your networks cannot reach the shares on the gate' : 'open to your networks') : undefined,
            })
          }
        />
      }
    >
      <div className="fx-form">
        <Field label="The file server is">
          <div className="fx-actions" role="radiogroup">
            {(['off', 'host', 'vm'] as FilesMode[]).map((m) => (
              <Button key={m} size="sm" variant={mode === m ? 'primary' : undefined} disabled={!app.can('admin') || (m === 'vm' && !app.has('virtual'))} aria-pressed={mode === m} onClick={() => setMode(m)}>
                {MODE_WORDS[m]}
              </Button>
            ))}
          </div>
        </Field>
        {mode === 'vm' && (
          <>
            <Field label="Virtual machine" help={machines.length ? undefined : 'There are no virtual machines on this server yet.'}>
              <Select style={{ maxWidth: 420 }} value={vmId || machines[0]?.id || ''} disabled={!app.can('admin')} onChange={(e) => setVmId(e.target.value)} options={machines.map((v) => ({ value: v.id, label: `${v.name}${v.ip ? ` (${v.ip})` : ''}` }))} />
            </Field>
            <Field label="Its address" help="Leave it empty to use the one the machine reports (its guest agent or DHCP). Type one when the machine has a fixed address on your network.">
              <Input value={address} placeholder="192.168.1.20" disabled={!app.can('admin')} onChange={(e) => setAddress(e.target.value)} style={{ width: 200 }} />
            </Field>
          </>
        )}
        {app.can('admin') && changed && (
          <div className="fx-actions">
            <Button variant="primary" loading={busy === 'mode'} disabled={mode === 'vm' && !machines.length} onClick={save}>
              Save
            </Button>
            <Button variant="ghost" onClick={() => setMode(s.mode)}>
              Cancel
            </Button>
          </div>
        )}
      </div>
      {s.mode === 'host' && mode === 'host' &&
        (s.host.ready ? (
          <KeyValue
            items={[
              ['Serving', <Status tone="good">Shares on {s.host.address}</Status>],
              ['Folders', <span className="mono">{s.host.root}</span>],
            ]}
          />
        ) : (
          <Callout tone="warning" title="Samba is not ready">{s.host.why}</Callout>
        ))}
      {s.mode === 'vm' && mode === 'vm' && s.vm && (
        <KeyValue
          items={[
            ['Machine', <>{s.vm.name} {s.vm.running === null ? <Status tone="critical">gone</Status> : s.vm.running ? <Status tone="good">running</Status> : <Status tone="warning">not running</Status>}</>],
            ['Address', s.vm.address ? <span className="mono">{s.vm.address}{s.vm.addressSet ? ' (typed in)' : ''}</span> : <span className="fx-muted">Not known yet: start it, or type its address</span>],
            [
              'Starts with the server',
              <Toggle checked={!!s.vm.autostart} disabled={!app.can('admin') || s.vm.running === null} onChange={(on) => void run('auto', () => api('PUT', '/v1/files/vm/autostart', { on }).then(reload), on ? 'It starts with the server' : 'It no longer starts with the server')} label={s.vm.autostart ? 'Yes' : 'No: people lose their files after a restart until someone starts it'} />,
            ],
          ]}
        />
      )}
      {s.mode === 'host' && mode === 'host' && s.gate.present && s.gate.open === false && (
        <Callout
          tone="warning"
          title="Your networks cannot reach the shares on this gate yet"
          actions={
            app.can('admin') ? (
              <Button size="sm" variant="primary" loading={busy === 'gate'} onClick={() => void run('gate', () => api<{ added: number }>('POST', '/v1/files/gate').then(() => go('gate-changes')))}>
                Add the firewall rule
              </Button>
            ) : undefined
          }
        >
          The gate’s firewall needs a rule from each of your networks to the gate for TCP 445 (SMB). The button adds it to what you are editing; review it with What If on Changes, then commit.
        </Callout>
      )}
    </Card>
  );
}

function ShareDialog({ share, s, onClose, reload }: { share: FileShare | null; s: FilesStatus; onClose: () => void; reload: () => Promise<void> }) {
  const [name, setName] = useState(share?.name ?? '');
  const [comment, setComment] = useState(share?.comment ?? '');
  const [readOnly, setReadOnly] = useState(share?.readOnly ?? false);
  const [who, setWho] = useState<string[]>(share?.accounts ?? []);
  const { run, busy } = useAction();
  const save = () =>
    void run(
      'save',
      async () => {
        const body = { comment, readOnly, accounts: who };
        if (share) await api('PUT', `/v1/files/shares/${share.name}`, body);
        else await api('POST', '/v1/files/shares', { ...body, name: name.trim().toLowerCase() });
        await reload();
        onClose();
      },
      share ? 'Share saved' : 'Share made',
    );
  return (
    <Modal
      title={share ? `Change ${share.name}` : 'New share'}
      description={share ? undefined : `A folder on this server that people open as ${unc(s.host.address, name.trim().toLowerCase() || 'name')}.`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 'save'} disabled={!share && !name.trim()} onClick={save}>
            {share ? 'Save' : 'Make the share'}
          </Button>
        </>
      }
    >
      <div className="fx-form">
        {!share && (
          <Field label="Name" help="Lowercase letters, digits and dashes.">
            <Input value={name} maxLength={32} placeholder="office" onChange={(e) => setName(e.target.value)} />
          </Field>
        )}
        <Field label="Description" help="Optional; people see it next to the share.">
          <Input value={comment} maxLength={80} onChange={(e) => setComment(e.target.value)} />
        </Field>
        <Toggle checked={readOnly} onChange={setReadOnly} label="Read only (people open and copy files, nobody changes them)" />
        <Field label="Who can open it" help={s.accounts.length ? 'None ticked: every file server account.' : 'Add accounts below first; until then nobody can sign in.'}>
          <div className="files-who">
            {s.accounts.map((a) => (
              <Toggle key={a.name} checked={who.includes(a.name)} onChange={(on) => setWho(on ? [...who, a.name] : who.filter((x) => x !== a.name))} label={a.name} />
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  );
}

function Shares({ s, reload }: { s: FilesStatus; reload: () => Promise<void> }) {
  const app = useApp();
  const [editing, setEditing] = useState<FileShare | 'new' | null>(null);
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  return (
    <Card
      title="Shares"
      subtitle="Folders people open from their computers over the network (Windows, macOS and Linux all speak SMB). Each share is a folder under the file server’s folder on this server."
      flush
      actions={
        app.can('admin') ? (
          <Button size="sm" variant="primary" icon="plus" onClick={() => setEditing('new')}>
            New share
          </Button>
        ) : undefined
      }
    >
      <Table<FileShare>
        rows={s.shares}
        rowKey={(x) => x.name}
        columns={[
          { key: 'n', header: 'Share', render: (x) => <span className="time-job-name"><b>{x.name}</b>{x.comment && <small className="fx-muted">{x.comment}</small>}</span> },
          { key: 'p', header: 'Open it as', render: (x) => <CopyText value={unc(s.host.address, x.name)} /> },
          { key: 'w', header: 'Who', render: (x) => (x.accounts.length ? x.accounts.join(', ') : <span className="fx-muted">Every account</span>) },
          { key: 'r', header: 'Changes', render: (x) => (x.readOnly ? 'Read only' : 'Read and write') },
          { key: 's', header: 'Size', className: 'num', render: (x) => (x.sizeBytes === null ? '—' : formatBytes(x.sizeBytes)) },
          {
            key: 'a',
            header: '',
            width: 96,
            render: (x) =>
              app.can('admin') && (
                <div className="fx-actions" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                  <Button size="sm" variant="ghost" icon="edit" aria-label={`Change ${x.name}`} onClick={() => setEditing(x)} />
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    aria-label={`Stop sharing ${x.name}`}
                    loading={busy === `d:${x.name}`}
                    onClick={async () => {
                      if (await confirm({ title: `Stop sharing ${x.name}?`, body: `Its files stay in ${x.path} on this server.`, confirmLabel: 'Stop sharing it', danger: true })) void run(`d:${x.name}`, () => api('DELETE', `/v1/files/shares/${x.name}`).then(reload), 'No longer shared');
                    }}
                  />
                </div>
              ),
          },
        ]}
        empty={<Empty title="No shares yet">Make one for each group of files people work on together: office, photos, scans.</Empty>}
      />
      {editing && <ShareDialog share={editing === 'new' ? null : editing} s={s} onClose={() => setEditing(null)} reload={reload} />}
      {dialog}
    </Card>
  );
}

function Accounts({ s, reload }: { s: FilesStatus; reload: () => Promise<void> }) {
  const app = useApp();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [reset, setReset] = useState<string | null>(null);
  const [newPw, setNewPw] = useState('');
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  return (
    <Card title="Accounts" subtitle="People sign in to the shares with these (they cannot sign in to the server itself). Passwords are kept by Samba only: nobody can read them back, so give each person theirs." flush>
      <Table
        rows={s.accounts}
        rowKey={(a) => a.name}
        columns={[
          { key: 'n', header: 'Account', render: (a) => <b>{a.name}</b> },
          { key: 's', header: 'Shares', render: (a) => s.shares.filter((x) => !x.accounts.length || x.accounts.includes(a.name)).map((x) => x.name).join(', ') || '—' },
          { key: 'c', header: 'Made', render: (a) => <span title={formatDate(a.createdAt)}>{timeAgo(a.createdAt)}</span> },
          {
            key: 'a',
            header: '',
            width: 200,
            render: (a) =>
              app.can('admin') && (
                <div className="fx-actions" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                  <Button size="sm" icon="key" onClick={() => (setReset(a.name), setNewPw(''))}>
                    New password
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    aria-label={`Remove ${a.name}`}
                    onClick={async () => {
                      if (await confirm({ title: `Remove ${a.name}?`, body: 'They can no longer open the shares. Files they made stay.', confirmLabel: 'Remove the account', danger: true })) void run(`d:${a.name}`, () => api('DELETE', `/v1/files/accounts/${a.name}`).then(reload), 'Account removed');
                    }}
                  />
                </div>
              ),
          },
        ]}
        empty={<Empty title="No accounts yet">Add one for each person (or one shared account for a small office).</Empty>}
      />
      {app.can('admin') && (
        <div className="fx-actions files-add">
          <Input value={name} placeholder="Account name" aria-label="Account name" maxLength={31} onChange={(e) => setName(e.target.value)} style={{ width: 180 }} />
          <Input value={password} type="password" placeholder="Password (8 or more)" aria-label="Password" autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} style={{ width: 220 }} />
          <Button icon="plus" loading={busy === 'add'} disabled={!name.trim() || password.length < 8} onClick={() => void run('add', () => api('POST', '/v1/files/accounts', { name: name.trim().toLowerCase(), password }).then(() => (setName(''), setPassword(''), reload())), 'Account added')}>
            Add account
          </Button>
        </div>
      )}
      {reset && (
        <Modal
          title={`New password for ${reset}`}
          onClose={() => setReset(null)}
          footer={
            <>
              <Button onClick={() => setReset(null)}>Cancel</Button>
              <Button variant="primary" loading={busy === 'pw'} disabled={newPw.length < 8} onClick={() => void run('pw', () => api('PUT', `/v1/files/accounts/${reset}/password`, { password: newPw }).then(() => setReset(null)), 'Password changed')}>
                Change it
              </Button>
            </>
          }
        >
          <Field label="Password" help="8 characters or more. Computers that saved the old one ask again.">
            <Input type="password" value={newPw} autoComplete="new-password" onChange={(e) => setNewPw(e.target.value)} />
          </Field>
        </Modal>
      )}
      {dialog}
    </Card>
  );
}

function Priority({ s, reload }: { s: FilesStatus; reload: () => Promise<void> }) {
  const app = useApp();
  const { run, busy } = useAction();
  const p = s.priority;
  const set = (body: { enabled: boolean; trafficClass?: MeshTrafficClass }) => void run('prio', () => api('PUT', '/v1/files/priority', body).then(reload));
  return (
    <Card
      title="Priority for its traffic"
      subtitle={
        s.mode === 'vm'
          ? 'Marks the file server machine’s SMB and NFS traffic as it passes through this server, so switches that honor priority, and FBRX Gate’s traffic shaping, let it go first.'
          : 'Marks what the shares send (SMB and NFS), so switches that honor priority, and FBRX Gate’s traffic shaping, let it go first.'
      }
    >
      <div className="fx-form">
        <Toggle checked={p.enabled} disabled={!app.can('admin') || busy === 'prio'} onChange={(enabled) => set({ enabled })} label="Let its traffic go first" />
        {p.enabled && (
          <>
            <Field label="Priority class" help="AF31 puts file copies ahead of everyday traffic and behind calls and video meetings.">
              <Select style={{ maxWidth: 360 }} value={p.trafficClass} disabled={!app.can('admin')} onChange={(e) => set({ enabled: true, trafficClass: e.target.value as MeshTrafficClass })} options={MESH_TRAFFIC_CLASSES.map((c) => ({ value: c, label: c === 'af31' ? 'AF31: important data (recommended)' : c === 'af41' ? 'AF41: interactive' : MESH_TRAFFIC_CLASS_WORDS[c] }))} />
            </Field>
            <p className="fx-secondary">
              {p.applied === true ? <Status tone="good">In place on this server</Status> : p.applied === false ? <Status tone="warning">Not in place</Status> : <Status tone="neutral">Cannot tell (nftables does not answer)</Status>}{' '}
              {p.applied === false && s.mode === 'vm' && !s.vm?.address ? 'The machine’s address is not known yet: start it, or type its address above.' : null}
            </p>
          </>
        )}
      </div>
    </Card>
  );
}

type PlaceForm = { kind: 'smb' | 'nfs'; path: string; user: string; password: string };
const formOf = (p: FilesPlace | null): PlaceForm => (p ? { kind: p.kind, path: placeWords(p), user: p.kind === 'smb' ? p.user : '', password: '' } : { kind: 'smb', path: '', user: '', password: '' });
const bodyOf = (f: PlaceForm) => (f.kind === 'nfs' ? { kind: 'nfs', path: f.path.trim() } : { kind: 'smb', path: f.path.trim(), user: f.user.trim(), ...(f.password ? { password: f.password } : {}) });

function PlaceFields({ f, set, saved, example }: { f: PlaceForm; set: (f: PlaceForm) => void; saved: boolean; example: string }) {
  return (
    <>
      <div className="time-when">
        <Field label="Kind">
          <Select value={f.kind} onChange={(e) => set({ ...f, kind: e.target.value as PlaceForm['kind'] })} options={[{ value: 'smb', label: 'Shared folder (SMB)' }, { value: 'nfs', label: 'NFS export' }]} />
        </Field>
        <Field label="Path">
          <Input value={f.path} placeholder={f.kind === 'smb' ? example : 'nas:/volume1/backups'} onChange={(e) => set({ ...f, path: e.target.value })} />
        </Field>
      </div>
      {f.kind === 'smb' && (
        <div className="time-when">
          <Field label="Account">
            <Input value={f.user} placeholder="backup" autoComplete="off" onChange={(e) => set({ ...f, user: e.target.value })} />
          </Field>
          <Field label="Password" help={saved ? 'Leave it empty to keep the saved one.' : undefined}>
            <Input type="password" value={f.password} autoComplete="new-password" placeholder={saved ? 'Saved' : ''} onChange={(e) => set({ ...f, password: e.target.value })} />
          </Field>
        </div>
      )}
    </>
  );
}

function BackupDialog({ b, s, onClose, reload }: { b: FilesBackup | null; s: FilesStatus; onClose: () => void; reload: () => Promise<void> }) {
  const [name, setName] = useState(b?.name ?? '');
  const fromShare = b ? b.source.kind === 'share' : s.mode === 'host' && s.shares.length > 0;
  const [sourceKind, setSourceKind] = useState<'share' | 'remote'>(fromShare ? 'share' : 'remote');
  const [share, setShare] = useState(b?.source.kind === 'share' ? b.source.share : (s.shares[0]?.name ?? ''));
  const [source, setSource] = useState<PlaceForm>(b?.source.kind === 'remote' ? formOf(b.source.place) : { ...formOf(null), path: s.vm?.address ? `\\\\${s.vm.address}\\` : '' });
  const [dest, setDest] = useState<PlaceForm>(formOf(b?.destination ?? null));
  const [schedule, setSchedule] = useState<FilesBackup['schedule']>(b?.schedule ?? 'daily');
  const [time, setTime] = useState(b?.time ?? '01:30');
  const [day, setDay] = useState(b?.day ?? 6);
  const [keepDays, setKeepDays] = useState(b?.keepDays ?? 30);
  const { run, busy } = useAction();
  const save = () =>
    void run(
      'save',
      async () => {
        const body = { name: name.trim(), source: sourceKind === 'share' ? { kind: 'share', share } : { kind: 'remote', place: bodyOf(source) }, destination: bodyOf(dest), schedule, time, day, keepDays };
        if (b) await api('PUT', `/v1/files/backups/${b.id}`, body);
        else await api('POST', '/v1/files/backups', body);
        await reload();
        onClose();
      },
      b ? 'Backup saved' : 'Backup made',
    );
  return (
    <Modal
      wide
      title={b ? `Change ${b.name}` : 'New backup'}
      description="Copies the files to another device on a schedule: what changed since last time, into a folder of this backup’s own there. Files that changed or were deleted are kept for a while, so a mistake (or ransomware) can be undone."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 'save'} disabled={!name.trim() || !dest.path.trim()} onClick={save}>
            {b ? 'Save' : 'Make the backup'}
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label="Name">
          <Input value={name} maxLength={80} placeholder="Office, nightly" onChange={(e) => setName(e.target.value)} />
        </Field>
        <h4 className="files-h">Copy from</h4>
        <Select
          value={sourceKind}
          aria-label="Copy from"
          onChange={(e) => setSourceKind(e.target.value as 'share' | 'remote')}
          options={[
            { value: 'share', label: 'A share on this server', disabled: !s.shares.length },
            { value: 'remote', label: s.mode === 'vm' ? 'A folder on the file server machine (or another device)' : 'A folder on another device' },
          ]}
        />
        {sourceKind === 'share' ? (
          <Field label="Share">
            <Select value={share} onChange={(e) => setShare(e.target.value)} options={s.shares.map((x) => x.name)} />
          </Field>
        ) : (
          <PlaceFields f={source} set={setSource} saved={b?.source.kind === 'remote' && b.source.place.kind === 'smb' && b.source.place.hasPassword} example={s.vm?.address ? `\\\\${s.vm.address}\\data` : '\\\\fileserver\\data'} />
        )}
        <h4 className="files-h">Copy to</h4>
        <PlaceFields f={dest} set={setDest} saved={b?.destination.kind === 'smb' && b.destination.hasPassword} example="\\nas\backups" />
        <div className="time-when">
          <Field label="When">
            <Select
              value={schedule}
              onChange={(e) => setSchedule(e.target.value as FilesBackup['schedule'])}
              options={[
                { value: 'daily', label: 'Every day' },
                { value: 'weekly', label: 'Every week' },
                { value: 'off', label: 'Only when I start it' },
              ]}
            />
          </Field>
          {schedule !== 'off' && (
            <Field label="At">
              <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </Field>
          )}
          {schedule === 'weekly' && (
            <Field label="On">
              <Select value={String(day)} onChange={(e) => setDay(Number(e.target.value))} options={WEEKDAYS.map((d, i) => ({ value: String(i), label: d }))} />
            </Field>
          )}
        </div>
        <Field label="Keep changed and deleted files for" help="Days. 0 keeps only the latest copy.">
          <Input type="number" min={0} max={3650} value={keepDays} onChange={(e) => setKeepDays(Math.max(0, Math.min(3650, Number(e.target.value) || 0)))} style={{ width: 120 }} />
        </Field>
      </div>
    </Modal>
  );
}

function RunDialog({ b, onClose }: { b: FilesBackup; onClose: () => void }) {
  const l = b.last!;
  return (
    <Modal
      title={`${b.name}: the last copy`}
      onClose={onClose}
      footer={
        <>
          {l.state === 'failed' && (
            <AskAiButton
              what={`the backup ${b.name}`}
              question="This backup on my FBRX Server's file server failed. What went wrong, and how do I fix it?"
              details={describeFor({ backup: b.name, from: b.source.kind === 'share' ? `share ${b.source.share} on this server` : placeWords(b.source.place), to: placeWords(b.destination), kind: b.destination.kind, error: l.detail, started: l.startedAt })}
            />
          )}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <KeyValue
        items={[
          ['How it went', l.state === 'ok' ? <Status tone="good">Copied</Status> : l.state === 'running' ? <Status tone="busy">Copying…</Status> : <Status tone="critical">Failed</Status>],
          ['Started', formatDate(l.startedAt)],
          ...(l.finishedAt ? ([['Finished', formatDate(l.finishedAt)]] as Array<[string, string]>) : []),
          ...(l.bytes !== null ? ([['Copied', `${l.files ?? 0} files, ${formatBytes(l.bytes)}`]] as Array<[string, string]>) : []),
          ['Details', l.detail],
          ['Where', <span className="mono">{`${placeWords(b.destination)}${b.destination.kind === 'smb' ? '\\' : '/'}${b.folder}`}</span>],
        ]}
      />
      {l.advice && (
        <div className="vt-assist-answer">
          <b>This server's AI: </b>
          {l.advice}
        </div>
      )}
    </Modal>
  );
}

function Backups({ s, reload }: { s: FilesStatus; reload: () => Promise<void> }) {
  const app = useApp();
  const [editing, setEditing] = useState<FilesBackup | 'new' | null>(null);
  const [looking, setLooking] = useState<FilesBackup | null>(null);
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const from = (b: FilesBackup) => (b.source.kind === 'share' ? `${b.source.share} (this server)` : placeWords(b.source.place));
  return (
    <Card
      title="Backups"
      subtitle="Copies of the files on another device, such as a NAS, on a schedule. Each backup keeps a current copy and, for as many days as you choose, the files that changed or were deleted."
      flush
      actions={
        app.can('admin') ? (
          <Button size="sm" variant="primary" icon="plus" onClick={() => setEditing('new')}>
            New backup
          </Button>
        ) : undefined
      }
    >
      <Table<FilesBackup>
        rows={s.backups}
        rowKey={(b) => b.id}
        columns={[
          { key: 'n', header: 'Backup', render: (b) => <span className="time-job-name"><b>{b.name}</b><small className="fx-muted">{from(b)} → {placeWords(b.destination)}</small></span> },
          { key: 'w', header: 'When', render: (b) => (b.enabled ? describeSchedule(b.schedule, b.time, b.day) : 'paused') },
          { key: 'k', header: 'Keeps', render: (b) => (b.keepDays ? `${b.keepDays} days` : 'latest only') },
          {
            key: 'l',
            header: 'Last copy',
            render: (b) =>
              b.last ? (
                <button className="files-last" onClick={() => setLooking(b)} title={b.last.detail}>
                  {b.last.state === 'ok' ? <Status tone="good">done</Status> : b.last.state === 'running' ? <Status tone="busy">{b.last.detail === 'Copying' ? 'copying…' : 'waiting…'}</Status> : <Status tone="critical">failed</Status>} {b.last.state !== 'running' && timeAgo(b.last.finishedAt ?? b.last.startedAt)}
                  {b.last.state === 'failed' && <small className="fx-cell-sub">{b.last.advice ? 'This server’s AI has a look: open it' : b.last.detail}</small>}
                </button>
              ) : (
                'not yet'
              ),
          },
          { key: 'x', header: 'Next', render: (b) => (b.nextAt ? new Date(b.nextAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—') },
          {
            key: 'a',
            header: '',
            width: 240,
            render: (b) => (
              <div className="fx-actions" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                {app.can('operator') &&
                  (b.last?.state === 'running' ? (
                    <Button size="sm" icon="stop" loading={busy === `s:${b.id}`} onClick={() => void run(`s:${b.id}`, () => api('POST', `/v1/files/backups/${b.id}/stop`).then(reload))}>
                      Stop
                    </Button>
                  ) : (
                    <Button size="sm" icon="play" loading={busy === `r:${b.id}`} onClick={() => void run(`r:${b.id}`, () => api('POST', `/v1/files/backups/${b.id}/run`).then(reload), 'Backup started')}>
                      Back up now
                    </Button>
                  ))}
                {app.can('admin') && (
                  <>
                    <Button size="sm" variant="ghost" icon="edit" aria-label={`Change ${b.name}`} onClick={() => setEditing(b)} />
                    <Button size="sm" variant="ghost" icon={b.enabled ? 'stop' : 'play'} aria-label={b.enabled ? 'Pause' : 'Resume'} title={b.enabled ? 'Pause the schedule' : 'Resume the schedule'} onClick={() => void run(`p:${b.id}`, () => api('PUT', `/v1/files/backups/${b.id}`, { enabled: !b.enabled }).then(reload))} />
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="trash"
                      aria-label={`Delete ${b.name}`}
                      onClick={async () => {
                        if (await confirm({ title: `Delete ${b.name}?`, body: `What it copied stays on ${placeWords(b.destination)}.`, confirmLabel: 'Delete the backup', danger: true })) void run(`d:${b.id}`, () => api('DELETE', `/v1/files/backups/${b.id}`).then(reload), 'Backup deleted');
                      }}
                    />
                  </>
                )}
              </div>
            ),
          },
        ]}
        empty={<Empty title="No backups yet">{s.mode === 'off' ? 'Turn the file server on above, or back up a folder on another device.' : 'Copy the files to a NAS or another server every night.'}</Empty>}
      />
      {editing && <BackupDialog b={editing === 'new' ? null : editing} s={s} onClose={() => setEditing(null)} reload={reload} />}
      {looking && <RunDialog b={s.backups.find((x) => x.id === looking.id) ?? looking} onClose={() => setLooking(null)} />}
      {dialog}
    </Card>
  );
}
