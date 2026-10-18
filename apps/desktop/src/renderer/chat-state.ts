import { foldRunActivity, type AgentEvent, type ChatMessage, type OpenConversation, type RunActivity } from '@fbrx/shared';

/**
 * The open chat: its messages and what the agent is doing in it right now.
 *
 * Opening a chat takes both from the core in one answer (ai.conversations.get); the agent's events for the chat then
 * fold in on top. Events that arrive while it opens are folded in once it has: the run's sequence numbers skip what the
 * core's answer already had, and the message events are whole messages, so applying one twice changes nothing. Leaving
 * the chat and coming back puts it together the same way, so the live activity of a run is never lost.
 */
export interface ChatView {
  conversationId: string | null;
  messages: ChatMessage[];
  run: RunActivity | null;
}

export const NEW_CHAT: ChatView = { conversationId: null, messages: [], run: null };

export function openedChat(c: OpenConversation): ChatView {
  return { conversationId: c.id, messages: c.messages, run: c.run };
}

/** Folds one of the chat's agent events into it. */
export function foldChat(v: ChatView, e: AgentEvent): ChatView {
  if (v.run && e.runId === v.run.runId && e.seq !== undefined && e.seq <= v.run.seq) return v;
  const run = foldRunActivity(v.run, e);
  switch (e.type) {
    case 'message.completed':
      return { ...v, run, messages: putMessage(v.messages, e.message) };
    case 'tool.updated':
      return {
        ...v,
        run,
        messages: v.messages.map((m) => (m.id === e.messageId ? { ...m, toolCalls: (m.toolCalls ?? []).map((c) => (c.id === e.call.id ? e.call : c)) } : m)),
      };
    default:
      return run === v.run ? v : { ...v, run };
  }
}

/** The message in its place when the chat has it already, at the end otherwise. */
function putMessage(list: ChatMessage[], m: ChatMessage): ChatMessage[] {
  const at = list.findIndex((x) => x.id === m.id);
  return at < 0 ? [...list, m] : list.map((x, i) => (i === at ? m : x));
}
