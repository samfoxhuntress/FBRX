import { useEffect, useState } from 'react';
import { cidrsOverlap, hostRange, intToIPv4, ipv4ToInt, isCidr, JUMBO_MTU, networkOf, parseCidr } from '@fbrx/shared';
import { NETWORK_PRESETS, PURPOSES, type GateConfig, type GateInterface, type GateNetwork, type NetworkPurpose } from '@fbrx/gate';
import { Button, Card, ChoiceCards, Empty, Field, Grid, Input, KeyValue, Modal, Select, Status, Table, Toggle, useConfirm } from '@fbrx/ui';
import { api } from '../api';
import { draftIssues, inItem, useGate } from '../gate-state';
import { useApp } from '../state';
import { ACCESS_WORDS, bitRate, GatePage, IssueList, PURPOSE_WORDS } from './gate-common';

interface SystemInterface {
  name: string;
  mac: string | null;
  up: boolean;
  speed: number | null;
  kind: string;
}

/** The ports the server has (for adding one to the gate). */
function useSystemInterfaces() {
  const [list, setList] = useState<SystemInterface[]>([]);
  useEffect(() => {
    void api<{ interfaces: SystemInterface[] }>('GET', '/v1/gate/interfaces')
      .then((r) => setList(r.interfaces))
      .catch(() => undefined);
  }, []);
  return list;
}

const VLAN_FOR: Record<NetworkPurpose, number> = { lan: 10, guest: 20, mesh: 30, servers: 40, iot: 50, management: 99, other: 60 };

/** Addresses handed out in a network: .100 to .199 in a /24, a fair share of anything else. */
function autoRange(cidr: string): { start: string; end: string } {
  const c = parseCidr(cidr);
  if (!c || c.family !== 4 || c.prefix > 30) return { start: '', end: '' };
  const r = hostRange(networkOf(cidr));
  const base = cidr.split('/')[0].split('.').slice(0, 3).join('.');
  if (c.prefix === 24) return { start: `${base}.100`, end: `${base}.199` };
  const first = ipv4ToInt(r.first);
  const last = ipv4ToInt(r.last);
  return { start: intToIPv4(first + Math.max(1, Math.floor((last - first + 1) / 4))), end: intToIPv4(last - 1) };
}

/** A name, VLAN tag and addresses for a new network that do not clash with what is there. */
function suggest(c: GateConfig, purpose: NetworkPurpose, parent: string): { name: string; vlanId: number; address: string } {
  const stem = purpose === 'management' ? 'mgmt' : purpose;
  let name = stem;
  for (let n = 2; c.networks.some((x) => x.name === name); n++) name = `${stem}${n}`;
  let vlanId = VLAN_FOR[purpose];
  while (c.interfaces.some((i) => i.parent === parent && i.vlanId === vlanId)) vlanId++;
  const taken = [...c.networks.map((n) => n.address), ...(c.vpn.enabled ? [c.vpn.address] : []), ...(c.wan.address ? [c.wan.address] : [])];
  const candidates = [vlanId, ...Array.from({ length: 200 }, (_x, k) => (vlanId + k + 1) % 255)].flatMap((o) => [`192.168.${o}.1/24`, `10.${o}.0.1/24`]);
  const address = candidates.find((a) => !taken.some((t) => cidrsOverlap(a, t))) ?? '10.250.0.1/24';
  return { name, vlanId, address };
}

export function GateNetworksPage() {
  const app = useApp();
  const g = useGate();
  const { confirm, dialog } = useConfirm();
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [wan, setWan] = useState(false);
  const [port, setPort] = useState<string | 'new' | null>(null);
  const admin = app.can('admin');
  return (
    <GatePage
      title="Networks & VLANs"
      description="The internet port, the server's ports and VLANs on them, and the networks behind the gate: each with its own addresses, what it may reach, and addresses handed out to its devices."
      actions={
        admin && (
          <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
            New network
          </Button>
        )
      }
    >
      {(info) => {
        const c = info.state.candidate;
        const live = g.live;
        const leases = (name: string) => live?.leases.filter((l) => l.network === name).length ?? 0;
        const usedBy = (iface: string) =>
          iface === c.wan.interface ? 'the internet' : (c.networks.find((n) => n.interface === iface)?.name ?? (c.interfaces.some((i) => i.parent === iface) ? 'its VLANs' : null));
        return (
          <>
            <Grid cols={2}>
              <Card title="Internet" actions={admin && <Button size="sm" icon="edit" onClick={() => setWan(true)}>Change</Button>}>
                <KeyValue
                  items={[
                    ['Port', <span className="mono">{c.wan.interface}</span>],
                    ['Address', c.wan.mode === 'dhcp' ? `From your provider (DHCP)${live?.wan.address ? ` · now ${live.wan.address}` : ''}` : `${c.wan.address} via ${c.wan.gateway}`],
                    ['Answers pings', c.wan.ping ? 'Yes' : 'No (the gate stays quiet)'],
                    ['Traffic now', `${bitRate(g.rates[c.wan.interface]?.rx)} down · ${bitRate(g.rates[c.wan.interface]?.tx)} up`],
                  ]}
                />
              </Card>
              <Card title="How networks are kept apart">
                <p className="fx-secondary" style={{ marginTop: 0 }}>
                  Each network gets what its <b>access</b> says: <b>everything</b> (the internet and your other networks), <b>the internet only</b>, or <b>nothing outside</b>. Nothing reaches in from the internet unless you forward a port. Firewall rules add exceptions.
                </p>
                <p className="fx-secondary" style={{ marginBottom: 0 }}>
                  VLANs carry several networks on one cable: your switch tags each port with the VLAN it belongs to, and the gate keeps them apart.
                </p>
              </Card>
            </Grid>
            <Card title="Networks" flush>
              <Table
                rows={c.networks}
                rowKey={(n) => n.name}
                onRowClick={admin ? (n) => setEditing(c.networks.indexOf(n)) : undefined}
                empty={<Empty title="No networks yet" action={admin && <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>New network</Button>} />}
                columns={[
                  { key: 'n', header: 'Network', render: (n) => <div><div className="fx-cell-title">{n.name}</div><div className="fx-cell-sub">{PURPOSE_WORDS[n.purpose]}{n.description && n.description !== PURPOSE_WORDS[n.purpose] ? ` · ${n.description}` : ''}</div></div> },
                  {
                    key: 'i',
                    header: 'On',
                    render: (n) => {
                      const i = c.interfaces.find((x) => x.name === n.interface);
                      return (
                        <div>
                          <div className="mono">{n.interface}</div>
                          <div className="fx-cell-sub">{i?.kind === 'vlan' ? `VLAN ${i.vlanId} on ${i.parent}` : 'Untagged'}{i && i.mtu >= JUMBO_MTU ? ' · jumbo' : ''}</div>
                        </div>
                      );
                    },
                  },
                  { key: 'a', header: 'Addresses', render: (n) => <div><div className="mono">{networkOf(n.address)}</div><div className="fx-cell-sub">gate {n.address.split('/')[0]}</div></div> },
                  { key: 'x', header: 'Reaches', render: (n) => <div><div>{ACCESS_WORDS[n.access]}</div>{n.manage && <div className="fx-cell-sub">may manage the gate</div>}</div> },
                  { key: 'd', header: 'Hands out', render: (n) => (n.dhcp.enabled ? <div><div className="mono">{n.dhcp.start.split('.').pop()}–{n.dhcp.end.split('.').pop()}</div><div className="fx-cell-sub">{leases(n.name)} device{leases(n.name) === 1 ? '' : 's'} now{n.dhcp.reservations.length ? ` · ${n.dhcp.reservations.length} reserved` : ''}</div></div> : <span className="fx-muted">Off</span>) },
                  {
                    key: 'p',
                    header: '',
                    render: (n) =>
                      c.qos.preferMesh.enabled && c.qos.preferMesh.networks.includes(n.name) ? (
                        <span className="fx-badge" title="Prefer Mesh: its traffic goes first">
                          Prefer Mesh
                        </span>
                      ) : null,
                  },
                ]}
              />
            </Card>
            <Card
              title="Ports & VLANs"
              actions={
                admin && (
                  <Button size="sm" icon="plus" onClick={() => setPort('new')}>
                    Add a port
                  </Button>
                )
              }
              flush
            >
              <Table<GateInterface>
                rows={c.interfaces}
                rowKey={(i) => i.name}
                onRowClick={admin ? (i) => setPort(i.name) : undefined}
                columns={[
                  { key: 'n', header: 'Name', render: (i) => <div><div className="fx-cell-title mono">{i.name}</div><div className="fx-cell-sub">{i.kind === 'vlan' ? `VLAN ${i.vlanId} on ${i.parent}` : 'Port'}{i.description ? ` · ${i.description}` : ''}</div></div> },
                  { key: 'u', header: 'Carries', render: (i) => usedBy(i.name) ?? <span className="fx-muted">Nothing yet</span> },
                  { key: 'm', header: 'MTU', render: (i) => (i.mtu >= JUMBO_MTU ? `${i.mtu} · jumbo` : i.mtu) },
                  {
                    key: 's',
                    header: 'State',
                    render: (i) => {
                      const l = live?.interfaces.find((x) => x.name === i.name);
                      return l ? <Status tone={l.up ? 'good' : 'critical'}>{l.up ? 'Up' : 'Down'}</Status> : <Status tone="neutral">{info.state.running?.interfaces.some((x) => x.name === i.name) ? 'Unknown' : 'Not applied'}</Status>;
                    },
                  },
                  { key: 'r', header: 'In / out', render: (i) => <span className="gt-rate">{bitRate(g.rates[i.name]?.rx)} / {bitRate(g.rates[i.name]?.tx)}</span> },
                ]}
              />
            </Card>
            {editing !== null && (
              <NetworkModal
                config={c}
                index={editing === 'new' ? null : editing}
                onClose={() => setEditing(null)}
                onDelete={async (n) => {
                  const refs = c.firewall.rules.filter((r) => r.from === n.name || r.to === n.name);
                  if (
                    await confirm({
                      title: `Delete the network ${n.name}?`,
                      body: (
                        <p className="fx-secondary">
                          Its devices lose their addresses at the next commit.{refs.length ? ` ${refs.length} firewall rule${refs.length === 1 ? '' : 's'} about it go too.` : ''}
                          {c.interfaces.find((i) => i.name === n.interface)?.kind === 'vlan' ? ` Its VLAN ${n.interface} goes as well.` : ''}
                        </p>
                      ),
                      confirmLabel: 'Delete',
                      danger: true,
                    })
                  ) {
                    const ok = await g.edit((d) => {
                      d.networks = d.networks.filter((x) => x.name !== n.name);
                      d.firewall.rules = d.firewall.rules.filter((r) => r.from !== n.name && r.to !== n.name);
                      d.qos.preferMesh.networks = d.qos.preferMesh.networks.filter((x) => x !== n.name);
                      const i = d.interfaces.find((x) => x.name === n.interface);
                      if (i?.kind === 'vlan') d.interfaces = d.interfaces.filter((x) => x.name !== i.name);
                    }, `${n.name} deleted`);
                    if (ok) setEditing(null);
                  }
                }}
              />
            )}
            {wan && <WanModal config={c} onClose={() => setWan(false)} />}
            {port !== null && <PortModal config={c} name={port === 'new' ? null : port} usedBy={usedBy} onClose={() => setPort(null)} />}
            {dialog}
          </>
        );
      }}
    </GatePage>
  );
}

function NetworkModal({ config, index, onClose, onDelete }: { config: GateConfig; index: number | null; onClose: () => void; onDelete: (n: GateNetwork) => void }) {
  const g = useGate();
  const sys = useSystemInterfaces();
  const isNew = index === null;
  const ports = config.interfaces.filter((i) => i.kind === 'ethernet' && i.name !== config.wan.interface);
  const firstParent = ports[0]?.name ?? '';
  const [placement, setPlacement] = useState<'vlan' | 'port'>('vlan');
  const [parent, setParent] = useState(firstParent);
  const [ownPort, setOwnPort] = useState('');
  const [start] = useState(() => {
    if (!isNew) return { net: structuredClone(config.networks[index]), vlanId: 0 };
    const s = suggest(config, 'guest', firstParent);
    const p = NETWORK_PRESETS.guest;
    return {
      net: { name: s.name, purpose: 'guest' as NetworkPurpose, interface: '', address: s.address, access: p.access, manage: p.manage, dhcp: { enabled: true, ...autoRange(s.address), leaseHours: 12, reservations: [] }, description: '' } satisfies GateNetwork,
      vlanId: s.vlanId,
    };
  });
  const [net, setNet] = useState<GateNetwork>(start.net);
  const [vlanId, setVlanId] = useState(start.vlanId);
  const currentIface = isNew ? null : config.interfaces.find((i) => i.name === net.interface);
  const [jumbo, setJumbo] = useState(isNew ? false : (currentIface?.mtu ?? 1500) >= JUMBO_MTU);
  const [res, setRes] = useState({ mac: '', address: '', name: '' });
  const set = (patch: Partial<GateNetwork>) => setNet((n) => ({ ...n, ...patch }));
  const setDhcp = (patch: Partial<GateNetwork['dhcp']>) => setNet((n) => ({ ...n, dhcp: { ...n.dhcp, ...patch } }));

  const unusedPorts = [
    ...config.interfaces.filter((i) => i.kind === 'ethernet' && i.name !== config.wan.interface && !config.networks.some((n) => n.interface === i.name) && !config.interfaces.some((v) => v.parent === i.name)).map((i) => i.name),
    ...sys.filter((s) => s.kind === 'ethernet' && !config.interfaces.some((i) => i.name === s.name)).map((s) => s.name),
  ];

  /** An untagged network on a port would get jumbo frames too if its VLANs had them. */
  const carriesUntagged = (port: string) => config.networks.some((n) => n.interface === port);
  const choosePurpose = (purpose: NetworkPurpose) => {
    const p = NETWORK_PRESETS[purpose];
    if (isNew) {
      const s = suggest(config, purpose, parent);
      setVlanId(s.vlanId);
      setJumbo(p.mtu >= JUMBO_MTU && (placement === 'port' || !carriesUntagged(parent)));
      set({ purpose, name: s.name, address: s.address, access: p.access, manage: p.manage, dhcp: { ...net.dhcp, ...autoRange(s.address) } });
    } else set({ purpose });
  };

  /** The whole configuration with this network in it (and its VLAN, jumbo frames and Prefer Mesh). */
  const compose = (): { next: GateConfig; iface: string } => {
    const d = structuredClone(config);
    const n = structuredClone(net);
    let iface = n.interface;
    const mtu = jumbo ? JUMBO_MTU : 1500;
    if (isNew) {
      if (placement === 'vlan') {
        iface = `${parent}.${vlanId}`;
        d.interfaces.push({ name: iface, kind: 'vlan', parent, vlanId, mtu, description: n.description || PURPOSE_WORDS[n.purpose] });
      } else {
        iface = ownPort;
        const have = d.interfaces.find((i) => i.name === ownPort);
        if (have) have.mtu = mtu;
        else d.interfaces.push({ name: ownPort, kind: 'ethernet', mtu, description: n.description || PURPOSE_WORDS[n.purpose] });
      }
      n.interface = iface;
      d.networks.push(n);
      if (n.purpose === 'mesh' && !d.qos.preferMesh.networks.includes(n.name)) d.qos.preferMesh.networks.push(n.name);
    } else {
      d.networks[index] = n;
      const i = d.interfaces.find((x) => x.name === iface);
      if (i) i.mtu = jumbo ? Math.max(i.mtu, JUMBO_MTU) : Math.min(i.mtu, 1500);
    }
    // A jumbo VLAN needs its port at least as large.
    const i = d.interfaces.find((x) => x.name === iface);
    const port = i?.kind === 'vlan' ? d.interfaces.find((x) => x.name === i.parent) : null;
    if (port && i && port.mtu < i.mtu) port.mtu = i.mtu;
    return { next: d, iface };
  };
  const { next, iface } = compose();
  const idx = isNew ? next.networks.length - 1 : index;
  const issues = draftIssues(next, (p) => inItem('networks', idx, net.name)(p) || p.startsWith(`interfaces.${iface}`) || p === `interfaces.${idx}` || p.startsWith('qos.preferMesh'));
  const canSave = issues.shapeOk && (!isNew || (placement === 'vlan' ? !!parent && vlanId >= 1 && vlanId <= 4094 : !!ownPort));
  const onVlan = isNew ? placement === 'vlan' : currentIface?.kind === 'vlan';
  const parentPort = config.interfaces.find((i) => i.name === (isNew ? (placement === 'vlan' ? parent : ownPort) : currentIface?.kind === 'vlan' ? currentIface.parent : currentIface?.name));
  const untaggedOnParent = onVlan ? config.networks.find((n) => n.interface === parentPort?.name) : null;

  return (
    <Modal
      wide
      title={isNew ? 'New network' : `Network ${net.name}`}
      description={isNew ? 'A network of its own: its own addresses, what it may reach, and addresses handed out. Nothing changes until you commit.' : 'Changes wait for a commit.'}
      onClose={onClose}
      footer={
        <>
          {!isNew && (
            <Button variant="danger" icon="trash" onClick={() => onDelete(config.networks[index])} style={{ marginRight: 'auto' }}>
              Delete
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canSave} onClick={async () => (await g.save(next, isNew ? `${net.name} added` : `${net.name} saved`)) && onClose()}>
            {isNew ? 'Add network' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Grid cols={2}>
          <Field label="Kind of network" help={NETWORK_PRESETS[net.purpose].hint}>
            <Select value={net.purpose} onChange={(e) => choosePurpose(e.target.value as NetworkPurpose)} options={PURPOSES.map((p) => ({ value: p, label: PURPOSE_WORDS[p] }))} />
          </Field>
          <Field label="Name" help={isNew ? 'Short, lower case: it names the network in firewall rules.' : 'Names stay (rules use them); delete and add to rename.'}>
            <Input value={net.name} disabled={!isNew} onChange={(e) => set({ name: e.target.value.toLowerCase() })} className="mono" />
          </Field>
        </Grid>
        {isNew && (
          <ChoiceCards
            label="Where it is"
            value={placement}
            onChange={setPlacement}
            options={[
              { value: 'vlan', title: 'A VLAN on a port', description: 'Shares a cable with other networks; your switch keeps them apart by tag.', icon: 'layers' },
              { value: 'port', title: 'A port of its own', description: 'Its own cable to its own switch.', icon: 'plug', detail: unusedPorts.length ? undefined : 'No free port' },
            ]}
          />
        )}
        {isNew && placement === 'vlan' && (
          <Grid cols={2}>
            <Field label="On the port">
              <Select value={parent} onChange={(e) => setParent(e.target.value)} options={ports.map((p) => ({ value: p.name, label: `${p.name}${p.description ? ` (${p.description})` : ''}` }))} />
            </Field>
            <Field label="VLAN tag" help={`1 to 4094; set the same on your switch. It will be ${parent}.${vlanId}.`}>
              <Input type="number" min={1} max={4094} value={vlanId} onChange={(e) => setVlanId(Number(e.target.value))} />
            </Field>
          </Grid>
        )}
        {isNew && placement === 'port' && (
          <Field label="Port">
            <Select value={ownPort} onChange={(e) => setOwnPort(e.target.value)} options={[{ value: '', label: unusedPorts.length ? 'Choose a port' : 'No free port', disabled: true }, ...unusedPorts]} />
          </Field>
        )}
        <Toggle
          checked={jumbo}
          onChange={setJumbo}
          label={`Jumbo frames (MTU ${JUMBO_MTU})`}
          title="Bigger packets: less work for the computers moving lots of data"
        />
        {!jumbo && net.purpose === 'mesh' && onVlan && untaggedOnParent && (
          <p className="fx-secondary gt-hint">
            Jumbo frames are off: {parentPort?.name} also carries {untaggedOnParent.name} untagged, which would get them too. For jumbo frames, give the mesh network a port of its own (or move {untaggedOnParent.name} onto a VLAN).
          </p>
        )}
        {jumbo && (
          <p className="fx-secondary gt-hint">
            Every switch and computer on this network must take jumbo frames. {parentPort && parentPort.mtu < JUMBO_MTU && onVlan ? `The port ${parentPort.name} goes to ${JUMBO_MTU} too.` : ''}
            {untaggedOnParent ? ` ${untaggedOnParent.name} (untagged on ${parentPort?.name}) then gets jumbo frames as well: give this network a port of its own if its devices cannot take them.` : ''}
          </p>
        )}
        <Grid cols={2}>
          <Field label="The gate's address and the network's size" help="Like 192.168.20.1/24: the gate is .1, devices get the rest.">
            <Input
              value={net.address}
              className="mono"
              onChange={(e) => {
                const address = e.target.value.trim();
                const wasAuto = JSON.stringify(autoRange(net.address)) === JSON.stringify({ start: net.dhcp.start, end: net.dhcp.end });
                set({ address, ...(wasAuto && isCidr(address) ? { dhcp: { ...net.dhcp, ...autoRange(address) } } : {}) });
              }}
            />
          </Field>
          <Field label="Description">
            <Input value={net.description} onChange={(e) => set({ description: e.target.value })} placeholder={PURPOSE_WORDS[net.purpose]} />
          </Field>
        </Grid>
        <ChoiceCards
          label="Devices here may reach"
          value={net.access}
          onChange={(access) => set({ access })}
          options={[
            { value: 'full', title: 'Everything', description: 'The internet and your other networks.', icon: 'globe' },
            { value: 'internet', title: 'The internet only', description: 'Kept away from your other networks.', icon: 'shield' },
            { value: 'isolated', title: 'Nothing outside', description: 'Only each other (and the gate for addresses and names).', icon: 'lock' },
          ]}
        />
        <Toggle checked={net.manage} onChange={(manage) => set({ manage })} label="Devices here may manage the gate (this console and SSH)" />
        <div className="gt-section">
          <Toggle checked={net.dhcp.enabled} onChange={(enabled) => setDhcp({ enabled })} label="Hand out addresses (DHCP)" />
          {net.dhcp.enabled && (
            <Grid cols={3}>
              <Field label="From">
                <Input value={net.dhcp.start} className="mono" onChange={(e) => setDhcp({ start: e.target.value.trim() })} />
              </Field>
              <Field label="To">
                <Input value={net.dhcp.end} className="mono" onChange={(e) => setDhcp({ end: e.target.value.trim() })} />
              </Field>
              <Field label="Kept for (hours)">
                <Input type="number" min={1} max={720} value={net.dhcp.leaseHours} onChange={(e) => setDhcp({ leaseHours: Number(e.target.value) })} />
              </Field>
            </Grid>
          )}
        </div>
        <div className="gt-section">
          <b>Reserved addresses</b>
          <p className="fx-secondary gt-hint">A device (by its MAC address) always gets the same address. Outside the range handed out is tidiest.</p>
          {net.dhcp.reservations.map((r, i) => (
            <div key={r.mac} className="gt-res-row">
              <span>{r.name ?? 'Unnamed'}</span>
              <span className="mono">{r.mac}</span>
              <span className="mono">{r.address}</span>
              <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove ${r.mac}`} onClick={() => setDhcp({ reservations: net.dhcp.reservations.filter((_x, k) => k !== i) })} />
            </div>
          ))}
          <div className="gt-res-row add">
            <Input placeholder="Name (nas)" value={res.name} onChange={(e) => setRes({ ...res, name: e.target.value })} />
            <Input placeholder="aa:bb:cc:dd:ee:ff" className="mono" value={res.mac} onChange={(e) => setRes({ ...res, mac: e.target.value.trim().toLowerCase().replace(/-/g, ':') })} />
            <Input placeholder="Address" className="mono" value={res.address} onChange={(e) => setRes({ ...res, address: e.target.value.trim() })} />
            <Button
              size="sm"
              icon="plus"
              disabled={!res.mac || !res.address}
              onClick={() => {
                setDhcp({ reservations: [...net.dhcp.reservations, { mac: res.mac, address: res.address, ...(res.name ? { name: res.name.replace(/\s+/g, '-') } : {}) }] });
                setRes({ mac: '', address: '', name: '' });
              }}
            >
              Reserve
            </Button>
          </div>
        </div>
        <IssueList errors={issues.errors} warnings={issues.warnings} />
      </div>
    </Modal>
  );
}

function WanModal({ config, onClose }: { config: GateConfig; onClose: () => void }) {
  const g = useGate();
  const sys = useSystemInterfaces();
  const [w, setW] = useState(structuredClone(config.wan));
  const options = [...new Set([...config.interfaces.filter((i) => i.kind === 'ethernet').map((i) => i.name), ...sys.filter((s) => s.kind === 'ethernet').map((s) => s.name)])];
  const next = structuredClone(config);
  next.wan = structuredClone(w);
  if (w.mode === 'dhcp') {
    delete next.wan.address;
    delete next.wan.gateway;
  }
  if (!next.interfaces.some((i) => i.name === w.interface)) next.interfaces.push({ name: w.interface, kind: 'ethernet', mtu: 1500, description: 'Internet' });
  const issues = draftIssues(next, (p, message) => p.startsWith('wan') || message.includes('internet port'));
  return (
    <Modal
      title="Internet"
      description="The port your internet line (modem or provider's box) plugs into. Changing it can cut you off: commit with a trial so it undoes itself."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!issues.shapeOk} onClick={async () => (await g.save(next, 'Internet settings saved')) && onClose()}>
            Save
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label="Port">
          <Select value={w.interface} onChange={(e) => setW({ ...w, interface: e.target.value })} options={options} />
        </Field>
        <ChoiceCards
          label="Address"
          value={w.mode}
          onChange={(mode) => setW({ ...w, mode })}
          options={[
            { value: 'dhcp', title: 'From the provider', description: 'Most home and office lines (DHCP).', icon: 'globe' },
            { value: 'static', title: 'Fixed', description: 'Your provider gave you an address and a gateway.', icon: 'tag' },
          ]}
        />
        {w.mode === 'static' && (
          <Grid cols={2}>
            <Field label="Address and size" help="Like 203.0.113.2/29">
              <Input className="mono" value={w.address ?? ''} onChange={(e) => setW({ ...w, address: e.target.value.trim() })} />
            </Field>
            <Field label="Gateway">
              <Input className="mono" value={w.gateway ?? ''} onChange={(e) => setW({ ...w, gateway: e.target.value.trim() })} />
            </Field>
          </Grid>
        )}
        <Toggle checked={w.ping} onChange={(ping) => setW({ ...w, ping })} label="Answer pings from the internet" />
        <IssueList errors={issues.errors} warnings={issues.warnings} />
      </div>
    </Modal>
  );
}

function PortModal({ config, name, usedBy, onClose }: { config: GateConfig; name: string | null; usedBy: (iface: string) => string | null; onClose: () => void }) {
  const g = useGate();
  const sys = useSystemInterfaces();
  const existing = name ? config.interfaces.find((i) => i.name === name) : null;
  const [i, setI] = useState<GateInterface>(existing ? structuredClone(existing) : { name: '', kind: 'ethernet', mtu: 1500, description: '' });
  const free = sys.filter((s) => s.kind === 'ethernet' && !config.interfaces.some((x) => x.name === s.name));
  const next = structuredClone(config);
  if (existing) next.interfaces[config.interfaces.indexOf(existing)] = i;
  else next.interfaces.push(i);
  const index = existing ? config.interfaces.indexOf(existing) : next.interfaces.length - 1;
  const issues = draftIssues(next, (p) => p.startsWith(`interfaces.${i.name}`) || p.startsWith(`interfaces.${index}`) || p === 'interfaces');
  const used = existing ? usedBy(existing.name) : null;
  return (
    <Modal
      title={existing ? `${existing.kind === 'vlan' ? 'VLAN' : 'Port'} ${existing.name}` : 'Add a port'}
      onClose={onClose}
      footer={
        <>
          {existing && (
            <Button
              variant="danger"
              icon="trash"
              style={{ marginRight: 'auto' }}
              disabled={!!used}
              title={used ? `It carries ${used}` : undefined}
              onClick={async () => (await g.edit((d) => void (d.interfaces = d.interfaces.filter((x) => x.name !== existing.name)), `${existing.name} removed`)) && onClose()}
            >
              Remove
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!issues.shapeOk || !i.name} onClick={async () => (await g.save(next, `${i.name} saved`)) && onClose()}>
            {existing ? 'Save' : 'Add'}
          </Button>
        </>
      }
    >
      <div className="fx-form">
        {!existing && (
          <Field label="Port on the server" help={free.length ? undefined : 'Every port the server has is in use already.'}>
            <Select
              value={i.name}
              onChange={(e) => setI({ ...i, name: e.target.value })}
              options={[{ value: '', label: 'Choose a port', disabled: true }, ...free.map((s) => ({ value: s.name, label: `${s.name}${s.speed ? ` · ${s.speed >= 1000 ? `${s.speed / 1000} Gb/s` : `${s.speed} Mb/s`}` : ''}${s.up ? ' · cable in' : ''}${s.mac ? ` · ${s.mac}` : ''}` }))]}
            />
          </Field>
        )}
        <Field label="Description">
          <Input value={i.description} onChange={(e) => setI({ ...i, description: e.target.value })} />
        </Field>
        <Field label="MTU" help={`1500 normally; ${JUMBO_MTU} for jumbo frames (everything on it must take them). A port carrying jumbo VLANs needs at least their size.`}>
          <Select value={String(i.mtu)} onChange={(e) => setI({ ...i, mtu: Number(e.target.value) })} options={[...new Set([1500, JUMBO_MTU, i.mtu])].map((m) => ({ value: String(m), label: m === 1500 ? '1500 (normal)' : m === JUMBO_MTU ? `${JUMBO_MTU} (jumbo frames)` : String(m) }))} />
        </Field>
        <IssueList errors={issues.errors} warnings={issues.warnings} />
      </div>
    </Modal>
  );
}
