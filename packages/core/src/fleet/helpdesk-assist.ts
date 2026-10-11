import { CoreError } from '../errors';
import type { ApprovalQueue } from '../governance/approvals';

export interface AssistPayload {
  ticketId: string;
  ticketNumber: number;
  subject: string;
  helper: string;
  action: 'diagnostics' | 'ask' | 'run';
  text: string;
}

export interface HelpdeskAssistDeps {
  /** Settings → help desk: ask once per ticket, allow, or never. */
  mode: () => 'ask' | 'allow' | 'off';
  approvals: ApprovalQueue;
  approvalSeconds: () => number;
  diagnostics: () => Promise<Record<string, unknown>>;
  /** This computer's agent answers (and may use its tools, as the policy allows for remote requests). */
  ask: (prompt: string, actor: string) => Promise<{ status: string; answer: string; error?: string }>;
  /**
   * Runs a command through the tool gate (policy and guardian always apply). "approved": the person here just said
   * yes to this very command, so the gate does not ask again; "remote": the policy decides whether to ask.
   */
  run: (command: string, actor: string, consent: 'approved' | 'remote') => Promise<{ ok: boolean; status: string; output: string; error?: string }>;
  notify: (title: string, body: string) => void;
  agentName: () => string;
}

/** How long the person's yes lasts for one ticket. */
const GRANT_MS = 2 * 3600_000;

/**
 * The asking computer's side of help desk assistance: a receiver working on its ticket wants to look at how it is
 * doing, ask its AI, or run a command. The person here lets the help desk in once per ticket (unless the
 * organization allows it outright), sees a notification for each request, and approves commands as the policy asks.
 */
export class HelpdeskAssistHost {
  private readonly grants = new Map<string, number>();
  /** One question to the person at a time per ticket, however many requests arrive together. */
  private readonly asking = new Map<string, Promise<boolean>>();

  constructor(private readonly d: HelpdeskAssistDeps) {}

  async handle(p: AssistPayload): Promise<unknown> {
    const mode = this.d.mode();
    if (mode === 'off') throw new CoreError('FORBIDDEN', 'This computer does not let the help desk work on it (its Settings → Messages → Help desk)');
    if (mode === 'ask' && !(await this.allowed(p))) throw new CoreError('FORBIDDEN', 'The person at the computer said no');
    const actor = `helpdesk:${p.helper}`;
    const ticket = `ticket #${p.ticketNumber}`;
    switch (p.action) {
      case 'diagnostics':
        this.d.notify(`${p.helper} is checking this computer`, `For ${ticket} (${p.subject}). Nothing is changed.`);
        return this.d.diagnostics();
      case 'ask': {
        this.d.notify(`${p.helper} asked ${this.d.agentName()} something`, `For ${ticket}: ${p.text.slice(0, 160)}`);
        const r = await this.d.ask(
          [
            `Someone from the help desk (${p.helper}) is helping with ${ticket}, “${p.subject}”, sent from this computer. Answer their question about this computer.`,
            'Look things up with your tools where that helps; anything that changes the computer still needs the approval of the person at it.',
            '',
            p.text,
          ].join('\n'),
          actor,
        );
        return { status: r.status, answer: r.answer, ...(r.error ? { error: r.error } : {}) };
      }
      case 'run': {
        // The person approves each command themselves (unless the organization lets the help desk in outright, when
        // the policy decides, as for any remote request).
        if (mode === 'ask') {
          this.d.notify(`${p.helper} wants to run a command`, `For ${ticket}: ${p.text.slice(0, 160)}. Approve or deny it under Approvals.`);
          const a = await this.d.approvals.request(
            { runId: null, tool: 'shell.run', toolTitle: `Run a command for ${p.helper} (help desk)`, risk: 'execute', input: { command: p.text }, reason: `${p.helper} from the help desk wants to run this command for your ${ticket} (“${p.subject}”).`, origin: 'remote', findings: [] },
            this.d.approvalSeconds(),
          );
          if (a.decision !== 'approve') return { ok: false, status: 'denied', output: a.decision === 'expired' ? 'Nobody answered at the computer in time.' : 'The person at the computer said no.' };
          const r = await this.d.run(p.text, actor, 'approved');
          return { ok: r.ok, status: r.status, output: r.output, ...(r.error ? { error: r.error } : {}) };
        }
        this.d.notify(`${p.helper} is running a command`, `For ${ticket}: ${p.text.slice(0, 160)}`);
        const r = await this.d.run(p.text, actor, 'remote');
        return { ok: r.ok, status: r.status, output: r.output, ...(r.error ? { error: r.error } : {}) };
      }
    }
  }

  private async allowed(p: AssistPayload): Promise<boolean> {
    const until = this.grants.get(p.ticketId) ?? 0;
    if (until > Date.now()) return true;
    let pending = this.asking.get(p.ticketId);
    if (!pending) {
      const what = p.action === 'diagnostics' ? 'check how this computer is doing' : p.action === 'ask' ? `ask ${this.d.agentName()} about it` : 'run a command on it';
      this.d.notify(`${p.helper} from the help desk would like to help`, `For ticket #${p.ticketNumber}: allow it under Approvals.`);
      pending = this.d.approvals
        .request(
          {
            runId: null,
            tool: 'helpdesk.assist',
            toolTitle: `Let ${p.helper} from the help desk work on this computer`,
            risk: 'read',
            input: { ticket: `#${p.ticketNumber} ${p.subject}`, first: what, ...(p.text ? { text: p.text.slice(0, 500) } : {}) },
            reason: `${p.helper} is working on your ticket #${p.ticketNumber} (“${p.subject}”) and wants to ${what}. Allowing it lets them check this computer and ask ${this.d.agentName()} for the next 2 hours; any command they want to run asks you first.`,
            origin: 'remote',
            findings: [],
          },
          this.d.approvalSeconds(),
        )
        .then((a) => {
          if (a.decision === 'approve') this.grants.set(p.ticketId, Date.now() + GRANT_MS);
          return a.decision === 'approve';
        })
        .finally(() => this.asking.delete(p.ticketId));
      this.asking.set(p.ticketId, pending);
    }
    return pending;
  }
}
