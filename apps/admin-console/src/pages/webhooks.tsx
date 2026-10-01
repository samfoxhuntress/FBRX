import { useState } from 'react';
import { Button, Card, CopyText, Empty, Field, Input, Modal, Page, Status, Table, Toggle, timeAgo, useAction, useConfirm } from '@fbrx/ui';
import { api } from '../api';
import { useQuery } from '../state';

const EVENTS = ['device.enrolled', 'device.online', 'device.offline', 'device.retired', 'device.alert', 'command.completed', 'command.failed', 'snapshot.uploaded', 'license.issued', 'release.published'];

interface Hook {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  lastStatus: number | null;
  lastDeliveryAt: string | null;
  lastError: string | null;
}

export function WebhooksPage() {
  const hooks = useQuery<Hook[]>('/v1/admin/webhooks');
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  const { run } = useAction();
  return (
    <Page
      title="Webhooks"
      description="Connect the control plane to your other systems. Each delivery is a JSON POST signed with HMAC-SHA256 (header x-fbrx-signature: sha256=…)."
      actions={
        <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
          New webhook
        </Button>
      }
    >
      <Card flush>
        <Table
          rows={hooks.data ?? []}
          rowKey={(h) => h.id}
          empty={<Empty title="No webhooks">Send fleet alerts to Slack, Teams, PagerDuty, a SIEM or your own service.</Empty>}
          columns={[
            { key: 'n', header: 'Webhook', render: (h) => (<div><div className="fx-cell-title">{h.name}</div><div className="fx-cell-sub mono">{h.url}</div></div>) },
            { key: 'e', header: 'Events', render: (h) => h.events.join(', ') },
            {
              key: 's',
              header: 'Last delivery',
              render: (h) =>
                h.lastError ? <Status tone="critical">{h.lastError}</Status> : h.lastStatus ? <Status tone={h.lastStatus < 400 ? 'good' : 'warning'}>HTTP {h.lastStatus} · {timeAgo(h.lastDeliveryAt)}</Status> : <span className="fx-muted">never</span>,
            },
            { key: 'on', header: 'Enabled', render: (h) => <Toggle checked={h.enabled} onChange={(v) => void run('t', () => api('PATCH', `/v1/admin/webhooks/${h.id}`, { enabled: v }).then(hooks.reload))} /> },
            {
              key: 'x',
              header: '',
              render: (h) => (
                <div className="fx-actions">
                  <Button size="sm" onClick={() => void run('test', () => api('POST', `/v1/admin/webhooks/${h.id}/test`).then(hooks.reload), 'Test event sent')}>
                    Test
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={async () => {
                      if (await confirm({ title: `Delete ${h.name}?`, danger: true, confirmLabel: 'Delete' })) {
                        await run('d', () => api('DELETE', `/v1/admin/webhooks/${h.id}`), 'Webhook deleted');
                        hooks.reload();
                      }
                    }}
                  >
                    Delete
                  </Button>
                </div>
              ),
            },
          ]}
        />
      </Card>
      {creating && (
        <Creator
          onClose={() => setCreating(false)}
          onCreated={(s) => {
            setCreating(false);
            setSecret(s);
            hooks.reload();
          }}
        />
      )}
      {secret && (
        <Modal title="Signing secret" description="Store this in the receiving system to verify signatures. It is shown only once." onClose={() => setSecret(null)} footer={<Button variant="primary" onClick={() => setSecret(null)}>Done</Button>}>
          <CopyText value={secret} />
        </Modal>
      )}
      {dialog}
    </Page>
  );
}

function Creator({ onClose, onCreated }: { onClose: () => void; onCreated: (secret: string) => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['device.alert', 'command.failed']);
  const { busy, run } = useAction();
  return (
    <Modal
      title="New webhook"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy === 'c'}
            disabled={!name || !/^https?:\/\//.test(url) || !events.length}
            onClick={async () => {
              const r = await run('c', () => api<{ secret: string }>('POST', '/v1/admin/webhooks', { name, url, events }));
              if (r) onCreated(r.secret);
            }}
          >
            Create
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ops alerts" />
        </Field>
        <Field label="Endpoint URL">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.example.com/fbrx" />
        </Field>
        <Field label="Events">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {EVENTS.map((e) => (
              <label key={e} className="fx-toggle">
                <input type="checkbox" checked={events.includes(e)} onChange={(x) => setEvents(x.target.checked ? [...events, e] : events.filter((y) => y !== e))} />
                <span className="mono">{e}</span>
              </label>
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  );
}
