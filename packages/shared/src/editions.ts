import { TIER_NAMES, type Tier } from './license';

/**
 * Who an FBRX organization is and who uses each of its computers.
 *
 * - **Vertical** (the *kind* of tenant): **Work** (`business`), **School** (`education`: classroom defaults for staff,
 *   student computers possible) or **Home** (`home`: a family, with parents' and children's computers). Chosen when
 *   FBRX Command is set up or a tenant is created, and changeable later.
 * - **Audience**: who uses a computer. Staff (and parents) get FBRX Endpoint Basic or Ultra. Students (and children)
 *   get **FBRX OS Education** (or Home): a narrowed, safe set of tools and a lightweight learning helper.
 *
 * The audience comes from the enrollment token or the computer's group in FBRX Command. A computer may always be
 * narrowed to a student computer when it joins, never widened.
 */
export const VERTICALS = ['business', 'education', 'home'] as const;
export type Vertical = (typeof VERTICALS)[number];
export const VERTICAL_NAMES: Record<Vertical, string> = { business: 'Work', education: 'School', home: 'Home' };

/** How each kind of tenant is described and spoken about, in FBRX Command and on its computers. */
export interface VerticalInfo {
  /** What the tenant is called in sentences ("your company", "your school", "your family"). */
  noun: string;
  /** One line for the kind chooser. */
  tagline: string;
  /** What its computers get. */
  computers: string;
  /** Example name for the name field. */
  example: string;
  /** Who answers help desk tickets, as people say it ("the IT team", "your parents"). */
  helpers: string;
  /** Who uses the learner computers, if this kind has them ("student", "child"). */
  learner: string | null;
}

export const VERTICAL_INFO: Record<Vertical, VerticalInfo> = {
  business: {
    noun: 'company',
    tagline: 'A business, nonprofit or team: staff computers, IT tools and a help desk.',
    computers: 'Staff on FBRX Endpoint Basic, IT on Endpoint Ultra.',
    example: 'Harbor Lane Design',
    helpers: 'the IT team',
    learner: null,
  },
  education: {
    noun: 'school',
    tagline: 'A school or co-op: classroom mode for teachers, safe student computers, a help desk to IT.',
    computers: 'Teachers on Basic in classroom mode, IT on Ultra, students on FBRX OS Education.',
    example: 'Hillside Co-op',
    helpers: 'the IT team',
    learner: 'student',
  },
  home: {
    noun: 'family',
    tagline: "A family: parents' computers, safe computers for the kids, and help that goes to a parent.",
    computers: 'Parents on FBRX Endpoint, children on FBRX OS Home with the learning helper.',
    example: 'The Rivera family',
    helpers: 'a parent',
    learner: 'child',
  },
};

/** Accepts the kind's id or its friendly name (work, school, family…), e.g. from FBRX_CP_ORGANIZATION_KIND. */
export function parseVertical(raw: string | null | undefined): Vertical | null {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'business' || v === 'work' || v === 'company' || v === 'office') return 'business';
  if (v === 'education' || v === 'school' || v === 'edu' || v === 'k12') return 'education';
  if (v === 'home' || v === 'family' || v === 'household') return 'home';
  return null;
}

/** The learner audience of a kind (students at a school, children at home), or null for Work. */
export function learnerAudienceFor(vertical: Vertical): Audience | null {
  return vertical === 'education' ? 'student' : vertical === 'home' ? 'child' : null;
}

/** The groups FBRX Command's quick setup creates for each kind, each with its own enrollment token. */
export const KIND_GROUPS: Record<Vertical, Array<{ name: string; description: string; audience: Audience; tier: Tier | null }>> = {
  business: [
    { name: 'Staff', description: 'Staff computers: FBRX Endpoint Basic', audience: 'staff', tier: 'basic' },
    { name: 'IT', description: 'IT and administrators: Endpoint Ultra; receives help desk tickets', audience: 'staff', tier: null },
  ],
  education: [
    { name: 'Teachers', description: 'Staff computers: Endpoint Basic in classroom mode', audience: 'staff', tier: 'basic' },
    { name: 'IT', description: 'IT and administrators: Endpoint Ultra; receives help desk tickets', audience: 'staff', tier: null },
    { name: 'Students', description: 'Student computers: FBRX OS Education', audience: 'student', tier: null },
  ],
  home: [
    { name: 'Parents', description: "Parents' computers: FBRX Endpoint; receive the children's requests for help", audience: 'parent', tier: null },
    { name: 'Children', description: "Children's computers: FBRX OS Home with the learning helper", audience: 'child', tier: null },
  ],
};

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

/**
 * The audience a computer ends up with: a token or group that says "student" (or "child") always wins, and any computer
 * may narrow itself to the kind's learner computer ("student" asked in a family becomes "child", and the other way).
 */
export function resolveAudience(vertical: Vertical, assigned: Audience | null | undefined, requested?: Audience | null): Audience {
  const allowed = VERTICAL_AUDIENCES[vertical];
  const learner = learnerAudienceFor(vertical);
  const base = assigned && allowed.includes(assigned) ? assigned : isLearner(assigned) && learner ? learner : allowed[0];
  if (isLearner(base)) return base;
  if (requested && isLearner(requested) && learner) return learner;
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
