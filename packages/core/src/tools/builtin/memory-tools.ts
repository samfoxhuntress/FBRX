import { newId } from '@fbrx/shared';
import type { Db } from '../../storage/db';
import type { ToolSpec } from '../types';

/** Long-term agent memory stored locally (and carried by snapshots). Full-text searchable via FTS5. */
export function memoryTools(db: Db): ToolSpec[] {
  return [
    {
      name: 'memory.remember',
      title: 'Remember',
      description: 'Store a durable note or fact for future conversations (preferences, project facts, decisions).',
      risk: 'write',
      source: 'builtin',
      sourceId: null,
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', minLength: 1, maxLength: 4000 },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['content'],
      },
      async run(i) {
        const id = newId('mem');
        db.run('INSERT INTO memories (id, content, tags, created_at) VALUES (?, ?, ?, ?)', id, i.content, (i.tags ?? []).join(' '), new Date().toISOString());
        return { output: `Remembered (${id})`, data: { id } };
      },
    },
    {
      name: 'memory.recall',
      title: 'Recall',
      description: 'Search long-term memory for notes relevant to a query.',
      risk: 'read',
      source: 'builtin',
      sourceId: null,
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 8 } },
        required: ['query'],
      },
      async run(i) {
        const terms = String(i.query)
          .toLowerCase()
          .match(/[\p{L}\p{N}_]+/gu)
          ?.slice(0, 12);
        let rows: Array<{ id: string; content: string; created_at: string }> = [];
        if (terms?.length) {
          rows = db.all(
            `SELECT m.id, m.content, m.created_at FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
             WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?`,
            terms.map((t) => `"${t}"`).join(' OR '),
            i.limit,
          );
        }
        if (!rows.length) rows = db.all('SELECT id, content, created_at FROM memories ORDER BY created_at DESC LIMIT ?', i.limit);
        return {
          output: rows.length ? rows.map((r) => `- (${r.created_at.slice(0, 10)}) ${r.content}`).join('\n') : 'No memories yet',
          data: rows,
        };
      },
    },
    {
      name: 'memory.forget',
      title: 'Forget',
      description: 'Delete a stored memory by id.',
      risk: 'write',
      source: 'builtin',
      sourceId: null,
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async run(i) {
        const { changes } = db.run('DELETE FROM memories WHERE id = ?', i.id);
        return { output: changes ? 'Forgotten' : 'No memory with that id' };
      },
    },
  ];
}
