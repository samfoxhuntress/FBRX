import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CORE_PRINCIPLES,
  PERSONALITY_LIMITS,
  PERSONALITY_OPTIONS_INTRO,
  PERSONALITY_PROMPT_SKIP,
  personalityCommandIn,
  personalityCommands,
  personaOf,
  personalityProblems,
  personalityAllowedTitle,
  PERSONALITY_SECTIONS,
  personalitySections,
  withPersonalitySection,
  type PersonalityCommand,
  type PersonaInfo,
  type PersonalityStatus,
} from '@fbrx/shared';
import { CoreError } from '../errors';
import type { EventBus } from '../events';
import type { MetaStore } from '../storage/meta';
import { DEFAULT_PERSONALITY } from './personality-default';
import { PERSONAS, personaList, withPersona } from './personas';

/**
 * The AI's personality (personality.md in FBRX's data folder, see @fbrx/shared personality.ts): its persona. Its sections (who it is, how
 * it talks, the options, the notes) go into the AI's instructions on every request, after FBRX's fixed core principles
 * (CORE_PRINCIPLES, which are not in the file); a command goes with the message it starts; the toolkits are read when asked.
 * personality.md never holds principles or options about approvals, secrets or safety: a change that would is refused, and a
 * file that has them (an older personality.md, or one edited by hand) loses them at start and in what the AI reads. Every
 * change keeps the version before it (personality.history), so a change can be undone. A personality the person never changed
 * follows FBRX's newer default.
 */

const WRITTEN = 'ai.soul.written';
const LOG = 'ai.soul.log';
/** What FBRX took out of personality.md at start, and the history file of the version before, until the person has seen it. */
const NOTICE = 'ai.soul.notice';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

export interface PersonalityStoreOptions {
  file: string;
  meta: MetaStore;
  /** A line for FBRX's log (when personality.md follows a newer default). */
  log?: (msg: string) => void;
  events?: EventBus;
}

export class PersonalityStore {
  constructor(private readonly o: PersonalityStoreOptions) {}

  get path(): string {
    return this.o.file;
  }

  private get historyDir(): string {
    return join(dirname(this.o.file), 'personality.history');
  }

  /** At start: the default on a first run, and FBRX's newer default when the person never changed theirs. */
  ensure(): void {
    this.fromSoul();
    const written = this.o.meta.get<string>(WRITTEN);
    if (!existsSync(this.o.file)) {
      this.write(DEFAULT_PERSONALITY, 'FBRX', false);
      return;
    }
    const now = readFileSync(this.o.file, 'utf8');
    if (written && sha(now) === written && written !== sha(DEFAULT_PERSONALITY)) {
      this.write(DEFAULT_PERSONALITY, 'FBRX (a newer default)', true);
      this.o.log?.('personality.md follows FBRX’s newer default (it had not been changed)');
      return;
    }
    // An older personality.md (up to 2.3.3 it held What I care about and safety options), or one edited by hand: the
    // principles are FBRX's own now, so they leave the file (the version before is kept, and Undo shows it).
    const removed = personalityProblems(now);
    if (removed.length) {
      const before = this.write(personaOf(now), 'FBRX (its core principles are fixed now)', true);
      this.o.meta.set(NOTICE, { at: new Date().toISOString(), removed, file: before });
      this.o.log?.('personality.md: sections about principles and options about approvals or safety left the file; FBRX keeps its core principles itself');
    }
  }

  /**
   * Up to FBRX 2.3.x the file was soul.md, its history soul.history: they move over once. FBRX's own names in a file
   * the person changed (soul.read, soul.update, /soul…) follow, with the version before kept; an unchanged default is
   * left to follow FBRX's newer one.
   */
  private fromSoul(): void {
    const dir = dirname(this.o.file);
    const old = join(dir, 'soul.md');
    if (existsSync(this.o.file) || !existsSync(old)) return;
    const oldHistory = join(dir, 'soul.history');
    if (existsSync(oldHistory) && !existsSync(this.historyDir)) renameSync(oldHistory, this.historyDir);
    renameSync(old, this.o.file);
    const text = readFileSync(this.o.file, 'utf8');
    const renamed = text
      .replace(/\bsoul\.read\b/g, 'personality.read')
      .replace(/\bsoul\.update\b/g, 'personality.update')
      .replace(/\bsoul\.\*/g, 'personality.*')
      .replace(/\bsoul\.md\b/g, 'personality.md')
      .replace(/`\/soul`/g, '`/personality`')
      .replace(/Settings → Soul/g, 'Settings → Personality')
      .replace(/^# Soul$/m, '# Personality');
    if (renamed !== text && this.o.meta.get<string>(WRITTEN) !== sha(text)) this.write(renamed, 'FBRX (soul.md is personality.md now)', true);
    this.o.log?.('soul.md is personality.md now');
  }

  /**
   * The personality as it is now (FBRX's default when the file cannot be read). Read from the file every time: it is small,
   * and a copy kept by its modified time could lag behind a change made within the same tick of the clock.
   */
  read(): string {
    try {
      return readFileSync(this.o.file, 'utf8').slice(0, PERSONALITY_LIMITS.file);
    } catch {
      return DEFAULT_PERSONALITY;
    }
  }

  isDefault(): boolean {
    return sha(this.read()) === sha(DEFAULT_PERSONALITY);
  }

  commands(): PersonalityCommand[] {
    return personalityCommands(this.read());
  }

  status(): PersonalityStatus {
    const text = this.read();
    let updatedAt: string | null = null;
    try {
      updatedAt = statSync(this.o.file).mtime.toISOString();
    } catch {
      /* not written yet */
    }
    return {
      text,
      core: CORE_PRINCIPLES,
      path: this.o.file,
      isDefault: this.isDefault(),
      commands: personalityCommands(text),
      sections: personalitySections(text).map((s) => s.title),
      updatedAt,
      history: (this.o.meta.get<Array<{ at: string; by: string }>>(LOG) ?? []).slice(0, PERSONALITY_LIMITS.history),
      notice: this.noticeNow(),
    };
  }

  private noticeNow(): { at: string; removed: string[] } | null {
    const n = this.o.meta.get<{ at: string; removed: string[]; file: string | null } | null>(NOTICE);
    return n ? { at: n.at, removed: n.removed } : null;
  }

  /** The version from before FBRX took the principles out of personality.md (for the notice in Settings), or null. */
  previous(): string | null {
    const n = this.o.meta.get<{ file: string | null } | null>(NOTICE);
    if (!n?.file) return null;
    try {
      return readFileSync(join(this.historyDir, n.file), 'utf8');
    } catch {
      return null;
    }
  }

  /** The person has seen the notice. */
  dismissNotice(): PersonalityStatus {
    this.o.meta.set(NOTICE, null);
    return this.status();
  }

  /**
   * The persona as the AI reads it on every request: all but the commands and toolkits, and the command names. Never
   * a section about principles or an option it may not set (whatever the file says), and cut to PERSONALITY_LIMITS.prompt:
   * FBRX's core principles (CORE_PRINCIPLES) go to the AI separately, whole, before this.
   */
  prompt(): string | null {
    const text = personaOf(this.read());
    const kept = personalitySections(text).filter((s) => !PERSONALITY_PROMPT_SKIP.includes(s.title.trim().toLowerCase()) && s.body.trim());
    if (!kept.length) return null;
    const names = personalityCommands(text).map((c) => `/${c.name}`);
    // The options come with FBRX's own line ahead of them, not the file's.
    let out = kept.map((s) => `### ${s.title}\n${s.title.trim().toLowerCase() === 'options' ? `${PERSONALITY_OPTIONS_INTRO}\n` : ''}${s.body}`).join('\n\n');
    if (out.length > PERSONALITY_LIMITS.prompt) out = `${out.slice(0, PERSONALITY_LIMITS.prompt)}\n[…the rest of personality.md is longer than the AI reads with every request: personality.read has all of it]`;
    if (names.length) out += `\n\n### Commands\nThe person can start a message with one of these: ${names.join(' ')}. When they do, what it means comes with the message.`;
    return out;
  }

  /** The command a message starts with, as the AI is to read it, and the tools it names; null when it starts with none. */
  command(message: string): { text: string; tools: string[] } | null {
    const typed = personalityCommandIn(message);
    if (!typed) return null;
    const all = this.commands();
    if (!all.length) return null;
    const c = all.find((x) => x.name === typed.name);
    if (!c) {
      const near = all.filter((x) => x.name.startsWith(typed.name.slice(0, 2)) || typed.name.startsWith(x.name.slice(0, 3))).slice(0, 5);
      return {
        text: `The person typed /${typed.name}, which is not one of the commands in personality.md. Say so in one line${near.length ? ` and offer the closest: ${near.map((x) => `/${x.name} (${firstClause(x.does)})`).join(', ')}` : ''}, or /help for the list.`,
        tools: [],
      };
    }
    if (c.name === 'help') {
      const topic = typed.args.toLowerCase();
      const shown = topic ? all.filter((x) => `${x.name} ${x.group} ${x.does}`.toLowerCase().includes(topic)) : all;
      const groups = [...new Set(shown.map((x) => x.group))];
      const list = groups.map((g) => `${g}:\n${shown.filter((x) => x.group === g).map((x) => `/${x.name}${x.hint ? ` ${x.hint}` : ''}: ${firstClause(x.does)}`).join('\n')}`).join('\n\n');
      return { text: `The person typed /help${topic ? ` ${typed.args}` : ''}. Show them these commands from personality.md as they are, grouped, one line each${topic && !shown.length ? ' (none matched: say so, and show the group names)' : ''}:\n\n${list || groups.join(', ')}`, tools: [] };
    }
    const tools = [...new Set(c.does.match(/\b[a-z_]+\.[a-z_*]+\b/g) ?? [])].filter((t) => !t.endsWith('*'));
    return {
      text: `The person typed the command /${c.name}${typed.args ? ` with: ${typed.args}` : ''}. From personality.md, it means: ${c.does}${c.hint && !typed.args ? ` (It takes ${c.hint}; when that is needed and missing, ask for it in one short question.)` : ''}`,
      tools,
    };
  }

  /** Changes one section (the AI's personality.update, approved by the person). */
  update(p: { section: string; content: string; mode: 'replace' | 'append' }, by: string): PersonalityStatus {
    const title = p.section.trim().replace(/^#+\s*/, '');
    if (!title || title.length > 60 || /[\r\n]/.test(title)) throw new CoreError('INVALID_ARGUMENT', 'Name the section to change, like Options or Notes');
    if (!personalityAllowedTitle(title)) throw new CoreError('FORBIDDEN', `FBRX's core principles are fixed, and personality.md holds only these sections: ${PERSONALITY_SECTIONS.join(', ')} (not "${title}")`);
    const content = p.content.trim();
    if (!content) throw new CoreError('INVALID_ARGUMENT', 'Say what the section should hold');
    if (content.length > PERSONALITY_LIMITS.change) throw new CoreError('INVALID_ARGUMENT', `One change holds ${PERSONALITY_LIMITS.change} characters at most`);
    if (/^#\s/m.test(content) || /^##\s/m.test(content)) throw new CoreError('INVALID_ARGUMENT', 'A section cannot hold other sections (# or ## headings); change one section at a time');
    const next = withPersonalitySection(personaOf(this.read()), title, content, p.mode);
    const problems = personalityProblems(next);
    if (problems.length) throw new CoreError('FORBIDDEN', `FBRX's core principles are fixed, so personality.md cannot hold ${problems.join('; ')}`);
    this.set(next, by);
    return this.status();
  }

  /** Replaces the whole personality (Settings → Personality). */
  set(text: string, by: string): PersonalityStatus {
    const t = text.replace(/\r\n/g, '\n').trim();
    if (!t) throw new CoreError('INVALID_ARGUMENT', 'The personality cannot be empty: reset it to FBRX’s default instead');
    if (t.length > PERSONALITY_LIMITS.file) throw new CoreError('INVALID_ARGUMENT', `personality.md holds ${PERSONALITY_LIMITS.file.toLocaleString('en-US')} characters at most`);
    const problems = personalityProblems(t);
    if (problems.length) throw new CoreError('FORBIDDEN', `FBRX's core principles are fixed, so personality.md cannot hold ${problems.join('; ')}`);
    this.write(`${t}\n`, by, true);
    return this.status();
  }

  /**
   * A ready-made persona in place of Who I am, How I talk and the option values it sets; the commands, toolkits, notes
   * and other options stay. The everyday persona on an unchanged default leaves it as it is (it is the default).
   */
  usePersona(id: string, by: string): PersonalityStatus {
    const p = PERSONAS.find((x) => x.id === id);
    if (!p) throw new CoreError('NOT_FOUND', `There is no persona "${id}"`);
    const now = personaOf(this.read());
    if (p.id === 'everyday' && sha(this.read()) === sha(DEFAULT_PERSONALITY)) return this.status();
    return this.set(withPersona(now, p), by);
  }

  personas(): PersonaInfo[] {
    return personaList(this.read());
  }

  /** Back to FBRX's default (the one before is kept). */
  reset(by: string): PersonalityStatus {
    this.write(DEFAULT_PERSONALITY, by, true);
    return this.status();
  }

  /**
   * The version before the last change, back in place. The one it replaces goes into the history in its turn, so an
   * undo can be undone.
   */
  undo(by: string): PersonalityStatus {
    const prev = this.historyFiles()[0];
    if (!prev) throw new CoreError('NOT_FOUND', 'There is no earlier version of personality.md to go back to');
    // An older version may hold what personality.md no longer does (principles, safety options): it comes back without them.
    const text = personaOf(readFileSync(join(this.historyDir, prev), 'utf8'));
    rmSync(join(this.historyDir, prev), { force: true });
    this.write(text, by, true);
    return this.status();
  }

  private historyFiles(): string[] {
    try {
      return readdirSync(this.historyDir).filter((f) => f.endsWith('.md')).sort().reverse();
    } catch {
      return [];
    }
  }

  /** Writes personality.md; with keepOld, the version before goes into the history first (its file name is returned). */
  private write(text: string, by: string, keepOld: boolean): string | null {
    mkdirSync(dirname(this.o.file), { recursive: true });
    let kept: string | null = null;
    if (keepOld && existsSync(this.o.file)) {
      mkdirSync(this.historyDir, { recursive: true });
      // A later name than any kept so far, so the newest is always first (two writes can share a millisecond).
      let name = `${stamp()}.md`;
      const newest = this.historyFiles()[0];
      if (newest && name <= newest) name = `${newest.slice(0, -3)}~.md`;
      writeFileSync(join(this.historyDir, name), readFileSync(this.o.file, 'utf8'));
      kept = name;
      for (const old of this.historyFiles().slice(PERSONALITY_LIMITS.history)) rmSync(join(this.historyDir, old), { force: true });
    }
    writeFileSync(this.o.file, text);
    // Written from FBRX's default: followed when FBRX's default changes, until the person changes it.
    this.o.meta.set(WRITTEN, text === DEFAULT_PERSONALITY ? sha(text) : '');
    const log = this.o.meta.get<Array<{ at: string; by: string }>>(LOG) ?? [];
    this.o.meta.set(LOG, [{ at: new Date().toISOString(), by }, ...log].slice(0, PERSONALITY_LIMITS.history));
    this.o.events?.emit('personality.changed', { isDefault: text === DEFAULT_PERSONALITY });
    return kept;
  }
}

/** The start of a command's description, up to its first colon or full stop (for lists). */
function firstClause(does: string): string {
  const cut = does.search(/[:.](\s|$)/);
  return (cut > 0 ? does.slice(0, cut) : does).trim();
}

export { DEFAULT_PERSONALITY };

/** @deprecated Through 2.4.x: the personality's name up to 2.3.x. */
export { PersonalityStore as SoulStore };
