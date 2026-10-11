import { z } from 'zod';

/**
 * Messages: people chat between their own devices (FBRX Mesh: computers and phone, end to end) and between the
 * computers of one organization (FBRX Command relays and keeps those). One page holds both, so a household or a
 * small office can talk without the help desk.
 */

export const MESSAGE_MAX_CHARS = 4000;

/** Where a conversation lives: your mesh, or your organization. */
export type ThreadPlace = 'mesh' | 'org';

export interface MessageThread {
  /** "mesh:all", "mesh:<device id>", "org:all" or "org:<device id>". */
  id: string;
  place: ThreadPlace;
  /** Everyone in the place, or one device. */
  kind: 'group' | 'direct';
  title: string;
  /** "Windows computer", "Phone", "4 computers"… */
  subtitle: string | null;
  /** Direct conversations: whether the other device is reachable now (null: unknown). */
  online: boolean | null;
  last: { text: string; fromName: string; mine: boolean; at: string } | null;
  unread: number;
  /** Why nothing can be sent here right now (null: it can). */
  cannotSend: string | null;
}

export type MessageState = 'sent' | 'waiting' | 'failed';

export interface ThreadMessage {
  id: string;
  threadId: string;
  fromId: string;
  fromName: string;
  mine: boolean;
  /** Sent by FBRX Command (an administrator), not a computer. */
  fromAdmin?: boolean;
  text: string;
  at: string;
  /** Your own messages to a device: delivered, waiting for it to come online, or not accepted. */
  state?: MessageState;
  /** Why it failed. */
  error?: string;
}

export interface MessagesOverview {
  /** Messages are on for this computer (Settings or the organization). */
  enabled: boolean;
  threads: MessageThread[];
  mesh: { on: boolean; devices: number; note: string | null };
  org: { on: boolean; name: string | null; note: string | null };
  unread: number;
}

// ------------------------------------------------------------------------- FBRX Command (organization chat)

export const OrgChatSendSchema = z.object({
  /** "all" (everyone in the organization) or a device id. */
  to: z.string().min(1).max(80),
  text: z.string().trim().min(1).max(MESSAGE_MAX_CHARS),
  /** The person's name on the sending computer. */
  fromName: z.string().max(100).optional(),
});
export type OrgChatSend = z.infer<typeof OrgChatSendSchema>;

/** A message as one computer sees it: `with` is "all" or the other computer's id. */
export interface OrgChatMessage {
  id: string;
  with: string;
  fromDeviceId: string | null;
  fromName: string;
  fromKind: 'device' | 'admin';
  text: string;
  at: string;
}

export interface OrgChatPeer {
  deviceId: string;
  name: string;
  platform: string;
  online: boolean;
}

/** GET /v1/device/chat: who is in the organization, and each conversation this computer has. */
export interface OrgChatState {
  available: boolean;
  message: string | null;
  organization: string | null;
  me: string;
  peers: OrgChatPeer[];
  conversations: Array<{ with: string; last: OrgChatMessage | null; unread: number }>;
}
