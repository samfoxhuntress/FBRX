import { parseSemver } from './semver';

/** Release stage shown with the version everywhere ("FBRX OS Alpha 1.8.1"). */
export const RELEASE_STAGE = 'Alpha';

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
  '1.10': { name: 'Shuttle', meaning: 'carries the thread across the cloth, back and forth' },
  '1.11': { name: 'Heddle', meaning: 'lifts the threads so the shuttle can pass between them' },
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

/** "Alpha 1.8.1". */
export function displayVersion(version: string): string {
  return `${RELEASE_STAGE} ${version.replace(/^v/, '')}`;
}

/** The release manifest (release.json at the root of the repository). */
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
  installing: { phase: 'downloading' | 'unpacking' | 'starting' | 'started' | 'failed'; pct: number | null; message: string | null } | null;
}
