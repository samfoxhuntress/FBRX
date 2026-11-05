import { describe, expect, it } from 'vitest';
import type { AgentEvent, ChatMessage, OpenConversation, ToolCallRecord } from '@fbrx/shared';
import { NEW_CHAT, foldChat, openedChat, type ChatView } from '../src/renderer/chat-state';

const run = 'run_1';
const conv = 'conv_1';
const usage = { inputTokens: 1, outputTokens: 1 };
const user: ChatMessage = { id: 'msg_u', role: 'user', content: 'Add milk to my list', createdAt: '' };
const call = (status: ToolCallRecord['status']): ToolCallRecord => ({ id: 'call_1', name: 'workspace.add_task', input: { title: 'Milk' }, status });
const asked: ChatMessage = { id: 'msg_a', role: 'assistant', content: '', toolCalls: [call('pending')], createdAt: '' };
const answer: ChatMessage = { id: 'msg_b', role: 'assistant', content: 'Added.', createdAt: '' };

/** One run, as the core numbers its events. */
const EVENTS: AgentEvent[] = (
  [
    { type: 'run.started', runId: run, conversationId: conv, providerId: 'p', model: 'm' },
    { type: 'run.progress', runId: run, conversationId: conv, step: 1, maxSteps: 30, phase: 'model', detail: 'Asking m', usage },
    { type: 'message.completed', runId: run, conversationId: conv, message: asked },
    { type: 'run.progress', runId: run, conversationId: conv, step: 1, maxSteps: 30, phase: 'tool', detail: 'Add task: Milk', usage },
    { type: 'tool.updated', runId: run, conversationId: conv, messageId: 'msg_a', call: call('running') },
    { type: 'tool.updated', runId: run, conversationId: conv, messageId: 'msg_a', call: call('succeeded') },
    { type: 'run.progress', runId: run, conversationId: conv, step: 2, maxSteps: 30, phase: 'writing', detail: 'Writing the answer', usage },
    { type: 'message.delta', runId: run, conversationId: conv, messageId: 'msg_b', delta: 'Add' },
    { type: 'message.delta', runId: run, conversationId: conv, messageId: 'msg_b', delta: 'ed.' },
  ] as AgentEvent[]
).map((e, i) => ({ ...e, seq: i + 1 }));

/** Watched from the start: the chat open, every event folded in as it came. */
function watched(upTo: number): ChatView {
  return EVENTS.slice(0, upTo).reduce(foldChat, { ...NEW_CHAT, conversationId: conv, messages: [user] });
}

/** What the core answers when the chat opens after the first `upTo` events: the stored messages and the run so far. */
function opened(upTo: number): OpenConversation {
  const v = watched(upTo);
  return { id: conv, title: 'Milk', createdAt: '', updatedAt: '', messageCount: v.messages.length, providerId: null, model: null, origin: 'user', offline: true, projectId: null, messages: v.messages, run: v.run };
}

const withoutTimes = (v: ChatView) => ({ ...v, run: v.run && { ...v.run, startedAt: 0, steps: v.run.steps.map((s) => ({ ...s, at: 0 })) } });

describe('the open chat', () => {
  it('opened in the middle of a run, with the events heard while it opened, matches having watched it all', () => {
    for (let at = 1; at <= EVENTS.length; at++) {
      // The core answered after `at` events; the chat heard everything from event 2 on while it opened.
      const caughtUp = EVENTS.slice(1).reduce(foldChat, openedChat(opened(at)));
      expect(withoutTimes(caughtUp)).toEqual(withoutTimes(watched(EVENTS.length)));
    }
  });

  it('shows the reply as it is written, and each message once, in its place', () => {
    const v = watched(EVENTS.length);
    expect(v.run?.reply).toEqual({ messageId: 'msg_b', text: 'Added.' });
    expect(v.messages.map((m) => m.id)).toEqual(['msg_u', 'msg_a']);
    expect(v.messages[1].toolCalls?.[0].status).toBe('succeeded');
    const done = [
      { type: 'message.completed', runId: run, conversationId: conv, message: answer, seq: 10 },
      { type: 'run.completed', runId: run, conversationId: conv, steps: 2, usage, seq: 11 },
    ] as AgentEvent[];
    const finished = done.reduce(foldChat, v);
    expect(finished.run).toBeNull();
    expect(finished.messages.map((m) => m.id)).toEqual(['msg_u', 'msg_a', 'msg_b']);
    // A message heard twice stays where it is.
    expect(foldChat(finished, { ...done[0], seq: undefined } as AgentEvent).messages.map((m) => m.id)).toEqual(['msg_u', 'msg_a', 'msg_b']);
  });
});
