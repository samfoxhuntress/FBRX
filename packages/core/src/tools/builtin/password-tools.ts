import { GENERATOR_DEFAULTS, GENERATOR_LENGTH, PASSWORD_OLD_DAYS, STRENGTH_WORDS, displayHost, generatePassword, loginMatch, siteOf, type LoginSummary } from '@fbrx/shared';
import type { Passwords } from '../../vault/passwords';
import type { ToolSpec } from '../types';

/** What the Save to Vault window opens with when the agent offers it. */
export interface SaveDraft {
  title: string;
  url: string;
  username: string;
}

const DAY = 86_400_000;
const isOld = (l: LoginSummary) => Date.now() - Date.parse(l.passwordChangedAt) > PASSWORD_OLD_DAYS * DAY;

function describe(l: LoginSummary): string {
  const site = l.urls[0] ? ` (${displayHost(l.urls[0])})` : '';
  const notes = [`${STRENGTH_WORDS[l.strength].toLowerCase()} password`, l.reused && 'the same password as another sign-in', isOld(l) && 'not changed in over a year', l.hasTotp && '2-step code kept'];
  return `- ${l.title}${site}: ${notes.filter(Boolean).join(', ')}`;
}

/**
 * The Vault's password keeper, for the agent. It never sees a username or a password: it finds sign-ins by name and
 * site and checks their health, opens the Save to Vault window for the person to type a password, and saves a sign-in
 * with a new strong password FBRX makes (once the person agrees).
 */
export function passwordTools(o: { passwords: Passwords; offerSave: (d: SaveDraft) => void }): ToolSpec[] {
  return [
    {
      name: 'passwords.find',
      title: 'Find sign-ins',
      description:
        "Look through the person's saved sign-ins in the Vault by name or site, or check their health (weak, reused or old passwords). Shows names, sites and health only, never usernames or passwords: the person sees those in the Vault, and FBRX Browser fills them in.",
      risk: 'read',
      source: 'builtin',
      sourceId: null,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 200, description: 'A name or site, such as "bank" or "netflix.com"; empty for all' },
          problems: { type: 'boolean', description: 'Only sign-ins whose password is weak, reused or over a year old' },
        },
      },
      async run(i) {
        const all = o.passwords.list();
        const q = String(i.query ?? '').trim().toLowerCase();
        const url = q.includes('.') && siteOf(q) ? `https://${q}` : null;
        const bad = (l: LoginSummary) => l.strength < 2 || l.reused || isOld(l);
        const hits = all.filter((l) => (!q || l.title.toLowerCase().includes(q) || (url !== null && loginMatch(l.urls, url) > 0)) && (!i.problems || bad(l)));
        const health = `${all.length} sign-ins in the Vault: ${all.filter((l) => l.strength < 2).length} with a weak password, ${all.filter((l) => l.reused).length} sharing a password, ${all.filter(isOld).length} not changed in over a year.`;
        if (!hits.length) return { output: `${q ? `No sign-in matches "${i.query}".` : 'Nothing to show.'} ${health}` };
        const shown = hits.slice(0, 40);
        return {
          output: [`${health}\n${q || i.problems ? 'Matching:' : 'They are:'}`, ...shown.map(describe), hits.length > shown.length ? `…and ${hits.length - shown.length} more.` : ''].filter(Boolean).join('\n'),
          data: shown.map(({ id, title, urls, strength, reused, hasTotp }) => ({ id, title, sites: urls.map(displayHost), strength, reused, hasTotp })),
        };
      },
    },
    {
      name: 'passwords.offer_save',
      title: 'Open Save to Vault',
      description:
        'Open the Save to Vault window for the person, filled in with a sign-in\'s name, site and username, so they type its password there and save it. Use this when the person wants to keep a password they already have: never ask them to type a password into the chat.',
      risk: 'read',
      source: 'builtin',
      sourceId: null,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: 120, description: 'What it is for: "Netflix", "Home router"' },
          site: { type: 'string', maxLength: 300, description: 'Its web address or site, such as netflix.com' },
          username: { type: 'string', maxLength: 300, description: 'The username or email it signs in with, when the person said' },
        },
      },
      async run(i) {
        o.offerSave({ title: String(i.title ?? ''), url: String(i.site ?? ''), username: String(i.username ?? '') });
        return { output: 'The Save to Vault window is open for the person, filled in with what you gave. They type the password there and save it.' };
      },
    },
    {
      name: 'passwords.create',
      title: 'Save a sign-in with a new password',
      description:
        'Save a sign-in in the Vault with a new strong password FBRX makes, for signing up somewhere or changing a password. When the Vault already has a sign-in for that site and username, its password changes (the old one stays in its history). You never see the password: the person copies it from the Vault, or FBRX Browser fills it in.',
      risk: 'write',
      source: 'builtin',
      sourceId: null,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: 120, description: 'What it is for: "Netflix"' },
          site: { type: 'string', maxLength: 300, description: 'Its web address or site, such as netflix.com' },
          username: { type: 'string', maxLength: 300, description: 'The username or email it signs in with' },
          length: { type: 'integer', minimum: GENERATOR_LENGTH.min, maximum: 64, default: GENERATOR_DEFAULTS.length },
          symbols: { type: 'boolean', default: true, description: 'Off for a site that refuses symbols such as !@#$' },
        },
        required: ['title'],
      },
      async run(i) {
        const urls = i.site ? [String(i.site)] : [];
        const username = String(i.username ?? '').trim();
        const password = generatePassword({ length: i.length ?? GENERATOR_DEFAULTS.length, symbols: i.symbols ?? true });
        const site = urls[0] ? siteOf(urls[0]) : null;
        const same = site ? o.passwords.list().find((l) => l.urls.some((u) => siteOf(u) === site) && l.username.toLowerCase() === username.toLowerCase()) : undefined;
        const saved = o.passwords.save(same ? { id: same.id, password } : { title: String(i.title), urls, username, password });
        const where = saved.urls[0] ? ` FBRX Browser fills it in on ${displayHost(saved.urls[0])}.` : '';
        return {
          output: `${same ? `Changed the password of "${saved.title}" in the Vault; the old one is kept in its history.` : `Saved "${saved.title}" in the Vault`} with a new strong password (${password.length} characters). The person copies it from the Vault.${where}`,
          data: { id: saved.id, updated: !!same },
        };
      },
    },
  ];
}
