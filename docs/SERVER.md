# FBRX Server and FBRX Virtual

**FBRX Server** is FBRX OS for servers: Debian 13 set up the FBRX way, running **FBRX Virtual**, the FBRX hypervisor.
FBRX Virtual runs virtual machines on KVM (through libvirt) and is managed from a web console on port **9443**:
virtual machines and their screens, storage and ISOs, networks, a live **hardware map** of the server, and the server
itself (health, power and **BIOS settings**) through its management controller.

> First stage (FBRX Virtual 0.1). It runs real virtual machines and is tested against a real hypervisor in CI. Clusters,
> backups of virtual machines and governance from FBRX Command come later (see [LINEUP.md](LINEUP.md)).

## Install

### A. From the FBRX Server ISO (wipes the server)

1. Get the ISO: the **FBRX Server ISO** workflow in GitHub Actions builds it (artifact `fbrx-server-iso`), or build it
   yourself on Linux: `scripts/server/bundle.sh --with-node && scripts/server/build-iso.sh` (needs `xorriso`).
2. Boot the server from it: write it to a USB stick (`dd`, or any image writer), or on a Dell PowerEdge mount it through
   the iDRAC: *Virtual Console → Virtual Media → Map CD/DVD*, then boot once from *Virtual CD/DVD/ISO* (F11 boot menu).
3. Pick **Install FBRX Server**. The installer asks only:
   * which disk to install on, and to confirm erasing it (it asks every time it is about to write),
   * the time zone,
   * the password of the administrator account `fbrx` (there is no root password; `fbrx` uses `sudo`).
   Everything else is answered: US English, DHCP, host name `fbrx-server`, LVM over the whole disk, SSH server.
4. At the end it installs FBRX Virtual and restarts. The server's screen then shows where to open the console and the
   first-time setup code.

The ISO is Debian's own network installer with FBRX Server added, so the server needs internet access while installing.

### B. On a Debian 13 server you already have

```bash
tar -xzf fbrx-server-0.1.0.tar.gz          # the CI artifact fbrx-server-bundle, or scripts/server/bundle.sh
sudo ./fbrx-server-0.1.0/install.sh
```

`install.sh` installs QEMU/KVM, libvirt, UEFI firmware (OVMF) and the software TPM (swtpm), Node.js 22 (kept in
`/opt/fbrx-server/node`, not system-wide) and FBRX Virtual, turns on the IOMMU in the kernel options (for device
passthrough, after one reboot) and starts the `fbrx-virtual` service.

| Option | |
| --- | --- |
| `--bridge eno1` | Makes bridge `br0` on that port so virtual machines sit straight on your network (applies after a reboot). Only for a port set up with DHCP; for a static address, see *Networks* below. |
| `--port 9443` | The console's port. |
| `--uninstall [--purge]` | Takes FBRX Virtual off again. Virtual machines and their disks stay unless `--purge`. |

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
fbrx-server restart                restart FBRX Virtual (virtual machines keep running)
fbrx-server users                  who can sign in
fbrx-server reset-password <user>  a new password for someone locked out
fbrx-server create-admin [name]    another administrator
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

## Security

* HTTPS with a certificate checked by fingerprint; sessions are random tokens stored hashed; passwords are scrypt
  hashes; sign-in is rate limited; the browser screen uses one-time tickets (30 seconds, one machine).
* The service runs as root because it drives the system hypervisor, moves interrupts and hands devices to machines;
  systemd keeps home folders and kernel modules out of its reach.
* virsh is called with argument lists (never a shell), and names, addresses and processor lists are checked before
  they reach it.
* The management controller's password is encrypted with a key kept in the data folder (`keys/master.key`, mode 600).

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

## Development

```bash
npm run dev:virtual            # FBRX Virtual on https://localhost:9443 (simulated; admin / fbrx-virtual-dev)
npm run dev:virtual-console    # the console with hot reload on http://localhost:5175
npx vitest run apps/virtual    # tests; FBRX_TEST_LIBVIRT=1 (as root, libvirt installed) adds the real-hypervisor test
```

The code is in `apps/virtual` (service: `drivers/` for libvirt and the simulated hypervisor, `hardware/` for the map,
`bmc/` for Redfish) and `apps/virtual-console` (React, the FBRX UI kit, noVNC). The installer, bundle and ISO scripts
are in `scripts/server`.
