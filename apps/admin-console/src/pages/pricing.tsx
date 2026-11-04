import { useEffect, useState } from 'react';
import { formatPrice, type MdmPricing } from '@fbrx/shared';
import { Button, Callout, Card, Field, Grid, Input, Page, StatTile, Status, Table, Toggle, useAction } from '@fbrx/ui';
import { api } from '../api';
import { useQuery } from '../state';

interface PricingInfo {
  mdm: MdmPricing;
  productId: string;
  maxPerEndpoint: number;
  /** What Stripe charges under the add-on's lookup key (null: Stripe is not set up here). */
  stripe: { found: boolean; unitAmount: number | null; interval: string | null; error?: string } | null;
}

/** Card payments take about this much of each charge (one invoice per organization, so no per-computer fixed fee). */
const CARD_FEE = 0.029;
/** The example organizations the earnings are shown for. */
const EXAMPLES = [30, 150, 400];

const dollars = (cents: number) => (cents / 100).toFixed(2);
/** "$1,260" or "$105.50": whole dollars when there are no cents. */
const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const toCents = (s: string) => {
  const n = Number(s.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};

/**
 * Platform view: prices FBRX Command's operator sets. For now the MDM add-on: whether it is sold, its price per managed
 * computer (the same whatever the computer's edition), whether Stripe charges the same, and what it earns.
 */
export function PricingPage() {
  const q = useQuery<PricingInfo>('/v1/admin/pricing');
  const p = q.data;
  return (
    <Page title="Pricing" description="What FBRX Command sells beyond the editions, and at what price. Stripe charges what its prices say: this page checks that they agree.">
      {p && <MdmCard info={p} onSaved={q.reload} />}
      {p && <Earnings price={p.mdm.perEndpoint} />}
    </Page>
  );
}

function MdmCard({ info, onSaved }: { info: PricingInfo; onSaved: () => void }) {
  const [price, setPrice] = useState(dollars(info.mdm.perEndpoint));
  useEffect(() => setPrice(dollars(info.mdm.perEndpoint)), [info.mdm.perEndpoint]);
  const { busy, run } = useAction();
  const cents = toCents(price);
  const valid = cents !== null && cents <= info.maxPerEndpoint;
  const save = (patch: Partial<MdmPricing>, done: string) => run('save', () => api('POST', '/v1/admin/pricing', { mdm: patch }).then(onSaved), done);
  const s = info.stripe;
  return (
    <Card
      title="The MDM add-on"
      subtitle="Device management for an organization’s computers, at one price per managed computer a month, whatever edition the computer runs (Essentials included). Organizations turn it on for a group’s computers in Profiles & groups."
      actions={<Toggle checked={info.mdm.available} disabled={busy === 'save'} onChange={(v) => void save({ available: v }, v ? 'The MDM add-on is on sale' : 'The MDM add-on is no longer sold')} label={info.mdm.available ? 'Sold' : 'Not sold'} />}
    >
      <div className="fx-form">
        <div className="fx-row" style={{ alignItems: 'flex-end' }}>
          <Field label="Price per managed computer, a month (US dollars)" help={`Up to ${formatPrice(info.maxPerEndpoint)}. Organizations already counted pay the new price from their next seat update.`}>
            <Input value={price} inputMode="decimal" onChange={(e) => setPrice(e.target.value)} style={{ maxWidth: 160 }} />
          </Field>
          <Button variant="primary" loading={busy === 'save'} disabled={!valid || cents === info.mdm.perEndpoint} onClick={() => void save({ perEndpoint: cents! }, `MDM add-on price set to ${formatPrice(cents!)}`)}>
            Save price
          </Button>
        </div>
        {!info.mdm.available && <div className="fx-muted">Not sold yet: organizations can mark groups for it, and nothing is charged until it is on sale.</div>}
        {s === null ? (
          <Status tone="neutral">Stripe is not set up on this FBRX Command: nothing is charged for it here.</Status>
        ) : s.error ? (
          <Status tone="warning">Stripe could not be asked: {s.error}</Status>
        ) : !s.found ? (
          <Callout tone="warning" title="Stripe has no price for it yet">
            In Stripe, add a product for the MDM add-on with a monthly recurring price of {formatPrice(info.mdm.perEndpoint)} and the lookup key <code>{info.productId}</code>.
          </Callout>
        ) : s.unitAmount !== info.mdm.perEndpoint || s.interval !== 'month' ? (
          <Callout tone="warning" title="Stripe charges something else">
            Stripe’s price under <code>{info.productId}</code> is {s.unitAmount === null ? 'not a fixed amount' : formatPrice(s.unitAmount)}
            {s.interval && s.interval !== 'month' ? ` a ${s.interval}` : ' a month'}; you set {formatPrice(info.mdm.perEndpoint)}. In Stripe, add a new monthly price of {formatPrice(info.mdm.perEndpoint)} to the product and move the lookup key to it (Transfer lookup key).
          </Callout>
        ) : (
          <Status tone="good">Stripe charges the same: {formatPrice(s.unitAmount)} a month under {info.productId}.</Status>
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
    <Card title="What it earns" subtitle="At the price above, after card fees and what a managed computer costs to look after. Change the cost to your own numbers.">
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
