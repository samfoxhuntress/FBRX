import type { AiUsageReport, CloudAiUsage, TokenUsage } from '@fbrx/shared';
import type { MetaStore } from '../storage/meta';

/** One month of AI use on this computer: by model, and by day. */
export interface UsageMonth {
  models: Record<string, { providerId: string; model: string; cloud: boolean; inputTokens: number; outputTokens: number; runs: number }>;
  days: Record<string, { inputTokens: number; outputTokens: number; runs: number }>;
}

const KEY = 'ai.usage';
/** How many months are kept. */
const MONTHS = 12;

/** "2026-10", in the computer's own time (a month here is the person's month). */
export function monthOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const dayOf = (d: Date) => `${monthOf(d)}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * The tokens every agent run on this computer read and wrote, by month, model and day: what the AI usage page shows, and
 * what the monthly cloud AI budget is counted against. Only counts are kept, never what was said.
 */
export class UsageLedger {
  constructor(
    private readonly meta: MetaStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private all(): Record<string, UsageMonth> {
    return this.meta.get<Record<string, UsageMonth>>(KEY) ?? {};
  }

  record(r: { providerId: string; model: string; cloud: boolean; usage: TokenUsage }): void {
    const { inputTokens, outputTokens } = r.usage;
    if (!inputTokens && !outputTokens) return;
    const at = this.now();
    const all = this.all();
    const m = (all[monthOf(at)] ??= { models: {}, days: {} });
    const model = (m.models[`${r.providerId}/${r.model}`] ??= { providerId: r.providerId, model: r.model, cloud: r.cloud, inputTokens: 0, outputTokens: 0, runs: 0 });
    const day = (m.days[dayOf(at)] ??= { inputTokens: 0, outputTokens: 0, runs: 0 });
    for (const t of [model, day]) {
      t.inputTokens += inputTokens;
      t.outputTokens += outputTokens;
      t.runs++;
    }
    const keep = Object.keys(all).sort().slice(-MONTHS);
    this.meta.set(KEY, Object.fromEntries(keep.map((k) => [k, all[k]])));
  }

  month(month = monthOf(this.now())): UsageMonth {
    return this.all()[month] ?? { models: {}, days: {} };
  }

  /** Tokens cloud models read and wrote this month (what the monthly budget counts). */
  cloudUsed(): number {
    return Object.values(this.month().models)
      .filter((m) => m.cloud)
      .reduce((n, m) => n + m.inputTokens + m.outputTokens, 0);
  }
}

/** What the AI usage page shows: this month here, the agent chats use now, and the account's FBRX Cloud AI. */
export async function usageReport(d: {
  ledger: UsageLedger;
  /** A provider's name, by its id. */
  providerName: (id: string) => string;
  budget: number;
  agent: () => AiUsageReport['agent'];
  /** The FBRX account's FBRX Cloud AI, when one is signed in (null otherwise). */
  cloudAi: () => Promise<CloudAiUsage> | null;
  now?: Date;
}): Promise<AiUsageReport> {
  const now = d.now ?? new Date();
  const month = monthOf(now);
  const m = d.ledger.month(month);
  const models = Object.values(m.models)
    .map((x) => ({ ...x, providerName: d.providerName(x.providerId) }))
    .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
  const days = Array.from({ length: now.getDate() }, (_, i) => {
    const day = `${month}-${String(i + 1).padStart(2, '0')}`;
    return { day, inputTokens: m.days[day]?.inputTokens ?? 0, outputTokens: m.days[day]?.outputTokens ?? 0 };
  });
  let agent: AiUsageReport['agent'] = null;
  try {
    agent = d.agent();
  } catch {
    /* no provider ready: the page says so */
  }
  const cloudAi = await (d.cloudAi() ?? Promise.resolve(null)).catch(() => null);
  return {
    month,
    inputTokens: models.reduce((n, x) => n + x.inputTokens, 0),
    outputTokens: models.reduce((n, x) => n + x.outputTokens, 0),
    runs: models.reduce((n, x) => n + x.runs, 0),
    cloudTokens: models.filter((x) => x.cloud).reduce((n, x) => n + x.inputTokens + x.outputTokens, 0),
    budget: d.budget,
    models,
    days,
    agent,
    cloudAi,
  };
}
