import { useEffect, useState } from 'react';
import { SECRET_KINDS, type SecretKind, type SecretMeta } from '@fbrx/shared';
import { Button, Callout, Card, CopyText, Empty, Field, Grid, Input, KeyValue, Modal, Page, Select, Status, Table, TextArea, timeAgo, useAction, useConfirm } from '@fbrx/ui';
import { call } from '../client';
import { useCore } from '../hooks';

export function VaultPage() {
  const status = useCore('vault.status', undefined, ['vault.changed']);
  const list = useCore('vault.list', undefined, ['vault.changed']);
  const [edit, setEdit] = useState<Partial<SecretMeta> | null>(null);
  const [revealed, setRevealed] = useState<{ name: string; value: string } | null>(null);
  const [recovery, setRecovery] = useState(false);
  const [unlock, setUnlock] = useState('');
  const { confirm, dialog } = useConfirm();
  const { run, busy } = useAction();
  const s = status.data;

  useEffect(() => {
    if (!revealed) return;
    const t = setTimeout(() => setRevealed(null), 30_000);
    return () => clearTimeout(t);
  }, [revealed]);

  return (
    <Page
      title="Vault"
      description="Encrypted credentials for the agent, plugins and connections. Values are encrypted with AES-256-GCM under a key protected by your operating system's keychain; the agent never sees them in plain text."
      actions={
        s?.state === 'unlocked' && (
          <Button variant="primary" icon="plus" onClick={() => setEdit({ kind: 'api-key' })}>
            Add credential
          </Button>
        )
      }
    >
      {s?.state === 'locked' && (
        <Callout tone="warning" title="Vault is locked">
          <div className="fx-row" style={{ marginTop: 8 }}>
            <Input type="password" placeholder="Recovery passphrase" value={unlock} onChange={(e) => setUnlock(e.target.value)} />
            <Button variant="primary" loading={busy === 'u'} disabled={!unlock} onClick={() => void run('u', () => call('vault.unlock', { recoveryPassphrase: unlock }).then(() => setUnlock('')), 'Vault unlocked')}>
              Unlock
            </Button>
          </div>
        </Callout>
      )}
      {s && !s.hasRecovery && s.state === 'unlocked' && (
        <Callout tone="info" title="Add a recovery passphrase" actions={<Button size="sm" onClick={() => setRecovery(true)}>Set passphrase</Button>}>
          Lets you unlock your credentials if this computer's keychain is reset. (Backups carry your credentials too, protected by the backup passphrase.)
        </Callout>
      )}
      <Grid cols={3}>
        <Card title="Status">
          <KeyValue
            items={[
              ['State', s ? <Status tone={s.state === 'unlocked' ? 'good' : 'warning'}>{s.state}</Status> : '…'],
              ['OS keychain', s?.keychain === 'available' ? 'In use' : 'Unavailable (key file)'],
              ['Credentials', s?.secretCount ?? '…'],
              ['From organization', s?.managedCount ?? 0],
              ['Recovery passphrase', s?.hasRecovery ? 'Set' : 'Not set'],
            ]}
          />
        </Card>
        <Card title="Recovery" subtitle="Change the passphrase that can unlock this vault anywhere">
          <Button icon="key" onClick={() => setRecovery(true)} disabled={s?.state !== 'unlocked'}>
            {s?.hasRecovery ? 'Change recovery passphrase' : 'Set recovery passphrase'}
          </Button>
        </Card>
        <Card title="Lock" subtitle="Clears the key from memory until restart or recovery unlock">
          <Button
            icon="lock"
            disabled={s?.state !== 'unlocked'}
            onClick={async () => {
              if (await confirm({ title: 'Lock the vault?', body: s?.hasRecovery ? 'Tools and connections that need credentials stop working until you unlock with the recovery passphrase or restart FBRX OS.' : 'You have no recovery passphrase, so the vault stays locked until FBRX OS restarts.', confirmLabel: 'Lock' })) await run('l', () => call('vault.lock'));
            }}
          >
            Lock now
          </Button>
        </Card>
      </Grid>
      <Card flush>
        <Table
          rows={list.data ?? []}
          rowKey={(x) => x.name}
          empty={<Empty title="No credentials yet">Add API keys for Claude or OpenAI, tokens for your connections, or passwords for plugins.</Empty>}
          columns={[
            { key: 'n', header: 'Name', render: (x) => (<div><div className="fx-cell-title mono">{x.name}</div><div className="fx-cell-sub">{x.description || x.kind}</div></div>) },
            { key: 'k', header: 'Kind', render: (x) => <span className="fx-badge">{x.kind}</span> },
            { key: 'm', header: 'Source', render: (x) => (x.managed ? <span className="fx-badge accent">Organization</span> : 'You') },
            { key: 'a', header: 'Last used', render: (x) => timeAgo(x.lastAccessedAt) },
            {
              key: 'x',
              header: '',
              render: (x) => (
                <div className="fx-actions">
                  <Button size="sm" icon="eye" onClick={async () => setRevealed((await run('r', () => call('vault.reveal', { name: x.name }))) ?? null)}>
                    Reveal
                  </Button>
                  {!x.managed && (
                    <>
                      <Button size="sm" onClick={() => setEdit(x)}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={async () => {
                          if (await confirm({ title: `Delete ${x.name}?`, body: 'Anything that references it will stop working.', danger: true, confirmLabel: 'Delete' })) await run('d', () => call('vault.delete', { name: x.name }), 'Credential deleted');
                        }}
                      >
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              ),
            },
          ]}
        />
      </Card>
      {edit && <SecretEditor secret={edit} onClose={() => setEdit(null)} />}
      {revealed && (
        <Modal title={revealed.name} description="Hidden again automatically after 30 seconds. This reveal was recorded in the audit log." onClose={() => setRevealed(null)} footer={<Button onClick={() => setRevealed(null)}>Done</Button>}>
          <CopyText value={revealed.value} secret />
        </Modal>
      )}
      {recovery && <RecoveryModal hasRecovery={!!s?.hasRecovery} onClose={() => setRecovery(false)} />}
      {dialog}
    </Page>
  );
}

function SecretEditor({ secret, onClose }: { secret: Partial<SecretMeta>; onClose: () => void }) {
  const [f, setF] = useState({ name: secret.name ?? '', value: '', kind: (secret.kind ?? 'api-key') as SecretKind, description: secret.description ?? '', tags: (secret.tags ?? []).join(', ') });
  const { run, busy } = useAction();
  const editing = !!secret.name;
  return (
    <Modal
      title={editing ? `Update ${secret.name}` : 'Add credential'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy === 's'}
            disabled={!f.name || !f.value}
            onClick={() => void run('s', () => call('vault.set', { name: f.name, value: f.value, kind: f.kind, description: f.description, tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean) }).then(onClose), 'Saved to vault')}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label="Name" help="How tools and connections refer to it, e.g. ANTHROPIC_API_KEY">
          <Input className="mono" value={f.name} disabled={editing} onChange={(e) => setF({ ...f, name: e.target.value.replace(/\s/g, '_') })} autoFocus={!editing} />
        </Field>
        <Field label="Value">
          {f.kind === 'certificate' || f.kind === 'note' ? (
            <TextArea code rows={5} value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} />
          ) : (
            <Input type="password" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} autoComplete="off" autoFocus={editing} />
          )}
        </Field>
        <div className="fx-row">
          <Field label="Kind">
            <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as SecretKind })} options={[...SECRET_KINDS]} />
          </Field>
          <Field label="Tags">
            <Input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} placeholder="ai, crm" />
          </Field>
        </div>
        <Field label="Description">
          <Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

export function RecoveryModal({ hasRecovery, onClose }: { hasRecovery: boolean; onClose: () => void }) {
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const { run, busy } = useAction();
  const ok = f.next.length >= 10 && f.next === f.confirm && (!hasRecovery || f.current);
  return (
    <Modal
      title={hasRecovery ? 'Change recovery passphrase' : 'Set recovery passphrase'}
      description="At least 10 characters. Store it in your password manager — FBRX cannot recover it for you."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 's'} disabled={!ok} onClick={() => void run('s', () => (hasRecovery ? call('vault.changeRecovery', { current: f.current, next: f.next }) : call('vault.initialize', { recoveryPassphrase: f.next })).then(onClose), 'Recovery passphrase saved')}>
            Save
          </Button>
        </>
      }
    >
      <div className="fx-form">
        {hasRecovery && (
          <Field label="Current passphrase">
            <Input type="password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} />
          </Field>
        )}
        <Field label="New passphrase">
          <Input type="password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} autoComplete="new-password" />
        </Field>
        <Field label="Confirm" error={f.confirm && f.confirm !== f.next ? 'Does not match' : undefined}>
          <Input type="password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} autoComplete="new-password" />
        </Field>
      </div>
    </Modal>
  );
}
