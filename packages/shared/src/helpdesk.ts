import { z } from 'zod';

/**
 * Help desk: people at an organization's computers send tickets to IT from FBRX (the Help desk tab), and the computers
 * the organization picked as receivers get them at once. FBRX Command keeps every ticket and its conversation, so
 * nothing is lost while a receiver is switched off, and pushes changes over each computer's live connection.
 */

export const TICKET_STATUSES = ['open', 'in_progress', 'waiting', 'resolved', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const TICKET_STATUS_NAMES: Record<TicketStatus, string> = { open: 'Open', in_progress: 'In progress', waiting: 'Waiting on you', resolved: 'Resolved', closed: 'Closed' };
/** Statuses that still need someone. */
export const OPEN_TICKET_STATUSES: readonly TicketStatus[] = ['open', 'in_progress', 'waiting'];

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_CATEGORIES = ['computer', 'network', 'printer', 'classroom', 'account', 'software', 'other'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];
export const TICKET_CATEGORY_NAMES: Record<TicketCategory, string> = {
  computer: 'This computer',
  network: 'Internet or Wi-Fi',
  printer: 'Printer',
  classroom: 'Projector, TV or sound',
  account: 'Sign-in or account',
  software: 'An app or website',
  other: 'Something else',
};

export const TicketCreateSchema = z.object({
  subject: z.string().trim().min(3).max(200),
  body: z.string().trim().min(1).max(10_000),
  category: z.enum(TICKET_CATEGORIES).default('other'),
  priority: z.enum(TICKET_PRIORITIES).default('normal'),
  requesterName: z.string().trim().max(100).default(''),
  /** What the computer looked like when the ticket was sent (name, OS, disk, network…), if the person allowed it. */
  diagnostics: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type TicketCreate = z.input<typeof TicketCreateSchema>;

export const TicketReplySchema = z.object({ body: z.string().trim().min(1).max(10_000) });

export const TicketUpdateSchema = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  /** A receiver takes the ticket. */
  assignToMe: z.boolean().optional(),
});
export type TicketUpdate = z.infer<typeof TicketUpdateSchema>;

export interface TicketSummary {
  id: string;
  /** Per-organization number people can say out loud (#12). */
  number: number;
  subject: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  requesterName: string;
  deviceId: string | null;
  deviceName: string | null;
  assigneeName: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface TicketMessage {
  id: string;
  /** requester = the person who asked; helpdesk = IT (a receiver or FBRX Command); system = status changes. */
  authorKind: 'requester' | 'helpdesk' | 'system';
  authorName: string;
  body: string;
  createdAt: string;
}

export interface TicketDetail extends TicketSummary {
  thread: TicketMessage[];
  diagnostics: Record<string, unknown> | null;
}

/** What the Help desk tab shows on a computer. */
export interface HelpdeskStatus {
  /** The computer belongs to an organization that runs a help desk in FBRX Command. */
  available: boolean;
  /** Why not, when it is not. */
  message: string | null;
  /** This computer receives the organization's tickets. */
  receiver: boolean;
  /** How many computers receive tickets (0 = tickets wait in FBRX Command). */
  receivers: number;
  organization: string | null;
}

export const HELPDESK_SCOPES = ['mine', 'queue'] as const;
export type HelpdeskScope = (typeof HELPDESK_SCOPES)[number];
