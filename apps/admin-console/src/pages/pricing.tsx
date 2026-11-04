import { useEffect, useMemo, useState } from 'react';
import { MAX_PRICE, MAX_VOLUME_STEPS, PAID_TIERS, TIER_SHORT, formatPrice, organizationBill, type MdmPricing, type PriceBook } from '@fbrx/shared';
import { Button, Callout, Card, Field, Grid, Input, Page, StatTile, Status, Table, Toggle, useAction, useConfirm } from '@fbrx/ui';
import { api } from '../api';
import { useQuery } from '../state';

interface StripePrice {
  found: boolean;
  unitAmount: number | null;
  interval: string | null;
  error?: string;
}

interface PricingInfo {
  book: PriceBook;
  mdm: MdmPricing;
  /** Every price the list charges, under its Stripe lookup key. */
  products: Array<{ productId: string; label: string; amount: number }>;
  maxPerEndpoint: number;
  /** What Stripe charges under each lookup key (null: Stripe is not set up here). */
  stripe: Record<string, StripePrice> | null;
}

/** Card payments take about this much of each charge (one invoice per organization, so no per-computer fixed fee). */
const CARD_FEE = 0.029;
/** The example organizations the earnings are shown for. */
const EXAMPLES = [30, 150, 400];
/** The example bills: Work organizations of three sizes, mostly Standard. */
const EXAMPLE_BILLS = [
  { name: 'Business, 30 computers', basic: 20, ultra: 10 },
  { name: 'School, 150 computers', basic: 120, ultra: 30 },
  { name: 'District, 400 computers', basic: 300, ultra: 100 },
];

const dollars = (cents: number) => (cents / 100).toFixed(2);
/** "$1,260" or "$105.50": whole dollars when there are no cents. */
const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const toCents = (s: string) => {
  const n = Number(s.replace(/[$,\s]/g, ''));
  return s.trim() && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};
const toCount = (s: string) => {
  const n = Number(s.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * Platform view: the prices FBRX Command's operator sets. The price list (the editions on their own, the organization
 * fees, each computer's price in an organization and the volume discount), the MDM add-on, and whether Stripe charges
 * the same under each lookup key.
 */
export function PricingPage() {
  const q = useQuery<PricingInfo>('/v1/admin/pricing');
  const p = q.data;
  return (
    <Page title="Pricing" description="What FBRX sells, and at what price. Organizations’ bills follow these prices; Stripe charges what its prices say, so this page checks that they agree and can bring Stripe in step.">
      {p && <PriceBookEditor book={p.book} onSaved={q.reload} />}
      {p && <StripeCard info={p} onSaved={q.reload} />}
      {p && <MdmCard info={p} onSaved={q.reload} />}
      {p && <Earnings price={p.mdm.perEndpoint} />}
    </Page>
  );
}

/** The price list as the form holds it: what was typed, until it is saved. */
interface Draft {
  personal: Record<'basic' | 'ultra', string>;
  seats: Record<(typeof PAID_TIERS)[number], string>;
  volume: Array<{ from: string; percentOff: string }>;
  base: string;
  large: { on: boolean; from: string; monthly: string };
  home: { on: boolean; monthly: string };
}

const draftOf = (b: PriceBook): Draft => ({
  personal: { basic: dollars(b.personal.basic), ultra: dollars(b.personal.ultra) },
  seats: { basic: dollars(b.seats.basic), ultra: dollars(b.seats.ultra), blackhole: dollars(b.seats.blackhole) },
  volume: b.volume.map((s) => ({ from: String(s.from), percentOff: String(s.percentOff) })),
  base: dollars(b.fees.base),
  large: { on: !!b.fees.large, from: String(b.fees.large?.from ?? 100), monthly: dollars(b.fees.large?.monthly ?? b.fees.base) },
  home: { on: b.fees.home !== null, monthly: dollars(b.fees.home ?? b.fees.base) },
});

/** The price list the form describes, or what is wrong with it. */
function bookOf(d: Draft): PriceBook | string {
  const price = (s: string, what: string) => {
    const c = toCents(s);
    if (c === null) throw new Error(`${what}: enter a price in dollars`);
    if (c > MAX_PRICE) throw new Error(`${what}: at most ${formatPrice(MAX_PRICE)}`);
    return c;
  };
  try {
    const volume = d.volume.map((s, i) => {
      const from = toCount(s.from);
      const percentOff = toCount(s.percentOff);
      if (from === null || from < 2) throw new Error(`Volume step ${i + 1}: from 2 computers or more`);
      if (percentOff === null || percentOff > 90) throw new Error(`Volume step ${i + 1}: a whole percent from 1 to 90`);
      return { from, percentOff };
    });
    if (volume.some((s, i) => i > 0 && s.from <= volume[i - 1]!.from)) throw new Error('Each volume step starts at more computers than the one before');
    const largeFrom = toCount(d.large.from);
    if (d.large.on && (largeFrom === null || largeFrom < 2)) throw new Error('Larger organizations: from 2 computers or more');
    return {
      personal: { basic: price(d.personal.basic, 'Standard on its own'), ultra: price(d.personal.ultra, 'Ultra on its own') },
      seats: { basic: price(d.seats.basic, 'Standard in an organization'), ultra: price(d.seats.ultra, 'Ultra in an organization'), blackhole: price(d.seats.blackhole, 'Black Hole in an organization') },
      volume,
      fees: {
        base: price(d.base, 'Organization fee'),
        large: d.large.on ? { from: largeFrom!, monthly: price(d.large.monthly, 'Fee for larger organizations') } : null,
        home: d.home.on ? price(d.home.monthly, 'Home organization fee') : null,
      },
    };
  } catch (err) {
    return (err as Error).message;
  }
}

function PriceBookEditor({ book, onSaved }: { book: PriceBook; onSaved: () => void }) {
  const saved = JSON.stringify(book);
  const [d, setD] = useState<Draft>(() => draftOf(book));
  useEffect(() => setD(draftOf(JSON.parse(saved) as PriceBook)), [saved]);
  const { busy, run } = useAction();
  const next = useMemo(() => bookOf(d), [d]);
  const changed = typeof next !== 'string' && JSON.stringify(next) !== saved;
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const money$ = (value: string, onChange: (v: string) => void, label?: string) => <Input value={value} inputMode="decimal" aria-label={label} onChange={(e) => onChange(e.target.value)} style={{ maxWidth: 140 }} />;
  /** A new step after the last: four times as many computers, 5% more off (the first: from 25 computers, 10% off). */
  const addStep = () => {
    const last = d.volume.at(-1);
    const from = toCount(last?.from ?? '');
    const off = toCount(last?.percentOff ?? '');
    set({ volume: [...d.volume, { from: String(from ? from * 4 : 25), percentOff: String(off ? Math.min(90, off + 5) : 10) }] });
  };
  const save = () => typeof next !== 'string' && run('book', () => api('POST', '/v1/admin/pricing', { book: next }).then(onSaved), 'Prices saved');
  return (
    <>
      <Grid cols={2}>
        <Card title="Editions on their own" subtitle="What a person pays for their own computers, a month. Essentials is free. Set the same prices in App Store Connect and the Google Play Console: the stores charge their own.">
          <div className="fx-form">
            <Field label="Standard">{money$(d.personal.basic, (v) => set({ personal: { ...d.personal, basic: v } }))}</Field>
            <Field label="Ultra">{money$(d.personal.ultra, (v) => set({ personal: { ...d.personal, ultra: v } }))}</Field>
          </div>
        </Card>
        <Card title="The organization fee" subtitle="What an organization pays for its FBRX Command, a month, on top of its computers. It is never discounted.">
          <div className="fx-form">
            <Field label={d.large.on || d.home.on ? 'Work and School' : 'Every organization'}>{money$(d.base, (v) => set({ base: v }))}</Field>
            <Toggle checked={d.large.on} onChange={(on) => set({ large: { ...d.large, on } })} label="Larger organizations pay another fee" />
            {d.large.on && (
              <div className="fx-row" style={{ alignItems: 'flex-start' }}>
                <Field label="From this many computers" help="Every computer counts, Essentials included.">
                  <Input value={d.large.from} inputMode="numeric" onChange={(e) => set({ large: { ...d.large, from: e.target.value } })} style={{ maxWidth: 110 }} />
                </Field>
                <Field label="Their fee">{money$(d.large.monthly, (v) => set({ large: { ...d.large, monthly: v } }))}</Field>
              </div>
            )}
            <Toggle checked={d.home.on} onChange={(on) => set({ home: { ...d.home, on } })} label="Home organizations pay another fee" />
            {d.home.on && <Field label="Home">{money$(d.home.monthly, (v) => set({ home: { ...d.home, monthly: v } }))}</Field>}
          </div>
        </Card>
      </Grid>
      <Card title="Each computer in an organization" subtitle="A month, before the volume discount. Essentials computers are free; student and child computers are billed as Standard.">
        <div className="fx-form">
          <div className="fx-row">
            {PAID_TIERS.map((t) => (
              <Field key={t} label={TIER_SHORT[t]}>
                {money$(d.seats[t], (v) => set({ seats: { ...d.seats, [t]: v } }))}
              </Field>
            ))}
          </div>
          <Field label="Volume discount" help="Off every paid computer once the organization has this many of them (Standard, Ultra and Black Hole together). The highest step reached counts. Stripe shows it on the invoice as its own line.">
            <div className="fx-form">
              {d.volume.length === 0 && <div className="fx-muted">None: every organization pays the prices above.</div>}
              {d.volume.map((s, i) => (
                <div key={i} className="fx-row" style={{ alignItems: 'center' }}>
                  <span>From</span>
                  <Input value={s.from} inputMode="numeric" aria-label={`Step ${i + 1}: from this many computers`} onChange={(e) => set({ volume: d.volume.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)) })} style={{ maxWidth: 90 }} />
                  <span>computers,</span>
                  <Input value={s.percentOff} inputMode="numeric" aria-label={`Step ${i + 1}: percent off`} onChange={(e) => set({ volume: d.volume.map((x, j) => (j === i ? { ...x, percentOff: e.target.value } : x)) })} style={{ maxWidth: 70 }} />
                  <span>% off</span>
                  <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove step ${i + 1}`} onClick={() => set({ volume: d.volume.filter((_, j) => j !== i) })} />
                </div>
              ))}
              {d.volume.length < MAX_VOLUME_STEPS && (
                <div>
                  <Button size="sm" icon="plus" onClick={addStep}>
                    Add a step
                  </Button>
                </div>
              )}
            </div>
          </Field>
        </div>
      </Card>
      <Card
        title="Example bills"
        subtitle="Work organizations at the prices above, before they are saved, without the MDM add-on."
        actions={
          <div className="fx-row">
            <Button variant="ghost" disabled={busy === 'book' || JSON.stringify(draftOf(book)) === JSON.stringify(d)} onClick={() => setD(draftOf(book))}>
              Undo changes
            </Button>
            <Button variant="primary" icon="check" loading={busy === 'book'} disabled={!changed} onClick={() => void save()}>
              Save prices
            </Button>
          </div>
        }
        flush
      >
        {typeof next === 'string' ? (
          <div style={{ padding: 16 }}>
            <Status tone="warning">{next}</Status>
          </div>
        ) : (
          <Table
            rows={EXAMPLE_BILLS.map((x) => ({ ...x, bill: organizationBill(next, { kind: 'business', computers: { basic: x.basic, ultra: x.ultra } }) }))}
            rowKey={(r) => r.name}
            columns={[
              { key: 'n', header: 'Organization', render: (r) => r.name },
              { key: 'm', header: 'Computers', render: (r) => `${r.basic} Standard, ${r.ultra} Ultra` },
              { key: 'f', header: 'Fee', render: (r) => money(r.bill.lines[0]!.total) },
              { key: 'd', header: 'Volume discount', render: (r) => (r.bill.percentOff ? `${r.bill.percentOff}% off` : '—') },
              { key: 't', header: 'A month', render: (r) => <strong>{money(r.bill.total)}</strong> },
            ]}
          />
        )}
      </Card>
    </>
  );
}

/** Whether Stripe charges each price on the list, and bringing it in step. */
function StripeCard({ info, onSaved }: { info: PricingInfo; onSaved: () => void }) {
  const { busy, run } = useAction();
  const { confirm, dialog } = useConfirm();
  const s = info.stripe;
  const state = (want: number, got: StripePrice | undefined) => (!got ? null : got.error ? 'error' : !got.found ? 'missing' : got.unitAmount === want && got.interval === 'month' ? 'same' : 'different');
  const off = s ? info.products.filter((p) => state(p.amount, s[p.productId]) === 'missing' || state(p.amount, s[p.productId]) === 'different') : [];
  const update = async () => {
    const ok = await confirm({
      title: `Update ${off.length === 1 ? 'one price' : `${off.length} prices`} in Stripe?`,
      body: 'Each gets a new monthly price in Stripe that takes its lookup key. People who already pay on their own keep their price; organizations move to the new one at their next seat update, so tell them before you raise a price.',
      confirmLabel: 'Update Stripe',
    });
    if (ok) await run('stripe', () => api('POST', '/v1/admin/pricing/stripe').then(onSaved), 'Stripe has the prices on this page');
  };
  return (
    <Card
      title="Stripe"
      subtitle="Stripe charges what its price under each lookup key says."
      actions={
        s && off.length > 0 ? (
          <Button variant="primary" icon="refresh" loading={busy === 'stripe'} onClick={() => void update()}>
            Update Stripe
          </Button>
        ) : undefined
      }
      flush
    >
      {dialog}
      {s === null ? (
        <div style={{ padding: 16 }}>
          <Status tone="neutral">Stripe is not set up on this FBRX Command: nothing is charged here.</Status>
        </div>
      ) : (
        <Table
          rows={info.products}
          rowKey={(p) => p.productId}
          columns={[
            { key: 'w', header: 'Price', render: (p) => p.label },
            { key: 'k', header: 'Lookup key', render: (p) => <code>{p.productId}</code> },
            { key: 'a', header: 'Here', render: (p) => formatPrice(p.amount) },
            {
              key: 's',
              header: 'In Stripe',
              render: (p) => {
                const got = s[p.productId];
                switch (state(p.amount, got)) {
                  case 'same':
                    return <Status tone="good">The same</Status>;
                  case 'missing':
                    return <Status tone="warning">No price yet</Status>;
                  case 'different':
                    return <Status tone="warning">{got!.unitAmount === null ? 'Not a fixed amount' : `${formatPrice(got!.unitAmount)} a ${got!.interval ?? 'time'}`}</Status>;
                  case 'error':
                    return <Status tone="warning">Could not ask: {got!.error}</Status>;
                  default:
                    return '—';
                }
              },
            },
          ]}
        />
      )}
    </Card>
  );
}

function MdmCard({ info, onSaved }: { info: PricingInfo; onSaved: () => void }) {
  const [price, setPrice] = useState(dollars(info.mdm.perEndpoint));
  useEffect(() => setPrice(dollars(info.mdm.perEndpoint)), [info.mdm.perEndpoint]);
  const { busy, run } = useAction();
  const cents = toCents(price);
  const valid = cents !== null && cents <= info.maxPerEndpoint;
  const save = (patch: Partial<MdmPricing>, done: string) => run('save', () => api('POST', '/v1/admin/pricing', { mdm: patch }).then(onSaved), done);
  return (
    <Card
      title="The MDM add-on"
      subtitle="Device management for an organization’s computers, at one price per managed computer a month, whatever edition the computer runs (Essentials included). No volume discount. Organizations turn it on for a group’s computers in Profiles & groups."
      actions={<Toggle checked={info.mdm.available} disabled={busy === 'save'} onChange={(v) => void save({ available: v }, v ? 'The MDM add-on is on sale' : 'The MDM add-on is no longer sold')} label={info.mdm.available ? 'Sold' : 'Not sold'} />}
    >
      <div className="fx-form">
        <div className="fx-row" style={{ alignItems: 'flex-end' }}>
          <Field label="Price per managed computer, a month (US dollars)" help={`Up to ${formatPrice(info.maxPerEndpoint)}.`}>
            <Input value={price} inputMode="decimal" onChange={(e) => setPrice(e.target.value)} style={{ maxWidth: 160 }} />
          </Field>
          <Button variant="primary" loading={busy === 'save'} disabled={!valid || cents === info.mdm.perEndpoint} onClick={() => void save({ perEndpoint: cents! }, `MDM add-on price set to ${formatPrice(cents!)}`)}>
            Save price
          </Button>
        </div>
        {!info.mdm.available && (
          <Callout tone="info" title="Not sold yet">
            Organizations can mark groups for it, and nothing is charged until it is on sale.
          </Callout>
        )}
      </div>
    </Card>
  );
}

/** What the add-on earns at this price: margin after what a managed computer costs, and the example organizations. */
function Earnings({ price }: { price: number }) {
  // About $0.81 a computer a month: support for patches and remote help ($0.75), relayed remote sessions and the
  // inventory and patch data (a few cents).
  const [cost, setCost] = useState('0.81');
  const c = toCents(cost) ?? 0;
  const net = price * (1 - CARD_FEE) - c;
  const margin = price > 0 ? net / price : 0;
  return (
    <Card title="What the MDM add-on earns" subtitle="At its price, after card fees and what a managed computer costs to look after. Change the cost to your own numbers.">
      <div className="fx-form">
        <Field label="Cost per managed computer, a month (US dollars)" help="Support for patches and remote help is most of it; relayed remote sessions and the inventory and patch data add a few cents.">
          <Input value={cost} inputMode="decimal" onChange={(e) => setCost(e.target.value)} style={{ maxWidth: 160 }} />
        </Field>
        <Grid cols={3}>
          <StatTile label="Price" value={formatPrice(price)} foot="per managed computer, a month" />
          <StatTile label="Kept" value={`$${dollars(Math.max(0, net))}`} foot="after card fees and the cost" />
          <StatTile label="Margin" value={`${Math.round(margin * 100)}%`} foot={margin < 0.6 ? 'Below 60%' : 'At or above 60%'} />
        </Grid>
        <Table
          rows={EXAMPLES.map((n) => ({ n }))}
          rowKey={(r) => String(r.n)}
          columns={[
            { key: 'n', header: 'Managed computers', render: (r) => r.n },
            { key: 'm', header: 'A month', render: (r) => money(price * r.n) },
            { key: 'y', header: 'A year', render: (r) => money(price * r.n * 12) },
            { key: 'k', header: 'Kept a year', render: (r) => money(Math.round((Math.max(0, net) * r.n * 12) / 100) * 100) },
          ]}
        />
      </div>
    </Card>
  );
}
