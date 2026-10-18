import { z } from 'zod';
import { isValidSemver, parseSemver } from './semver';

/** Release stage shown with the version everywhere ("FBRX OS Beta 2.0.0"): 1.x was the Alpha, 2.x is the Beta. */
export function stageFor(version: string): string {
  return (parseSemver(version)?.major ?? 0) >= 2 ? 'Beta' : 'Alpha';
}

/** A copy installed from an app store is updated by that store, never by FBRX itself. */
export const STORE_UPDATES = 'The store you installed FBRX from keeps it up to date';

/** The public repository FBRX OS is downloaded from. */
export const RELEASE_REPO = 'samfoxhuntress/FBRX';
/** The release manifest on the repository's default branch, checked for new versions. */
export const RELEASE_MANIFEST_URL = `https://raw.githubusercontent.com/${RELEASE_REPO}/HEAD/release.json`;

/**
 * Codenames, one per minor version, following cloth from fiber to fabric (like dessert names on phones). Shown in
 * Settings → About.
 */
export const CODENAMES: Record<string, { name: string; meaning: string }> = {
  '1.8': { name: 'Spindle', meaning: 'where every thread begins: the spindle twists loose fiber into yarn' },
  '1.9': { name: 'Bobbin', meaning: 'holds the thread, wound and ready for the loom' },
  '2.0': { name: 'Loom', meaning: 'where all the threads come together as fabric' },
  '2.1': { name: 'Warp', meaning: 'the strong threads held tight along the loom' },
  '2.2': { name: 'Weft', meaning: 'the thread woven through the warp, row by row' },
  '2.3': { name: 'Selvedge', meaning: 'the finished edge that keeps the cloth from fraying' },
  '2.4': { name: 'Tapestry', meaning: 'a whole picture, woven in' },
};

export function codenameFor(version: string): { name: string; meaning: string } | null {
  const v = parseSemver(version);
  return v ? (CODENAMES[`${v.major}.${v.minor}`] ?? null) : null;
}

/** "Alpha 1.8.1", "Beta 2.0.0". */
export function displayVersion(version: string): string {
  const v = version.replace(/^v/, '');
  return `${stageFor(v)} ${v}`;
}

/**
 * release.json at the root of the repository, as FBRX OS and FBRX Command read it: what it leaves out gets its default,
 * and the stage follows the version (stageFor) unless it names one.
 */
export const ReleaseManifestSchema = z
  .object({
    version: z.string().refine(isValidSemver, 'not a version'),
    stage: z.string().max(40).optional(),
    codename: z.string().max(60).default(''),
    released: z.string().max(40).default(''),
    importance: z.enum(['optional', 'recommended', 'important']).default('recommended'),
    summary: z.string().max(600).default(''),
    notes: z.array(z.string().max(400)).max(40).default([]),
    download: z.string().url(),
    page: z.string().url(),
    /** What is new in FBRX Command itself, when the release says so. */
    command: z.object({ summary: z.string().max(600).default(''), notes: z.array(z.string().max(400)).max(40).default([]) }).optional(),
  })
  .transform((m) => ({ ...m, stage: m.stage ?? stageFor(m.version) }));

/** A release, as FBRX OS shows it (release.json without what is only for FBRX Command). */
export interface ReleaseInfo {
  version: string;
  stage: string;
  codename: string;
  released: string;
  /** "important" updates are pointed out more strongly; all are still the person's choice. */
  importance: 'optional' | 'recommended' | 'important';
  summary: string;
  notes: string[];
  /** Zip of the FBRX folder with this version. */
  download: string;
  /** Where to read more. */
  page: string;
}

export interface ReleaseCheck {
  state: 'idle' | 'checking' | 'current' | 'available' | 'error' | 'off';
  currentVersion: string;
  latest: ReleaseInfo | null;
  checkedAt: string | null;
  message: string | null;
  /** The latest version is the one the person chose to skip. */
  skipped: boolean;
  /** FBRX knows the folder it was installed from, so it can update itself. */
  canInstall: boolean;
  /** Installed from an app store, which keeps it up to date: FBRX does not look for new versions itself. */
  store: boolean;
  installing: { phase: 'downloading' | 'unpacking' | 'starting' | 'started' | 'failed'; pct: number | null; message: string | null } | null;
}
