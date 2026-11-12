import { DIGGER_NAME, DIGGER_PAGES, DIGGER_SETTINGS } from './digger';
import { atLeast, TIER_SHORT, type Tier } from './license';
import { PRODUCT_NAME } from './constants';

/**
 * The FBRX app family. From 2.5.0 the pro tools move out of FBRX Endpoint into apps of their own, one new app per
 * release, all built from this one codebase (each app is a flavor of the desktop app) and sharing one license (the FBRX
 * account's edition unlocks them) and one AI (Fabrix runs in the Endpoint; each app reaches it over the local link).
 * This list is what every app and the Endpoint know about the others: what each is, the edition that unlocks it, the
 * release it arrives in, the pages it shows, and the Endpoint pages that hand off to it ("Open" when it is installed,
 * "Get" when it is not).
 */
export const APP_IDS = ['os', 'digger', 'reach', 'browser', 'shield', 'sandbox'] as const;
export type AppId = (typeof APP_IDS)[number];

export interface FbrxAppInfo {
  id: AppId;
  /** Its full name, as on its window, installer and data folder. */
  name: string;
  /** Its short name on buttons ("Open Digger"). */
  short: string;
  /** One line on what it is for. */
  what: string;
  /** The lightest edition that unlocks it. */
  edition: Tier;
  /** The FBRX OS release it arrives in as an app of its own. */
  since: string;
  /** Whether this codebase builds it yet (the others are planned). */
  built: boolean;
  /** The pages it shows ('all' for FBRX Endpoint). */
  pages: readonly string[] | 'all';
  /** The settings tabs it shows. */
  settings: readonly string[] | 'all';
  /**
   * The Endpoint pages that hand off to it once it is its own app: a page id, or "page/tab" for one tab of a page
   * (the Network Center's "network/digger").
   */
  takes: readonly string[];
  /** Its releases' tag prefix (v2.5.0, digger-v1.3.0). */
  tag: string;
  /** Its window and installer icon in apps/desktop/build. */
  icon: string;
}

export const FBRX_APPS: Record<AppId, FbrxAppInfo> = {
  os: {
    id: 'os',
    name: PRODUCT_NAME,
    short: 'FBRX Endpoint',
    what: 'Your AI, your computer and your day: Fabrix, This PC, the dashboard, calendar, tasks and notes, and everyday network checks.',
    edition: 'essentials',
    since: '1.0.0',
    built: true,
    pages: 'all',
    settings: 'all',
    takes: [],
    tag: 'v',
    icon: 'icon.png',
  },
  digger: {
    id: 'digger',
    name: DIGGER_NAME,
    short: 'Digger',
    what: 'Every network tool: scans and their comparison, consoles, remote desktop, the Wi-Fi channel planner and network environments.',
    edition: 'ultra',
    since: '2.5.0',
    built: true,
    pages: DIGGER_PAGES,
    settings: DIGGER_SETTINGS,
    takes: ['network/digger'],
    tag: 'digger-v',
    icon: 'digger-icon.png',
  },
  reach: {
    id: 'reach',
    name: 'FBRX Reach',
    short: 'Reach',
    what: 'Remote desktop: terminals, SSH, RDP and VNC inside the app, saved connections, logins in the vault and FBRX Server.',
    edition: 'ultra',
    since: '2.6.0',
    built: false,
    pages: [],
    settings: [],
    takes: [],
    tag: 'reach-v',
    icon: 'reach-icon.png',
  },
  browser: {
    id: 'browser',
    name: 'FBRX Browser',
    short: 'Browser',
    what: 'The web browser with its passwords and AI, as its own install.',
    edition: 'essentials',
    since: '2.7.0',
    built: false,
    pages: [],
    settings: [],
    takes: [],
    tag: 'browser-v',
    icon: 'browser-icon.png',
  },
  shield: {
    id: 'shield',
    name: 'FBRX Shield',
    short: 'Shield',
    what: 'Protection as a background service, so scans keep running when the Endpoint is closed.',
    edition: 'basic',
    since: '2.7.0',
    built: false,
    pages: [],
    settings: [],
    takes: [],
    tag: 'shield-v',
    icon: 'shield-icon.png',
  },
  sandbox: {
    id: 'sandbox',
    name: 'FBRX Sandbox',
    short: 'Sandbox',
    what: 'The virtual lab and the coding lab, connected to Fabrix.',
    edition: 'ultra',
    since: '2.8.0',
    built: false,
    pages: [],
    settings: [],
    takes: [],
    tag: 'sandbox-v',
    icon: 'sandbox-icon.png',
  },
};

/** Whether an edition unlocks an app. */
export const appUnlocked = (id: AppId, tier: Tier | null | undefined): boolean => atLeast(tier, FBRX_APPS[id].edition);

/** "Needs Ultra", "Needs Pro" (Pro's id is basic). */
export const appNeeds = (id: AppId): string => `Needs ${TIER_SHORT[FBRX_APPS[id].edition]}`;

/** What the Endpoint shows for a page another app has taken: open that app, get it, or the edition it needs. */
export interface AppHandoff {
  app: FbrxAppInfo;
  action: 'open' | 'get' | 'upgrade';
}

/**
 * The hand-off for a page ("network/digger" for a tab), as the app running now shows it: null when no app takes the
 * page, when the app taking it is the one running, or when that app is not built yet.
 */
export function handoffFor(page: string, o: { flavor: AppId; tier: Tier | null | undefined; installed: readonly AppId[] }): AppHandoff | null {
  const app = Object.values(FBRX_APPS).find((a) => a.built && a.takes.includes(page));
  if (!app || app.id === o.flavor) return null;
  if (o.installed.includes(app.id)) return { app, action: 'open' };
  return { app, action: appUnlocked(app.id, o.tier) ? 'get' : 'upgrade' };
}

/** What an app writes about itself when it starts (app.json in its data folder), so the others know it is installed. */
export interface AppPresence {
  id: AppId;
  version: string;
  /** The program to start it with. */
  exec: string;
  /** When it last started. */
  at: string;
}

/** An app as the Endpoint lists it (Settings → FBRX apps). */
export interface AppStatus {
  id: AppId;
  name: string;
  short: string;
  what: string;
  edition: Tier;
  since: string;
  built: boolean;
  /** This is the app running now. */
  self: boolean;
  installed: boolean;
  version: string | null;
  unlocked: boolean;
  /** Where to get it, when it has a release (release.json). */
  download: string | null;
}
