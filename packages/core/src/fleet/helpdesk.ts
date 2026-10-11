import {
  AssistRequestSchema,
  TicketCreateSchema,
  TicketReplySchema,
  TicketUpdateSchema,
  type AssistAction,
  type AssistJob,
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
  /** Requests this computer made to askers' computers, per ticket, newest first. */
  private readonly jobs = new Map<string, AssistJob[]>();

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

  /**
   * A receiver works on the asker's computer: FBRX Command hands the request over, and this computer follows it until
   * the answer arrives (`helpdesk.assist` events), for as long as the asker's computer may take to come online.
   */
  async assist(ticketId: string, action: AssistAction, text = ''): Promise<AssistJob> {
    const body = AssistRequestSchema.parse({ action, text, helperName: this.d.requesterName() });
    const job = await this.d.fleet.request<AssistJob>('POST', `/v1/device/helpdesk/tickets/${encodeURIComponent(ticketId)}/assist`, body);
    this.mine(ticketId);
    this.keep(job);
    void this.follow(job);
    return job;
  }

  assistJobs(ticketId: string): AssistJob[] {
    return this.jobs.get(ticketId) ?? [];
  }

  private keep(job: AssistJob) {
    const list = (this.jobs.get(job.ticketId) ?? []).filter((j) => j.id !== job.id);
    this.jobs.set(job.ticketId, [job, ...list].slice(0, 50));
    this.d.events.emit('helpdesk.assist', job);
  }

  private async follow(job: AssistJob) {
    const until = Date.now() + 35 * 60_000;
    let cur = job;
    let wait = 1000;
    while (!['succeeded', 'failed', 'expired', 'cancelled'].includes(cur.status) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait + 500, 5000);
      try {
        const next = await this.d.fleet.request<AssistJob>('GET', `/v1/device/helpdesk/assist/${encodeURIComponent(job.id)}`);
        if (next.status !== cur.status || next.completedAt !== cur.completedAt) this.keep(next);
        cur = next;
      } catch (err) {
        this.d.log.debug('Help desk request not followed', { error: String(err) });
      }
    }
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
