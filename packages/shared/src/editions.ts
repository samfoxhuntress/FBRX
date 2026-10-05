import { TIER_NAMES, type Tier } from './license';

/**
 * Who an FBRX organization is and who uses each of its computers.
 *
 * - **Vertical**: what kind of organization runs FBRX Command. *Education* (schools) turns on classroom defaults for
 *   staff and makes student computers possible; *Home* (families, coming later) does the same for parents and children.
 * - **Audience**: who uses a computer. Staff (and parents) get FBRX Endpoint Basic or Ultra. Students (and children)
 *   get **FBRX OS Education** (or Home): a narrowed, safe set of tools and a lightweight learning helper.
 *
 * The audience comes from the enrollment token or the computer's group in FBRX Command. A computer may always be
 * narrowed to a student computer when it joins, never widened.
 */
export const VERTICALS = ['business', 'education', 'home'] as const;
export type Vertical = (typeof VERTICALS)[number];
export const VERTICAL_NAMES: Record<Vertical, string> = { business: 'Business', education: 'Education', home: 'Home' };

export const AUDIENCES = ['staff', 'student', 'parent', 'child'] as const;
export type Audience = (typeof AUDIENCES)[number];
export const AUDIENCE_NAMES: Record<Audience, string> = { staff: 'Staff', student: 'Student', parent: 'Parent', child: 'Child' };

/** Audiences that make sense for a vertical (the first is the default). */
export const VERTICAL_AUDIENCES: Record<Vertical, readonly Audience[]> = {
  business: ['staff'],
  education: ['staff', 'student'],
  home: ['parent', 'child'],
};

/** Students and children: the learner experience with a narrowed agent. */
export function isLearner(audience: Audience | null | undefined): boolean {
  return audience === 'student' || audience === 'child';
}

/** The audience a computer ends up with: a token or group that says "student" always wins; anything may narrow to student. */
export function resolveAudience(vertical: Vertical, assigned: Audience | null | undefined, requested?: Audience | null): Audience {
  const allowed = VERTICAL_AUDIENCES[vertical];
  const base = assigned && allowed.includes(assigned) ? assigned : allowed[0];
  if (isLearner(base)) return base;
  if (requested && allowed.includes(requested) && isLearner(requested)) return requested;
  return base;
}

/** The product name a computer shows: FBRX OS Education on student computers, otherwise its Endpoint edition. */
export function productNameFor(tier: Tier, vertical: Vertical, audience: Audience): string {
  if (vertical === 'education' && audience === 'student') return 'FBRX OS Education';
  if (vertical === 'home' && audience === 'child') return 'FBRX OS Home';
  return TIER_NAMES[tier];
}

/** The edition a group can hold its computers to (never above the organization's license). */
export function narrowTier(licensed: Tier, wanted: Tier | null | undefined): Tier {
  return wanted === 'basic' ? 'basic' : licensed;
}

/** How a computer installs new versions, as its organization decides in FBRX Command. */
export const AUTO_UPDATE_MODES = ['off', 'notify', 'install'] as const;
export type AutoUpdateMode = (typeof AUTO_UPDATE_MODES)[number];
export const AUTO_UPDATE_NAMES: Record<AutoUpdateMode, string> = { off: 'Off', notify: 'Tell people', install: 'Install automatically' };

/** What FBRX Command decided for this computer, beyond settings and policy. */
export interface DeviceEdition {
  vertical: Vertical;
  audience: Audience;
  /** Hold the computer to Endpoint Basic (null = what the license gives). */
  tier: Tier | null;
  helpdesk: { enabled: boolean; receiver: boolean };
  autoUpdate: AutoUpdateMode;
}

/** How a computer describes itself (system status, the sidebar, Settings). */
export interface EditionStatus {
  tier: Tier;
  vertical: Vertical;
  audience: Audience;
  learner: boolean;
  /** "FBRX Endpoint Basic", "FBRX Endpoint Ultra", "FBRX OS Education"… */
  productName: string;
}

/**
 * Classroom defaults for staff computers in an Education organization, under the organization's own profiles:
 * presenter-safe mode turns on with a projector, chats start offline, and fun extras stay off.
 */
export const EDUCATION_STAFF_DEFAULTS = {
  presenter: { auto: true, hideNotifications: true, maskClipboard: true, blurPrivate: true },
  ai: { newChatsOffline: true },
  appearance: { easterEggs: false, gooseVisits: false },
} as const;

/** Student (and child) computers: the defaults, and the settings they cannot change. */
export const LEARNER_DEFAULTS = {
  presenter: { auto: true, hideNotifications: true, maskClipboard: true, blurPrivate: true },
  ai: { newChatsOffline: true },
  appearance: { easterEggs: false, gooseVisits: false },
  clipboard: { history: false },
  mesh: { enabled: false },
  localApi: { enabled: false },
} as const;
export const LEARNER_LOCKED = ['appearance.easterEggs', 'appearance.gooseVisits', 'mesh.enabled', 'localApi.enabled', 'ai.systemPrompt', 'ai.providers', 'ai.defaultProvider', 'ai.defaultModel'];
