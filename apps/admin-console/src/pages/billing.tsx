import { useState } from 'react';
import { COMMAND_PLAN, EDITION_PLANS, SERVER_OFFER, TENANT_DISCOUNT, TIERS, TIER_NAMES, TIER_SHORT, formatPrice, type AccountView, type MemberView, type TenantPlanView, type Tier } from '@fbrx/shared';
import { Button, Card, Empty, Field, Grid, Input, Modal, Page, Select, StatTile, Status, Table, formatDay, useAction, useConfirm } from '@fbrx/ui';
import { api } from '../api';
import { useApp, useQuery } from '../state';

interface BillingInfo {
  plan: TenantPlanView;
  /** Payments are set up on this FBRX Command. */
  payments: boolean;
}

const tierOptions = TIERS.map((t) => ({ value: t, label: `${TIER_SHORT[t]} · ${EDITION_PLANS[t].tenantMonthly ? `${formatPrice(EDITION_PLANS[t].tenantMonthly)} a month` : 'free'}` }));

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
      <p style={{ margin: 0 }}>
        <strong>{formatPrice(SERVER_OFFER.price)} once</strong>
        <span className="fx-secondary">: the installer stays on your FBRX Command (or your FBRX account) for good.</span>
      </p>
    </Card>
  );
}

/** Billing: the organization's FBRX Command plan and what its computers come to. */
export function BillingPage() {
  const app = useApp();
  const q = useQuery<BillingInfo>('/v1/admin/billing');
  const { run, busy } = useAction();
  const b = q.data;
  const manage = app.can('billing.manage');
  const open = (path: string, key: string) => run(key, () => api<{ url: string }>('POST', path).then((r) => void (location.href = r.url)));
  if (!b) return <Page title="Billing">{null}</Page>;
  const p = b.plan;
  const lines = (['basic', 'ultra', 'blackhole'] as const).map((t) => ({ tier: t, n: p.computers[t], each: EDITION_PLANS[t].tenantMonthly }));
  return (
    <Page
      title="Billing"
      description={`Your FBRX Command plan is ${formatPrice(COMMAND_PLAN.monthly)} a month, and each computer is billed at its edition: Standard and Ultra at ${Math.round(TENANT_DISCOUNT * 100)}% off, Black Hole as an add-on at full price, Essentials free.`}
      actions={
        manage && p.billing === 'cloud' ? (
          p.active || p.portal ? (
            <Button icon="external" loading={busy === 'portal'} onClick={() => void open('/v1/admin/billing/portal', 'portal')}>
              Manage billing
            </Button>
          ) : (
            <Button variant="primary" icon="sparkles" disabled={!b.payments} loading={busy === 'start'} onClick={() => void open('/v1/admin/billing/checkout', 'start')}>
              Start the FBRX Command plan
            </Button>
          )
        ) : undefined
      }
    >
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
              foot={p.active ? (p.status === 'grace' ? <Status tone="warning">A payment failed: update your card in Manage billing</Status> : `Renews ${formatDay(p.periodEnd)}`) : 'Until it starts, every computer runs Essentials'}
            />
            <StatTile label="A month comes to" value={formatPrice(p.monthly)} foot={`The plan, and ${lines.reduce((n, l) => n + l.n, 0)} computers at a paid edition`} />
            <StatTile label="Essentials computers" value={p.computers.essentials} foot="Free, as many as you like" />
          </Grid>
          {!b.payments && <Status tone="warning">Payments are not set up on this FBRX Command yet.</Status>}
          <Card title="What it comes to" subtitle="Counted from the editions you give computers and members (Members, Devices, Profiles & groups); student and child computers count as Standard. It follows by itself; changes are prorated." flush>
            <Table
              rows={[{ tier: 'command' as const, n: 1, each: COMMAND_PLAN.monthly }, ...lines]}
              rowKey={(l) => l.tier}
              columns={[
                { key: 'w', header: 'What', render: (l) => (l.tier === 'command' ? 'The FBRX Command plan' : <span className={`fx-badge${l.tier === 'blackhole' ? ' accent' : ''}`}>{TIER_NAMES[l.tier]}</span>) },
                { key: 'n', header: 'Computers', render: (l) => (l.tier === 'command' ? '—' : l.n) },
                { key: 'e', header: 'Each, a month', render: (l) => formatPrice(l.each) + (l.tier === 'blackhole' ? ' (add-on)' : l.tier === 'command' ? '' : ` (${Math.round(TENANT_DISCOUNT * 100)}% off ${formatPrice(EDITION_PLANS[l.tier].monthly!)})`) },
                { key: 't', header: 'A month', render: (l) => <strong>{formatPrice(l.each * l.n)}</strong> },
              ]}
            />
          </Card>
        </>
      )}
      <Grid cols={2}>
        <Card title="Black Hole, for the people who run your FBRX Command">
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

/** Members: FBRX accounts the organization gives an edition; it comes on wherever they sign in. */
export function MembersPage() {
  const q = useQuery<MemberView[]>('/v1/admin/members');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<{ email: string; tier: Tier }>({ email: '', tier: 'essentials' });
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
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
      <Card flush>
        <Table
          rows={q.data ?? []}
          rowKey={(m) => m.accountId}
          empty={<Empty title="No members yet">Add the people who use your computers by the email of their FBRX account.</Empty>}
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
            { key: 'd', header: 'Computers', render: (m) => m.devices },
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
      {adding && (
        <Modal
          title="Add a member"
          onClose={() => setAdding(false)}
          footer={
            <Button
              variant="primary"
              loading={busy === 'add'}
              disabled={!form.email}
              onClick={() =>
                void run('add', () => api('POST', '/v1/admin/members', form).then(() => {
                  setAdding(false);
                  setForm({ email: '', tier: 'essentials' });
                  q.reload();
                }), 'Member added')
              }
            >
              Add
            </Button>
          }
        >
          <div className="fx-form">
            <Field label="Email of their FBRX account" help="They make the account themselves, in FBRX or on the website.">
              <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value.trim() })} />
            </Field>
            <Field label="Edition" help="Black Hole is for the people who run this FBRX Command and its servers.">
              <Select value={form.tier} options={tierOptions} onChange={(e) => setForm({ ...form, tier: e.target.value as Tier })} />
            </Field>
          </div>
        </Modal>
      )}
      {dialog}
    </Page>
  );
}

/** Platform view: FBRX accounts, what they bought, and giving one an edition (support, a promotion). */
export function AccountsPage() {
  const [search, setSearch] = useState('');
  const q = useQuery<Array<AccountView & { status: string }>>(`/v1/admin/accounts${search ? `?q=${encodeURIComponent(search)}` : ''}`, [search]);
  const [grant, setGrant] = useState<{ id: string; email: string; tier: 'basic' | 'ultra'; days: string } | null>(null);
  const { run, busy } = useAction();
  return (
    <Page title="FBRX accounts" description="Everyone with an FBRX account on this FBRX Command, and the edition their own purchases give them." actions={<div style={{ width: 280 }}><Input placeholder="Search by email or name" value={search} onChange={(e) => setSearch(e.target.value)} /></div>}>
      <Card flush>
        <Table
          rows={q.data ?? []}
          rowKey={(a) => a.id}
          empty={<Empty title="No accounts">People make FBRX accounts in FBRX, in the phone apps or on the website.</Empty>}
          columns={[
            { key: 'n', header: 'Account', render: (a) => (<div><div className="fx-cell-title">{a.name}</div><div className="fx-cell-sub">{a.email}</div></div>) },
            { key: 't', header: 'Edition', render: (a) => <span className={`fx-badge${a.tier === 'essentials' ? '' : ' accent'}`}>{TIER_SHORT[a.tier]}</span> },
            { key: 'p', header: 'Purchases', render: (a) => a.entitlements.filter((e) => e.valid).map((e) => `${e.productId} (${e.source})`).join(', ') || '—' },
            { key: 'o', header: 'Organizations', render: (a) => a.memberships.map((m) => m.tenantName).join(', ') || '—' },
            { key: 's', header: 'Status', render: (a) => <Status tone={a.status === 'active' ? 'good' : 'warning'}>{a.status}</Status> },
            {
              key: 'x',
              header: '',
              render: (a) => (
                <div className="fx-actions">
                  <Button size="sm" onClick={() => setGrant({ id: a.id, email: a.email, tier: 'ultra', days: '30' })}>
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
            <Button variant="primary" loading={busy === 'grant'} onClick={() => void run('grant', () => api('POST', `/v1/admin/accounts/${grant.id}/grant`, { tier: grant.tier, days: grant.days ? Number(grant.days) : null }).then(() => (setGrant(null), q.reload())), 'Edition given')}>
              Give
            </Button>
          }
        >
          <div className="fx-form">
            <Field label="Edition">
              <Select value={grant.tier} options={(['basic', 'ultra'] as const).map((t) => ({ value: t, label: TIER_SHORT[t] }))} onChange={(e) => setGrant({ ...grant, tier: e.target.value as 'basic' | 'ultra' })} />
            </Field>
            <Field label="For how many days" help="Empty: no end.">
              <Input type="number" min={1} value={grant.days} onChange={(e) => setGrant({ ...grant, days: e.target.value })} />
            </Field>
          </div>
        </Modal>
      )}
    </Page>
  );
}
