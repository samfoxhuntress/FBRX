import { randomInt } from 'node:crypto';
import { EDITION_PLANS, PROMO_CODE_ALPHABET, normalizePromoCode, promoCodeKey, promoGives, type PromoCodeView, type PromoRedeemed, type Tier } from '@fbrx/shared';
import type { AppContext } from '../context';
import { ids } from '../context';
import { badRequest, conflict } from '../errors';
import { changeCloudAiAccount } from './cloud-ai';
import { recordPurchase } from './entitlements';

/**
 * Promo codes the operator makes (FBRX Command → Cloud AI → Promo codes): extra FBRX Cloud AI tokens, Standard or
 * Ultra for some days, or both. An account uses each code once (in FBRX OS, on the website or in the phone apps); a
 * code works for a number of accounts, until a date, or until the operator turns it off.
 */

interface PromoRow {
  id: string;
  code: string;
  code_key: string;
  tokens: number;
  tier: Tier | null;
  days: number | null;
  max_redemptions: number | null;
  redemptions: number;
  expires_at: string | null;
  disabled_at: string | null;
  note: string;
  created_by: string;
  created_at: string;
}

export interface PromoInput {
  /** Empty: FBRX makes one up (FBRX-XXXX-XXXX). */
  code?: string;
  tokens: number;
  tier: 'basic' | 'ultra' | null;
  days: number | null;
  maxRedemptions: number | null;
  expiresAt: string | null;
  note: string;
}

export function promoView(r: PromoRow, now = new Date().toISOString()): PromoCodeView {
  return {
    id: r.id,
    code: r.code,
    tokens: r.tokens,
    tier: r.tier,
    days: r.days,
    maxRedemptions: r.max_redemptions,
    redemptions: r.redemptions,
    expiresAt: r.expires_at,
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
    status: r.disabled_at ? 'disabled' : r.expires_at && r.expires_at <= now ? 'expired' : r.max_redemptions !== null && r.redemptions >= r.max_redemptions ? 'used up' : 'active',
  };
}

const randomPromoCode = () => `FBRX-${Array.from({ length: 2 }, () => Array.from({ length: 4 }, () => PROMO_CODE_ALPHABET[randomInt(PROMO_CODE_ALPHABET.length)]).join('')).join('-')}`;

export function listPromos(ctx: AppContext): PromoCodeView[] {
  return ctx.db.all<PromoRow>('SELECT * FROM promo_codes ORDER BY created_at DESC, rowid DESC').map((r) => promoView(r));
}

export function getPromo(ctx: AppContext, id: string): PromoRow | undefined {
  return ctx.db.get<PromoRow>('SELECT * FROM promo_codes WHERE id = ?', id);
}

export function createPromo(ctx: AppContext, p: PromoInput, by: string): PromoCodeView {
  if (p.tokens <= 0 && !p.tier) throw badRequest('A promo code gives tokens, an edition for some days, or both');
  if (p.tier && !p.days) throw badRequest('Say for how many days the code gives the edition');
  const code = p.code?.trim() ? normalizePromoCode(p.code) : randomPromoCode();
  if (!code) throw badRequest('A promo code is 4 to 32 letters and digits (dashes between them are fine)');
  if (ctx.db.get('SELECT 1 FROM promo_codes WHERE code_key = ?', promoCodeKey(code))) throw conflict(`There is a promo code ${code} already`);
  const row: PromoRow = {
    id: ids.promo(),
    code,
    code_key: promoCodeKey(code),
    tokens: p.tokens,
    tier: p.tier,
    days: p.tier ? p.days : null,
    max_redemptions: p.maxRedemptions,
    redemptions: 0,
    expires_at: p.expiresAt,
    disabled_at: null,
    note: p.note,
    created_by: by,
    created_at: new Date().toISOString(),
  };
  ctx.db.run(
    'INSERT INTO promo_codes (id, code, code_key, tokens, tier, days, max_redemptions, expires_at, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    row.id,
    row.code,
    row.code_key,
    row.tokens,
    row.tier,
    row.days,
    row.max_redemptions,
    row.expires_at,
    row.note,
    row.created_by,
    row.created_at,
  );
  return promoView(row);
}

export function setPromoDisabled(ctx: AppContext, id: string, disabled: boolean): PromoCodeView | null {
  ctx.db.run('UPDATE promo_codes SET disabled_at = ? WHERE id = ?', disabled ? new Date().toISOString() : null, id);
  const r = getPromo(ctx, id);
  return r ? promoView(r) : null;
}

/** The accounts that used a code, newest first. */
export function promoRedemptions(ctx: AppContext, id: string): Array<{ accountId: string; email: string; redeemedAt: string }> {
  return ctx.db
    .all<{ account_id: string; email: string; redeemed_at: string }>('SELECT r.account_id, a.email, r.redeemed_at FROM promo_redemptions r JOIN accounts a ON a.id = r.account_id WHERE r.promo_id = ? ORDER BY r.redeemed_at DESC', id)
    .map((r) => ({ accountId: r.account_id, email: r.email, redeemedAt: r.redeemed_at }));
}

/** Uses a code for an account: its tokens become extra tokens, its edition a grant for its days. */
export function redeemPromo(ctx: AppContext, accountId: string, input: string): PromoRedeemed {
  const code = normalizePromoCode(input);
  const r = code ? ctx.db.get<PromoRow>('SELECT * FROM promo_codes WHERE code_key = ?', promoCodeKey(code)) : undefined;
  if (!r) throw badRequest('That promo code does not work: check it and try again');
  if (ctx.db.get('SELECT 1 FROM promo_redemptions WHERE promo_id = ? AND account_id = ?', r.id, accountId)) throw conflict('You have used that promo code already');
  const status = promoView(r).status;
  if (status !== 'active') throw badRequest(status === 'expired' ? 'That promo code has expired' : status === 'used up' ? 'That promo code has been used up' : 'That promo code was turned off');
  const now = new Date();
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO promo_redemptions (promo_id, account_id, redeemed_at) VALUES (?,?,?)', r.id, accountId, now.toISOString());
    ctx.db.run('UPDATE promo_codes SET redemptions = redemptions + 1 WHERE id = ?', r.id);
    if (r.tokens > 0) changeCloudAiAccount(ctx, accountId, { tokens: r.tokens });
    if (r.tier && r.days) {
      recordPurchase(ctx, {
        source: 'grant',
        externalId: `promo_${r.id}_${accountId}`,
        productId: EDITION_PLANS[r.tier].productId!,
        status: 'active',
        periodEnd: new Date(now.getTime() + r.days * 86_400_000).toISOString(),
        accountId,
      });
    }
  });
  return { code: r.code, tokens: r.tokens, tier: r.tier, days: r.days, message: `Added to your FBRX account: ${promoGives(r)}.` };
}
