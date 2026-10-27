import type { ProviderConfig } from '@fbrx/shared';

/**
 * How FBRX meets the agent the person chose: it is the banks of the river, not the river. Every agent gets the same
 * governance (policy, guardian, approvals), the same tools and the same memory; what changes is how much FBRX
 * scaffolds, by how much the agent can take in.
 *
 * - An agent that holds a long conversation (a cloud AI, a big model on a server) sees every tool, fully described,
 *   and does its own reasoning: FBRX leaves its thinking to it.
 * - A small one (a short context, as on a laptop's processor) sees the tools the chat is about, briefly described,
 *   so it is not swamped by reading them (tool-shortlist.ts).
 *
 * Either way the start of every request (the instructions and the tools) stays the same from one request to the next
 * and what is remembered rides with the person's latest message, so every provider reuses its reading (prompt caching).
 */
export interface AgentFit {
  /** "all": every tool it may use, fully described; "focused": the ones the chat is about, briefly described. */
  tools: 'all' | 'focused';
}

/** About 32K tokens: every tool's description (about 26,000 characters) takes under a third of what the agent holds. */
const ROOMY_CHARS = 80_000;

/** The fit for a provider: its own setting, or by how much it holds (its history budget, in characters). */
export function agentFit(cfg: Pick<ProviderConfig, 'tools'>, provider: { historyBudgetChars: number }): AgentFit {
  const chosen = cfg.tools ?? 'auto';
  if (chosen !== 'auto') return { tools: chosen };
  return { tools: provider.historyBudgetChars >= ROOMY_CHARS ? 'all' : 'focused' };
}
