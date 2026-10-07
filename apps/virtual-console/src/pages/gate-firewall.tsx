import { useState } from 'react';
import type { GateConfig, GateForward, GateRule } from '@fbrx/gate';
import { Button, Card, ChoiceCards, Empty, Field, formatNumber, Grid, Input, Modal, Select, Status, Table, Toggle, useConfirm } from '@fbrx/ui';
import { draftIssues, inItem, useGate } from '../gate-state';
import { useApp } from '../state';
import { ACCESS_WORDS, GatePage, IssueList, newId, zoneWords } from './gate-common';

const ACTION_TONE = { accept: 'good', drop: 'critical', reject: 'warning' } as const;
const ACTION_WORDS = { accept: 'Allow', drop: 'Block quietly', reject: 'Refuse' } as const;
const PROTO_WORDS: Record<GateRule['proto'], string> = { any: 'Anything', tcp: 'TCP', udp: 'UDP', 'tcp+udp': 'TCP and UDP', icmp: 'Ping (ICMP)' };

/** Ready-made rules people often want. */
const RECIPES: Array<{ label: string; rule: Omit<GateRule, 'id' | 'from' | 'to'> & { from?: string; to?: string } }> = [
  { label: 'Allow a network to print', rule: { name: 'Printing', enabled: true, proto: 'tcp', ports: '631,9100', action: 'accept', log: false } },
  { label: 'Allow screen casting', rule: { name: 'Screen casting', enabled: true, proto: 'tcp+udp', ports: '8008-8009,1900,5353', action: 'accept', log: false } },
  { label: 'Allow file sharing', rule: { name: 'File sharing', enabled: true, proto: 'tcp', ports: '445', action: 'accept', log: false } },
  { label: 'Block a network', rule: { name: 'Keep out', enabled: true, proto: 'any', action: 'drop', log: true } },
];

export function GateFirewallPage() {
  const app = useApp();
  const g = useGate();
  const { confirm, dialog } = useConfirm();
  const [rule, setRule] = useState<number | 'new' | null>(null);
  const [forward, setForward] = useState<number | 'new' | null>(null);
  const admin = app.can('admin');
  const hits = (key: string) => g.live?.counters[key]?.packets;
  return (
    <GatePage
      title="Firewall"
      description="Who may reach what. Each network's access sets the basics; rules here add exceptions, top to bottom, first match wins. Port forwards let something on the internet reach one device inside."
      actions={
        admin && (
          <>
            <Button icon="plus" onClick={() => setForward('new')}>
              Port forward
            </Button>
            <Button variant="primary" icon="plus" onClick={() => setRule('new')}>
              New rule
            </Button>
          </>
        )
      }
    >
      {(info) => {
        const c = info.state.candidate;
        const move = (i: number, by: -1 | 1) =>
          void g.edit((d) => {
            const [r] = d.firewall.rules.splice(i, 1);
            d.firewall.rules.splice(i + by, 0, r);
          });
        return (
          <>
            <Card title="The basics" subtitle="From each network's access (change it under Networks)" flush>
              <Table
                rows={c.networks}
                rowKey={(n) => n.name}
                empty={<Empty title="No networks yet" />}
                columns={[
                  { key: 'n', header: 'From', render: (n) => zoneWords(n.name, c) },
                  { key: 'i', header: 'The internet', render: (n) => <Status tone={n.access === 'isolated' ? 'critical' : 'good'}>{n.access === 'isolated' ? 'No' : 'Yes'}</Status> },
                  { key: 'o', header: 'Other networks', render: (n) => <Status tone={n.access === 'full' ? 'good' : 'critical'}>{n.access === 'full' ? 'Yes' : 'No'}</Status> },
                  { key: 'g', header: 'Manage the gate', render: (n) => <Status tone={n.manage ? 'good' : 'neutral'}>{n.manage ? 'Yes' : 'No'}</Status> },
                  { key: 'a', header: 'Access', render: (n) => <span className="fx-muted">{ACCESS_WORDS[n.access]}</span> },
                ]}
              />
              <div className="gt-foot">
                From the internet: nothing, except port forwards{c.vpn.enabled ? ' and the VPN' : ''}{c.wan.ping ? ' and pings' : ''}. Turned away so far: {formatNumber(hits('default:input') ?? 0)} knocking on the gate, {formatNumber(hits('default:forward') ?? 0)} passing through.
              </div>
            </Card>
            <Card title="Rules" subtitle="Top to bottom; the first that matches decides" flush>
              <Table
                rows={c.firewall.rules.map((r, i) => ({ r, i }))}
                rowKey={({ r }) => r.id}
                onRowClick={admin ? ({ i }) => setRule(i) : undefined}
                empty={<Empty title="No rules: the basics above decide everything" action={admin && <Button icon="plus" onClick={() => setRule('new')}>New rule</Button>} />}
                columns={[
                  {
                    key: 'o',
                    header: '',
                    width: 84,
                    render: ({ i }) =>
                      admin && (
                        <span className="fx-row" style={{ gap: 2, flexWrap: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                          <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up" title="Move up">
                            ↑
                          </Button>
                          <Button size="sm" variant="ghost" disabled={i === c.firewall.rules.length - 1} onClick={() => move(i, 1)} aria-label="Move down" title="Move down">
                            ↓
                          </Button>
                        </span>
                      ),
                  },
                  { key: 'n', header: 'Rule', render: ({ r }) => <div><div className="fx-cell-title">{r.name}</div><div className="fx-cell-sub">{r.enabled ? (r.log ? 'Logged' : '') : 'Switched off'}</div></div> },
                  { key: 'f', header: 'From → to', render: ({ r }) => `${zoneWords(r.from, c)} → ${zoneWords(r.to, c)}` },
                  { key: 'w', header: 'What', render: ({ r }) => <span>{PROTO_WORDS[r.proto]}{r.ports ? <span className="mono"> {r.ports}</span> : ''}{r.source ? <span className="fx-cell-sub"> from {r.source}</span> : ''}{r.destination ? <span className="fx-cell-sub"> to {r.destination}</span> : ''}</span> },
                  { key: 'a', header: 'Then', render: ({ r }) => <Status tone={r.enabled ? ACTION_TONE[r.action] : 'neutral'}>{ACTION_WORDS[r.action]}</Status> },
                  { key: 'h', header: 'Matched', render: ({ r }) => <span className="gt-rate">{hits(`rule:${r.id}`) == null ? '—' : formatNumber(hits(`rule:${r.id}`)!)}</span> },
                ]}
              />
            </Card>
            <Card title="Port forwards" subtitle="From the internet to one device inside" flush>
              <Table
                rows={c.firewall.forwards.map((f, i) => ({ f, i }))}
                rowKey={({ f }) => f.id}
                onRowClick={admin ? ({ i }) => setForward(i) : undefined}
                empty={<Empty title="Nothing is forwarded: nobody on the internet reaches in" />}
                columns={[
                  { key: 'n', header: 'Forward', render: ({ f }) => <div><div className="fx-cell-title">{f.name}</div><div className="fx-cell-sub">{f.enabled ? '' : 'Switched off'}</div></div> },
                  { key: 'p', header: 'Internet port', render: ({ f }) => <span className="mono">{f.proto.toUpperCase()} {f.port}</span> },
                  { key: 't', header: 'Goes to', render: ({ f }) => <span className="mono">{f.to}{f.toPort ? `:${f.toPort}` : ''}</span> },
                  { key: 's', header: 'Only from', render: ({ f }) => (f.source ? <span className="mono">{f.source}</span> : <span className="fx-muted">Anyone</span>) },
                  { key: 'h', header: 'Connections', render: ({ f }) => <span className="gt-rate">{hits(`forward:${f.id}`) == null ? '—' : formatNumber(hits(`forward:${f.id}`)!)}</span> },
                ]}
              />
            </Card>
            {rule !== null && (
              <RuleModal
                config={c}
                index={rule === 'new' ? null : rule}
                onClose={() => setRule(null)}
                onDelete={async (r) => {
                  if (await confirm({ title: `Delete the rule “${r.name}”?`, confirmLabel: 'Delete', danger: true }))
                    if (await g.edit((d) => void (d.firewall.rules = d.firewall.rules.filter((x) => x.id !== r.id)), 'Rule deleted')) setRule(null);
                }}
              />
            )}
            {forward !== null && (
              <ForwardModal
                config={c}
                index={forward === 'new' ? null : forward}
                onClose={() => setForward(null)}
                onDelete={async (f) => {
                  if (await confirm({ title: `Stop forwarding “${f.name}”?`, confirmLabel: 'Delete', danger: true }))
                    if (await g.edit((d) => void (d.firewall.forwards = d.firewall.forwards.filter((x) => x.id !== f.id)), 'Port forward deleted')) setForward(null);
                }}
              />
            )}
            {dialog}
          </>
        );
      }}
    </GatePage>
  );
}

function zoneOptions(c: GateConfig, from: boolean) {
  return [
    ...c.networks.map((n) => ({ value: n.name, label: zoneWords(n.name, c) })),
    { value: 'wan', label: 'Internet' },
    ...(c.vpn.enabled ? [{ value: 'vpn', label: 'VPN devices' }] : []),
    ...(from ? [] : [{ value: 'gate', label: 'The gate itself' }]),
    { value: 'any', label: 'Anywhere' },
  ];
}

function RuleModal({ config, index, onClose, onDelete }: { config: GateConfig; index: number | null; onClose: () => void; onDelete: (r: GateRule) => void }) {
  const g = useGate();
  const isNew = index === null;
  const [r, setR] = useState<GateRule>(() =>
    isNew ? { id: '', name: '', enabled: true, from: config.networks[0]?.name ?? 'any', to: config.networks[1]?.name ?? 'wan', proto: 'tcp', ports: '', action: 'accept', log: false } : structuredClone(config.firewall.rules[index]),
  );
  const set = (patch: Partial<GateRule>) => setR((x) => ({ ...x, ...patch }));
  const clean: GateRule = { ...r, id: r.id || newId(r.name, config.firewall.rules.map((x) => x.id).concat(config.firewall.forwards.map((f) => f.id))) };
  for (const k of ['ports', 'source', 'destination'] as const) if (!clean[k]) delete clean[k];
  if (!['tcp', 'udp', 'tcp+udp'].includes(clean.proto)) delete clean.ports;
  const next = structuredClone(config);
  if (isNew) next.firewall.rules.push(clean);
  else next.firewall.rules[index] = clean;
  const idx = isNew ? next.firewall.rules.length - 1 : index;
  const issues = draftIssues(next, inItem('firewall.rules', idx, clean.id));
  return (
    <Modal
      wide
      title={isNew ? 'New rule' : `Rule “${r.name}”`}
      onClose={onClose}
      footer={
        <>
          {!isNew && (
            <Button variant="danger" icon="trash" style={{ marginRight: 'auto' }} onClick={() => onDelete(config.firewall.rules[index])}>
              Delete
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!issues.shapeOk || !r.name.trim()} onClick={async () => (await g.save(next, isNew ? 'Rule added' : 'Rule saved')) && onClose()}>
            {isNew ? 'Add rule' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="fx-form">
        {isNew && (
          <div className="vt-chips">
            {RECIPES.map((x) => (
              <button key={x.label} type="button" className="vt-chip" onClick={() => set({ ports: '', source: '', destination: '', ...x.rule })}>
                {x.label}
              </button>
            ))}
          </div>
        )}
        <Grid cols={2}>
          <Field label="Name">
            <Input value={r.name} onChange={(e) => set({ name: e.target.value })} placeholder="Laptops reach the printer" />
          </Field>
          <Field label="Then">
            <Select value={r.action} onChange={(e) => set({ action: e.target.value as GateRule['action'] })} options={[{ value: 'accept', label: 'Allow' }, { value: 'reject', label: 'Refuse (the sender is told)' }, { value: 'drop', label: 'Block quietly (the sender hears nothing)' }]} />
          </Field>
          <Field label="From">
            <Select value={r.from} onChange={(e) => set({ from: e.target.value })} options={zoneOptions(config, true)} />
          </Field>
          <Field label="To">
            <Select value={r.to} onChange={(e) => set({ to: e.target.value })} options={zoneOptions(config, false)} />
          </Field>
          <Field label="What">
            <Select value={r.proto} onChange={(e) => set({ proto: e.target.value as GateRule['proto'] })} options={Object.entries(PROTO_WORDS).map(([value, label]) => ({ value, label }))} />
          </Field>
          <Field label="Ports" help="Like 443, 80,443 or 6000-6100 (TCP or UDP only). Empty: every port.">
            <Input className="mono" value={r.ports ?? ''} disabled={!['tcp', 'udp', 'tcp+udp'].includes(r.proto)} onChange={(e) => set({ ports: e.target.value.replace(/\s+/g, '') })} />
          </Field>
          <Field label="Only from addresses" help="Optional: a device (10.0.0.5/32) or part of the network.">
            <Input className="mono" value={r.source ?? ''} onChange={(e) => set({ source: e.target.value.trim() })} placeholder="any" />
          </Field>
          <Field label="Only to addresses" help="Optional, like 192.168.1.20/32 for the printer.">
            <Input className="mono" value={r.destination ?? ''} onChange={(e) => set({ destination: e.target.value.trim() })} placeholder="any" />
          </Field>
        </Grid>
        <div className="fx-row" style={{ gap: 24, flexWrap: 'wrap' }}>
          <Toggle checked={r.enabled} onChange={(enabled) => set({ enabled })} label="Switched on" />
          <Toggle checked={r.log} onChange={(log) => set({ log })} label="Log what matches" />
        </div>
        <IssueList errors={issues.errors} warnings={issues.warnings} />
      </div>
    </Modal>
  );
}

function ForwardModal({ config, index, onClose, onDelete }: { config: GateConfig; index: number | null; onClose: () => void; onDelete: (f: GateForward) => void }) {
  const g = useGate();
  const isNew = index === null;
  const [f, setF] = useState<GateForward>(() => (isNew ? { id: '', name: '', enabled: true, proto: 'tcp', port: '', to: '' } : structuredClone(config.firewall.forwards[index])));
  const [kind, setKind] = useState<'same' | 'other'>(f.toPort ? 'other' : 'same');
  const set = (patch: Partial<GateForward>) => setF((x) => ({ ...x, ...patch }));
  const clean: GateForward = { ...f, id: f.id || newId(f.name, config.firewall.forwards.map((x) => x.id).concat(config.firewall.rules.map((r) => r.id))) };
  if (kind === 'same' || !clean.toPort) delete clean.toPort;
  if (!clean.source) delete clean.source;
  const next = structuredClone(config);
  if (isNew) next.firewall.forwards.push(clean);
  else next.firewall.forwards[index] = clean;
  const idx = isNew ? next.firewall.forwards.length - 1 : index;
  const issues = draftIssues(next, inItem('firewall.forwards', idx, clean.id));
  const devices = (g.live?.leases ?? []).filter((l) => l.name);
  return (
    <Modal
      title={isNew ? 'New port forward' : `Port forward “${f.name}”`}
      description="Something on the internet reaches one device inside on this port. Only forward what must be reachable, and keep that device up to date."
      onClose={onClose}
      footer={
        <>
          {!isNew && (
            <Button variant="danger" icon="trash" style={{ marginRight: 'auto' }} onClick={() => onDelete(config.firewall.forwards[index])}>
              Delete
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!issues.shapeOk || !f.name.trim()} onClick={async () => (await g.save(next, isNew ? 'Port forward added' : 'Port forward saved')) && onClose()}>
            {isNew ? 'Add' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label="Name">
          <Input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="Web server" />
        </Field>
        <Grid cols={2}>
          <Field label="Protocol">
            <Select value={f.proto} onChange={(e) => set({ proto: e.target.value as GateForward['proto'] })} options={[{ value: 'tcp', label: 'TCP' }, { value: 'udp', label: 'UDP' }, { value: 'tcp+udp', label: 'TCP and UDP' }]} />
          </Field>
          <Field label="Internet port" help="Like 443 or 6000-6100">
            <Input className="mono" value={f.port} onChange={(e) => set({ port: e.target.value.replace(/\s+/g, '') })} />
          </Field>
        </Grid>
        <Field label="Device inside" help={devices.length ? 'Its address; better reserved under Networks so it does not change.' : 'Its address; reserve it under Networks so it does not change.'}>
          <Input className="mono" value={f.to} onChange={(e) => set({ to: e.target.value.trim() })} list="gt-devices" placeholder="192.168.1.20" />
          <datalist id="gt-devices">
            {devices.map((d) => (
              <option key={d.mac} value={d.address}>
                {d.name}
              </option>
            ))}
          </datalist>
        </Field>
        <ChoiceCards
          label="On the device"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'same', title: 'The same port', icon: 'link' },
            { value: 'other', title: 'Another port', description: 'Single ports only.', icon: 'refresh' },
          ]}
        />
        {kind === 'other' && (
          <Field label="Its port">
            <Input type="number" min={1} max={65535} value={f.toPort ?? ''} onChange={(e) => set({ toPort: e.target.value ? Number(e.target.value) : undefined })} />
          </Field>
        )}
        <Field label="Only from" help="Optional: an address or network on the internet (your office, say). Empty: anyone.">
          <Input className="mono" value={f.source ?? ''} onChange={(e) => set({ source: e.target.value.trim() })} placeholder="anyone" />
        </Field>
        <Toggle checked={f.enabled} onChange={(enabled) => set({ enabled })} label="Switched on" />
        <IssueList errors={issues.errors} warnings={issues.warnings} />
      </div>
    </Modal>
  );
}
