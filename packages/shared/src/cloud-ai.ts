import { TIER_SHORT, type Tier } from './license';

/**
 * FBRX Cloud AI: models FBRX runs in the cloud for FBRX accounts. A computer signed in to an FBRX account sends its
 * chats to FBRX Command (OpenAI-compatible, under CLOUD_AI_PATH), which checks the account, counts its tokens and
 * passes the chat on to the model provider it holds the keys for. FBRX Command keeps the counts, never what was said.
 *
 * Each account has a month's allowance of tokens (its edition's, or a limit the operator set for it). Past it, extra
 * tokens are spent (from a promo code or the operator); with none left, it waits for the next month, unless the
 * operator lifts the limit for the rest of the month. A token is one read or written, times the model's weight (a large
 * model's count for more).
 */
export const CLOUD_AI_PATH = '/v1/ai';

/** The tokens a month each edition comes with, until the operator changes them (Essentials: with a confirmed email). */
export const CLOUD_AI_ALLOWANCE: Record<Tier, number> = { essentials: 0, basic: 1_000_000, ultra: 3_000_000, blackhole: 5_000_000 };

/**
 * Whether FBRX Cloud AI takes a chat from the account now:
 * - `ok`: within the month's allowance.
 * - `credit`: past it, spending extra tokens.
 * - `lifted`: past it, and the operator lifted the limit for the rest of the month.
 * - `limit`: the allowance and the extra tokens are used up (until the month renews).
 * - `off`: the operator turned FBRX Cloud AI off for the account.
 * - `busy`: the whole service reached what it may spend this month.
 * - `unavailable`: this FBRX Command has no FBRX Cloud AI set up.
 */
export const CLOUD_AI_STATES = ['ok', 'credit', 'lifted', 'limit', 'off', 'busy', 'unavailable'] as const;
export type CloudAiState = (typeof CLOUD_AI_STATES)[number];

/** A model FBRX Cloud AI offers, under FBRX's name for it. */
export interface CloudAiModel {
  id: string;
  /** Each token counts this many times. */
  weight: number;
}

/** An account's FBRX Cloud AI this month (GET /v1/accounts/ai). */
export interface CloudAiUsage {
  state: CloudAiState;
  /** Why it takes no chat now, in a sentence; null while it does. */
  message: string | null;
  /** The month counted, as 2026-10 (UTC). */
  month: string;
  /** When the next month's allowance starts. */
  renewsAt: string;
  /** The edition the allowance comes from: the account's own, or the fullest an organization gives it. */
  tier: Tier;
  /** Tokens this month. */
  allowance: number;
  /** The allowance is one the operator set for this account, not the edition's. */
  customLimit: boolean;
  /** Essentials' allowance waits for the account's email to be confirmed. */
  needsEmail: boolean;
  /** Counted this month (weighted), and what was read and written. */
  used: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  /** Extra tokens, spent once the allowance is used; they do not run out at the end of the month. */
  credit: number;
  models: CloudAiModel[];
}

/** One month of an account's FBRX Cloud AI. */
export interface CloudAiMonth {
  month: string;
  used: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

/** An account's FBRX Cloud AI as the operator sees it (FBRX Command → Cloud AI). */
export interface CloudAiAccountView extends CloudAiUsage {
  accountId: string;
  email: string;
  name: string;
  /** Turned off by the operator. */
  off: boolean;
  /** The limit is lifted for this month. */
  lifted: boolean;
  note: string;
  /** The last months, newest first. */
  history: CloudAiMonth[];
}

/** What the operator sets for the whole service (FBRX Command → Cloud AI → Settings). */
export interface CloudAiSettings {
  allowance: Record<Tier, number>;
  /** The most the service counts in a month for everyone together; past it, it takes no chats. Null: no limit. */
  budget: number | null;
}

export interface CloudAiOverview extends CloudAiSettings {
  available: boolean;
  models: CloudAiModel[];
  month: string;
  /** Counted this month, everyone together. */
  used: number;
  requests: number;
  /** Accounts that used it this month or have something set, most used first (or the ones a search found). */
  accounts: CloudAiAccountView[];
}

/**
 * A promo code: extra FBRX Cloud AI tokens, an edition for some days, or both. Each account uses a code once; a code
 * may be used by a number of accounts, until a date.
 */
export interface PromoCodeView {
  id: string;
  code: string;
  tokens: number;
  /** The edition it gives (Standard or Ultra), for `days`. */
  tier: Tier | null;
  days: number | null;
  /** How many accounts may use it (null: any number). */
  maxRedemptions: number | null;
  redemptions: number;
  expiresAt: string | null;
  note: string;
  createdBy: string;
  createdAt: string;
  status: 'active' | 'expired' | 'used up' | 'disabled';
}

/** A code an account used (POST /v1/accounts/promo). */
export interface PromoRedeemed {
  code: string;
  tokens: number;
  tier: Tier | null;
  days: number | null;
  /** What it gave, in a sentence. */
  message: string;
}

/** Promo codes FBRX makes up: FBRX- and two groups of four, without the characters that look alike (0 O 1 I L U). */
export const PROMO_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A promo code as typed (any case, spaces and dashes) in the form it is kept in, or null when it cannot be one. */
export function normalizePromoCode(input: string): string | null {
  const code = input.trim().toUpperCase().replace(/[\s_]+/g, '-').replace(/[^0-9A-Z-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return code.replace(/-/g, '').length >= 4 && code.length <= 32 ? code : null;
}

/** The key a promo code is found by: its letters and digits only, so "launch 50" finds LAUNCH-50. */
export const promoCodeKey = (code: string) => code.toUpperCase().replace(/[^0-9A-Z]/g, '');

/** "1.2M", "350K", "900" tokens. */
export function formatTokens(n: number): string {
  const abs = Math.abs(n);
  const short = (v: number, unit: string) => `${Number.isInteger(v) ? v : v.toFixed(1).replace(/\.0$/, '')}${unit}`;
  if (abs >= 1_000_000) return short(n / 1_000_000, 'M');
  if (abs >= 10_000) return short(Math.round(n / 1000), 'K');
  return n.toLocaleString('en-US');
}

/** A number of tokens as typed: "250000", "250K", "1.5M" (null when it is not one). */
export function parseTokens(input: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(input.trim().replace(/,/g, ''));
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2]?.toLowerCase() === 'm' ? 1_000_000 : m[2]?.toLowerCase() === 'k' ? 1000 : 1));
}

/** What a promo code gives, in a sentence: "500K FBRX Cloud AI tokens and Ultra for 30 days". */
export function promoGives(p: { tokens: number; tier: Tier | null; days: number | null }): string {
  const parts = [p.tokens > 0 ? `${formatTokens(p.tokens)} FBRX Cloud AI tokens` : '', p.tier && p.days ? `${TIER_SHORT[p.tier]} for ${p.days} day${p.days === 1 ? '' : 's'}` : ''].filter(Boolean);
  return parts.join(' and ');
}
