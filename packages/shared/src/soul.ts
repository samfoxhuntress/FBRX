/**
 * The AI's soul (soul.md, in FBRX's data folder): who it is, what it cares about, how it talks, the options the person
 * set, the commands they can type (/checkup, /wifi, /gate…), the toolkits it has, and notes on how they like it to work.
 * FBRX ships a default; the person edits it in Settings → Agent → Soul, or asks the AI to (soul.update, which they
 * approve). Markdown with ## sections; commands are list items of the Commands section, grouped by ### headings:
 *
 *   - `/name what` — what the AI does when someone types it
 */

export const SOUL_LIMITS = {
  /** The whole file. */
  file: 32_000,
  /** What of it goes into the AI's instructions on every request (the rest is read when needed). */
  prompt: 6_000,
  /** One change the AI makes. */
  change: 4_000,
  /** Earlier versions kept (soul.history), newest first. */
  history: 20,
} as const;

/** Sections the AI reads with every request; Commands come only when one is typed, Toolkits when it asks. */
export const SOUL_PROMPT_SKIP = ['commands', 'toolkits'];

export interface SoulSection {
  title: string;
  body: string;
}

export interface SoulCommand {
  /** Without the slash: checkup. */
  name: string;
  /** What goes after it, in words (host, a file…), or ''. */
  hint: string;
  /** What the AI does. */
  does: string;
  /** Its ### group in the Commands section (This computer, Network…). */
  group: string;
}

export interface SoulStatus {
  text: string;
  /** Where the file is. */
  path: string;
  /** It is FBRX's default, unchanged. */
  isDefault: boolean;
  commands: SoulCommand[];
  sections: string[];
  updatedAt: string | null;
  /** Earlier versions, newest first. */
  history: Array<{ at: string; by: string }>;
}

/** The ## sections, in order (text before the first one is left out). */
export function soulSections(text: string): SoulSection[] {
  const out: SoulSection[] = [];
  let cur: SoulSection | null = null;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h && !line.startsWith('###')) {
      if (cur) out.push({ ...cur, body: cur.body.trim() });
      cur = { title: h[1]!, body: '' };
    } else if (cur) cur.body += `${line}\n`;
  }
  if (cur) out.push({ ...cur, body: cur.body.trim() });
  return out;
}

const key = (title: string) => title.trim().toLowerCase();

/** The section of that title (any case), or null. */
export function soulSection(text: string, title: string): SoulSection | null {
  return soulSections(text).find((s) => key(s.title) === key(title)) ?? null;
}

const COMMAND_LINE = /^\s*[-*]\s+`\/([a-z][a-z0-9-]{0,30})((?:\s+[^`]*)?)`\s*[—–-]+\s*(.+?)\s*$/;

/** The commands in the Commands section, with their groups. */
export function soulCommands(text: string): SoulCommand[] {
  const s = soulSection(text, 'Commands');
  if (!s) return [];
  const out: SoulCommand[] = [];
  let group = 'Commands';
  for (const line of s.body.split('\n')) {
    const g = /^###\s+(.+?)\s*$/.exec(line);
    if (g) {
      group = g[1]!;
      continue;
    }
    const m = COMMAND_LINE.exec(line);
    if (m && !out.some((c) => c.name === m[1])) out.push({ name: m[1]!, hint: m[2]!.trim(), does: m[3]!, group });
  }
  return out;
}

/** A message that starts with a command (/wifi, /ping 1.1.1.1), not a path (/etc/hosts): its name and the rest. */
export function soulCommandIn(message: string): { name: string; args: string } | null {
  const m = /^\/([a-z][a-z0-9-]{0,30})(?:\s+([\s\S]*))?$/.exec(message.trim());
  return m ? { name: m[1]!, args: (m[2] ?? '').trim() } : null;
}

/** Replaces one section's body (or adds the section at the end, before Notes when there is one). */
export function withSoulSection(text: string, title: string, body: string, mode: 'replace' | 'append'): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^##\s+/.test(l) && !l.startsWith('###') && key(l.replace(/^##\s+/, '')) === key(title));
  if (start < 0) {
    const notes = lines.findIndex((l) => /^##\s+notes\s*$/i.test(l));
    const block = [`## ${title.trim()}`, '', body.trim(), ''];
    if (notes >= 0 && key(title) !== 'notes') lines.splice(notes, 0, ...block);
    else lines.push(...(lines.at(-1)?.trim() ? [''] : []), ...block);
    return lines.join('\n').replace(/\n{3,}/g, '\n\n');
  }
  let end = lines.findIndex((l, i) => i > start && /^##\s+/.test(l) && !l.startsWith('###'));
  if (end < 0) end = lines.length;
  const old = lines.slice(start + 1, end).join('\n').trim();
  const next = mode === 'append' && old ? `${old}\n${body.trim()}` : body.trim();
  lines.splice(start + 1, end - start - 1, '', next, '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}
