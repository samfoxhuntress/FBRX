import { useEffect, useMemo, useRef, useState } from 'react';
import { LEARNING_QUIPS, type LearningStatus, type LearningStep } from '@fbrx/shared';
import { Button, Card, FbrxMark, Icon, formatDate } from '@fbrx/ui';
import { call } from './client';
import { useAgentName, useCore } from './hooks';

/** How long each quip stays before the next one. */
const QUIP_MS = 2800;

/** The quips in an order of their own each time, the hyperdrives always first. */
function shuffled(): string[] {
  const [first, ...rest] = LEARNING_QUIPS;
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j]!, rest[i]!];
  }
  return [first!, ...rest];
}

/**
 * Whether the learning screen is up: while FBRX learns the computer on the full screen (after setup, for a new AI),
 * then the "Ready" moment, until the person goes on. A refresh in the background never shows it.
 */
export function useLearningScreen(): { status: LearningStatus | null; visible: boolean; close: () => void } {
  const status = useCore('learning.status', undefined, ['learning.changed']).data ?? null;
  // The run this window saw learning; its "Ready" stays until closed.
  const [seen, setSeen] = useState<string | null>(null);
  const [closed, setClosed] = useState<string | null>(null);
  const run = status?.startedAt ?? null;
  useEffect(() => {
    if (status?.state === 'learning' && status.screen && run) setSeen(run);
  }, [status?.state, status?.screen, run]);
  const visible = !!status && !!run && closed !== run && status.screen && (status.state === 'learning' || (status.state === 'ready' && seen === run));
  return { status, visible, close: () => setClosed(run) };
}

function StepRow({ step }: { step: LearningStep }) {
  const mark =
    step.state === 'done' ? <Icon name="checkCircle" /> : step.state === 'running' ? <span className="learn-spin" aria-hidden /> : step.state === 'failed' ? <Icon name="alert" /> : step.state === 'skipped' ? <Icon name="chevronRight" /> : <span className="learn-dot" aria-hidden />;
  return (
    <li className={`learn-step ${step.state}`}>
      <span className="learn-step-mark">{mark}</span>
      <span className="learn-step-label">{step.label}</span>
      {step.detail && <span className="learn-step-detail">{step.detail}</span>}
    </li>
  );
}

/**
 * Learning your computer: the full screen while FBRX gets the AI ready for this computer. The quips take turns, the
 * steps tick off as they are done, and the person can go on at any moment (it keeps going in the background).
 */
export function LearningScreen({ status, onClose }: { status: LearningStatus; onClose: () => void }) {
  const agentName = useAgentName();
  const quips = useMemo(shuffled, [status.startedAt]);
  const [n, setN] = useState(0);
  const ready = status.state === 'ready';
  useEffect(() => {
    if (ready) return;
    const t = setInterval(() => setN((x) => x + 1), QUIP_MS);
    return () => clearInterval(t);
  }, [ready]);
  // A clean finish goes on to the chat by itself after a moment; one with something to say waits for the person.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!ready || status.message) return;
    const t = setTimeout(() => closeRef.current(), 4500);
    return () => clearTimeout(t);
  }, [ready, status.message]);

  const total = status.steps.length || 1;
  const done = status.steps.filter((s) => s.state === 'done' || s.state === 'skipped' || s.state === 'failed').length;
  const running = status.steps.some((s) => s.state === 'running') ? 0.5 : 0;
  const pct = ready ? 100 : Math.round(((done + running) / total) * 100);
  const quip = quips[n % quips.length];
  const who = status.agent ? `${status.agent.label}, on ${status.agent.where}` : agentName;
  const title = ready ? 'Ready for action' : status.reason === 'agent' ? 'Getting your new agent up to speed' : 'Learning your computer';
  const goOn = () => {
    if (ready) onClose();
    else void call('learning.background').then(onClose, onClose);
  };

  return (
    <div className={`learn-screen${ready ? ' ready' : ''}`} role="dialog" aria-modal="true" aria-labelledby="learn-title">
      <div className="learn-card">
        <div className="learn-orbit" aria-hidden>
          <span className="learn-ring" />
          <span className="learn-ring two" />
          <FbrxMark size={52} />
        </div>
        <h1 id="learn-title" className="learn-title">
          {title}
        </h1>
        <p className="learn-who">
          {ready ? (status.summary ?? who) : `${agentName}${status.agent?.persona && status.agent.persona !== 'your own' ? ` (${status.agent.persona})` : ''} is getting to know this computer, with ${who}`}
        </p>
        {!ready && (
          <p key={n} className="learn-quip" aria-live="polite">
            {quip}
          </p>
        )}
        <div className="learn-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Learning progress">
          <span style={{ width: `${pct}%` }} />
        </div>
        <ul className="learn-steps">
          {status.steps.map((s) => (
            <StepRow key={s.id} step={s} />
          ))}
        </ul>
        {ready && status.message && <p className="learn-message">{status.message}</p>}
        <div className="learn-actions">
          {ready ? (
            <Button variant="primary" icon="sparkles" onClick={onClose} autoFocus>
              Start chatting
            </Button>
          ) : (
            <Button variant="ghost" onClick={goOn}>
              Keep going in the background
            </Button>
          )}
        </div>
        <p className="learn-note">
          {ready
            ? `Settings → Agent shows what ${agentName} knows, and learns it again.`
            : status.agent?.cloud
              ? 'Nothing on the computer is changed. The cloud AI gets what it learns without the computer’s name, serial number or addresses.'
              : 'Nothing on the computer is changed, and what it learns stays here.'}
        </p>
      </div>
    </div>
  );
}

/**
 * Settings → Agent: what the AI knows about this computer (the profile in its instructions), what a cloud AI gets
 * instead, and Learn again.
 */
export function ComputerKnowledge() {
  const agentName = useAgentName();
  const p = useCore('learning.profile', undefined, ['learning.changed']);
  const st = useCore('learning.status', undefined, ['learning.changed']).data;
  const [cloud, setCloud] = useState(false);
  const text = (cloud ? p.data?.cloud : p.data?.local) ?? null;
  const busy = st?.state === 'learning';
  return (
    <Card
      title={`What ${agentName} knows about this computer`}
      subtitle={p.data?.learnedAt ? `Learned ${formatDate(p.data.learnedAt)}${p.data.agent ? ` for ${p.data.agent}` : ''}` : 'Not learned yet'}
      actions={
        <Button size="sm" icon="refresh" loading={busy} onClick={() => void call('learning.start')}>
          Learn again
        </Button>
      }
    >
      <p className="fx-muted" style={{ fontSize: 12.5, marginTop: 0 }}>
        FBRX reads this on the computer after setup and for each new AI, and it goes into {agentName}’s instructions so it can answer about this
        computer straight away. It is learned again every week.
      </p>
      <div className="seg" role="group" aria-label="Which AI">
        <button className={cloud ? '' : 'on'} onClick={() => setCloud(false)}>
          A model on this computer
        </button>
        <button className={cloud ? 'on' : ''} onClick={() => setCloud(true)}>
          A cloud AI
        </button>
      </div>
      {text ? <pre className="learn-profile">{text}</pre> : <p className="fx-muted">Nothing yet: Learn again reads it now.</p>}
      {cloud && <p className="fx-muted" style={{ fontSize: 12.5, marginBottom: 0 }}>A cloud AI gets no serial number, computer or account name, network addresses or Wi-Fi name.</p>}
    </Card>
  );
}
