import { EDITION_PLANS, STANDARD_TRIAL_DAYS, formatPrice } from './plans';
import type { Tier } from './license';

/**
 * Home in Endpoint Essentials, on the computer and on the phone: no dashboard, just the split-flap board and a few
 * notes from FBRX itself: tips and tricks, the AI models, and what the editions above add. One list, so the computer
 * and the phone say the same things.
 */
export type EssentialsNoteKind = 'welcome' | 'tip' | 'models' | 'upgrade';

export interface EssentialsNote {
  id: string;
  kind: EssentialsNoteKind;
  title: string;
  body: string;
  /** Where its button goes: the chat, the AI models, the editions (and buying), pairing the phone. */
  action?: { label: string; to: 'agent' | 'models' | 'edition' | 'pair' };
}

/** Every tip there is (the website shows them too); notesFor picks two a day. */
export const ESSENTIALS_TIPS: Array<Omit<EssentialsNote, 'kind'>> = [
  { id: 'tip-ask', title: 'Ask in your own words', body: '“Help me write a thank-you note”, “why is my computer slow?”, “explain this error”: no special phrasing needed.', action: { label: 'Ask now', to: 'agent' } },
  { id: 'tip-offline', title: 'Your chats stay here', body: 'Chats start offline. {agent} asks before it uses the internet or changes anything on your computer.' },
  { id: 'tip-memory', title: '{agent} can remember', body: 'Tell it “remember that I teach 4th grade” and it keeps that in mind. Settings → Memory shows what it knows, and forgets on request.' },
  { id: 'tip-voice', title: 'Talk instead of typing', body: 'Settings → Voice: speak to {agent} and hear its answers, with a voice you pick.' },
  { id: 'tip-spotlight', title: 'Spotlight, from anywhere', body: 'Press Ctrl+K (⌘K on a Mac) for apps, files, settings and quick answers.' },
  { id: 'tip-stop', title: 'One button stops it all', body: 'The emergency stop halts every AI action at once: in the chat, the tray menu and Settings → Agent.' },
  { id: 'tip-thinking', title: 'Big job? Let {agent} work longer', body: 'Settings → Agent → Thinking: Quick for small questions, Everyday for most things, Thorough for big jobs with many steps.' },
];

/**
 * The notes for Home: a welcome the first days, two tips that change each day, the AI models, and (in Essentials) what
 * Standard and Ultra add, with their prices, or Standard's free trial while this computer may start it (`trial`).
 * `dismissed` ids are left out.
 */
export function notesFor(o: { tier: Tier; agentName: string; modelName?: string | null; now?: Date; dismissed?: string[]; paired?: boolean; firstDays?: boolean; trial?: boolean }): EssentialsNote[] {
  const now = o.now ?? new Date();
  const fill = (s: string) => s.replace(/\{agent\}/g, o.agentName);
  const day = Math.floor(now.getTime() / 86_400_000);
  const notes: EssentialsNote[] = [];
  if (o.firstDays) notes.push({ id: 'welcome', kind: 'welcome', title: 'Welcome to FBRX', body: fill('{agent} is your own AI, running on your computer. Ask it anything; it explains as it goes.'), action: { label: 'Start a chat', to: 'agent' } });
  for (const i of [0, 1]) {
    const t = ESSENTIALS_TIPS[(day * 2 + i) % ESSENTIALS_TIPS.length]!;
    notes.push({ ...t, kind: 'tip', title: fill(t.title), body: fill(t.body) });
  }
  notes.push({
    id: 'models',
    kind: 'models',
    title: 'Try another AI model',
    body: o.modelName
      ? `${o.agentName} runs ${o.modelName} now. A bigger model answers better; a smaller one is quicker. AI models has both, and the AI apps you already use.`
      : `${o.agentName} needs a model to think with. AI models picks one for your computer in a click.`,
    action: { label: 'AI models', to: 'models' },
  });
  if (o.tier === 'essentials') {
    const std = EDITION_PLANS.basic;
    const ultra = EDITION_PLANS.ultra;
    const standard = 'Your AI’s controls (how long it works, how long its answers are, how much it keeps in mind), plus Dash (the dashboard), notes, tasks, calendar, alerts, storage and backups.';
    notes.push(
      o.trial
        ? {
            id: 'upgrade-standard',
            kind: 'upgrade',
            title: `Try Standard free for ${STANDARD_TRIAL_DAYS} days`,
            body: `${standard} No card needed; then ${formatPrice(std.monthly!)} a month.`,
            action: { label: 'Try it free', to: 'edition' },
          }
        : { id: 'upgrade-standard', kind: 'upgrade', title: `More with Standard, ${formatPrice(std.monthly!)} a month`, body: standard, action: { label: 'See the editions', to: 'edition' } },
    );
    notes.push({
      id: 'upgrade-ultra',
      kind: 'upgrade',
      title: `Everything for experts with Ultra, ${formatPrice(ultra.monthly!)} a month`,
      body: 'Terminal, Task Manager, the virtual lab, your phone and computers together, AI coordination and every look.',
      action: { label: 'See the editions', to: 'edition' },
    });
  }
  return notes.filter((n) => !o.dismissed?.includes(n.id));
}

/** The split-flap board's messages on Home: rows of up to about 24 letters. */
export function homeBoard(o: { name?: string | null; agentName: string; aiReady: boolean; deviceName?: string | null; now?: Date; tier: Tier }): string[][] {
  const now = o.now ?? new Date();
  const h = now.getHours();
  const greeting = h < 5 ? 'GOOD NIGHT' : h < 12 ? 'GOOD MORNING' : h < 18 ? 'GOOD AFTERNOON' : 'GOOD EVENING';
  const m: string[][] = [o.name ? [`${greeting},`, o.name] : [greeting, o.deviceName ?? 'FBRX']];
  m.push([now.toLocaleDateString(undefined, { weekday: 'long' }), now.toLocaleDateString(undefined, { month: 'short', day: '2-digit', year: 'numeric' })]);
  m.push(o.aiReady ? [`${o.agentName} IS READY`, 'ASK ME ANYTHING'] : [`${o.agentName}`, 'NEEDS A MODEL']);
  m.push(['YOUR AI', 'ON YOUR COMPUTER']);
  if (o.tier === 'essentials') m.push(['FBRX ESSENTIALS', 'FREE, ALWAYS']);
  return m;
}
