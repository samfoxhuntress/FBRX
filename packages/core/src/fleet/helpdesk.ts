import {
  TicketCreateSchema,
  TicketReplySchema,
  TicketUpdateSchema,
  type HelpdeskScope,
  type HelpdeskStatus,
  type ServerToDeviceMessage,
  type TicketCreate,
  type TicketDetail,
  type TicketSummary,
  type TicketUpdate,
} from '@fbrx/shared';
import { CoreError } from '../errors';
import type { EventBus } from '../events';
import type { Logger } from '../logger';
import type { FleetAgent } from './fleet-agent';

export interface HelpdeskDeps {
  fleet: FleetAgent;
  events: EventBus;
  log: Logger;
  /** Who is asking: the person's name from Settings, or the computer's. */
  requesterName: () => string;
  /** A snapshot of the computer for IT (name, system, disk, network…), attached when the person allows it. */
  diagnostics: () => Promise<Record<string, unknown>>;
  notify: (title: string, body: string) => void;
}

/**
 * The Help desk tab on a computer that belongs to an organization: send tickets to IT, follow them, and, on computers
 * the organization chose as receivers, work the queue. FBRX Command stores the tickets and pushes changes over the
 * computer's live connection, so a new ticket reaches IT within a second (or when its computer next comes online).
 */
export class Helpdesk {
  /** Tickets this computer just changed, so it does not notify itself about them. */
  private readonly own = new Map<string, number>();
  private last: HelpdeskStatus | null = null;

  constructor(private readonly d: HelpdeskDeps) {}

  private mine(id: string) {
    this.own.set(id, Date.now());
  }

  private self(id: string): boolean {
    const at = this.own.get(id);
    return at !== undefined && Date.now() - at < 8000;
  }

  async status(): Promise<HelpdeskStatus> {
    const fleet = this.d.fleet.status();
    if (fleet.state === 'unenrolled') {
      return { available: false, message: 'Join your organization (Organization page) to send problems to its IT team.', receiver: false, receivers: 0, organization: null };
    }
    try {
      this.last = await this.d.fleet.request<HelpdeskStatus>('GET', '/v1/device/helpdesk');
      return this.last;
    } catch (err) {
      // Offline: keep showing the tab with what we knew, and say why lists may be stale.
      const msg = err instanceof CoreError ? err.message : String(err);
      return { ...(this.last ?? { available: true, receiver: false, receivers: 0, organization: fleet.tenantName }), message: msg };
    }
  }

  list(scope: HelpdeskScope, state: 'open' | 'closed' | 'all'): Promise<TicketSummary[]> {
    return this.d.fleet.request<TicketSummary[]>('GET', `/v1/device/helpdesk/tickets?scope=${scope}&state=${state}`);
  }

  get(id: string): Promise<TicketDetail> {
    return this.d.fleet.request<TicketDetail>('GET', `/v1/device/helpdesk/tickets/${encodeURIComponent(id)}`);
  }

  async create(input: TicketCreate & { attachDiagnostics?: boolean }): Promise<TicketDetail> {
    const { attachDiagnostics, ...rest } = input;
    const body = TicketCreateSchema.parse({ ...rest, requesterName: rest.requesterName || this.d.requesterName() });
    const diagnostics = attachDiagnostics === false ? null : await this.d.diagnostics().catch(() => null);
    const t = await this.d.fleet.request<TicketDetail>('POST', '/v1/device/helpdesk/tickets', { ...body, diagnostics });
    this.mine(t.id);
    this.d.events.emit('helpdesk.changed', { ticketId: t.id, number: t.number, reason: 'created', subject: t.subject });
    return t;
  }

  async reply(id: string, body: string): Promise<TicketDetail> {
    const b = TicketReplySchema.parse({ body });
    this.mine(id);
    const t = await this.d.fleet.request<TicketDetail>('POST', `/v1/device/helpdesk/tickets/${encodeURIComponent(id)}/messages`, { ...b, authorName: this.d.requesterName() });
    this.d.events.emit('helpdesk.changed', { ticketId: t.id, number: t.number, reason: 'message', subject: t.subject });
    return t;
  }

  async update(id: string, change: TicketUpdate): Promise<TicketDetail> {
    const c = TicketUpdateSchema.parse(change);
    this.mine(id);
    const t = await this.d.fleet.request<TicketDetail>('PATCH', `/v1/device/helpdesk/tickets/${encodeURIComponent(id)}`, { ...c, authorName: this.d.requesterName() });
    this.d.events.emit('helpdesk.changed', { ticketId: t.id, number: t.number, reason: 'updated', subject: t.subject });
    return t;
  }

  /** A push from FBRX Command: refresh the tab, and tell the person when someone else did something. */
  onPush(msg: ServerToDeviceMessage): void {
    if (msg.type !== 'helpdesk.changed') return;
    this.d.events.emit('helpdesk.changed', { ticketId: msg.ticketId, number: msg.number, reason: msg.reason, subject: msg.subject });
    if (this.self(msg.ticketId)) return;
    const receiver = this.last?.receiver ?? false;
    if (msg.reason === 'created' && receiver) this.d.notify(`New help desk ticket #${msg.number}`, msg.subject);
    else if (msg.reason === 'message') this.d.notify(`Ticket #${msg.number}: new reply`, msg.subject);
    else if (msg.reason === 'updated' && !receiver) this.d.notify(`Ticket #${msg.number} was updated`, msg.subject);
  }
}
