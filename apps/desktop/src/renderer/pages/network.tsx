import { useEffect, useState } from 'react';
import type { LanDevice, LanScan, LanScanCompare, NetAdapter, PingResult, SpeedTestResult, TraceHop } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Field, Grid, Input, KeyValue, LineChart, Meter, Modal, Page, Select, Spinner, StatTile, Status, Tabs, formatDate, useAction, useConfirm, useToast, type Column, Table } from '@fbrx/ui';
import { call, onEvent, pickFile } from '../client';
import { newReqId, useAgentName, useCore } from '../hooks';
import { IS_WINDOWS, navigate } from '../app';

type Tab = 'overview' | 'trace' | 'devices' | 'speed' | 'wifi' | 'bluetooth' | 'printers' | 'tools' | 'adapters';

const ROLE: Record<TraceHop['role'], { label: string; tone: 'good' | 'info' | 'neutral' | 'warning' | 'busy' }> = {
  'this-pc': { label: 'This PC', tone: 'info' },
  gateway: { label: 'Your router', tone: 'good' },
  router: { label: 'Local router', tone: 'warning' },
  isp: { label: 'Internet provider', tone: 'info' },
  internet: { label: 'Internet', tone: 'neutral' },
  target: { label: 'Destination', tone: 'good' },
  timeout: { label: 'No reply', tone: 'neutral' },
};

function pingTone(ms: number | null) {
  return ms == null ? 'neutral' : ms < 40 ? 'good' : ms < 120 ? 'warning' : 'critical';
}

function Overview() {
  const ctx = useCore('net.context');
  const pub = useCore('net.publicIp');
  const [gw, setGw] = useState<PingResult | null>(null);
  const [web, setWeb] = useState<PingResult | null>(null);
  const agent = useAgentName();
  useEffect(() => {
    if (ctx.data?.gateway) void call('net.ping', { host: ctx.data.gateway, count: 4 }).then(setGw).catch(() => undefined);
    void call('net.ping', { host: '1.1.1.1', count: 4 }).then(setWeb).catch(() => undefined);
  }, [ctx.data?.gateway]);
  const verdict = !web ? null : web.received ? (gw && !gw.received ? 'Router is not answering pings, but the internet works.' : 'You are online.') : gw?.received ? 'Your router answers but the internet does not: the problem is likely your provider or modem.' : 'No connection to your router: check Wi-Fi or the cable.';
  return (
    <>
      <Grid cols={4}>
        <StatTile label="This PC" value={ctx.data?.ip ?? '—'} foot={ctx.data?.hostname} />
        <StatTile label="Router" value={ctx.data?.gateway ?? '—'} foot={gw ? <Status tone={pingTone(gw.avg)}>{gw.avg != null ? `${gw.avg} ms` : 'no reply'}</Status> : ctx.data && !ctx.data.gateway ? 'No router found' : 'Testing…'} />
        <StatTile label="Internet" value={web ? (web.received ? `${web.avg} ms` : 'Offline') : '…'} foot={web ? `${web.lossPct}% loss · jitter ${web.jitter ?? 0} ms` : 'Testing 1.1.1.1'} />
        <StatTile label="Public address" value={pub.data?.ip ?? '—'} foot={pub.data?.isp ?? pub.error ?? ''} />
      </Grid>
      {verdict && (
        <Callout tone={web?.received ? 'good' : 'warning'} actions={<Button size="sm" icon="sparkles" onClick={() => navigate(`agent/ask/${encodeURIComponent('Diagnose my network connection step by step and explain any problem in plain language.')}`)}>Ask {agent}</Button>}>
          {verdict}
        </Callout>
      )}
      <Card title="Network interfaces" flush>
        <Table
          columns={[
            { key: 'name', header: 'Name', render: (i) => i.name },
            { key: 'ip', header: 'Address', render: (i) => <span className="mono">{i.ip}</span> },
            { key: 'type', header: 'Type', render: (i) => i.type },
            { key: 'speed', header: 'Speed', render: (i) => (i.speedMbps ? `${i.speedMbps} Mbps` : '—') },
            { key: 'mac', header: 'MAC', render: (i) => <span className="mono fx-muted">{i.mac}</span> },
            { key: 'up', header: '', render: (i) => <Status tone={i.up ? 'good' : 'neutral'}>{i.up ? 'up' : 'down'}</Status> },
          ]}
          rows={ctx.data?.interfaces ?? []}
          rowKey={(i) => `${i.name}${i.ip}`}
        />
        <div style={{ padding: '10px 18px' }} className="fx-muted">
          DNS servers: <span className="mono">{ctx.data?.dns.join(', ') || '—'}</span>
        </div>
      </Card>
    </>
  );
}

function Trace() {
  const [host, setHost] = useState('google.com');
  const [ping, setPing] = useState<PingResult | null>(null);
  const [hops, setHops] = useState<TraceHop[]>([]);
  const [tracing, setTracing] = useState(false);
  const { run, busy } = useAction();
  const trace = async () => {
    const reqId = newReqId();
    setHops([]);
    setTracing(true);
    const off = onEvent('net.event', (e) => {
      if (e.reqId === reqId && e.type === 'hop' && e.hop) setHops((h) => [...h.filter((x) => x.hop !== e.hop!.hop), e.hop!]);
    });
    const r = await run('trace', () => call('net.traceroute', { host, reqId }));
    off();
    setTracing(false);
    if (r) setHops(r.hops);
  };
  return (
    <>
      <Card>
        <div className="fx-actions">
          <div style={{ flex: 1, minWidth: 220 }}>
            <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="Host name or address" aria-label="Host" onKeyDown={(e) => e.key === 'Enter' && void trace()} />
          </div>
          <Button loading={busy === 'ping'} onClick={() => void run('ping', () => call('net.ping', { host, count: 10 })).then((r) => r && setPing(r))}>
            Ping
          </Button>
          <Button variant="primary" loading={tracing} onClick={() => void trace()}>
            Trace route
          </Button>
        </div>
      </Card>
      {ping && (
        <Grid cols={4}>
          <StatTile label={`Ping ${ping.host}`} value={ping.avg != null ? `${ping.avg} ms` : 'No reply'} foot={ping.ip ?? ''} />
          <StatTile label="Packet loss" value={`${ping.lossPct}%`} foot={`${ping.received}/${ping.sent} replies`} />
          <StatTile label="Jitter" value={ping.jitter != null ? `${ping.jitter} ms` : '—'} foot="Variation between replies" />
          <StatTile label="Range" value={ping.min != null ? `${ping.min}–${ping.max} ms` : '—'} trend={ping.samples.map((s) => s ?? 0)} />
        </Grid>
      )}
      {(hops.length > 0 || tracing) && (
        <Card title="Route" subtitle="Every router between this PC and the destination">
          <div className="hops">
            {[...hops].sort((a, b) => a.hop - b.hop).map((h) => (
              <div key={h.hop} className={`hop hop-${h.role}`}>
                <div className="hop-n">{h.hop}</div>
                <div className="hop-line" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong className="mono">{h.ip ?? '* * *'}</strong>
                    <Status tone={ROLE[h.role].tone}>{ROLE[h.role].label}</Status>
                    {h.avg != null && <Status tone={pingTone(h.avg)}>{h.avg} ms</Status>}
                  </div>
                  <div className="fx-muted" style={{ fontSize: 12.5 }}>
                    {[h.name, h.vendor, h.org, h.location].filter(Boolean).join(' · ') || (h.role === 'timeout' ? 'This router does not answer traceroute probes; that is normal if later hops respond.' : '')}
                  </div>
                </div>
              </div>
            ))}
            {tracing && (
              <div className="hop">
                <Spinner />
              </div>
            )}
          </div>
        </Card>
      )}
    </>
  );
}

function Devices() {
  const scans = useCore('net.scans');
  const [scan, setScan] = useState<LanScan | null>(null);
  const [progress, setProgress] = useState<{ phase: string; pct: number } | null>(null);
  const [subnet, setSubnet] = useState('');
  const [label, setLabel] = useState('');
  const [cmp, setCmp] = useState<{ a: string; b: string; result: LanScanCompare | null } | null>(null);
  const [detail, setDetail] = useState<LanDevice | null>(null);
  const { run, busy } = useAction();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  useEffect(() => {
    if (!scan && scans.data?.[0]) void call('net.scanGet', { id: scans.data[0].id }).then(setScan);
  }, [scans.data, scan]);
  const start = async () => {
    const reqId = newReqId();
    setProgress({ phase: 'Starting', pct: 0 });
    const off = onEvent('net.event', (e) => {
      if (e.reqId === reqId && e.type === 'progress') setProgress({ phase: e.phase ?? '', pct: e.total ? Math.round(((e.done ?? 0) / e.total) * 100) : 0 });
    });
    const r = await run('scan', () => call('net.scan', { reqId, subnet: subnet || undefined, label: label || undefined }));
    off();
    setProgress(null);
    if (r) {
      setScan(r);
      scans.reload();
      toast.success(`Found ${r.devices.length} devices`);
    }
  };
  const cols: Column<LanDevice>[] = [
    { key: 'ip', header: 'Address', render: (d) => <span className="mono">{d.ip}</span>, width: 130 },
    { key: 'type', header: 'Device', render: (d) => <span>{d.typeLabel}{d.isSelf ? ' (this PC)' : ''}</span> },
    { key: 'name', header: 'Name', render: (d) => d.name ?? <span className="fx-muted">—</span> },
    { key: 'vendor', header: 'Maker', render: (d) => d.vendor ?? <span className="fx-muted">Unknown</span> },
    { key: 'ports', header: 'Open ports', render: (d) => <span className="mono fx-muted">{d.ports.join(', ') || '—'}</span> },
  ];
  return (
    <>
      <Card title="Find devices on my network" subtitle="Ping sweep, ARP, mDNS / Bonjour, UPnP and port fingerprinting. Takes about a minute.">
        <div className="fx-actions">
          <div style={{ width: 200 }}>
            <Input placeholder="Subnet (auto)" value={subnet} onChange={(e) => setSubnet(e.target.value)} aria-label="Subnet" />
          </div>
          <div style={{ width: 200 }}>
            <Input placeholder="Label (e.g. Home)" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Scan label" />
          </div>
          <Button variant="primary" icon="search" loading={busy === 'scan'} onClick={() => void start()}>
            Scan now
          </Button>
          <span className="fx-spacer" />
          {(scans.data?.length ?? 0) > 1 && (
            <Button icon="layers" onClick={() => setCmp({ a: scans.data![1].id, b: scans.data![0].id, result: null })}>
              Compare scans
            </Button>
          )}
        </div>
        {progress && (
          <div style={{ marginTop: 12 }}>
            <div className="fx-muted" style={{ fontSize: 12.5, marginBottom: 4 }}>
              {progress.phase}
            </div>
            <Meter value={progress.pct} label="Scan progress" />
          </div>
        )}
      </Card>
      {scan ? (
        <Card
          title={`${scan.label} · ${scan.devices.length} devices`}
          subtitle={`${scan.subnet} · ${formatDate(scan.scannedAt)} · ${(scan.durationMs / 1000).toFixed(0)} s`}
          actions={
            <>
              <Select
                aria-label="Saved scans"
                value={scan.id}
                onChange={(e) => void call('net.scanGet', { id: e.target.value }).then(setScan)}
                options={(scans.data ?? []).map((s) => ({ value: s.id, label: `${s.label} · ${formatDate(s.scannedAt)} (${s.count})` }))}
              />
              <Button
                size="sm"
                icon="download"
                onClick={async () => {
                  const path = await pickFile({ kind: 'save', title: 'Export devices', defaultPath: `network-devices-${scan.scannedAt.slice(0, 10)}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] });
                  if (path) await run('csv', () => call('net.exportCsv', { id: scan.id, path }), 'Exported');
                }}
              >
                CSV
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon="trash"
                aria-label="Delete scan"
                onClick={async () => {
                  if (await confirm({ title: 'Delete this scan?', danger: true, confirmLabel: 'Delete' })) {
                    await call('net.scanDelete', { id: scan.id });
                    setScan(null);
                    scans.reload();
                  }
                }}
              />
            </>
          }
          flush
        >
          <Table columns={cols} rows={scan.devices} rowKey={(d) => d.ip} onRowClick={setDetail} />
        </Card>
      ) : (
        !progress && <Empty title="No scans yet">Run a scan to see every device on your network.</Empty>
      )}
      {detail && (
        <Modal title={detail.name ?? detail.ip} description={detail.typeLabel} onClose={() => setDetail(null)}>
          <KeyValue
            items={[
              ['Address', <span className="mono">{detail.ip}</span>],
              ['MAC', <span className="mono">{detail.mac ?? '—'}</span>],
              ['Maker', detail.vendor ?? 'Unknown'],
              ['Open ports', detail.ports.join(', ') || 'None found'],
              ['Services', detail.services.join(', ') || '—'],
              ['Router', detail.isGateway ? 'Yes' : 'No'],
            ]}
          />
          <div className="fx-actions" style={{ marginTop: 12 }}>
            {detail.ports.some((p) => p === 80 || p === 443) && (
              <Button icon="external" onClick={() => void call('spotlight.run', { item: { id: 'dev', kind: 'web', title: detail.ip, score: 0, action: { type: 'url', url: `${detail.ports.includes(443) ? 'https' : 'http'}://${detail.ip}` } } })}>
                Open web page
              </Button>
            )}
            {IS_WINDOWS && detail.ports.includes(22) && (
              <Button icon="terminal" onClick={() => void call('net.ssh', { host: detail.ip })}>
                SSH
              </Button>
            )}
          </div>
        </Modal>
      )}
      {cmp && (
        <Modal
          title="Compare two scans"
          wide
          onClose={() => setCmp(null)}
          footer={
            <Button variant="primary" onClick={() => void call('net.compare', { a: cmp.a, b: cmp.b }).then((result) => setCmp({ ...cmp, result }))}>
              Compare
            </Button>
          }
        >
          <div className="fx-row">
            <Field label="Before">
              <Select value={cmp.a} onChange={(e) => setCmp({ ...cmp, a: e.target.value, result: null })} options={(scans.data ?? []).map((s) => ({ value: s.id, label: `${s.label} · ${formatDate(s.scannedAt)}` }))} />
            </Field>
            <Field label="After">
              <Select value={cmp.b} onChange={(e) => setCmp({ ...cmp, b: e.target.value, result: null })} options={(scans.data ?? []).map((s) => ({ value: s.id, label: `${s.label} · ${formatDate(s.scannedAt)}` }))} />
            </Field>
          </div>
          {cmp.result && (
            <div className="fx-grid" style={{ marginTop: 12 }}>
              <div>
                <Status tone="warning">{cmp.result.added.length} new</Status> {cmp.result.added.map((d) => `${d.ip} ${d.name ?? d.vendor ?? ''}`).join(' · ')}
              </div>
              <div>
                <Status tone="neutral">{cmp.result.removed.length} gone</Status> {cmp.result.removed.map((d) => `${d.ip} ${d.name ?? d.vendor ?? ''}`).join(' · ')}
              </div>
              <div>
                <Status tone="info">{cmp.result.changed.length} changed</Status>
                {cmp.result.changed.map((c) => (
                  <div key={c.device.ip} className="fx-muted" style={{ fontSize: 12.5 }}>
                    {c.device.ip}: {c.diffs.join('; ')}
                  </div>
                ))}
              </div>
              <div className="fx-muted">{cmp.result.unchanged} unchanged</div>
            </div>
          )}
        </Modal>
      )}
      {dialog}
    </>
  );
}

function Speed() {
  const hist = useCore('net.speedHistory');
  const [live, setLive] = useState<{ phase: string; mbps: number } | null>(null);
  const [last, setLast] = useState<SpeedTestResult | null>(null);
  const { run, busy } = useAction();
  const start = async () => {
    const reqId = newReqId();
    const off = onEvent('net.event', (e) => {
      if (e.reqId === reqId && e.type === 'speed') setLive({ phase: e.phase ?? '', mbps: e.mbps ?? 0 });
    });
    const r = await run('speed', () => call('net.speedTest', { reqId }));
    off();
    setLive(null);
    if (r) {
      setLast(r);
      hist.reload();
    }
  };
  const h = [...(hist.data ?? [])].reverse();
  const shown = last ?? hist.data?.[0];
  return (
    <>
      <Card title="Internet speed" subtitle="Measured against Cloudflare's nearest server. Uses about 100 MB of data." actions={<Button variant="primary" icon="play" loading={busy === 'speed'} onClick={() => void start()}>Run test</Button>}>
        {live && (
          <div className="speed-live">
            <div className="speed-num">{live.mbps.toFixed(1)}</div>
            <div className="fx-muted">Mbps · {live.phase}</div>
          </div>
        )}
        {!live && shown && (
          <Grid cols={4}>
            <StatTile label="Download" value={`${shown.downloadMbps} Mbps`} />
            <StatTile label="Upload" value={`${shown.uploadMbps} Mbps`} />
            <StatTile label="Latency" value={shown.latencyMs != null ? `${shown.latencyMs} ms` : '—'} foot={`jitter ${shown.jitterMs ?? '—'} ms`} />
            <StatTile label="Server" value={shown.server ?? '—'} foot={formatDate(shown.at)} />
          </Grid>
        )}
        {!live && !shown && <Empty title="No tests yet" />}
      </Card>
      {h.length > 1 && (
        <Card title="History">
          <LineChart
            height={200}
            yFormat={(n) => `${n}`}
            xFormat={(t) => new Date(t).toLocaleDateString()}
            series={[
              { key: 'down', label: 'Download (Mbps)', slot: 0, points: h.map((x) => ({ t: Date.parse(x.at), v: x.downloadMbps })) },
              { key: 'up', label: 'Upload (Mbps)', slot: 1, points: h.map((x) => ({ t: Date.parse(x.at), v: x.uploadMbps })) },
            ]}
          />
        </Card>
      )}
    </>
  );
}

function Wifi() {
  const wifi = useCore('net.wifi', undefined, [], 15_000);
  const c = wifi.data?.connection;
  const channels = Object.entries(wifi.data?.channels ?? {}).sort((a, b) => Number(a[0]) - Number(b[0]));
  return (
    <>
      {c ? (
        <Grid cols={4}>
          <StatTile label="Connected to" value={c.ssid} foot={c.security} />
          <StatTile label="Signal" value={`${c.signalPct}%`} foot={c.signalPct > 70 ? 'Strong' : c.signalPct > 40 ? 'Fair' : 'Weak: move closer to the router'} />
          <StatTile label="Channel" value={c.channel ? String(c.channel) : '—'} foot={c.band} />
          <StatTile label="Link speed" value={c.rxMbps ? `${c.rxMbps} Mbps` : '—'} foot={c.txMbps ? `send ${c.txMbps} Mbps` : ''} />
        </Grid>
      ) : (
        <Callout tone="info">Not connected to Wi-Fi (or Wi-Fi details are unavailable).</Callout>
      )}
      <Grid cols={2}>
        <Card title="Nearby networks" flush>
          <Table
            columns={[
              { key: 'ssid', header: 'Network', render: (n) => n.ssid },
              { key: 'sig', header: 'Signal', render: (n) => <Meter value={n.signalPct} label={`${n.ssid} signal`} />, width: 120 },
              { key: 'ch', header: 'Channel', render: (n) => `${n.channel ?? '—'} · ${n.band}`, width: 120 },
              { key: 'sec', header: 'Security', render: (n) => <span className="fx-muted">{n.security}</span> },
            ]}
            rows={wifi.data?.networks ?? []}
            rowKey={(n) => `${n.ssid}${n.channel}`}
            empty={<Empty title="No networks found" />}
          />
        </Card>
        <Card title="Channel congestion" subtitle="How many networks share each channel. Fewer is better.">
          {channels.length ? (
            <div className="fx-grid" style={{ gap: 6 }}>
              {channels.map(([ch, n]) => (
                <div key={ch} style={{ display: 'grid', gridTemplateColumns: '60px 1fr 30px', gap: 8, alignItems: 'center', fontSize: 13 }}>
                  <span>Ch {ch}</span>
                  <Meter value={n} max={Math.max(...channels.map(([, x]) => x))} label={`Channel ${ch}`} />
                  <span className="fx-muted">{n}</span>
                </div>
              ))}
            </div>
          ) : (
            <Empty title="No data" />
          )}
        </Card>
      </Grid>
    </>
  );
}

function Bluetooth() {
  const bt = useCore('net.bluetooth');
  return (
    <Card title="Bluetooth devices" subtitle={bt.data?.adapters.join(', ') || 'Bluetooth adapter'} actions={<Button size="sm" icon="external" onClick={() => void call('spotlight.run', { item: { id: 'bt', kind: 'command', title: 'Bluetooth', score: 0, action: { type: 'url', url: 'ms-settings:bluetooth' } } })}>Bluetooth settings</Button>} flush>
      {bt.error ? (
        <Callout tone="warning">{bt.error}</Callout>
      ) : (
        <Table
          columns={[
            { key: 'n', header: 'Device', render: (d) => d.name },
            { key: 'k', header: 'Kind', render: (d) => <span className="fx-muted">{d.kind}</span> },
            { key: 'b', header: 'Battery', render: (d) => (d.battery != null ? `${d.battery}%` : '—') },
            { key: 'c', header: '', render: (d) => <Status tone={d.connected ? 'good' : 'neutral'}>{d.connected ? 'connected' : 'paired'}</Status> },
          ]}
          rows={bt.data?.devices ?? []}
          rowKey={(d) => d.name}
          empty={<Empty title={bt.data ? 'No Bluetooth devices' : 'Reading…'} />}
        />
      )}
    </Card>
  );
}

function Printers() {
  const printers = useCore('net.printers');
  const { run, busy } = useAction();
  const toast = useToast();
  const act = (name: string, action: 'test' | 'queue' | 'props' | 'default' | 'clear' | 'spooler', msg?: string) =>
    run(`${action}${name}`, async () => {
      await call('net.printerAction', { name, action });
      if (msg) toast.success(msg);
      printers.reload();
    });
  if (!IS_WINDOWS) return <Callout tone="info">Printer management is available on Windows.</Callout>;
  return (
    <Card title="Printers" actions={<Button size="sm" loading={busy?.startsWith('spooler')} onClick={() => void act('', 'spooler', 'Print spooler restarted')}>Restart print spooler</Button>} flush>
      <Table
        columns={[
          { key: 'n', header: 'Printer', render: (p) => <span>{p.name}{p.isDefault ? <Status tone="info">default</Status> : null}</span> },
          { key: 's', header: 'Status', render: (p) => <Status tone={/normal|idle|printing|^0$|^3$/i.test(p.status) ? 'good' : 'warning'}>{p.status}</Status> },
          { key: 'j', header: 'Jobs', render: (p) => p.jobs, width: 60 },
          { key: 'i', header: 'Address', render: (p) => <span className="mono fx-muted">{p.ip ?? p.port}</span> },
          {
            key: 'a',
            header: '',
            render: (p) => (
              <div className="fx-actions">
                <Button size="sm" onClick={() => void act(p.name, 'test', 'Test page sent')}>Test page</Button>
                <Button size="sm" variant="ghost" onClick={() => void act(p.name, 'queue')}>Queue</Button>
                {p.jobs > 0 && <Button size="sm" variant="ghost" onClick={() => void act(p.name, 'clear', 'Queue cleared')}>Clear queue</Button>}
                {!p.isDefault && <Button size="sm" variant="ghost" onClick={() => void act(p.name, 'default', 'Default printer set')}>Make default</Button>}
              </div>
            ),
          },
        ]}
        rows={printers.data ?? []}
        rowKey={(p) => p.name}
        empty={<Empty title={printers.data ? 'No printers' : 'Reading…'} />}
      />
    </Card>
  );
}

function Tools() {
  const [name, setName] = useState('example.com');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('443');
  const [ssh, setSsh] = useState({ host: '', user: '', port: '22' });
  const [dns, setDns] = useState<Awaited<ReturnType<typeof call<'net.dns'>>> | null>(null);
  const [portRes, setPortRes] = useState<string | null>(null);
  const { run, busy } = useAction();
  return (
    <Grid cols={2}>
      <Card title="DNS lookup" subtitle="Compare your DNS with public resolvers">
        <div className="fx-actions">
          <div style={{ flex: 1 }}>
            <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
          </div>
          <Button variant="primary" loading={busy === 'dns'} onClick={() => void run('dns', () => call('net.dns', { name })).then((r) => r && setDns(r))}>
            Look up
          </Button>
        </div>
        {dns && (
          <div style={{ marginTop: 10 }}>
            <div className="mono" style={{ fontSize: 13 }}>{dns.addresses.join(', ') || 'No addresses'}</div>
            {dns.resolvers.map((r) => (
              <div key={r.name} style={{ display: 'flex', gap: 8, fontSize: 13, marginTop: 4 }}>
                <span style={{ width: 100 }}>{r.name}</span>
                <span className="mono fx-muted" style={{ flex: 1 }}>{r.ip}</span>
                <Status tone={r.ok ? pingTone(r.ms) : 'critical'}>{r.ok ? `${r.ms} ms` : 'failed'}</Status>
              </div>
            ))}
          </div>
        )}
      </Card>
      <Card title="Port check" subtitle="Is a service reachable?">
        <div className="fx-actions">
          <div style={{ flex: 1 }}>
            <Input placeholder="Host" value={host} onChange={(e) => setHost(e.target.value)} aria-label="Host" />
          </div>
          <div style={{ width: 90 }}>
            <Input type="number" value={port} onChange={(e) => setPort(e.target.value)} aria-label="Port" />
          </div>
          <Button variant="primary" loading={busy === 'port'} disabled={!host} onClick={() => void run('port', () => call('net.port', { host, port: Number(port) })).then((r) => r && setPortRes(r.open ? `Open (${r.ms} ms)` : 'Closed or filtered'))}>
            Check
          </Button>
        </div>
        {portRes && <div style={{ marginTop: 10 }}><Status tone={portRes.startsWith('Open') ? 'good' : 'warning'}>{portRes}</Status></div>}
      </Card>
      {IS_WINDOWS && (
        <Card title="SSH" subtitle="Open a secure shell to a server in Windows Terminal">
          <div className="fx-actions">
            <Input placeholder="user" value={ssh.user} onChange={(e) => setSsh({ ...ssh, user: e.target.value })} aria-label="User" style={{ width: 110 }} />
            <Input placeholder="host" value={ssh.host} onChange={(e) => setSsh({ ...ssh, host: e.target.value })} aria-label="SSH host" style={{ flex: 1 }} />
            <Input type="number" value={ssh.port} onChange={(e) => setSsh({ ...ssh, port: e.target.value })} aria-label="SSH port" style={{ width: 80 }} />
            <Button variant="primary" icon="terminal" disabled={!ssh.host} onClick={() => void run('ssh', () => call('net.ssh', { host: ssh.host, user: ssh.user || undefined, port: Number(ssh.port) || 22 }))}>
              Connect
            </Button>
          </div>
        </Card>
      )}
    </Grid>
  );
}

function Adapters() {
  const adapters = useCore('net.adapters');
  const [edit, setEdit] = useState<{ a: NetAdapter; mode: 'dhcp' | 'static' | 'secondary'; ip: string; prefix: string; gateway: string; dns: string } | null>(null);
  const { run, busy } = useAction();
  const toast = useToast();
  return (
    <>
      <Callout tone="warning">Changing addresses can disconnect this PC. Windows asks for administrator permission before anything changes.</Callout>
      {(adapters.data ?? []).map((a) => (
        <Card key={a.alias} title={a.alias} subtitle={`${a.description} · ${a.speed}`} actions={<><Status tone={a.status === 'Up' ? 'good' : 'neutral'}>{a.status}</Status><Button size="sm" onClick={() => setEdit({ a, mode: a.dhcp ? 'dhcp' : 'static', ip: a.ipv4[0]?.ip ?? '', prefix: String(a.ipv4[0]?.prefix ?? 24), gateway: a.gateway ?? '', dns: a.dns.join(', ') })}>Configure</Button></>}>
          <KeyValue
            items={[
              ['Addresses', a.ipv4.map((x) => `${x.ip}/${x.prefix}`).join(', ') || '—'],
              ['Gateway', a.gateway ?? '—'],
              ['DNS', a.dns.join(', ') || '—'],
              ['Mode', a.dhcp ? 'Automatic (DHCP)' : 'Manual'],
              ['MAC', a.mac],
            ]}
          />
        </Card>
      ))}
      {adapters.error && <Callout tone="warning">{adapters.error}</Callout>}
      {edit && (
        <Modal
          title={`Configure ${edit.a.alias}`}
          onClose={() => setEdit(null)}
          footer={
            <>
              <Button onClick={() => setEdit(null)}>Cancel</Button>
              <Button
                variant="primary"
                loading={busy === 'ip'}
                onClick={async () => {
                  const r = await run('ip', () => call('net.setIp', { alias: edit.a.alias, mode: edit.mode, ip: edit.ip, prefix: edit.prefix, gateway: edit.gateway || undefined, dns: edit.dns.split(/[,\s]+/).filter(Boolean) }));
                  if (r) {
                    (r.ok ? toast.success : toast.warning)(r.ok ? 'Applied' : 'Check the result', r.output.slice(-300));
                    setEdit(null);
                    adapters.reload();
                  }
                }}
              >
                Apply
              </Button>
            </>
          }
        >
          <div className="fx-grid">
            <Field label="Mode">
              <Select value={edit.mode} onChange={(e) => setEdit({ ...edit, mode: e.target.value as 'dhcp' })} options={[{ value: 'dhcp', label: 'Automatic (DHCP)' }, { value: 'static', label: 'Manual address' }, { value: 'secondary', label: 'Add a second address (keeps the current one)' }]} />
            </Field>
            {edit.mode !== 'dhcp' && (
              <>
                <div className="fx-row">
                  <Field label="IP address">
                    <Input value={edit.ip} onChange={(e) => setEdit({ ...edit, ip: e.target.value })} />
                  </Field>
                  <Field label="Prefix or mask">
                    <Input value={edit.prefix} onChange={(e) => setEdit({ ...edit, prefix: e.target.value })} />
                  </Field>
                </div>
                {edit.mode === 'static' && (
                  <div className="fx-row">
                    <Field label="Gateway">
                      <Input value={edit.gateway} onChange={(e) => setEdit({ ...edit, gateway: e.target.value })} />
                    </Field>
                    <Field label="DNS servers">
                      <Input value={edit.dns} onChange={(e) => setEdit({ ...edit, dns: e.target.value })} placeholder="1.1.1.1, 8.8.8.8" />
                    </Field>
                  </div>
                )}
              </>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

export function NetworkPage({ advanced }: { advanced: boolean }) {
  const [tab, setTab] = useState<Tab>('overview');
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'trace', label: 'Ping & trace' },
    { id: 'devices', label: 'Devices' },
    { id: 'speed', label: 'Speed' },
    { id: 'wifi', label: 'Wi-Fi' },
    { id: 'bluetooth', label: 'Bluetooth' },
    { id: 'printers', label: 'Printers' },
    { id: 'tools', label: 'Tools' },
    ...(advanced && IS_WINDOWS ? [{ id: 'adapters' as const, label: 'Adapters' }] : []),
  ];
  return (
    <Page title="Network Center" description="See how this PC connects, what else is on your network, and what is slowing things down.">
      <Tabs tabs={tabs} active={tab} onChange={setTab} />
      {tab === 'overview' && <Overview />}
      {tab === 'trace' && <Trace />}
      {tab === 'devices' && <Devices />}
      {tab === 'speed' && <Speed />}
      {tab === 'wifi' && <Wifi />}
      {tab === 'bluetooth' && <Bluetooth />}
      {tab === 'printers' && <Printers />}
      {tab === 'tools' && <Tools />}
      {tab === 'adapters' && <Adapters />}
    </Page>
  );
}
