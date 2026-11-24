# Signing in with an AI subscription instead of an API key

Research for Sam's ask (2026-11-20): connect a ChatGPT, Gemini, Grok or Claude account, and Nous Portal, the way Hermes
Agent does, so no separate API billing. As of 2026-11-24. The providers' own pages could not be opened from the build
environment (its network policy blocks them), so this rests on search results and the coverage linked below; check
the primary pages before building.

## Answer

Only OpenAI has a program for this, and FBRX OS would have to be accepted into it. Reusing the sign-in of a provider's
own tool (what Hermes and OpenClaw did) breaks Anthropic's and Google's terms and gets accounts suspended. The route
that works today without breaking anyone's terms is the one FBRX already has: the official apps use FBRX's tools.

| Provider | Subscription sign-in in another app | What FBRX should do |
| --- | --- | --- |
| OpenAI (ChatGPT Plus/Pro) | Allowed through the official **Sign in with ChatGPT** program (terms dated 2026-09-29). Plan usage is open to open-source and local personal projects; commercial apps are a limited trial with selected partners. Requests must come from the user's own computer; no pooling, sharing or reselling of plan usage or tokens. | Apply for the trial for FBRX OS (it runs on the person's computer, which fits). Build the sign-in once accepted. Never reuse Codex's token. |
| Anthropic (Claude Pro/Max) | Not allowed. Since February 2026 Anthropic's terms say subscription sign-ins work only in Claude Code and claude.ai, and third-party apps may not offer a Claude login; it is enforced. | No subscription sign-in. Keep API keys, and Claude Code on this PC for second opinions (the official client, run by the person). |
| Google (Gemini, Google AI Pro/Ultra) | No program. Accounts that used Gemini CLI or Antigravity sign-ins through third-party tools were suspended through 2026. | No subscription sign-in. API keys (Google AI Studio has a free tier). |
| xAI (SuperGrok, X Premium+) | xAI built SuperGrok sign-in into Hermes as a partnership; its endpoints are on xAI's own allowlist. No open program for other apps found. | Ask xAI for a partnership if wanted; until then, API keys. |
| Nous Portal | Its sign-in is Hermes' own, but it also sells Portal API keys for an OpenAI-compatible endpoint (checked 2026-11-24, below). | Works today: an OpenAI-compatible model in FBRX with a Portal API key. |

## What works today, within every provider's terms

* **The official apps use FBRX.** AI coordination connects Claude Desktop, Claude Code, Gemini CLI, Hermes and others
  to FBRX's tools (MCP). The person works in the app they pay for, on its subscription, and FBRX's tools, approvals
  and audit log come along. Codex CLI (a ChatGPT subscription's own client) connects too since 2026-11-24: FBRX writes
  its `[mcp_servers.fbrx]` table in `~/.codex/config.toml`.
* **Second opinions from the official client.** FBRX already asks Claude Code on this computer (the person's own
  install and sign-in). The same could be offered for `codex exec` and `gemini -p`; for Gemini, reports of suspensions
  even with the official CLI argue for waiting.
* **Free models through API keys.** Google AI Studio, Nous Portal (to confirm) and OpenRouter's free models cost
  nothing beyond a key.

## Next steps (decisions for Sam)

1. Apply to OpenAI's Sign in with ChatGPT trial for FBRX OS. Sam said apply (2026-11-24); the answers are below, for
   Sam to send through OpenAI's interest form (it needs Sam's own details, and openai.com is not reachable from the
   build environment).
2. ~~Connect Codex CLI in AI coordination (its `config.toml`), so a ChatGPT subscription works with FBRX's tools
   today.~~ Done 2026-11-24, waiting for a release.
3. Offer Codex (and later Gemini) second opinions through the official CLIs, like Claude Code's.
4. ~~Confirm Nous Portal's API keys and free models.~~ Checked 2026-11-24 (below): it works today as an
   OpenAI-compatible model. A preset can come once Sam has tried a key.

## Sign in with ChatGPT: the application

Commercial apps join through OpenAI's **Sign in with ChatGPT interest form** (openai.com/form/sign-in-with-chatgpt-interest),
or through an OpenAI representative. The form asks for the company, website and the person's job title, whether the app
wants sign-in only or sign-in and plan usage, and which products would use it and how. Open-source and local personal
tools register on first sign-in without approval; FBRX OS is a commercial app, so it needs the form. Once accepted,
OpenAI issues a client ID (developers.openai.com/siwc/request-client-id) and FBRX OS gets the sign-in.

Answers to paste (Sam fills in the name, email, job title and website):

* **Company:** Fox Huntress Labs.
* **Product:** FBRX OS, a desktop app for Windows, macOS and Linux. Its assistant, Fabrix, runs on the person's own
  computer and works on it (files, settings, the network, everyday IT) through tools the person approves, with an audit
  log of every action. Organizations manage their computers with FBRX Command.
* **What we ask for:** Sign in with ChatGPT and plan usage. A person could choose their own ChatGPT plan as Fabrix's
  model, next to the local model and API keys they already can.
* **How it keeps to the terms:** every request goes from the person's own computer under their own sign-in. Nothing
  is pooled, shared, resold or relayed through FBRX's servers; the sign-in is kept sealed in FBRX OS's vault on that
  computer and can be signed out at any time. In an organization, FBRX Command never holds or hands out a member's
  ChatGPT sign-in.
* **Capabilities used:** chat with streaming, tool calls (each one gated by FBRX's approvals) and reasoning.
* **Today:** people with a ChatGPT plan use FBRX's tools through Codex CLI (FBRX OS connects it), so the demand is there.

## Nous Portal (checked 2026-11-24)

From Nous' own comparison pages and third-party lists; the portal itself is not reachable from the build environment.

* **API:** OpenAI-compatible at `https://inference-api.nousresearch.com/v1`, with a **Portal API key** made in the
  portal. Model IDs are OpenRouter-style (`maker/model`).
* **Paying:** keys bill pay-as-you-go credits per token, never a plan's included usage. Plans start around $20 a
  month. One report says getting a key needs a card on file (a $0 charge), even for free use.
* **Free models:** a Free plan with free models (IDs end in `:free`), standard rate limits that are not published. The
  lists disagree and change: in November 2026 they named about six to nine, among them `stepfun/step-3.7-flash:free`
  and Poolside's Laguna models. The portal's models page (Free filter) has the current list.
* **In FBRX today:** on the AI models page, add an OpenAI-compatible model with that address, the key, and a model ID.
  No code is needed. The free model Sam reached through Hermes (LongCat) was not on the lists found.

## Sources

* [Anthropic clarifies its ban on third-party harnesses (The Register, 2026-02-20)](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access),
  [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance.md),
  [WinBuzzer](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/)
* [Sign in with ChatGPT terms](https://openai.com/policies/sign-in-with-chatgpt-terms/),
  [SIWC quickstart](https://developers.openai.com/siwc/quickstart),
  [help article](https://help.openai.com/en/articles/20001410),
  [The New Stack](https://thenewstack.io/sign-in-with-chatgpt/),
  [WorkOS on plan usage scope](https://workos.com/blog/sign-in-with-chatgpt-plan-usage-scope)
* [Gemini CLI / Antigravity suspensions (Google AI forum)](https://discuss.ai.google.dev/t/urgent-mass-403-tos-bans-on-gemini-api-antigravity-for-open-source-cli-users-paid-tier/124508),
  [OAuth via OpenClaw thread](https://discuss.ai.google.dev/t/account-restricted-without-warning-google-ai-ultra-oauth-via-openclaw/122778?page=3)
* [xAI: Grok in Hermes](https://x.ai/news/grok-hermes),
  [Hermes docs: xAI Grok OAuth](https://hermes-agent.nousresearch.com/docs/guides/xai-grok-oauth),
  [Hermes providers](https://hermes-agent.nousresearch.com/docs/integrations/providers),
  [Nous Portal](https://hermes-agent.nousresearch.com/docs/integrations/nous-portal)
* [Sign in with ChatGPT interest form](https://openai.com/form/sign-in-with-chatgpt-interest/),
  [Request a client ID](https://developers.openai.com/siwc/request-client-id),
  [On your website](https://developers.openai.com/siwc/website),
  [Using your ChatGPT plan in other apps](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)
* [Nous Portal vs OpenRouter](https://portal.nousresearch.com/compare/openrouter),
  [Nous Portal free tier (awesome-free-ai-coding)](https://mvalentsev.github.io/awesome-free-ai-coding/providers/nous-portal/),
  [freeinference.dev](https://freeinference.dev/providers/nous-portal/)
