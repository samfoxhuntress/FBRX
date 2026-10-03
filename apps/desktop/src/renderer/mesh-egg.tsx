import { useEffect, useRef, useState } from 'react';
import { unlockTrophy } from './fun';

/**
 * Mesh easter egg: ping the same computer three times in a row (or your own address, if there is no other) and the
 * two computers end up pointing at each other, each sure the other one is the copy. Only with fun extras on.
 */

const LINES: Array<[side: 'left' | 'right', text: string]> = [
  ['left', 'Wait… you’re me?'],
  ['right', 'No. YOU’RE me.'],
  ['left', 'I pinged first.'],
  ['right', 'Reply from me: time < 1 ms.'],
  ['left', 'That’s exactly what I would say.'],
];

/** Counts clicks per target; the third within eight seconds calls back. */
export function useTriplePing(onTriple: (key: string) => void) {
  const hits = useRef(new Map<string, number[]>());
  return (key: string) => {
    const now = Date.now();
    const list = (hits.current.get(key) ?? []).filter((t) => now - t < 8000);
    list.push(now);
    hits.current.set(key, list);
    if (list.length >= 3) {
      hits.current.delete(key);
      onTriple(key);
    }
  };
}

function Monitor({ flip }: { flip?: boolean }) {
  return (
    <svg className={`pc-mon${flip ? ' flip' : ''}`} viewBox="0 0 120 110" aria-hidden>
      <g className="pc-arm">
        <path d="M86 58 Q100 52 110 46" stroke="var(--text-primary)" strokeWidth="4" strokeLinecap="round" fill="none" />
        <circle cx="111" cy="45" r="5" fill="#f2c9a0" stroke="var(--text-primary)" strokeWidth="1.5" />
        <path d="M114 43 L119 40" stroke="#f2c9a0" strokeWidth="3.2" strokeLinecap="round" />
      </g>
      <rect x="8" y="8" width="80" height="58" rx="7" fill="var(--surface-2)" stroke="var(--text-primary)" strokeWidth="3" />
      <rect x="15" y="15" width="66" height="44" rx="4" fill="#1d2433" />
      <circle cx="37" cy="33" r="4" fill="#9fe0ff" />
      <circle cx="59" cy="33" r="4" fill="#9fe0ff" />
      <path d="M38 47 Q48 42 58 47" stroke="#9fe0ff" strokeWidth="2.6" fill="none" strokeLinecap="round" />
      <rect x="42" y="66" width="12" height="16" fill="var(--text-primary)" />
      <rect x="28" y="82" width="40" height="7" rx="3.5" fill="var(--text-primary)" />
    </svg>
  );
}

export function PointingComputers({ left, right, onClose }: { left: string; right: string; onClose: () => void }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    unlockTrophy('mirror');
    const timers = LINES.map((_l, i) => setTimeout(() => setShown(i + 1), 300 + i * 1300));
    const done = setTimeout(onClose, 300 + LINES.length * 1300 + 2200);
    return () => {
      timers.forEach(clearTimeout);
      clearTimeout(done);
    };
  }, [onClose]);
  const line = LINES[shown - 1];
  return (
    <div className="pc-egg" role="dialog" aria-label="Two computers pointing at each other" onClick={onClose}>
      <div className="pc-stage">
        <div className="pc-side">
          {line?.[0] === 'left' && <div className="pc-bubble left">{line[1]}</div>}
          <Monitor />
          <div className="pc-name">{left}</div>
        </div>
        <div className="pc-ping" aria-hidden>
          <span />
          <span />
          <span />
        </div>
        <div className="pc-side">
          {line?.[0] === 'right' && <div className="pc-bubble right">{line[1]}</div>}
          <Monitor flip />
          <div className="pc-name">{right}</div>
        </div>
      </div>
      <div className="pc-caption">Ping 0.4 ms · packet loss 0% · identity crisis 100%</div>
    </div>
  );
}
