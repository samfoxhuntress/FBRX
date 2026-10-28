# FBRX Cloud AI

FBRX's models in the cloud, for FBRX accounts. A computer signed in to an FBRX account chats with them through the
account server (FBRX Command in the cloud, [CLOUD.md](CLOUD.md)): it checks the account, counts its tokens and passes
the chat on to the model provider whose key only it holds. It is a cloud FBRX Server for the AI alone: the agent's
tools, its memory, approvals and files stay on the computer, as with any AI it thinks with.

## On a computer

- **AI models → FBRX Cloud AI** (signed in to an FBRX account whose server offers it): this month's tokens, the extra
  tokens, when the month renews, **Use for chats**, and a field for a promo code. **Settings → FBRX account** shows the
  month in one line and takes promo codes too.
- It is a cloud provider like any other: the governance policy's *allow cloud providers* decides whether it may be
  used, and only the general part of the memory goes with a chat. It is off on learners' computers (students' and
  children's, in an organization).
- It is ready only while the account may chat; otherwise the AI models page says why (the month's tokens are used,
  it was turned off), and so does a chat that runs into it.

## How it is counted

- **Tokens** read and written, together, times the model's weight (a large model's count for more), by the month
  (UTC).
- **Each edition's allowance a month**, until the operator changes it: Essentials none, Standard 1M, Ultra 3M, Black
  Hole 5M (`CLOUD_AI_ALLOWANCE`). The edition is the account's own or the fullest one an organization gives it.
  Essentials' allowance, when there is one, waits for the account's email to be confirmed.
- **Extra tokens** (from a promo code or the operator) are spent once the month's allowance is used, and do not run
  out at the end of the month. With none left, the account waits for the next month.
- **A stopped answer** counts what was read and written up to there (about four characters to a token, when the
  provider did not get to say).
- **Each chat**: answers of up to 8,192 tokens, four chats going at once per account, sixty a minute per sign-in.
- **Kept**: per account and month, the tokens read, written and counted and the number of chats. Never what was said:
  a chat passes through and is not stored or logged, and nothing about the person goes to the provider (only the
  chat's messages, tools and settings).

## The operator (FBRX Command → Cloud AI)

The platform operator (superadmin) sees the month so far (everyone's tokens against the service's budget, the chats,
the models, the promo codes in use) and:

- **Allowances**: each edition's tokens a month, and the **service budget**, the most FBRX Cloud AI counts in a month
  for everyone together. Past it, it takes no new chats until the month ends: a ceiling no bug or abuse gets through.
- **Accounts** (this month's, most used first; or any account, by search). **Manage** one: its own monthly limit
  instead of its edition's, extra tokens to add (or take back), **lift its limit until the month ends** (it goes on,
  still counted, without spending extra tokens), **turn FBRX Cloud AI off** for it, a note, and its last twelve months.
- **Promo codes**: a code (or one FBRX makes up, FBRX-XXXX-XXXX) that gives extra tokens, Standard or Ultra for some
  days (as a grant, like *Give an edition*), or both; for how many accounts and until when. Each account uses a code
  once, in FBRX OS, on the website or in the phone apps. Turn one off or back on, and see who used it.

Every change is in the audit log.

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

## What a refused chat says

| | |
| --- | --- |
| `402 AI_LIMIT` | The month's allowance and the extra tokens are used (or the edition comes with none) |
| `403 AI_OFF` | The operator turned FBRX Cloud AI off for the account |
| `503 AI_BUSY` | The service reached its budget, or the provider is busy |
| `503 AI_UNAVAILABLE` | This FBRX Command has no FBRX Cloud AI |
| `429` | Four chats going already, or sixty in the last minute |
| `400` | What the provider said was wrong with the chat (too long for the model, say) |
| `502 AI_UPSTREAM` | The provider could not be reached or did not answer |

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
