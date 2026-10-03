import { useEffect, useState } from 'react';
import { SECRET_KINDS, type SecretKind, type SecretMeta } from '@fbrx/shared';
import { Button, Callout, Card, CopyText, Empty, Field, Grid, Input, KeyValue, Modal, Page, Select, Status, Table, TextArea, Toggle, timeAgo, useAction, useConfirm } from '@fbrx/ui';
import { call } from '../client';
import { useCore } from '../hooks';
import { LockedNotice } from '../vault-lock';

export function VaultPage() {
  const status = useCore('vault.status', undefined, ['vault.changed']);
  const list = useCore('vault.list', undefined, ['vault.changed']);
  const [edit, setEdit] = useState<Partial<SecretMeta> | null>(null);
  const [revealed, setRevealed] = useState<{ name: string; value: string } | null>(null);
  const [recovery, setRecovery] = useState(false);
  const [askOnStart, setAskOnStart] = useState<boolean | null>(null);
  const { confirm, dialog } = useConfirm();
  const { run } = useAction();
  const s = status.data;
  const startOver = async () => {
    if (
      await confirm({
        title: 'Delete every saved credential and start over?',
        body: 'Your API keys, passwords and tokens in this vault are deleted, along with FBRX’s own keys (paired phones and computers need pairing again). FBRX restarts to finish. This cannot be undone.',
        danger: true,
        confirmLabel: 'Delete and start over',
      })
    )
      await run('reset', () => call('vault.reset', { confirm: 'DELETE' }), 'Starting over: FBRX restarts');
  };

  useEffect(() => {
    if (!revealed) return;
    const t = setTimeout(() => setRevealed(null), 30_000);
    return () => clearTimeout(t);
  }, [revealed]);

  return (
    <Page
      title="Vault"
      description="Encrypted credentials for the agent, plugins and connections. Values are encrypted with AES-256-GCM under a key that only this computer (or your passphrase) can open; the agent never sees them in plain text."
      actions={
        s?.state === 'unlocked' && (
          <Button variant="primary" icon="plus" onClick={() => setEdit({ kind: 'api-key' })}>
            Add credential
          </Button>
        )
      }
    >
      {s?.state === 'locked' && <LockedNotice status={s} onStartOver={() => void startOver()} />}
      {s && !s.hasRecovery && s.state === 'unlocked' && (
        <Callout tone="info" title="Add a recovery passphrase" actions={<Button size="sm" onClick={() => setRecovery(true)}>Set passphrase</Button>}>
          Lets you unlock your credentials if this computer's key is lost, and on another computer. (Backups carry your credentials too, protected by the backup passphrase.)
        </Callout>
      )}
      <Grid cols={3}>
        <Card title="Status">
          <KeyValue
            items={[
              ['State', s ? <Status tone={s.state === 'unlocked' ? 'good' : 'warning'}>{s.state}</Status> : '…'],
              ['Key kept by', s ? (s.passwordOnStart ? 'Your vault password' : s.keychainKind === 'os' ? "This computer's keychain" : 'A key file only you can read') : '…'],
              ['Credentials', s?.secretCount ?? '…'],
              ['From organization', s?.managedCount ?? 0],
              ['Recovery passphrase', s?.hasRecovery ? 'Set' : 'Not set'],
            ]}
          />
        </Card>
        <Card title="Password" subtitle="The passphrase that unlocks this vault on any computer">
          <div className="fx-stack" style={{ gap: 12 }}>
            <Button icon="key" onClick={() => setRecovery(true)} disabled={s?.state !== 'unlocked'}>
              {s?.hasRecovery ? 'Change passphrase' : 'Set passphrase'}
            </Button>
            <Toggle
              checked={!!s?.passwordOnStart}
              disabled={s?.state !== 'unlocked'}
              onChange={(v) => setAskOnStart(v)}
              label="Ask for it every time FBRX starts"
            />
            <span className="fx-muted" style={{ fontSize: 12 }}>
              Off: credentials unlock by themselves on this computer and nothing asks for a password. On: they stay locked after every start until you type the passphrase.
            </span>
          </div>
        </Card>
        <Card title="Lock" subtitle="Clears the key from memory until restart or recovery unlock">
          <Button
            icon="lock"
            disabled={s?.state !== 'unlocked'}
            onClick={async () => {
              if (await confirm({ title: 'Lock the vault?', body: s?.hasRecovery ? 'Tools and connections that need credentials stop working until you unlock with the passphrase or restart FBRX.' : 'You have no recovery passphrase, so the vault stays locked until FBRX restarts.', confirmLabel: 'Lock' })) await run('l', () => call('vault.lock'));
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
      {askOnStart !== null && s && <AskOnStartModal enable={askOnStart} hasRecovery={s.hasRecovery} onClose={() => setAskOnStart(null)} />}
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

function AskOnStartModal({ enable, hasRecovery, onClose }: { enable: boolean; hasRecovery: boolean; onClose: () => void }) {
  const [f, setF] = useState({ pass: '', confirm: '' });
  const { run, busy } = useAction();
  const creating = enable && !hasRecovery;
  const ok = f.pass.length >= (creating ? 10 : 1) && (!creating || f.pass === f.confirm);
  return (
    <Modal
      title={enable ? 'Ask for a password at every start' : 'Stop asking for a password'}
      description={
        enable
          ? creating
            ? 'Choose a vault passphrase (at least 10 characters). FBRX asks for it every time it starts; keep it in your password manager, FBRX cannot recover it.'
            : 'Enter your vault passphrase. FBRX will ask for it every time it starts.'
          : 'Enter your vault passphrase. Credentials will unlock by themselves on this computer again.'
      }
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 's'} disabled={!ok} onClick={() => void run('s', () => call('vault.passwordOnStart', { enabled: enable, passphrase: f.pass }).then(onClose), enable ? 'FBRX will ask for the vault passphrase at start' : 'Credentials unlock by themselves again')}>
            {enable ? 'Turn on' : 'Turn off'}
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label={creating ? 'New vault passphrase' : 'Vault passphrase'}>
          <Input type="password" value={f.pass} onChange={(e) => setF({ ...f, pass: e.target.value })} autoComplete={creating ? 'new-password' : 'current-password'} />
        </Field>
        {creating && (
          <Field label="Confirm" error={f.confirm && f.confirm !== f.pass ? 'Does not match' : undefined}>
            <Input type="password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} autoComplete="new-password" />
          </Field>
        )}
      </div>
    </Modal>
  );
}
