import { useEffect, useMemo, useState } from 'react';
import { NETENV_KIND_NAMES, type NetEnvClient, type NetEnvDevice, type NetEnvironment, type NetEnvOverview, type NetEnvProbe, type NetEnvVoucher } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Field, Grid, Input, KeyValue, Modal, Select, StatTile, Status, Table, formatDate, useAction, useConfirm, useToast, type Column } from '@fbrx/ui';
import { call } from '../client';
import { useCore } from '../hooks';
import { AskButton } from '../widgets';

/**
 * Network Center → Environments (Endpoint Ultra): attach the UniFi console that runs the school or office network,
 * then see every gateway, switch and access point, who is connected where, restart a device, and make guest Wi-Fi
 * codes. The agent can read the same view (and asks before it restarts anything).
 */

const STATE_TONE: Record<NetEnvDevice['state'], 'good' | 'critical' | 'busy' | 'warning' | 'neutral'> = { online: 'good', offline: 'critical', updating: 'busy', pending: 'warning', other: 'neutral' };
const CLIENT_LABEL: Record<NetEnvClient['type'], string> = { wired: 'Wired', wireless: 'Wi-Fi', vpn: 'VPN', other: 'Other' };

export function Environments() {
  const envs = useCore('netenv.list', undefined, ['netenv.changed', 'vault.changed']);
  const vault = useCore('vault.status', undefined, ['vault.changed']);
  const [picked, setPicked] = useState<string | null>(null);
  const [editing, setEditing] = useState<NetEnvironment | 'new' | null>(null);
  const list = envs.data ?? [];
  const env = list.find((e) => e.id === picked) ?? list[0] ?? null;

  if (envs.error) return <Callout tone="warning">{envs.error}</Callout>;
  return (
    <>
      {vault.data && vault.data.state !== 'unlocked' && <Callout tone="warning">Unlock the vault in Credentials: the console's API key is kept there.</Callout>}
      {!list.length ? (
        <Card>
          <Empty title="Attach your network" action={<Button variant="primary" icon="plus" onClick={() => setEditing('new')}>Attach a UniFi console</Button>}>
            See every gateway, switch and access point on the school or office network, who is connected where, and restart a device or make guest Wi-Fi codes without opening UniFi. The agent can answer questions about the whole network too.
          </Empty>
        </Card>
      ) : (
        <>
          <div className="fx-actions" style={{ marginBottom: 12 }}>
            {list.length > 1 && (
              <div style={{ width: 260 }}>
                <Select aria-label="Network environment" value={env?.id ?? ''} onChange={(e) => setPicked(e.target.value)} options={list.map((e) => ({ value: e.id, label: e.name }))} />
              </div>
            )}
            <span className="fx-spacer" />
            {env && (
              <Button size="sm" icon="settings" onClick={() => setEditing(env)}>
                Edit
              </Button>
            )}
            <Button size="sm" icon="plus" onClick={() => setEditing('new')}>
              Attach another
            </Button>
          </div>
          {env && <EnvironmentView key={env.id} env={env} />}
        </>
      )}
      {editing && <EnvironmentEditor env={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(e) => setPicked(e.id)} />}
    </>
  );
}

function EnvironmentView({ env }: { env: NetEnvironment }) {
  const [site, setSite] = useState<string | undefined>(env.defaultSiteId ?? undefined);
  const [data, setData] = useState<NetEnvOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [device, setDevice] = useState<NetEnvDevice | null>(null);
  const [guest, setGuest] = useState(false);
  const load = (siteId = site) => {
    setLoading(true);
    call('netenv.overview', { id: env.id, siteId })
      .then((o) => {
        setData(o);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
    const t = setInterval(() => load(), 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env.id, site]);

  const perDevice = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of data?.clients ?? []) if (c.uplinkDeviceId) m.set(c.uplinkDeviceId, (m.get(c.uplinkDeviceId) ?? 0) + 1);
    return m;
  }, [data]);
  const names = useMemo(() => new Map((data?.devices ?? []).map((d) => [d.id, d.name])), [data]);

  if (!data) {
    return (
      <Card title={env.name} subtitle={env.url}>
        {error ? (
          <Callout tone="critical" title="Could not reach the console" actions={<Button size="sm" icon="refresh" onClick={() => load()}>Try again</Button>}>
            {error}
          </Callout>
        ) : (
          <p className="fx-muted">Reading the network…</p>
        )}
      </Card>
    );
  }
  const offline = data.devices.filter((d) => d.state === 'offline');
  const updates = data.devices.filter((d) => d.firmwareUpdatable);
  const wifi = data.clients.filter((c) => c.type === 'wireless').length;
  const q = filter.trim().toLowerCase();
  const clients = q ? data.clients.filter((c) => [c.name, c.ip, c.mac, c.uplinkDeviceId ? names.get(c.uplinkDeviceId) : ''].some((x) => x?.toLowerCase().includes(q))) : data.clients;

  const deviceCols: Column<NetEnvDevice>[] = [
    { key: 'name', header: 'Device', render: (d) => <b>{d.name}</b> },
    { key: 'model', header: 'Model', render: (d) => <span className="fx-muted">{d.model || '—'}</span> },
    { key: 'roles', header: 'Role', render: (d) => d.roles.join(', ') || '—' },
    { key: 'ip', header: 'Address', render: (d) => <span className="mono">{d.ip ?? '—'}</span>, width: 130 },
    { key: 'state', header: 'State', render: (d) => <Status tone={STATE_TONE[d.state]}>{d.state}</Status>, width: 110 },
    { key: 'clients', header: 'Clients', render: (d) => perDevice.get(d.id) ?? 0, width: 80 },
    { key: 'fw', header: 'Firmware', render: (d) => <span className="mono fx-muted">{d.firmware ?? '—'}{d.firmwareUpdatable ? ' ↑' : ''}</span>, width: 120 },
  ];
  const clientCols: Column<NetEnvClient>[] = [
    { key: 'name', header: 'Client', render: (c) => c.name },
    { key: 'type', header: 'Connection', render: (c) => CLIENT_LABEL[c.type], width: 100 },
    { key: 'ip', header: 'Address', render: (c) => <span className="mono">{c.ip ?? '—'}</span>, width: 130 },
    { key: 'mac', header: 'MAC', render: (c) => <span className="mono fx-muted">{c.mac ?? '—'}</span>, width: 150 },
    { key: 'on', header: 'Connected to', render: (c) => (c.uplinkDeviceId ? (names.get(c.uplinkDeviceId) ?? '—') : '—') },
    { key: 'since', header: 'Since', render: (c) => <span className="fx-muted">{c.connectedAt ? formatDate(c.connectedAt) : '—'}</span>, width: 150 },
  ];
  return (
    <>
      <Grid cols={4}>
        <StatTile label="Devices online" value={`${data.devices.length - offline.length} / ${data.devices.length}`} foot={offline.length ? <Status tone="critical">{offline.length} offline</Status> : <Status tone="good">all online</Status>} />
        <StatTile label="Clients" value={data.clients.length} foot={`${wifi} on Wi-Fi, ${data.clients.length - wifi} wired or VPN`} />
        <StatTile label="Firmware updates" value={updates.length} foot={updates.length ? updates.map((d) => d.name).slice(0, 3).join(', ') : 'everything current'} />
        <StatTile label="Console" value={<span style={{ fontSize: 18 }}>{NETENV_KIND_NAMES[env.kind]}</span>} foot={<span className="mono">{new URL(env.url).host}{env.trust === 'pinned' ? ' · pinned certificate' : ''}</span>} />
      </Grid>
      <Card
        title={`Devices · ${data.site.name}`}
        subtitle={`Updated ${formatDate(data.fetchedAt)}. Click a device for its health and actions.`}
        actions={
          <>
            {data.sites.length > 1 && (
              <div style={{ width: 200 }}>
                <Select aria-label="Site" value={data.site.id} onChange={(e) => setSite(e.target.value)} options={data.sites.map((s) => ({ value: s.id, label: s.name }))} />
              </div>
            )}
            <Button size="sm" icon="ticket" onClick={() => setGuest(true)}>
              Guest Wi-Fi codes
            </Button>
            <AskButton label="Ask about this network" prompt="Here is the current state of my school or office network from the UniFi console. Summarize its health, point out anything offline or worrying, and suggest what to do." context={{ site: data.site.name, devices: data.devices.map((d) => ({ ...d, clients: perDevice.get(d.id) ?? 0 })), clients: data.clients.length }} />
            <Button size="sm" icon="refresh" loading={loading} onClick={() => load()}>
              Refresh
            </Button>
          </>
        }
      >
        <Table columns={deviceCols} rows={data.devices} rowKey={(d) => d.id} onRowClick={setDevice} empty={<Empty title="No devices on this site" />} />
      </Card>
      <Card title={`Clients (${clients.length})`} actions={<div style={{ width: 240 }}><Input placeholder="Find a name, IP or MAC" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Find a client" /></div>}>
        <Table columns={clientCols} rows={clients.slice(0, 500)} rowKey={(c) => c.id} empty={<Empty title={q ? 'Nothing matches' : 'No clients connected'} />} />
      </Card>
      {device && <DeviceDialog env={env} siteId={data.site.id} device={device} clients={perDevice.get(device.id) ?? 0} onClose={() => setDevice(null)} onChanged={() => load()} />}
      {guest && <GuestCodes env={env} siteId={data.site.id} onClose={() => setGuest(false)} />}
    </>
  );
}

function DeviceDialog({ env, siteId, device, clients, onClose, onChanged }: { env: NetEnvironment; siteId: string; device: NetEnvDevice; clients: number; onClose: () => void; onChanged: () => void }) {
  const stats = useCore('netenv.deviceStats', { id: env.id, deviceId: device.id, siteId });
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const s = stats.data;
  const pct = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n)}%`);
  const rate = (n: number | null | undefined) => (n == null ? '—' : `${(n / 1e6).toFixed(1)} Mbps`);
  const up = s?.uptimeSec == null ? '—' : `${Math.floor(s.uptimeSec / 86400)} days ${Math.floor((s.uptimeSec % 86400) / 3600)} hours`;
  const restart = async () => {
    const ok = await confirm({ title: `Restart ${device.name}?`, body: `${clients} client${clients === 1 ? '' : 's'} connected through it will drop for a minute or two while it starts again.`, confirmLabel: 'Restart', danger: true });
    if (!ok) return;
    const r = await run('restart', () => call('netenv.deviceAction', { id: env.id, deviceId: device.id, action: 'restart', siteId }), `${device.name} is restarting`);
    if (r) {
      onChanged();
      onClose();
    }
  };
  return (
    <Modal title={device.name} description={`${device.model}${device.roles.length ? ` · ${device.roles.join(', ')}` : ''}`} onClose={onClose}>
      {stats.error && <Callout tone="warning">{stats.error}</Callout>}
      <KeyValue
        items={[
          ['State', <Status tone={STATE_TONE[device.state]}>{device.state}</Status>],
          ['Address', <span className="mono">{device.ip ?? '—'}</span>],
          ['MAC', <span className="mono">{device.mac}</span>],
          ['Firmware', `${s?.device?.firmware ?? device.firmware ?? '—'}${device.firmwareUpdatable ? ' (update available)' : ''}`],
          ['Up for', up],
          ['CPU / memory', `${pct(s?.cpuPct)} / ${pct(s?.memPct)}`],
          ['Uplink', `↑ ${rate(s?.txBps)}  ↓ ${rate(s?.rxBps)}`],
          ['Clients', clients],
        ]}
      />
      <div className="fx-actions" style={{ marginTop: 14 }}>
        <Button variant="danger" icon="refresh" loading={busy === 'restart'} onClick={() => void restart()}>
          Restart
        </Button>
        <AskButton label="Ask about this device" prompt={`Is this UniFi device healthy? Explain anything unusual and what I should do.`} context={{ device, stats: s, clients }} />
      </div>
      {dialog}
    </Modal>
  );
}

function GuestCodes({ env, siteId, onClose }: { env: NetEnvironment; siteId: string; onClose: () => void }) {
  const existing = useCore('netenv.vouchers', { id: env.id, siteId });
  const [made, setMade] = useState<NetEnvVoucher[]>([]);
  const [count, setCount] = useState('1');
  const [hours, setHours] = useState('8');
  const [note, setNote] = useState('Visitor');
  const { run, busy } = useAction();
  const make = async () => {
    const r = await run('make', () => call('netenv.createVouchers', { id: env.id, siteId, name: note, count: Number(count), timeLimitMinutes: Math.round(Number(hours) * 60) }));
    if (r) {
      setMade(r);
      existing.reload();
    }
  };
  const active = (existing.data ?? []).filter((v) => !v.expired).slice(0, 12);
  return (
    <Modal title="Guest Wi-Fi codes" description="One-time codes for the guest hotspot. The guest network must use vouchers (UniFi → Hotspot)." onClose={onClose}>
      <div className="fx-form">
        <Grid cols={3}>
          <Field label="How many">
            <Select value={count} onChange={(e) => setCount(e.target.value)} options={['1', '2', '5', '10', '20', '30'].map((v) => ({ value: v, label: v }))} />
          </Field>
          <Field label="Each lasts">
            <Select value={hours} onChange={(e) => setHours(e.target.value)} options={[{ value: '1', label: '1 hour' }, { value: '4', label: '4 hours' }, { value: '8', label: 'A school day' }, { value: '24', label: '1 day' }, { value: '168', label: '1 week' }]} />
          </Field>
          <Field label="Label">
            <Input value={note} maxLength={60} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </Grid>
        <div>
          <Button variant="primary" icon="ticket" loading={busy === 'make'} onClick={() => void make()}>
            Make codes
          </Button>
        </div>
        {made.length > 0 && (
          <Callout tone="good" title="New codes">
            <div className="voucher-grid">
              {made.map((v) => (
                <span key={v.id} className="mono voucher">{v.code}</span>
              ))}
            </div>
          </Callout>
        )}
        {existing.error && <Callout tone="warning">{existing.error}</Callout>}
        {active.length > 0 && (
          <Field label="Codes still unused or in use">
            <div className="voucher-grid">
              {active.map((v) => (
                <span key={v.id} className="mono voucher" title={v.name}>{v.code}</span>
              ))}
            </div>
          </Field>
        )}
      </div>
    </Modal>
  );
}

function EnvironmentEditor({ env, onClose, onSaved }: { env: NetEnvironment | null; onClose: () => void; onSaved: (e: NetEnvironment) => void }) {
  const [name, setName] = useState(env?.name ?? 'School network');
  const [url, setUrl] = useState(env?.url ?? '');
  const [key, setKey] = useState('');
  const [probe, setProbe] = useState<NetEnvProbe | null>(null);
  const [trusted, setTrusted] = useState<string | null>(env?.fingerprint ?? null);
  const [site, setSite] = useState<string | null>(env?.defaultSiteId ?? null);
  const { run, busy } = useAction();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const test = async (fingerprint: string | null = trusted) => {
    const r = await run('test', () => call('netenv.probe', { url, apiKey: key || undefined, id: env?.id, fingerprint }));
    if (!r) return;
    setProbe(r);
    if (r.ok) {
      setSite((s) => s ?? r.sites[0]?.id ?? null);
      // Connected with this fingerprint pinned (or the first test showed one): save it with the environment.
      setTrusted(fingerprint ?? r.certificate?.fingerprint ?? null);
    }
  };
  const save = async () => {
    const r = await run('save', () => call('netenv.save', { id: env?.id, kind: 'unifi', name, url, apiKey: key || undefined, fingerprint: trusted, defaultSiteId: site }), `${name} attached`);
    if (r) {
      onSaved(r);
      onClose();
    }
  };
  const remove = async () => {
    if (!env) return;
    if (!(await confirm({ title: `Detach ${env.name}?`, body: 'Its saved API key is deleted from the vault. Nothing changes on the console.', confirmLabel: 'Detach', danger: true }))) return;
    await call('netenv.remove', { id: env.id });
    toast.success(`${env.name} detached`);
    onClose();
  };
  const cert = probe?.certificate;
  return (
    <Modal
      wide
      title={env ? `Edit ${env.name}` : 'Attach a UniFi console'}
      description="Works with a Dream Machine, Cloud Gateway, Cloud Key or UniFi OS Server running UniFi Network 9 or newer."
      onClose={onClose}
      footer={
        <>
          {env && (
            <Button variant="danger" onClick={() => void remove()}>
              Detach
            </Button>
          )}
          <span className="fx-spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!probe?.ok && !env} loading={busy === 'save'} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <ol className="fx-muted" style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
          <li>In UniFi Network, open <b>Settings → Control Plane → Integrations</b> and create an API key. Copy it; UniFi shows it once.</li>
          <li>Enter the console's local address and paste the key. FBRX keeps the key in this computer's vault.</li>
          <li>Test the connection. UniFi consoles use their own certificate, so check its fingerprint against the console's and trust it once.</li>
        </ol>
        <Grid cols={2}>
          <Field label="Name">
            <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Console address" help="For example https://192.168.1.1">
            <Input
              value={url}
              placeholder="https://192.168.1.1"
              onChange={(e) => {
                setUrl(e.target.value);
                setProbe(null);
                setTrusted(null);
              }}
            />
          </Field>
        </Grid>
        <Field label="API key" help={env?.hasKey ? 'Leave empty to keep the saved key' : undefined}>
          <Input type="password" value={key} autoComplete="off" placeholder={env?.hasKey ? '•••••••• (saved)' : 'Paste the key'} onChange={(e) => setKey(e.target.value)} />
        </Field>
        <div className="fx-actions">
          <Button icon="plug" loading={busy === 'test'} disabled={!url || (!key && !env?.hasKey)} onClick={() => void test()}>
            Test connection
          </Button>
          {probe?.ok && <Status tone="good">Connected{probe.version ? ` · UniFi Network ${probe.version}` : ''}</Status>}
        </div>
        {probe && !probe.ok && cert && (
          <Callout
            tone="warning"
            title="Check this certificate"
            actions={
              <Button size="sm" variant="primary" onClick={() => void test(cert.fingerprint)}>
                Trust it and connect
              </Button>
            }
          >
            <p style={{ margin: '0 0 6px' }}>The console uses a certificate no authority vouches for (normal for UniFi). Make sure the fingerprint matches the one in your browser's certificate details for {url}, then trust it. FBRX will refuse the connection if it ever changes.</p>
            <KeyValue items={[['Issued to', cert.subject], ['Issued by', cert.issuer], ['Valid until', cert.validTo], ['SHA-256', <span className="mono" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>{cert.fingerprint}</span>]]} />
          </Callout>
        )}
        {probe && !probe.ok && !cert && probe.message && <Callout tone="critical">{probe.message}</Callout>}
        {probe?.ok && probe.sites.length > 1 && (
          <Field label="Site">
            <Select value={site ?? ''} onChange={(e) => setSite(e.target.value)} options={probe.sites.map((s) => ({ value: s.id, label: s.name }))} />
          </Field>
        )}
      </div>
      {dialog}
    </Modal>
  );
}
