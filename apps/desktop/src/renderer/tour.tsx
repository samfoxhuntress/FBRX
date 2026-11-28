import { useCallback, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { Button, Icons } from '@fbrx/ui';

/** One stop on the walkthrough: a sidebar page it points at (by its id), or none for a card in the middle. */
export interface TourStep {
  target?: string;
  title: string;
  body: ReactNode;
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

const PAD = 6;
const CARD_W = 340;

/** Where the step's sidebar item is on screen (null when it is not shown). */
function boxOf(target: string | undefined): Box | null {
  if (!target) return null;
  const el = document.querySelector<HTMLElement>(`[data-nav="${CSS.escape(target)}"]`);
  if (!el) return null;
  el.scrollIntoView({ block: 'nearest' });
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
}

/**
 * The Essentials walkthrough: a short look around the app on a new computer. It dims the window, lights up one page
 * in the sidebar at a time with a card that says what it is for, and ends on how to get more (Settings → Edition).
 * Enter or → goes on, ← goes back, Esc skips; it never opens a page or changes anything by itself.
 */
export function Tour({ steps, onDone }: { steps: TourStep[]; onDone: (finished: boolean) => void }) {
  const [i, setI] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const step = steps[Math.min(i, steps.length - 1)];
  const last = i >= steps.length - 1;

  const place = useCallback(() => setBox(boxOf(step.target)), [step.target]);
  useLayoutEffect(place, [place]);
  useEffect(() => {
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [place]);

  const next = useCallback(() => (last ? onDone(true) : setI((n) => n + 1)), [last, onDone]);
  const back = useCallback(() => setI((n) => Math.max(0, n - 1)), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDone(false);
      else if (e.key === 'Enter' || e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') back();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, back, onDone]);

  // Next to the lit item (the sidebar is on the left), kept on screen; in the middle when nothing is lit.
  const cardStyle = box
    ? { top: Math.max(16, Math.min(box.top - 8, window.innerHeight - 260)), left: Math.min(box.left + box.width + 18, window.innerWidth - CARD_W - 16), width: CARD_W }
    : { top: '50%', left: '50%', width: CARD_W + 60, transform: 'translate(-50%, -50%)' };

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      {box ? <div className="tour-spot" style={box} /> : <div className="tour-dim" />}
      <div className={`tour-card${box ? '' : ' center'}`} style={cardStyle}>
        {box && <span className="tour-arrow" aria-hidden style={{ top: Math.min(box.top + box.height / 2, window.innerHeight - 40) - (cardStyle.top as number) - 7 }} />}
        <div className="tour-step-count">
          {!box && <Icons.sparkles size={14} />} {i + 1} of {steps.length}
        </div>
        <h3 id="tour-title">{step.title}</h3>
        <div className="tour-body">{step.body}</div>
        <div className="tour-dots" aria-hidden>
          {steps.map((_s, n) => (
            <span key={n} className={n === i ? 'on' : n < i ? 'seen' : ''} />
          ))}
        </div>
        <div className="tour-actions">
          {!last && (
            <button className="link-btn" onClick={() => onDone(false)}>
              Skip the tour
            </button>
          )}
          <span style={{ flex: 1 }} />
          {i > 0 && (
            <Button size="sm" onClick={back}>
              Back
            </Button>
          )}
          <Button size="sm" variant="primary" onClick={next} autoFocus>
            {last ? 'Start using FBRX' : i === 0 ? 'Show me around' : 'Next'}
          </Button>
        </div>
      </div>
    </div>
  );
}
