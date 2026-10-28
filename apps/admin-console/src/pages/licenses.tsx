import { useState } from 'react';
import { ALL_FEATURES, EDITIONS, EDITION_FEATURES, FEATURES, SUPPORT_ENTER_PHRASE, SUPPORT_EXIT_PHRASE, SUPPORT_PASS_DEFAULT_HOURS, SUPPORT_PASS_MAX_HOURS, TIER_NAMES, tierFor, type Edition, type Tier } from '@fbrx/shared';
import { Button, Callout, Card, CopyText, Empty, Field, Input, KeyValue, Modal, Page, Select, Status, Table, formatDate, useAction, useConfirm } from '@fbrx/ui';
import { api } from '../api';
import { useApp, useQuery } from '../state';

interface License {
  id: string;
  tenantId: string;
  customer: string;
  edition: string;
  tier: Tier;
  vertical?: 'business' | 'education' | 'home';
  commandUrl: string | null;
  seats: number;
  features: string[];
  issuedAt: string;
  expiresAt: string | null;
  maxMajorVersion: number | null;
  revokedAt: string | null;
  key: string;
}

export function LicensesPage() {
  const app = useApp();
  const manage = app.can('licenses.manage');
  const lic = useQuery<License[]>('/v1/admin/licenses');
  const pub = useQuery<{ publicKeyPem: string }>(manage ? '/v1/admin/licensing/public-key' : null);
  const tenants = app.me.tenants;
  const [issuing, setIssuing] = useState(false);
  const [supportPass, setSupportPass] = useState(false);
  const [show, setShow] = useState<License | null>(null);
  const { confirm, dialog } = useConfirm();
  const { run } = useAction();
  const state = (l: License) =>
    l.revokedAt ? <Status tone="neutral">Revoked</Status> : l.expiresAt && l.expiresAt < new Date().toISOString() ? <Status tone="warning">Expired</Status> : <Status tone="good">Active</Status>;
  return (
    <Page
      title="Licenses"
      description="Each customer is a tenant with a signed license (product, edition, seats, features, expiry). Computers open in FBRX Endpoint Essentials, free. A license key goes up to Ultra on a computer on its own; Black Hole comes only when the computer is in this tenant and the license allows it. A key that joins the tenant enrolls the computer here on its own. Licenses are verified offline by the app using your public key and delivered automatically to enrolled devices."
      actions={
        manage ? (
          <>
            <Button icon="lifebuoy" onClick={() => setSupportPass(true)}>
              Support pass
            </Button>
            {app.tenantId && (
              <Button variant="primary" icon="plus" onClick={() => setIssuing(true)}>
                Issue license
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      {manage && !app.tenantId && <Callout tone="info">Select a tenant (customer) in the top bar to issue them a license.</Callout>}
      {manage && pub.data && (
        <Card title="License signing public key" subtitle="Embed this in desktop builds (FBRX_LICENSE_PUBLIC_KEY at build time) so they trust licenses from this control plane">
          <pre className="fx-code">{pub.data.publicKeyPem}</pre>
          <div style={{ marginTop: 8 }}>
            <CopyText value={pub.data.publicKeyPem.replace(/\n/g, '\\n')} />
          </div>
        </Card>
      )}
      <Card flush>
        <Table
          rows={lic.data ?? []}
          rowKey={(l) => l.id}
          onRowClick={setShow}
          empty={<Empty title="No licenses issued" />}
          columns={[
            { key: 'c', header: 'Customer', render: (l) => (<div><div className="fx-cell-title">{l.customer}</div><div className="fx-cell-sub">{tenants.find((t) => t.id === l.tenantId)?.name ?? l.tenantId}</div></div>) },
            { key: 'p', header: 'Product', render: (l) => (<div><div className="fx-cell-title">{TIER_NAMES[l.tier]}{l.vertical && l.vertical !== 'business' ? <span className="fx-badge accent" style={{ marginLeft: 6 }}>{l.vertical === 'education' ? 'School' : 'Home'}</span> : null}</div>{l.commandUrl && <div className="fx-cell-sub">Joins this tenant</div>}</div>) },
            { key: 'e', header: 'Edition', render: (l) => <span className="fx-badge accent">{l.edition}</span> },
            { key: 's', header: 'Seats', className: 'num', render: (l) => l.seats || 'unlimited' },
            { key: 'st', header: 'Status', render: state },
            { key: 'x', header: 'Expires', render: (l) => (l.expiresAt ? formatDate(l.expiresAt) : 'perpetual') },
            { key: 'i', header: 'Issued', render: (l) => formatDate(l.issuedAt) },
          ]}
        />
      </Card>
      {issuing && <IssueModal onClose={() => setIssuing(false)} onIssued={() => (setIssuing(false), lic.reload())} />}
      {supportPass && <SupportPassModal onClose={() => setSupportPass(false)} />}
      {show && (
        <Modal
          wide
          title={`${show.customer} · ${show.edition}`}
          onClose={() => setShow(null)}
          footer={
            <>
              {manage && !show.revokedAt && (
                <Button
                  variant="danger"
                  style={{ marginRight: 'auto' }}
                  onClick={async () => {
                    if (await confirm({ title: 'Revoke this license?', body: 'Enrolled devices drop to Community features on their next sync.', danger: true, confirmLabel: 'Revoke' })) {
                      await run('r', () => api('POST', `/v1/admin/licenses/${show.id}/revoke`), 'License revoked');
                      setShow(null);
                      lic.reload();
                    }
                  }}
                >
                  Revoke
                </Button>
              )}
              <Button onClick={() => setShow(null)}>Close</Button>
            </>
          }
        >
          <div className="fx-form">
            <Field label="License key" help={show.commandUrl ? 'Paste into FBRX Endpoint → Settings → License: the computer turns on its product and joins this tenant.' : 'Paste into FBRX Endpoint → Settings → License (works without FBRX Command too).'}>
              <CopyText value={show.key} />
            </Field>
            <Field label="Features">
              <div>{[...new Set([...EDITION_FEATURES[show.edition as Edition], ...show.features])].map((f) => <span key={f} className="fx-badge" style={{ margin: '0 4px 4px 0' }}>{FEATURES[f as keyof typeof FEATURES] ?? f}</span>)}</div>
            </Field>
          </div>
        </Modal>
      )}
      {dialog}
    </Page>
  );
}

function IssueModal({ onClose, onIssued }: { onClose: () => void; onIssued: () => void }) {
  const kind = useApp().kind;
  const [f, setF] = useState({ edition: 'enterprise' as Edition, tier: 'auto' as Tier | 'auto', joinTenant: true, seats: '25', expires: '', customer: '', maxMajorVersion: '', vertical: (kind ?? 'business') as 'business' | 'education' | 'home' });
  const [extra, setExtra] = useState<string[]>([]);
  const { busy, run } = useAction();
  const base = EDITION_FEATURES[f.edition];
  return (
    <Modal
      title="Issue license"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy === 'i'}
            onClick={() =>
              void run(
                'i',
                () =>
                  api('POST', '/v1/admin/licenses', {
                    edition: f.edition,
                    tier: f.tier === 'auto' ? undefined : f.tier,
                    joinTenant: f.joinTenant,
                    vertical: f.vertical === 'business' ? undefined : f.vertical,
                    seats: Number(f.seats || 0),
                    features: extra,
                    expiresAt: f.expires ? new Date(f.expires).toISOString() : null,
                    customer: f.customer || undefined,
                    maxMajorVersion: f.maxMajorVersion ? Number(f.maxMajorVersion) : null,
                  }).then(onIssued),
                'License issued and pushed to devices',
              )
            }
          >
            Sign & issue
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label="Product on the computers" help="The most FBRX Endpoint may run with this license. Computers open in Essentials and switch up in Settings. Black Hole works only in this organization (FBRX Command); on a computer on its own, the license goes up to Ultra.">
          <Select
            value={f.tier}
            onChange={(e) => setF({ ...f, tier: e.target.value as Tier | 'auto' })}
            options={[
              { value: 'auto', label: `By edition (up to ${TIER_NAMES[tierFor(f.edition)]})` },
              { value: 'blackhole', label: `Up to ${TIER_NAMES.blackhole}` },
              { value: 'ultra', label: `Up to ${TIER_NAMES.ultra}` },
              { value: 'basic', label: `Up to ${TIER_NAMES.basic}` },
            ]}
          />
        </Field>
        <Field label="Kind of license" help="Also sets the tenant's kind. School: staff computers start in classroom mode and student computers run FBRX OS Education. Home: children's computers run FBRX OS Home.">
          <Select
            value={f.vertical}
            onChange={(e) => setF({ ...f, vertical: e.target.value as typeof f.vertical })}
            options={[
              { value: 'business', label: 'Work (companies and teams)' },
              { value: 'education', label: 'School (Education)' },
              { value: 'home', label: 'Home (families)' },
            ]}
          />
        </Field>
        <label className="fx-toggle">
          <input type="checkbox" checked={f.joinTenant} onChange={(e) => setF({ ...f, joinTenant: e.target.checked })} />
          Computers that activate this key join this tenant automatically (one enrollment per seat)
        </label>
        <div className="fx-row">
          <Field label="Edition">
            <Select value={f.edition} onChange={(e) => setF({ ...f, edition: e.target.value as Edition })} options={[...EDITIONS]} />
          </Field>
          <Field label="Seats" help="0 = unlimited">
            <Input type="number" min={0} value={f.seats} onChange={(e) => setF({ ...f, seats: e.target.value })} />
          </Field>
        </div>
        <div className="fx-row">
          <Field label="Expires" help="Empty = perpetual">
            <Input type="date" value={f.expires} onChange={(e) => setF({ ...f, expires: e.target.value })} />
          </Field>
          <Field label="Covers versions up to (major)" help="Empty = all versions">
            <Input type="number" min={1} value={f.maxMajorVersion} onChange={(e) => setF({ ...f, maxMajorVersion: e.target.value })} />
          </Field>
        </div>
        <Field label="Customer name on license" help="Defaults to the tenant name">
          <Input value={f.customer} onChange={(e) => setF({ ...f, customer: e.target.value })} />
        </Field>
        <Field label="Additional features">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {ALL_FEATURES.filter((x) => !base.includes(x)).map((x) => (
              <label key={x} className="fx-toggle">
                <input type="checkbox" checked={extra.includes(x)} onChange={(e) => setExtra(e.target.checked ? [...extra, x] : extra.filter((y) => y !== x))} />
                {FEATURES[x]}
              </label>
            ))}
            {ALL_FEATURES.every((x) => base.includes(x)) && <span className="fx-muted">Enterprise includes every feature.</span>}
          </div>
        </Field>
        {!f.joinTenant && !base.includes('fleet') && !extra.includes('fleet') && (
          <Callout tone="warning" title="No fleet management">
            Without “{FEATURES.fleet}”, new workstations cannot enroll in this organization. Use the license as an offline key, or add the feature.
          </Callout>
        )}
      </div>
    </Modal>
  );
}

/**
 * A support pass for one computer (docs/SUPPORT.md): signed with this FBRX Command's license key, so it works on
 * builds that carry the public key above. The person at the computer reads its install id from Settings → License.
 */
function SupportPassModal({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ installId: '', hours: String(SUPPORT_PASS_DEFAULT_HOURS), tier: 'blackhole' as Tier, note: '' });
  const [made, setMade] = useState<{ pass: string; expiresAt: string; tier: Tier } | null>(null);
  const { busy, run } = useAction();
  const make = () =>
    void run('p', () => api<{ pass: string; expiresAt: string; tier: Tier }>('POST', '/v1/admin/support-passes', { installId: f.installId.trim(), hours: Number(f.hours), tier: f.tier, note: f.note.trim() }).then(setMade));
  return (
    <Modal
      title="Support pass"
      description="Full access to one computer's FBRX apps for troubleshooting, for a few hours. On a computer in an organization, that organization must have FBRX support access turned on."
      onClose={onClose}
      footer={
        made ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" icon="key" loading={busy === 'p'} disabled={!f.installId.trim()} onClick={make}>
              Make the pass
            </Button>
          </>
        )
      }
    >
      {made ? (
        <div className="fx-form">
          <Field label="Support pass" help="Shown once. Hand it to the computer it is for.">
            <CopyText value={made.pass} secret />
          </Field>
          <KeyValue
            items={[
              ['Runs as', TIER_NAMES[made.tier]],
              ['Ends', formatDate(made.expiresAt)],
            ]}
          />
          <Callout tone="info" title="On the computer">
            Type <code>{SUPPORT_ENTER_PHRASE}</code> in Settings → License (or Spotlight, or FBRX Browser&apos;s address bar), then paste the pass. <code>{SUPPORT_EXIT_PHRASE}</code> ends support and puts everything back.
          </Callout>
        </div>
      ) : (
        <div className="fx-form">
          <Field label="Install id" help="On the computer: Settings → License (copy button), or show version in Terminal → FBRX/1.">
            <Input value={f.installId} autoFocus spellCheck={false} onChange={(e) => setF({ ...f, installId: e.target.value })} />
          </Field>
          <Field label="For how long">
            <Select value={f.hours} options={Array.from({ length: SUPPORT_PASS_MAX_HOURS }, (_, i) => ({ value: String(i + 1), label: `${i + 1} hour${i ? 's' : ''}` }))} onChange={(e) => setF({ ...f, hours: e.target.value })} />
          </Field>
          <Field label="Runs as">
            <Select value={f.tier} options={(['blackhole', 'ultra', 'basic'] as const).map((t) => ({ value: t, label: TIER_NAMES[t] }))} onChange={(e) => setF({ ...f, tier: e.target.value as Tier })} />
          </Field>
          <Field label="Note" help="Why, such as a ticket number. It is in both audit logs.">
            <Input value={f.note} maxLength={200} onChange={(e) => setF({ ...f, note: e.target.value })} />
          </Field>
        </div>
      )}
    </Modal>
  );
}
