import { useState } from 'react';
import type { SnapshotHeader, SnapshotInfo } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Field, Grid, Input, KeyValue, Modal, Page, Table, Toggle, formatBytes, formatDate, useAction, useConfirm } from '@fbrx/ui';
import { bridge, call, pickFile } from '../client';
import { isLocked, useCore } from '../hooks';

export function BackupPage() {
  const list = useCore('backup.list', undefined, ['audit.appended']);
  const settings = useCore('settings.get', undefined, ['settings.changed']);
  const vault = useCore('vault.list', undefined, ['vault.changed']);
  const [creating, setCreating] = useState(false);
  const [restore, setRestore] = useState<{ file: string; header: SnapshotHeader } | null>(null);
  const { confirm, dialog } = useConfirm();
  const { run, busy } = useAction();
  const cfg = settings.data?.settings.backup;
  const locked = settings.data?.locked ?? [];
  const hasPass = (vault.data ?? []).some((s) => s.name === cfg?.passphraseSecret);
  const startRestore = async (file: string) => {
    const header = await run('inspect', () => call('backup.inspect', { file }));
    if (header) setRestore({ file, header });
  };
  return (
    <Page
      title="Backup & restore"
      description="A snapshot captures this whole workstation — settings, credentials, conversations, agent memory, plugins, connections, workspace files and audit log — in one encrypted file. Restore it on any Mac or Windows machine and continue exactly where you left off."
      actions={
        <>
          <Button
            icon="upload"
            onClick={async () => {
              const f = await pickFile({ kind: 'file', title: 'Choose a snapshot to restore', filters: [{ name: 'FBRX snapshot', extensions: ['fbrxsnap'] }] });
              if (f) await startRestore(f);
            }}
          >
            Restore from file…
          </Button>
          <Button variant="primary" icon="archive" onClick={() => setCreating(true)}>
            Create snapshot
          </Button>
        </>
      }
    >
      <Grid cols={2}>
        <Card title="Scheduled backups" subtitle={cfg?.directory || 'Saved in the FBRX data folder'}>
          {cfg && (
            <div className="fx-form">
              <Toggle
                checked={cfg.scheduleEnabled}
                disabled={isLocked(locked, 'backup.scheduleEnabled')}
                onChange={(v) => void run('s', () => call('settings.update', { patch: { backup: { scheduleEnabled: v } } }))}
                label="Back up automatically"
              />
              <div className="fx-row">
                <Field label="Every (hours)">
                  <Input type="number" min={1} value={cfg.intervalHours} disabled={isLocked(locked, 'backup.intervalHours')} onChange={(e) => void call('settings.update', { patch: { backup: { intervalHours: Number(e.target.value) || 24 } } })} />
                </Field>
                <Field label="Keep last">
                  <Input type="number" min={1} value={cfg.retention} disabled={isLocked(locked, 'backup.retention')} onChange={(e) => void call('settings.update', { patch: { backup: { retention: Number(e.target.value) || 7 } } })} />
                </Field>
              </div>
              <Toggle checked={cfg.includeModels} disabled={isLocked(locked, 'backup.includeModels')} onChange={(v) => void call('settings.update', { patch: { backup: { includeModels: v } } })} label="Include downloaded AI models (large)" />
              <div className="fx-actions">
                <Button
                  size="sm"
                  icon="file"
                  disabled={isLocked(locked, 'backup.directory')}
                  onClick={async () => {
                    const d = await pickFile({ kind: 'folder', title: 'Backup folder (e.g. an external drive or synced folder)' });
                    if (d) await run('dir', () => call('settings.update', { patch: { backup: { directory: d } } }), 'Backup folder changed');
                  }}
                >
                  Change folder…
                </Button>
              </div>
              {hasPass ? (
                <Callout tone="good">Unattended backups use the passphrase stored in the vault as <code>{cfg.passphraseSecret}</code>.</Callout>
              ) : (
                <Callout tone="warning" title="Store a backup passphrase">
                  Scheduled backups need a passphrase saved in the vault as <code>{cfg.passphraseSecret}</code>. Use the same passphrase to restore on another machine.
                </Callout>
              )}
            </div>
          )}
        </Card>
        <Card title="Moving to a new computer">
          <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
            <li>Create a snapshot here (or let your organisation back up this device).</li>
            <li>Install FBRX OS on the new Mac or Windows machine.</li>
            <li>Choose <strong>Restore from file</strong>, enter the snapshot passphrase and pick <strong>Migrate</strong>.</li>
            <li>FBRX restarts and everything — credentials included — is back. Your organisation sees the device move to new hardware.</li>
          </ol>
          <p className="fx-secondary" style={{ marginBottom: 0 }}>Use <strong>Clone</strong> instead to set up an additional machine from this one (it enrolls as a new device).</p>
        </Card>
      </Grid>
      <Card flush title="Snapshots">
        <Table
          rows={list.data ?? []}
          rowKey={(s) => s.file}
          empty={<Empty title="No snapshots yet" action={<Button onClick={() => setCreating(true)}>Create the first one</Button>} />}
          columns={[
            { key: 'n', header: 'Snapshot', render: (s: SnapshotInfo) => (<div><div className="fx-cell-title">{s.header?.label ?? 'Snapshot'}</div><div className="fx-cell-sub mono">{s.name}</div></div>) },
            { key: 'd', header: 'Created', render: (s) => (s.header ? formatDate(s.header.createdAt) : <span className="fx-error-text">{s.error}</span>) },
            { key: 'v', header: 'Version', render: (s) => <span className="mono">{s.header?.appVersion ?? '—'}</span> },
            { key: 's', header: 'Size', className: 'num', render: (s) => formatBytes(s.sizeBytes) },
            {
              key: 'x',
              header: '',
              render: (s) => (
                <div className="fx-actions">
                  {bridge.reveal && <Button size="sm" variant="ghost" icon="file" aria-label="Show in folder" onClick={() => void bridge.reveal!(s.file)} />}
                  <Button size="sm" disabled={!s.header} onClick={() => void startRestore(s.file)}>
                    Restore
                  </Button>
                  <Button size="sm" variant="ghost" icon="trash" aria-label="Delete snapshot" onClick={async () => { if (await confirm({ title: 'Delete this snapshot?', danger: true, confirmLabel: 'Delete' })) await run('del', () => call('backup.delete', { file: s.file }).then(list.reload)); }} />
                </div>
              ),
            },
          ]}
        />
      </Card>
      {creating && <CreateSnapshot onClose={() => setCreating(false)} onDone={() => (setCreating(false), list.reload())} defaultIncludeModels={!!cfg?.includeModels} />}
      {restore && <RestoreModal file={restore.file} header={restore.header} onClose={() => setRestore(null)} />}
      {dialog}
      {busy === 'inspect' && null}
    </Page>
  );
}

function CreateSnapshot({ onClose, onDone, defaultIncludeModels }: { onClose: () => void; onDone: () => void; defaultIncludeModels: boolean }) {
  const [f, setF] = useState({ passphrase: '', confirm: '', label: '', includeModels: defaultIncludeModels, save: false });
  const { run, busy } = useAction();
  const ok = f.passphrase.length >= 10 && f.passphrase === f.confirm;
  return (
    <Modal
      title="Create snapshot"
      description="The snapshot is encrypted with this passphrase (AES-256-GCM, scrypt). Without it nobody — including you — can open the file."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy === 'c'}
            disabled={!ok}
            onClick={() =>
              void run(
                'c',
                async () => {
                  if (f.save) await call('vault.set', { name: 'FBRX_BACKUP_PASSPHRASE', value: f.passphrase, kind: 'password', description: 'Backup passphrase' });
                  await call('backup.create', { passphrase: f.passphrase, label: f.label || undefined, includeModels: f.includeModels });
                  onDone();
                },
                'Snapshot created',
              )
            }
          >
            Create snapshot
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label="Label">
          <Input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Before laptop upgrade" autoFocus />
        </Field>
        <Field label="Passphrase" help="At least 10 characters">
          <Input type="password" value={f.passphrase} onChange={(e) => setF({ ...f, passphrase: e.target.value })} autoComplete="new-password" />
        </Field>
        <Field label="Confirm passphrase" error={f.confirm && f.confirm !== f.passphrase ? 'Does not match' : undefined}>
          <Input type="password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} autoComplete="new-password" />
        </Field>
        <Toggle checked={f.includeModels} onChange={(v) => setF({ ...f, includeModels: v })} label="Include AI models (can add several GB)" />
        <Toggle checked={f.save} onChange={(v) => setF({ ...f, save: v })} label="Also save this passphrase in the vault for scheduled backups" />
      </div>
    </Modal>
  );
}

function RestoreModal({ file, header, onClose }: { file: string; header: SnapshotHeader; onClose: () => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [mode, setMode] = useState<'migrate' | 'clone'>('migrate');
  const [restarting, setRestarting] = useState(false);
  const { run, busy } = useAction();
  return (
    <Modal
      title="Restore snapshot"
      onClose={onClose}
      footer={
        restarting ? undefined : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="danger-solid"
              loading={busy === 'r'}
              disabled={passphrase.length < 1}
              onClick={async () => {
                const r = await run('r', () => call('backup.restore', { file, passphrase, mode }));
                if (r) setRestarting(true);
              }}
            >
              Restore and restart
            </Button>
          </>
        )
      }
    >
      {restarting ? (
        <Callout tone="good" title="Snapshot verified">FBRX OS is restarting to finish the restore…</Callout>
      ) : (
        <div className="fx-form">
          <KeyValue
            items={[
              ['From', `${header.deviceName} (${header.hostname}, ${header.platform})`],
              ['Created', formatDate(header.createdAt)],
              ['Label', header.label ?? '—'],
              ['FBRX OS version', header.appVersion],
              ['Includes models', header.includesModels ? 'Yes' : 'No'],
            ]}
          />
          <Field label="Snapshot passphrase">
            <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoFocus />
          </Field>
          <div className="choice-grid">
            <button className={`choice${mode === 'migrate' ? ' selected' : ''}`} onClick={() => setMode('migrate')}>
              <strong>Migrate</strong>
              <span className="fx-secondary" style={{ fontSize: 13 }}>This computer becomes that workstation — same device in your organisation. Use when replacing hardware.</span>
            </button>
            <button className={`choice${mode === 'clone' ? ' selected' : ''}`} onClick={() => setMode('clone')}>
              <strong>Clone</strong>
              <span className="fx-secondary" style={{ fontSize: 13 }}>Copy everything but leave the organisation enrollment behind; enroll this computer as a new device.</span>
            </button>
          </div>
          <Callout tone="warning">Current data on this computer is kept in a safety copy inside the data folder (<code>.pre-restore</code>) and then replaced.</Callout>
        </div>
      )}
    </Modal>
  );
}
