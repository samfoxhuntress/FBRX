import { newId, type ChatMessage, type Conversation, type ConversationSummary, type InvocationOrigin, type ToolCallRecord } from '@fbrx/shared';
import { CoreError } from '../errors';
import type { Db } from '../storage/db';
import type { ProviderData } from './providers/types';

interface ConvRow {
  id: string;
  title: string;
  provider_id: string | null;
  model: string | null;
  origin: InvocationOrigin;
  created_at: string;
  updated_at: string;
  message_count?: number;
}

interface MsgRow {
  id: string;
  conversation_id: string;
  seq: number;
  role: ChatMessage['role'];
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  provider_id: string | null;
  model: string | null;
  provider_data: string | null;
  created_at: string;
}

export interface StoredMessage extends ChatMessage {
  providerData: ProviderData | null;
}

export class ConversationStore {
  constructor(private readonly db: Db) {}

  create(title: string, origin: InvocationOrigin): ConversationSummary {
    const id = newId('conv');
    const now = new Date().toISOString();
    this.db.run(
      'INSERT INTO conversations (id, title, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      id,
      title.slice(0, 120) || 'New conversation',
      origin,
      now,
      now,
    );
    return this.summary(id);
  }

  exists(id: string): boolean {
    return !!this.db.get('SELECT 1 FROM conversations WHERE id = ?', id);
  }

  summary(id: string): ConversationSummary {
    const row = this.db.get<ConvRow>(
      'SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role IN (\'user\',\'assistant\')) AS message_count FROM conversations c WHERE c.id = ?',
      id,
    );
    if (!row) throw new CoreError('NOT_FOUND', `Conversation ${id} not found`);
    return toSummary(row);
  }

  list(limit = 200): ConversationSummary[] {
    return this.db
      .all<ConvRow>(
        `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role IN ('user','assistant')) AS message_count
         FROM conversations c ORDER BY c.updated_at DESC LIMIT ?`,
        limit,
      )
      .map(toSummary);
  }

  get(id: string): Conversation {
    const summary = this.summary(id);
    return { ...summary, messages: this.messages(id).map(({ providerData: _p, ...m }) => m) };
  }

  messages(conversationId: string): StoredMessage[] {
    return this.db.all<MsgRow>('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq', conversationId).map(toMessage);
  }

  append(conversationId: string, msg: Omit<ChatMessage, 'id' | 'createdAt'> & { providerData?: ProviderData | null; id?: string }): StoredMessage {
    const id = msg.id ?? newId('msg');
    const now = new Date().toISOString();
    this.db.tx(() => {
      const seq = Number(this.db.get<{ s: number }>('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM messages WHERE conversation_id = ?', conversationId)?.s ?? 1);
      this.db.run(
        `INSERT INTO messages (id, conversation_id, seq, role, content, tool_calls, tool_call_id, tool_name, provider_id, model, provider_data, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        conversationId,
        seq,
        msg.role,
        msg.content,
        msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
        msg.toolCallId ?? null,
        msg.toolName ?? null,
        msg.providerId ?? null,
        msg.model ?? null,
        msg.providerData ? JSON.stringify(msg.providerData) : null,
        now,
      );
      this.db.run(
        'UPDATE conversations SET updated_at = ?, provider_id = COALESCE(?, provider_id), model = COALESCE(?, model) WHERE id = ?',
        now,
        msg.providerId ?? null,
        msg.model ?? null,
        conversationId,
      );
    });
    return { ...msg, id, createdAt: now, providerData: msg.providerData ?? null } as StoredMessage;
  }

  /** Updates the UI-facing tool call records (status/output). Provider replay data is never edited. */
  updateToolCalls(messageId: string, calls: ToolCallRecord[]): void {
    this.db.run('UPDATE messages SET tool_calls = ? WHERE id = ?', JSON.stringify(calls), messageId);
  }

  rename(id: string, title: string): ConversationSummary {
    const t = title.trim().slice(0, 120);
    if (!t) throw new CoreError('INVALID_ARGUMENT', 'Title cannot be empty');
    const { changes } = this.db.run('UPDATE conversations SET title = ? WHERE id = ?', t, id);
    if (!changes) throw new CoreError('NOT_FOUND', `Conversation ${id} not found`);
    return this.summary(id);
  }

  delete(id: string): boolean {
    return this.db.run('DELETE FROM conversations WHERE id = ?', id).changes > 0;
  }
}

function toSummary(r: ConvRow): ConversationSummary {
  return {
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: Number(r.message_count ?? 0),
    providerId: r.provider_id,
    model: r.model,
    origin: r.origin,
  };
}

function toMessage(r: MsgRow): StoredMessage {
  return {
    id: r.id,
    role: r.role,
    content: r.content,
    toolCalls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined,
    toolCallId: r.tool_call_id ?? undefined,
    toolName: r.tool_name ?? undefined,
    providerId: r.provider_id ?? undefined,
    model: r.model ?? undefined,
    createdAt: r.created_at,
    providerData: r.provider_data ? JSON.parse(r.provider_data) : null,
  };
}
