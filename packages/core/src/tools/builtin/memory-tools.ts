import { MEMORY_CATEGORIES, MEMORY_CATEGORY_LABEL } from '@fbrx/shared';
import type { MemoryService } from '../../ai/memory';
import type { ToolSpec } from '../types';

/**
 * The AI's memory of the person, kept on this computer (memory.ts): lasting facts and past conversations. Identity and
 * money numbers are never kept; private kinds only when the person allows them (Settings → Memory).
 */
export function memoryTools(memory: MemoryService): ToolSpec[] {
  return [
    {
      name: 'memory.remember',
      title: 'Remember',
      description:
        'Keep a lasting fact about the person for future conversations (their preferences, work, family, where they live, a decision). Never use it for Social Security, license, passport, tax or bank numbers, full card numbers or passwords: FBRX refuses those.',
      risk: 'write',
      source: 'builtin',
      sourceId: null,
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', minLength: 3, maxLength: 1000, description: 'One fact, written about the person: "Prefers short answers", "Works at Fabrics Inc"' },
          category: { type: 'string', enum: [...MEMORY_CATEGORIES] },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['content'],
      },
      async run(i) {
        const m = memory.remember({ content: i.content, category: i.category, tags: i.tags, source: 'agent' });
        return { output: `Remembered (${MEMORY_CATEGORY_LABEL[m.category]}): ${m.content}`, data: { id: m.id } };
      },
    },
    {
      name: 'memory.recall',
      title: 'Recall',
      description: 'Search what you remember about the person (long-term memory).',
      risk: 'read',
      source: 'builtin',
      sourceId: null,
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 8 } }, required: ['query'] },
      async run(i) {
        const rows = memory.recall(i.query, i.limit);
        const list = rows.length ? rows : memory.list().slice(0, i.limit);
        return { output: list.length ? list.map((r) => `- (${r.id}, ${r.createdAt.slice(0, 10)}) ${r.content}`).join('\n') : 'Nothing remembered yet', data: list };
      },
    },
    {
      name: 'memory.search_chats',
      title: 'Search past conversations',
      description: "Find what was said in the person's earlier conversations with you (long-term chat history on this computer), newest first.",
      risk: 'read',
      source: 'builtin',
      sourceId: null,
      inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 3 }, limit: { type: 'integer', minimum: 1, maximum: 30, default: 10 } }, required: ['query'] },
      async run(i) {
        const hits = memory.searchChats(i.query, i.limit);
        return {
          output: hits.length ? hits.map((h) => `- ${h.at.slice(0, 10)} "${h.title}" (${h.role === 'user' ? 'they said' : 'you said'}): ${h.text}`).join('\n') : 'No earlier conversation mentions that',
          data: hits,
        };
      },
    },
    {
      name: 'memory.forget',
      title: 'Forget',
      description: 'Delete something you remember, by its id (from memory.recall).',
      risk: 'write',
      source: 'builtin',
      sourceId: null,
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async run(i) {
        return { output: memory.forget(i.id) ? 'Forgotten' : 'No memory with that id' };
      },
    },
  ];
}
