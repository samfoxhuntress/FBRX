import { useEffect, useMemo, useRef, useState } from 'react';
import { PASSWORD_OLD_DAYS, SECRET_KINDS, STRENGTH_WORDS, displayHost, type Login, type LoginSummary, type SecretKind, type SecretMeta, type VaultStatus } from '@fbrx/shared';
import { Button, Callout, Card, CopyText, Empty, Field, Grid, Icons, Input, KeyValue, Modal, Page, Select, Spinner, Status, Table, Tabs, TextArea, Toggle, timeAgo, useAction, useConfirm, useToast } from '@fbrx/ui';
import { call, copySecret, writeClipboard } from '../client';
import { useCore } from '../hooks';
import { LockedNotice } from '../vault-lock';
import { LoginEditor, StrengthMeter, saveToVault } from '../vault-save';
import { navigate, routeArg } from '../app';

/**
 * The Vault: a password keeper (sign-ins FBRX Browser fills in, with 2-step codes, health checks and import from other
 * browsers), the keys and tokens the agent, plugins and connections use, and how the vault itself is locked. Everything
 * in it is encrypted with AES-256-GCM under a key only this computer (or the vault password) can open.
 */

type VaultTab = 'passwords' | 'keys' | 'security';
const TABS: Array<{ id: VaultTab; label: string }> = [
  { id: 'passwords', label: 'Passwords' },
  { id: 'keys', label: 'Keys & tokens' },
  { id: 'security', label: 'Security' },
];
const tabFromRoute = (): VaultTab => (TABS.some((t) => t.id === routeArg()) ? (routeArg() as VaultTab) : 'passwords');

export function VaultPage() {
  const status = useCore('vault.status', undefined, ['vault.changed']);
  const [tab, setTab] = useState<VaultTab>(tabFromRoute);
  const [addingKey, setAddingKey] = useState(false);
  const { confirm, dialog } = useConfirm();
  const { run } = useAction();
  const s = status.data;
  useEffect(() => {
    const on = () => setTab(tabFromRoute());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const startOver = async () => {
    if (
      await confirm({
        title: 'Delete everything in the Vault and start over?',
        body: 'Your passwords, API keys and tokens are deleted, along with FBRX’s own keys (paired phones and computers need pairing again). FBRX restarts to finish. This cannot be undone.',
        danger: true,
        confirmLabel: 'Delete and start over',
      })
    )
      await run('reset', () => call('vault.reset', { confirm: 'DELETE' }), 'Starting over: FBRX restarts');
  };

  return (
    <Page
      title="Vault"
      description="Your passwords and the keys FBRX uses, encrypted on this computer. FBRX Browser fills in your sign-ins; Fabrix never sees a password."
      actions={
        s?.state === 'unlocked' &&
        tab !== 'security' && (
          <Button variant="primary" icon="plus" onClick={() => (tab === 'passwords' ? saveToVault() : setAddingKey(true))}>
            {tab === 'passwords' ? 'Add sign-in' : 'Add key or token'}
          </Button>
        )
      }
    >
      {s?.state === 'locked' && <LockedNotice status={s} onStartOver={() => void startOver()} />}
      <Tabs tabs={TABS.map((t) => ({ ...t, label: t.id === 'passwords' && s?.loginCount ? `${t.label} (${s.loginCount})` : t.label }))} active={tab} onChange={(t) => navigate(`vault/${t}`)} />
      {tab === 'passwords' && s?.state === 'unlocked' && <PasswordsTab />}
      {tab === 'keys' && <KeysTab unlocked={s?.state === 'unlocked'} adding={addingKey} onAdded={() => setAddingKey(false)} />}
      {tab === 'security' && s && <SecurityTab status={s} onStartOver={() => void startOver()} />}
      {dialog}
    </Page>
  );
}

const DAY = 86_400_000;
const isOld = (l: LoginSummary) => Date.now() - Date.parse(l.passwordChangedAt) > PASSWORD_OLD_DAYS * DAY;
const needsAttention = (l: LoginSummary) => l.strength < 2 || l.reused || isOld(l);

type Filter = 'all' | 'favorites' | 'attention' | 'totp';

/** The password keeper: search and filters, the list, and the chosen sign-in. */
function PasswordsTab() {
  const list = useCore('passwords.list', undefined, ['vault.changed']);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [picked, setPicked] = useState<string | null>(null);
  const all = list.data ?? [];
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return all.filter(
      (l) =>
        (!term || l.title.toLowerCase().includes(term) || l.username.toLowerCase().includes(term) || l.urls.some((u) => u.toLowerCase().includes(term))) &&
        (filter === 'all' || (filter === 'favorites' && l.favorite) || (filter === 'attention' && needsAttention(l)) || (filter === 'totp' && l.hasTotp)),
    );
  }, [all, q, filter]);
  const chosen = all.find((l) => l.id === picked) ?? shown[0] ?? null;
  const weak = all.filter((l) => l.strength < 2).length;
  const reused = all.filter((l) => l.reused).length;
  const old = all.filter(isOld).length;

  if (!list.data) return <Spinner />;
  if (!all.length) return <PasswordsEmpty />;
  return (
    <>
      {(weak > 0 || reused > 0 || old > 0) && filter !== 'attention' && (
        <Callout tone="warning" title="Some passwords need attention" actions={<Button size="sm" onClick={() => setFilter('attention')}>Show them</Button>}>
          {[weak && `${weak} ${weak === 1 ? 'is' : 'are'} weak`, reused && `${reused} ${reused === 1 ? 'shares its password' : 'share a password'} with another sign-in`, old && `${old} ${old === 1 ? 'has' : 'have'} not changed in over a year`].filter(Boolean).join(', ')}. Give each its own strong password: open it, choose Edit, and make a new one.
        </Callout>
      )}
      <div className="pw-tools">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${all.length} sign-ins`} aria-label="Search sign-ins" />
        <div className="pw-filters" role="radiogroup" aria-label="Show">
          {(
            [
              ['all', 'All'],
              ['favorites', 'Favorites'],
              ['attention', 'Needs attention'],
              ['totp', '2-step codes'],
            ] as Array<[Filter, string]>
          ).map(([id, label]) => (
            <button key={id} role="radio" aria-checked={filter === id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
        </div>
        <ImportButton />
      </div>
      <div className="pw-layout">
        <Card flush className="pw-list private">
          {shown.length === 0 && <Empty title="Nothing matches">Try another word, or show all sign-ins.</Empty>}
          {shown.map((l) => (
            <button key={l.id} className={`pw-row${chosen?.id === l.id ? ' on' : ''}`} onClick={() => setPicked(l.id)}>
              <SiteMark title={l.title} />
              <span className="pw-row-text">
                <b>
                  {l.title} {l.favorite && <Icons.bookmark size={11} />}
                </b>
                <small>{l.username || (l.urls[0] ? displayHost(l.urls[0]) : 'No username')}</small>
              </span>
              {needsAttention(l) && <span className={`pw-flag ${l.strength < 2 ? 'bad' : ''}`}>{l.strength < 2 ? STRENGTH_WORDS[l.strength] : l.reused ? 'Reused' : 'Old'}</span>}
            </button>
          ))}
        </Card>
        {chosen && <LoginDetail key={chosen.id} login={chosen} />}
      </div>
    </>
  );
}

function PasswordsEmpty() {
  return (
    <Card>
      <Empty title="Keep your passwords here" action={<Button variant="primary" icon="plus" onClick={() => saveToVault()}>Add a sign-in</Button>}>
        Save a sign-in, or bring your passwords over from another browser or password manager: export them as a CSV file there, then import it here. FBRX Browser fills them in and offers to save new ones as you sign in.
        <div style={{ marginTop: 12 }}>
          <ImportButton />
        </div>
      </Empty>
    </Card>
  );
}

/** A round mark with the site's first letter. */
function SiteMark({ title }: { title: string }) {
  const hue = [...title].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <span className="pw-mark" style={{ background: `hsl(${hue} 55% 42%)` }} aria-hidden>
      {title.trim().charAt(0).toUpperCase() || '•'}
    </span>
  );
}

/** Brings sign-ins over from the CSV file another browser or password manager exports. */
function ImportButton() {
  const input = useRef<HTMLInputElement>(null);
  const { run, busy } = useAction();
  const toast = useToast();
  return (
    <>
      <Button
        icon="upload"
        loading={busy === 'imp'}
        onClick={() => input.current?.click()}
        title="Export your passwords as a CSV file from your browser or password manager, then pick that file"
      >
        Import
      </Button>
      <input
        ref={input}
        type="file"
        accept=".csv,text/csv"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          void run('imp', async () => {
            const r = await call('passwords.import', { csv: await file.text() });
            toast.success(`Imported ${r.added} sign-in${r.added === 1 ? '' : 's'}`, `${r.updated ? `${r.updated} updated. ` : ''}${r.skipped ? `${r.skipped} already here or empty. ` : ''}Now delete the exported file: it holds your passwords in plain text.`);
          });
        }}
      />
    </>
  );
}

/** One sign-in: copy its username, password and 2-step code, open its site, edit or delete it. */
function LoginDetail({ login }: { login: LoginSummary }) {
  const [full, setFull] = useState<Login | null>(null);
  const [shown, setShown] = useState(false);
  const [editing, setEditing] = useState(false);
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const toast = useToast();
  const reveal = async (): Promise<Login> => {
    if (full) return full;
    const l = await call('passwords.reveal', { id: login.id });
    setFull(l);
    return l;
  };
  const copy = (what: 'username' | 'password') =>
    void run(what, async () => {
      if (what === 'username') await writeClipboard(login.username);
      else await copySecret((await reveal()).password);
      toast.info(what === 'username' ? 'Username copied' : 'Password copied', what === 'password' ? 'It leaves the clipboard again shortly.' : undefined);
    });
  // Hide the password again after a while.
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(false), 30_000);
    return () => clearTimeout(t);
  }, [shown]);

  return (
    <Card className="pw-detail private">
      <div className="pw-detail-head">
        <SiteMark title={login.title} />
        <div>
          <h2>{login.title}</h2>
          <span className="fx-muted">{login.urls[0] ? displayHost(login.urls[0]) : 'Not on the web'}</span>
        </div>
        <span className="fx-spacer" />
        <Button size="sm" variant="ghost" icon="bookmark" className={login.favorite ? 'pw-fav on' : 'pw-fav'} aria-label={login.favorite ? 'Remove from favorites' : 'Add to favorites'} onClick={() => void run('fav', () => call('passwords.save', { id: login.id, favorite: !login.favorite }))} />
        <Button
          size="sm"
          icon="edit"
          loading={busy === 'edit'}
          onClick={() =>
            void run('edit', async () => {
              await reveal();
              setEditing(true);
            })
          }
        >
          Edit
        </Button>
        <Button
          size="sm"
          variant="danger"
          icon="trash"
          aria-label={`Delete ${login.title}`}
          onClick={async () => {
            if (await confirm({ title: `Delete ${login.title}?`, body: 'Its username, password and 2-step key go from the Vault.', danger: true, confirmLabel: 'Delete' })) await run('rm', () => call('passwords.remove', { id: login.id }), 'Sign-in deleted');
          }}
        />
      </div>
      <dl className="pw-fields">
        <dt>Username</dt>
        <dd>
          <span className="mono">{login.username || '—'}</span>
          {login.username && <Button size="sm" variant="ghost" icon="copy" aria-label="Copy username" onClick={() => copy('username')} />}
        </dd>
        <dt>Password</dt>
        <dd>
          <span className="mono pw-secret">{shown && full ? full.password : '••••••••••••'}</span>
          <Button
            size="sm"
            variant="ghost"
            icon={shown ? 'eyeOff' : 'eye'}
            aria-label={shown ? 'Hide password' : 'Show password'}
            loading={busy === 'show'}
            onClick={() => {
              if (shown) return setShown(false);
              void run('show', async () => {
                await reveal();
                setShown(true);
              });
            }}
          />
          <Button size="sm" variant="ghost" icon="copy" aria-label="Copy password" loading={busy === 'password'} onClick={() => copy('password')} />
          <StrengthMeter strength={login.strength} />
        </dd>
        {login.hasTotp && (
          <>
            <dt>2-step code</dt>
            <dd>
              <TotpCode id={login.id} />
            </dd>
          </>
        )}
        {login.urls.length > 0 && (
          <>
            <dt>Website</dt>
            <dd className="pw-urls">
              {login.urls.map((u) => (
                <button key={u} className="pw-link" onClick={() => navigate(`browser/${u}`)} title="Open in FBRX Browser">
                  {displayHost(u)} <Icons.external size={12} />
                </button>
              ))}
            </dd>
          </>
        )}
        {login.hasNotes && (
          <>
            <dt>Notes</dt>
            <dd>{full ? <span className="pw-notes">{full.notes}</span> : <Button size="sm" variant="ghost" onClick={() => void run('notes', reveal)}>Show notes</Button>}</dd>
          </>
        )}
      </dl>
      {(login.strength < 2 || login.reused || isOld(login)) && (
        <Callout tone="warning">
          {login.strength < 2 ? `This password is ${STRENGTH_WORDS[login.strength].toLowerCase()}. ` : ''}
          {login.reused ? 'Another sign-in has the same password: if one site leaks it, the other is open too. ' : ''}
          {isOld(login) ? 'It has not changed in over a year. ' : ''}
          Change it on the site, then choose Edit and make a new strong one here.
        </Callout>
      )}
      {full && full.history.length > 0 && (
        <details className="pw-history">
          <summary>Earlier passwords ({full.history.length})</summary>
          {full.history.map((h) => (
            <div key={h.until}>
              <span className="mono">{h.password}</span>
              <span className="fx-muted">until {new Date(h.until).toLocaleDateString()}</span>
            </div>
          ))}
        </details>
      )}
      <p className="fx-muted pw-meta">
        Last used {login.lastUsedAt ? timeAgo(login.lastUsedAt) : 'never'} · password changed {timeAgo(login.passwordChangedAt)} · added {timeAgo(login.createdAt)}
      </p>
      {editing && full && (
        <LoginEditor
          login={full}
          onClose={() => {
            setEditing(false);
            setFull(null);
            setShown(false);
          }}
        />
      )}
      {dialog}
    </Card>
  );
}

/** The 2-step code, counting down to the next one. */
function TotpCode({ id }: { id: string }) {
  const [code, setCode] = useState<{ code: string; remaining: number; at: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const { run, busy } = useAction();
  const toast = useToast();
  const left = code ? Math.max(0, code.remaining - Math.floor((now - code.at) / 1000)) : 0;
  useEffect(() => {
    if (!code) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [code]);
  useEffect(() => {
    if (code && left === 0) void call('passwords.code', { id }).then((c) => setCode({ ...c, at: Date.now() }));
  }, [code, left, id]);
  if (!code)
    return (
      <Button size="sm" variant="ghost" loading={busy === 'c'} onClick={() => void run('c', async () => setCode({ ...(await call('passwords.code', { id })), at: Date.now() }))}>
        Show code
      </Button>
    );
  return (
    <>
      <span className="mono pw-code">
        {code.code.slice(0, Math.ceil(code.code.length / 2))} {code.code.slice(Math.ceil(code.code.length / 2))}
      </span>
      <span className="fx-muted">{left}s</span>
      <Button size="sm" variant="ghost" icon="copy" aria-label="Copy code" onClick={() => void copySecret(code.code).then(() => toast.info('Code copied'))} />
    </>
  );
}

/** The keys and tokens the agent, plugins and connections use, by name. */
function KeysTab({ unlocked, adding, onAdded }: { unlocked: boolean; adding: boolean; onAdded: () => void }) {
  const list = useCore('vault.list', undefined, ['vault.changed']);
  const [edit, setEdit] = useState<Partial<SecretMeta> | null>(null);
  const [revealed, setRevealed] = useState<{ name: string; value: string } | null>(null);
  const { confirm, dialog } = useConfirm();
  const { run } = useAction();
  // "Add key or token" is in the page's header.
  useEffect(() => {
    if (!adding) return;
    setEdit({ kind: 'api-key' });
    onAdded();
  }, [adding, onAdded]);
  useEffect(() => {
    if (!revealed) return;
    const t = setTimeout(() => setRevealed(null), 30_000);
    return () => clearTimeout(t);
  }, [revealed]);
  return (
    <>
      <p className="fx-muted">API keys, tokens and passwords that tools, plugins and connections refer to by name. They are used for you and never shown to the agent.</p>
      <Card flush className="private">
        <Table
          rows={list.data ?? []}
          rowKey={(x) => x.name}
          empty={<Empty title="No keys yet">Add API keys for Claude or OpenAI, tokens for your connections, or passwords for plugins.</Empty>}
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
                  <Button size="sm" icon="eye" disabled={!unlocked} onClick={async () => setRevealed((await run('r', () => call('vault.reveal', { name: x.name }))) ?? null)}>
                    Reveal
                  </Button>
                  {!x.managed && (
                    <>
                      <Button size="sm" disabled={!unlocked} onClick={() => setEdit(x)}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={async () => {
                          if (await confirm({ title: `Delete ${x.name}?`, body: 'Anything that references it will stop working.', danger: true, confirmLabel: 'Delete' })) await run('d', () => call('vault.delete', { name: x.name }), 'Key deleted');
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
      {dialog}
    </>
  );
}

/** How the vault is locked and unlocked, and how the password keeper behaves. */
function SecurityTab({ status: s, onStartOver }: { status: VaultStatus; onStartOver: () => void }) {
  const settings = useCore('settings.get', undefined, ['settings.changed']);
  const [recovery, setRecovery] = useState(false);
  const [askOnStart, setAskOnStart] = useState<boolean | null>(null);
  const { confirm, dialog } = useConfirm();
  const { run } = useAction();
  const pw = settings.data?.settings.passwords;
  const patch = (p: Partial<NonNullable<typeof pw>>) => void run('set', () => call('settings.update', { patch: { passwords: p } }));
  return (
    <>
      {!s.hasRecovery && s.state === 'unlocked' && (
        <Callout tone="info" title="Add a vault password" actions={<Button size="sm" onClick={() => setRecovery(true)}>Set password</Button>}>
          It unlocks your Vault if this computer's key is lost, and on another computer. (Backups carry your Vault too, protected by the backup passphrase.)
        </Callout>
      )}
      <Grid cols={3}>
        <Card title="Status">
          <KeyValue
            items={[
              ['State', <Status key="s" tone={s.state === 'unlocked' ? 'good' : 'warning'}>{s.state}</Status>],
              ['Key kept by', s.passwordOnStart ? 'Your vault password' : s.keychainKind === 'os' ? "This computer's keychain" : 'A key file only you can read'],
              ['Sign-ins', s.loginCount],
              ['Keys & tokens', s.secretCount],
              ['From organization', s.managedCount],
            ]}
          />
        </Card>
        <Card title="Vault password" subtitle="Unlocks this Vault on any computer">
          <div className="fx-stack" style={{ gap: 12 }}>
            <Button icon="key" onClick={() => setRecovery(true)} disabled={s.state !== 'unlocked'}>
              {s.hasRecovery ? 'Change password' : 'Set password'}
            </Button>
            <Toggle checked={s.passwordOnStart} disabled={s.state !== 'unlocked'} onChange={(v) => setAskOnStart(v)} label="Ask for it every time FBRX starts" />
            <span className="fx-muted" style={{ fontSize: 12 }}>
              Off: the Vault unlocks by itself on this computer. On: it stays locked after every start until you type the password.
            </span>
          </div>
        </Card>
        <Card title="Lock" subtitle="Clears the key from memory until restart or unlock">
          <div className="fx-stack" style={{ gap: 12 }}>
            <Button
              icon="lock"
              disabled={s.state !== 'unlocked'}
              onClick={async () => {
                if (await confirm({ title: 'Lock the Vault?', body: s.hasRecovery ? 'Sign-ins, tools and connections that need it stop working until you unlock it with the vault password or restart FBRX.' : 'You have no vault password, so the Vault stays locked until FBRX restarts.', confirmLabel: 'Lock' })) await run('l', () => call('vault.lock'));
              }}
            >
              Lock now
            </Button>
            <Button variant="ghost" icon="trash" onClick={onStartOver}>
              Delete everything and start over…
            </Button>
          </div>
        </Card>
      </Grid>
      {pw && (
        <Card title="Passwords">
          <div className="fx-form">
            <Toggle checked={pw.offerToSave} onChange={(offerToSave) => patch({ offerToSave })} label="FBRX Browser offers to save a sign-in when you sign in to a site" />
            <Field label="Clear a copied password from the clipboard after">
              <Select
                value={String(pw.clearClipboardSeconds)}
                onChange={(e) => patch({ clearClipboardSeconds: Number(e.target.value) })}
                options={[
                  { value: '15', label: '15 seconds' },
                  { value: '30', label: '30 seconds' },
                  { value: '60', label: '1 minute' },
                  { value: '120', label: '2 minutes' },
                  { value: '0', label: 'Never (it stays)' },
                ]}
              />
            </Field>
            {pw.neverSave.length > 0 && (
              <Field label="Sites FBRX Browser never offers to save for">
                <div className="pw-never">
                  {pw.neverSave.map((site) => (
                    <span key={site} className="fx-badge">
                      {site}
                      <button aria-label={`Offer again on ${site}`} onClick={() => patch({ neverSave: pw.neverSave.filter((x) => x !== site) })}>
                        <Icons.x size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              </Field>
            )}
          </div>
        </Card>
      )}
      {recovery && <RecoveryModal hasRecovery={s.hasRecovery} onClose={() => setRecovery(false)} />}
      {askOnStart !== null && <AskOnStartModal enable={askOnStart} hasRecovery={s.hasRecovery} onClose={() => setAskOnStart(null)} />}
      {dialog}
    </>
  );
}

function SecretEditor({ secret, onClose }: { secret: Partial<SecretMeta>; onClose: () => void }) {
  const [f, setF] = useState({ name: secret.name ?? '', value: '', kind: (secret.kind ?? 'api-key') as SecretKind, description: secret.description ?? '', tags: (secret.tags ?? []).join(', ') });
  const { run, busy } = useAction();
  const editing = !!secret.name;
  return (
    <Modal
      title={editing ? `Update ${secret.name}` : 'Add key or token'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy === 's'}
            disabled={!f.name || !f.value}
            onClick={() => void run('s', () => call('vault.set', { name: f.name, value: f.value, kind: f.kind, description: f.description, tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean) }).then(onClose), 'Saved to Vault')}
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
      title={hasRecovery ? 'Change vault password' : 'Set vault password'}
      description="At least 10 characters. Keep it somewhere safe: FBRX cannot recover it for you."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 's'} disabled={!ok} onClick={() => void run('s', () => (hasRecovery ? call('vault.changeRecovery', { current: f.current, next: f.next }) : call('vault.initialize', { recoveryPassphrase: f.next })).then(onClose), 'Vault password saved')}>
            Save
          </Button>
        </>
      }
    >
      <div className="fx-form">
        {hasRecovery && (
          <Field label="Current password">
            <Input type="password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} />
          </Field>
        )}
        <Field label="New password">
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
            ? 'Choose a vault password (at least 10 characters). FBRX asks for it every time it starts; keep it somewhere safe, FBRX cannot recover it.'
            : 'Enter your vault password. FBRX will ask for it every time it starts.'
          : 'Enter your vault password. The Vault will unlock by itself on this computer again.'
      }
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 's'} disabled={!ok} onClick={() => void run('s', () => call('vault.passwordOnStart', { enabled: enable, passphrase: f.pass }).then(onClose), enable ? 'FBRX will ask for the vault password at start' : 'The Vault unlocks by itself again')}>
            {enable ? 'Turn on' : 'Turn off'}
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label={creating ? 'New vault password' : 'Vault password'}>
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
