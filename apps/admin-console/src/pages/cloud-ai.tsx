import { useEffect, useState } from 'react';
import { TIERS, TIER_SHORT, formatTokens, parseTokens, promoGives, type CloudAiAccountView, type CloudAiOverview, type CloudAiState, type PromoCodeView, type Tier } from '@fbrx/shared';
import { Button, Callout, Card, CopyText, Empty, Field, Grid, Input, KeyValue, Meter, Modal, Page, Select, StatTile, Status, Table, TextArea, Toggle, formatDate, formatDay, useAction, type StatusTone } from '@fbrx/ui';
import { api } from '../api';
import { useQuery } from '../state';

const STATES: Record<CloudAiState, { tone: StatusTone; label: string }> = {
  ok: { tone: 'good', label: 'Within its allowance' },
  credit: { tone: 'info', label: 'On extra tokens' },
  lifted: { tone: 'warning', label: 'Limit lifted' },
  limit: { tone: 'serious', label: 'At its limit' },
  off: { tone: 'critical', label: 'Turned off' },
  busy: { tone: 'warning', label: 'Service at its budget' },
  unavailable: { tone: 'neutral', label: 'Not set up' },
};

const PROMO_STATES: Record<PromoCodeView['status'], { tone: StatusTone; label: string }> = {
  active: { tone: 'good', label: 'Active' },
  expired: { tone: 'neutral', label: 'Expired' },
  'used up': { tone: 'neutral', label: 'Used up' },
  disabled: { tone: 'warning', label: 'Turned off' },
};

/** "October 2026". */
const monthName = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
/** An amount of tokens typed in a form, or undefined when it is not one. */
const typed = (s: string) => parseTokens(s) ?? undefined;
const tokenText = (n: number | null | undefined) => (n === null || n === undefined ? '' : formatTokens(n));

/** Platform view: FBRX Cloud AI. The month so far, each edition's allowance, every account's use, and promo codes. */
export function CloudAiPage() {
  const [search, setSearch] = useState('');
  const q = useQuery<CloudAiOverview>(`/v1/admin/ai${search ? `?q=${encodeURIComponent(search)}` : ''}`, [search]);
  const promos = useQuery<PromoCodeView[]>('/v1/admin/promos');
  const [managing, setManaging] = useState<CloudAiAccountView | null>(null);
  const o = q.data;
  return (
    <Page
      title="Cloud AI"
      description="The models FBRX runs for FBRX accounts. FBRX Command counts each account’s tokens, never what was said."
      actions={
        <div style={{ width: 280 }}>
          <Input placeholder="Find an account by email or name" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      }
    >
      {o && !o.available && (
        <Callout tone="warning" title="FBRX Cloud AI is not set up here">
          Set FBRX_AI_UPSTREAM_URL, FBRX_AI_UPSTREAM_KEY and FBRX_AI_MODELS where FBRX Command runs and restart it. Until then, chats are refused; allowances and promo codes can be set up now.
        </Callout>
      )}
      {o && (
        <Grid cols={4}>
          <StatTile label={`Used in ${monthName(o.month)}`} value={formatTokens(o.used)} foot={o.budget !== null ? `of a ${formatTokens(o.budget)} budget` : 'No budget set'} />
          <StatTile label="Chats this month" value={o.requests.toLocaleString('en-US')} foot={`${o.accounts.filter((a) => a.used > 0).length} accounts`} />
          <StatTile label="Models" value={o.models.length} foot={o.models.map((m) => (m.weight === 1 ? m.id : `${m.id} ×${m.weight}`)).join(', ') || 'None yet'} />
          <StatTile label="Promo codes in use" value={(promos.data ?? []).filter((p) => p.status === 'active').length} foot={`${(promos.data ?? []).reduce((n, p) => n + p.redemptions, 0)} used so far`} />
        </Grid>
      )}
      {o && <Allowances overview={o} onSaved={q.reload} />}
      <Card title="Accounts" subtitle={search ? 'The accounts that match' : 'This month’s, most used first, and the ones with something set'} flush>
        <Table
          rows={o?.accounts ?? []}
          rowKey={(a) => a.accountId}
          onRowClick={setManaging}
          empty={<Empty title={search ? 'No account matches' : 'Nobody has used FBRX Cloud AI this month'}>Find an account above to set its limit, add tokens or turn it off.</Empty>}
          columns={[
            { key: 'n', header: 'Account', render: (a) => (<div><div className="fx-cell-title">{a.name}</div><div className="fx-cell-sub">{a.email}</div></div>) },
            { key: 't', header: 'Edition', render: (a) => (a.customLimit ? `${TIER_SHORT[a.tier]} · own limit` : TIER_SHORT[a.tier]) },
            {
              key: 'u',
              header: 'This month',
              render: (a) => (
                <div style={{ minWidth: 160 }}>
                  <div className="fx-cell-sub">{a.allowance ? `${formatTokens(a.used)} of ${formatTokens(a.allowance)}` : `${formatTokens(a.used)} · no allowance`}</div>
                  {a.allowance > 0 && <Meter value={a.used} max={a.allowance} label={`${a.email}: tokens used this month`} />}
                </div>
              ),
            },
            { key: 'c', header: 'Extra tokens', render: (a) => (a.credit ? formatTokens(a.credit) : '—') },
            { key: 's', header: 'State', render: (a) => <Status tone={STATES[a.state].tone}>{STATES[a.state].label}</Status> },
            { key: 'x', header: '', render: (a) => <Button size="sm" onClick={(e) => (e.stopPropagation(), setManaging(a))}>Manage</Button> },
          ]}
        />
      </Card>
      <PromoCodes q={promos} />
      {managing && (
        <ManageAccount
          account={managing}
          onClose={() => setManaging(null)}
          onSaved={() => {
            setManaging(null);
            q.reload();
          }}
        />
      )}
    </Page>
  );
}

/** Each edition's tokens a month, and the most the whole service may count in one. */
function Allowances({ overview, onSaved }: { overview: CloudAiOverview; onSaved: () => void }) {
  const [form, setForm] = useState(() => ({ allowance: Object.fromEntries(TIERS.map((t) => [t, tokenText(overview.allowance[t])])) as Record<Tier, string>, budget: tokenText(overview.budget) }));
  const { run, busy } = useAction();
  const valid = TIERS.every((t) => typed(form.allowance[t]) !== undefined) && (!form.budget.trim() || typed(form.budget) !== undefined);
  return (
    <Card
      title="Allowances"
      subtitle="Tokens a month, read and written together. Essentials’ need a confirmed email. Past its allowance an account spends extra tokens, then waits for the next month."
      actions={
        <Button
          variant="primary"
          size="sm"
          disabled={!valid}
          loading={busy === 'save'}
          onClick={() =>
            void run('save', () => api('POST', '/v1/admin/ai/settings', { allowance: Object.fromEntries(TIERS.map((t) => [t, typed(form.allowance[t])])), budget: form.budget.trim() ? typed(form.budget) : null }).then(onSaved), 'Allowances saved')
          }
        >
          Save
        </Button>
      }
    >
      <div className="fx-form">
        <Grid cols={4}>
          {TIERS.map((t) => (
            <Field key={t} label={TIER_SHORT[t]}>
              <Input value={form.allowance[t]} onChange={(e) => setForm({ ...form, allowance: { ...form.allowance, [t]: e.target.value } })} placeholder="0" />
            </Field>
          ))}
        </Grid>
        <Field label="Service budget a month" help="The most FBRX Cloud AI counts for everyone together; past it, it takes no new chats until the month ends. Empty: no budget. 1.5M, 250K and 250000 all work.">
          <Input value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} placeholder="No budget" />
        </Field>
      </div>
    </Card>
  );
}

/** One account: its own limit, extra tokens, the limit lifted for the month, turned off, a note, its last months. */
function ManageAccount({ account: a, onClose, onSaved }: { account: CloudAiAccountView; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ limit: a.customLimit ? tokenText(a.allowance) : '', tokens: '', lift: a.lifted, off: a.off, note: a.note });
  const { run, busy } = useAction();
  const taking = form.tokens.trim().startsWith('-');
  const tokens = form.tokens.trim() ? typed(form.tokens.trim().replace(/^-/, '')) : 0;
  const limit = form.limit.trim() ? typed(form.limit) : null;
  const valid = tokens !== undefined && limit !== undefined;
  return (
    <Modal
      title={a.email}
      description={STATES[a.state].label + (a.message ? `: ${a.message}` : '')}
      onClose={onClose}
      wide
      footer={
        <Button
          variant="primary"
          disabled={!valid}
          loading={busy === 'save'}
          onClick={() =>
            void run('save', () => api('POST', `/v1/admin/ai/accounts/${a.accountId}`, { monthlyLimit: limit, tokens: (taking ? -1 : 1) * (tokens ?? 0), lift: form.lift, off: form.off, note: form.note }).then(onSaved), 'Saved')
          }
        >
          Save
        </Button>
      }
    >
      <KeyValue
        items={[
          ['Edition', TIER_SHORT[a.tier]],
          ['This month', `${formatTokens(a.used)} of ${formatTokens(a.allowance)} (${a.requests.toLocaleString('en-US')} chats)`],
          ['Extra tokens', a.credit ? formatTokens(a.credit) : 'None'],
          ['Renews', formatDay(a.renewsAt)],
        ]}
      />
      <div className="fx-form" style={{ marginTop: 12 }}>
        <Grid cols={2}>
          <Field label="Its own monthly limit" help={`Empty: its edition’s (${TIER_SHORT[a.tier]}).`}>
            <Input value={form.limit} onChange={(e) => setForm({ ...form, limit: e.target.value })} placeholder="Its edition’s" />
          </Field>
          <Field label="Add extra tokens" help="Spent once the month’s allowance is used; they do not run out. A minus takes some back.">
            <Input value={form.tokens} onChange={(e) => setForm({ ...form, tokens: e.target.value })} placeholder="250K" />
          </Field>
        </Grid>
        <Toggle checked={form.lift} onChange={(lift) => setForm({ ...form, lift })} label="Lift its limit until the month ends" info="It goes on past its allowance (still counted, and the service budget still applies) without spending extra tokens. It ends by itself when the month does." />
        <Toggle checked={form.off} onChange={(off) => setForm({ ...form, off })} label="Turn FBRX Cloud AI off for this account" info="Its chats are refused, whatever its allowance, until it is turned back on." />
        <Field label="Note" help="For you; the account does not see it.">
          <TextArea rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </Field>
      </div>
      {a.history.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <Table
            rows={a.history}
            rowKey={(m) => m.month}
            columns={[
              { key: 'm', header: 'Month', render: (m) => monthName(m.month) },
              { key: 'u', header: 'Counted', render: (m) => formatTokens(m.used) },
              { key: 'i', header: 'Read', render: (m) => formatTokens(m.inputTokens) },
              { key: 'o', header: 'Written', render: (m) => formatTokens(m.outputTokens) },
              { key: 'r', header: 'Chats', render: (m) => m.requests.toLocaleString('en-US') },
            ]}
          />
        </div>
      )}
    </Modal>
  );
}

type Promos = ReturnType<typeof useQuery<PromoCodeView[]>>;

/** Promo codes: extra tokens, an edition for some days, or both; each account uses a code once. */
function PromoCodes({ q }: { q: Promos }) {
  const [making, setMaking] = useState(false);
  const [made, setMade] = useState<PromoCodeView | null>(null);
  const [usedBy, setUsedBy] = useState<PromoCodeView | null>(null);
  const { run, busy } = useAction();
  return (
    <Card
      title="Promo codes"
      subtitle="People enter them in FBRX OS (Settings → Account), on the website or in the phone apps."
      flush
      actions={
        <Button size="sm" variant="primary" icon="plus" onClick={() => setMaking(true)}>
          New promo code
        </Button>
      }
    >
      <Table
        rows={q.data ?? []}
        rowKey={(p) => p.id}
        empty={<Empty title="No promo codes yet">Make one to give extra FBRX Cloud AI tokens, Standard or Ultra for some days, or both.</Empty>}
        columns={[
          { key: 'c', header: 'Code', render: (p) => (<div><CopyText value={p.code} />{p.note && <div className="fx-cell-sub">{p.note}</div>}</div>) },
          { key: 'g', header: 'Gives', render: (p) => promoGives(p) },
          {
            key: 'u',
            header: 'Used',
            render: (p) => {
              const used = `${p.redemptions}${p.maxRedemptions ? ` of ${p.maxRedemptions}` : ''}`;
              return p.redemptions ? (
                <Button size="sm" variant="ghost" title="Who used it" onClick={() => setUsedBy(p)}>
                  {used}
                </Button>
              ) : (
                used
              );
            },
          },
          { key: 'e', header: 'Works until', render: (p) => (p.expiresAt ? formatDay(p.expiresAt) : 'No end') },
          { key: 's', header: 'State', render: (p) => <Status tone={PROMO_STATES[p.status].tone}>{PROMO_STATES[p.status].label}</Status> },
          {
            key: 'x',
            header: '',
            render: (p) => (
              <Button size="sm" variant="ghost" loading={busy === p.id} onClick={() => void run(p.id, () => api('POST', `/v1/admin/promos/${p.id}`, { disabled: p.status !== 'disabled' }).then(q.reload))}>
                {p.status === 'disabled' ? 'Turn on' : 'Turn off'}
              </Button>
            ),
          },
        ]}
      />
      {making && (
        <NewPromo
          onClose={() => setMaking(false)}
          onMade={(p) => {
            setMaking(false);
            setMade(p);
            q.reload();
          }}
        />
      )}
      {made && (
        <Modal title="Promo code made" onClose={() => setMade(null)} footer={<Button onClick={() => setMade(null)}>Done</Button>}>
          <KeyValue items={[['Code', <CopyText key="c" value={made.code} />], ['Gives', promoGives(made)], ['Works until', made.expiresAt ? formatDay(made.expiresAt) : 'No end'], ['Accounts', made.maxRedemptions ? `Up to ${made.maxRedemptions}` : 'Any number']]} />
        </Modal>
      )}
      {usedBy && <UsedBy promo={usedBy} onClose={() => setUsedBy(null)} />}
    </Card>
  );
}

function NewPromo({ onClose, onMade }: { onClose: () => void; onMade: (p: PromoCodeView) => void }) {
  const [form, setForm] = useState({ code: '', tokens: '', tier: '' as '' | 'basic' | 'ultra', days: '30', max: '', until: '', note: '' });
  const { run, busy } = useAction();
  const tokens = form.tokens.trim() ? typed(form.tokens) : 0;
  const valid = tokens !== undefined && (tokens > 0 || !!form.tier) && (!form.tier || Number(form.days) >= 1);
  return (
    <Modal
      title="New promo code"
      onClose={onClose}
      footer={
        <Button
          variant="primary"
          disabled={!valid}
          loading={busy === 'make'}
          onClick={() =>
            void run('make', () =>
              api<PromoCodeView>('POST', '/v1/admin/promos', {
                code: form.code.trim() || undefined,
                tokens,
                tier: form.tier || null,
                days: form.tier ? Number(form.days) : null,
                maxRedemptions: form.max.trim() ? Number(form.max) : null,
                expiresAt: form.until || null,
                note: form.note,
              }).then(onMade),
            )
          }
        >
          Make it
        </Button>
      }
    >
      <div className="fx-form">
        <Field label="Code" help="Empty: FBRX makes one up (FBRX-XXXX-XXXX). Letters, digits and dashes; any case works when it is entered.">
          <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="LAUNCH-WEEK" />
        </Field>
        <Field label="Extra FBRX Cloud AI tokens" help="1.5M, 250K and 250000 all work. Empty: none.">
          <Input value={form.tokens} onChange={(e) => setForm({ ...form, tokens: e.target.value })} placeholder="250K" />
        </Field>
        <Grid cols={2}>
          <Field label="An edition too">
            <Select value={form.tier} options={[{ value: '', label: 'No edition' }, { value: 'basic', label: TIER_SHORT.basic }, { value: 'ultra', label: TIER_SHORT.ultra }]} onChange={(e) => setForm({ ...form, tier: e.target.value as '' | 'basic' | 'ultra' })} />
          </Field>
          <Field label="For how many days">
            <Input type="number" min={1} disabled={!form.tier} value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} />
          </Field>
          <Field label="How many accounts may use it" help="Empty: any number.">
            <Input type="number" min={1} value={form.max} onChange={(e) => setForm({ ...form, max: e.target.value })} />
          </Field>
          <Field label="Works until" help="Empty: no end.">
            <Input type="date" value={form.until} onChange={(e) => setForm({ ...form, until: e.target.value })} />
          </Field>
        </Grid>
        <Field label="Note" help="For you: what the code is for.">
          <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

function UsedBy({ promo, onClose }: { promo: PromoCodeView; onClose: () => void }) {
  const [rows, setRows] = useState<Array<{ accountId: string; email: string; redeemedAt: string }> | null>(null);
  useEffect(() => {
    void api<typeof rows>('GET', `/v1/admin/promos/${promo.id}/redemptions`).then(setRows);
  }, [promo.id]);
  return (
    <Modal title={`Who used ${promo.code}`} onClose={onClose}>
      <Table
        rows={rows ?? []}
        rowKey={(r) => r.accountId}
        empty={<Empty title={rows ? 'Nobody yet' : 'Loading…'} />}
        columns={[
          { key: 'e', header: 'Account', render: (r) => r.email },
          { key: 'w', header: 'When', render: (r) => formatDate(r.redeemedAt) },
        ]}
      />
    </Modal>
  );
}
