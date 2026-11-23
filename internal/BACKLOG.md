# Backlog: reported, not yet looked into

Problems and asks Sam reports when there is no time to work on them yet. Each is picked up later, then moved into the
roadmap doc (see `ROADMAP.md`) or fixed and removed from here.

## Reported 2026-11-20 (FBRX OS 2.5.0, FBRX Digger 1.3.0)

1. **Sign in with an AI account people already pay for, no API key.** Connect a ChatGPT, Gemini, Grok or Claude
   account (and Nous Portal, whose free models such as LongCat 2.5 Sam uses), the way Hermes Agent does, so no
   separate API billing. Look into how Hermes signs in to each one (the providers' own sign-in flows for their
   command-line tools), and check each provider's terms before building: some allow a subscription sign-in only in
   their own apps, and FBRX must not break them.
2. **Bring agent setups over from other platforms.** Import an agent's setup into FBRX OS: its soul.md (Personality),
   config, skills, memory and MCP servers, starting with Hermes Agent (`~/.hermes`). Sam runs a Hermes agent with its
   own soul.md on each lab machine and wants FBRX OS to take that role over. Then other agent tools' instruction and
   config files. FBRX already writes itself into Hermes' config (AI coordination, 2.1.2); this is the other direction.
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
