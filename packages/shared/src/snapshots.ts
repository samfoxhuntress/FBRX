/**
 * FBRX Snapshot: pictures of the screen (an area, one window or a whole screen), marked up (pen, highlighter, arrows,
 * boxes, text, blur, crop), then copied, saved or handed to the agent. Each one is a PNG file in the snapshot folder
 * (Pictures/FBRX Snapshots at first); the desktop app takes them, the core keeps the folder.
 */

/** What a snapshot takes: an area dragged out, one window, or a whole screen. */
export const SNAPSHOT_MODES = ['region', 'window', 'screen'] as const;
export type SnapshotMode = (typeof SNAPSHOT_MODES)[number];
export const SNAPSHOT_MODE_NAMES: Record<SnapshotMode, string> = { region: 'Area', window: 'Window', screen: 'Whole screen' };

/** Seconds to wait before taking it (time to open a menu). */
export const SNAPSHOT_DELAYS = [0, 3, 5, 10] as const;

export const DEFAULT_SNAPSHOT_FOLDER = '${PICTURES}/FBRX Snapshots';
/** The largest picture kept (a marked-up shot of several 4K screens stays well under it). */
export const SNAPSHOT_MAX_BYTES = 60 * 1024 * 1024;
/** The newest snapshots listed; older ones stay in the folder. */
export const SNAPSHOT_LIST_LIMIT = 60;

/** After a snapshot is taken: open it to mark it up, or only say it was copied (the notification opens it). */
export const SNAPSHOT_AFTER = ['editor', 'notify'] as const;
export type SnapshotAfter = (typeof SNAPSHOT_AFTER)[number];

export interface ScreenSnapshot {
  /** Its file name in the snapshot folder. */
  id: string;
  path: string;
  size: number;
  /** When it was taken (or last saved). */
  createdAt: string;
}

/** The file name for a snapshot taken at `at`: "Snapshot 2026-10-24 at 08.15.32" (local time; "." as some systems refuse ":"). */
export function snapshotName(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `Snapshot ${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} at ${p(at.getHours())}.${p(at.getMinutes())}.${p(at.getSeconds())}`;
}
