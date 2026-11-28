/**
 * FBRX Sync: your projects, tasks, notes, snippets and FBRX calendar events, kept the same on two of your computers.
 * It runs only when someone starts it, straight between the two computers over FBRX Mesh, sealed so only those two
 * can read it: no FBRX server ever holds or sees the data. Both computers must allow it (the Sync permission).
 */

/** What syncs, in the order it is applied (projects first: the others may belong to one). */
export const SYNC_KINDS = ['projects', 'tasks', 'notes', 'snippets', 'events'] as const;
export type SyncKind = (typeof SYNC_KINDS)[number];

export const SYNC_KIND_NAMES: Record<SyncKind, string> = {
  projects: 'Projects',
  tasks: 'Tasks',
  notes: 'Notes',
  snippets: 'Snippets',
  events: 'Calendar events',
};

/** What one sync did, for one kind or all of them together. */
export interface SyncCounts {
  /** New or newer here, from the other computer. */
  received: number;
  /** New or newer there, from this computer. */
  sent: number;
  /** Deleted (on either computer) because it was deleted on the other. */
  deleted: number;
  /** Changed on both since they last synced: the newer one won, and a note or snippet kept the other as a copy. */
  conflicts: number;
}

export interface SyncResult {
  deviceId: string;
  deviceName: string;
  at: string;
  kinds: Record<SyncKind, SyncCounts>;
  total: SyncCounts;
}

/** A paired computer as FBRX Sync sees it: whether both sides allow it, and how the last sync went. */
export interface SyncPeer {
  deviceId: string;
  name: string;
  online: boolean;
  /** This computer allows syncing with it (its Sync permission here). */
  allowed: boolean;
  lastSyncAt: string | null;
  last: SyncResult | null;
}
