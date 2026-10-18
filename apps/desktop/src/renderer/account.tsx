import { useState, type ReactNode } from 'react';
import { COMMAND_PLAN, EDITION_PLANS, TENANT_DISCOUNT, TIER_NAMES, TIER_SHORT, VERTICALS, VERTICAL_NAMES, atLeast, formatPrice, type AccountStatus, type Tier, type Vertical } from '@fbrx/shared';
import { Button, Card, Field, Input, KeyValue, Status, formatDate, formatDay, useAction } from '@fbrx/ui';
import { call, openExternal } from './client';
import { useCore } from './hooks';

/**
 * The person's FBRX account on this computer. Signing in brings whatever the account bought (on the website, another
 * computer or a phone) and turns that edition on; buying from here opens the website's checkout in the browser.
 */
export function useAccount(): AccountStatus | null {
  return useCore('account.status', undefined, ['account.changed', 'license.changed']).data;
}

/** Sign in, or make an account (`create`). Asks for the FBRX Command address only when none is built in. */
export function AccountSignInForm({ onDone, extraActions, startCreating = false }: { onDone?: () => void; extraActions?: ReactNode; startCreating?: boolean }) {
  const account = useAccount();
  const [creating, setCreating] = useState(startCreating);
  const [f, setF] = useState({ server: '', email: '', password: '', name: '' });
  const { run, busy } = useAction();
  const needServer = !account?.server;
  const submit = () =>
    run(
      'signin',
      () =>
        call('account.signIn', { email: f.email, password: f.password, ...(needServer || f.server ? { server: f.server } : {}), ...(creating ? { create: true, name: f.name } : {}) }).then((s) => {
          onDone?.();
          return s;
        }),
      creating ? 'Your FBRX account is ready' : 'Signed in',
    );
  return (
    <form
      className="fx-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {needServer && (
        <Field label="FBRX Command address" help="Where your FBRX account lives, such as https://command.example.com">
          <Input value={f.server} placeholder="https://" onChange={(e) => setF({ ...f, server: e.target.value.trim() })} />
        </Field>
      )}
      {creating && (
        <Field label="Your name">
          <Input value={f.name} maxLength={120} autoComplete="name" onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
      )}
      <Field label="Email">
        <Input type="email" value={f.email} autoComplete="email" onChange={(e) => setF({ ...f, email: e.target.value })} />
      </Field>
      <Field label="Password" help={creating ? 'At least 12 characters' : undefined}>
        <Input type="password" value={f.password} autoComplete={creating ? 'new-password' : 'current-password'} onChange={(e) => setF({ ...f, password: e.target.value })} />
      </Field>
      <div className="fx-actions">
        <Button type="submit" variant="primary" icon="key" loading={busy === 'signin'} disabled={!f.email || !f.password || (needServer && !f.server)}>
          {creating ? 'Make my account' : 'Sign in'}
        </Button>
        <Button variant="ghost" onClick={() => setCreating(!creating)}>
          {creating ? 'I have an account' : 'Make an account'}
        </Button>
        {extraActions}
      </div>
    </form>
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
      <Card title="Your FBRX account" subtitle="Sign in to bring what you bought (on the website, on another computer or on your phone) to this computer. It turns that edition on here too.">
        {account.error && <Status tone="warning">{account.error}</Status>}
        <AccountSignInForm />
      </Card>
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
    </>
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
