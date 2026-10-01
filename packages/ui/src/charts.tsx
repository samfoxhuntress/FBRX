import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

/** Categorical slots in validated order. Color follows the entity: pass a stable slot per series. */
export const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)'];

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => setW(Math.floor(entries[0].contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceStep(range: number, ticks = 4): number {
  if (range <= 0) return 1;
  const raw = range / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

// ---------------------------------------------------------------------------------- stat tile

export function StatTile({ label, value, foot, trend, hero }: { label: ReactNode; value: ReactNode; foot?: ReactNode; trend?: number[]; hero?: boolean }) {
  return (
    <div className="fx-card fx-stat">
      <div className="fx-stat-label">{label}</div>
      <div className={hero ? 'fx-hero' : 'fx-stat-value'}>{value}</div>
      <div className="fx-stat-foot">
        {foot}
      </div>
      {trend && trend.length > 1 && (
        <div className="fx-stat-trend">
          <Sparkline values={trend} fill />
        </div>
      )}
    </div>
  );
}

/**
 * Sparkline of the last points. Compact: de-emphasis ink with the current point in the accent. `fill`: stretches to
 * its container with an accent line and a fading accent area, as on the dashboard tiles.
 */
export function Sparkline({ values, width = 72, height = 20, fill = false }: { values: number[]; width?: number; height?: number; fill?: boolean }) {
  const id = useId().replace(/:/g, '');
  const v = values.slice(fill ? -40 : -12);
  const max = Math.max(...v, 1);
  const min = Math.min(...v, 0);
  const w = fill ? 200 : width;
  const h = fill ? 44 : height;
  const x = (i: number) => (i / Math.max(1, v.length - 1)) * (w - 4) + 2;
  const y = (n: number) => h - 2 - ((n - min) / (max - min || 1)) * (h - 6);
  const d = v.map((n, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(n).toFixed(1)}`).join('');
  if (fill) {
    return (
      <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={`spark${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.32} />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <path d={`${d}L${x(v.length - 1)},${h}L${x(0)},${h}Z`} fill={`url(#spark${id})`} />
        <path d={d} fill="none" stroke="var(--accent)" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
    );
  }
  return (
    <svg width={width} height={height} aria-hidden="true">
      <path d={d} fill="none" stroke="var(--text-muted)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(v.length - 1)} cy={y(v[v.length - 1])} r={3} fill="var(--accent)" stroke="var(--surface-1)" strokeWidth={1.5} />
    </svg>
  );
}

export function Meter({ value, max = 100, label }: { value: number; max?: number; label?: string }) {
  const pct = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  const color = pct >= 90 ? 'var(--critical)' : pct >= 75 ? 'var(--warning)' : 'var(--accent)';
  return (
    <div className="fx-meter" role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={label}>
      <div style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

// ---------------------------------------------------------------------------------- bar list

export interface BarItem {
  key: string;
  label: string;
  value: number;
}

/** Horizontal bars (magnitude by category): one hue, value at the tip, hover tooltip with share. */
export function BarList({ items, color = SERIES[0], format = (n: number) => n.toLocaleString(), empty }: { items: BarItem[]; color?: string; format?: (n: number) => string; empty?: ReactNode }) {
  const [hover, setHover] = useState<string | null>(null);
  const max = Math.max(...items.map((i) => i.value), 1);
  const total = items.reduce((n, i) => n + i.value, 0) || 1;
  if (!items.length) return <>{empty ?? <div className="fx-muted">No data</div>}</>;
  return (
    <div className="fx-barlist" role="list">
      {items.map((it) => (
        <div
          key={it.key}
          className="fx-barlist-row"
          role="listitem"
          tabIndex={0}
          onPointerEnter={() => setHover(it.key)}
          onPointerLeave={() => setHover(null)}
          onFocus={() => setHover(it.key)}
          onBlur={() => setHover(null)}
          aria-label={`${it.label}: ${format(it.value)}`}
        >
          <span className="fx-barlist-label" title={it.label}>
            {it.label}
          </span>
          <span className="fx-barlist-track">
            <span className="fx-barlist-bar" style={{ display: 'block', width: `${(it.value / max) * 100}%`, maxWidth: '100%', background: color }} />
            {hover === it.key && (
              <span className="fx-tooltip" style={{ left: `${Math.min(90, Math.max(10, (it.value / max) * 50))}%`, top: 0 }}>
                <div className="fx-tooltip-head">{it.label}</div>
                <div className="fx-tooltip-row">
                  <strong>{format(it.value)}</strong>
                  <span>{Math.round((it.value / total) * 100)}% of total</span>
                </div>
              </span>
            )}
          </span>
          <span className="fx-barlist-value">{format(it.value)}</span>
        </div>
      ))}
    </div>
  );
}

// -------------------------------------------------------------------------------- line chart

export interface LineSeries {
  key: string;
  label: string;
  /** Categorical slot (0-based); keep it stable per entity. */
  slot: number;
  points: Array<{ t: number; v: number | null }>;
}

/**
 * Time-series line chart: 2px lines, hairline grid, one y-axis, legend for ≥2 series, end labels,
 * crosshair tooltip listing every series, and a table view.
 */
export function LineChart({
  series,
  height = 200,
  yMax,
  yFormat = (n: number) => n.toLocaleString(),
  xFormat = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  area,
}: {
  series: LineSeries[];
  height?: number;
  yMax?: number;
  yFormat?: (n: number) => string;
  xFormat?: (t: number) => string;
  area?: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const gid = useId().replace(/:/g, '');
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const times = useMemo(() => [...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b), [series]);
  const values = series.flatMap((s) => s.points.map((p) => p.v ?? 0));
  const top = yMax ?? Math.max(...values, 1);
  const step = niceStep(top);
  const maxY = Math.ceil(top / step) * step;
  const m = { l: 40, r: series.length <= 4 ? 64 : 12, t: 10, b: 24 };
  const w = Math.max(0, width - m.l - m.r);
  const h = height - m.t - m.b;
  const t0 = times[0] ?? 0;
  const t1 = times[times.length - 1] ?? 1;
  const x = (t: number) => m.l + (t1 === t0 ? w / 2 : ((t - t0) / (t1 - t0)) * w);
  const y = (v: number) => m.t + h - (v / (maxY || 1)) * h;
  const ticks: number[] = [];
  for (let v = 0; v <= maxY + 1e-9; v += step) ticks.push(v);
  const xTicks = times.length > 1 ? [t0, t0 + (t1 - t0) / 2, t1] : times;
  // End labels only when they don't collide; otherwise the legend + tooltip carry identity.
  const endYs = series
    .map((s) => s.points.filter((p) => p.v !== null).sort((a, b) => a.t - b.t).pop())
    .filter((p): p is { t: number; v: number } => !!p)
    .map((p) => y(p.v))
    .sort((a, b) => a - b);
  const endLabels = series.length <= 4 && endYs.every((v, i) => i === 0 || v - endYs[i - 1] >= 14);

  const onMove = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    let best: number | null = null;
    let bestD = Infinity;
    for (const t of times) {
      const d = Math.abs(x(t) - px);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    setHoverT(best);
  };

  if (!times.length) return <div className="fx-muted" style={{ padding: '24px 0' }}>No data in this range yet.</div>;

  return (
    <div className="fx-chart" ref={ref}>
      <div className="fx-chart-legend">
        {series.length >= 2 &&
          series.map((s) => (
            <span key={s.key} className="fx-legend-key">
              <span className="fx-legend-line" style={{ background: SERIES[s.slot % 8] }} />
              {s.label}
            </span>
          ))}
        <button className="fx-btn ghost sm" style={{ marginLeft: 'auto', height: 22 }} onClick={() => setShowTable(!showTable)}>
          {showTable ? 'Chart' : 'Table'}
        </button>
      </div>
      {showTable ? (
        <div className="fx-table-wrap" style={{ maxHeight: height, overflow: 'auto' }}>
          <table className="fx-table">
            <thead>
              <tr>
                <th>Time</th>
                {series.map((s) => (
                  <th key={s.key} className="num">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {times.map((t) => (
                <tr key={t}>
                  <td>{xFormat(t)}</td>
                  {series.map((s) => {
                    const p = s.points.find((q) => q.t === t);
                    return (
                      <td key={s.key} className="num">
                        {p?.v === null || p?.v === undefined ? '—' : yFormat(p.v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        width > 0 && (
          <svg width={width} height={height} role="img" aria-label={`Line chart: ${series.map((s) => s.label).join(', ')}`} onPointerMove={onMove} onPointerLeave={() => setHoverT(null)}>
            {ticks.map((v) => (
              <g key={v}>
                <line x1={m.l} x2={m.l + w} y1={y(v)} y2={y(v)} stroke={v === 0 ? 'var(--axis)' : 'var(--grid)'} strokeWidth={1} />
                <text x={m.l - 8} y={y(v)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--text-muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {yFormat(v)}
                </text>
              </g>
            ))}
            {xTicks.map((t, i) => (
              <text key={t} x={x(t)} y={height - 6} textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'} fontSize={11} fill="var(--text-muted)">
                {xFormat(t)}
              </text>
            ))}
            {series.map((s) => {
              const pts = s.points.filter((p) => p.v !== null).sort((a, b) => a.t - b.t);
              if (!pts.length) return null;
              const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v!).toFixed(1)}`).join('');
              const color = SERIES[s.slot % 8];
              const last = pts[pts.length - 1];
              return (
                <g key={s.key}>
                  {(area || series.length <= 3) && (
                    <>
                      <defs>
                        <linearGradient id={`area${gid}${s.slot}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={color} stopOpacity={series.length === 1 ? 0.28 : 0.16} />
                          <stop offset="100%" stopColor={color} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <path d={`${d}L${x(last.t)},${y(0)}L${x(pts[0].t)},${y(0)}Z`} fill={`url(#area${gid}${s.slot})`} />
                    </>
                  )}
                  <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                  <circle cx={x(last.t)} cy={y(last.v!)} r={4} fill={color} stroke="var(--surface-1)" strokeWidth={2} />
                  {endLabels && (
                    <text x={x(last.t) + 8} y={y(last.v!)} dy="0.32em" fontSize={11} fill="var(--text-secondary)">
                      {series.length > 1 ? `${s.label} ` : ''}
                      {yFormat(last.v!)}
                    </text>
                  )}
                </g>
              );
            })}
            {hoverT !== null && (
              <g pointerEvents="none">
                <line x1={x(hoverT)} x2={x(hoverT)} y1={m.t} y2={m.t + h} stroke="var(--axis)" strokeWidth={1} />
                {series.map((s) => {
                  const p = s.points.find((q) => q.t === hoverT);
                  return p && p.v !== null ? <circle key={s.key} cx={x(hoverT)} cy={y(p.v)} r={4} fill={SERIES[s.slot % 8]} stroke="var(--surface-1)" strokeWidth={2} /> : null;
                })}
              </g>
            )}
            <rect x={m.l} y={m.t} width={w} height={h} fill="transparent" />
          </svg>
        )
      )}
      {!showTable && hoverT !== null && (
        <div className="fx-tooltip" style={{ left: x(hoverT), top: m.t + 28 }}>
          <div className="fx-tooltip-head">{xFormat(hoverT)}</div>
          {series.map((s) => {
            const p = s.points.find((q) => q.t === hoverT);
            return (
              <div key={s.key} className="fx-tooltip-row">
                <span className="fx-legend-line" style={{ background: SERIES[s.slot % 8] }} />
                <strong>{p?.v === null || p?.v === undefined ? '—' : yFormat(p.v)}</strong>
                <span>{s.label}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
