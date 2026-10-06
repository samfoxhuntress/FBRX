import { useState } from 'react';
import type { VirtualNetwork } from '@fbrx/shared';
import { Button, Card, ChoiceCards, Empty, Field, Input, Modal, Page, Status, Table, useAction, useConfirm } from '@fbrx/ui';
import { api } from '../api';
import { useApp, usePoll } from '../state';

const KIND: Record<VirtualNetwork['kind'], string> = { nat: 'Private, internet through the server', isolated: 'Machines only (no way out)', bridge: 'Straight onto the network', other: 'Other' };

export function NetworksPage() {
  const app = useApp();
  const { busy, run } = useAction();
  const { confirm, dialog } = useConfirm();
  const nets = usePoll<{ networks: VirtualNetwork[] }>('/v1/networks', 10000);
  const [creating, setCreating] = useState(false);
  return (
    <Page
      title="Networks"
      description="Where virtual machines plug in. Bridges put machines on your real network (they get addresses from your router); private networks keep them behind the server."
      actions={app.can('admin') && <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>New private network</Button>}
    >
      <Card flush>
        <Table
          rows={nets.data?.networks ?? []}
          rowKey={(n) => n.name}
          empty={<Empty title="Loading…" />}
          columns={[
            { key: 'n', header: 'Name', render: (n) => <div><div className="fx-cell-title">{n.name}</div><div className="fx-cell-sub">{n.managed ? 'Made in FBRX Virtual' : 'Bridge on the server'}</div></div> },
            { key: 'k', header: 'Kind', render: (n) => KIND[n.kind] },
            { key: 's', header: 'Addresses', render: (n) => <span className="mono">{n.subnet ?? (n.kind === 'bridge' ? 'From your network' : '—')}</span> },
            { key: 'p', header: 'Through', render: (n) => <span className="mono">{n.ports.length ? n.ports.join(', ') : (n.bridge ?? '—')}</span> },
            { key: 'a', header: 'State', render: (n) => <Status tone={n.active ? 'good' : 'neutral'}>{n.active ? 'Up' : 'Down'}</Status> },
            {
              key: 'x',
              header: '',
              render: (n) =>
                app.can('admin') &&
                n.managed && (
                  <Button
                    size="sm"
                    variant="danger"
                    icon="trash"
                    aria-label={`Delete ${n.name}`}
                    loading={busy === n.name}
                    onClick={async () => {
                      if (await confirm({ title: `Delete the network ${n.name}?`, confirmLabel: 'Delete', danger: true })) await run(n.name, async () => { await api('DELETE', `/v1/networks/${encodeURIComponent(n.name)}`); await nets.reload(); }, `${n.name} deleted`);
                    }}
                  />
                ),
            },
          ]}
        />
      </Card>
      {creating && <NewNetwork onClose={() => setCreating(false)} onDone={() => void nets.reload()} />}
      {dialog}
    </Page>
  );
}

function NewNetwork({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'nat' | 'isolated'>('nat');
  const [subnet, setSubnet] = useState('10.20.0.0/24');
  return (
    <Modal
      title="New private network"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 'go'} disabled={!/^[A-Za-z0-9][A-Za-z0-9._-]{0,14}$/.test(name)} onClick={() => void run('go', async () => { await api('POST', '/v1/networks', { name, kind, subnet }); onDone(); onClose(); }, `${name} is up`)}>
            Create
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <ChoiceCards
          label="Kind"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'nat', title: 'With internet', description: 'Machines reach the internet through the server; nothing reaches them from outside.', icon: 'globe' },
            { value: 'isolated', title: 'Machines only', description: 'A lab network: machines on it talk only to each other.', icon: 'lock' },
          ]}
        />
        <Field label="Name" help="Up to 15 letters, digits, dots, dashes, underscores.">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="lab" />
        </Field>
        <Field label="Addresses" help="A private range. The server takes the first address and hands out the rest (DHCP).">
          <Input value={subnet} onChange={(e) => setSubnet(e.target.value)} className="mono" />
        </Field>
      </div>
    </Modal>
  );
}
