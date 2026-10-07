import type { GateLease } from '@fbrx/gate';
import { Button, Callout, Card, Empty, formatBytes, formatNumber, Grid, KeyValue, LineChart, StatTile, Status, Table, timeAgo } from '@fbrx/ui';
import { useGate } from '../gate-state';
import { useApp, useRoute } from '../state';
import { bitRate, GatePage, zoneWords } from './gate-common';

/** The gate at a glance: the internet line, ports, devices, and what is switched on. */
export function GateDashboardPage() {
  const app = useApp();
  const g = useGate();
  const [, go] = useRoute();
  return (
    <GatePage
      title={g.info?.state.running?.hostname ?? g.info?.state.candidate.hostname ?? 'FBRX Gate'}
      description="FBRX Gate: this server routes and protects your network. Its firewall, networks, addresses, VPN and traffic priority are one configuration you edit, review and commit."
      actions={
        <>
          <Button icon="network" onClick={() => go('gate-networks')}>
            Networks
          </Button>
          <Button icon="shield" onClick={() => go('gate-firewall')}>
            Firewall
          </Button>
        </>
      }
    >
      {(info) => {
        const run = info.state.running;
        const live = g.live;
        const wan = run?.wan.interface;
        const wanRate = wan ? g.rates[wan] : undefined;
        const last = info.state.lastCommit;
        const meshBytes = Object.entries(live?.counters ?? {})
          .filter(([k]) => k.startsWith('mesh:'))
          .reduce((n, [, v]) => n + v.bytes, 0);
        const connected = (live?.vpn ?? []).filter((p) => p.latestHandshake && Date.now() - Date.parse(p.latestHandshake) < 180_000).length;
        return (
          <>
            {info.mode === 'simulated' && (
              <Callout tone="info" title="Simulated gate">
                Nothing on this computer changes: commits, counters and devices are pretend. On FBRX Server with the gate role, FBRX Gate applies to the real ports.
              </Callout>
            )}
            {!run && (
              <Callout
                tone="warning"
                title="Nothing is applied yet"
                actions={
                  app.can('admin') && (
                    <Button variant="primary" icon="diff" onClick={() => go('gate-changes')}>
                      Review the starter configuration
                    </Button>
                  )
                }
              >
                FBRX Gate starts with the internet on {info.state.candidate.wan.interface} and your network on {info.state.candidate.networks[0]?.interface ?? 'the second port'}. Look it over, change what you need, and commit it.
              </Callout>
            )}
            {live?.problems
              .filter((p) => !p.startsWith('Simulated'))
              .map((p) => (
                <Callout key={p} tone="warning">
                  {p}
                </Callout>
              ))}
            {info.notes.filter((n) => !n.startsWith('Simulated')).length > 0 && (
              <Callout tone="info" title="From the last commit">
                {info.notes.filter((n) => !n.startsWith('Simulated')).join(' · ')}
              </Callout>
            )}
            <Grid cols={4}>
              <StatTile label="Internet address" value={live?.wan.address ?? '—'} foot={run ? `${run.wan.mode === 'dhcp' ? 'From your provider (DHCP)' : 'Fixed address'} on ${run.wan.interface}${live?.wan.gateway ? ` · via ${live.wan.gateway}` : ''}` : 'Not applied yet'} />
              <StatTile label="Downloading" value={bitRate(wanRate?.rx)} foot={run?.qos.enabled && run.qos.download ? `Shaped to ${run.qos.download} Mb/s` : 'Into the gate from the internet'} trend={g.wanHistory.map((h) => h.rx)} />
              <StatTile label="Uploading" value={bitRate(wanRate?.tx)} foot={run?.qos.enabled ? `Shaped to ${run.qos.upload} Mb/s` : 'Out to the internet'} trend={g.wanHistory.map((h) => h.tx)} />
              <StatTile label="Devices" value={live ? formatNumber(live.leases.length) : '—'} foot={live?.conntrack != null ? `${formatNumber(live.conntrack)} connections through the gate` : 'With an address from the gate'} />
            </Grid>
            {g.wanHistory.length > 1 && (
              <Card title="Internet traffic" subtitle={`Since this page opened (${Math.max(1, Math.round((g.wanHistory[g.wanHistory.length - 1].t - g.wanHistory[0].t) / 1000))} seconds, up to the last 3 minutes)`}>
                <LineChart
                  height={180}
                  yFormat={(n) => bitRate(n)}
                  series={[
                    { key: 'rx', label: 'Download', slot: 0, points: g.wanHistory.map((h) => ({ t: h.t, v: h.rx })) },
                    { key: 'tx', label: 'Upload', slot: 1, points: g.wanHistory.map((h) => ({ t: h.t, v: h.tx })) },
                  ]}
                />
              </Card>
            )}
            <Grid cols={2}>
              <Card title="Ports" flush>
                <Table
                  rows={run?.interfaces ?? []}
                  rowKey={(i) => i.name}
                  onRowClick={() => go('gate-networks')}
                  empty={<Empty title="Nothing applied yet" />}
                  columns={[
                    {
                      key: 'n',
                      header: 'Port',
                      render: (i) => {
                        const nets = run!.networks.filter((n) => n.interface === i.name).map((n) => n.name);
                        return (
                          <div>
                            <div className="fx-cell-title mono">{i.name}</div>
                            <div className="fx-cell-sub">{i.name === run!.wan.interface ? 'Internet' : nets.length ? nets.join(', ') : i.description || (i.kind === 'vlan' ? `VLAN ${i.vlanId}` : 'Not used')}</div>
                          </div>
                        );
                      },
                    },
                    {
                      key: 's',
                      header: 'State',
                      render: (i) => {
                        const l = live?.interfaces.find((x) => x.name === i.name);
                        return l ? <Status tone={l.up ? 'good' : 'critical'}>{l.up ? 'Up' : 'Down'}</Status> : <Status tone="neutral">—</Status>;
                      },
                    },
                    { key: 'm', header: 'MTU', render: (i) => (i.mtu >= 9000 ? <span title="Jumbo frames">{i.mtu} · jumbo</span> : i.mtu) },
                    {
                      key: 'r',
                      header: 'In / out',
                      render: (i) => (
                        <span className="gt-rate">
                          {bitRate(g.rates[i.name]?.rx)} <span className="fx-muted">/</span> {bitRate(g.rates[i.name]?.tx)}
                        </span>
                      ),
                    },
                  ]}
                />
              </Card>
              <Card title="Switched on">
                {run ? (
                  <KeyValue
                    items={[
                      ['Networks', run.networks.length ? run.networks.map((n) => zoneWords(n.name, run)).join(', ') : 'None'],
                      ['Firewall', `${run.firewall.rules.filter((r) => r.enabled).length} rule${run.firewall.rules.length === 1 ? '' : 's'}, ${run.firewall.forwards.filter((f) => f.enabled).length} port forward${run.firewall.forwards.length === 1 ? '' : 's'} · ${formatNumber(live?.counters['default:input']?.packets ?? 0)} knocks on the gate turned away`],
                      ['Names (DNS)', `${live?.dns.running ? 'Answering' : 'Not answering'} · .${run.dns.domain}${run.dns.block.enabled ? ` · blocking on${run.dns.block.domains.length + run.dns.block.lists.length ? '' : ' (nothing listed yet)'}` : ''}`],
                      ['VPN', run.vpn.enabled ? `${run.vpn.peers.length} device${run.vpn.peers.length === 1 ? '' : 's'} · ${connected} connected now` : 'Off'],
                      ['Traffic priority', run.qos.enabled ? (live?.qos.detail ?? 'On') : 'Off'],
                      ['Prefer Mesh', run.qos.preferMesh.enabled ? `On (${run.qos.preferMesh.trafficClass.toUpperCase()}) · ${formatBytes(meshBytes)} marked` : 'Off'],
                      ['Last commit', last ? `${last.id} · ${last.status} ${timeAgo(last.at)} by ${last.by}${last.comment ? ` · “${last.comment}”` : ''}` : 'None yet'],
                    ]}
                  />
                ) : (
                  <Empty title="Nothing applied yet" />
                )}
              </Card>
            </Grid>
            <Card title="Devices" subtitle="With an address from the gate" flush>
              <Table<GateLease>
                rows={live?.leases ?? []}
                rowKey={(l) => `${l.mac}-${l.address}`}
                empty={<Empty title="No devices yet">Devices show here when they ask the gate for an address.</Empty>}
                columns={[
                  { key: 'n', header: 'Device', render: (l) => <div><div className="fx-cell-title">{l.name ?? 'Unnamed'}</div><div className="fx-cell-sub mono">{l.mac}</div></div> },
                  { key: 'a', header: 'Address', render: (l) => <span className="mono">{l.address}</span> },
                  { key: 'w', header: 'Network', render: (l) => l.network ?? '—' },
                  { key: 'e', header: 'Address kept until', render: (l) => (l.expires ? new Date(l.expires).toLocaleString() : 'Reserved') },
                ]}
              />
            </Card>
          </>
        );
      }}
    </GatePage>
  );
}
