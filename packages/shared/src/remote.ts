/**
 * Remote view and control: seeing another computer's screen, and using its mouse and keyboard. Two ways in: your own
 * computers over FBRX Mesh (a paired computer you allowed to), and FBRX Command's administrators (with a ticket number
 * and the person's yes at the computer). The computer being seen asks its person first, unless you let one of your own
 * computers in without asking; a banner with Stop stays on its screen while it lasts, and every session is recorded in
 * the audit log.
 */

export type RemoteMode = 'view' | 'control';

export interface RemoteFrom {
  kind: 'mesh' | 'command';
  /** The computer or administrator looking, as the person at this computer sees it. */
  name: string;
  /** Mesh: the paired computer's id. */
  deviceId?: string;
  /** Command: the administrator's sign-in, the ticket number and the reason they gave. */
  admin?: string;
  ticket?: string;
  reason?: string;
}

export type RemoteState = 'asking' | 'live' | 'denied' | 'ended';

export interface RemoteSession {
  id: string;
  viewer: RemoteFrom;
  /** What was asked for, and (once answered) what was allowed: control can be narrowed to view. */
  asked: RemoteMode;
  mode: RemoteMode;
  state: RemoteState;
  /** Started without asking (one of the person's own computers they let in). */
  unattended: boolean;
  startedAt: string;
  endedAt: string | null;
  /** Why it ended or was not allowed, in words. */
  why: string | null;
  /** The screens there, and whether its mouse and keyboard can be used from here (and why not). */
  displays: number;
  control: { ok: boolean; why: string | null };
}

export interface RemoteFrame {
  /** Goes up with each new picture. */
  seq: number;
  width: number;
  height: number;
  /** JPEG, base64. */
  jpeg: string;
  display: number;
  displays: number;
}

export type RemoteButton = 'left' | 'right' | 'middle';
export type RemoteModifier = 'ctrl' | 'alt' | 'shift' | 'meta';

/** Keys that are not typed text. Letters and digits are here for shortcuts (Ctrl+C); typing goes as text. */
export const REMOTE_KEYS = [
  'Enter', 'Tab', 'Backspace', 'Escape', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  ...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''),
] as const;
export type RemoteKey = (typeof REMOTE_KEYS)[number];

/** One thing done with the mouse or keyboard; x and y are 0-1 across the screen being shown. */
export type RemoteInput =
  | { t: 'move'; x: number; y: number }
  | { t: 'down' | 'up'; x: number; y: number; button: RemoteButton }
  | { t: 'scroll'; x: number; y: number; dy: number }
  | { t: 'text'; text: string }
  | { t: 'key'; key: RemoteKey; mods: RemoteModifier[] };

export const REMOTE_LIMITS = {
  /** Events in one batch, and characters in one typed text. */
  batch: 200,
  text: 2000,
  /** A session nobody asked anything of for this long ends (the viewer went away). */
  idleMs: 45_000,
  /** How long the person at the computer has to answer. */
  askMs: 60_000,
} as const;

/** What is wrong with a batch of input, in words (null: fine). */
export function remoteInputProblem(events: unknown): string | null {
  if (!Array.isArray(events) || events.length > REMOTE_LIMITS.batch) return `Send 1-${REMOTE_LIMITS.batch} events at a time`;
  const unit = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  for (const e of events as RemoteInput[]) {
    if (!e || typeof e !== 'object') return 'Not an event';
    switch (e.t) {
      case 'move':
        if (!unit(e.x) || !unit(e.y)) return 'A position is 0-1 across the screen';
        break;
      case 'down':
      case 'up':
        if (!unit(e.x) || !unit(e.y) || !['left', 'right', 'middle'].includes(e.button)) return 'A button needs a position and left, right or middle';
        break;
      case 'scroll':
        if (!unit(e.x) || !unit(e.y) || typeof e.dy !== 'number' || !Number.isFinite(e.dy) || Math.abs(e.dy) > 50) return 'Scroll by -50 to 50 lines';
        break;
      case 'text':
        if (typeof e.text !== 'string' || !e.text || e.text.length > REMOTE_LIMITS.text || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(e.text)) return `Text is 1-${REMOTE_LIMITS.text} characters, without control characters`;
        break;
      case 'key':
        if (!(REMOTE_KEYS as readonly string[]).includes(e.key) || !Array.isArray(e.mods) || e.mods.some((m) => !['ctrl', 'alt', 'shift', 'meta'].includes(m))) return 'Not a key this can press';
        break;
      default:
        return 'Not an event';
    }
  }
  return null;
}

/** "Fox's laptop (control)", "Sam, ticket 4521 (view only)" for the banner and the question. */
export function remoteWho(v: RemoteFrom): string {
  return v.kind === 'command' ? `${v.admin ?? v.name}${v.ticket ? `, ticket ${v.ticket}` : ''}` : v.name;
}
