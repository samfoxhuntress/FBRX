import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { load } from 'js-yaml';
import { SKILL_LIMITS, type AgentSetupPreview } from '@fbrx/shared';

/**
 * Taking over an AI agent's setup on this computer: Hermes Agent's ~/.hermes (or one of its profiles). Its persona
 * (SOUL.md), what it remembers (memories/MEMORY.md) and knows about the person (memories/USER.md), its skills
 * (skills/…/SKILL.md) and its MCP servers (config.yaml) come into FBRX OS, each through FBRX's own checks. Its keys
 * (.env), sessions and scheduled jobs stay where they are. Nothing here writes to Hermes.
 */

const MAX_FILE = 256 * 1024;
const MAX_SKILLS = 200;
const MAX_ENTRIES = 300;

/** One of Hermes' MCP servers, as FBRX keeps a connector: secret values come apart, to go into the vault. */
export interface ImportedServer {
  name: string;
  type: 'mcp-stdio' | 'mcp-http';
  config: Record<string, unknown>;
  /** Env vars or headers whose values go into the vault: where they sit in the config, and the value. */
  secrets: Array<{ where: 'env' | 'headers'; key: string; value: string }>;
}

export interface AgentSetup {
  app: 'hermes';
  folder: string;
  profiles: string[];
  profile: string;
  personality: string | null;
  memories: string[];
  aboutYou: string[];
  skills: Array<{ name: string; when: string; steps: string[]; cut: boolean }>;
  servers: ImportedServer[];
  stays: string[];
}

const read = (f: string): string | null => {
  try {
    return statSync(f).size <= MAX_FILE ? readFileSync(f, 'utf8') : null;
  } catch {
    return null;
  }
};

/** Hermes' home: HERMES_HOME, else ~/.hermes. */
export function hermesHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.HERMES_HOME?.trim() || join(home, '.hermes');
}

/**
 * The entries of a memory file. Hermes separates entries with a line holding only §; a file written by hand may use
 * bullets or paragraphs instead. Headings are left out.
 */
export function memoryEntries(text: string | null): string[] {
  if (!text?.trim()) return [];
  const t = text.replace(/\r\n/g, '\n');
  let parts: string[];
  if (/^\s*§\s*$/m.test(t)) parts = t.split(/^\s*§\s*$/m);
  else if (/^\s*[-*]\s+\S/m.test(t)) parts = t.split('\n').filter((l) => /^\s*[-*]\s+\S/.test(l)).map((l) => l.replace(/^\s*[-*]\s+/, ''));
  else parts = t.split(/\n\s*\n/);
  return parts
    .map((p) =>
      p
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((p) => p.length >= 3)
    .slice(0, MAX_ENTRIES);
}

/** A SKILL.md (front matter with name and description, then instructions) as an FBRX skill: a name, when, steps. */
export function skillOf(text: string, folder: string): AgentSetup['skills'][number] | null {
  const t = text.replace(/\r\n/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(t);
  let meta: Record<string, unknown> = {};
  if (fm) {
    try {
      const m = load(fm[1]!);
      if (m && typeof m === 'object' && !Array.isArray(m)) meta = m as Record<string, unknown>;
    } catch {
      /* not YAML: the folder's name and the text are enough */
    }
  }
  const body = fm ? t.slice(fm[0].length) : t;
  const name = (typeof meta.name === 'string' && meta.name.trim()) || folder;
  const description = typeof meta.description === 'string' ? meta.description.replace(/\s+/g, ' ').trim() : '';
  // The steps: its numbered or bulleted lines when it has a few, else its paragraphs (headings left out).
  const items = body
    .split('\n')
    .filter((l) => /^\s*(\d+[.)]|[-*])\s+\S/.test(l))
    .map((l) => l.replace(/^\s*(\d+[.)]|[-*])\s+/, '').trim());
  const all = (items.length >= 2 ? items : body.split(/\n\s*\n/).map((p) => p.replace(/^#+\s.*$/gm, '').replace(/\s+/g, ' ').trim())).filter(Boolean);
  if (!all.length) return null;
  const steps = all.slice(0, SKILL_LIMITS.steps).map((s) => s.slice(0, SKILL_LIMITS.step));
  const cut = all.length > SKILL_LIMITS.steps || all.some((s) => s.length > SKILL_LIMITS.step) || name.length > SKILL_LIMITS.name || description.length > SKILL_LIMITS.when;
  return { name: name.slice(0, SKILL_LIMITS.name), when: (description || `When ${name} is asked for`).slice(0, SKILL_LIMITS.when), steps, cut };
}

/** The SKILL.md files under a skills folder (skills/<category>/<name>/SKILL.md, or skills/<name>/SKILL.md). */
function skillFiles(dir: string, depth = 0): string[] {
  if (depth > 3) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  if (names.includes('SKILL.md')) return [join(dir, 'SKILL.md')];
  return names.filter((n) => !n.startsWith('.')).flatMap((n) => skillFiles(join(dir, n), depth + 1));
}

/** A name a vault secret can have: HERMES_<SERVER>_<KEY>. */
export function secretName(server: string, key: string): string {
  return `HERMES_${server}_${key}`.replace(/[^A-Za-z0-9._-]+/g, '_').toUpperCase().slice(0, 128);
}

/**
 * Hermes' MCP servers (config.yaml → mcp_servers) as FBRX connectors. FBRX's own entry (fbrx) is left out, and so is
 * anything that is neither a command nor a web address.
 */
export function serversOf(yaml: string | null): { servers: ImportedServer[]; skipped: string[] } {
  if (!yaml?.trim()) return { servers: [], skipped: [] };
  let doc: unknown;
  try {
    doc = load(yaml);
  } catch {
    return { servers: [], skipped: ['config.yaml could not be read (it is not valid YAML)'] };
  }
  const block = doc && typeof doc === 'object' ? (doc as Record<string, unknown>).mcp_servers : null;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return { servers: [], skipped: [] };
  const servers: ImportedServer[] = [];
  const skipped: string[] = [];
  const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : null);
  const map = (v: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) if (text(x) !== null) out[k] = text(x)!;
    return out;
  };
  for (const [name, raw] of Object.entries(block as Record<string, unknown>).slice(0, 50)) {
    if (name === 'fbrx') continue;
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    if (s.enabled === false) {
      skipped.push(`${name} (turned off in Hermes)`);
      continue;
    }
    const secrets: ImportedServer['secrets'] = [];
    if (typeof s.command === 'string' && s.command.trim()) {
      const env = map(s.env);
      for (const [k, v] of Object.entries(env)) if (v) secrets.push({ where: 'env', key: k, value: v });
      const args = Array.isArray(s.args) ? s.args.map(text).filter((a): a is string => a !== null) : [];
      servers.push({ name, type: 'mcp-stdio', config: { command: s.command.trim(), args, ...(typeof s.cwd === 'string' ? { cwd: s.cwd } : {}) }, secrets });
    } else if (typeof s.url === 'string' && /^https?:\/\//i.test(s.url.trim())) {
      for (const [k, v] of Object.entries(map(s.headers))) if (v) secrets.push({ where: 'headers', key: k, value: v });
      servers.push({ name, type: 'mcp-http', config: { url: s.url.trim() }, secrets });
    } else skipped.push(`${name} (neither a command nor a web address)`);
  }
  return { servers, skipped };
}

/** SOUL.md as the Personality's Who I am: its # and ## headings become bold lines (a section holds no sections). */
export function personalityOf(soul: string | null): string | null {
  const t = soul?.replace(/\r\n/g, '\n').trim();
  if (!t) return null;
  return t.replace(/^#{1,2}\s+(.+?)\s*#*\s*$/gm, '**$1**');
}

/** The profiles Hermes keeps besides its default one (~/.hermes/profiles/<name>). */
export function hermesProfiles(home: string): string[] {
  try {
    return readdirSync(join(home, 'profiles'))
      .filter((n) => /^[A-Za-z0-9._-]{1,64}$/.test(n) && statSync(join(home, 'profiles', n)).isDirectory())
      .sort();
  } catch {
    return [];
  }
}

/** Hermes' setup on this computer (its default profile, or a named one), or null when Hermes has none here. */
export function readHermes(home: string, profile = 'default'): AgentSetup | null {
  const profiles = hermesProfiles(home);
  if (profile !== 'default' && !profiles.includes(profile)) return null;
  const dir = profile === 'default' ? home : join(home, 'profiles', profile);
  if (!existsSync(dir)) return null;
  const soul = read(join(dir, 'SOUL.md')) ?? read(join(dir, 'soul.md'));
  const skills = skillFiles(join(dir, 'skills'))
    .slice(0, MAX_SKILLS)
    .map((f) => skillOf(read(f) ?? '', basename(join(f, '..'))))
    .filter((s): s is NonNullable<typeof s> => !!s);
  const { servers, skipped } = serversOf(read(join(dir, 'config.yaml')));
  const setup: AgentSetup = {
    app: 'hermes',
    folder: dir,
    profiles: ['default', ...profiles],
    profile,
    personality: personalityOf(soul),
    memories: memoryEntries(read(join(dir, 'memories', 'MEMORY.md'))),
    aboutYou: memoryEntries(read(join(dir, 'memories', 'USER.md'))),
    skills,
    servers,
    stays: [
      ...(existsSync(join(dir, '.env')) ? ['Its keys (.env): add the ones FBRX needs in AI models'] : []),
      ...(existsSync(join(dir, 'sessions')) || existsSync(join(dir, 'state.db')) ? ['Its past conversations'] : []),
      ...(existsSync(join(dir, 'cron')) ? ['Its scheduled jobs: make them again as FBRX automations'] : []),
      ...skipped.map((s) => `MCP server ${s}`),
    ],
  };
  const empty = !setup.personality && !setup.memories.length && !setup.aboutYou.length && !setup.skills.length && !setup.servers.length;
  return empty && !existsSync(join(dir, 'config.yaml')) ? null : setup;
}

/** What the person sees before choosing: never a secret's value, only that the server has one. */
export function previewOf(s: AgentSetup): AgentSetupPreview {
  return {
    app: s.app,
    name: s.profile === 'default' ? 'Hermes Agent' : `Hermes Agent (${s.profile})`,
    folder: s.folder,
    profiles: s.profiles,
    profile: s.profile,
    personality: s.personality ? { chars: s.personality.length, start: s.personality.slice(0, 280) } : null,
    memories: s.memories,
    aboutYou: s.aboutYou,
    skills: s.skills.map((k) => ({ name: k.name, when: k.when, steps: k.steps.length, cut: k.cut })),
    servers: s.servers.map((v) => ({ name: v.name, kind: v.type === 'mcp-stdio' ? 'command' : 'web', what: v.type === 'mcp-stdio' ? [String(v.config.command), ...((v.config.args as string[]) ?? [])].join(' ').slice(0, 160) : String(v.config.url), secrets: v.secrets.map((x) => x.key) })),
    stays: s.stays,
  };
}
