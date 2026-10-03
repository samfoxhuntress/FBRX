import { useEffect, useRef, useState } from 'react';
import type { AgentEvent, AgentPhase, TokenUsage } from '@fbrx/shared';
import { Icons, type IconName } from '@fbrx/ui';

/**
 * What the agent is doing while it works: the current step (asking the model, thinking, using a tool, waiting for
 * your approval, writing), a timeline of the steps so far, time and tokens, and its thinking as it streams in.
 */

export interface ActivityEntry {
  phase: AgentPhase;
  detail: string;
  at: number;
}

export interface Activity {
  runId: string;
  startedAt: number;
  entries: ActivityEntry[];
  step: number;
  maxSteps: number;
  usage: TokenUsage;
  /** Thinking for the current step (resets when the model starts a new reply). */
  thinking: string;
  thinkingFor: string | null;
}

export function newActivity(runId: string): Activity {
  return { runId, startedAt: Date.now(), entries: [], step: 0, maxSteps: 0, usage: { inputTokens: 0, outputTokens: 0 }, thinking: '', thinkingFor: null };
}

/** Folds an agent event into the activity (returns the same object when nothing changed). */
export function reduceActivity(a: Activity | null, e: AgentEvent): Activity | null {
  if (e.type === 'run.started') return newActivity(e.runId);
  if (!a || !('runId' in e) || e.runId !== a.runId) return a;
  if (e.type === 'run.progress') {
    const last = a.entries[a.entries.length - 1];
    const entries = last && last.phase === e.phase && last.detail === e.detail ? a.entries : [...a.entries.slice(-59), { phase: e.phase, detail: e.detail, at: Date.now() }];
    return { ...a, entries, step: e.step, maxSteps: e.maxSteps, usage: e.usage };
  }
  if (e.type === 'thinking.delta') {
    return e.messageId === a.thinkingFor ? { ...a, thinking: (a.thinking + e.delta).slice(-20_000) } : { ...a, thinking: e.delta, thinkingFor: e.messageId };
  }
  if (e.type === 'run.completed' || e.type === 'run.failed' || e.type === 'run.cancelled') return null;
  return a;
}

const PHASE: Record<AgentPhase, { label: string; icon: IconName }> = {
  model: { label: 'Starting', icon: 'sparkles' },
  reading: { label: 'Reading the results', icon: 'eye' },
  thinking: { label: 'Thinking', icon: 'brain' },
  writing: { label: 'Writing', icon: 'edit' },
  tool: { label: 'Working', icon: 'wrench' },
  approval: { label: 'Waiting for you', icon: 'shield' },
};

function seconds(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export function ActivityPanel({ activity, agentName, showThinking }: { activity: Activity; agentName: string; showThinking: boolean }) {
  const [, tick] = useState(0);
  const [open, setOpen] = useState(true);
  const [stepsOpen, setStepsOpen] = useState(false);
  const thinkRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const el = thinkRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activity.thinking]);

  const now = Date.now();
  const current = activity.entries[activity.entries.length - 1];
  const phase = current ? PHASE[current.phase] : PHASE.model;
  const Ico = Icons[phase.icon];
  const tokens = activity.usage.inputTokens + activity.usage.outputTokens;
  const done = activity.entries.slice(0, -1);
  return (
    <div className={`activity phase-${current?.phase ?? 'model'}`} aria-live="polite">
      <div className="activity-head">
        <span className="activity-pulse" aria-hidden>
          <Ico size={14} />
        </span>
        <div className="activity-now">
          <b>{phase.label}</b>
          <span className="activity-detail">{current?.detail ?? `${agentName} is getting started`}</span>
        </div>
        <span className="activity-meta">
          {activity.maxSteps ? `Step ${activity.step} of ${activity.maxSteps} · ` : ''}
          {seconds(now - activity.startedAt)}
          {tokens ? ` · ${tokens.toLocaleString()} tokens` : ''}
        </span>
      </div>
      {showThinking && activity.thinking.trim() && (
        <div className="activity-thinking">
          <button className="activity-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? <Icons.chevronDown size={12} /> : <Icons.chevronRight size={12} />} {agentName}'s thinking
          </button>
          {open && (
            <div className="activity-thinking-text" ref={thinkRef}>
              {activity.thinking}
            </div>
          )}
        </div>
      )}
      {done.length > 0 && (
        <div className="activity-steps">
          <button className="activity-toggle" onClick={() => setStepsOpen(!stepsOpen)} aria-expanded={stepsOpen}>
            {stepsOpen ? <Icons.chevronDown size={12} /> : <Icons.chevronRight size={12} />} {done.length} step{done.length === 1 ? '' : 's'} so far
          </button>
          {stepsOpen && (
            <ol>
              {done.map((e, i) => (
                <li key={`${e.at}-${i}`}>
                  <Icons.check size={12} />
                  <span>{e.detail}</span>
                  <span className="activity-dur">{seconds((activity.entries[i + 1]?.at ?? now) - e.at)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

/** The thinking behind a finished answer, folded away under it. */
export function ThinkingNote({ text, agentName }: { text: string; agentName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="msg-thinking">
      <button className="activity-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icons.brain size={12} /> How {agentName} thought about it {open ? <Icons.chevronDown size={12} /> : <Icons.chevronRight size={12} />}
      </button>
      {open && <div className="msg-thinking-text">{text}</div>}
    </div>
  );
}
