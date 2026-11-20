# Backlog: reported, not yet looked into

Problems and asks Sam reports when there is no time to work on them yet. Each is picked up later, then moved into the
roadmap doc (see `ROADMAP.md`) or fixed and removed from here.

## Reported 2026-11-20 (FBRX OS 2.5.0, FBRX Digger 1.3.0)

1. **Digger says the computer is not on Ultra, when it is on Black Hole Edition** (Sam's iMac, Digger 1.3.0). Digger's
   advanced tools follow the edition FBRX Endpoint gives the computer (Ultra or above, `kernel.networkTools()`).
   Check how Digger reads that edition on a Mac: Black Hole Edition is above Ultra, so it must count. Also check
   which kind of Black Hole Edition this is (license, organization, support pass or the developer unlock): the
   developer unlock lives in FBRX OS's own data, and Digger may not see it. Sam believes the iMac is on Black Hole
   Edition through the developer unlock (`418teapotadmin`).
2. **Disk-filling-up notifications show in Digger, not in FBRX OS** (same iMac). The warning about the computer's
   drive belongs to FBRX OS (the endpoint). Find which part of the core raises it and why Digger runs it. Digger
   should leave computer-health notifications to FBRX OS when FBRX OS is installed, and FBRX OS must still show them.
3. **FBRX Server: quick downloads in the ISO section.** One-click download links for the major operating systems,
   starting with Ubuntu 26.04 LTS Desktop and Ubuntu 26.04 LTS Server, straight into the server's ISO library.
4. **FBRX Server: thin or thick provisioning when creating a VM.** Let the person choose the virtual disk type, in
   the standard terms: **Thin provisioned** (dynamically expanding: the disk file grows as the VM writes data, up to
   its maximum size) or **Thick provisioned** (fixed size: the full capacity is allocated when the VM is created).
5. **Sign in with an AI account people already pay for, no API key.** Connect a ChatGPT, Gemini, Grok or Claude
   account (and Nous Portal, whose free models such as LongCat 2.5 Sam uses), the way Hermes Agent does, so no
   separate API billing. Look into how Hermes signs in to each one (the providers' own sign-in flows for their
   command-line tools), and check each provider's terms before building: some allow a subscription sign-in only in
   their own apps, and FBRX must not break them.
6. **Bring agent setups over from other platforms.** Import an agent's setup into FBRX OS: its soul.md (Personality),
   config, skills, memory and MCP servers, starting with Hermes Agent (`~/.hermes`). Sam runs a Hermes agent with its
   own soul.md on each lab machine and wants FBRX OS to take that role over. Then other agent tools' instruction and
   config files. FBRX already writes itself into Hermes' config (AI coordination, 2.1.2); this is the other direction.
