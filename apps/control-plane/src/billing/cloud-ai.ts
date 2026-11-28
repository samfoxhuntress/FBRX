import { CLOUD_AI_ALLOWANCE, TIER_SHORT, formatTokens, maxTier, type CloudAiAccountView, type CloudAiModel, type CloudAiMonth, type CloudAiSettings, type CloudAiState, type CloudAiUsage, type Tier } from '@fbrx/shared';
import type { AppContext } from '../context';
import { HttpError } from '../errors';
import { parseJson } from '../routes/util';
import { accountTier } from './entitlements';

/**
 * FBRX Cloud AI's governance: each account's month (its allowance, what it used, its extra tokens) and what the
 * operator set for it, and whether a chat may go ahead. Only counts are kept, never what was said (see CloudAiUsage).
 */

/** The account fields FBRX Cloud AI needs. */
export interface CloudAiAccount {
  id: string;
  email: string;
  name: string;
  email_verified_at: string | null;
}

interface AiAccountRow {
  account_id: string;
  monthly_limit: number | null;
  credit: number;
  off: number;
  lifted_month: string | null;
  note: string;
}

interface UsageRow {
  month: string;
  input_tokens: number;
  output_tokens: number;
  counted: number;
  requests: number;
}

/** What the operator changes for one account (FBRX Command → Cloud AI). */
export interface CloudAiAccountChange {
  /** Its own monthly limit instead of its edition's; null goes back to the edition's. */
  monthlyLimit?: number | null;
  off?: boolean;
  /** Lets it go past its limit for the rest of this month (still counted, and the service budget still applies). */
  lift?: boolean;
  note?: string;
  /** Extra tokens to add (or, below zero, to take back). */
  tokens?: number;
}

const SETTINGS_KEY = 'cloud_ai.settings';

/** The month usage is counted in (UTC), as 2026-10. */
export const usageMonth = (at = new Date()) => at.toISOString().slice(0, 7);
/** When the month after `at` starts (UTC). */
export const nextMonthStart = (at = new Date()) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)).toISOString();

export function cloudAiModels(ctx: AppContext): CloudAiModel[] {
  return (ctx.config.cloud.ai?.models ?? []).map((m) => ({ id: m.id, weight: m.weight }));
}

/** What the operator set, over the defaults (CLOUD_AI_ALLOWANCE, no service budget). */
function savedSettings(ctx: AppContext): Partial<CloudAiSettings> {
  return parseJson<Partial<CloudAiSettings>>(ctx.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', SETTINGS_KEY)?.value, {});
}

export function cloudAiSettings(ctx: AppContext): CloudAiSettings {
  const saved = savedSettings(ctx);
  return { allowance: { ...CLOUD_AI_ALLOWANCE, ...saved.allowance }, budget: saved.budget ?? null };
}

export function saveCloudAiSettings(ctx: AppContext, patch: { allowance?: Partial<Record<Tier, number>>; budget?: number | null }): CloudAiSettings {
  const saved = savedSettings(ctx);
  // Only what the operator set is kept, so an edition they left alone follows FBRX's defaults.
  const next = { allowance: { ...saved.allowance, ...patch.allowance }, budget: patch.budget === undefined ? (saved.budget ?? null) : patch.budget };
  ctx.db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', SETTINGS_KEY, JSON.stringify(next));
  return cloudAiSettings(ctx);
}

/** Counted this month for everyone together. */
export function serviceUsage(ctx: AppContext, month = usageMonth()): { used: number; requests: number } {
  const r = ctx.db.get<{ used: number | null; requests: number | null }>('SELECT SUM(counted) AS used, SUM(requests) AS requests FROM ai_usage WHERE month = ?', month);
  return { used: Number(r?.used ?? 0), requests: Number(r?.requests ?? 0) };
}

function accountRow(ctx: AppContext, accountId: string): AiAccountRow {
  return ctx.db.get<AiAccountRow>('SELECT * FROM ai_accounts WHERE account_id = ?', accountId) ?? { account_id: accountId, monthly_limit: null, credit: 0, off: 0, lifted_month: null, note: '' };
}

function usageRow(ctx: AppContext, accountId: string, month: string): UsageRow {
  return ctx.db.get<UsageRow>('SELECT * FROM ai_usage WHERE account_id = ? AND month = ?', accountId, month) ?? { month, input_tokens: 0, output_tokens: 0, counted: 0, requests: 0 };
}

const monthView = (u: UsageRow): CloudAiMonth => ({ month: u.month, used: u.counted, inputTokens: u.input_tokens, outputTokens: u.output_tokens, requests: u.requests });

/** The edition FBRX Cloud AI follows: the account's own, or the fullest one an organization gives it. */
function cloudTier(ctx: AppContext, accountId: string): Tier {
  const given = ctx.db.all<{ tier: Tier }>("SELECT m.tier FROM tenant_members m JOIN tenants t ON t.id = m.tenant_id WHERE m.account_id = ? AND t.status = 'active'", accountId);
  return given.reduce<Tier>((t, m) => maxTier(t, m.tier), accountTier(ctx, accountId).tier);
}

const renewalDay = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });

/** Why a chat cannot go ahead, for the person whose chat it is. */
function blockedBecause(u: Omit<CloudAiUsage, 'message'>, settings: CloudAiSettings): string | null {
  switch (u.state) {
    case 'unavailable':
      return 'FBRX Cloud AI is not set up on this FBRX Command';
    case 'off':
      return 'FBRX Cloud AI is turned off for this account: contact FBRX support';
    case 'busy':
      return 'FBRX Cloud AI is not taking new chats right now. Try again later, or use the AI on your computer.';
    case 'limit': {
      if (u.allowance > 0) return `You have used this month’s FBRX Cloud AI (${formatTokens(u.allowance)} tokens). It renews on ${renewalDay(u.renewsAt)}, or a promo code adds tokens.`;
      if (u.needsEmail) return 'Confirm your FBRX account’s email to use FBRX Cloud AI: open the link FBRX sent you.';
      if (u.customLimit) return 'This account has no FBRX Cloud AI tokens this month. A promo code adds some.';
      const editions = (['basic', 'ultra'] as const).filter((t) => settings.allowance[t] > 0).map((t) => TIER_SHORT[t]);
      return editions.length ? `FBRX Cloud AI comes with ${editions.join(' and ')}, and a promo code adds tokens.` : 'A promo code adds FBRX Cloud AI tokens to your account.';
    }
    default:
      return null;
  }
}

/** An account's FBRX Cloud AI this month, and whether it takes a chat now. */
export function cloudAiUsage(ctx: AppContext, a: CloudAiAccount, at = new Date()): CloudAiUsage {
  const month = usageMonth(at);
  const settings = cloudAiSettings(ctx);
  const row = accountRow(ctx, a.id);
  const u = usageRow(ctx, a.id, month);
  const tier = cloudTier(ctx, a.id);
  const customLimit = row.monthly_limit !== null;
  // Free tokens need a confirmed email, so a throwaway address does not get a month of them.
  const needsEmail = !customLimit && tier === 'essentials' && settings.allowance.essentials > 0 && !a.email_verified_at;
  const allowance = customLimit ? row.monthly_limit! : needsEmail ? 0 : settings.allowance[tier];
  const state: CloudAiState = !ctx.config.cloud.ai
    ? 'unavailable'
    : row.off
      ? 'off'
      : settings.budget !== null && serviceUsage(ctx, month).used >= settings.budget
        ? 'busy'
        : u.counted < allowance
          ? 'ok'
          : row.lifted_month === month
            ? 'lifted'
            : row.credit > 0
              ? 'credit'
              : 'limit';
  const usage = {
    state,
    month,
    renewsAt: nextMonthStart(at),
    tier,
    allowance,
    customLimit,
    needsEmail,
    used: u.counted,
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    requests: u.requests,
    credit: row.credit,
    models: cloudAiModels(ctx),
  };
  return { ...usage, message: blockedBecause(usage, settings) };
}

const BLOCKED: Partial<Record<CloudAiState, [status: number, code: string]>> = {
  limit: [402, 'AI_LIMIT'],
  off: [403, 'AI_OFF'],
  busy: [503, 'AI_BUSY'],
  unavailable: [503, 'AI_UNAVAILABLE'],
};

/** Lets a chat go ahead, or says why it may not (as the HTTP error the computer shows). */
export function admitCloudAi(ctx: AppContext, a: CloudAiAccount): CloudAiUsage {
  const u = cloudAiUsage(ctx, a);
  const blocked = BLOCKED[u.state];
  if (blocked) throw new HttpError(blocked[0], u.message!, blocked[1]);
  return u;
}

/**
 * Counts a chat's tokens for the account, times the model's weight: against the month's allowance first, then its
 * extra tokens (none are spent while the limit is lifted). Returns what was counted.
 */
export function recordCloudAi(ctx: AppContext, a: CloudAiAccount, p: { inputTokens: number; outputTokens: number; weight: number }, at = new Date()): number {
  const month = usageMonth(at);
  const counted = Math.ceil((p.inputTokens + p.outputTokens) * p.weight);
  ctx.db.tx(() => {
    const before = cloudAiUsage(ctx, a, at);
    ctx.db.run(
      'INSERT INTO ai_usage (account_id, month, input_tokens, output_tokens, counted, requests) VALUES (?,?,?,?,?,1) ON CONFLICT(account_id, month) DO UPDATE SET input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens, counted = counted + excluded.counted, requests = requests + 1',
      a.id,
      month,
      p.inputTokens,
      p.outputTokens,
      counted,
    );
    const past = Math.max(0, before.used + counted - before.allowance) - Math.max(0, before.used - before.allowance);
    if (past > 0 && accountRow(ctx, a.id).lifted_month !== month) ctx.db.run('UPDATE ai_accounts SET credit = MAX(0, credit - ?) WHERE account_id = ?', past, a.id);
  });
  return counted;
}

/** Changes what the operator set for an account (or adds extra tokens from a promo code). */
export function changeCloudAiAccount(ctx: AppContext, accountId: string, p: CloudAiAccountChange) {
  const now = new Date().toISOString();
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO ai_accounts (account_id, updated_at) VALUES (?, ?) ON CONFLICT(account_id) DO NOTHING', accountId, now);
    if (p.monthlyLimit !== undefined) ctx.db.run('UPDATE ai_accounts SET monthly_limit = ? WHERE account_id = ?', p.monthlyLimit, accountId);
    if (p.off !== undefined) ctx.db.run('UPDATE ai_accounts SET off = ? WHERE account_id = ?', p.off ? 1 : 0, accountId);
    if (p.lift !== undefined) ctx.db.run('UPDATE ai_accounts SET lifted_month = ? WHERE account_id = ?', p.lift ? usageMonth() : null, accountId);
    if (p.note !== undefined) ctx.db.run('UPDATE ai_accounts SET note = ? WHERE account_id = ?', p.note, accountId);
    if (p.tokens) ctx.db.run('UPDATE ai_accounts SET credit = MAX(0, credit + ?) WHERE account_id = ?', p.tokens, accountId);
    ctx.db.run('UPDATE ai_accounts SET updated_at = ? WHERE account_id = ?', now, accountId);
  });
}

/** An account's FBRX Cloud AI as the operator sees it: this month, what they set, and the last year. */
export function cloudAiAccountView(ctx: AppContext, a: CloudAiAccount): CloudAiAccountView {
  const row = accountRow(ctx, a.id);
  const usage = cloudAiUsage(ctx, a);
  return {
    ...usage,
    accountId: a.id,
    email: a.email,
    name: a.name,
    off: !!row.off,
    lifted: row.lifted_month === usage.month,
    note: row.note,
    history: ctx.db.all<UsageRow>('SELECT * FROM ai_usage WHERE account_id = ? ORDER BY month DESC LIMIT 12', a.id).map(monthView),
  };
}
