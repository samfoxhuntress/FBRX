import { useEffect, useState } from 'react';
import { isIPv4 } from '@fbrx/shared';
import type { GateConfig, GatePeer, GateState } from '@fbrx/gate';
import { Button, Callout, Card, ChoiceCards, CopyText, Empty, Field, formatBytes, Grid, Input, KeyValue, Modal, Status, Table, Tabs, TextArea, timeAgo, Toggle, useConfirm } from '@fbrx/ui';
import { api } from '../api';
import { draftIssues, useGate } from '../gate-state';
import { useApp, useRoute } from '../state';
import { GatePage, IssueList, vpnGateAddress } from './gate-common';

type Tab = 'dns' | 'vpn';

/** DNS (names for your devices, blocking) and the VPN (your devices reaching home from anywhere). */
export function GateServicesPage({ tab }: { tab?: string }) {
  const [, go] = useRoute();
  const active: Tab = tab === 'vpn' ? 'vpn' : 'dns';
  return (
    <GatePage title="DNS & VPN" description="Names: the gate answers your devices' questions, knows your own devices by name, and can block ads and known bad places. VPN: your phone and laptop reach home, safely, from anywhere.">
      {(info) => (
        <>
          <Tabs<Tab>
            active={active}
            onChange={(t) => go('gate-dns', t)}
            tabs={[
              { id: 'dns', label: 'Names (DNS)' },
              { id: 'vpn', label: `VPN${info.state.candidate.vpn.peers.length ? ` · ${info.state.candidate.vpn.peers.length}` : ''}` },
            ]}
          />
          {active === 'dns' ? <Dns config={info.state.candidate} /> : <Vpn config={info.state.candidate} state={info.state} />}
        </>
      )}
    </GatePage>
  );
}

const lines = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

function Dns({ config }: { config: GateConfig }) {
  const app = useApp();
  const g = useGate();
  const admin = app.can('admin');
  const [dns, setDns] = useState(() => structuredClone(config.dns));
  const [upstream, setUpstream] = useState(config.dns.upstream.join(', '));
  const [domains, setDomains] = useState(config.dns.block.domains.join('\n'));
  const [lists, setLists] = useState(config.dns.block.lists.join('\n'));
  const [rec, setRec] = useState({ name: '', address: '' });
  // Follow the candidate when it changes elsewhere (another tab, the command line).
  const key = JSON.stringify(config.dns);
  useEffect(() => {
    setDns(structuredClone(config.dns));
    setUpstream(config.dns.upstream.join(', '));
    setDomains(config.dns.block.domains.join('\n'));
    setLists(config.dns.block.lists.join('\n'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const draft: GateConfig['dns'] = { ...dns, upstream: lines(upstream), block: { ...dns.block, domains: lines(domains), lists: lines(lists) } };
  const next = { ...structuredClone(config), dns: draft };
  const issues = draftIssues(next, (p) => p.startsWith('dns'));
  const dirty = JSON.stringify(draft) !== JSON.stringify(config.dns);
  const sample = config.networks[0];
  return (
    <>
      <Grid cols={2}>
        <Card title="Answering">
          <fieldset className="vt-fieldset" disabled={!admin}>
            <Field label="Ask these when the gate does not know" help="Up to four, like 1.1.1.1, 9.9.9.9">
              <Input className="mono" value={upstream} onChange={(e) => setUpstream(e.target.value)} />
            </Field>
            <Field label="Your own domain" help={`A device called nas is nas.${draft.domain || 'lan'} (and just nas).`}>
              <Input className="mono" value={dns.domain} onChange={(e) => setDns({ ...dns, domain: e.target.value.trim() })} />
            </Field>
            <Toggle checked={dns.logQueries} onChange={(logQueries) => setDns({ ...dns, logQueries })} label="Keep a log of questions (FBRX MiniDome reads it to spot threats)" />
          </fieldset>
        </Card>
        <Card title="Blocking">
          <fieldset className="vt-fieldset" disabled={!admin}>
            <Toggle checked={dns.block.enabled} onChange={(enabled) => setDns({ ...dns, block: { ...dns.block, enabled } })} label="Block ads, trackers and known bad places" />
            <Field label="Blocklists" help="Web addresses of hosts files or domain lists, one per line. The gate fetches them now and then.">
              <TextArea code rows={3} value={lists} onChange={(e) => setLists(e.target.value)} placeholder="https://example.org/blocklist.txt" />
            </Field>
            <Field label="Also block" help="Domains, one per line (their subdomains too).">
              <TextArea code rows={3} value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="ads.example.com" />
            </Field>
          </fieldset>
        </Card>
      </Grid>
      <Card title="Your devices by name" subtitle={`Devices that ask for an address are known by their own name already${sample ? ` (laptop.${config.dns.domain})` : ''}. Add others here.`} flush>
        <Table
          rows={draft.records}
          rowKey={(r) => r.name}
          empty={<Empty title="No names of your own yet" />}
          columns={[
            { key: 'n', header: 'Name', render: (r) => <span className="mono">{r.name}</span> },
            { key: 'a', header: 'Address', render: (r) => <span className="mono">{r.address}</span> },
            {
              key: 'x',
              header: '',
              render: (r) =>
                admin && <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove ${r.name}`} onClick={() => setDns({ ...dns, records: dns.records.filter((x) => x.name !== r.name) })} />,
            },
          ]}
        />
        {admin && (
          <div className="gt-res-row add gt-pad">
            <Input placeholder={`nas.${draft.domain || 'lan'}`} className="mono" value={rec.name} onChange={(e) => setRec({ ...rec, name: e.target.value.trim() })} />
            <Input placeholder="192.168.1.20" className="mono" value={rec.address} onChange={(e) => setRec({ ...rec, address: e.target.value.trim() })} />
            <Button
              size="sm"
              icon="plus"
              disabled={!rec.name || !isIPv4(rec.address)}
              onClick={() => {
                setDns({ ...dns, records: [...dns.records, rec] });
                setRec({ name: '', address: '' });
              }}
            >
              Add
            </Button>
          </div>
        )}
      </Card>
      <IssueList errors={issues.errors} warnings={issues.warnings} />
      {admin && dirty && (
        <div className="vt-savebar">
          <span>Names and blocking changed</span>
          <span className="fx-spacer" />
          <Button
            onClick={() => {
              setDns(structuredClone(config.dns));
              setUpstream(config.dns.upstream.join(', '));
              setDomains(config.dns.block.domains.join('\n'));
              setLists(config.dns.block.lists.join('\n'));
            }}
          >
            Undo
          </Button>
          <Button variant="primary" disabled={!issues.shapeOk} onClick={() => void g.save(next, 'DNS settings saved')}>
            Save
          </Button>
        </div>
      )}
    </>
  );
}

interface NewPeer {
  peer: GatePeer;
  config: string;
  qr: string;
  state: GateState;
}

function Vpn({ config, state }: { config: GateConfig; state: GateState }) {
  const app = useApp();
  const g = useGate();
  const admin = app.can('admin');
  const { confirm, dialog } = useConfirm();
  const [adding, setAdding] = useState(false);
  const [settings, setSettings] = useState(false);
  const live = (key: string) => g.live?.vpn.find((p) => p.publicKey === key);
  const running = state.running?.vpn;
  return (
    <>
      {!config.vpn.enabled && (
        <Callout tone="info" title="The VPN is off" actions={admin && <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>Add a device</Button>}>
          Adding a device switches it on. Your phone or laptop then reaches home (and uses its internet, if you like) from anywhere, through an encrypted tunnel. Uses WireGuard: the free WireGuard app on the device scans a QR code.
        </Callout>
      )}
      <Grid cols={2}>
        <Card title="Tunnel" actions={admin && <Button size="sm" icon="edit" onClick={() => setSettings(true)}>Change</Button>}>
          <KeyValue
            items={[
              ['State', config.vpn.enabled ? (running?.enabled ? <Status tone="good">On</Status> : <Status tone="warning">On after the next commit</Status>) : <Status tone="neutral">Off</Status>],
              ['Port', `UDP ${config.vpn.port} on the internet side`],
              ['Addresses', `${config.vpn.address} (the gate is ${vpnGateAddress(config)})`],
              ['Devices reach', config.vpn.access === 'full' ? 'Your networks and the internet' : 'The internet only (through home)'],
              ['Gate key', state.vpnPublicKey ? <span className="mono gt-key">{state.vpnPublicKey}</span> : 'Made at the first commit with the VPN on'],
            ]}
          />
        </Card>
        <Card title="Your public address">
          <p className="fx-secondary" style={{ marginTop: 0 }}>
            Devices find home at {g.live?.wan.address ? <b className="mono">{g.live.wan.address}</b> : 'the gate’s internet address'}. If your provider changes it now and then, use a dynamic DNS name for it when adding devices.
          </p>
          <p className="fx-secondary" style={{ marginBottom: 0 }}>Behind another router? Forward UDP {config.vpn.port} on it to this gate.</p>
        </Card>
      </Grid>
      <Card title="Devices" actions={admin && config.vpn.enabled && <Button size="sm" variant="primary" icon="plus" onClick={() => setAdding(true)}>Add a device</Button>} flush>
        <Table<GatePeer>
          rows={config.vpn.peers}
          rowKey={(p) => p.publicKey}
          empty={<Empty title="No devices yet" />}
          columns={[
            { key: 'n', header: 'Device', render: (p) => <div><div className="fx-cell-title">{p.name}</div><div className="fx-cell-sub mono gt-key">{p.publicKey}</div></div> },
            { key: 'a', header: 'Address', render: (p) => <span className="mono">{p.address}</span> },
            {
              key: 's',
              header: 'Last seen',
              render: (p) => {
                const l = live(p.publicKey);
                if (!running?.peers.some((x) => x.publicKey === p.publicKey)) return <Status tone="neutral">After the next commit</Status>;
                if (!l?.latestHandshake) return <Status tone="neutral">Never</Status>;
                const fresh = Date.now() - Date.parse(l.latestHandshake) < 180_000;
                return (
                  <div>
                    <Status tone={fresh ? 'good' : 'neutral'}>{fresh ? 'Connected' : timeAgo(l.latestHandshake)}</Status>
                    {l.endpoint && <div className="fx-cell-sub mono">{l.endpoint}</div>}
                  </div>
                );
              },
            },
            { key: 't', header: 'Traffic', render: (p) => { const l = live(p.publicKey); return l ? `${formatBytes(l.rxBytes)} in · ${formatBytes(l.txBytes)} out` : '—'; } },
            {
              key: 'x',
              header: '',
              render: (p) =>
                admin && (
                  <Button
                    size="sm"
                    variant="danger"
                    icon="trash"
                    aria-label={`Remove ${p.name}`}
                    onClick={async () => {
                      if (await confirm({ title: `Remove ${p.name} from the VPN?`, body: <p className="fx-secondary">It cannot connect any more after the next commit. To let it back, add it again (with new settings).</p>, confirmLabel: 'Remove', danger: true }))
                        await g.edit((d) => void (d.vpn.peers = d.vpn.peers.filter((x) => x.publicKey !== p.publicKey)), `${p.name} removed`);
                    }}
                  />
                ),
            },
          ]}
        />
      </Card>
      {adding && <AddPeer onClose={() => setAdding(false)} />}
      {settings && <TunnelModal config={config} onClose={() => setSettings(false)} />}
      {dialog}
    </>
  );
}

function AddPeer({ onClose }: { onClose: () => void }) {
  const g = useGate();
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [fullTunnel, setFullTunnel] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<NewPeer | null>(null);
  const valid = /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,39}$/.test(name);
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([made!.config], { type: 'text/plain' }));
    a.download = `${made!.peer.name.replace(/[^a-zA-Z0-9._-]+/g, '-')}.conf`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  if (made)
    return (
      <Modal
        title={`${made.peer.name} is ready`}
        description="Scan the code with the WireGuard app on the device (Add tunnel → Scan from QR code), or send it the settings file. This is shown once: the gate does not keep the device's private key."
        onClose={onClose}
        footer={
          <>
            <Button icon="download" onClick={download}>
              Settings file
            </Button>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        }
      >
        <div className="gt-peer">
          <img src={made.qr} alt={`QR code with the VPN settings for ${made.peer.name}`} width={240} height={240} className="vt-pair-qr" />
          <div className="fx-form">
            <KeyValue items={[['Address', made.peer.address], ['Uses home for', fullTunnel ? 'Everything (the internet too)' : 'Your networks only']]} />
            <Callout tone="warning">It works after you commit the change (the banner at the top).</Callout>
            <details>
              <summary className="fx-secondary">Settings as text</summary>
              <CopyText value={made.config} secret />
            </details>
          </div>
        </div>
      </Modal>
    );
  return (
    <Modal
      title="Add a device to the VPN"
      description="The gate makes the device's keys and settings. Nothing changes on the network until you commit."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!valid}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const r = await api<NewPeer>('POST', '/v1/gate/vpn/peers', { name: name.trim(), endpoint: endpoint.trim() || undefined, fullTunnel });
                g.setState(r.state);
                setMade(r);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Make its settings
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label="Device" help="Letters, digits, spaces, dots and dashes.">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Sam's phone" autoFocus />
        </Field>
        <Field label="Home's address on the internet" help={`Empty: ${g.live?.wan.address ?? 'the gate’s internet address now'}. A name (home.example.org) keeps working when your provider changes the address.`}>
          <Input className="mono" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder={g.live?.wan.address ?? ''} />
        </Field>
        <ChoiceCards
          label="Through home"
          value={fullTunnel ? 'all' : 'home'}
          onChange={(v) => setFullTunnel(v === 'all')}
          options={[
            { value: 'all', title: 'Everything', description: 'Safer on hotel and café Wi-Fi: all its traffic goes through home.', icon: 'shield' },
            { value: 'home', title: 'Only home', description: 'Just your networks; the rest goes straight out.', icon: 'house' },
          ]}
        />
        {error && <Callout tone="critical">{error}</Callout>}
      </div>
    </Modal>
  );
}

function TunnelModal({ config, onClose }: { config: GateConfig; onClose: () => void }) {
  const g = useGate();
  const [v, setV] = useState(() => structuredClone(config.vpn));
  const next = { ...structuredClone(config), vpn: v };
  const issues = draftIssues(next, (p, m) => p.startsWith('vpn') || m.includes('VPN'));
  return (
    <Modal
      title="VPN tunnel"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!issues.shapeOk} onClick={async () => (await g.save(next, 'VPN settings saved')) && onClose()}>
            Save
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Toggle checked={v.enabled} onChange={(enabled) => setV({ ...v, enabled })} label="VPN on" />
        <Grid cols={2}>
          <Field label="Port (UDP)" help="Devices already set up need new settings if it changes.">
            <Input type="number" min={1} max={65535} value={v.port} onChange={(e) => setV({ ...v, port: Number(e.target.value) })} />
          </Field>
          <Field label="Tunnel addresses" help="The gate's address in the tunnel, with its size.">
            <Input className="mono" value={v.address} onChange={(e) => setV({ ...v, address: e.target.value.trim() })} />
          </Field>
        </Grid>
        <ChoiceCards
          label="Devices may reach"
          value={v.access}
          onChange={(access) => setV({ ...v, access })}
          options={[
            { value: 'full', title: 'Your networks and the internet', icon: 'house' },
            { value: 'internet', title: 'The internet only', description: 'Through home, but kept out of your networks.', icon: 'globe' },
          ]}
        />
        <IssueList errors={issues.errors} warnings={issues.warnings} />
      </div>
    </Modal>
  );
}
