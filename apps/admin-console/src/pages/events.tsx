import { useState } from 'react';
import { Button, Card, Empty, Page, Select, Table, formatDate, timeAgo, useAction } from '@fbrx/ui';
import { api } from '../api';
import { useApp, useQuery } from '../state';
import { SeverityStatus } from './common';

interface Ev {
  id: string;
  deviceId: string;
  deviceName: string;
  ts: string;
  kind: string;
  severity: string;
  message: string;
  acknowledgedAt: string | null;
}

export function EventsPage() {
  const app = useApp();
  const [severity, setSeverity] = useState('');
  const events = useQuery<Ev[]>(`/v1/admin/events?limit=300${severity ? `&severity=${severity}` : ''}`, [], (e) => e.type === 'device.event');
  const { run } = useAction();
  return (
    <Page title="Alerts & events" description="Service failures, vault locks, hardware identity changes and audit anomalies reported by devices, in real time.">
      <div className="fx-row">
        <div style={{ width: 220 }}>
          <Select aria-label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value)} options={[{ value: '', label: 'All severities' }, { value: 'critical', label: 'Critical' }, { value: 'warning', label: 'Warning' }, { value: 'info', label: 'Info' }]} />
        </div>
      </div>
      <Card flush>
        <Table
          rows={events.data ?? []}
          rowKey={(e) => e.id}
          empty={<Empty title="All quiet">No alerts from your devices.</Empty>}
          columns={[
            { key: 's', header: 'Severity', render: (e) => <SeverityStatus severity={e.severity} /> },
            { key: 'd', header: 'Device', render: (e) => <a href={`#/device/${e.deviceId}`}>{e.deviceName}</a> },
            { key: 'k', header: 'Kind', render: (e) => <span className="mono">{e.kind}</span> },
            { key: 'm', header: 'Message', render: (e) => e.message },
            { key: 't', header: 'When', render: (e) => <span title={formatDate(e.ts)}>{timeAgo(e.ts)}</span> },
            {
              key: 'a',
              header: '',
              render: (e) =>
                e.acknowledgedAt ? (
                  <span className="fx-muted">Acknowledged</span>
                ) : app.can('devices.manage') ? (
                  <Button size="sm" onClick={() => void run('ack', () => api('POST', `/v1/admin/events/${e.id}/ack`).then(events.reload))}>
                    Acknowledge
                  </Button>
                ) : null,
            },
          ]}
        />
      </Card>
    </Page>
  );
}
