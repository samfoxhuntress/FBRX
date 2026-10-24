import { useEffect, useState, type ReactNode } from 'react';
import { COMMAND_PLAN, EDITION_PLANS, TENANT_DISCOUNT, TIER_NAMES, TIER_SHORT, VERTICALS, VERTICAL_NAMES, atLeast, formatPrice, type AccountDevice, type AccountStatus, type InvitationPreview, type LocalAccountStatus, type Tier, type Vertical } from '@fbrx/shared';
import { Button, Callout, Card, Field, Icons, Input, KeyValue, Status, Toggle, formatDate, formatDay, timeAgo, useAction, useConfirm, useToast, type IconName } from '@fbrx/ui';
import { call, openExternal } from './client';
import { useCore } from './hooks';

/**
 * The person's FBRX account on this computer. Signing in brings whatever the account bought (on the website, another
 * computer or a phone) and turns that edition on; buying from here opens the website's checkout in the browser.
 */
export function useAccount(): AccountStatus | null {
  return useCore('account.status', undefined, ['account.changed', 'license.changed']).data;
}

/**
 * Sign in, make an account, or use an organization's invitation code (which makes the account and joins the
 * organization, with no website or email needed). Asks for the FBRX Command address only when none is built in.
 */
export function AccountSignInForm({ onDone, extraActions, startCreating = false }: { onDone?: () => void; extraActions?: ReactNode; startCreating?: boolean }) {
  const account = useAccount();
  const [mode, setMode] = useState<'signin' | 'create' | 'invite'>(startCreating ? 'create' : 'signin');
  const [f, setF] = useState({ server: '', email: '', password: '', name: '', code: '' });
  const [invite, setInvite] = useState<InvitationPreview | null>(null);
  const { run, busy } = useAction();
  const toast = useToast();
  const needServer = !account?.server;
  const server = needServer || f.server ? { server: f.server } : {};
  const forgot = () =>
    run('forgot', async () => {
      await call('account.forgotPassword', { email: f.email, ...server });
      toast.success('Check your email', `If ${f.email} has an FBRX account, a link to choose a new password is on its way. It opens in your browser.`);
    });
  const lookUp = () => run('look', () => call('account.previewInvitation', { code: f.code, ...server }).then(setInvite));
  const submit = () => {
    if (mode === 'invite' && !invite) return void lookUp();
    const done = <T,>(s: T) => {
      onDone?.();
      return s;
    };
    void run(
      'signin',
      () =>
        mode === 'invite'
          ? call('account.acceptInvitation', { code: f.code, password: f.password, ...server, ...(f.name.trim() ? { name: f.name } : {}) }).then(done)
          : call('account.signIn', { email: f.email, password: f.password, ...server, ...(mode === 'create' ? { create: true, name: f.name } : {}) }).then(done),
      mode === 'invite' ? `Welcome to ${invite!.tenantName}` : mode === 'create' ? 'Your FBRX account is ready' : 'Signed in',
    );
  };
  const switchTo = (m: typeof mode) => {
    setMode(m);
    setInvite(null);
  };
  const newPassword = mode === 'create' || (mode === 'invite' && invite && !invite.accountExists);
  return (
    <form
      className="fx-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {needServer && (
        <Field label="FBRX Command address" help={mode === 'invite' ? 'It is with your invitation code, such as https://command.example.com' : 'Where your FBRX account lives, such as https://command.example.com'}>
          <Input value={f.server} placeholder="https://" onChange={(e) => setF({ ...f, server: e.target.value.trim() })} />
        </Field>
      )}
      {mode === 'invite' && (
        <Field label="Invitation code" help={invite ? undefined : 'From your organization: FBRX- and four groups of four letters and numbers'}>
          <Input
            value={f.code}
            placeholder="FBRX-XXXX-XXXX-XXXX-XXXX"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setF({ ...f, code: e.target.value });
              setInvite(null);
            }}
          />
        </Field>
      )}
      {invite && (
        <Callout tone="good" title={`${invite.tenantName} invited ${invite.email}`}>
          {TIER_NAMES[invite.tier]}.{' '}
          {invite.accountExists ? 'That email has an FBRX account: enter its password to join.' : 'Choose a password for your new FBRX account.'} This computer joins {invite.tenantName} too.
        </Callout>
      )}
      {(mode === 'create' || (mode === 'invite' && invite && !invite.accountExists)) && (
        <Field label="Your name">
          <Input value={f.name} maxLength={120} autoComplete="name" onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
      )}
      {mode !== 'invite' && (
        <Field label="Email">
          <Input type="email" value={f.email} autoComplete="email" onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
      )}
      {(mode !== 'invite' || invite) && (
        <Field label={mode === 'invite' && invite?.accountExists ? 'Password of your FBRX account' : 'Password'} help={newPassword ? 'At least 12 characters' : undefined}>
          <Input type="password" value={f.password} autoComplete={newPassword ? 'new-password' : 'current-password'} onChange={(e) => setF({ ...f, password: e.target.value })} />
        </Field>
      )}
      <div className="fx-actions">
        {mode === 'invite' && !invite ? (
          <Button type="submit" variant="primary" icon="search" loading={busy === 'look'} disabled={!f.code.trim() || (needServer && !f.server)}>
            Look up the invitation
          </Button>
        ) : (
          <Button type="submit" variant="primary" icon="key" loading={busy === 'signin'} disabled={(mode !== 'invite' && !f.email) || !f.password || (needServer && !f.server)}>
            {mode === 'invite' ? `Join ${invite!.tenantName}` : mode === 'create' ? 'Make my account' : 'Sign in'}
          </Button>
        )}
        {mode !== 'signin' && (
          <Button variant="ghost" onClick={() => switchTo('signin')}>
            I have an account
          </Button>
        )}
        {mode !== 'create' && (
          <Button variant="ghost" onClick={() => switchTo('create')}>
            Make an account
          </Button>
        )}
        {mode !== 'invite' && (
          <Button variant="ghost" icon="ticket" onClick={() => switchTo('invite')}>
            I have an invitation
          </Button>
        )}
        {mode === 'signin' && (
          <Button variant="ghost" loading={busy === 'forgot'} disabled={!f.email || (needServer && !f.server)} title={f.email ? undefined : 'Type your email first'} onClick={() => void forgot()}>
            Forgot your password?
          </Button>
        )}
        {extraActions}
      </div>
    </form>
  );
}

/**
 * The offline account's start password: when it is on, FBRX waits for it at launch. A full-screen cover over every
 * window until the right password is given (the lock is only this computer's, kept apart from the vault).
 */
export function LocalAccountLock() {
  const { data: local } = useCore('localAccount.status', undefined, ['localAccount.changed']);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useAction();
  if (!local?.locked) return null;
  const unlock = () =>
    run('u', () => call('localAccount.unlock', { password })).then(
      () => setPassword(''),
      (e: Error) => setError(e.message),
    );
  return (
    <div className="localacct-lock">
      <form
        className="localacct-lock-card"
        onSubmit={(e) => {
          e.preventDefault();
          void unlock();
        }}
      >
        <Icons.lock size={30} />
        <h2>{local.account?.name ? `Welcome back, ${local.account.name}` : 'This computer is locked'}</h2>
        <p>Enter your FBRX start password.</p>
        <Input type="password" autoFocus value={password} autoComplete="current-password" onChange={(e) => (setPassword(e.target.value), setError(null))} />
        {error && <Status tone="warning">{error}</Status>}
        <Button type="submit" variant="primary" loading={busy === 'u'} disabled={!password}>
          Unlock
        </Button>
      </form>
    </div>
  );
}

/** "Get Ultra, $11.99 a month": opens the checkout in the browser. Only the editions above what the account has. */
export function BuyButtons({ account, only, short }: { account: AccountStatus; only?: Tier[]; short?: boolean }) {
  const { run, busy } = useAction();
  const tiers = (only ?? (['basic', 'ultra'] as Tier[])).filter((t) => EDITION_PLANS[t].sold === 'personal' && !atLeast(account.tier, t));
  if (!account.canBuy || !tiers.length) return null;
  return (
    <>
      {tiers.map((t) => (
        <Button
          key={t}
          size="sm"
          variant={t === 'ultra' ? 'primary' : undefined}
          icon="sparkles"
          loading={busy === t}
          onClick={() => void run(t, () => call('account.checkout', { productId: EDITION_PLANS[t].productId! }).then((r) => openExternal(r.url)))}
        >
          {short ? `Get ${TIER_SHORT[t]}` : `Get ${TIER_SHORT[t]}, ${formatPrice(EDITION_PLANS[t].monthly!)} a month`}
        </Button>
      ))}
    </>
  );
}

/** Settings → Account. */
export function AccountSettings() {
  const account = useAccount();
  const fleet = useCore('fleet.status', undefined, ['fleet.changed']).data;
  const { run, busy } = useAction();
  if (!account) return null;
  if (!account.signedIn) {
    return (
      <>
        <Card title="Your FBRX account" subtitle="Sign in to bring what you bought (on the website, on another computer or on your phone) to this computer. It turns that edition on here too.">
          {account.error && <Status tone="warning">{account.error}</Status>}
          <AccountSignInForm />
        </Card>
        <LocalAccountCard />
      </>
    );
  }
  return (
    <>
      <Card
        title={account.name ?? 'Your FBRX account'}
        subtitle={account.email ?? undefined}
        actions={
          <Button size="sm" variant="ghost" loading={busy === 'out'} onClick={() => void run('out', () => call('account.signOut'), 'Signed out')}>
            Sign out
          </Button>
        }
      >
        <KeyValue
          items={[
            ['Edition', <span className={`tier-badge ${account.tier}`}>{account.tier === 'essentials' ? 'Essentials (nothing bought yet)' : TIER_NAMES[account.tier]}</span>],
            ['Renews by itself', account.licenseUntil ? `Runs until ${formatDay(account.licenseUntil)}` : '—'],
            ['Last checked', account.lastSyncAt ? formatDate(account.lastSyncAt) : '—'],
          ]}
        />
        {account.error && <Status tone="warning">{account.error}</Status>}
        {!account.emailVerified && (
          <div className="fx-actions" style={{ marginTop: 10 }}>
            <Status tone="warning">Confirm your email: open the link FBRX sent to {account.email}.</Status>
            <Button size="sm" variant="ghost" loading={busy === 'confirm'} onClick={() => void run('confirm', () => call('account.resendConfirmation').then(() => call('account.refresh')), 'Sent again')}>
              Send it again
            </Button>
          </div>
        )}
        <div className="fx-actions" style={{ marginTop: 10 }}>
          <BuyButtons account={account} />
          {account.billingPortal && (
            <Button size="sm" icon="external" loading={busy === 'portal'} onClick={() => void run('portal', () => call('account.portal').then((r) => openExternal(r.url)))}>
              Manage billing
            </Button>
          )}
          <Button size="sm" variant="ghost" icon="refresh" loading={busy === 'sync'} onClick={() => void run('sync', () => call('account.refresh'))}>
            Check now
          </Button>
        </div>
        {account.canBuy && !atLeast(account.tier, 'ultra') && (
          <p className="fx-muted" style={{ margin: '10px 0 0', fontSize: 12.5 }}>
            The checkout opens in your browser. Once it is done, this computer turns on what you bought by itself.
          </p>
        )}
      </Card>
      <SignedInDevices />
      {account.memberships.length === 0 && <StartOrganization />}
      {account.memberships.length > 0 && (
        <Card title="Your organizations" subtitle="Organizations that gave your account an edition. Join this computer to one and it runs that edition, looked after by its FBRX Command.">
          <div className="fx-form">
            {account.memberships.map((m) => {
              const here = fleet?.tenantId === m.tenantId;
              return (
                <div key={m.tenantId} className="account-org">
                  <div>
                    <strong>{m.tenantName}</strong> <span className={`tier-badge ${m.tier}`}>{TIER_SHORT[m.tier]}</span>
                  </div>
                  {here ? (
                    <Status tone="good">This computer is in it</Status>
                  ) : (
                    <Button size="sm" icon="users" disabled={fleet?.state !== 'unenrolled'} loading={busy === m.tenantId} onClick={() => void run(m.tenantId, () => call('account.join', { tenantId: m.tenantId }), `Joined ${m.tenantName}`)}>
                      Join this computer
                    </Button>
                  )}
                </div>
              );
            })}
            {fleet?.state !== 'unenrolled' && !account.memberships.some((m) => m.tenantId === fleet?.tenantId) && (
              <p className="fx-muted" style={{ margin: 0, fontSize: 12.5 }}>
                This computer is in another organization already.
              </p>
            )}
          </div>
        </Card>
      )}
      <LocalAccountCard />
    </>
  );
}

/**
 * The offline account: a local identity for running FBRX with no cloud (a local-only environment, or the Beta before
 * the account server is live). It pairs with a license key for its edition. An optional password locks FBRX on start.
 * Separate from the cloud FBRX account above.
 */
function LocalAccountCard() {
  const { data: local } = useCore('localAccount.status', undefined, ['localAccount.changed']);
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const [pw, setPw] = useState({ current: '', next: '' });
  const [editingPw, setEditingPw] = useState(false);
  if (!local) return null;

  if (!local.exists) {
    return (
      <Card title="Offline account" subtitle="For running FBRX without the cloud — a local-only computer, or the Beta before online accounts open. It pairs with a license key for its edition and never leaves this computer.">
        {creating ? (
          <form
            className="fx-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run('make', () => call('localAccount.create', { name: f.name, email: f.email || undefined, password: f.password || undefined }), 'Offline account created').then(() => setCreating(false));
            }}
          >
            <Field label="Name">
              <Input value={f.name} maxLength={120} autoComplete="off" onChange={(e) => setF({ ...f, name: e.target.value })} />
            </Field>
            <Field label="Email" help="Optional, only to recognize you. It is never sent anywhere.">
              <Input value={f.email} maxLength={200} autoComplete="off" onChange={(e) => setF({ ...f, email: e.target.value })} />
            </Field>
            <Field label="Start password" help="Optional. FBRX asks for it each time it starts.">
              <Input type="password" value={f.password} autoComplete="new-password" onChange={(e) => setF({ ...f, password: e.target.value })} />
            </Field>
            <div className="fx-actions">
              <Button type="submit" variant="primary" icon="user" loading={busy === 'make'} disabled={!f.name.trim()}>
                Create it
              </Button>
              <Button variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <Button size="sm" icon="user" onClick={() => setCreating(true)}>
            Make an offline account
          </Button>
        )}
      </Card>
    );
  }

  const a = local.account!;
  return (
    <Card
      title={a.name}
      subtitle={a.email ?? 'Offline account on this computer'}
      actions={
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void confirm({ title: 'Remove this offline account?', body: 'Its name and start password are deleted from this computer. Your license and settings are not touched.', confirmLabel: 'Remove', danger: true }).then((ok) => {
              if (ok) void run('rm', () => call('localAccount.remove', { confirm: 'DELETE' }), 'Offline account removed');
            })
          }
        >
          Remove
        </Button>
      }
    >
      <Callout tone="info">Offline account — for local, licensed use with no cloud. Add a license key under Settings → License to set its edition.</Callout>
      <div className="fx-form" style={{ marginTop: 10 }}>
        <Toggle
          checked={a.passwordOnStart}
          onChange={(on) => {
            if (on) setEditingPw(true);
            else
              void confirm({
                title: 'Turn off the start password',
                body: (
                  <Field label="Current password">
                    <Input type="password" autoComplete="current-password" onChange={(e) => setPw((v) => ({ ...v, current: e.target.value }))} />
                  </Field>
                ),
                confirmLabel: 'Turn it off',
              }).then((ok) => {
                if (ok) void run('pwoff', () => call('localAccount.clearPassword', { current: pw.current }), 'Start password turned off').finally(() => setPw({ current: '', next: '' }));
              });
          }}
          label="Ask for a password when FBRX starts"
        />
        {editingPw && (
          <form
            className="fx-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run('pwon', () => call('localAccount.setPassword', { password: pw.next, current: a.passwordOnStart ? pw.current : undefined }), 'Start password set')
                .then(() => setEditingPw(false))
                .finally(() => setPw({ current: '', next: '' }));
            }}
          >
            {a.passwordOnStart && (
              <Field label="Current password">
                <Input type="password" value={pw.current} autoComplete="current-password" onChange={(e) => setPw({ ...pw, current: e.target.value })} />
              </Field>
            )}
            <Field label="New start password" help="At least 4 characters.">
              <Input type="password" value={pw.next} autoComplete="new-password" onChange={(e) => setPw({ ...pw, next: e.target.value })} />
            </Field>
            <div className="fx-actions">
              <Button type="submit" size="sm" variant="primary" loading={busy === 'pwon'} disabled={pw.next.length < 4}>
                Save password
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => (setEditingPw(false), setPw({ current: '', next: '' }))}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </div>
      {dialog}
    </Card>
  );
}

const DEVICE_ICON: Record<AccountDevice['kind'], IconName> = { computer: 'laptop', phone: 'phone', website: 'globe' };

/** Where the account is signed in (computers, phones, the website), and signing one of them out. */
function SignedInDevices() {
  const [devices, setDevices] = useState<AccountDevice[] | null>(null);
  const { run, busy } = useAction();
  const load = () => call('account.devices').then(setDevices, () => setDevices(null));
  useEffect(() => void load(), []);
  if (!devices) return null;
  return (
    <Card title="Signed in on" subtitle="Computers, phones and browsers signed in to your FBRX account. Signing one out stops it renewing what the account bought.">
      <div className="fx-form">
        {devices.map((d) => {
          const Ico = Icons[DEVICE_ICON[d.kind]];
          return (
            <div key={d.id} className="account-org">
              <div>
                <Ico size={14} /> <strong>{d.name || 'Unnamed'}</strong>{' '}
                <span className="fx-muted" style={{ fontSize: 12.5 }}>
                  {[d.platform, d.appVersion && `FBRX ${d.appVersion}`, d.lastSeenAt && `seen ${timeAgo(d.lastSeenAt)}`].filter(Boolean).join(' · ')}
                </span>
              </div>
              {d.current ? (
                <Status tone="good">This computer</Status>
              ) : (
                <Button size="sm" variant="ghost" loading={busy === d.id} onClick={() => void run(d.id, () => call('account.signOutDevice', { id: d.id }).then(load), `Signed out of ${d.name || 'it'}`)}>
                  Sign out
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/** Starts an FBRX Command for the person's organization: they own it, and its console opens in the browser. */
function StartOrganization() {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<{ name: string; kind: Vertical }>({ name: '', kind: 'business' });
  const { run, busy } = useAction();
  return (
    <Card title="Run FBRX for your organization" subtitle={`FBRX Command looks after your company’s, school’s or family’s computers: ${formatPrice(COMMAND_PLAN.monthly)} a month, each computer at its edition with ${Math.round(TENANT_DISCOUNT * 100)}% off, Essentials computers free.`}>
      {open ? (
        <form
          className="fx-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run('org', () => call('account.startOrganization', f).then((r) => openExternal(r.consoleUrl)), 'Your FBRX Command is ready: its console opens in your browser');
          }}
        >
          <Field label="Organization name">
            <Input value={f.name} maxLength={120} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="Kind">
            <div className="seg" role="group" aria-label="Kind">
              {VERTICALS.map((k) => (
                <button key={k} type="button" className={f.kind === k ? 'on' : ''} onClick={() => setF({ ...f, kind: k })}>
                  {VERTICAL_NAMES[k]}
                </button>
              ))}
            </div>
          </Field>
          <div className="fx-actions">
            <Button type="submit" variant="primary" loading={busy === 'org'} disabled={!f.name.trim()}>
              Start my FBRX Command
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button size="sm" icon="globe" onClick={() => setOpen(true)}>
          Start an FBRX Command
        </Button>
      )}
    </Card>
  );
}
