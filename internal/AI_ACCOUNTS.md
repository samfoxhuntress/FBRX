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
| Nous Portal | Its sign-in is Hermes' own. Nous Portal is a subscription gateway; whether other apps may use it, and its free models, could not be confirmed. | Check Nous Portal's docs for API keys and free models: if it has an OpenAI-compatible key, FBRX can use it today as a custom provider. |

## What works today, within every provider's terms

* **The official apps use FBRX.** AI coordination connects Claude Desktop, Claude Code, Gemini CLI, Hermes and others
  to FBRX's tools (MCP). The person works in the app they pay for, on its subscription, and FBRX's tools, approvals
  and audit log come along. Codex CLI (a ChatGPT subscription's own client) is found but cannot be connected yet: it
  keeps its MCP servers in `~/.codex/config.toml`, which FBRX does not write.
* **Second opinions from the official client.** FBRX already asks Claude Code on this computer (the person's own
  install and sign-in). The same could be offered for `codex exec` and `gemini -p`; for Gemini, reports of suspensions
  even with the official CLI argue for waiting.
* **Free models through API keys.** Google AI Studio, Nous Portal (to confirm) and OpenRouter's free models cost
  nothing beyond a key.

## Next steps (decisions for Sam)

1. Apply to OpenAI's Sign in with ChatGPT trial for FBRX OS.
2. Connect Codex CLI in AI coordination (its `config.toml`), so a ChatGPT subscription works with FBRX's tools today.
3. Offer Codex (and later Gemini) second opinions through the official CLIs, like Claude Code's.
4. Confirm Nous Portal's API keys and free models, then add it as a provider preset.

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
