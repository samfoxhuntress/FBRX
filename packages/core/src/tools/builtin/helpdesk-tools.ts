import { TICKET_CATEGORIES, TICKET_CATEGORY_NAMES, TICKET_STATUS_NAMES, type TicketSummary } from '@fbrx/shared';
import type { Helpdesk } from '../../fleet/helpdesk';
import type { ToolSpec } from '../types';

/**
 * The agent and the help desk: it can write up a problem for IT (the person approves the ticket before it goes) and
 * tell people where their tickets stand. On a receiver computer it can read the queue.
 */
export function helpdeskTools(helpdesk: Helpdesk, unavailable: () => string | null): ToolSpec[] {
  const tool = (t: Omit<ToolSpec, 'source' | 'sourceId' | 'unavailable'>): ToolSpec => ({ source: 'builtin', sourceId: null, unavailable, ...t });
  const line = (t: TicketSummary) => `- #${t.number} ${t.subject} — ${TICKET_STATUS_NAMES[t.status]}, ${t.priority}${t.assigneeName ? `, with ${t.assigneeName}` : ''}${t.deviceName ? `, from ${t.requesterName} (${t.deviceName})` : ''}, updated ${t.updatedAt}`;
  return [
    tool({
      name: 'helpdesk.send_ticket',
      title: 'Send a problem to IT',
      description:
        "Sends a help desk ticket to the organization's IT team through FBRX Command, with a short summary of this computer attached. Use it when the person wants IT to look at something you cannot fix, after you have tried the safe steps. Write the subject as the symptom (\"Projector in Room 12 shows no signal\") and the details as what happened and what was tried.",
      risk: 'write',
      inputSchema: {
        type: 'object',
        required: ['subject', 'details'],
        properties: {
          subject: { type: 'string', maxLength: 200 },
          details: { type: 'string', maxLength: 5000, description: 'What happened, since when, and what was already tried' },
          category: { type: 'string', enum: [...TICKET_CATEGORIES], description: Object.entries(TICKET_CATEGORY_NAMES).map(([k, v]) => `${k} = ${v}`).join('; ') },
          urgent: { type: 'boolean', description: 'True only when a class or meeting cannot go on' },
        },
      },
      async run(i) {
        const t = await helpdesk.create({ subject: i.subject, body: i.details, category: i.category ?? 'other', priority: i.urgent ? 'urgent' : 'normal', attachDiagnostics: true });
        return { output: `Sent to IT as ticket #${t.number}. Replies show up in the Help desk tab.`, data: { id: t.id, number: t.number } };
      },
    }),
    tool({
      name: 'helpdesk.tickets',
      title: 'Help desk tickets',
      description: "This computer's help desk tickets and where they stand. On a computer that receives the organization's tickets, queue=true lists everyone's open tickets.",
      risk: 'read',
      inputSchema: { type: 'object', properties: { queue: { type: 'boolean' }, closed: { type: 'boolean', description: 'Include resolved and closed tickets' } } },
      async run(i) {
        const list = await helpdesk.list(i.queue ? 'queue' : 'mine', i.closed ? 'all' : 'open');
        return { output: list.length ? list.map(line).join('\n') : i.queue ? 'The queue is empty.' : 'No tickets from this computer.', data: list };
      },
    }),
  ];
}
