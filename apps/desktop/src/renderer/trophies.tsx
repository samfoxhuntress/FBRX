import type { ReactNode } from 'react';
import { GOLDEN_TROPHY, TROPHIES, type TrophyInfo } from '@fbrx/shared';
import { Button, Callout, Card, formatDate } from '@fbrx/ui';
import { useCore } from './hooks';
import { summonGoose } from './fun';

/**
 * The trophy case (Settings → Trophy case): one badge per easter egg. Found badges are in color with how they were
 * earned and when; the rest are greyed out with a hint. The core keeps the record (fun.trophies) and awards the
 * Golden Goose by itself once every other badge is found.
 */

const COLORS: Record<string, [string, string]> = {
  goose: ['#f4efe2', '#b9b1a0'],
  shoo: ['#8fbf7a', '#4f7f3c'],
  konami: ['#7d8bff', '#3b46b8'],
  loom: ['#e0a15c', '#9a5c22'],
  goggles: ['#ffc65c', '#c07a10'],
  stories: ['#c39af0', '#6f3fa8'],
  matrix: ['#3fcf7a', '#0f6b38'],
  sandwich: ['#f0c66b', '#a8741c'],
  teapot: ['#6cc5c7', '#2a7d80'],
  edge: ['#e3e6ea', '#8a9099'],
  nat20: ['#ee6a5f', '#9e2a21'],
  jigowatts: ['#6fb3ff', '#1f5fbf'],
  stapler: ['#f06058', '#a3201a'],
  loose: ['#b9bec7', '#5f6570'],
  flaps: ['#5c6270', '#22252c'],
  golden: ['#ffd95a', '#b8860b'],
  chicken: ['#ffe9a8', '#c9962b'],
  pcload: ['#d7dde4', '#6c7682'],
  chewie: ['#c08a5a', '#6b4423'],
  fuzzball: ['#d9a46c', '#7a4f26'],
  father: ['#ef5350', '#5a0f0f'],
  wookiee: ['#a9784c', '#4e3018'],
};

/** The picture on each badge, drawn in a 64 × 64 box. */
function Glyph({ id }: { id: string }): ReactNode {
  switch (id) {
    case 'goose':
      return (
        <g>
          <ellipse cx="37" cy="43" rx="13" ry="7.5" fill="#fff" stroke="#9c9484" strokeWidth="1.2" />
          <path d="M28 42 Q22 32 26 21" stroke="#fff" strokeWidth="6.5" strokeLinecap="round" fill="none" />
          <circle cx="26.5" cy="20" r="5.5" fill="#fff" stroke="#9c9484" strokeWidth="1.1" />
          <path d="M21.5 19 L14 21 L21.5 23 Z" fill="#f08c00" />
          <circle cx="25" cy="18.5" r="1.2" fill="#1b1b1b" />
        </g>
      );
    case 'shoo':
      return (
        <g fill="#f08c00" stroke="#a85e00" strokeWidth="1">
          <path d="M32 46 L20 24 Q24 20 27 24 L32 34 L37 24 Q40 20 44 24 Z" />
          <path d="M32 46 L30 22 Q32 17 34 22 Z" />
        </g>
      );
    case 'konami':
      return (
        <g>
          <rect x="14" y="23" width="36" height="20" rx="9" fill="#1e2340" />
          <path d="M22 29v8M18 33h8" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
          <circle cx="40" cy="36" r="2.6" fill="#ff5d5d" />
          <circle cx="45" cy="31" r="2.6" fill="#ffd34d" />
          <text x="32" y="20" textAnchor="middle" fontSize="7" fontWeight="700" fill="#fff">↑↑↓↓</text>
        </g>
      );
    case 'loom':
      return (
        <g>
          {[22, 32, 42].map((x, i) => (
            <rect key={`v${x}`} x={x - 3} y="16" width="6" height="32" rx="1.5" fill={i % 2 ? '#fff3e0' : '#7a3e10'} />
          ))}
          {[22, 32, 42].map((y, i) => (
            <g key={`h${y}`}>
              <rect x="16" y={y - 3} width="32" height="6" rx="1.5" fill={i % 2 ? '#7a3e10' : '#fff3e0'} />
              {[22, 32, 42]
                .filter((_, j) => (i + j) % 2 === 0)
                .map((x) => (
                  <rect key={x} x={x - 3} y={y - 3} width="6" height="6" fill={i % 2 ? '#fff3e0' : '#7a3e10'} />
                ))}
            </g>
          ))}
        </g>
      );
    case 'goggles':
      return (
        <g>
          <path d="M12 31 Q32 24 52 31" stroke="#5a3a10" strokeWidth="3" fill="none" />
          <circle cx="24" cy="33" r="8" fill="#bfe8ff" stroke="#3b3b3b" strokeWidth="3" />
          <circle cx="40" cy="33" r="8" fill="#bfe8ff" stroke="#3b3b3b" strokeWidth="3" />
          <path d="M30.5 33h3" stroke="#3b3b3b" strokeWidth="3" />
          <path d="M20 30 l3 -2 M36 30 l3 -2" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
        </g>
      );
    case 'stories':
      return (
        <g>
          <path d="M14 22 Q23 18 32 23 Q41 18 50 22 V45 Q41 41 32 46 Q23 41 14 45 Z" fill="#fff" stroke="#4b2a78" strokeWidth="1.5" />
          <path d="M32 23 V46" stroke="#4b2a78" strokeWidth="1.5" />
          <path d="M41 11 l1.6 3.4 3.7.5 -2.7 2.6.7 3.7 -3.3-1.8 -3.3 1.8.7-3.7 -2.7-2.6 3.7-.5z" fill="#ffd34d" />
          <path d="M18 28h9M18 32h9M37 28h9M37 32h7" stroke="#b9a6d6" strokeWidth="1.5" strokeLinecap="round" />
        </g>
      );
    case 'matrix':
      return (
        <g>
          {[18, 25, 39, 46].map((x, i) => (
            <text key={x} x={x} y={20 + (i % 2) * 8} fontSize="8" fontFamily="monospace" fill="#b6ffcf" opacity="0.8">
              {i % 2 ? '1' : '0'}
            </text>
          ))}
          <g transform="rotate(-35 32 38)">
            <rect x="20" y="32" width="24" height="12" rx="6" fill="#fff" />
            <path d="M26 32 h6 v12 h-6 a6 6 0 0 1 0-12z" fill="#e0262b" />
          </g>
        </g>
      );
    case 'sandwich':
      return (
        <g>
          <path d="M14 30 Q32 14 50 30 Z" fill="#e8b45c" stroke="#9c6b1c" strokeWidth="1.2" />
          <path d="M13 31 q4 3 8 0 q4 3 8 0 q4 3 8 0 q4 3 8 0 q4 3 6 0" stroke="#3fae4a" strokeWidth="3" fill="none" />
          <rect x="15" y="34" width="34" height="4" fill="#ffd34d" />
          <rect x="15" y="38" width="34" height="4" fill="#d9534f" />
          <rect x="14" y="42" width="36" height="6" rx="3" fill="#e8b45c" stroke="#9c6b1c" strokeWidth="1.2" />
        </g>
      );
    case 'teapot':
      return (
        <g fill="#fff" stroke="#1f5c5e" strokeWidth="1.6">
          <ellipse cx="31" cy="38" rx="13" ry="10" />
          <path d="M44 34 Q51 33 53 26 Q48 30 44 30" />
          <path d="M18 33 Q11 35 15 42 Q17 43 19 41" fill="none" />
          <path d="M22 28 h18" />
          <circle cx="31" cy="24" r="2.5" />
          <text x="31" y="42" textAnchor="middle" fontSize="7" fontWeight="700" stroke="none" fill="#1f5c5e">418</text>
        </g>
      );
    case 'edge':
      return (
        <g>
          <ellipse cx="32" cy="48" rx="14" ry="2.5" fill="#00000033" />
          <rect x="28" y="16" width="8" height="32" rx="4" fill="#c9a227" stroke="#7a5f0c" strokeWidth="1.2" />
          <path d="M30 20v24M34 20v24" stroke="#7a5f0c" strokeWidth="0.8" />
          <path d="M18 24l-4-3M46 24l4-3M17 32h-5M47 32h5" stroke="#555" strokeWidth="1.5" strokeLinecap="round" />
        </g>
      );
    case 'nat20':
      return (
        <g>
          <path d="M32 12 L49 22 V42 L32 52 L15 42 V22 Z" fill="#fff" stroke="#7a1d16" strokeWidth="1.6" />
          <path d="M32 12 L22 35 H42 Z M22 35 L15 22 M42 35 L49 22 M22 35 L32 52 L42 35" stroke="#7a1d16" strokeWidth="1" fill="none" />
          <text x="32" y="32" textAnchor="middle" fontSize="9" fontWeight="800" fill="#7a1d16">20</text>
        </g>
      );
    case 'jigowatts':
      return (
        <g>
          <rect x="16" y="14" width="32" height="36" rx="4" fill="#1d2433" stroke="#9fb4d6" strokeWidth="1.2" />
          <path d="M24 22 L32 32 M40 22 L32 32 M32 32 V44" stroke="#bfe3ff" strokeWidth="3" strokeLinecap="round" />
          <circle cx="32" cy="32" r="3" fill="#fff" />
          <path d="M34 18 l-4 6 h4 l-3 6" stroke="#ffd34d" strokeWidth="1.6" fill="none" strokeLinejoin="round" />
        </g>
      );
    case 'stapler':
      return (
        <g>
          <rect x="14" y="40" width="36" height="6" rx="2" fill="#3a3a3a" />
          <path d="M14 38 Q14 28 24 28 H48 Q52 28 52 32 V36 H14 Z" fill="#e0262b" stroke="#8c1410" strokeWidth="1.2" />
          <circle cx="18" cy="38" r="2" fill="#bbb" />
          <path d="M26 31h20" stroke="#ff8a85" strokeWidth="1.5" strokeLinecap="round" />
        </g>
      );
    case 'loose':
      return (
        <g>
          <circle cx="32" cy="32" r="13" fill="#d6d9de" stroke="#5a5f68" strokeWidth="1.6" />
          <path d="M23 27 L41 37" stroke="#5a5f68" strokeWidth="3.2" strokeLinecap="round" />
          <path d="M47 15 q4 3 2 7 M51 20 q2 3 0 6" stroke="#5a5f68" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </g>
      );
    case 'flaps':
      return (
        <g>
          <rect x="20" y="14" width="24" height="36" rx="3" fill="#1b1d22" />
          <path d="M20 32 H44" stroke="#000" strokeWidth="1.6" />
          <text x="32" y="41" textAnchor="middle" fontSize="22" fontWeight="800" fontFamily="monospace" fill="#f5f5f0">
            F
          </text>
          <circle cx="21.5" cy="32" r="1.3" fill="#888" />
          <circle cx="42.5" cy="32" r="1.3" fill="#888" />
        </g>
      );
    case 'chicken':
      return (
        <g>
          <ellipse cx="34" cy="40" rx="13" ry="10" fill="#fff" stroke="#b07a1a" strokeWidth="1.2" />
          <circle cx="26" cy="27" r="7" fill="#fff" stroke="#b07a1a" strokeWidth="1.2" />
          <path d="M23 20 q2 -5 4 0 q2 -5 4 0" fill="#e0262b" />
          <path d="M19.5 27 l-5 1.5 5 1.5z" fill="#f08c00" />
          <path d="M22 31 q-1 4 1.5 4.5" fill="#e0262b" />
          <circle cx="25" cy="26" r="1.2" fill="#1b1b1b" />
          <path d="M44 34 q6 -4 5 4" stroke="#b07a1a" strokeWidth="1.2" fill="#fff" />
          <path d="M30 50 v5 M37 50 v5" stroke="#f08c00" strokeWidth="2" strokeLinecap="round" />
        </g>
      );
    case 'pcload':
      return (
        <g>
          <rect x="16" y="26" width="32" height="15" rx="3" fill="#3a3f47" />
          <rect x="22" y="15" width="20" height="12" fill="#fff" stroke="#999" strokeWidth="1" />
          <rect x="21" y="38" width="22" height="12" fill="#fff" stroke="#999" strokeWidth="1" />
          <rect x="34" y="29" width="10" height="4" rx="1" fill="#9be38f" />
          <text x="32" y="47" textAnchor="middle" fontSize="5.4" fontWeight="800" fill="#c62828">LETTER?</text>
        </g>
      );
    case 'chewie':
      return (
        <g>
          <path d="M20 14 L44 50" stroke="#3e2a14" strokeWidth="6" strokeLinecap="round" />
          {[0, 1, 2, 3, 4].map((i) => (
            <rect key={i} x={22.5 + i * 4.4} y={17 + i * 6.6} width="4.5" height="5" rx="1" fill="#c9c9c9" stroke="#555" strokeWidth="0.6" transform={`rotate(-34 ${24.7 + i * 4.4} ${19.5 + i * 6.6})`} />
          ))}
          <path d="M40 18 l4 -6 2 7 6 1 -5 4" fill="#ffd34d" />
        </g>
      );
    case 'fuzzball':
      return (
        <g>
          <circle cx="32" cy="33" r="15" fill="#8a5a2b" />
          {Array.from({ length: 14 }, (_, i) => {
            const a = (i / 14) * Math.PI * 2;
            return <path key={i} d={`M${32 + Math.cos(a) * 13} ${33 + Math.sin(a) * 13} l${Math.cos(a) * 5} ${Math.sin(a) * 5}`} stroke="#8a5a2b" strokeWidth="2.4" strokeLinecap="round" />;
          })}
          <circle cx="27" cy="29" r="2" fill="#1b1b1b" />
          <circle cx="37" cy="29" r="2" fill="#1b1b1b" />
          <path d="M25 36 q7 8 14 0 z" fill="#3a1d0b" />
        </g>
      );
    case 'father':
      return (
        <g>
          <path d="M18 40 Q18 16 32 15 Q46 16 46 40 L50 47 H14 Z" fill="#1d1d1f" stroke="#555" strokeWidth="1" />
          <path d="M24 30 h7 v5 h-7z M33 30 h7 v5 h-7z" fill="#5a0f0f" />
          <path d="M28 39 h8 l2 7 h-12z" fill="#3a3a3c" />
          <path d="M29.5 41 v4 M32 41 v4 M34.5 41 v4" stroke="#888" strokeWidth="0.8" />
        </g>
      );
    case 'wookiee':
      return (
        <g>
          <path d="M18 22 Q20 10 32 10 Q44 10 46 22 L48 44 Q40 54 32 54 Q24 54 16 44 Z" fill="#7a4f26" />
          <path d="M22 26 Q32 20 42 26 L41 42 Q32 48 23 42 Z" fill="#a8774a" />
          <circle cx="27" cy="31" r="2" fill="#1b1b1b" />
          <circle cx="37" cy="31" r="2" fill="#1b1b1b" />
          <path d="M28 40 q4 3 8 0" stroke="#3a1d0b" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          <path d="M30 35 h4 l-2 2z" fill="#2a1508" />
        </g>
      );
    case 'golden':
      return (
        <g>
          <ellipse cx="30" cy="36" rx="12" ry="15" fill="#ffd34d" stroke="#a87a00" strokeWidth="1.5" />
          <path d="M24 26 q3 -4 6 -3" stroke="#fff6c9" strokeWidth="2.4" strokeLinecap="round" fill="none" />
          <path d="M42 36 l-3 14 4-3 3 4 1-15z" fill="#c8102e" />
          <circle cx="43" cy="33" r="7.5" fill="#ffd34d" stroke="#a87a00" strokeWidth="1.5" />
          <text x="43" y="36" textAnchor="middle" fontSize="7.5" fontWeight="800" fill="#7a5600">#1</text>
        </g>
      );
    default:
      return null;
  }
}

/** A round badge: colored when found, greyed out with a small lock when not. */
export function TrophyBadge({ id, found, size = 64 }: { id: string; found: boolean; size?: number }) {
  const [hi, lo] = COLORS[id] ?? ['#ccc', '#777'];
  const g = `tb-${id}`;
  return (
    <svg className={`trophy-badge${found ? ' found' : ''}`} width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <radialGradient id={g} cx="35%" cy="30%" r="80%">
          <stop offset="0" stopColor={hi} />
          <stop offset="1" stopColor={lo} />
        </radialGradient>
      </defs>
      <circle cx="32" cy="32" r="30" fill={`url(#${g})`} stroke={lo} strokeWidth="2" />
      <circle cx="32" cy="32" r="25.5" fill="none" stroke="#ffffff66" strokeWidth="1.2" strokeDasharray="2 2.5" />
      <Glyph id={id} />
      {!found && (
        <g transform="translate(44 44)">
          <circle r="9" fill="var(--surface-1, #fff)" stroke="#8888" />
          <rect x="-4" y="-1.5" width="8" height="6.5" rx="1.2" fill="#777" />
          <path d="M-2.6 -1.5 v-2 a2.6 2.6 0 0 1 5.2 0 v2" stroke="#777" strokeWidth="1.6" fill="none" />
        </g>
      )}
    </svg>
  );
}

function TrophyTile({ t, at }: { t: TrophyInfo; at: string | undefined }) {
  return (
    <div className={`trophy-tile${at ? ' found' : ''}`} title={at ? t.how : `Hint: ${t.hint}`}>
      <TrophyBadge id={t.id} found={!!at} />
      <div className="trophy-name">{t.name}</div>
      <div className="trophy-text">{at ? t.how : t.hint}</div>
      {at && <div className="trophy-date">Found {formatDate(at)}</div>}
    </div>
  );
}

export function TrophyCase({ enabled, onEnable }: { enabled: boolean; onEnable: () => void }) {
  const { data } = useCore('fun.trophies', undefined, ['fun.trophy']);
  const unlocked = data?.unlocked ?? {};
  const found = TROPHIES.filter((t) => unlocked[t.id]).length;
  const golden = unlocked[GOLDEN_TROPHY.id];
  return (
    <>
      {!enabled && (
        <Callout tone="info" title="Fun extras are off" actions={<Button size="sm" variant="primary" onClick={onEnable}>Turn on Fun extras</Button>}>
          Easter eggs are switched off, so nothing new can be found. Badges you already found stay here.
        </Callout>
      )}
      <Card title="Trophy case" subtitle="Every easter egg in FBRX OS has a badge. Greyed-out ones are still out there; each has a hint.">
        <div className="trophy-head">
          <div className={`trophy-golden${golden ? ' found' : ''}`}>
            <TrophyBadge id="golden" found={!!golden} size={88} />
            <div>
              <div className="trophy-name">{GOLDEN_TROPHY.name}</div>
              <div className="trophy-text">{golden ? GOLDEN_TROPHY.how : `Find all ${TROPHIES.length} badges below. The goose will be very proud.`}</div>
              {golden ? (
                <Button size="sm" icon="feather" disabled={!enabled} onClick={summonGoose}>
                  Show off the egg
                </Button>
              ) : null}
            </div>
          </div>
          <div className="trophy-progress">
            <div className="trophy-count">
              <b>{found}</b> of {TROPHIES.length} found
            </div>
            <div className="trophy-bar">
              <span style={{ width: `${(found / TROPHIES.length) * 100}%` }} />
            </div>
          </div>
        </div>
        <div className="trophy-grid">
          {TROPHIES.map((t) => (
            <TrophyTile key={t.id} t={t} at={unlocked[t.id]} />
          ))}
        </div>
      </Card>
    </>
  );
}
