# Backlog: reported, not yet looked into

Problems and asks Sam reports when there is no time to work on them yet. Each is picked up later, then moved into the
roadmap doc (see `ROADMAP.md`) or fixed and removed from here.

## Reported 2026-11-20 (FBRX OS 2.5.0, FBRX Digger 1.3.0)

1. **Sign in with an AI account people already pay for, no API key.** Researched (2026-11-24): see `AI_ACCOUNTS.md`.
   Only OpenAI has a program (Sign in with ChatGPT, a trial for commercial apps); Claude and Gemini forbid it, Grok is
   a partnership. Codex CLI now connects (step 2); Nous Portal works today as an OpenAI-compatible model (step 4).
   Sam is sending the Sign in with ChatGPT application (step 1, answers drafted); Codex second opinions (step 3) wait.

## Fixed, waiting for a release

* Digger follows FBRX OS in support mode (the developer unlock and support passes), and leaves the computer's health
  alerts to FBRX OS. Needs both an FBRX OS and a Digger release. (FBRX OS showed the drive warning too; Sam confirmed.)
* FBRX OS: AI coordination → Hermes Agent → Bring its setup over… takes its persona (SOUL.md → Who I am), memories
  (MEMORY.md, USER.md), skills (SKILL.md) and MCP servers (config.yaml, keys into the vault), per profile, through
  FBRX's checks. Other agent tools' files come later. Needs an FBRX OS release; the look was approved by Sam.
* FBRX OS: AI coordination connects OpenAI Codex CLI (its `~/.codex/config.toml`, an `[mcp_servers.fbrx]` table, the
  rest of the file kept), so a ChatGPT plan works with FBRX's tools through Codex's own sign-in. Needs an FBRX OS
  release.
* Device consoles (FBRX OS and FBRX Digger 1.3.1): copy and paste (Ctrl+V, Ctrl+Shift+V, Shift+Insert, Cmd+V,
  right-click), and the console fits the window and scrolls its own lines. FBRX Server's Terminal tab fits the window
  too (needs an FBRX Server release). The look waits for Sam's approval.
* FBRX Alert v1 (2.6.0 chunk 1): all-clears, signed webhooks and syslog in FBRX OS and Digger. The look of Alerts →
  Delivery waits for Sam's approval.

## Released

* FBRX Server 1.4.5 (2026-11-25, server-v1.4.5, on its own between FBRX OS releases): Bridge a port, FBRX Time copies
  off the server, Ubuntu quick downloads and thin or thick disks, paced pastes. Sam to try the bridge (the ESXi port
  group must allow Promiscuous mode, MAC address changes and Forged transmits) and a long paste on a real VM.
