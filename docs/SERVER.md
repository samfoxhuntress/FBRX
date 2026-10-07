# FBRX Server and FBRX Virtual

**FBRX Server** is FBRX OS for servers: Debian 13 set up the FBRX way, running **FBRX Virtual**, the FBRX hypervisor.
FBRX Virtual runs virtual machines on KVM (through libvirt) and is managed from a web console on port **9443**:
virtual machines and their screens, storage and ISOs, networks, a live **hardware map** of the server, and the server
itself (health, power and **BIOS settings**) through its management controller.

With the **ai** role (on by default) the server also runs the **FBRX core**: an AI agent on **FBRX Mesh** that works
with your other FBRX computers through **Mesh Assist**, lending its AI when theirs runs out of steps or credits,
borrowing theirs, and, as a **controller**, handing out work to them. It is managed from the same console
(*Mesh & AI*, below).

With the **gate** role the server routes and protects your network (**FBRX Gate**: firewall, VLANs, DHCP and DNS, VPN,
traffic priority and Prefer Mesh, [GATE.md](GATE.md)); with **minidome** it also watches it for threats (**FBRX
MiniDome**, [MINIDOME.md](MINIDOME.md)). Same console, *Gate* pages.

> First stage (FBRX Virtual 0.1). It runs real virtual machines and is tested against a real hypervisor in CI. Clusters,
> backups of virtual machines and governance from FBRX Command come later (see [LINEUP.md](LINEUP.md)).

## Install

### A. From the FBRX Server ISO (wipes the server)

1. Get the ISO: it comes with **FBRX Endpoint** for now (*Lab → FBRX Server*, with the bundle and these guides), the
   **FBRX Server ISO** workflow in GitHub Actions builds it (artifact `fbrx-server-iso`), or build it yourself on Linux:
   `scripts/server/bundle.sh --with-node && scripts/server/build-iso.sh` (needs `xorriso`).
2. Boot the server from it: write it to a USB stick (`dd`, or any image writer; in Rufus choose **DD Image mode** when
   it asks), or on a Dell PowerEdge mount it through the iDRAC: *Virtual Console → Virtual Media → Map CD/DVD*, then boot
   once from *Virtual CD/DVD/ISO* (F11 boot menu). In Hyper-V, use a generation 2 machine.
3. Pick **Install FBRX Server**. The installer asks only:
   * which disk to install on, and to confirm erasing it (it asks every time it is about to write),
   * the time zone,
   * the administrator account's name (suggested: **`fbrx`**) and its password. There is no root password; the
     administrator uses `sudo`.
   Everything else is answered: US English, DHCP, host name `fbrx-server`, LVM over the whole disk, SSH server.
4. It copies FBRX Server onto the new system and restarts. At this **first start FBRX Server finishes its setup** (the
   hypervisor, FBRX Virtual, the AI role): a few minutes, with its progress on the screen, before the login prompt.
   The screen then shows where to open the console, the first-time setup code, and which account to sign in with.

The ISO is Debian's own network installer with FBRX Server added, so the server needs internet access while installing
and at its first start. If the first start could not finish (no internet, say), the login screen says so: sign in,
fix the network, and run `sudo bash /opt/fbrx-installer/firstboot.sh` (it also tries again at every start until it
finishes). Everything it did is in `/var/log/fbrx-server-install.log`.

### B. On a Debian 13 server you already have

```bash
tar -xzf fbrx-server-0.1.0.tar.gz          # from FBRX Endpoint (Lab → FBRX Server), the CI artifact, or bundle.sh
sudo bash fbrx-server-0.1.0/install.sh
```

`install.sh` installs QEMU/KVM, libvirt, UEFI firmware (OVMF) and the software TPM (swtpm), Node.js 22 (kept in
`/opt/fbrx-server/node`, not system-wide), FBRX Virtual and (ai role) the FBRX core, turns on the IOMMU in the kernel
options (for device passthrough, after one reboot) and starts the `fbrx-virtual` and `fbrx-core` services.

| Option | |
| --- | --- |
| `--roles virtual,ai` | What the server does (below). `--roles virtual` installs the hypervisor alone; `--roles gate,minidome,ai` makes a gate without virtual machines. Running the installer again with other roles adds roles, or turns the ai role off (its data stays). |
| `--gate-wan eno1 --gate-lan eno2` | The gate's internet port and the port to your network (gate role; see [GATE.md](GATE.md#install)). `--gate-manage <cidr\|none>` keeps the console and SSH reachable from a private network on the internet side. |
| `--bridge eno1` | Makes bridge `br0` on that port so virtual machines sit straight on your network (applies after a reboot). Only for a port set up with DHCP; for a static address, see *Networks* below. |
| `--port 9443` | The console's port. |
| `--uninstall [--purge]` | Takes FBRX Server off again. Virtual machines and their disks, and the ai role's mesh pairings and keys, stay unless `--purge`. |

### Server roles

An FBRX Server announces its roles to the other computers on FBRX Mesh (Mesh Assist shows them when it picks a
helper, so work can go to the right server).

| Role | What it runs | |
| --- | --- | --- |
| `virtual` | FBRX Virtual: the hypervisor (virtual machines) | Default |
| `ai` | The FBRX core: the agent, FBRX Mesh and Mesh Assist (`fbrx-core` service) | Default |
| `gate` | FBRX Gate: routing, firewall, VLANs, DHCP and DNS, VPN, traffic priority ([GATE.md](GATE.md)) | First stage |
| `minidome` | FBRX MiniDome: threat detection through the gate ([MINIDOME.md](MINIDOME.md)); needs `gate` | First stage |
| `command` | FBRX Command on the server: the tenant's settings and policy, kept with the mesh | Planned |
| `dns` | Name service for the network | Planned |
| `directory` | Directory and sign-in for the organization's computers (a domain controller) | Planned |
| `files` | File sharing | Planned |

The web console comes with every role (it is FBRX Virtual's service, with or without virtual machines). The installer
refuses a planned role for now and says so.

## Dell PowerEdge R330 checklist

The R330 (13th generation) has an **iDRAC 8**. Before (or after) installing:

1. **iDRAC network.** At boot press F2 → *iDRAC Settings → Network*: give it an address on your network. Change the
   default `root` password, and make a separate iDRAC user with the Administrator role for FBRX Virtual.
2. **BIOS** (F2 → *System BIOS*, or later from FBRX Virtual's *Server & BIOS* page):
   * *Processor Settings → Virtualization Technology: Enabled.* On these servers it turns on both VT-x (fast virtual
     machines) and VT-d (giving PCI devices to virtual machines).
   * *Boot Settings → Boot Mode: UEFI.*
   * *System Profile Settings → System Profile: Performance* (processors stay at full speed).
   * *Integrated Devices → SR-IOV Global Enable: Enabled* (network cards that split into virtual ones).
3. **Disks.** The PERC H330 can present the disks as a RAID volume (pick the virtual disk in the installer) or pass
   them through (HBA / non-RAID mode).

FBRX Virtual's *Server & BIOS → BIOS settings* shows these as **Recommended for FBRX Virtual** and sets them in one go.

## First sign-in

Open `https://<server address>:9443` from another computer. FBRX Virtual makes its own certificate, so the browser warns
the first time: check that the fingerprint matches what the server shows (`fbrx-server fingerprint`), then continue.
Enter the **setup code** (on the server's screen, or `sudo fbrx-server setup-code`) and make the first administrator.

Roles: **administrators** do everything (users, networks, deleting machines, device passthrough, interrupt placement,
the BIOS); **operators** run virtual machines (create, start, screens, snapshots, ISOs); **viewers** look. Every change
and sign-in is in the audit log.

## Using FBRX Virtual

* **Virtual machines.** *New virtual machine* picks sensible devices for the operating system: Windows gets SATA disks
  and an Intel network card (installs with no extra drivers), Secure Boot and a TPM for Windows 11; Linux gets the fast
  virtio devices. Disks are thin qcow2 files in `/var/lib/fbrx-virtual/images`.
* **Screen.** Each running machine's screen opens in the browser (VNC relayed by FBRX Virtual; the VNC ports themselves
  only listen on the server). Ctrl+Alt+Del and full screen are in the toolbar.
* **Snapshots.** Machines with BIOS firmware are snapshotted live, memory included. UEFI machines keep their firmware
  settings outside the disk, which QEMU cannot put in a snapshot, so they are snapshotted (and restored) while off.
* **Changes.** Processors and memory change at the machine's next start (the page says so); the CD drive, the disk size
  and processor placement change right away.
* **ISOs.** Upload installers, or have the server download them from a web address (faster).
* **Networks.** `default` is a private network with internet through the server. Make more (private with internet, or
  machines-only lab networks), or use a bridge for machines on your own network. For a server with a static address,
  add a bridge in `/etc/network/interfaces` yourself:

  ```
  auto eno1
  iface eno1 inet manual

  auto br0
  iface br0 inet static
      address 192.168.1.10/24
      gateway 192.168.1.1
      bridge_ports eno1
      bridge_stp off
      bridge_fd 0
  ```

## Mesh & AI (the ai role)

The FBRX core runs as its own unprivileged account (`fbrx-core`, no login, no sudo) with only `/var/lib/fbrx-core`
writable, so its agent can look around the server but not change it as root; its tools follow FBRX policy and ask
before anything risky, like on any FBRX computer. It listens for FBRX Mesh on port **47800** and for its console on
`127.0.0.1:47821` only.

*Mesh & AI* in the console:

* **Mesh Assist:** when this server brings other computers' AI in (out of steps, AI provider out of credits or
  unreachable, the agent consulting another), whether it lends its own (never, ask an operator here first, or
  automatically), what its agent may do while helping, how much help at once and at what priority. **This server is a
  controller** makes its requests run without asking on computers that gave it the Controller permission (urgent ones
  may stop lower-priority help there). *Who can help?* lists the paired computers with their AI, load and roles;
  *Hand out work* sends a task to the best helper, every computer, or one; requests waiting for a yes, and all help
  asked and given (with the answers and follow-up questions), are on the same tab. See [MESH.md](MESH.md).
* **Computers on the mesh:** turn FBRX Mesh on or off, show a pairing code for another computer (on that computer:
  *Mesh & phone → Join a computer*), join another computer's code, and set what each paired computer may do here,
  including **Help with AI** and **Controller**.
* **AI provider:** what this server's agent runs on: a cloud provider with an API key (kept encrypted in the core's
  vault, never shown again), or a model on your network (Ollama or any OpenAI-compatible server, by address).

**Who may do what.** Viewers see it all. Operators answer Mesh Assist's requests for help and hand out work.
Administrators change the settings, pair computers, set permissions, choose the provider, save keys and answer any
approval. Every change is in FBRX Virtual's audit log and, with the console user's name, in the core's own.

**How the console reaches the core.** At every start the core writes a new random **console token** to
`/var/lib/fbrx-core/console.token` (readable by root only); FBRX Virtual, which runs as root, reads it and calls the
core's Local API on `127.0.0.1` with it, as the person signed in to the console. FBRX Virtual passes on only the
calls the page makes, with the role each needs, and only the settings above (never the core's policy, Local API or
system prompt). The console token can never read a secret back or the Local API's automation tokens.

## The hardware map

*Hardware map* draws the server as it is wired: the processor sockets (NUMA nodes) with their cores on top, and the
devices on each socket's PCIe lanes below (network ports, disk controllers, USB, display), with their link width and
speed. Lines show the data moving right now, in (received, read) and out (sent, written), thicker and faster as more
moves. Cores glow by how many device interrupts they handle.

**Changing where data goes:**

* **A device's interrupts.** Drag a device onto a socket or a single core (or use the buttons under it) to choose which
  processors handle its interrupts, which is where its data is first handled. Keep a fast network card's interrupts on
  the socket it is plugged into, and away from cores busy virtual machines run on. FBRX Virtual remembers the
  placement and puts it back after every restart. `irqbalance` moves interrupts on its own; turn it off from the page
  when you place them by hand.
* **A virtual machine's processors.** Drag a pinned machine onto a socket or core, or set its processors on its
  *Hardware & placement* tab: it then runs only there (moved right away, kept for later starts).
* **Device passthrough.** Give a PCI device (a network card, a disk controller, a graphics card) to one virtual machine,
  which then uses it directly at full speed. Needs VT-d and the IOMMU (the installer turns it on; reboot once). Never
  give away the network port you reach the console through.

On a computer without a Linux hardware view (development, the simulated mode) the page shows a sample server.

## Server & BIOS (iDRAC and other Redfish controllers)

*Server & BIOS → Connect*: enter the controller's address, check the certificate it presents (compare its fingerprint
with the iDRAC's own page, *iDRAC Settings → Network/Services → SSL*), trust it and sign in. From then on FBRX Virtual
talks only to that exact controller, and keeps the password encrypted.

* **Health & power:** model, service tag, BIOS and controller firmware, temperatures, fans, power use; turn the server
  on, shut it down, restart or force it (the page reminds you every virtual machine stops with it).
* **BIOS settings:** every setting by group, with the maker's names, choices and help. Changes are **staged** and applied
  by the server at its next restart (Dell controllers do this through a configuration job, which the page lists).
  *Apply at next restart* or *Apply and restart now*; *Throw them away* cancels staged changes. *Next start: BIOS setup*
  boots into the setup screen once (see it through the iDRAC virtual console).
* **Event log:** the hardware event log (memory, power supply, fan and temperature events).

## Everyday commands

```
fbrx-server status                 where the console is, service and hypervisor state, certificate fingerprint
fbrx-server setup-code             the first-time setup code
fbrx-server logs [-f]              FBRX Virtual's log
fbrx-server logs ai [-f]           the FBRX core's log (agent, FBRX Mesh, Mesh Assist)
fbrx-server restart                restart FBRX Virtual (virtual machines keep running)
fbrx-server restart ai             restart the FBRX core
fbrx-server users                  who can sign in
fbrx-server reset-password <user>  a new password for someone locked out
fbrx-server create-admin [name]    another administrator
fbrx-gate help                     FBRX Gate's own commands (gate role, see GATE.md)
```

## Settings

`/etc/fbrx-virtual/fbrx-virtual.env` (restart the service after a change):

| Variable | Default | |
| --- | --- | --- |
| `FBRX_V_PORT` | `9443` | Console port. |
| `FBRX_V_DATA_DIR` | `/var/lib/fbrx-virtual` | Database, certificate, keys. |
| `FBRX_V_IMAGES_DIR` / `FBRX_V_ISOS_DIR` | `…/images`, `…/isos` | Virtual disks and the ISO library (libvirt pools `fbrx-images`, `fbrx-isos`). |
| `FBRX_V_TLS` | `self-signed` | `off` serves plain HTTP (only behind a reverse proxy). `FBRX_V_TLS_CERT` + `FBRX_V_TLS_KEY` use your own certificate. |
| `FBRX_V_TLS_NAMES` | | Extra names for the self-signed certificate. |
| `FBRX_V_SESSION_HOURS` | `12` | How long a sign-in lasts. |
| `FBRX_V_MAX_UPLOAD_GB` | `32` | Largest ISO. |
| `FBRX_V_DRIVER` | `libvirt` | `simulated` pretends (no virtual machines really run). |
| `FBRX_V_LIBVIRT_URI` | `qemu:///system` | |
| `FBRX_V_DOMAIN_TYPE` | | `qemu` forces software emulation (nested setups). |
| `FBRX_V_CORE_URL` | `http://127.0.0.1:47821` | The FBRX core's Local API (ai role). |
| `FBRX_V_CORE_TOKEN_FILE` | `/var/lib/fbrx-core/console.token` | Where the core writes the console token. |
| `FBRX_V_ROLES` | `virtual` | The server's roles, comma separated (the installer writes it); the console shows what is there. |
| `FBRX_V_GATE_WAN` / `FBRX_V_GATE_LAN` | `eth0` / `eth1` | The gate's ports, for its starter configuration. |
| `FBRX_V_GATE` | `linux` | `simulated` pretends (nothing on the computer changes). |
| `FBRX_V_GATE_FIRST` | | `commit`: put the starter configuration in place at the first start (the installer sets it). |
| `FBRX_V_GATE_MANAGE_WAN` | | A private network on the internet side allowed to reach the console and SSH. |

`/etc/fbrx-core/fbrx-core.env` (ai role; `sudo systemctl restart fbrx-core` after a change): `FBRX_SERVER_ROLES`, the
roles this server announces (the installer writes it). Everything else about the core is set from *Mesh & AI*.

## Security

* HTTPS with a certificate checked by fingerprint; sessions are random tokens stored hashed; passwords are scrypt
  hashes; sign-in is rate limited; the browser screen uses one-time tickets (30 seconds, one machine).
* The service runs as root because it drives the system hypervisor, moves interrupts and hands devices to machines;
  systemd keeps home folders and kernel modules out of its reach.
* virsh is called with argument lists (never a shell), and names, addresses and processor lists are checked before
  they reach it.
* The management controller's password is encrypted with a key kept in the data folder (`keys/master.key`, mode 600).
* The FBRX core (ai role) runs unprivileged and sandboxed by systemd (read-only system, only its data folder
  writable); see *Mesh & AI* for how the console reaches it.

## API

All under `/v1`, with `Authorization: Bearer <token>` from `POST /v1/auth/login`.

| | |
| --- | --- |
| `GET /setup`, `POST /setup`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/password` | Setup and sign-in |
| `GET/POST /users`, `PATCH/DELETE /users/:id`, `GET /audit` | Users and the audit log (administrators) |
| `GET /host` | The server, the hypervisor and warnings |
| `GET/POST /vms`, `GET/PATCH/DELETE /vms/:id`, `POST /vms/:id/power` | Virtual machines |
| `GET/POST /vms/:id/snapshots`, `POST …/:name/revert`, `DELETE …/:name` | Snapshots |
| `POST /vms/:id/console` → ticket, WebSocket `/vms/:id/console/ws?ticket=` | The screen (VNC) |
| `POST /vms/:id/hostdevs`, `DELETE /vms/:id/hostdevs/:address` | Device passthrough |
| `GET /storage/pools`, `GET/DELETE /storage/pools/:pool/volumes[/:name]` | Storage |
| `GET /isos`, `PUT /isos/:name` (upload), `POST /isos/download`, `DELETE /isos/:name` | ISO library |
| `GET/POST /networks`, `DELETE /networks/:name` | Networks |
| `GET /hardware/topology`, `GET /hardware/flows`, `PUT /hardware/devices/:address/irqs`, `PUT /hardware/irqs/:irq`, `PUT /hardware/irqbalance` | Hardware map |
| `GET/PUT/DELETE /bmc`, `POST /bmc/probe`, `GET /bmc/system`, `/sensors`, `/logs`, `POST /bmc/power`, `POST /bmc/boot-to-setup`, `GET/PATCH /bmc/bios`, `DELETE /bmc/bios/pending` | Server management |
| `/gate/…` | FBRX Gate (gate role): see [GATE.md](GATE.md#api) |
| `/dome/…` | FBRX MiniDome (minidome role): see [MINIDOME.md](MINIDOME.md#api) |
| `GET /core`, `POST /core/call` `{ method, params }` | The FBRX core (ai role): `system.status`, `settings.get`, `ai.providers`, `mesh.status`, `mesh.assist.helpers`, `mesh.assist.sessions`, `approvals.list` (viewers); `mesh.assist.send`, `mesh.assist.followUp`, `mesh.assist.cancel`, `approvals.resolve` for Mesh Assist (operators); `settings.update` (Mesh Assist and AI provider settings), `vault.set` (provider keys), `vault.list`, `ai.models`, `mesh.setEnabled`, `mesh.rename`, `mesh.startPairing`, `mesh.cancelPairing`, `mesh.pair`, `mesh.removeDevice`, `mesh.setPermissions` (administrators) |

## Development

```bash
npm run dev:virtual            # FBRX Virtual on https://localhost:9443 (simulated; admin / fbrx-virtual-dev)
npm run dev:virtual-console    # the console with hot reload on http://localhost:5175
npx vitest run apps/virtual    # tests; FBRX_TEST_LIBVIRT=1 (as root, libvirt installed) adds the real-hypervisor test
FBRX_V_ROLES=gate,minidome,ai FBRX_V_GATE=simulated npm run dev:virtual   # a pretend gate with MiniDome

# Mesh & AI against a real core: the core in server mode, then FBRX Virtual pointed at its console token
npm run headless -- run --server --data-dir .fbrx-core-dev --roles virtual,ai --console-token-file .fbrx-core-dev/console.token
FBRX_V_CORE_TOKEN_FILE=$PWD/.fbrx-core-dev/console.token npm run dev:virtual

scripts/server/bundle.sh && scripts/server/smoke.sh dist/fbrx-server-0.1.0   # the bundle, end to end
```

The code is in `apps/virtual` (service: `drivers/` for libvirt and the simulated hypervisor, `hardware/` for the map,
`bmc/` for Redfish) and `apps/virtual-console` (React, the FBRX UI kit, noVNC). The installer, bundle and ISO scripts
are in `scripts/server`. The FBRX core for the ai role is `packages/core/bin/fbrx-headless.ts`, bundled by
`scripts/server/build-core.mjs`.

### FBRX Server inside FBRX Endpoint (for now)

Until FBRX Server has its own download page, the FBRX Endpoint installers carry it: the installer ISO, the bundle and
the guides, under *Lab → FBRX Server* in the app (copy them to Downloads, check them against the fingerprints taken
when the installer was made, read the guides). `scripts/server/endpoint-resources.mjs` gathers them into
`apps/desktop/resources/server`; macOS and Linux packages carry them as app resources, and Windows Setup adds them once
for both processor types (`apps/desktop/build/installer.nsh`), stored as they are.

* **Release workflow:** builds the ISO and bundle first and packs them into the signed installers; the ISO and bundle
  are also attached to the GitHub release.
* **Install FBRX OS (the setup wizard):** builds the bundle and takes the ISO from the `fbrx-server-iso` download in
  your Downloads folder (the zip as downloaded from GitHub Actions, or the .iso). Without one, the app carries the
  bundle and guides only. `--no-server` leaves them all out.
* `scripts/server/bundle.mjs` is the bundle builder (bundle.sh runs it); it works on Windows and macOS too.
