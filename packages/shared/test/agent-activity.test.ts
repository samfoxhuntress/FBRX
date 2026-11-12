import { describe, expect, it } from 'vitest';
import { foldRunActivity, type AgentEvent, type RunActivity } from '../src';

const run = 'run_1';
const conv = 'conv_1';
const usage = { inputTokens: 10, outputTokens: 2 };

/** A run's events as the core emits them: numbered from 1. */
function numbered(events: AgentEvent[]): AgentEvent[] {
  return events.map((e, i) => ({ ...e, seq: i + 1 }));
}

const EVENTS = numbered([
  { type: 'run.started', runId: run, conversationId: conv, providerId: 'p', model: 'm' },
  { type: 'run.progress', runId: run, conversationId: conv, step: 1, maxSteps: 30, phase: 'model', detail: 'Asking m', usage },
  { type: 'thinking.delta', runId: run, conversationId: conv, messageId: 'msg_1', delta: 'Let me see. ' },
  { type: 'thinking.delta', runId: run, conversationId: conv, messageId: 'msg_1', delta: 'The clock.' },
  { type: 'run.progress', runId: run, conversationId: conv, step: 1, maxSteps: 30, phase: 'writing', detail: 'Writing the answer', usage },
  { type: 'message.delta', runId: run, conversationId: conv, messageId: 'msg_1', delta: 'It is ' },
  { type: 'message.delta', runId: run, conversationId: conv, messageId: 'msg_1', delta: 'noon.' },
]);

const fold = (a: RunActivity | null, events: AgentEvent[]) => events.reduce<RunActivity | null>((acc, e) => foldRunActivity(acc, e, 1000), a);

describe('a run as it happens', () => {
  it('collects the steps, the thinking and the reply being written', () => {
    const a = fold(null, EVENTS)!;
    expect(a).toMatchObject({ runId: run, conversationId: conv, seq: 7, step: 1, maxSteps: 30, usage, thinking: 'Let me see. The clock.', thinkingFor: 'msg_1', reply: { messageId: 'msg_1', text: 'It is noon.' } });
    expect(a.steps.map((s) => s.phase)).toEqual(['model', 'writing']);
  });

  it('puts the same activity together from a snapshot and every event heard, even ones already in it', () => {
    const snapshot = fold(null, EVENTS.slice(0, 4));
    // Heard while the chat opened: events 3 and 4 are in the snapshot already, 5 to 7 are not.
    expect(fold(snapshot, EVENTS.slice(2))).toEqual(fold(null, EVENTS));
  });

  it('ends with the run, starts the reply over for each message, and keeps only the latest steps', () => {
    const a = fold(null, EVENTS);
    expect(foldRunActivity(a, { type: 'message.completed', runId: run, conversationId: conv, message: { id: 'msg_1', role: 'assistant', content: 'It is noon.', createdAt: '' }, seq: 8 })!.reply).toBeNull();
    expect(foldRunActivity(a, { type: 'run.completed', runId: run, conversationId: conv, steps: 1, usage, seq: 8 })).toBeNull();
    expect(foldRunActivity(a, { type: 'thinking.delta', runId: run, conversationId: conv, messageId: 'msg_2', delta: 'Next.', seq: 8 })!.thinking).toBe('Next.');
    // Another run's events leave it alone.
    expect(foldRunActivity(a, { type: 'message.delta', runId: 'run_2', conversationId: conv, messageId: 'x', delta: '!', seq: 99 })).toBe(a);
    const many = numbered([
      EVENTS[0],
      ...Array.from({ length: 80 }, (_, i): AgentEvent => ({ type: 'run.progress', runId: run, conversationId: conv, step: i, maxSteps: 90, phase: 'tool', detail: `Tool ${i}`, usage })),
    ]);
    const steps = fold(null, many)!.steps;
    expect(steps).toHaveLength(60);
    expect(steps[59].detail).toBe('Tool 79');
  });
});
