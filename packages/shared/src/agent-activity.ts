import type { AgentEvent, RunActivity } from './api';

/** The activity panel lists this many of the latest steps. */
const STEPS_KEPT = 60;
/** And keeps this much of the latest thinking. */
const THINKING_KEPT = 20_000;

/**
 * Folds one of a run's events into what the run is doing (null before it starts and once it ends). The core does this
 * as it emits the events; the chat does it again as they arrive. An event already folded in (by its sequence number)
 * changes nothing, so a chat that opens in the middle of a run can fold every event it hears onto the run's activity.
 */
export function foldRunActivity(a: RunActivity | null, e: AgentEvent, now = Date.now()): RunActivity | null {
  if (a && e.runId === a.runId && e.seq !== undefined && e.seq <= a.seq) return a;
  if (e.type === 'run.started') {
    return {
      runId: e.runId,
      conversationId: e.conversationId,
      seq: e.seq ?? 0,
      startedAt: now,
      steps: [],
      step: 0,
      maxSteps: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      thinking: '',
      thinkingFor: null,
      reply: null,
    };
  }
  if (!a || e.runId !== a.runId) return a;
  const seq = e.seq ?? a.seq;
  switch (e.type) {
    case 'run.progress': {
      const last = a.steps[a.steps.length - 1];
      const same = last && last.phase === e.phase && last.detail === e.detail;
      const steps = same ? a.steps : [...a.steps.slice(1 - STEPS_KEPT), { phase: e.phase, detail: e.detail, at: now }];
      return { ...a, seq, steps, step: e.step, maxSteps: e.maxSteps, usage: e.usage };
    }
    case 'thinking.delta':
      return e.messageId === a.thinkingFor
        ? { ...a, seq, thinking: (a.thinking + e.delta).slice(-THINKING_KEPT) }
        : { ...a, seq, thinking: e.delta, thinkingFor: e.messageId };
    case 'message.delta':
      return { ...a, seq, reply: { messageId: e.messageId, text: a.reply?.messageId === e.messageId ? a.reply.text + e.delta : e.delta } };
    case 'message.completed':
      return { ...a, seq, reply: a.reply?.messageId === e.message.id ? null : a.reply };
    case 'run.completed':
    case 'run.failed':
    case 'run.cancelled':
      return null;
    default:
      return { ...a, seq };
  }
}
