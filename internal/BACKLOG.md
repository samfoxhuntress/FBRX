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
