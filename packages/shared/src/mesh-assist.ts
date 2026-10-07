/**
 * Mesh Assist: computers on the mesh lending each other their AI. When one computer's agent runs out of steps or its
 * AI provider stops answering (credits, quota, rate limits, an outage), another computer's agent can take the task
 * over; an agent can also consult another computer's agent mid-task, back and forth. Controllers (a server run as
 * administrator, trusted for it) can hand work to other computers without asking.
 */

/** How urgent a request for help is: higher ones go first; "urgent" (from a controller) may stop lower help. */
export const ASSIST_PRIORITIES = ['background', 'normal', 'high', 'urgent'] as const;
export type AssistPriority = (typeof ASSIST_PRIORITIES)[number];

/** Off, ask the person first, or go ahead on its own. */
export const ASSIST_MODES = ['off', 'ask', 'auto'] as const;
export type AssistMode = (typeof ASSIST_MODES)[number];

/** What a helper may do on its own computer while helping: think only, look things up, or what its policy allows. */
export const ASSIST_TOOLS = ['none', 'read', 'all'] as const;
export type AssistTools = (typeof ASSIST_TOOLS)[number];

/**
 * consult: answer a question or do a piece of work and report back; continue: take over a task another computer's
 * agent could not finish; task: work handed out by a person or a controller.
 */
export type AssistKind = 'consult' | 'continue' | 'task';
/** Why help was asked: the agent chose to, it ran out of steps, its AI provider failed, a person, or a controller. */
export type AssistTrigger = 'agent' | 'steps' | 'provider' | 'person' | 'controller';
export type AssistStatus = 'waiting-approval' | 'queued' | 'running' | 'done' | 'denied' | 'error' | 'cancelled';

/** Server roles a computer announces (FBRX Server runs one or more; more arrive with later products). */
export const SERVER_ROLES = ['ai', 'virtual', 'command', 'dns', 'directory', 'files', 'gate', 'minidome'] as const;
export type ServerRole = (typeof SERVER_ROLES)[number];

/** A computer's answer to "could you help?". */
export interface AssistOffer {
  deviceId: string;
  name: string;
  /** How it would treat a request from the asker right now. */
  accepts: AssistMode;
  reason: string | null;
  ai: { ready: boolean; provider: string | null; model: string | null; local: boolean };
  busy: number;
  queued: number;
  capacity: number;
  load: { cpu: number | null; memUsedPct: number | null };
  roles: string[];
  /** The highest priority the asker may use there. */
  maxPriority: AssistPriority;
}

export interface AssistSession {
  id: string;
  /** "out": help this computer asked for; "in": help this computer gives. */
  direction: 'in' | 'out';
  peerId: string;
  peerName: string;
  kind: AssistKind;
  trigger: AssistTrigger;
  priority: AssistPriority;
  /** Sent by a computer running as administrator (a controller's request when the receiver trusts it for that). */
  admin: boolean;
  status: AssistStatus;
  goal: string;
  answer: string;
  error: string | null;
  steps: number;
  tools: string[];
  createdAt: string;
  finishedAt: string | null;
  /** Help given here: the chat on this computer that holds the work. */
  conversationId: string | null;
  /** Help asked from here: the session on the helper (follow-ups continue it). */
  remoteId: string | null;
}

export const ASSIST_TERMINAL: readonly AssistStatus[] = ['done', 'denied', 'error', 'cancelled'];

export const assistRank = (p: AssistPriority) => ASSIST_PRIORITIES.indexOf(p);
