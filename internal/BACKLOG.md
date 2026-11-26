# Backlog: reported, not yet looked into

Problems and asks Sam reports when there is no time to work on them yet. Each is picked up later, then moved into the
roadmap doc (see `ROADMAP.md`) or fixed and removed from here.

## Reported 2026-11-20 (FBRX OS 2.5.0, FBRX Digger 1.3.0)

1. **Sign in with an AI account people already pay for, no API key.** Researched (2026-11-24): see `AI_ACCOUNTS.md`.
   Only OpenAI has a program (Sign in with ChatGPT, a trial for commercial apps); Claude and Gemini forbid it, Grok is
   a partnership. Codex CLI now connects (step 2); Nous Portal works today as an OpenAI-compatible model (step 4).
   Sam is sending the Sign in with ChatGPT application (step 1, answers drafted); Codex second opinions (step 3) wait.

## Fixed, waiting for a release

Nothing: everything fixed went out in FBRX OS 2.5.1 (below).

## Released

* FBRX OS Beta 2.5.1, FBRX Digger 1.3.1 and FBRX Server 1.4.6 (2026-11-26, v2.5.1 and digger-v1.3.1): model fallbacks
  and backup practice, closing the local model (the Closing window), the Linux keyring and Local API fixes from the
  Hermes setup on Ubuntu, AI apps' cancels, Hermes Agent's setup brought over, Codex CLI, FBRX Alert v1 (all-clears,
  signed webhooks, syslog), device console copy and paste, Digger in support mode; FBRX Server's Alerts page and a
  Terminal tab that fits. Sam's looks: the fallbacks card, backup practice, the Closing window and the server's
  Alerts page went out with Sam's go on the release.
* FBRX Server 1.4.5 (2026-11-25, server-v1.4.5, on its own between FBRX OS releases): Bridge a port, FBRX Time copies
  off the server, Ubuntu quick downloads and thin or thick disks, paced pastes. Sam to try the bridge (the ESXi port
  group must allow Promiscuous mode, MAC address changes and Forged transmits) and a long paste on a real VM.
