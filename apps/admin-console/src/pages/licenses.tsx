import { useState } from 'react';
import { ALL_FEATURES, EDITIONS, EDITION_FEATURES, FEATURES, type Edition } from '@fbrx/shared';
import { Button, Callout, Card, CopyText, Empty, Field, Input, Modal, Page, Select, Status, Table, formatDate, useAction, useConfirm } from '@fbrx/ui';
import { api } from '../api';
import { useApp, useQuery } from '../state';

interface License {
  id: string;
  tenantId: string;
  customer: string;
  edition: string;
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
  const [show, setShow] = useState<License | null>(null);
  const { confirm, dialog } = useConfirm();
  const { run } = useAction();
  const state = (l: License) =>
    l.revokedAt ? <Status tone="neutral">Revoked</Status> : l.expiresAt && l.expiresAt < new Date().toISOString() ? <Status tone="warning">Expired</Status> : <Status tone="good">Active</Status>;
  return (
    <Page
      title="Licenses"
      description="Sell FBRX OS: each customer is a tenant with a signed license (edition, seats, features, expiry). Licenses are verified offline by the app using your public key and delivered automatically to enrolled devices."
      actions={
        manage && app.tenantId ? (
          <Button variant="primary" icon="plus" onClick={() => setIssuing(true)}>
            Issue license
          </Button>
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
            { key: 'e', header: 'Edition', render: (l) => <span className="fx-badge accent">{l.edition}</span> },
            { key: 's', header: 'Seats', className: 'num', render: (l) => l.seats || 'unlimited' },
            { key: 'st', header: 'Status', render: state },
            { key: 'x', header: 'Expires', render: (l) => (l.expiresAt ? formatDate(l.expiresAt) : 'perpetual') },
            { key: 'i', header: 'Issued', render: (l) => formatDate(l.issuedAt) },
          ]}
        />
      </Card>
      {issuing && <IssueModal onClose={() => setIssuing(false)} onIssued={() => (setIssuing(false), lic.reload())} />}
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
            <Field label="License key" help="Customers without a control plane can paste this into FBRX OS → Settings → License">
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
  const [f, setF] = useState({ edition: 'enterprise' as Edition, seats: '25', expires: '', customer: '', maxMajorVersion: '' });
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
        {!base.includes('fleet') && !extra.includes('fleet') && (
          <Callout tone="warning" title="No fleet management">
            Without “{FEATURES.fleet}”, new workstations cannot enroll in this organization. Use the license as an offline key, or add the feature.
          </Callout>
        )}
      </div>
    </Modal>
  );
}
