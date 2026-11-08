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

With the **time** role the server makes image backups (**FBRX Time**, [TIME.md](TIME.md)): its virtual machines on a
schedule while they run, and the computers that send it their whole-computer images. It checks every image the way a
restore would: it opens it as a throwaway virtual machine with no network, confirms it starts, then shuts it down and
deletes it. Same console, *FBRX Time* page.

With the **command** role the server runs your organization's **FBRX Command**: the computers that join it, their
settings and policy, licenses, updates, backups and help desk, with its own console on port **8787**. It runs day and
night, so computers stay in touch with it, and it updates with the server. A server with the ai role also joins an
FBRX Command (its own or another) and takes its settings and policy from there (*FBRX Command* page, below).

Roles can be added and turned off later, from the console's *Roles* page or `fbrx-server roles` (below).

> FBRX Server 1.0. It runs real virtual machines and backs them up, and both are tested against a real hypervisor.
> FBRX Command runs on the server, and servers join it; clusters come later (see [LINEUP.md](LINEUP.md)).

## Install

### A. From the FBRX Server ISO (wipes the server)

1. Get the ISO: it comes with **FBRX Endpoint** for now (*Lab → FBRX Server*, with the bundle and these guides), the
   **FBRX Server ISO** workflow in GitHub Actions builds it (artifact `fbrx-server-iso`), or build it yourself on Linux:
   `scripts/server/bundle.sh --with-node && scripts/server/build-iso.sh` (needs `xorriso`).
2. Boot the server from it: write it to a USB stick (`dd`, or any image writer; if the writer offers a choice, pick
   the raw/DD image mode), or attach it as virtual media through the server's management controller (its remote
   console), then boot once from it (the one-time boot menu, often F11 or F12). In Hyper-V, use a generation 2
   machine.
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
tar -xzf fbrx-server-1.0.0.tar.gz          # from the FBRX website, or FBRX Endpoint (Lab → FBRX Server)
sudo bash fbrx-server-1.0.0/install.sh
```

`install.sh` installs QEMU/KVM, libvirt, UEFI firmware (OVMF) and the software TPM (swtpm), Node.js 22 (kept in
`/opt/fbrx-server/node`, not system-wide), FBRX Virtual and (ai role) the FBRX core, turns on the IOMMU in the kernel
options (for device passthrough, after one reboot) and starts the `fbrx-virtual` and `fbrx-core` services.

| Option | |
| --- | --- |
| `--roles virtual,ai` | What the server does (below). `--roles virtual` installs the hypervisor alone; `--roles virtual,ai,time` adds image backups; `--roles gate,minidome,ai` makes a gate without virtual machines. Change them later with `fbrx-server roles` or the console's *Roles* page. |
| `--gate-wan eno1 --gate-lan eno2` | The gate's internet port and the port to your network (gate role; see [GATE.md](GATE.md#install)). Your network avoids the addresses the internet side uses; `--gate-lan-address`, `--gate-wan-address` and `--gate-wan-gateway` choose them yourself. `--gate-manage <cidr\|none>` keeps the console and SSH reachable from a private network on the internet side. |
| `--reboot` | Restart at the end when a change waits for it (the gate taking its ports, the bridge). |
| `--command-address command.example.lan` | The address computers use to reach FBRX Command (command role): a name in your DNS, or an address. By default the one it has, else this server's address (the gate's address in your network, on a gate). |
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
| `time` | FBRX Time: image backups of virtual machines and computers, each checked by starting it ([TIME.md](TIME.md)); needs `virtual` | New in 1.0 |
| `command` | FBRX Command: your organization's computers, their settings and policy, licenses and updates, with its own console on port 8787 ([below](#fbrx-command-on-the-server-the-command-role)) | New |
| `dns` | Name service for the network | Planned |
| `directory` | Directory and sign-in for the organization's computers (a domain controller) | Planned |
| `files` | File sharing | Planned |

The web console comes with every role (it is FBRX Virtual's service, with or without virtual machines). The installer
refuses a planned role for now and says so.

### Changing roles

In the console, **Roles** lists every role with what it does: switch the ones you want on or off and choose *Change
the roles* (administrators). Adding FBRX Gate asks for its two ports first; turning it off warns that the network loses
its router. From the server's command line:

```
fbrx-server roles                         this server's roles, and how the last change went
sudo fbrx-server roles add time           add a role
sudo fbrx-server roles remove ai          turn one off (its data stays)
sudo fbrx-server roles set virtual,ai,time   exactly these roles
```

Both run the copy of the installer the server keeps (`/opt/fbrx-server/bundle`, kept by every install and update
from 1.0) with the new roles: it installs what an added role needs and stops what a removed one ran, keeping the port,
the settings and the gate's ports. The console restarts at the end (sign in again if it asks); the run is logged in
`/var/log/fbrx-server-roles.log` and its last lines show on the *Roles* page. A server on 0.1.x keeps no copy yet:
update it once (below), or run `install.sh --roles …` from a bundle.

## Before you install: the server's own settings

Any 64-bit (x86-64) PC or server works. Before (or after) installing:

1. **Firmware (BIOS/UEFI).** Turn on hardware virtualization (VT-x or AMD-V; fast virtual machines) and the IOMMU
   (VT-d or AMD-Vi; giving PCI devices to virtual machines). Boot in **UEFI** mode. If there is a power or system
   profile, pick **performance** (processors stay at full speed). On servers with network cards that split into
   virtual ones, turn on **SR-IOV**.
2. **Management controller** (most rack servers have one, a small computer that runs even when the server is off):
   give it an address on your network, change its default password, and make a separate administrator account for
   FBRX Virtual. FBRX Virtual's *Server & BIOS* page then shows its health and changes the firmware settings above
   for you (any Redfish controller; its *BIOS settings* list marks them **Recommended for FBRX Virtual**).
3. **Disks.** A RAID controller can offer the disks as one volume (pick that volume in the installer) or pass them
   through as they are (HBA or non-RAID mode, for software RAID or ZFS later).

## First sign-in

Open `https://<server address>:9443` from another computer, or in FBRX Endpoint add it under **Lab → FBRX Server →
Your servers** and open it there (a browser built into FBRX, with its own sign-ins; see below). FBRX Virtual makes its
own certificate, so the browser warns the first time: check that the fingerprint matches what the server shows
(`fbrx-server fingerprint`), then continue.
Enter the **setup code** (on the server's screen, or `sudo fbrx-server setup-code`) and make the first administrator.

Roles: **administrators** do everything (users, networks, deleting machines, device passthrough, interrupt placement,
the BIOS); **operators** run virtual machines (create, start, screens, snapshots, ISOs); **viewers** look. Every change
and sign-in is in the audit log.

## Using FBRX Virtual

* **Virtual machines.** *New virtual machine* picks sensible devices for the operating system: Windows gets SATA disks
  and an Intel network card (installs with no extra drivers), Secure Boot and a TPM for Windows 11; Linux gets the fast
  virtio devices. Disks are thin qcow2 files in `/var/lib/fbrx-virtual/images`.
* **Screen.** Each running machine's screen opens in the browser (VNC relayed by FBRX Virtual; the VNC ports themselves
  only listen on the server). Ctrl+Alt+Del and full screen are in the toolbar, and **Paste** sends text from your
  computer: it shows your clipboard (or a box to paste into), then types it into the machine as on a US keyboard, so it
  works anywhere, even on a login prompt or a BIOS screen. Click where the text should go first.
* **Snapshots.** Machines with BIOS firmware are snapshotted live, memory included. UEFI machines keep their firmware
  settings outside the disk, which QEMU cannot put in a snapshot, so they are snapshotted (and restored) while off.
* **Changes.** Processors and memory change at the machine's next start (the page says so); the CD drive, the disk size
  and processor placement change right away.
* **ISOs.** Upload installers, or have the server download them from a web address (faster).
* **Networks.** Each network is a card showing the way out: machines → the network or switch → where it leads, and
  which machines are plugged in. `default` is a private network with internet through the server: machines reach the
  internet, nothing on your network reaches them. To put machines **on your network** (next to your other devices,
  reachable from them, one more device for your router or gate):
  * **with FBRX Gate on this server**, turn on *Virtual machines can join this network* for a gate network (your LAN,
    a VLAN) and commit: it becomes a switch machines plug into ([GATE.md](GATE.md#virtual-machines-on-your-networks));
  * **otherwise**, a bridge on the port cabled to your network: the installer's `--bridge eno1`, or by hand.
  Any number of machines share a switch or bridge with the server itself. Giving a network card to one machine
  (*Hardware map*, passthrough) is different: that machine alone uses the card, at full speed.
  Pick the network when creating a machine, or move one under *its Settings → Network* (running machines move at
  once; the MAC address stays). For a server with a static address, add a bridge in `/etc/network/interfaces` yourself:

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
  may stop lower-priority help there). **This server's own requests go first** (on by default): its console's chats,
  MiniDome's and What If's explanations, its automations start on its AI before help for the mesh, and the work queue
  shows who the AI is answering and who waits. *Who can help?* lists the paired computers with their AI, load and roles;
  *Hand out work* sends a task to the best helper, every computer, or one; requests waiting for a yes, and all help
  asked and given (with the answers and follow-up questions), are on the same tab. See [MESH.md](MESH.md).
* **Work queue:** the requests of every computer that asks this server's AI, as they run and wait their turn, with the
  person and the computer that asked. Operators run one next, change its priority or cancel it; administrators pause
  the queue.
* **Log** (administrators): every request for 180 days, by person and by computer, with how it ended and who cancelled
  it; filter it and export it as CSV.
* **Computers on the mesh:** turn FBRX Mesh on or off, show a pairing code for another computer (on that computer:
  *Mesh & phone → Add a device → Enter a code*), join another computer's code, and set what each paired computer may do here,
  including **Help with AI** and **Controller**.
* **Models on this server:** run the AI right here, with FBRX's built-in runtime (llama.cpp), so the server is the
  big agent the other computers lean on (see below). Paired computers may also think with the model itself while their
  own agent keeps working on them (*AI models → Your other computers' AI* there; see
  [MESH.md](MESH.md#think-with-your-fbrx-servers-ai)): the same lending setting and Help with AI permission decide.
* **AI provider:** what this server's agent runs on: a cloud provider with an API key (kept encrypted in the core's
  vault, never shown again), or a model on your network (Ollama or any OpenAI-compatible server, by address).

### The AI sets itself up

On the first start of the ai role, the server gets its own AI ready without anyone choosing: it installs the runtime,
picks the best model the hardware runs well, downloads it and makes it the server's AI. With graphics cards, the
biggest model they hold (several cards add up); on processors alone, a model that answers quickly there (gpt-oss 120B
with 96 GB of memory or more, Qwen3 30B-A3B Instruct 2507 with 32 GB or more), otherwise the biggest everyday model
that fits; always leaving 20 GB of the disk free. *Fabrix* in the
console shows the progress (and *Try again* to administrators when a download fails). It happens once, and only when
nobody chose an AI for the server yet: a provider or model set by an administrator is never overruled, and after that
the choice is theirs (below).

### A bigger AI on the server

Endpoints run small models (or a cloud provider). A server with plenty of memory, or a graphics card, can run a much
larger one and lend it over FBRX Mesh: a computer whose own AI is too small for a job, runs out of steps or stops
answering asks Mesh Assist, which hands the work to the server (*Mesh Assist* tab: who may ask, how many at once, at
what priority).

1. *Mesh & AI → Models on this server* shows the server's memory, threads and graphics cards, and for every model
   whether it fits the graphics cards (llama.cpp spreads a model over all of them), fits in memory (processors only:
   slower, fine for background work), only just fits, or is too big. Leave room for the virtual machines.
   `sudo fbrx-server ai recommend` names the best one for this server.
2. **Install the runtime** (a small download from the llama.cpp project's own releases; the graphics-card build when
   the server has a card it can use).
3. **Download** a model. Besides the desktop ones there are models *for servers*:
   * **Qwen3 30B-A3B Instruct 2507** (~19 GB): only 3B of its 30B parameters work at a time, so it answers quickly
     without a graphics card, and it reads long material (a 128K-token context here). The one to start with on a
     server with 32 GB or more. (The earlier **Qwen3 30B-A3B**, which thinks before it answers, is there too.)
   * **Qwen3 32B** (~20 GB): stronger and careful, at home on a 24 GB graphics card; slow on processors alone.
   * **Llama 3.3 70B Instruct** (~43 GB): for 64 GB+ of memory or 48 GB of graphics memory.
   * **gpt-oss 120B** (~63 GB): the most capable model that still answers quickly on processors (5B of its 117B
     parameters at a time), with a 128K-token context. For 96 GB+ of memory or 80 GB of graphics memory.
   * **Qwen3 235B-A22B Instruct 2507** (~143 GB): the largest, close to the best open models. For 192 GB+ of memory;
     22B parameters at a time make it slow on processors alone, quick with graphics cards to help.

   A download checks first that the disk has room for it and 20 GB to spare, resumes where it stopped when interrupted,
   and is checked before use. The biggest models come in several files: they download as one.
4. **Use it**: the model becomes this server's AI (the built-in runtime turns on and becomes the default provider).
   The runtime starts at the first question and stops after a while unused. `sudo fbrx-server ai download <id> --use`
   does both in one go.

**Any GGUF model on Hugging Face.** *A model of your own → From Hugging Face* (or `sudo fbrx-server ai add`) takes the
model's repository, `owner/name` or its address, with its quantization after a colon when it is not Q4_K_M
(`bartowski/Qwen_Qwen3-14B-GGUF:Q6_K`). FBRX finds its files (every part of a model in several), adds it to the list
and downloads it like the others, checking every file against the checksum Hugging Face publishes. Public models only:
FBRX does not sign in to Hugging Face. Its tools work when the model's chat template supports tool calls. *Take off
the list* (or `fbrx-server ai delete`) removes it again.

A GGUF file of your own works too: copy it to the server (not into a home folder: the core cannot see those), then
`sudo fbrx-server ai import /srv/model.gguf "Its name"`.

**The context window** is how much the model keeps in mind at once: the conversation, a long log, several documents.
On **Auto** (the default) the server gives it as much as it has room for, up to 128K tokens and never more than the
model was made for: in memory, after the model and a quarter left for the system and the virtual machines; on the
graphics cards, what they have left after the model, so the model stays on them. Kept in 8 bits with flash attention,
it takes about half the memory it otherwise would. *Mesh & AI → Models on this server* shows it and lets
administrators fix it (16K to 256K tokens; `sudo fbrx-server ai context 64k`, or `auto`); the runtime restarts with it
at the next question. A long context window only helps models made for it: the 2507 Qwen3 models, gpt-oss and Llama 3.3
read 128K tokens, the earlier Qwen3 models 32K.

From the command line (as root):

| | |
| --- | --- |
| `fbrx-server ai` | the runtime, the model in use, its context window, memory, graphics and disk |
| `fbrx-server ai models` | every model, what fits this server, its context, which are downloaded |
| `fbrx-server ai recommend` | the best model for this server, and the command that installs it |
| `fbrx-server ai install-runtime` | install or update the runtime |
| `fbrx-server ai download <id> [--use]` | download a model with its progress, speed and time left (Ctrl+C stops watching; the download goes on); `--use` then makes it this server's AI |
| `fbrx-server ai download <owner/name[:QUANT]> [--use]` | the same for a GGUF model on Hugging Face |
| `fbrx-server ai add <owner/name[:QUANT]> [name]` | put a Hugging Face model on the list |
| `fbrx-server ai use <id>` | make it this server's AI |
| `fbrx-server ai delete <id>` | delete a model (one added from Hugging Face also leaves the list) |
| `fbrx-server ai context [auto\|64k\|128k\|<tokens>]` | the context window |
| `fbrx-server ai import <file> [name]` | a GGUF file copied to the server |
| `fbrx-server ai start`, `stop`, `logs` | the runtime itself |

**Graphics cards.** The installer gives the core's account the `render` and `video` groups and, when it finds an
AMD, Intel or NVIDIA card, installs the Vulkan libraries. AMD and Intel cards work with Debian's own drivers; an
NVIDIA card also needs NVIDIA's driver (Debian's `nvidia-driver`, from the non-free section). Without a usable card the
runtime uses the processors.

Viewers see the models; operators start and stop the runtime; administrators install the runtime, download, delete
and choose models (they fill the disk and decide what the server's AI is).

**Who may do what.** Viewers see it all. Operators answer Mesh Assist's requests for help and hand out work.
Administrators change the settings, pair computers, set permissions, choose the provider, save keys and answer any
approval. Every change is in FBRX Virtual's audit log and, with the console user's name, in the core's own.

**How the console reaches the core.** At every start the core writes a new random **console token** to
`/var/lib/fbrx-core/console.token` (readable by root only); FBRX Virtual, which runs as root, reads it and calls the
core's Local API on `127.0.0.1` with it, as the person signed in to the console. FBRX Virtual passes on only the
calls the page makes, with the role each needs, and only the settings above (never the core's policy, Local API or
system prompt). The console token can never read a secret back or the Local API's automation tokens.

## Fabrix in the console

*Fabrix* (in the console's Server section, with the ai role) is a chat with the server's own agent: ask how the
server is doing, which virtual machines use what, what filled the disk, or hand it a job. Its answer shows as it is
written, with each step it takes; Stop ends a run. It works under the server's FBRX policy like on any FBRX computer:
it looks things up freely, and what needs a yes waits for an administrator (in the chat, or under Mesh & AI). A new
chat stays offline unless *May use the internet* is on.

**Attach** (or drop, or paste) files and pictures for it to read, up to ten a message and 25 MB each: they go to the
server, where its agent reads them. What it makes (documents, drawings) shows under the step that made it, pictures as
a thumbnail, and **Download** brings a file to the computer you are on; an attached file downloads the same way. It
gives out only what it made or was given, nothing else on the server. Drawings come as SVG (the server has no window
to turn them into PNG); pictures from a description need a picture maker, which the server does not run yet.

**Ask the AI**, all over the console, opens a new chat about what you are looking at, with its details already in the
box: a virtual machine, a warning on the overview, a device in the hardware map, a storage pool, the hardware event
log, a change of roles that did not finish, the gate and its firewall, and what is on the terminal's screen. Add your
own question or send it as it is; nothing is sent until you do.

Operators and administrators chat; administrators also delete chats. FBRX Virtual's audit log records who asked and
how long the question was, never what it said, and of an attached file only its name, type and size.

If a page of the console ever fails to draw, it says what went wrong, with **Try again** and **Reload**; the rest of
the console keeps working.

## FBRX Command on the server (the command role)

The **FBRX Command** page (Server section) shows where FBRX Command is, the fingerprint of its certificate and, until
someone sets it up, its **setup token** (administrators only; `sudo fbrx-server command` shows the same).

1. **Set it up.** Open its address (`https://<server address>:8787`; *Open FBRX Command* on the page). FBRX Command
   makes its own certificate, so the browser warns the first time: compare the fingerprint with the page's. Enter
   the setup token, your organization (Work, School or Home) and the first administrator. The rest is FBRX Command
   as in [ADMIN_CONSOLE.md](ADMIN_CONSOLE.md).
2. **Computers join it** from *Deploy & enroll* in FBRX Command, as on any FBRX Command: an enrollment token, a
   provisioning file, a device-manager script. They pin its certificate's fingerprint when they join.
3. **Keep its address.** Computers keep the address they joined with: give the server a fixed address in your router,
   or a name in your DNS (`install.sh --command-address <name>` sets it; computers that joined before keep the old one).

On a gate, a new gate lets your network reach FBRX Command from the start (a firewall rule, *FBRX Command for your
network*). On a gate set up before the command role, the page says when the rule is missing: add it under *Gate →
Firewall* (from your network to the gate, TCP 8787, accept).

**This server in FBRX Command.** With the ai role, the page's second card joins this server to an FBRX Command: paste an
enrollment token from FBRX Command (*Deploy & enroll*). On a server with the command role it joins its own FBRX Command,
trusting its certificate by itself; otherwise enter the other FBRX Command's address and fingerprint too. The server's
FBRX core then shows in FBRX Command as one of the organization's computers and takes its settings and policy from
there. *Leave FBRX Command* undoes it.

**Updates and data.** FBRX Command updates with the server (`sudo fbrx-server update`; its *Releases* page says so
instead of offering *Update now*), and an update's rollback brings its database and settings back too. Its data
(database, keys, certificate, uploads) is in `/var/lib/fbrx-command`; turning the role off keeps it, `--uninstall
--purge` deletes it. Its settings are in `/etc/fbrx-command/fbrx-command.env` (the address, port and certificate; see
DEPLOYMENT.md → Configuration) and its secrets in `/etc/fbrx-command/secrets.env`, which only root reads (the setup
token; an e-mail server's address with its password goes here too). `sudo systemctl restart fbrx-command` after a
change.

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

## Server & BIOS (Redfish management controllers)

*Server & BIOS → Connect*: enter the controller's address, check the certificate it presents (compare its fingerprint
with the one on the controller's own web page, usually under its network or SSL settings), trust it and sign in. From then on FBRX Virtual
talks only to that exact controller, and keeps the password encrypted.

* **Health & power:** model, service tag, BIOS and controller firmware, temperatures, fans, power use; turn the server
  on, shut it down, restart or force it (the page reminds you every virtual machine stops with it).
* **BIOS settings:** every setting by group, with the maker's names, choices and help. Changes are **staged** and applied
  by the server at its next restart (some controllers do this through a configuration job, which the page lists).
  *Apply at next restart* or *Apply and restart now*; *Throw them away* cancels staged changes. *Next start: BIOS setup*
  boots into the setup screen once (see it through the controller's remote console).
* **Event log:** the hardware event log (memory, power supply, fan and temperature events).

## Terminal

*Server → Terminal* (administrators only) is the server's own shell in the browser: bash as root on its Debian, the
same as sitting at the server's keyboard or signing in over SSH. It opens in your home folder (`/root`), sees the whole
system, and runs every command line tool on the server, `fbrx-server` and `fbrx-gate` included.

* **Ctrl+C** stops the running command. With text selected, Ctrl+C copies it instead (Ctrl+Shift+C always copies).
* **Paste** types the text on your clipboard into the shell; **Ctrl+Shift+V** (Cmd+V on a Mac) does the same from the
  keyboard. Over plain HTTP some browsers keep the clipboard to themselves: then the keyboard shortcut is the way.
* The terminal follows the size of the window; **Full screen** gives it the whole screen.
* **End session** closes the shell, and so does `exit`. Closing the tab or signing out ends it too: nothing keeps running
  after you leave (start long jobs with `systemd-run` or in `tmux` if you need them to carry on).
* Up to four terminals can be open on a server at once.

Every session is in *Users & audit* (who opened it, when, and for how long), and what was on the screen is recorded on
the server in `/var/lib/fbrx-virtual/terminal`, readable by root only and kept 30 days. What you type without it being
shown, such as a password, is not in the recording.

The terminal is on with FBRX Server. To turn it off, add `FBRX_V_TERMINAL=off` to the settings below and restart the
service; FBRX Virtual installed some other way has it off unless you set `FBRX_V_TERMINAL=on`.

## Everyday commands

```
fbrx-server status                 where the console is, service and hypervisor state, certificate fingerprint
fbrx-server doctor [--fix]         every service this server's roles need, on and running; --fix switches on what is off
fbrx-server roles [add|remove|set] this server's roles, and changing them (above)
fbrx-server update [check|commit|rollback]   updating FBRX Server (below)
fbrx-server setup-code             the first-time setup code
fbrx-server logs [-f]              FBRX Virtual's log
fbrx-server logs ai [-f]           the FBRX core's log (agent, FBRX Mesh, Mesh Assist)
fbrx-server restart                restart FBRX Virtual (virtual machines keep running)
fbrx-server restart ai             restart the FBRX core
fbrx-server command                FBRX Command (command role): address, certificate, setup token until set up
fbrx-server logs command [-f]      FBRX Command's log
fbrx-server restart command        restart FBRX Command (computers reconnect by themselves)
fbrx-server users                  who can sign in
fbrx-server reset-password <user>  a new password for someone locked out
fbrx-server create-admin [name]    another administrator
fbrx-gate help                     FBRX Gate's own commands (gate role, see GATE.md)
```

## Updating FBRX Server

```bash
sudo fbrx-server update check     # is there a newer FBRX Server? If so: downloaded, checked, unpacked, ready
sudo fbrx-server update           # what runs, what is ready to install, what came before
sudo fbrx-server update commit    # install it
sudo fbrx-server update rollback  # back to the version before the last update
```

* **check** reads the release list (`release.json` in the FBRX repository, its `server` entry) and, when it names a
  newer version, downloads the bundle from the GitHub release, compares it with its published SHA-256 (refusing it if
  they differ, or if there is none) and unpacks it into `/var/lib/fbrx-server-update/staged`. Nothing that runs
  changes. `--file <fbrx-server-x.y.z.tar.gz>` uses a bundle you brought along instead (a USB stick, or the copy inside
  FBRX Endpoint's installer); `--force` gets a version ready that is not newer (to repair, or to go back on purpose).
  `FBRX_SERVER_UPDATE_URL` in `/etc/fbrx-virtual/fbrx-virtual.env` points it at another release list.
* **commit** keeps the running version aside (its programs, settings, service files and databases; virtual disks,
  ISOs and AI models are never touched by an update), then runs the new version's own installer with this server's
  roles, port and settings. Virtual machines keep running and the gate keeps routing; the console and the AI role
  restart. If the installer fails, or the console does not answer within a minute and a half, the server goes back to
  the version it had by itself, and the new one stays ready to try again. The whole run is logged in
  `/var/log/fbrx-server-update.log`.
* **rollback** puts the kept version back, its databases included (changes made in the console since the update go
  back with them).

`fbrx-server status` says when an update is ready. A server installed before `update` existed (FBRX Server 0.1.0)
updates by hand once, then with these commands from then on:

```bash
curl -fsSLO https://github.com/samfoxhuntress/FBRX/releases/download/v1.9.8/fbrx-server-1.0.0.tar.gz
curl -fsSLO https://github.com/samfoxhuntress/FBRX/releases/download/v1.9.8/fbrx-server-1.0.0.tar.gz.sha256
sha256sum -c fbrx-server-1.0.0.tar.gz.sha256  # says OK, or stop here
tar -xzf fbrx-server-1.0.0.tar.gz
sudo bash fbrx-server-1.0.0/install.sh        # keeps the roles, port and settings this server has
sudo fbrx-server doctor
```

A server on 0.1.1 or later needs none of this: `sudo fbrx-server update check`, then `sudo fbrx-server update commit`.

No new ISO is needed for this, or for any update: the ISO is only for a server's first install.

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
| `FBRX_V_GATE_LAN_ADDRESS` | | Your network's addresses in the starter configuration (default: 192.168.1.1/24, or the next free choice clear of the internet side's). |
| `FBRX_V_GATE_WAN_ADDRESS` / `FBRX_V_GATE_WAN_GATEWAY` | | A fixed internet address in the starter configuration (both, or DHCP). |
| `FBRX_V_COMMAND_URL` | `http://127.0.0.1:8788` | FBRX Command's local-only address (command role), where the console checks on it. |
| `FBRX_V_TERMINAL` | `on` with FBRX Server | `off` removes the Terminal; `on` turns it on elsewhere (Linux only). |
| `FBRX_V_TERMINAL_RECORD` | | `off`: do not record terminal sessions. |
| `FBRX_V_TERMINAL_KEEP_DAYS` | `30` | How long terminal recordings are kept. |

`/etc/fbrx-core/fbrx-core.env` (ai role; `sudo systemctl restart fbrx-core` after a change): `FBRX_SERVER_ROLES`, the
roles this server announces (the installer writes it). Everything else about the core is set from *Mesh & AI*.

## Security

* HTTPS with a certificate checked by fingerprint; sessions are random tokens stored hashed; passwords are scrypt
  hashes; sign-in is rate limited; the browser screen and the terminal use one-time tickets (30 seconds, one use).
* The terminal is for administrators only, audited and recorded. On FBRX Server each terminal runs as a systemd service
  of its own (outside the console's sandbox, so it sees the whole system) and is stopped when its browser tab goes.
* The service runs as root because it drives the system hypervisor, moves interrupts and hands devices to machines;
  systemd keeps home folders and kernel modules out of its reach.
* virsh is called with argument lists (never a shell), and names, addresses and processor lists are checked before
  they reach it.
* The management controller's password is encrypted with a key kept in the data folder (`keys/master.key`, mode 600).
* The FBRX core (ai role) runs unprivileged and sandboxed by systemd (read-only system, only its data folder
  writable); see *Mesh & AI* for how the console reaches it.
* FBRX Command (command role) runs unprivileged and sandboxed the same way, as its own `fbrx-command` account; its
  secrets file is readable by root only, and the console reads its status on a port only this computer reaches.

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
| `GET/POST /auth/app-tokens`, `DELETE /auth/app-tokens/:id` | Apps with read-only access (administrators; an app may give its own up) |
| `GET /troubleshoot` | The network as the server sees it, for troubleshooting: the server's warnings, FBRX Gate and FBRX MiniDome (viewers) |
| `GET /host/terminal`, `POST /host/terminal` → ticket, WebSocket `/host/terminal/ws?ticket=&cols=&rows=` | The server's shell (administrators): binary frames are the screen both ways, a text frame `{"type":"resize","cols":…,"rows":…}` sets the size |
| `POST /vms/:id/hostdevs`, `DELETE /vms/:id/hostdevs/:address` | Device passthrough |
| `GET /storage/pools`, `GET/DELETE /storage/pools/:pool/volumes[/:name]` | Storage |
| `GET /isos`, `PUT /isos/:name` (upload), `POST /isos/download`, `DELETE /isos/:name` | ISO library |
| `GET/POST /networks`, `DELETE /networks/:name` | Networks |
| `GET /hardware/topology`, `GET /hardware/flows`, `PUT /hardware/devices/:address/irqs`, `PUT /hardware/irqs/:irq`, `PUT /hardware/irqbalance` | Hardware map |
| `GET/PUT/DELETE /bmc`, `POST /bmc/probe`, `GET /bmc/system`, `/sensors`, `/logs`, `POST /bmc/power`, `POST /bmc/boot-to-setup`, `GET/PATCH /bmc/bios`, `DELETE /bmc/bios/pending` | Server management |
| `/gate/…` | FBRX Gate (gate role): see [GATE.md](GATE.md#api) |
| `/dome/…` | FBRX MiniDome (minidome role): see [MINIDOME.md](MINIDOME.md#api) |
| `GET /core`, `POST /core/call` `{ method, params }` | The FBRX core (ai role): `system.status`, `settings.get`, `ai.providers`, `mesh.status`, `mesh.assist.helpers`, `mesh.assist.sessions`, `approvals.list` (viewers); `mesh.assist.send`, `mesh.assist.followUp`, `mesh.assist.cancel`, `approvals.resolve` for Mesh Assist (operators); `settings.update` (Mesh Assist and AI provider settings), `vault.set` (provider keys), `vault.list`, `ai.models`, `mesh.setEnabled`, `mesh.rename`, `mesh.startPairing`, `mesh.cancelPairing`, `mesh.pair`, `mesh.removeDevice`, `mesh.setPermissions` (administrators) |

## Your servers in FBRX Endpoint

*Lab → FBRX Server → Your servers* keeps the servers you manage: FBRX Server's console (port 9443) or any other web
page a server or device has (a NAS, another hypervisor, a management controller). FBRX Servers paired on FBRX Mesh
are offered there. *Open* shows the console inside FBRX, in a browser of its own:

* its sign-ins, cookies and storage are kept apart from everything else in FBRX, and the page cannot reach FBRX
  itself (no FBRX bridge, no Node.js, only clipboard writes and full screen allowed);
* a certificate a public authority vouches for opens straight away. FBRX Server's own certificate is shown the first
  time with its fingerprint to compare with the server's (`fbrx-server fingerprint`); once trusted, FBRX accepts
  exactly that certificate at exactly that address and port, and stops with a warning if the server ever presents
  another one;
* links to the same server open in place (back, forward and reload in the bar); anything else opens in your own
  browser, as does the button at the end of the bar.

**Remote desktop.** An FBRX Server (a saved server on port 9443) opens as a remote desktop: its console, with the
dashboard, the roles and every virtual machine's screen, and **Terminal**, a command line on the server over SSH under
the console (the host key is confirmed the first time, a password can be kept encrypted in the vault, and the session
is also in Terminal → Device consoles, with the FBRX Server guide). **Full screen** fills the screen with it, and **In a
window of its own** gives the server a window beside FBRX. Away from home, connect [FBRX VPN](VPN.md) first: the bar
shows *FBRX VPN* when the server is reached through your gate, and a server that does not answer offers to connect it.
When the server is the gate itself, its console, SSH and FBRX Mesh answer VPN devices while the gate's VPN has full
access (the default). The server has no graphical desktop of its own yet; the console is its screen.

**Let Fabrix look.** On an FBRX Server in *Your servers*, **Let Fabrix look** lets Fabrix check the network through it
when you ask it to troubleshoot: FBRX Gate (its internet side: link, address and router; your networks, DHCP and DNS;
a change waiting to be confirmed; problems it found) and FBRX MiniDome (whether its sensors work, and the worst open
findings). An administrator of the server signs in once. The server then gives this computer read-only access: it can
look at everything above but never change anything, and it never sees keys or passwords. The password you typed is
not kept; the access is, in your vault (unlock it if FBRX asks). **Stop** gives the access back. On the server,
*Users & audit → Apps with access* lists every computer that may look, when each last did, and **Revoke**s any of them.

## FBRX Server inside FBRX Endpoint (for now)

Until FBRX Server has its own download page, the FBRX Endpoint installers carry it: the installer ISO, the bundle and
the guides, under *Lab → FBRX Server* in the app (copy them to Downloads, check them against the fingerprints taken
when the installer was made, read the guides). A copy you build with **Install FBRX OS** carries the bundle and guides,
and the ISO too when the `fbrx-server-iso` download (the zip, or the .iso) is in your Downloads folder; `--no-server`
leaves them all out.
