import { WEEKDAYS } from './schedule';

/**
 * Automations, the automatic macros: jobs the agent does by itself, on a schedule, when FBRX starts or with a keyboard
 * shortcut, and then tells the person what it found (every time, or only when something changed). Each automation keeps
 * its own chat, so its results can be read and followed up like any conversation. Nobody is there to approve anything
 * while one runs, so it uses only the tools the policy allows without asking.
 */

/** Tell the person: every time, only when something changed since the last run, or never (it stays in its chat). */
export const AUTOMATION_NOTIFY = ['always', 'changes', 'never'] as const;
export type AutomationNotify = (typeof AUTOMATION_NOTIFY)[number];

/**
 * When it runs: every so many minutes, at a time on chosen days of the week (0 Sunday … 6 Saturday, local time), each
 * time FBRX starts, or only when someone runs it (its button or shortcut).
 */
export type AutomationSchedule = { kind: 'interval'; minutes: number } | { kind: 'daily'; time: string; days: number[] } | { kind: 'start' } | { kind: 'manual' };

export const AUTOMATION_INTERVAL = { min: 15, max: 7 * 24 * 60 } as const;
/** What the agent answers when a run found nothing new (then nobody is told). */
export const AUTOMATION_NO_CHANGE = 'NO_CHANGE';

export interface AutomationRun {
  id: string;
  automationId: string;
  trigger: 'schedule' | 'start' | 'manual' | 'hotkey';
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'done' | 'failed';
  /** Something new since the last run (always true for a first run and for automations that tell every time). */
  changed: boolean;
  /** The start of what the agent answered, or why it failed. */
  summary: string;
}

export interface AutomationInput {
  name: string;
  /** What the agent is asked to do each time. */
  prompt: string;
  schedule: AutomationSchedule;
  notify: AutomationNotify;
  /** May use the internet (web pages, search, quotes); without it, only what is on this computer. */
  online: boolean;
  /** A shortcut that runs it at once from any app ("CommandOrControl+Alt+1"), or "". */
  hotkey: string;
  enabled: boolean;
}

export interface Automation extends AutomationInput {
  id: string;
  /** The chat its runs are in (made at its first run). */
  conversationId: string | null;
  createdAt: string;
  nextRunAt: string | null;
  running: boolean;
  lastRun: AutomationRun | null;
}

/** When an automation runs next, after `from` (null: only when it is run by hand or at start). */
export function nextAutomationRun(s: AutomationSchedule, from: Date, lastRun: Date | null): Date | null {
  if (s.kind === 'interval') {
    const due = lastRun ? new Date(lastRun.getTime() + s.minutes * 60_000) : from;
    return due < from ? from : due;
  }
  if (s.kind === 'daily') {
    const [h, m] = s.time.split(':').map(Number);
    const days = s.days.length ? s.days : [0, 1, 2, 3, 4, 5, 6];
    const at = new Date(from);
    at.setHours(h, m, 0, 0);
    for (let n = 0; n < 8; n++, at.setDate(at.getDate() + 1)) if (at > from && days.includes(at.getDay())) return at;
    return null;
  }
  return null;
}

/** A schedule as people say it: "Every hour", "Weekdays at 7:30 AM", "When FBRX starts". */
export function describeAutomationSchedule(s: AutomationSchedule): string {
  switch (s.kind) {
    case 'interval': {
      const m = s.minutes;
      if (m % 1440 === 0) return m === 1440 ? 'Every day' : `Every ${m / 1440} days`;
      if (m % 60 === 0) return m === 60 ? 'Every hour' : `Every ${m / 60} hours`;
      return `Every ${m} minutes`;
    }
    case 'daily': {
      const [h, min] = s.time.split(':').map(Number);
      const time = new Date(2000, 0, 1, h, min).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const days = [...new Set(s.days)].sort();
      const when = !days.length || days.length === 7 ? 'Every day' : days.join() === '1,2,3,4,5' ? 'Weekdays' : days.join() === '0,6' ? 'Weekends' : days.map((d) => WEEKDAYS[d].slice(0, 3)).join(', ');
      return `${when} at ${time}`;
    }
    case 'start':
      return 'When FBRX starts';
    case 'manual':
      return 'Only when you run it';
  }
}

/** Ready-made automations to start from; the person fills in the parts in [brackets]. */
export const AUTOMATION_TEMPLATES: Array<{ id: string; icon: string; title: string; description: string; input: Omit<AutomationInput, 'hotkey' | 'enabled'> }> = [
  {
    id: 'listings',
    icon: 'search',
    title: 'Watch classified listings',
    description: 'New ads that match what you want, with price and link.',
    input: {
      name: 'New listings',
      prompt: 'Read the listings at [the web address of the search results page] and list the ones that match: [what you want, price range, area]. For each, give the title, price, place and link.',
      schedule: { kind: 'interval', minutes: 60 },
      notify: 'changes',
      online: true,
    },
  },
  {
    id: 'stocks',
    icon: 'activity',
    title: 'Check my stocks',
    description: 'Quotes for your tickers, and the big moves.',
    input: {
      name: 'My stocks',
      prompt: 'Get the latest quotes for [AAPL, MSFT, NVDA] and say how each moved since the open. Point out any that moved more than 3%.',
      schedule: { kind: 'daily', time: '16:15', days: [1, 2, 3, 4, 5] },
      notify: 'always',
      online: true,
    },
  },
  {
    id: 'price',
    icon: 'tag',
    title: 'Price drop alert',
    description: 'Tells you when something gets cheaper.',
    input: {
      name: 'Price drop',
      prompt: 'Check the price of [the product] at [its web address]. Tell me when it is below $[the price you want to pay].',
      schedule: { kind: 'interval', minutes: 360 },
      notify: 'changes',
      online: true,
    },
  },
  {
    id: 'brief',
    icon: 'sun',
    title: 'Morning brief',
    description: 'Your day, your tasks and the weather.',
    input: {
      name: 'Morning brief',
      prompt: 'Give me a short morning brief: what is on my calendar today, my open tasks that are due soon, and the weather in [your city] (read it from a weather website).',
      schedule: { kind: 'daily', time: '07:30', days: [1, 2, 3, 4, 5] },
      notify: 'always',
      online: true,
    },
  },
  {
    id: 'news',
    icon: 'globe',
    title: 'News on a topic',
    description: 'The day’s three most important stories, with links.',
    input: {
      name: 'Topic news',
      prompt: 'Search the web for news about [your topic] from the last day, and summarize the three most important stories with their links.',
      schedule: { kind: 'daily', time: '08:00', days: [] },
      notify: 'changes',
      online: true,
    },
  },
  {
    id: 'report',
    icon: 'note',
    title: 'Weekly report',
    description: 'A PDF report, ready on Friday afternoon.',
    input: {
      name: 'Weekly report',
      prompt: 'Make a PDF report of [what to report on, such as the tasks I finished this week and what is still open], with a short summary at the top.',
      schedule: { kind: 'daily', time: '16:00', days: [5] },
      notify: 'always',
      online: false,
    },
  },
];
