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
* FBRX Server: quick downloads in the ISO library (Ubuntu 26.04 LTS Desktop and Server, newest point release, checked
  against Ubuntu's SHA256SUMS) and thin or thick provisioned disks for new VMs. Needs an FBRX Server release; the look
  was approved by Sam.
* FBRX Time on FBRX Server: copies of each new image off the server (a NAS share, an NFS export or a USB drive), tested
  before saving, changeable any time. FBRX Endpoint already had a drive or network folder and Change… on Windows. Needs
  an FBRX Server release; the look waits for Sam's approval.
* FBRX Virtual: long pastes into a VM. Keys are paced (a breath every 32 keys and after each line), Shift is held over
  a run and always let go, and the console relay sends keys at once (no Nagle). Needs an FBRX Server release; Sam to
  try a long paste on a real VM.
* FBRX Server: Networks → Bridge a port… makes bridge br0 from the console (DHCP, a fixed address or a spare card),
  says what the outer hypervisor must allow (VMware, Hyper-V, VirtualBox), and Restart now finishes it. Needs an FBRX
  Server release; the look waits for Sam's approval. Sam's ESXi port group must allow Promiscuous mode, MAC address
  changes and Forged transmits.
* FBRX OS: AI coordination → Hermes Agent → Bring its setup over… takes its persona (SOUL.md → Who I am), memories
  (MEMORY.md, USER.md), skills (SKILL.md) and MCP servers (config.yaml, keys into the vault), per profile, through
  FBRX's checks. Other agent tools' files come later. Needs an FBRX OS release; the look was approved by Sam.
* FBRX OS: AI coordination connects OpenAI Codex CLI (its `~/.codex/config.toml`, an `[mcp_servers.fbrx]` table, the
  rest of the file kept), so a ChatGPT plan works with FBRX's tools through Codex's own sign-in. Needs an FBRX OS
  release.
