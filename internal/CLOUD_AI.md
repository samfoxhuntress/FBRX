# Running FBRX Cloud AI

Setting up FBRX Cloud AI on the account server, and its API. How it works for people: [CLOUD_AI.md](../docs/CLOUD_AI.md).

## Setting it up

On the account server (`deploy/control-plane/.env`):

| Variable | |
| --- | --- |
| `FBRX_AI_UPSTREAM_URL` | The model provider's OpenAI-compatible address, such as `https://api.provider.example/v1` |
| `FBRX_AI_UPSTREAM_KEY` | Its API key. It never leaves FBRX Command |
| `FBRX_AI_MODELS` | The models offered, under FBRX's names: `name=provider-model`, comma-separated, the first one the default; `*3` after one counts each of its tokens three times. For example `fbrx-everyday=org/model-a,fbrx-thorough=org/model-b*3` |

Choose a provider whose terms keep none of the API's traffic and never train on it, set a spending limit there as well
as the service budget here, and check each model's license allows serving it to others. Without the three variables,
FBRX Cloud AI stays off: accounts are told it is not set up, and allowances and promo codes can be prepared anyway.

## The API

| | |
| --- | --- |
| `GET /v1/ai/models` | The models, under FBRX's names, with their weight |
| `POST /v1/ai/chat/completions` | OpenAI Chat Completions with the account token as the bearer key, streamed or whole; `model` is FBRX's name (empty: the first) |
| `GET /v1/accounts/ai` | The account's month (`CloudAiUsage`): its state, why it takes no chat (`message`), the allowance, what it used, extra tokens, when it renews |
| `POST /v1/accounts/promo` `{ code }` | Uses a promo code: answers with what it gave, the account and its month |

The operator's: `GET /v1/admin/ai?q=` (the month, the settings and the accounts), `POST /v1/admin/ai/settings`
`{ allowance, budget }`, `GET` and `POST /v1/admin/ai/accounts/:id` `{ monthlyLimit, off, lift, note, tokens }`,
`GET` and `POST /v1/admin/promos` `{ code, tokens, tier, days, maxRedemptions, expiresAt, note }`,
`POST /v1/admin/promos/:id` `{ disabled }` and `GET /v1/admin/promos/:id/redemptions`.
