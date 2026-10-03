import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { LanDevice, LanScan, LanScanCompare, NetAdapter, PingResult, SpeedTestResult, TraceHop } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Field, Grid, Icons, Input, KeyValue, LineChart, Meter, Modal, Page, Select, Spinner, StatTile, Status, Tabs, formatDate, useAction, useConfirm, useToast, type Column, Table, advancedLabel } from '@fbrx/ui';
import { bridge, call, onEvent, pickFile } from '../client';
import { newReqId, useAgentName, useCore } from '../hooks';
import { IS_WINDOWS, navigate, routeArg } from '../app';
import { AskButton, askAgent } from '../widgets';
import { ConnectDialog, type ConnectTarget } from '../consoles';
import { Speedometer, speedFraction } from '../speedometer';
import { unlockTrophy } from '../fun';
import { commandSearchUrl, matchDeviceProfile } from '@fbrx/shared';

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
        <Callout tone={web?.received ? 'good' : 'warning'} actions={<Button size="sm" icon="sparkles" onClick={() => navigate(`agent/ask/${encodeURIComponent('Diagnose my network connection step by step and explain any problem in plain language.')}`)}>Diagnose with {agent}</Button>}>
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
        <Card
          title="Route"
          subtitle="Every router between this PC and the destination"
          actions={!tracing && hops.length > 0 && <AskButton label="Explain this route" prompt="Explain this traceroute from my PC in plain language: where the connection goes, where any slowdown or loss starts, and whether it is my network, my provider or further away." context={[...hops].sort((a, b) => a.hop - b.hop)} />}
        >
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

const ipNum = (ip: string) => ip.split('.').reduce((n, p) => (n << 8) + Number(p), 0) >>> 0;
const ipStr = (n: number) => [24, 16, 8, 0].map((b) => (n >>> b) & 255).join('.');
const isV4 = (ip: string) => /^\d+\.\d+\.\d+\.\d+$/.test(ip);

/** The network an adapter is on, limited to /22–/30 (at most 1022 addresses) so a scan takes about a minute. */
export function scanSubnet(ip: string, netmask: string): string {
  const bits = isV4(netmask) ? (ipNum(netmask).toString(2).match(/1/g) ?? []).length : 24;
  const prefix = Math.max(22, Math.min(30, bits || 24));
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return `${ipStr((ipNum(ip) & mask) >>> 0)}/${prefix}`;
}

function Devices({ advanced }: { advanced: boolean }) {
  const scans = useCore('net.scans');
  const ctx = useCore('net.context');
  const [scan, setScan] = useState<LanScan | null>(null);
  const [progress, setProgress] = useState<{ phase: string; pct: number } | null>(null);
  const [adapter, setAdapter] = useState('');
  const [subnet, setSubnet] = useState('');
  const adapters = (ctx.data?.interfaces ?? []).filter((i) => isV4(i.ip) && i.up);
  const chosen = adapters.find((i) => i.name === adapter) ?? adapters.find((i) => i.ip === ctx.data?.ip) ?? adapters[0];
  const autoSubnet = chosen ? scanSubnet(chosen.ip, chosen.netmask) : '';
  useEffect(() => {
    if (chosen && !adapter) setAdapter(chosen.name);
    setSubnet(autoSubnet);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSubnet]);
  const hosts = (() => {
    const m = /\/(\d+)$/.exec(subnet);
    return m ? 2 ** (32 - Number(m[1])) - 2 : null;
  })();
  const [label, setLabel] = useState('');
  const [cmp, setCmp] = useState<{ a: string; b: string; result: LanScanCompare | null } | null>(null);
  const [detail, setDetail] = useState<LanDevice | null>(null);
  const [connect, setConnect] = useState<ConnectTarget | null>(null);
  const vendors = useCore('net.vendorInfo');
  const { run, busy } = useAction();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  useEffect(() => {
    if (!scan && scans.data?.[0]) void call('net.scanGet', { id: scans.data[0].id }).then(setScan);
  }, [scans.data, scan]);
  const hasCli = (d: LanDevice) => d.ports.some((p) => p === 22 || p === 23 || p === 4118);
  const target = (d: LanDevice, protocol?: 'ssh' | 'telnet'): ConnectTarget => ({ host: d.ip, name: d.name, vendor: d.vendor, model: d.model, ports: d.ports, protocol });
  const start = async () => {
    const reqId = newReqId();
    setProgress({ phase: 'Starting', pct: 0 });
    const off = onEvent('net.event', (e) => {
      if (e.reqId === reqId && e.type === 'progress') setProgress({ phase: e.phase ?? '', pct: e.total ? Math.round(((e.done ?? 0) / e.total) * 100) : 0 });
    });
    const r = await run('scan', () => call('net.scan', { reqId, subnet: subnet || undefined, label: label || chosen?.name || undefined }));
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
    {
      key: 'x',
      header: '',
      render: (d) => (
        <span style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
          {hasCli(d) && !d.isSelf && (
            <Button size="sm" icon="terminal" disabled={!advanced} title={advanced ? `Open a console (${matchDeviceProfile(d)?.name ?? 'command line'})` : 'Turn on Advanced mode to open device consoles'} onClick={() => setConnect(target(d))}>
              Connect
            </Button>
          )}
          <AskButton iconOnly label="What is this device" prompt="What is this device on my home or office network, and is anything about it (open ports, unknown maker) a concern?" context={d} />
        </span>
      ),
      width: 130,
    },
  ];
  return (
    <>
      <Card title="Find devices on my network" subtitle="Ping sweep, ARP, mDNS / Bonjour, UPnP and port fingerprinting. Takes about a minute.">
        <div className="fx-actions">
          <div style={{ width: 280 }}>
            <Select
              aria-label="Network adapter to scan from"
              value={chosen?.name ?? ''}
              onChange={(e) => setAdapter(e.target.value)}
              options={adapters.length ? adapters.map((i) => ({ value: i.name, label: `${i.name} — ${i.ip}${i.ip === ctx.data?.ip ? ' (main)' : ''}` })) : [{ value: '', label: ctx.data ? 'No connected network adapter' : 'Reading adapters…' }]}
            />
          </div>
          <div style={{ width: 190 }}>
            {advanced ? (
              <Input value={subnet} placeholder="192.168.1.0/24" onChange={(e) => setSubnet(e.target.value)} aria-label="Subnet to scan" title="Advanced: any /22 to /30 network" />
            ) : (
              <div className="fx-input" style={{ display: 'flex', alignItems: 'center' }} title="Turn on Advanced mode to scan a different subnet">
                <span className="mono">{subnet || '—'}</span>
              </div>
            )}
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
        <div className="fx-muted" style={{ fontSize: 12.5, marginTop: 8 }}>
          {vendors.data?.entries ? `Makers come from the IEEE registry (${vendors.data.entries.toLocaleString()} MAC blocks, ${vendors.data.source}${vendors.data.updatedAt ? ` ${vendors.data.updatedAt}` : ''}). ` : ''}
          {subnet ? `Scans ${subnet}${hosts ? ` (${hosts} addresses)` : ''}${advanced && subnet !== autoSubnet ? ` · adapter network is ${autoSubnet}` : ''}.` : 'Connect to a network to scan it.'}
          {!advanced && ' Advanced mode lets you scan a different subnet.'}
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
              <AskButton label="Analyze my network" prompt="Here are the devices FBRX OS found on my network. Identify what they probably are, flag anything unknown or risky (open ports, unusual makers), and suggest what to check." context={{ subnet: scan.subnet, devices: scan.devices.map((d) => ({ ip: d.ip, type: d.typeLabel, name: d.name, maker: d.vendor, ports: d.ports, services: d.services, gateway: d.isGateway, thisPC: d.isSelf })) }} />
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
      {detail &&
        (() => {
          const profile = matchDeviceProfile(detail);
          const web = (profile?.webPorts ?? [443, 80, 8443, 8080]).find((p) => detail.ports.includes(p)) ?? (detail.ports.includes(443) ? 443 : detail.ports.includes(80) ? 80 : null);
          return (
            <Modal title={detail.name ?? detail.ip} description={detail.typeLabel} onClose={() => setDetail(null)}>
              <KeyValue
                items={[
                  ['Address', <span className="mono">{detail.ip}</span>],
                  ['MAC', <span className="mono">{detail.mac ?? '—'}</span>],
                  ['Maker', detail.vendor ?? 'Unknown'],
                  ...(detail.model ? [['Model', detail.model] as [string, string]] : []),
                  ['Open ports', detail.ports.join(', ') || 'None found'],
                  ['Services', detail.services.join(', ') || '—'],
                  ['Router', detail.isGateway ? 'Yes' : 'No'],
                  ...(profile ? [['Device guide', `${profile.name} (${profile.kind})`] as [string, string]] : []),
                ]}
              />
              <div className="fx-actions" style={{ marginTop: 12 }}>
                {hasCli(detail) && !detail.isSelf && (
                  <>
                    {detail.ports.some((p) => p === 22 || p === 4118) && (
                      <Button variant="primary" icon="terminal" disabled={!advanced} title={advanced ? undefined : 'Turn on Advanced mode to open device consoles'} onClick={() => setConnect(target(detail, 'ssh'))}>
                        Connect (SSH)
                      </Button>
                    )}
                    {detail.ports.includes(23) && (
                      <Button icon="terminal" disabled={!advanced} onClick={() => setConnect(target(detail, 'telnet'))}>
                        Connect (Telnet)
                      </Button>
                    )}
                  </>
                )}
                {web && (
                  <Button icon="external" onClick={() => bridge.openExternal?.(`${[80, 8080, 5000].includes(web) ? 'http' : 'https'}://${detail.ip}${web === 80 || web === 443 ? '' : `:${web}`}`)}>
                    {profile ? 'Web admin' : 'Open web page'}
                  </Button>
                )}
                {profile?.docs[0] && (
                  <Button icon="book" onClick={() => bridge.openExternal?.(profile.docs[0].url)}>
                    {profile.docs[0].label}
                  </Button>
                )}
                {!profile && detail.vendor && !/private/i.test(detail.vendor) && (
                  <Button icon="book" variant="ghost" onClick={() => bridge.openExternal?.(commandSearchUrl(detail.vendor!, detail.model))}>
                    Find its manual
                  </Button>
                )}
                {IS_WINDOWS && detail.ports.includes(22) && advanced && (
                  <Button variant="ghost" icon="terminal" onClick={() => void call('net.ssh', { host: detail.ip })}>
                    Windows Terminal
                  </Button>
                )}
                <Button
                  className="ask-btn"
                  icon="sparkles"
                  onClick={() =>
                    askAgent(
                      `Tell me about this device on my network and how to manage it safely: what it probably is, how to log in to it (web admin or command line), how to update its firmware, and what to harden (default passwords, Telnet, open ports).${profile ? ` It looks like ${profile.name}.` : ''}`,
                      detail,
                    )
                  }
                >
                  Ask about it
                </Button>
              </div>
              {hasCli(detail) && !advanced && <div className="fx-muted" style={{ fontSize: 12.5, marginTop: 8 }}>Turn on Advanced mode to open its command line here.</div>}
            </Modal>
          );
        })()}
      {connect && (
        <ConnectDialog
          target={connect}
          onClose={() => setConnect(null)}
          onConnected={(s) => {
            setConnect(null);
            setDetail(null);
            navigate(`terminal/console/${s.id}`);
          }}
        />
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

/** The 88 mph sequence: needle position (0…1), readout, unit, remark, lightning; then back to zero. */
const JIGOWATTS: Array<[number, { f?: number; value?: string; unit?: string; label?: string; flux?: boolean }]> = [
  [0, { f: 0.3, value: '30', unit: 'mph', label: 'Roads? Where we\'re going…' }],
  [380, { f: 0.62, value: '62' }],
  [760, { f: 0.41, value: '41' }],
  [1140, { f: 0.8, value: '80' }],
  [1500, { f: 0.57, value: '57' }],
  [1880, { f: 0.88, value: '88', label: 'Hold on tight!' }],
  [2220, { f: 0.79, value: '84' }],
  [2520, { f: 0.9, value: '88' }],
  [2820, { f: 0.85, value: '87' }],
  [3120, { f: 0.88, value: '1.21', unit: 'gigawatts', label: '88 mph', flux: true }],
  [3260, { flux: false }],
  [3400, { flux: true }],
  [3560, { flux: false }],
  [3700, { flux: true }],
  [5600, { f: 0, value: '0.0', unit: 'Mbps', label: '', flux: false }],
];

function Speed({ easterEggs }: { easterEggs: boolean }) {
  const hist = useCore('net.speedHistory');
  const [live, setLive] = useState<{ phase: string; mbps: number } | null>(null);
  const [last, setLast] = useState<SpeedTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [egg, setEgg] = useState<{ f: number; value: string; unit: string; label: string; flux: boolean } | null>(null);
  const clicks = useRef<number[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const toast = useToast();
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const start = async () => {
    const reqId = newReqId();
    setTesting(true);
    const off = onEvent('net.event', (e) => {
      if (e.reqId === reqId && e.type === 'speed') setLive({ phase: e.phase ?? '', mbps: e.mbps ?? 0 });
    });
    try {
      const r = await call('net.speedTest', { reqId });
      setLast(r);
      hist.reload();
    } catch (e) {
      toast.error('Speed test failed', (e as Error).message);
    } finally {
      off();
      setLive(null);
      setTesting(false);
    }
  };
  const timeTravel = () => {
    unlockTrophy('jigowatts');
    let state = { f: 0, value: '0.0', unit: 'mph', label: '', flux: false };
    for (const [t, patch] of JIGOWATTS) {
      timers.current.push(
        setTimeout(() => {
          state = { ...state, ...patch };
          setEgg(state);
        }, t),
      );
    }
    // Back to normal, as if nothing happened.
    timers.current.push(setTimeout(() => setEgg(null), 6700));
  };
  const onRun = () => {
    const now = Date.now();
    clicks.current = [...clicks.current.filter((t) => now - t < 4000), now];
    if (easterEggs && !egg && clicks.current.length >= 8) {
      clicks.current = [];
      timeTravel();
      return;
    }
    if (!testing && !egg) void start();
  };
  const h = [...(hist.data ?? [])].reverse();
  const shown = last ?? hist.data?.[0];
  const phaseName = (p: string) => (p ? p[0].toUpperCase() + p.slice(1) : 'Measuring');
  const dial = egg
    ? { fraction: egg.f, value: egg.value, unit: egg.unit, label: egg.label, flux: egg.flux }
    : live
      ? { fraction: speedFraction(live.mbps), value: live.mbps.toFixed(1), unit: 'Mbps', label: phaseName(live.phase) }
      : testing
        ? { fraction: 0, value: '…', unit: 'Mbps', label: 'Connecting' }
        : shown
          ? { fraction: speedFraction(shown.downloadMbps), value: String(shown.downloadMbps), unit: 'Mbps', label: 'Download' }
          : { fraction: 0, value: '0.0', unit: 'Mbps', label: 'Press Run test' };
  return (
    <>
      <Card
        title="Internet speed"
        subtitle="Measured against Cloudflare's nearest server. Uses about 100 MB of data."
        actions={shown && !live && !egg ? <AskButton label="Is this good?" prompt="Here are my internet speed test results (newest first). Is this good for what most people do (video calls, streaming, gaming, large downloads)? If something looks wrong, how do I fix it?" context={(hist.data ?? []).slice(0, 8)} /> : undefined}
      >
        <div className="speed-panel">
          <div className="speed-dial">
            <Speedometer {...dial} />
            {/* Stays clickable while a test runs, so an impatient person can click it again. And again. */}
            <button type="button" className={`fx-btn primary speed-go${testing ? ' running' : ''}`} aria-busy={testing} onClick={onRun}>
              {testing ? <span className="fx-spinner" /> : <Icons.play size={16} />}
              {testing ? 'Testing…' : 'Run test'}
            </button>
          </div>
          <div className="speed-stats">
            <StatTile label="Download" value={shown ? `${shown.downloadMbps} Mbps` : '—'} />
            <StatTile label="Upload" value={shown ? `${shown.uploadMbps} Mbps` : '—'} />
            <StatTile label="Latency" value={shown?.latencyMs != null ? `${shown.latencyMs} ms` : '—'} foot={shown ? `jitter ${shown.jitterMs ?? '—'} ms` : undefined} />
            <StatTile label="Server" value={shown?.server ?? '—'} foot={shown ? formatDate(shown.at) : 'No tests yet'} />
          </div>
        </div>
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

function Tools({ advanced }: { advanced: boolean }) {
  const [console_, setConsole] = useState<ConnectTarget | null>(null);
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
      <Card title="Device console" subtitle="SSH or Telnet to a switch, firewall, access point or server, with the maker's guide alongside">
        <div className="fx-actions">
          <Input placeholder="user" value={ssh.user} onChange={(e) => setSsh({ ...ssh, user: e.target.value })} aria-label="User" style={{ width: 110 }} />
          <Input placeholder="host or IP address" value={ssh.host} onChange={(e) => setSsh({ ...ssh, host: e.target.value })} aria-label="SSH host" style={{ flex: 1 }} />
          <Input type="number" value={ssh.port} onChange={(e) => setSsh({ ...ssh, port: e.target.value })} aria-label="SSH port" style={{ width: 80 }} />
          <Button variant="primary" icon="terminal" disabled={!ssh.host || !advanced} title={advanced ? undefined : 'Turn on Advanced mode to open device consoles'} onClick={() => setConsole({ host: ssh.host })}>
            Connect
          </Button>
          {IS_WINDOWS && (
            <Button variant="ghost" disabled={!ssh.host} onClick={() => void run('ssh', () => call('net.ssh', { host: ssh.host, user: ssh.user || undefined, port: Number(ssh.port) || 22 }))}>
              Windows Terminal
            </Button>
          )}
        </div>
      </Card>
      {console_ && (
        <ConnectDialog
          target={console_}
          onClose={() => setConsole(null)}
          onConnected={(s) => {
            setConsole(null);
            navigate(`terminal/console/${s.id}`);
          }}
        />
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

const NET_TABS: Tab[] = ['overview', 'trace', 'devices', 'speed', 'wifi', 'bluetooth', 'printers', 'tools', 'adapters'];

export function NetworkPage({ advanced, easterEggs }: { advanced: boolean; easterEggs: boolean }) {
  // network/speed, network/printers… open that tab directly.
  const [tab, setTab] = useState<Tab>(() => (NET_TABS.includes(routeArg() as Tab) ? (routeArg() as Tab) : 'overview'));
  const tabs: Array<{ id: Tab; label: ReactNode }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'trace', label: 'Ping & trace' },
    { id: 'devices', label: 'Devices' },
    { id: 'speed', label: 'Speed' },
    { id: 'wifi', label: 'Wi-Fi' },
    { id: 'bluetooth', label: 'Bluetooth' },
    { id: 'printers', label: 'Printers' },
    { id: 'tools', label: 'Tools' },
    ...(advanced && IS_WINDOWS ? [{ id: 'adapters' as const, label: advancedLabel('Adapters') }] : []),
  ];
  return (
    <Page title="Network Center" description="See how this PC connects, what else is on your network, and what is slowing things down.">
      <Tabs tabs={tabs} active={tab} onChange={setTab} />
      {tab === 'overview' && <Overview />}
      {tab === 'trace' && <Trace />}
      {tab === 'devices' && <Devices advanced={advanced} />}
      {tab === 'speed' && <Speed easterEggs={easterEggs} />}
      {tab === 'wifi' && <Wifi />}
      {tab === 'bluetooth' && <Bluetooth />}
      {tab === 'printers' && <Printers />}
      {tab === 'tools' && <Tools advanced={advanced} />}
      {tab === 'adapters' && <Adapters />}
    </Page>
  );
}
