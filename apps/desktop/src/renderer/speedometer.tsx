/**
 * A car-style speedometer for the speed test: a dark dial with a 270° scale, a lit arc up to the needle and a
 * spring-loaded needle (CSS transitions do the swinging). The scale is stretched like a real speed test's, so
 * 5 Mbps and 500 Mbps both get room.
 */

/** Scale marks, evenly spaced around the dial. */
export const SPEED_MARKS = [0, 5, 10, 25, 50, 100, 250, 500, 1000, 2500];

/** Where a speed in Mbps sits on the dial, 0…1. */
export function speedFraction(mbps: number): number {
  if (!(mbps > 0)) return 0;
  const n = SPEED_MARKS.length - 1;
  for (let i = 1; i <= n; i++) {
    if (mbps <= SPEED_MARKS[i]) {
      const lo = SPEED_MARKS[i - 1];
      return (i - 1 + (mbps - lo) / (SPEED_MARKS[i] - lo)) / n;
    }
  }
  return 1;
}

const CX = 150;
const CY = 150;
const R = 118;
const START = 135;
const SWEEP = 270;

const at = (deg: number, r: number) => {
  const a = (deg * Math.PI) / 180;
  return { x: CX + r * Math.cos(a), y: CY + r * Math.sin(a) };
};
const ARC = (() => {
  const a = at(START, R);
  const b = at(START + SWEEP, R);
  return `M ${a.x} ${a.y} A ${R} ${R} 0 1 1 ${b.x} ${b.y}`;
})();

export interface SpeedometerProps {
  /** Needle position, 0…1. */
  fraction: number;
  /** Big number in the middle. */
  value: string;
  unit: string;
  /** Small line under the unit (the test phase, or a remark). */
  label?: string;
  /** Lightning and a blue glow (for 1.21 jigowatts). */
  flux?: boolean;
  /** Scale labels; defaults to the Mbps marks. */
  marks?: string[];
}

export function Speedometer({ fraction, value, unit, label, flux = false, marks }: SpeedometerProps) {
  const f = Math.max(0, Math.min(1, fraction));
  const labels = marks ?? SPEED_MARKS.map((m) => (m >= 1000 ? `${m / 1000}G` : String(m)));
  const n = labels.length - 1;
  const ticks: Array<{ deg: number; major: boolean }> = [];
  for (let i = 0; i <= n * 5; i++) ticks.push({ deg: START + (SWEEP * i) / (n * 5), major: i % 5 === 0 });
  return (
    <svg className={`speedo${flux ? ' flux' : ''}`} viewBox="0 0 300 300" role="img" aria-label={`${value} ${unit}${label ? `, ${label}` : ''}`}>
      <defs>
        <radialGradient id="speedo-face" cx="50%" cy="38%" r="70%">
          <stop offset="0" stopColor="#1d2430" />
          <stop offset="0.75" stopColor="#0b0e14" />
          <stop offset="1" stopColor="#05070a" />
        </radialGradient>
        <linearGradient id="speedo-bezel" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e9edf2" />
          <stop offset="0.35" stopColor="#8b939e" />
          <stop offset="0.6" stopColor="#f4f6f8" />
          <stop offset="1" stopColor="#5d646e" />
        </linearGradient>
        <linearGradient id="speedo-arc" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.55" />
          <stop offset="1" stopColor="var(--accent)" />
        </linearGradient>
        <linearGradient id="speedo-glass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.16" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <filter id="speedo-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3.2" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <circle cx={CX} cy={CY} r="146" fill="url(#speedo-bezel)" />
      <circle cx={CX} cy={CY} r="139" className="speedo-face" fill="url(#speedo-face)" />
      {/* Redline zone at the top of the scale. */}
      <path d={ARC} pathLength={100} fill="none" stroke="#e5484d" strokeOpacity="0.55" strokeWidth="5" strokeDasharray="0 88 12 0" />
      <path d={ARC} pathLength={100} fill="none" stroke="#ffffff" strokeOpacity="0.07" strokeWidth="14" strokeLinecap="round" />
      <path className="speedo-arc" d={ARC} pathLength={100} fill="none" stroke="url(#speedo-arc)" strokeWidth="14" strokeLinecap="round" strokeDasharray={`${f * 100} 100`} filter="url(#speedo-glow)" />
      {ticks.map((t, i) => {
        const a = at(t.deg, t.major ? 98 : 102);
        const b = at(t.deg, 108);
        return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#c9d1dc" strokeOpacity={t.major ? 0.9 : 0.4} strokeWidth={t.major ? 2.4 : 1.2} />;
      })}
      {labels.map((m, i) => {
        const p = at(START + (SWEEP * i) / n, 82);
        return (
          <text key={m} x={p.x} y={p.y + 4} textAnchor="middle" className="speedo-mark">
            {m}
          </text>
        );
      })}
      {flux && (
        <g className="speedo-bolts" fill="none" stroke="#dff1ff" strokeWidth="2.4" strokeLinejoin="round">
          <path d="M70 70 l18 16 -9 4 20 20" />
          <path d="M232 64 l-16 20 10 2 -18 22" />
          <path d="M150 30 l-6 18 8 0 -6 20" />
        </g>
      )}
      <g className="speedo-needle" style={{ transform: `rotate(${START + SWEEP * f}deg)` }}>
        <path d={`M ${CX - 14} ${CY - 3.5} L ${CX + 104} ${CY - 0.8} L ${CX + 108} ${CY} L ${CX + 104} ${CY + 0.8} L ${CX - 14} ${CY + 3.5} Z`} fill="#ff5a3c" />
      </g>
      <circle cx={CX} cy={CY} r="12" fill="#2a313c" stroke="#9aa3ae" strokeWidth="2" />
      <circle cx={CX} cy={CY} r="4" fill="#cfd6df" />
      <text x={CX} y={CY + 62} textAnchor="middle" className="speedo-value">
        {value}
      </text>
      <text x={CX} y={CY + 84} textAnchor="middle" className="speedo-unit">
        {unit}
      </text>
      {label && (
        <text x={CX} y={CY + 104} textAnchor="middle" className="speedo-label">
          {label}
        </text>
      )}
      <ellipse cx={CX} cy={CY - 62} rx="112" ry="70" fill="url(#speedo-glass)" pointerEvents="none" />
    </svg>
  );
}
