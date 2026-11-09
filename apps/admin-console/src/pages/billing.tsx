import { useState } from 'react';
import { EDITION_PLANS, SERVER_OFFER, TIERS, TIER_NAMES, TIER_SHORT, extraComputers, formatPrice, licenseEditionFor, tierRank, type AccountView, type AddMemberResult, type BillLine, type BillingInterval, type InvitationView, type MemberView, type PriceBook, type TenantPlanView, type Tier } from '@fbrx/shared';
import { Button, Callout, Card, ChoiceCards, CopyText, Empty, Field, Grid, Input, KeyValue, Modal, Page, Select, StatTile, Status, Table, formatDay, useAction, useConfirm } from '@fbrx/ui';
import { api } from '../api';
import { useApp, useQuery } from '../state';

interface BillingInfo {
  plan: TenantPlanView;
  /** Payments are set up on this FBRX Command. */
  payments: boolean;
}

/** The editions to give, each with its price per person and the computers it includes, as the operator set them. */
function useTierOptions() {
  const prices = useQuery<{ prices: PriceBook }>('/v1/plans').data?.prices;
  const options = TIERS.map((t) => {
    const each = t === 'essentials' ? 0 : (prices?.seats[t] ?? EDITION_PLANS[t].tenantMonthly);
    const included = t === 'essentials' ? null : prices?.computers.included[t];
    return { value: t, label: `${TIER_SHORT[t]} · ${each ? `${formatPrice(each)} a month${included ? `, ${included} computers` : ''}` : 'free'}` };
  });
  return { options, prices };
}

/** A member's computers, and how many of them are past what their edition includes. */
function memberComputers(m: MemberView, prices: PriceBook | undefined) {
  if (m.tier === 'essentials' || !prices) return m.devices;
  const extra = extraComputers(prices, m.tier, m.devices);
  return extra ? `${m.devices} (${extra} extra, ${formatPrice(prices.computers.extra[m.tier] * extra)} a month)` : m.devices;
}

/** What a line of the bill is for. */
function lineName(l: BillLine) {
  if (l.item === 'fee') return 'The organization fee';
  if (l.item === 'mdm') return 'The MDM add-on';
  const badge = <span className={`fx-badge${l.tier === 'blackhole' ? ' accent' : ''}`}>{TIER_NAMES[l.tier!]}</span>;
  return l.item === 'extra' ? <>{badge} computers past those included</> : badge;
}

/** How many a line counts: people and shared computers, or computers. */
function lineCount(l: BillLine) {
  if (l.item === 'fee') return '—';
  if (l.item !== 'seats') return `${l.quantity} ${l.quantity === 1 ? 'computer' : 'computers'}`;
  const parts = [l.people ? `${l.people} ${l.people === 1 ? 'person' : 'people'}` : '', l.shared ? `${l.shared} shared ${l.shared === 1 ? 'computer' : 'computers'}` : ''];
  return parts.filter(Boolean).join(', ');
}

/** FBRX Server: announced, not for sale yet. */
export function ServerComingSoon() {
  return (
    <Card title="FBRX Server is coming" subtitle="Not available yet">
      <p className="fx-secondary" style={{ marginTop: 0 }}>
        {SERVER_OFFER.summary}
      </p>
      <ul className="fx-secondary" style={{ margin: '0 0 10px', paddingLeft: 18 }}>
        {SERVER_OFFER.highlights.map((h) => (
          <li key={h}>{h}</li>
        ))}
      </ul>
    </Card>
  );
}

/** "a month", "a year". */
const per = (i: BillingInterval) => `a ${i}`;

/** Billing: the organization's FBRX Command plan and what its people and computers come to. */
export function BillingPage() {
  const app = useApp();
  /** How to pay, before the plan starts (the bill is shown that way). */
  const [choice, setChoice] = useState<BillingInterval>('month');
  const q = useQuery<BillingInfo>(`/v1/admin/billing?interval=${choice}`, [choice]);
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const b = q.data;
  const manage = app.can('billing.manage');
  const open = (path: string, key: string, body?: unknown) => run(key, () => api<{ url: string }>('POST', path, body).then((r) => void (location.href = r.url)));
  if (!b) return <Page title="Billing">{null}</Page>;
  const p = b.plan;
  const paid = p.bill.paid;
  const other: BillingInterval = p.interval === 'year' ? 'month' : 'year';
  /** Moves the running plan to the other interval, once the owner agrees to what Stripe does. */
  const switchInterval = async () => {
    const ok = await confirm({
      title: other === 'year' ? 'Pay yearly?' : 'Pay monthly?',
      body:
        other === 'year'
          ? `The plan is billed once a year from today: ${formatPrice(p.totals.year)} a year for today's people and computers (${p.yearlyMonths} months' price). Stripe charges the year now, less what is left of this month.`
          : `The plan is billed each month from today: ${formatPrice(p.totals.month)} a month for today's people and computers. Stripe credits what is left of the year to the coming invoices.`,
      confirmLabel: other === 'year' ? 'Pay yearly' : 'Pay monthly',
    });
    if (ok) await run('interval', () => api('POST', '/v1/admin/billing/interval', { interval: other }).then(q.reload), other === 'year' ? 'The plan is paid yearly' : 'The plan is paid monthly');
  };
  return (
    <Page
      title="Billing"
      description="Your organization fee covers your FBRX Command; each person is billed at their edition, on as many computers as it includes, with a volume discount once you have more of them. Pay monthly or yearly. Essentials is free."
      actions={
        manage && p.billing === 'cloud' ? (
          p.active || p.portal ? (
            <Button icon="external" loading={busy === 'portal'} onClick={() => void open('/v1/admin/billing/portal', 'portal')}>
              Manage billing
            </Button>
          ) : (
            <Button variant="primary" icon="sparkles" disabled={!b.payments} loading={busy === 'start'} onClick={() => void open('/v1/admin/billing/checkout', 'start', { interval: choice })}>
              {choice === 'year' ? 'Start the FBRX Command plan, yearly' : 'Start the FBRX Command plan'}
            </Button>
          )
        ) : undefined
      }
    >
      {dialog}
      {p.billing === 'manual' ? (
        <Card title="Licenses from your FBRX Command operator">
          <p className="fx-secondary" style={{ margin: 0 }}>
            This organization’s computers run what its licenses allow (Licenses). There is no plan to pay here.
          </p>
        </Card>
      ) : (
        <>
          <Grid cols={3}>
            <StatTile
              label="The FBRX Command plan"
              value={p.active ? 'Running' : 'Not started'}
              foot={
                p.active ? (
                  p.status === 'grace' ? (
                    <Status tone="warning">A payment failed: update your card in Manage billing</Status>
                  ) : (
                    `Paid ${p.interval === 'year' ? 'yearly' : 'monthly'}, renews ${formatDay(p.periodEnd)}`
                  )
                ) : (
                  'Until it starts, every computer runs Essentials'
                )
              }
            />
            <StatTile
              label={p.interval === 'year' ? 'A year comes to' : 'A month comes to'}
              value={formatPrice(p.bill.total)}
              foot={`The organization fee, and ${paid} ${paid === 1 ? 'seat' : 'seats'} at a paid edition${p.bill.percentOff ? `, ${p.bill.percentOff}% off` : ''}`}
            />
            <StatTile label="Essentials computers" value={p.computers.essentials} foot="Free, as many as you like" />
          </Grid>
          {!b.payments && <Status tone="warning">Payments are not set up on this FBRX Command yet.</Status>}
          {!p.active && manage && (
            <Card title="How often to pay" subtitle="Everything on the plan is paid the same way. You can change it later.">
              <ChoiceCards
                label="How often to pay"
                value={choice}
                onChange={setChoice}
                options={[
                  { value: 'month', title: 'Monthly', description: `${formatPrice(p.totals.month)} a month for today's people and computers` },
                  { value: 'year', title: 'Yearly', description: `${formatPrice(p.totals.year)} a year: ${p.yearlyMonths} months' price${p.yearlyMonths < 12 ? `, ${12 - p.yearlyMonths} free` : ''}` },
                ]}
              />
            </Card>
          )}
          <Card
            title="What it comes to"
            subtitle="Each member at their edition, on as many computers as it includes; each further computer they use; and each shared, lab or student computer at the edition you give it (Members, Devices, Profiles & groups). Student and child computers count as Pro. It follows by itself; changes are prorated."
            actions={
              manage && p.active ? (
                <Button size="sm" loading={busy === 'interval'} onClick={() => void switchInterval()}>
                  {other === 'year' ? `Pay yearly, ${formatPrice(p.totals.year)} a year` : 'Pay monthly'}
                </Button>
              ) : undefined
            }
            flush
          >
            <Table
              rows={p.bill.lines.filter((l) => l.item === 'fee' || l.item === 'mdm' || l.quantity > 0)}
              rowKey={(l) => `${l.item}${l.tier ?? ''}`}
              columns={[
                { key: 'w', header: 'What', render: lineName },
                { key: 'n', header: 'For', render: lineCount },
                { key: 'e', header: `Each, ${per(p.interval)}`, render: (l) => formatPrice(l.each) + (l.item === 'mdm' ? ' (any edition, in groups managed with it)' : l.percentOff ? ` (volume discount: ${l.percentOff}% off)` : '') },
                { key: 't', header: p.interval === 'year' ? 'A year' : 'A month', render: (l) => <strong>{formatPrice(l.total)}</strong> },
              ]}
            />
          </Card>
        </>
      )}
      <Grid cols={2}>
        <Card title="Black Hole Edition, for the people who run your FBRX Command">
          <p className="fx-secondary" style={{ marginTop: 0 }}>
            {EDITION_PLANS.blackhole.summary} It is an add-on here, per computer: give it to your admins in Members (it comes on wherever they sign in) or to a computer in Devices.
          </p>
          <ul className="fx-secondary" style={{ margin: 0, paddingLeft: 18 }}>
            {EDITION_PLANS.blackhole.highlights.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </Card>
        <ServerComingSoon />
      </Grid>
    </Page>
  );
}

/**
 * Members: FBRX accounts the organization gives an edition; it comes on wherever they sign in. Someone without a
 * confirmed FBRX account is invited: a code they enter in FBRX OS makes their account and joins them (no website or
 * email needed; it is emailed too when this FBRX Command sends email).
 */
export function MembersPage() {
  const app = useApp();
  const q = useQuery<MemberView[]>('/v1/admin/members');
  const { options: tierOptions, prices } = useTierOptions();
  // The organization's license is the most its computers run (the newest one in force, as computers get it): a member
  // given more than it allows runs what it allows. Said here, with the license that fixes it one click away.
  const lic = useQuery<Array<{ tier: Tier; vertical: string; revokedAt: string | null; expiresAt: string | null }>>(app.can('licenses.read') ? '/v1/admin/licenses' : null);
  const current = lic.data?.find((l) => !l.revokedAt && (!l.expiresAt || Date.parse(l.expiresAt) > Date.now())) ?? null;
  const held = lic.data ? (q.data ?? []).filter((m) => m.tier !== 'essentials' && (!current || tierRank(m.tier) > tierRank(current.tier))) : [];
  const needed = held.reduce<Tier>((t, m) => (tierRank(m.tier) > tierRank(t) ? m.tier : t), 'essentials');
  const invites = useQuery<InvitationView[]>('/v1/admin/invitations');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<{ email: string; tier: Tier }>({ email: '', tier: 'essentials' });
  const [invited, setInvited] = useState<Extract<AddMemberResult, { kind: 'invited' }> | null>(null);
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const add = async () => {
    const r = await run('add', () => api<AddMemberResult>('POST', '/v1/admin/invitations', form), undefined);
    if (!r) return;
    setAdding(false);
    setForm({ email: '', tier: 'essentials' });
    if (r.kind === 'invited') setInvited(r);
    q.reload();
    invites.reload();
  };
  const pending = invites.data ?? [];
  return (
    <Page
      title="Members"
      description="People with an FBRX account who belong to this organization. Give each an edition: when they sign in on a computer and join it here, it runs that edition. Essentials members are free."
      actions={
        <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
          Add a member
        </Button>
      }
    >
      {held.length > 0 && (
        <Callout
          tone="warning"
          title={current ? `This organization's license allows up to ${TIER_NAMES[current.tier]}` : 'This organization has no license yet'}
          actions={
            app.can('licenses.manage') && (
              <Button
                size="sm"
                variant="primary"
                icon="key"
                loading={busy === 'license'}
                onClick={() =>
                  void run(
                    'license',
                    () =>
                      api('POST', '/v1/admin/licenses', { edition: licenseEditionFor(needed), tier: needed, seats: 0, ...(current && current.vertical !== 'business' ? { vertical: current.vertical } : {}) }).then(() => lic.reload()),
                    `License for ${TIER_NAMES[needed]} issued: computers pick it up at their next check-in`,
                  )
                }
              >
                Issue a {TIER_SHORT[needed]} license
              </Button>
            )
          }
        >
          {held.map((m) => m.name || m.email).join(', ')} {held.length === 1 ? 'is' : 'are'} given more than it allows, so their computers run {current ? TIER_NAMES[current.tier] : 'Essentials'}. A license for {TIER_NAMES[needed]} lets each run the edition given here.
        </Callout>
      )}
      <Card flush>
        <Table
          rows={q.data ?? []}
          rowKey={(m) => m.accountId}
          empty={<Empty title="No members yet">Add the people who use your computers by their email. Without an FBRX account yet, they get an invitation code.</Empty>}
          columns={[
            { key: 'n', header: 'Member', render: (m) => (<div><div className="fx-cell-title">{m.name}</div><div className="fx-cell-sub">{m.email}</div></div>) },
            {
              key: 't',
              header: 'Edition',
              render: (m) => (
                <div style={{ width: 270 }}>
                  <Select aria-label={`Edition for ${m.email}`} value={m.tier} options={tierOptions} onChange={(e) => void run(m.accountId, () => api('PATCH', `/v1/admin/members/${m.accountId}`, { tier: e.target.value }).then(q.reload), 'Edition changed')} />
                </div>
              ),
            },
            { key: 'd', header: 'Computers', render: (m) => memberComputers(m, prices) },
            {
              key: 'x',
              header: '',
              render: (m) => (
                <Button
                  size="sm"
                  variant="danger"
                  loading={busy === `rm-${m.accountId}`}
                  onClick={async () => {
                    if (await confirm({ title: `Remove ${m.name}?`, body: 'Their computers stay in the organization, on Essentials, until you remove them.', confirmLabel: 'Remove', danger: true })) {
                      void run(`rm-${m.accountId}`, () => api('DELETE', `/v1/admin/members/${m.accountId}`).then(q.reload), 'Member removed');
                    }
                  }}
                >
                  Remove
                </Button>
              ),
            },
          ]}
        />
      </Card>
      {pending.length > 0 && (
        <Card title="Invitations" subtitle="Waiting for the person to enter their code in FBRX OS (Settings → Account → I have an invitation)." flush>
          <Table
            rows={pending}
            rowKey={(i) => i.id}
            columns={[
              { key: 'e', header: 'Email', render: (i) => i.email },
              { key: 't', header: 'Edition', render: (i) => TIER_SHORT[i.tier] },
              { key: 's', header: 'Code works until', render: (i) => (i.status === 'expired' ? <Status tone="warning">Expired: invite again</Status> : formatDay(i.expiresAt)) },
              { key: 'b', header: 'Made by', render: (i) => i.createdBy },
              {
                key: 'x',
                header: '',
                render: (i) => (
                  <Button size="sm" variant="danger" loading={busy === `inv-${i.id}`} onClick={() => void run(`inv-${i.id}`, () => api('DELETE', `/v1/admin/invitations/${i.id}`).then(invites.reload), 'Invitation withdrawn')}>
                    Withdraw
                  </Button>
                ),
              },
            ]}
          />
        </Card>
      )}
      {adding && (
        <Modal
          title="Add a member"
          onClose={() => setAdding(false)}
          footer={
            <Button variant="primary" loading={busy === 'add'} disabled={!form.email} onClick={() => void add()}>
              Add
            </Button>
          }
        >
          <div className="fx-form">
            <Field label="Their email" help="With a confirmed FBRX account, they are added now. Otherwise you get an invitation code to give them: it makes their account in FBRX OS.">
              <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value.trim() })} />
            </Field>
            <Field label="Edition" help="Black Hole Edition is for the people who run this FBRX Command and its servers.">
              <Select value={form.tier} options={tierOptions} onChange={(e) => setForm({ ...form, tier: e.target.value as Tier })} />
            </Field>
          </div>
        </Modal>
      )}
      {invited && (
        <Modal title={`Invitation for ${invited.invitation.email}`} onClose={() => setInvited(null)} footer={<Button variant="primary" onClick={() => setInvited(null)}>Done</Button>}>
          <Callout tone={invited.emailed ? 'good' : 'info'} title={invited.emailed ? 'Emailed to them' : 'Give them this code'}>
            {invited.emailed
              ? 'FBRX sent them the code. It is shown here once too, in case it does not arrive.'
              : 'This FBRX Command does not send email, so pass the code on yourself (a message, a call, a note). It is shown only now.'}
          </Callout>
          <KeyValue
            items={[
              ['Invitation code', <CopyText key="c" value={invited.code} />],
              ['FBRX Command', <CopyText key="u" value={invited.server} />],
              ['Edition', TIER_NAMES[invited.invitation.tier]],
              ['Works until', formatDay(invited.invitation.expiresAt)],
            ]}
          />
          <p className="fx-secondary" style={{ marginBottom: 0 }}>
            In FBRX OS they open <strong>Settings → Account → I have an invitation</strong> and enter the code (and this FBRX Command&apos;s address, if FBRX asks). It makes their FBRX account, or uses the one they have, and joins their computer here at this edition.
          </p>
        </Modal>
      )}
      {dialog}
    </Page>
  );
}

/** The edition given to an account now ("Ultra until Dec 9, 2026"), or null. */
function givenLine(entitlements: AccountView['entitlements']): string | null {
  const g = entitlements.find((e) => e.source === 'grant' && e.valid && e.tier);
  return g ? `${TIER_SHORT[g.tier!]}${g.periodEnd ? ` until ${formatDay(g.periodEnd)}` : ', no end'}` : null;
}

/** Platform view: FBRX accounts, what they bought, and giving one an edition (support, a promotion). */
export function AccountsPage() {
  const [search, setSearch] = useState('');
  const q = useQuery<Array<AccountView & { status: string }>>(`/v1/admin/accounts${search ? `?q=${encodeURIComponent(search)}` : ''}`, [search]);
  const [grant, setGrant] = useState<{ id: string; email: string; tier: 'essentials' | 'basic' | 'ultra'; days: string; given: string | null } | null>(null);
  const { run, busy } = useAction();
  return (
    <Page
      title="FBRX accounts"
      description="Everyone with an FBRX account on this FBRX Command: what they bought themselves, and the edition each organization gives them. People in an organization get their edition, Black Hole Edition included, from its Members page."
      actions={<div style={{ width: 280 }}><Input placeholder="Search by email or name" value={search} onChange={(e) => setSearch(e.target.value)} /></div>}>
      <Card flush>
        <Table
          rows={q.data ?? []}
          rowKey={(a) => a.id}
          empty={<Empty title="No accounts">People make FBRX accounts in FBRX, in the phone apps or on the website.</Empty>}
          columns={[
            { key: 'n', header: 'Account', render: (a) => (<div><div className="fx-cell-title">{a.name}</div><div className="fx-cell-sub">{a.email}</div></div>) },
            { key: 't', header: 'Their own', render: (a) => <span className={`fx-badge${a.tier === 'essentials' ? '' : ' accent'}`}>{TIER_SHORT[a.tier]}</span> },
            { key: 'p', header: 'Purchases', render: (a) => a.entitlements.filter((e) => e.valid).map((e) => `${e.productId} (${e.source})`).join(', ') || '—' },
            {
              key: 'o',
              header: 'From organizations',
              render: (a) =>
                a.memberships.length ? (
                  <div className="fx-actions" style={{ gap: 4 }}>
                    {a.memberships.map((m) => (
                      <span key={m.tenantId} className={`fx-badge${m.tier === 'essentials' ? '' : ' accent'}`} title={`Set on ${m.tenantName}'s Members page`}>
                        {m.tenantName}: {TIER_SHORT[m.tier]}
                      </span>
                    ))}
                  </div>
                ) : (
                  '—'
                ),
            },
            { key: 's', header: 'Status', render: (a) => <Status tone={a.status !== 'active' ? 'warning' : a.emailVerified ? 'good' : 'neutral'}>{a.status !== 'active' ? a.status : a.emailVerified ? 'active' : 'email not confirmed'}</Status> },
            {
              key: 'x',
              header: '',
              render: (a) => (
                <div className="fx-actions">
                  <Button size="sm" onClick={() => setGrant({ id: a.id, email: a.email, tier: 'ultra', days: '30', given: givenLine(a.entitlements) })}>
                    Give an edition
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void run(`s-${a.id}`, () => api('POST', `/v1/admin/accounts/${a.id}/status`, { status: a.status === 'active' ? 'disabled' : 'active' }).then(q.reload))}>
                    {a.status === 'active' ? 'Disable' : 'Enable'}
                  </Button>
                </div>
              ),
            },
          ]}
        />
      </Card>
      {grant && (
        <Modal
          title={`Give ${grant.email} an edition`}
          onClose={() => setGrant(null)}
          footer={
            <Button variant="primary" loading={busy === 'grant'} onClick={() => void run('grant', () => api('POST', `/v1/admin/accounts/${grant.id}/grant`, { tier: grant.tier, days: grant.days ? Number(grant.days) : null }).then(() => (setGrant(null), q.reload())), grant.tier === 'essentials' ? 'Given edition taken back' : 'Edition given')}>
              {grant.tier === 'essentials' ? 'Take it back' : 'Give'}
            </Button>
          }
        >
          <div className="fx-form">
            <Callout tone="info">
              This is for the person on their own (a promotion, or support), as if they had bought it. In an organization, the edition comes from its <strong>Members</strong> page instead, and Black Hole Edition only ever comes that way.
            </Callout>
            <Field label="Edition" help={grant.given ? `Now given: ${grant.given}. Giving one replaces it.` : 'What they bought themselves is not touched.'}>
              <Select
                value={grant.tier}
                options={[...(['basic', 'ultra'] as const).map((t) => ({ value: t, label: TIER_SHORT[t] })), ...(grant.given ? [{ value: 'essentials', label: 'None: take the given edition back' }] : [])]}
                onChange={(e) => setGrant({ ...grant, tier: e.target.value as 'essentials' | 'basic' | 'ultra' })}
              />
            </Field>
            {grant.tier !== 'essentials' && (
              <Field label="For how many days" help="Empty: no end.">
                <Input type="number" min={1} value={grant.days} onChange={(e) => setGrant({ ...grant, days: e.target.value })} />
              </Field>
            )}
          </div>
        </Modal>
      )}
    </Page>
  );
}
