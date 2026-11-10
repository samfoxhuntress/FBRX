import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  SOUL_CORE,
  SOUL_LIMITS,
  SOUL_PROMPT_SKIP,
  SOUL_RESERVED,
  soulCommandIn,
  soulCommands,
  soulPersona,
  soulProblems,
  soulSections,
  withSoulSection,
  type SoulCommand,
  type SoulStatus,
} from '@fbrx/shared';
import { CoreError } from '../errors';
import type { EventBus } from '../events';
import type { MetaStore } from '../storage/meta';
import { DEFAULT_SOUL } from './soul-default';

/**
 * The AI's soul (soul.md in FBRX's data folder, see @fbrx/shared soul.ts): its persona. Its sections (who it is, how
 * it talks, the options, the notes) go into the AI's instructions on every request, after FBRX's fixed core principles
 * (SOUL_CORE, which are not in the file); a command goes with the message it starts; the toolkits are read when asked.
 * soul.md never holds principles or options about approvals, secrets or safety: a change that would is refused, and a
 * file that has them (an older soul.md, or one edited by hand) loses them at start and in what the AI reads. Every
 * change keeps the version before it (soul.history), so a change can be undone. A soul the person never changed
 * follows FBRX's newer default.
 */

const WRITTEN = 'ai.soul.written';
const LOG = 'ai.soul.log';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

export interface SoulStoreOptions {
  file: string;
  meta: MetaStore;
  /** A line for FBRX's log (when soul.md follows a newer default). */
  log?: (msg: string) => void;
  events?: EventBus;
}

export class SoulStore {
  private cache: { mtime: number; text: string } | null = null;

  constructor(private readonly o: SoulStoreOptions) {}

  get path(): string {
    return this.o.file;
  }

  private get historyDir(): string {
    return join(dirname(this.o.file), 'soul.history');
  }

  /** At start: the default on a first run, and FBRX's newer default when the person never changed theirs. */
  ensure(): void {
    const written = this.o.meta.get<string>(WRITTEN);
    if (!existsSync(this.o.file)) {
      this.write(DEFAULT_SOUL, 'FBRX', false);
      return;
    }
    const now = readFileSync(this.o.file, 'utf8');
    if (written && sha(now) === written && written !== sha(DEFAULT_SOUL)) {
      this.write(DEFAULT_SOUL, 'FBRX (a newer default)', true);
      this.o.log?.('soul.md follows FBRX’s newer default (it had not been changed)');
      return;
    }
    // An older soul.md (up to 2.3.3 it held What I care about and safety options), or one edited by hand: the
    // principles are FBRX's own now, so they leave the file (the version before is kept, and Undo shows it).
    if (soulProblems(now).length) {
      this.write(soulPersona(now), 'FBRX (its core principles are fixed now)', true);
      this.o.log?.('soul.md: sections about principles and options about approvals or safety left the file; FBRX keeps its core principles itself');
    }
  }

  /** The soul as it is now (FBRX's default when the file cannot be read). */
  read(): string {
    try {
      const st = statSync(this.o.file);
      if (this.cache && this.cache.mtime === st.mtimeMs) return this.cache.text;
      const text = readFileSync(this.o.file, 'utf8').slice(0, SOUL_LIMITS.file);
      this.cache = { mtime: st.mtimeMs, text };
      return text;
    } catch {
      return DEFAULT_SOUL;
    }
  }

  isDefault(): boolean {
    return sha(this.read()) === sha(DEFAULT_SOUL);
  }

  commands(): SoulCommand[] {
    return soulCommands(this.read());
  }

  status(): SoulStatus {
    const text = this.read();
    let updatedAt: string | null = null;
    try {
      updatedAt = statSync(this.o.file).mtime.toISOString();
    } catch {
      /* not written yet */
    }
    return {
      text,
      core: SOUL_CORE,
      path: this.o.file,
      isDefault: this.isDefault(),
      commands: soulCommands(text),
      sections: soulSections(text).map((s) => s.title),
      updatedAt,
      history: (this.o.meta.get<Array<{ at: string; by: string }>>(LOG) ?? []).slice(0, SOUL_LIMITS.history),
    };
  }

  /**
   * The persona as the AI reads it on every request: all but the commands and toolkits, and the command names. Never
   * a section about principles or an option it may not set (whatever the file says), and cut to SOUL_LIMITS.prompt:
   * FBRX's core principles (SOUL_CORE) go to the AI separately, whole, before this.
   */
  prompt(): string | null {
    const text = soulPersona(this.read());
    const kept = soulSections(text).filter((s) => !SOUL_PROMPT_SKIP.includes(s.title.trim().toLowerCase()) && s.body.trim());
    if (!kept.length) return null;
    const names = soulCommands(text).map((c) => `/${c.name}`);
    let out = kept.map((s) => `### ${s.title}\n${s.body}`).join('\n\n');
    if (out.length > SOUL_LIMITS.prompt) out = `${out.slice(0, SOUL_LIMITS.prompt)}\n[…the rest of soul.md is longer than the AI reads with every request: soul.read has all of it]`;
    if (names.length) out += `\n\n### Commands\nThe person can start a message with one of these: ${names.join(' ')}. When they do, what it means comes with the message.`;
    return out;
  }

  /** The command a message starts with, as the AI is to read it, and the tools it names; null when it starts with none. */
  command(message: string): { text: string; tools: string[] } | null {
    const typed = soulCommandIn(message);
    if (!typed) return null;
    const all = this.commands();
    if (!all.length) return null;
    const c = all.find((x) => x.name === typed.name);
    if (!c) {
      const near = all.filter((x) => x.name.startsWith(typed.name.slice(0, 2)) || typed.name.startsWith(x.name.slice(0, 3))).slice(0, 5);
      return {
        text: `The person typed /${typed.name}, which is not one of the commands in soul.md. Say so in one line${near.length ? ` and offer the closest: ${near.map((x) => `/${x.name} (${firstClause(x.does)})`).join(', ')}` : ''}, or /help for the list.`,
        tools: [],
      };
    }
    if (c.name === 'help') {
      const topic = typed.args.toLowerCase();
      const shown = topic ? all.filter((x) => `${x.name} ${x.group} ${x.does}`.toLowerCase().includes(topic)) : all;
      const groups = [...new Set(shown.map((x) => x.group))];
      const list = groups.map((g) => `${g}:\n${shown.filter((x) => x.group === g).map((x) => `/${x.name}${x.hint ? ` ${x.hint}` : ''}: ${firstClause(x.does)}`).join('\n')}`).join('\n\n');
      return { text: `The person typed /help${topic ? ` ${typed.args}` : ''}. Show them these commands from soul.md as they are, grouped, one line each${topic && !shown.length ? ' (none matched: say so, and show the group names)' : ''}:\n\n${list || groups.join(', ')}`, tools: [] };
    }
    const tools = [...new Set(c.does.match(/\b[a-z_]+\.[a-z_*]+\b/g) ?? [])].filter((t) => !t.endsWith('*'));
    return {
      text: `The person typed the command /${c.name}${typed.args ? ` with: ${typed.args}` : ''}. From soul.md, it means: ${c.does}${c.hint && !typed.args ? ` (It takes ${c.hint}; when that is needed and missing, ask for it in one short question.)` : ''}`,
      tools,
    };
  }

  /** Changes one section (the AI's soul.update, approved by the person). */
  update(p: { section: string; content: string; mode: 'replace' | 'append' }, by: string): SoulStatus {
    const title = p.section.trim().replace(/^#+\s*/, '');
    if (!title || title.length > 60 || /[\r\n]/.test(title)) throw new CoreError('INVALID_ARGUMENT', 'Name the section to change, like Options or Notes');
    if (SOUL_RESERVED.test(title)) throw new CoreError('FORBIDDEN', `FBRX's core principles are fixed: soul.md has no "${title}" section, and no change can add one`);
    const content = p.content.trim();
    if (!content) throw new CoreError('INVALID_ARGUMENT', 'Say what the section should hold');
    if (content.length > SOUL_LIMITS.change) throw new CoreError('INVALID_ARGUMENT', `One change holds ${SOUL_LIMITS.change} characters at most`);
    if (/^#\s/m.test(content) || /^##\s/m.test(content)) throw new CoreError('INVALID_ARGUMENT', 'A section cannot hold other sections (# or ## headings); change one section at a time');
    const next = withSoulSection(soulPersona(this.read()), title, content, p.mode);
    const problems = soulProblems(next);
    if (problems.length) throw new CoreError('FORBIDDEN', `FBRX's core principles are fixed, so soul.md cannot hold ${problems.join('; ')}`);
    this.set(next, by);
    return this.status();
  }

  /** Replaces the whole soul (Settings → Soul). */
  set(text: string, by: string): SoulStatus {
    const t = text.replace(/\r\n/g, '\n').trim();
    if (!t) throw new CoreError('INVALID_ARGUMENT', 'The soul cannot be empty: reset it to FBRX’s default instead');
    if (t.length > SOUL_LIMITS.file) throw new CoreError('INVALID_ARGUMENT', `soul.md holds ${SOUL_LIMITS.file.toLocaleString('en-US')} characters at most`);
    const problems = soulProblems(t);
    if (problems.length) throw new CoreError('FORBIDDEN', `FBRX's core principles are fixed, so soul.md cannot hold ${problems.join('; ')}`);
    this.write(`${t}\n`, by, true);
    return this.status();
  }

  /** Back to FBRX's default (the one before is kept). */
  reset(by: string): SoulStatus {
    this.write(DEFAULT_SOUL, by, true);
    return this.status();
  }

  /** The version before the last change, back in place (that one is kept too). */
  undo(by: string): SoulStatus {
    const prev = this.historyFiles()[0];
    if (!prev) throw new CoreError('NOT_FOUND', 'There is no earlier version of soul.md to go back to');
    // An older version may hold what soul.md no longer does (principles, safety options): it comes back without them.
    const text = soulPersona(readFileSync(join(this.historyDir, prev), 'utf8'));
    rmSync(join(this.historyDir, prev), { force: true });
    this.write(text, by, false);
    return this.status();
  }

  private historyFiles(): string[] {
    try {
      return readdirSync(this.historyDir).filter((f) => f.endsWith('.md')).sort().reverse();
    } catch {
      return [];
    }
  }

  private write(text: string, by: string, keepOld: boolean): void {
    mkdirSync(dirname(this.o.file), { recursive: true });
    if (keepOld && existsSync(this.o.file)) {
      mkdirSync(this.historyDir, { recursive: true });
      writeFileSync(join(this.historyDir, `${stamp()}.md`), readFileSync(this.o.file, 'utf8'));
      for (const old of this.historyFiles().slice(SOUL_LIMITS.history)) rmSync(join(this.historyDir, old), { force: true });
    }
    writeFileSync(this.o.file, text);
    this.cache = null;
    // Written from FBRX's default: followed when FBRX's default changes, until the person changes it.
    this.o.meta.set(WRITTEN, text === DEFAULT_SOUL ? sha(text) : '');
    const log = this.o.meta.get<Array<{ at: string; by: string }>>(LOG) ?? [];
    this.o.meta.set(LOG, [{ at: new Date().toISOString(), by }, ...log].slice(0, SOUL_LIMITS.history));
    this.o.events?.emit('soul.changed', { isDefault: text === DEFAULT_SOUL });
  }
}

/** The start of a command's description, up to its first colon or full stop (for lists). */
function firstClause(does: string): string {
  const cut = does.search(/[:.](\s|$)/);
  return (cut > 0 ? does.slice(0, cut) : does).trim();
}

export { DEFAULT_SOUL };
