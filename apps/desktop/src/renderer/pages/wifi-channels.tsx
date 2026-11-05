import { useMemo, useState } from 'react';
import type { WifiAccessPoint, WifiBand, WifiBandReport, WifiChannelReport } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Spinner, Status, Table, timeAgo } from '@fbrx/ui';
import { useCore } from '../hooks';
import { navigate } from '../app';

/**
 * The Wi-Fi channel planner: every network around drawn over the channels it covers (yours in the accent color),
 * how busy each channel is, and the channel to move to with the reason. Endpoint Ultra adds the channel width to set,
 * DFS channels, how busy each channel has been since FBRX started, and every access point with its signal.
 */

const W = 960;
const H = 260;
const PAD = { left: 44, right: 16, top: 14, bottom: 30 };
/** Signal scale of the graph, in dBm. */
const TOP = -30;
const FLOOR = -95;

const y = (dbm: number) => PAD.top + ((TOP - Math.max(FLOOR, Math.min(TOP, dbm))) / (TOP - FLOOR)) * (H - PAD.top - PAD.bottom);

/** Where a channel sits on the graph: 2.4 GHz by channel number, 5 and 6 GHz evenly by their place in the list. */
function axis(band: WifiBandReport) {
  const chs = band.channels.map((c) => c.channel);
  const span = band.band === '2.4 GHz' ? { from: -1, to: 15 } : { from: -0.8, to: chs.length - 0.2 };
  const pos = (ch: number) => (band.band === '2.4 GHz' ? ch : chs.indexOf(ch));
  const x = (p: number) => PAD.left + ((p - span.from) / (span.to - span.from)) * (W - PAD.left - PAD.right);
  // A 2.4 GHz network covers 22 MHz: two channels either side. Elsewhere a scan does not say how wide: one slot.
  const half = band.band === '2.4 GHz' ? 2 : 0.45;
  return { chs, x, pos, half };
}

function Spectrum({ band, points }: { band: WifiBandReport; points: WifiAccessPoint[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const a = axis(band);
  const here = points.filter((p) => p.band === band.band && a.chs.includes(p.channel)).sort((p, q) => Number(p.mine) - Number(q.mine) || p.signalDbm - q.signalDbm);
  const labelled = new Set([...here].sort((p, q) => q.signalDbm - p.signalDbm).slice(0, 5).map((p) => p.bssid));
  const shape = (p: WifiAccessPoint) => {
    const c = a.pos(p.channel);
    const [x0, x1, xm, base, peak] = [a.x(c - a.half), a.x(c + a.half), a.x(c), y(FLOOR), y(p.signalDbm)];
    return `M${x0},${base} C${x0 + (xm - x0) * 0.35},${peak} ${x1 - (x1 - xm) * 0.35},${peak} ${x1},${base} Z`;
  };
  return (
    <svg className="wifi-spectrum" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Networks on the ${band.band} channels`}>
      {[-40, -50, -60, -70, -80, -90].map((d) => (
        <g key={d}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(d)} y2={y(d)} className="wifi-grid" />
          <text x={PAD.left - 6} y={y(d) + 4} className="wifi-tick" textAnchor="end">
            {d}
          </text>
        </g>
      ))}
      {a.chs.map((ch) => (
        <text key={ch} x={a.x(a.pos(ch))} y={H - 10} className={`wifi-tick${ch === band.best?.channel ? ' best' : ''}`} textAnchor="middle">
          {ch}
        </text>
      ))}
      {here.map((p) => (
        <path
          key={p.bssid || `${p.ssid}${p.channel}`}
          d={shape(p)}
          className={`wifi-net${p.mine ? ' mine' : ''}${hover === p.bssid ? ' on' : ''}`}
          onPointerEnter={() => setHover(p.bssid)}
          onPointerLeave={() => setHover(null)}
        >
          <title>{`${p.ssid} · channel ${p.channel} · ${p.signalDbm} dBm${p.mine ? ' · yours' : ''}`}</title>
        </path>
      ))}
      {here
        .filter((p) => labelled.has(p.bssid) || p.connected)
        .map((p) => (
          <text key={`l${p.bssid}`} x={a.x(a.pos(p.channel))} y={y(p.signalDbm) - 6} className={`wifi-name${p.mine ? ' mine' : ''}`} textAnchor="middle">
            {p.ssid.length > 18 ? `${p.ssid.slice(0, 17)}…` : p.ssid}
          </text>
        ))}
    </svg>
  );
}

/** How busy each channel is: taller is busier; the best channel and yours are marked. */
function Loads({ band }: { band: WifiBandReport }) {
  const max = Math.max(1, ...band.channels.map((c) => c.load));
  const shown = band.band === '2.4 GHz' ? band.channels : band.channels.filter((c) => c.load > 0 || c.mine || c.channel === band.best?.channel || !c.dfs);
  return (
    <div className="wifi-loads" role="list" aria-label="How busy each channel is">
      {shown.map((c) => (
        <div key={c.channel} role="listitem" className={`wifi-load${c.channel === band.best?.channel ? ' best' : ''}${c.mine ? ' mine' : ''}`} title={`Channel ${c.channel}: ${c.networks} network${c.networks === 1 ? '' : 's'} on it${c.dfs ? ' · DFS' : ''}`}>
          <span className="bar">
            <i style={{ height: `${Math.max(3, (c.load / max) * 100)}%` }} />
          </span>
          <b>{c.channel}</b>
          <small>{c.channel === band.best?.channel ? 'Best' : c.mine ? 'Yours' : c.dfs ? 'DFS' : c.networks || ''}</small>
        </div>
      ))}
    </div>
  );
}

/** Endpoint Ultra: how busy each channel has been since FBRX started (darker is busier). */
function History({ report, band }: { report: WifiChannelReport; band: WifiBandReport }) {
  const rows = useMemo(() => (report.history ?? []).filter((h) => h.loads[band.band]).slice(-48), [report.history, band.band]);
  if (rows.length < 2) return <span className="fx-muted">The history fills in as you keep this page open (a scan every two minutes).</span>;
  const max = Math.max(0.5, ...rows.flatMap((h) => h.loads[band.band]!));
  const channels = band.band === '2.4 GHz' ? [1, 6, 11] : band.channels.filter((c) => !c.dfs || c.channel === band.best?.channel).map((c) => c.channel);
  return (
    <div className="wifi-history" style={{ gridTemplateColumns: `52px repeat(${rows.length}, 1fr)` }} aria-label="How busy each channel has been">
      {channels.map((ch) => {
        const i = band.channels.findIndex((c) => c.channel === ch);
        return [
          <b key={`h${ch}`}>Ch {ch}</b>,
          ...rows.map((h) => <i key={`${ch}${h.at}`} title={`${new Date(h.at).toLocaleTimeString()} · load ${h.loads[band.band]![i]}`} style={{ opacity: 0.08 + (h.loads[band.band]![i] / max) * 0.92 }} />),
        ];
      })}
      <span />
      <small style={{ gridColumn: `2 / span ${rows.length}` }}>
        {timeAgo(rows[0].at)} → now
      </small>
    </div>
  );
}

export function WifiChannelPlanner() {
  const report = useCore('net.wifiChannels', undefined, [], 30_000);
  const [pick, setPick] = useState<WifiBand | null>(null);
  const r = report.data;
  if (report.error) return <Callout tone="warning">{report.error}</Callout>;
  if (!r) return <Spinner />;
  if (!r.points.length) return <Empty title="No Wi-Fi networks found">Turn Wi-Fi on, or this computer may not have Wi-Fi.</Empty>;
  const band = r.bands.find((b) => b.band === (pick ?? r.connected?.band)) ?? r.bands[0];
  return (
    <Card
      title="Channel planner"
      subtitle="Every network around, the channels they crowd, and the best one for yours"
      actions={
        <div className="seg" role="group" aria-label="Band">
          {r.bands.map((b) => (
            <button key={b.band} className={b === band ? 'on' : ''} onClick={() => setPick(b.band)}>
              {b.band}
            </button>
          ))}
        </div>
      }
    >
      <Spectrum band={band} points={r.points} />
      <Loads band={band} />
      <div className="wifi-advice">
        {band.best && (
          <Status tone={band.mine === null || band.mine === band.best.channel ? 'good' : 'warning'}>
            {band.mine === null ? `Best channel here: ${band.best.channel}` : band.mine === band.best.channel ? `Channel ${band.mine} is the best here` : `Best: channel ${band.best.channel} (yours is ${band.mine})`}
          </Status>
        )}
        <ul>
          {band.advice.map((t) => (
            <li key={t}>{t}</li>
          ))}
          {band.width && <li>Channel width: {band.width.mhz} MHz. {band.width.why}</li>}
        </ul>
        {r.router && (
          <Button size="sm" icon="globe" onClick={() => navigate(`browser/http://${r.router}`)} title="Channels are changed in your router's settings, usually under Wireless or Wi-Fi">
            Open router settings ({r.router})
          </Button>
        )}
      </div>
      {r.ultra ? (
        <div className="fx-grid" style={{ gap: 14, marginTop: 14 }}>
          <div>
            <div className="fx-label">How busy the channels have been</div>
            <History report={r} band={band} />
          </div>
          <div>
            <div className="fx-label">Access points on {band.band}</div>
            <Table
              columns={[
                { key: 'n', header: 'Network', render: (p) => (p.mine ? <b>{p.ssid}</b> : p.ssid) },
                { key: 'b', header: 'Access point', render: (p) => <span className="mono fx-muted">{p.bssid || '—'}</span> },
                { key: 'c', header: 'Channel', render: (p) => p.channel, width: 80 },
                { key: 's', header: 'Signal', render: (p) => `${p.signalDbm} dBm`, width: 90 },
                { key: 'x', header: '', render: (p) => (p.connected ? <Status tone="good">connected</Status> : p.mine ? <Status tone="neutral">yours</Status> : null), width: 110 },
              ]}
              rows={r.points.filter((p) => p.band === band.band)}
              rowKey={(p) => p.bssid || `${p.ssid}${p.channel}`}
            />
          </div>
        </div>
      ) : (
        <Callout tone="info">Endpoint Ultra adds the channel width to set, DFS channels, how busy each channel has been, and every access point with its signal.</Callout>
      )}
    </Card>
  );
}
