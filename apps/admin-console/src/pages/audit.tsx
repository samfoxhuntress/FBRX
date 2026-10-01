import { useState } from 'react';
import { Button, Callout, Card, Empty, Input, Modal, Page, Table, formatDate, useAction } from '@fbrx/ui';
import { api } from '../api';
import { useApp, useQuery } from '../state';

interface Entry {
  seq: number;
  ts: string;
  tenantId: string | null;
  actorType: string;
  actorLabel: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  details: unknown;
  hash: string;
}

export function AuditPage() {
  const app = useApp();
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('');
  const [view, setView] = useState<Entry | null>(null);
  const [verify, setVerify] = useState<{ ok: boolean; checked: number; brokenAtSeq: number | null } | null>(null);
  const qs = new URLSearchParams({ limit: '200', ...(search ? { search } : {}), ...(action ? { action } : {}) });
  const entries = useQuery<Entry[]>(`/v1/admin/audit?${qs}`, [], (e) => e.type === 'audit');
  const { busy, run } = useAction();
  return (
    <Page
      title="Audit log"
      description="Every administrative action, enrollment and remote command, hash-chained so tampering is detectable. Device-side actions are kept in each device's own tamper-evident log."
      actions={
        app.me.principal.role === 'superadmin' && (
          <Button icon="shield" loading={busy === 'v'} onClick={async () => setVerify((await run('v', () => api('GET', '/v1/admin/audit/verify'))) ?? null)}>
            Verify chain
          </Button>
        )
      }
    >
      {verify && (
        <Callout tone={verify.ok ? 'good' : 'critical'} title={verify.ok ? 'Audit chain intact' : 'Audit chain broken'}>
          {verify.ok ? `${verify.checked} entries verified.` : `Tampering detected at entry #${verify.brokenAtSeq}.`}
        </Callout>
      )}
      <div className="fx-row">
        <div style={{ flex: 2, minWidth: 220 }}>
          <Input placeholder="Search actor, target or details…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div style={{ flex: 1, minWidth: 160 }}>
          <Input placeholder="Action prefix (e.g. command.)" value={action} onChange={(e) => setAction(e.target.value)} />
        </div>
      </div>
      <Card flush>
        <Table
          rows={entries.data ?? []}
          rowKey={(e) => String(e.seq)}
          onRowClick={setView}
          empty={<Empty title="No matching entries" />}
          columns={[
            { key: 'seq', header: '#', className: 'num', render: (e) => e.seq },
            { key: 'ts', header: 'When', render: (e) => formatDate(e.ts) },
            { key: 'a', header: 'Action', render: (e) => <span className="mono">{e.action}</span> },
            { key: 'actor', header: 'Actor', render: (e) => e.actorLabel },
            { key: 't', header: 'Target', render: (e) => (e.targetId ? <span className="mono fx-secondary">{e.targetType}:{e.targetId}</span> : '—') },
            { key: 'ip', header: 'IP', render: (e) => <span className="fx-muted">{e.ip ?? ''}</span> },
          ]}
        />
      </Card>
      {view && (
        <Modal wide title={`#${view.seq} ${view.action}`} onClose={() => setView(null)} footer={<Button onClick={() => setView(null)}>Close</Button>}>
          <pre className="fx-code">{JSON.stringify(view, null, 2)}</pre>
        </Modal>
      )}
    </Page>
  );
}
