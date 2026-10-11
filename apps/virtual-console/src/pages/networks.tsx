import { useState } from 'react';
import type { VirtualNetwork, VmSummary } from '@fbrx/shared';
import { Button, Callout, Card, ChoiceCards, Empty, Field, Icons, InfoTip, Input, Modal, Page, Status, useAction, useConfirm, type IconName } from '@fbrx/ui';
import { api } from '../api';
import { useApp, usePoll, useRoute } from '../state';
import { VmStateBadge } from './common';

type Kind = 'gate' | 'bridge' | 'nat' | 'isolated' | 'other';
const kindOf = (n: VirtualNetwork): Kind => (n.gate ? 'gate' : !n.managed && n.kind === 'bridge' ? 'bridge' : n.kind === 'nat' ? 'nat' : n.kind === 'isolated' ? 'isolated' : 'other');

const KINDS: Record<Kind, { title: string; icon: IconName; what: string }> = {
  gate: {
    title: 'On your network (FBRX Gate switch)',
    icon: 'network',
    what: 'Machines plug into one of the gate’s networks like computers into its port: the gate gives them addresses and its rules for that network apply. Your devices reach them directly.',
  },
  bridge: {
    title: 'On your network (bridge)',
    icon: 'network',
    what: 'Machines sit on the network the port is cabled to, next to your other devices, and get addresses from its router.',
  },
  nat: {
    title: 'Private, internet through the server',
    icon: 'globe',
    what: 'Machines get private addresses from this server and reach the internet through it. Nothing on your network reaches them.',
  },
  isolated: { title: 'Machines only', icon: 'lock', what: 'A closed lab: machines on it talk only to each other.' },
  other: { title: 'Other', icon: 'box', what: 'A network set up outside FBRX Virtual.' },
};

/** Where virtual machines plug in, drawn as the way their traffic goes: machines → this network → out. */
export function NetworksPage() {
  const app = useApp();
  const [, go] = useRoute();
  const nets = usePoll<{ networks: VirtualNetwork[] }>('/v1/networks', 10000);
  const vms = usePoll<{ vms: VmSummary[] }>('/v1/vms', 15000);
  const [creating, setCreating] = useState(false);
  const list = nets.data?.networks ?? [];
  const order: Kind[] = ['gate', 'bridge', 'nat', 'isolated', 'other'];
  const sorted = [...list].sort((a, b) => order.indexOf(kindOf(a)) - order.indexOf(kindOf(b)) || a.name.localeCompare(b.name));
  const onLan = list.some((n) => kindOf(n) === 'gate' || kindOf(n) === 'bridge');
  return (
    <Page
      title="Networks"
      description="Where virtual machines plug in. On your network, a machine is one more device next to your others (any number of machines share the port with the server, like a virtual switch). On a private network it stays behind the server."
      actions={app.can('admin') && <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>New private network</Button>}
    >
      {nets.data && !onLan && (
        <Callout tone="info" title="Put machines on your network">
          {app.has('gate') ? (
            <>
              This server is your gate: open <b>Gate → Networks &amp; VLANs</b>, pick a network (your LAN, a server VLAN…), turn on <b>Virtual machines can join this network</b>, and commit. It appears
              here as a switch machines can plug into.{' '}
              <Button size="sm" onClick={() => go('gate-networks')}>
                Open Networks &amp; VLANs
              </Button>
            </>
          ) : (
            <>
              Make a bridge on a port: run the installer again with <span className="mono">--bridge eno1</span> (the port cabled to your network) and restart. Machines on it get addresses
              from your router.
            </>
          )}
        </Callout>
      )}
      {!nets.data ? (
        <Empty title="Loading…" />
      ) : (
        <div className="vn-grid">
          {sorted.map((n) => (
            <NetworkCard key={n.name} n={n} vms={(vms.data?.vms ?? []).filter((v) => v.networks?.includes(n.managed ? n.name : (n.bridge ?? n.name)))} onDeleted={() => void nets.reload()} />
          ))}
        </div>
      )}
      {creating && <NewNetwork onClose={() => setCreating(false)} onDone={() => void nets.reload()} />}
    </Page>
  );
}

const ACCESS_WORDS = { full: 'everything (the internet and your other networks)', internet: 'the internet only', isolated: 'nothing outside it' } as const;

function NetworkCard({ n, vms, onDeleted }: { n: VirtualNetwork; vms: VmSummary[]; onDeleted: () => void }) {
  const app = useApp();
  const [, go] = useRoute();
  const { busy, run } = useAction();
  const { confirm, dialog } = useConfirm();
  const k = kindOf(n);
  const meta = KINDS[k];
  const Ico = Icons[meta.icon];
  // The way out, from the machines' side.
  const out =
    k === 'gate'
      ? { via: `${n.bridge} switch`, to: `${n.gate!.network} via ${n.gate!.port}`, sub: `reaches ${ACCESS_WORDS[n.gate!.access]}` }
      : k === 'bridge'
        ? { via: `${n.bridge} switch`, to: n.ports.length ? `your network via ${n.ports.join(', ')}` : 'no port yet', sub: 'addresses from your router' }
        : k === 'nat'
          ? { via: n.bridge ?? 'the server', to: 'the internet', sub: 'through the server’s own address' }
          : k === 'isolated'
            ? { via: n.bridge ?? 'switch', to: 'nowhere', sub: 'machines only' }
            : { via: n.bridge ?? '—', to: '—', sub: '' };
  return (
    <Card
      className={`vn-card ${k}`}
      title={
        <span className="vn-title">
          <Ico size={16} />
          {n.gate ? n.gate.network : n.name}
          <InfoTip>{meta.what}</InfoTip>
        </span>
      }
      subtitle={meta.title}
      actions={<Status tone={n.active ? 'good' : 'warning'}>{n.active ? 'Up' : 'Not up yet'}</Status>}
    >
      <div className="vn-flow" aria-label={`Machines → ${out.via} → ${out.to}`}>
        <div className="vn-node">
          <Icons.box size={16} />
          <b>{vms.length}</b>
          <span>machine{vms.length === 1 ? '' : 's'}</span>
        </div>
        <span className="vn-link" aria-hidden="true" />
        <div className="vn-node mid">
          <Icons.layers size={16} />
          <b className="mono">{out.via}</b>
          <span>{n.subnet ?? (k === 'bridge' ? 'addresses from your network' : '—')}</span>
        </div>
        <span className={`vn-link${k === 'isolated' ? ' cut' : ''}`} aria-hidden="true" />
        <div className="vn-node">
          {k === 'nat' ? <Icons.globe size={16} /> : k === 'isolated' ? <Icons.lock size={16} /> : <Icons.network size={16} />}
          <b>{out.to}</b>
          <span>{out.sub}</span>
        </div>
      </div>
      {!n.active && n.gate && <div className="fx-muted" style={{ fontSize: 12.5 }}>The gate has this switch, but the server does not show it yet: Gate shows any problem, and <span className="mono">sudo fbrx-gate status</span> too.</div>}
      <div className="vn-vms">
        {vms.length === 0 ? (
          <span className="fx-muted" style={{ fontSize: 12.5 }}>No machine plugged in. Pick it when creating one, or under a machine’s Settings → Network.</span>
        ) : (
          vms.map((v) => (
            <button key={v.id} type="button" className="vn-vm" onClick={() => go('vm', v.id)} title={`Open ${v.name}`}>
              <VmStateBadge state={v.state} />
              <span>{v.name}</span>
              {v.ip && <span className="mono fx-muted">{v.ip}</span>}
            </button>
          ))
        )}
      </div>
      {(app.can('admin') && n.managed) || n.gate ? (
        <div className="fx-actions" style={{ marginTop: 10 }}>
          {n.gate && app.has('gate') && (
            <Button size="sm" onClick={() => go('gate-networks')}>
              Its gate settings
            </Button>
          )}
          <span className="fx-spacer" />
          {app.can('admin') && n.managed && (
            <Button
              size="sm"
              variant="danger"
              icon="trash"
              loading={busy === n.name}
              onClick={async () => {
                if (await confirm({ title: `Delete the network ${n.name}?`, body: vms.length ? `${vms.length} machine${vms.length === 1 ? ' is' : 's are'} plugged into it: move them first.` : undefined, confirmLabel: 'Delete', danger: true }))
                  await run(n.name, async () => {
                    await api('DELETE', `/v1/networks/${encodeURIComponent(n.name)}`);
                    onDeleted();
                  }, `${n.name} deleted`);
              }}
            >
              Delete
            </Button>
          )}
        </div>
      ) : null}
      {dialog}
    </Card>
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
      description="For machines that should stay behind the server. To put machines on your network instead, use a gate switch or a bridge."
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
