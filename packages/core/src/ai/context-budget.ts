import type { StoredMessage } from './conversations';

/**
 * How FBRX keeps a conversation within what the agent holds (its context window), and what it tells the agent about
 * where it stands so it can pace itself (the <budget> block, with the person's latest message).
 */

/** About how many characters make a token: a cautious count (English prose is nearer 4, code and other languages fewer). */
export const CHARS_PER_TOKEN = 2.5;

export const tokensFor = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);

/** Of what the agent holds, the part older requests may take once folded into a digest. */
export const DIGEST_SHARE = 0.15;

/** Ids FBRX tools hand out (prj_…, note_…, task_…): kept when older turns are folded, so later steps can still use them. */
const ID = /\b[a-z]{2,10}_[0-9a-z]{8,}\b/g;

const clip = (text: string, max: number) => {
  const t = text
    .replace(/<attachment[^>]*>[\s\S]*?<\/attachment>/g, '[attachment]')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** One older request in a line (what was asked, what came of it, the tools it used), and the ids it made or used. */
function digestTurn(turn: StoredMessage[]): { line: string; ids: string[] } {
  const asked = turn.find((m) => m.role === 'user');
  const answer = turn.filter((m) => m.role === 'assistant' && m.content.trim()).pop();
  const tools = [...new Set(turn.flatMap((m) => m.toolCalls?.map((c) => c.name) ?? []))];
  const ids = [...new Set(turn.flatMap((m) => (m.role === 'tool' || m.role === 'assistant' ? (m.content.match(ID) ?? []) : [])))].slice(0, 8);
  const line = [
    `- Asked: "${clip(asked?.content ?? '', 160)}"`,
    answer ? ` → ${clip(answer.content, 200)}` : ' → (no answer)',
    tools.length ? ` [tools: ${tools.join(', ')}]` : '',
    ids.length ? ` [ids: ${ids.join(', ')}]` : '',
  ].join('');
  return { line, ids };
}

/**
 * Older turns folded into a short digest when the conversation no longer fits: what was asked, what came of it, and the
 * ids it made. No model is asked to summarize (that would spend the very budget being saved, and a small model can lose
 * facts doing it), so nothing in the digest is made up. When even the digest is too long the newest requests stay, and
 * the ids of the ones left out are still listed: an id is what a later step cannot do without.
 */
export function digestTurns(turns: StoredMessage[][], maxChars: number): string {
  const parts = turns.map(digestTurn);
  const head = (left: number) => {
    if (!left) return '';
    const ids = [...new Set(parts.slice(0, left).flatMap((p) => p.ids))].slice(-12);
    return `(${left} older request${left === 1 ? '' : 's'} left out${ids.length ? `; their ids: ${ids.join(', ')}` : ''})\n`;
  };
  const text = (left: number) => `${head(left)}${parts.slice(left).map((p) => p.line).join('\n')}`;
  let left = 0;
  while (left < parts.length - 1 && text(left).length > maxChars) left++;
  return text(left).slice(0, Math.max(0, maxChars));
}

/** What the agent is told about its room, with the person's latest message (once per run, so requests stay cacheable). */
export function budgetNote(b: { windowTokens: number; usedTokens: number; folded: number; maxOutputTokens: number; maxSteps: number; month: { used: number; budget: number } | null }): string {
  const pct = (a: number, of: number) => Math.min(100, Math.round((a / Math.max(1, of)) * 100));
  const lines = [
    `Context window: about ${b.windowTokens.toLocaleString('en-US')} tokens; this conversation fills about ${b.usedTokens.toLocaleString('en-US')} (${pct(b.usedTokens, b.windowTokens)}%).${b.folded ? ` ${b.folded} older request${b.folded === 1 ? ' is' : 's are'} folded into <earlier>.` : ''}`,
    `Longest answer: ${b.maxOutputTokens ? `${b.maxOutputTokens.toLocaleString('en-US')} tokens` : "the model's own limit"}. Steps for this task: up to ${b.maxSteps}.`,
  ];
  if (b.month?.budget) lines.push(`Cloud AI this month on this computer: ${b.month.used.toLocaleString('en-US')} of ${b.month.budget.toLocaleString('en-US')} tokens set aside (${pct(b.month.used, b.month.budget)}%).`);
  return lines.join('\n');
}
