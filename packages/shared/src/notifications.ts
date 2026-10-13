/**
 * Pop-up notifications on this computer: which kinds show, where (inside FBRX, or in the system's notification
 * center) and with what sound. One notification shows in one place: by default inside FBRX while you are using it,
 * and in the system's notification center while you are not.
 */

/** auto: in FBRX while it is in front, otherwise the system's; app: only in FBRX; system: only the system's; both. */
export type NotificationShow = 'auto' | 'app' | 'system' | 'both';
/** fbrx: FBRX's own chime; system: the system's notification sound; off: silent. */
export type NotificationSound = 'fbrx' | 'system' | 'off';

export interface NotificationSettings {
  enabled: boolean;
  show: NotificationShow;
  sound: NotificationSound;
  /** FBRX's chime, 0–1. */
  volume: number;
  /** Kinds turned off (NOTIFICATION_KINDS ids). Alerts and messages have their own switches. */
  muted: string[];
}

export interface NotificationKind {
  id: string;
  label: string;
  help: string;
  /** Where its switch lives when it has one of its own. */
  setting?: 'alerts.channels.desktop' | 'messages.notify';
}

/** The kinds of notification FBRX shows, each with a switch on Alerts → Notifications. */
export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  { id: 'alerts', label: 'Alerts', help: 'Problems FBRX watches for: storage, antivirus, FBRX Shield, updates (the Rules tab decides which)', setting: 'alerts.channels.desktop' },
  { id: 'approvals', label: 'Approvals', help: 'Your AI asking before it does something' },
  { id: 'messages', label: 'Messages', help: 'New messages from your devices and your organization', setting: 'messages.notify' },
  { id: 'mesh', label: 'FBRX Mesh', help: 'Devices pairing, notes from your devices, someone looking for this computer' },
  { id: 'helpdesk', label: 'Help desk', help: 'Someone from IT checking or working on this computer' },
  { id: 'organization', label: 'Your organization', help: 'Notes sent from FBRX Command' },
  { id: 'calendar', label: 'Calendar', help: 'Reminders before your meetings' },
  { id: 'backup', label: 'Backups', help: 'Scheduled snapshots that failed or were skipped' },
  { id: 'agent', label: 'Your AI', help: 'Notes your AI leaves when it finishes something' },
  { id: 'macros', label: 'Macros', help: '“Ready to paste” after a macro' },
  { id: 'fbrx', label: 'FBRX itself', help: 'A part of FBRX that keeps failing' },
  { id: 'plugins', label: 'Plugins', help: 'Notifications from plugins you installed' },
];

const KIND_OF_SOURCE: Record<string, string> = {
  alerts: 'alerts',
  // A new version of FBRX: an alert like the others, with its own source so Essentials can still show it.
  updates: 'alerts',
  governance: 'approvals',
  messages: 'messages',
  mesh: 'mesh',
  helpdesk: 'helpdesk',
  administrator: 'organization',
  calendar: 'calendar',
  backup: 'backup',
  agent: 'agent',
  macros: 'macros',
  watchdog: 'fbrx',
};

/** The kind a notification's source belongs to (a plugin's own id counts as plugins). */
export function notificationKind(source: string): string {
  return KIND_OF_SOURCE[source] ?? 'plugins';
}

/**
 * Endpoint Essentials is the AI on its own: what pops up there is about the AI, FBRX itself, the organization and new
 * versions. Everything else (storage, antivirus, messages…) waits for Standard, where its pages are.
 */
const ESSENTIALS_SOURCES = new Set(['governance', 'agent', 'watchdog', 'administrator', 'helpdesk', 'updates']);
export function essentialsNotifies(source: string): boolean {
  return ESSENTIALS_SOURCES.has(source);
}

/** Kinds that never make a sound (you just did the thing yourself). */
const QUIET_KINDS = new Set(['macros']);

/** Whether a notification from this source shows at all. */
export function shouldNotify(s: NotificationSettings, source: string): boolean {
  return s.enabled && !s.muted.includes(notificationKind(source));
}

export interface NotificationDelivery {
  /** Inside FBRX (a toast in its window). */
  app: boolean;
  /** In the system's notification center. */
  system: boolean;
  /** The sound to play once, whichever place shows it. */
  sound: 'fbrx' | 'system' | null;
}

/**
 * Where one notification shows. inFront: one of FBRX's windows is the one being used; open: FBRX has a window that can
 * show a toast (it may be hidden or behind other windows).
 */
export function notificationDelivery(s: NotificationSettings, source: string, o: { inFront: boolean; open: boolean }): NotificationDelivery {
  const app = o.open && (s.show === 'app' || s.show === 'both' || (s.show === 'auto' && o.inFront));
  const system = s.show === 'system' || s.show === 'both' || (s.show === 'auto' && !o.inFront);
  const sound = (!app && !system) || s.sound === 'off' || QUIET_KINDS.has(notificationKind(source)) ? null : s.sound;
  return { app, system, sound };
}
