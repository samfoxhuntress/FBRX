import { MAX_VERSES, type Scripture } from '../../scripture/scripture';
import type { ToolSpec } from '../types';

/** Bible verses word for word, for the agent: a model quotes from here, never from memory (Noah, round two). */
export function scriptureTools(o: { scripture: Scripture }): ToolSpec[] {
  return [
    {
      name: 'scripture.lookup',
      title: 'Look up a Bible verse',
      description: `The exact words of a Bible verse or passage, from verified public-domain texts on this computer: quote the Bible from this, never from memory. Give a reference ("John 3:16", "Psalm 23", "1 Corinthians 13:4-7", "Genesis 1:1-2:3") and, when the person names one, a version: KJV (the default), ASV, WEB, BSB, YLT or Darby; the KJV also has the Apocrypha (Tobit, Sirach, 1 Maccabees…). A book or verse that does not exist gets a plain no. Up to ${MAX_VERSES} verses at a time.`,
      risk: 'read',
      source: 'builtin',
      sourceId: null,
      inputSchema: {
        type: 'object',
        properties: {
          reference: { type: 'string', maxLength: 120, description: 'A book, chapter and verses: "John 3:16", "Psalm 23", "Romans 8:28-39"' },
          version: { type: 'string', maxLength: 40, description: 'KJV (the default), ASV, WEB, BSB, YLT or Darby' },
        },
        required: ['reference'],
      },
      unavailable: () => o.scripture.unavailable(),
      async run(i) {
        return o.scripture.lookup(String(i.reference ?? ''), i.version ? String(i.version) : undefined);
      },
    },
  ];
}
