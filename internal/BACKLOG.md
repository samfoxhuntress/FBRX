# Backlog: reported, not yet looked into

Problems and asks Sam reports when there is no time to work on them yet. Each is picked up later, then moved into the
roadmap doc (see `ROADMAP.md`) or fixed and removed from here.

## Reported 2026-11-20 (FBRX OS 2.5.0, FBRX Digger 1.3.0)

1. **FBRX Server: quick downloads in the ISO section.** One-click download links for the major operating systems,
   starting with Ubuntu 26.04 LTS Desktop and Ubuntu 26.04 LTS Server, straight into the server's ISO library.
2. **FBRX Server: thin or thick provisioning when creating a VM.** Let the person choose the virtual disk type, in
   the standard terms: **Thin provisioned** (dynamically expanding: the disk file grows as the VM writes data, up to
   its maximum size) or **Thick provisioned** (fixed size: the full capacity is allocated when the VM is created).
3. **Sign in with an AI account people already pay for, no API key.** Connect a ChatGPT, Gemini, Grok or Claude
   account (and Nous Portal, whose free models such as LongCat 2.5 Sam uses), the way Hermes Agent does, so no
   separate API billing. Look into how Hermes signs in to each one (the providers' own sign-in flows for their
   command-line tools), and check each provider's terms before building: some allow a subscription sign-in only in
   their own apps, and FBRX must not break them.
4. **Bring agent setups over from other platforms.** Import an agent's setup into FBRX OS: its soul.md (Personality),
   config, skills, memory and MCP servers, starting with Hermes Agent (`~/.hermes`). Sam runs a Hermes agent with its
   own soul.md on each lab machine and wants FBRX OS to take that role over. Then other agent tools' instruction and
   config files. FBRX already writes itself into Hermes' config (AI coordination, 2.1.2); this is the other direction.
5. **FBRX Time: back up to a NAS or an external drive.** Sam found no way to send a Time backup to a network share or
   an external hard drive. Check whether it exists but is hard to find; if not, add both as backup destinations.
6. **FBRX Time: change the backup location afterwards.** Once the backup location is set there is no way to edit it.
   Let it be changed later, and say what happens to the backups already made there.
7. **FBRX Virtual: long pastes into a VM come out garbled.** Pasting long text into a VM works for the first part,
   then the characters come out wrong. If the paste is typed into the VM as keystrokes, check whether they are sent
   faster than the VM takes them (pace them, or send in chunks with a pause), and test with long text and symbols.

## Fixed, waiting for a release

* Digger follows FBRX OS in support mode (the developer unlock and support passes), and leaves the computer's health
  alerts to FBRX OS. Needs both an FBRX OS and a Digger release. Still open: why FBRX OS on the iMac did not show the
  drive warning itself (same check as Digger had). Check FBRX OS → Alerts for it, and macOS Notifications for FBRX OS.
