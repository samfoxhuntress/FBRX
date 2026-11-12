import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CLOUD_AI_PATH, parseSse, type CloudAiOverview, type CloudAiSettings, type PromoCodeView } from '@fbrx/shared';
import type { AppContext } from '../context';
import type { Actor } from '../audit';
import { adminAuth, requirePerm } from '../auth';
import { badRequest, HttpError, notFound } from '../errors';
import { accountActor, accountAuth, accountView, type AccountRow } from './accounts';
import { admitCloudAi, changeCloudAiAccount, cloudAiAccountView, cloudAiModels, cloudAiSettings, cloudAiUsage, recordCloudAi, saveCloudAiSettings, serviceUsage, usageMonth } from '../billing/cloud-ai';
import { createPromo, getPromo, listPromos, promoRedemptions, redeemPromo, setPromoDisabled } from '../billing/promos';

/**
 * FBRX Cloud AI (FBRX Command in the cloud). Computers signed in to an FBRX account chat with FBRX's models here, the
 * OpenAI way (`/v1/ai/models`, `/v1/ai/chat/completions`, the account token as the key): FBRX Command checks the
 * account may (billing/cloud-ai.ts), passes the chat on to the model provider with the key only it holds, streams the
 * answer back and counts its tokens. Neither the chat nor the answer is kept or logged.
 *
 * Accounts see their month (GET /v1/accounts/ai) and use promo codes (POST /v1/accounts/promo); the platform operator
 * sees everyone's, sets allowances and the service's budget, lifts or turns off an account, adds tokens, and makes
 * promo codes (/v1/admin/ai, /v1/admin/promos).
 */

/** The longest answer one chat may ask for, in tokens. */
const MAX_OUTPUT_TOKENS = 8192;
/** Chats one account may have going at once. */
const MAX_OPEN_CHATS = 4;
/** A chat may carry pictures. */
const MAX_CHAT_BYTES = 24 * 1024 * 1024;

/** What FBRX Cloud AI passes on from a chat request (anything else is left out). */
const ChatSchema = z.object({
  model: z.string().max(200).optional(),
  messages: z.array(z.record(z.string(), z.unknown())).min(1).max(4000),
  tools: z.array(z.record(z.string(), z.unknown())).max(512).optional(),
  tool_choice: z.unknown().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().min(1).optional(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
  response_format: z.record(z.string(), z.unknown()).optional(),
  stream: z.boolean().optional(),
});

const Tokens = z.number().int().min(0).max(1_000_000_000_000);

/** A day (2026-12-31, to its end) or a moment. */
const Until = z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/).transform((d) => `${d}T23:59:59.999Z`), z.string().datetime({ offset: true }).transform((t) => new Date(t).toISOString())]);

type Usage = { prompt_tokens?: number; completion_tokens?: number } | null | undefined;

/**
 * About how many tokens a chat's messages are (four characters to a token, a picture as a thousand), for an answer cut
 * off before the provider said what it counted.
 */
function estimateTokens(body: z.infer<typeof ChatSchema>): number {
  let chars = body.tools ? JSON.stringify(body.tools).length : 0;
  for (const m of body.messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) for (const part of m.content as Array<{ type?: string; text?: string }>) chars += part.type === 'text' ? (part.text?.length ?? 0) : 4000;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(chars / 4);
}

/** The characters an answer's piece adds (its text, its thinking, its tool calls). */
function answerChars(delta: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } | undefined): number {
  if (!delta) return 0;
  const text = (v: unknown) => (typeof v === 'string' ? v.length : 0);
  return text(delta.content) + text(delta.reasoning_content) + text(delta.reasoning) + (delta.tool_calls ?? []).reduce((n, c) => n + text(c.function?.name) + text(c.function?.arguments), 0);
}

/** The model provider's error message, if it gave one. */
async function upstreamMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    return (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? text.slice(0, 300);
  } catch {
    return text.slice(0, 300) || res.statusText;
  }
}

export async function cloudAiRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = accountAuth(ctx);
  /** Chats going now, per account. */
  const open = new Map<string, number>();

  const upstream = () => {
    const ai = ctx.config.cloud.ai;
    if (!ai) throw new HttpError(503, 'FBRX Cloud AI is not set up on this FBRX Command', 'AI_UNAVAILABLE');
    return ai;
  };

  app.get(`${CLOUD_AI_PATH}/models`, { preHandler: auth }, async () => {
    upstream();
    return { object: 'list', data: cloudAiModels(ctx).map((m) => ({ id: m.id, object: 'model', owned_by: 'fbrx', weight: m.weight })) };
  });

  app.post(
    `${CLOUD_AI_PATH}/chat/completions`,
    // A sign-in at a time (each computer has its own), so one busy computer does not hold up another.
    { preHandler: auth, bodyLimit: MAX_CHAT_BYTES, config: { rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => req.headers.authorization ?? req.ip } } },
    async (req, reply) => {
      const ai = upstream();
      const a = req.account!;
      admitCloudAi(ctx, a);
      const body = ChatSchema.parse(req.body);
      const model = body.model && body.model !== 'default' ? ai.models.find((m) => m.id === body.model) : ai.models[0];
      if (!model) throw badRequest(`FBRX Cloud AI has no model "${body.model}": it has ${ai.models.map((m) => m.id).join(', ')}`);
      if ((open.get(a.id) ?? 0) >= MAX_OPEN_CHATS) throw new HttpError(429, 'Too many chats at once on FBRX Cloud AI: wait for one to finish', 'AI_BUSY');

      open.set(a.id, (open.get(a.id) ?? 0) + 1);
      const abort = new AbortController();
      // The computer went away (the person stopped the answer): stop the provider too.
      reply.raw.on('close', () => abort.abort());
      const count = (usage: Usage, outChars: number) =>
        recordCloudAi(ctx, a, { inputTokens: usage?.prompt_tokens ?? estimateTokens(body), outputTokens: usage?.completion_tokens ?? Math.ceil(outChars / 4), weight: model.weight });
      try {
        const { stream, max_tokens, ...rest } = body;
        let res: Response;
        try {
          res = await fetch(`${ai.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { authorization: `Bearer ${ai.apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              ...rest,
              model: model.upstream,
              max_tokens: Math.min(max_tokens ?? MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS),
              stream: !!stream,
              ...(stream ? { stream_options: { include_usage: true } } : {}),
            }),
            signal: abort.signal,
          });
        } catch (err) {
          req.log.warn({ err: (err as Error).message }, 'FBRX Cloud AI could not reach its model provider');
          throw new HttpError(502, 'FBRX Cloud AI could not reach its models: try again in a moment', 'AI_UPSTREAM');
        }
        if (!res.ok || !res.body) {
          const said = (await upstreamMessage(res)).replaceAll(model.upstream, model.id);
          req.log.warn({ status: res.status }, 'FBRX Cloud AI model provider did not take a chat');
          // What was wrong with the chat itself (too long for the model, say) is worth telling; the rest is FBRX's.
          if (res.status === 400 || res.status === 413 || res.status === 422) throw badRequest(`FBRX Cloud AI could not take that chat: ${said}`);
          if (res.status === 429) throw new HttpError(503, 'FBRX Cloud AI is busy: try again in a moment', 'AI_BUSY');
          throw new HttpError(502, 'FBRX Cloud AI could not answer just now: try again in a moment', 'AI_UPSTREAM');
        }

        if (!stream) {
          const answer = (await res.json()) as { model?: string; usage?: Usage; choices?: Array<{ message?: Parameters<typeof answerChars>[0] }> };
          count(answer.usage, (answer.choices ?? []).reduce((n, c) => n + answerChars(c.message), 0));
          return { ...answer, model: model.id };
        }

        // Passed on as it comes, under FBRX's name for the model; the provider's count comes last (include_usage).
        reply.hijack();
        reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
        let usage: Usage = null;
        let outChars = 0;
        try {
          for await (const ev of parseSse(res.body)) {
            if (ev.data === '[DONE]') break;
            let chunk: { model?: string; usage?: Usage; choices?: Array<{ delta?: Parameters<typeof answerChars>[0] }> };
            try {
              chunk = JSON.parse(ev.data);
            } catch {
              continue;
            }
            if (chunk.usage) usage = chunk.usage;
            for (const c of chunk.choices ?? []) outChars += answerChars(c.delta);
            reply.raw.write(`data: ${JSON.stringify({ ...chunk, model: model.id })}\n\n`);
          }
          reply.raw.write('data: [DONE]\n\n');
        } catch (err) {
          if (!abort.signal.aborted) req.log.warn({ err: (err as Error).message }, 'FBRX Cloud AI answer was cut off');
        } finally {
          // A stopped answer still counts what was read and written so far.
          count(usage, outChars);
          reply.raw.end();
        }
        return reply;
      } finally {
        const n = (open.get(a.id) ?? 1) - 1;
        if (n > 0) open.set(a.id, n);
        else open.delete(a.id);
      }
    },
  );

  // ------------------------------------------------------------------------------------------------ the account's own
  app.get('/v1/accounts/ai', { preHandler: auth }, async (req) => cloudAiUsage(ctx, req.account!));

  app.post('/v1/accounts/promo', { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const a = req.account!;
    const { code } = z.object({ code: z.string().max(64) }).parse(req.body);
    const redeemed = redeemPromo(ctx, a.id, code);
    ctx.audit.record(accountActor(a, req), 'promo.redeemed', { type: 'account', id: a.id }, { code: redeemed.code });
    return { redeemed, account: accountView(ctx, a), ai: cloudAiUsage(ctx, a) };
  });

  // ------------------------------------------------------------------------------------------- the platform operator
  await app.register(async (admin) => {
    admin.addHook('preHandler', adminAuth(ctx));
    const operator = (req: FastifyRequest): Actor => {
      const p = requirePerm(req, 'tenants.manage');
      return { type: 'user', id: p.id, label: p.label, tenantId: null, ip: req.ip };
    };
    const account = (req: FastifyRequest) => {
      const a = ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', (req.params as { id: string }).id);
      if (!a) throw notFound('No such account');
      return a;
    };
    const promo = (req: FastifyRequest) => {
      const id = (req.params as { id: string }).id;
      if (!getPromo(ctx, id)) throw notFound('No such promo code');
      return id;
    };

    /** The month so far: the service, and the accounts that used it (or have something set), most used first. */
    admin.get('/v1/admin/ai', async (req): Promise<CloudAiOverview> => {
      requirePerm(req, 'tenants.manage');
      const q = String((req.query as Record<string, string>)?.q ?? '').trim();
      const month = usageMonth();
      const rows = q
        ? ctx.db.all<AccountRow>('SELECT * FROM accounts WHERE email LIKE ? OR name LIKE ? ORDER BY created_at DESC LIMIT 100', `%${q}%`, `%${q}%`)
        : ctx.db.all<AccountRow>(
            'SELECT a.* FROM accounts a LEFT JOIN ai_usage u ON u.account_id = a.id AND u.month = ? LEFT JOIN ai_accounts s ON s.account_id = a.id WHERE u.account_id IS NOT NULL OR s.account_id IS NOT NULL ORDER BY COALESCE(u.counted, 0) DESC, a.email LIMIT 100',
            month,
          );
      return { available: !!ctx.config.cloud.ai, models: cloudAiModels(ctx), month, ...serviceUsage(ctx, month), ...cloudAiSettings(ctx), accounts: rows.map((a) => cloudAiAccountView(ctx, a)) };
    });

    /** Each edition's monthly allowance, and the most the whole service counts in a month (null: no limit). */
    admin.post('/v1/admin/ai/settings', async (req): Promise<CloudAiSettings> => {
      const actor = operator(req);
      const body = z.object({ allowance: z.object({ essentials: Tokens, basic: Tokens, ultra: Tokens, blackhole: Tokens }).partial().optional(), budget: Tokens.nullable().optional() }).parse(req.body);
      const settings = saveCloudAiSettings(ctx, body);
      ctx.audit.record(actor, 'ai.settings', { type: 'cloud-ai' }, body);
      return settings;
    });

    admin.get('/v1/admin/ai/accounts/:id', async (req) => {
      requirePerm(req, 'tenants.manage');
      return cloudAiAccountView(ctx, account(req));
    });

    /** Its own monthly limit, turned off or on, the limit lifted for this month, a note, extra tokens. */
    admin.post('/v1/admin/ai/accounts/:id', async (req) => {
      const actor = operator(req);
      const a = account(req);
      const body = z
        .object({ monthlyLimit: Tokens.nullable().optional(), off: z.boolean().optional(), lift: z.boolean().optional(), note: z.string().max(500).optional(), tokens: z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000).optional() })
        .parse(req.body);
      changeCloudAiAccount(ctx, a.id, body);
      ctx.audit.record(actor, 'ai.account.changed', { type: 'account', id: a.id }, body);
      return cloudAiAccountView(ctx, a);
    });

    admin.get('/v1/admin/promos', async (req): Promise<PromoCodeView[]> => {
      requirePerm(req, 'tenants.manage');
      return listPromos(ctx);
    });

    admin.post('/v1/admin/promos', async (req): Promise<PromoCodeView> => {
      const actor = operator(req);
      const body = z
        .object({
          code: z.string().max(64).optional(),
          tokens: Tokens.default(0),
          tier: z.enum(['basic', 'ultra']).nullable().default(null),
          days: z.number().int().min(1).max(3650).nullable().default(null),
          maxRedemptions: z.number().int().min(1).nullable().default(null),
          expiresAt: Until.nullable().default(null),
          note: z.string().max(500).default(''),
        })
        .parse(req.body);
      const made = createPromo(ctx, body, actor.label);
      ctx.audit.record(actor, 'promo.created', { type: 'promo', id: made.id }, { code: made.code, tokens: made.tokens, tier: made.tier, days: made.days, maxRedemptions: made.maxRedemptions, expiresAt: made.expiresAt });
      return made;
    });

    /** Turns a code off (or back on). */
    admin.post('/v1/admin/promos/:id', async (req) => {
      const actor = operator(req);
      const id = promo(req);
      const { disabled } = z.object({ disabled: z.boolean() }).parse(req.body);
      ctx.audit.record(actor, disabled ? 'promo.disabled' : 'promo.enabled', { type: 'promo', id });
      return setPromoDisabled(ctx, id, disabled);
    });

    admin.get('/v1/admin/promos/:id/redemptions', async (req) => {
      requirePerm(req, 'tenants.manage');
      return promoRedemptions(ctx, promo(req));
    });
  });
}
