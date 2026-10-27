# Mesh and FBRX Mobile

The mesh links one person's devices: this computer, their other FBRX OS computers and their phone. It is off until
you turn it on in **Mesh & phone**; then FBRX listens on port 47800 (configurable) on the local network.

## What paired devices can do

Each device gets its own permissions on *this* computer, changeable at any time and effective immediately:

| Permission | Phones (default) | Computers (default) |
| --- | :-: | :-: |
| See how it is doing (health, performance, services) | ✔ | ✔ |
| Messages (to this computer alone or to everyone) and notifications | ✔ | ✔ |
| Ask this computer's agent | ✔ | |
| Approve or deny waiting actions | ✔ | |
| Tasks and notes | ✔ | |
| Receive alerts | ✔ | |
| Lock and sleep | | |
| Borrow its AI (Mesh Assist, below) | — | ✔ |
| Controller (Mesh Assist, below) | — | |
| Network protection (a gate's FBRX MiniDome, below) | | |

Each device card offers one choice, **What it may do here**: *The usual* (the defaults above), *Full trust* (everything
but the two special permissions), *Messages only* or *Paused* (stays paired, can do nothing). **Choose one by one**
opens every permission, each with an (i) that explains it; **Network protection** and **Controller** are special and
never part of a preset. *Message* (opens the conversation with it in **Messages**, see [MESSAGES.md](MESSAGES.md)),
*Ask its agent* and *How is it doing?* are on the card; *Send a ping*, *Find my
phone*, *Lock it*, *Put it to sleep* and *Remove* are under **More**.

Requests from another *computer* follow **When another computer asks this computer's agent**: ask me first (an
approval appears here), allow, or never; a device can never approve its own request. Phones you pair are yours, so
their requests skip that first question (turn off *Ask the agent* for a phone to stop them). Either way the agent runs
under this computer's policy: each risky tool call still waits for an approval.

**FBRX Mobile** is a small web app the computer serves to paired phones at `http://<computer>:47800/m/`. Add it to
the home screen. It shows status, alerts, tasks, messages and waiting approvals, lets you ask the agent, and can
make the phone ring (*Find my phone*). It refreshes while open; phones are not woken in the background.

When the computer runs **Endpoint Essentials**, FBRX Mobile is as simple as the computer: **Home** is the split-flap
board (a greeting, the date, whether the AI is ready) and a few notes from FBRX: tips and tricks (each can be
dismissed), **AI models** (the models on the computer, and *Use* to switch to one, for a phone that may ask the AI)
and what Standard and Ultra add. Its tabs are Home, Ask, AI (and Approve when something waits). The notes are the
same ones as on the computer's Home (`packages/shared/src/essentials-home.ts`).

## Mesh Assist: computers lending each other their AI

When the agent on one computer runs out of room, another computer on the mesh finishes the job, and the two can talk
it through. It also lets one computer (typically a server) hand work out to the others.

**When help is brought in** (each one a setting under **Mesh & phone → Share AI → Fine-tune**; *Sharing* sets asking and lending together):

* **Out of steps.** The agent reached its step limit for a task: the task, a digest of what was done so far and what
  is left go to a helper, whose answer finishes the reply (marked as coming from that computer).
* **The AI provider stopped answering.** Out of credits, over a quota or rate limit, a billing problem, an outage or a
  network failure: the same handover, instead of an error.
* **The agent asks.** Mid-task, the agent can look at who could help (`mesh.helpers`) and consult another computer's
  agent (`mesh.consult`), with follow-up questions in the same conversation on the helper.
* **A person or a controller sends work** to the best helper, to every computer, or to one, with a priority.

**Who helps.** The asking computer asks each paired computer what it can do right now (its AI and model, whether it
runs locally, how busy it is, its processor load and the roles it announces) and picks the best one: one that helps
right away before one that asks its person, a ready AI, a free slot, a light load.

**The settings, on both sides:**

| Setting | Default | |
| --- | --- | --- |
| Bring another computer's AI in | Ask me first | Off, ask the person here first (an approval), or automatically. |
| When the agent runs out of steps / when the AI provider stops answering / the agent may consult | On | Which of the above may bring help in. |
| Priority of this computer's requests | Normal | Background, normal, high (urgent is for controllers). |
| Lend the agent to other computers | Ask me first | Off, ask the person here first, or automatically. |
| While helping, the agent here may | Look things up | Think and answer only, read-only tools, or anything its policy allows. |
| Help at the same time / steps per request | 1 / 12 | The rest waits in a queue, highest priority first. |
| Urgent work from a controller may stop lower-priority help | On | The stopped help is told why. |

The **Help with AI** permission decides which paired computers may ask at all (on by default between computers, never
for phones).

**Priorities and controllers.** Requests are background, normal, high or urgent; a helper runs the most urgent first.
A **controller** is a computer you trust to hand out work: give it the **Controller** permission on each computer
that should obey it. A controller's requests (when FBRX runs as administrator there, or, on FBRX Server, when its
console's administrators made it a controller) run without the helper's person being asked, may be urgent, and may
stop lower-priority help that is running. Without the Controller permission a computer treats it like any other.

**What never changes:**

* Help runs under the **helping** computer's policy and Guardian: every risky tool call there still needs its usual
  approval, and the helper works with its own files, not the asker's.
* Help is never passed along twice: a helper cannot bring a third computer in.
* Everything is in both computers' audit logs (`assist.*`, `run.handoff`), and either side can stop a request.
* Requests travel over the same sealed, authenticated mesh connection as everything else.

## Prefer Mesh

A fast lane for traffic between FBRX computers, so their AI helping each other does not wait behind a backup or a
download. Turn it on in **Mesh & phone → Network** (on an FBRX Server: *Mesh & AI → Network*).

* **Mesh networks first.** List the networks the computers should reach each other through, in order (a VLAN for AI
  and servers, say). Computers tell each other their addresses when they say hello, and each one picks the other's
  address inside a mesh network; if it does not answer, the usual address is used and the mesh address is tried again
  five minutes later.
* **TCP, kept open.** Mesh calls go over TCP connections that are kept alive and send at once (no delay), so a
  conversation between two computers does not start a new handshake each time.
* **Marked for priority.** Mesh traffic (TCP port 47800) is marked with a DSCP class: AF41 by default (interactive,
  below voice calls; EF and CS5 sit higher, CS0 turns the priority off). Switches that trust DSCP, and FBRX Gate, put it
  in a faster queue. Marking is set up on Linux with an nftables table (`inet fbrx_mesh`, as root) and on Windows with
  a QoS policy (after an administrator prompt); macOS does not mark.
* **Jumbo frames.** If the mesh networks run at MTU 9000, say so: the page checks each computer's mesh interface and
  the test sends a 9000-byte packet that may not be split, to see whether every switch on the way takes it.
* **Test the paths.** *Test* shows, for each paired computer, which address it is reached on, whether that is a mesh
  address, the round trip, and the jumbo-frame result.

FBRX Gate does the network's side: it marks mesh traffic it routes (and everything from a mesh VLAN), shapes the
internet line with a priority lane, and offers jumbo frames on the mesh VLAN. See [GATE.md](GATE.md#traffic-priority-and-prefer-mesh).

## Network protection: FBRX MiniDome and FBRX Shield

A gate's **FBRX MiniDome** ([MINIDOME.md](MINIDOME.md)) watches the network. With **Network protection** allowed for the
gate's server, this computer gets an alert when MiniDome saw something coming from it (a known-bad domain, a DNS
tunnel, …), and MiniDome may see how this computer is protected (its antivirus and threats found). It is off until you
allow it, per paired server.

## Pairing

1. **Mesh & phone → Add a device → Show a code on this computer** shows a QR code and a 20-character one-time code (100 bits), valid for five
   minutes.
2. A phone scans the QR code (it contains the computer's address, the code and the computer's key fingerprint), with
   the camera (FBRX Mobile opens in the browser) or with **Scan the code** in the FBRX app ([STORES.md](STORES.md));
   another computer uses **Add a device → Enter a code from another computer** (or **Join** beside it under *FBRX
   computers nearby*) and types the code.
3. The joining device creates its own X25519 key pair and sends its public key with
   `HMAC-SHA512(code, "fbrx-pair-v1" | its key | the computer's key)`. The computer checks it, stores the device and
   answers with its own HMAC over both keys and the new device id, which the joining device checks before trusting
   the computer. Both sides have proved they know the code, so a device in the middle cannot substitute its keys.
4. The code is used once. Five wrong attempts end the pairing session (and notify you); pairing requests are also
   rate-limited per address.

Compare the fingerprints shown on both screens if you want to be certain.

## Every request

Requests between paired devices are JSON sealed with NaCl `box` (X25519 + XSalsa20-Poly1305) using the sender's
secret key and the recipient's public key, so each request is both encrypted and authenticated. Each carries a
random id and a timestamp; the receiver refuses requests older or newer than two minutes and any id it has already
seen. Replies are sealed the same way and tied to the request id. Removing a device deletes its key; its next request
is refused.

The computer's secret key lives in the credential vault (encrypted under the OS keychain). The phone's key lives in
the phone's browser storage for the FBRX Mobile page.

## Limits to know about

* **Local network only.** The mesh is meant for your home or office network. To reach your devices from elsewhere,
  connect with **FBRX VPN** to your FBRX Gate ([VPN.md](VPN.md)) rather than forwarding the port: the mesh then works
  through the tunnel, your FBRX Server's AI included.
* **The phone app arrives over plain HTTP.** Requests are end-to-end encrypted, but the web page itself is served
  unencrypted by your computer, so someone actively attacking your local network at the moment you open FBRX
  Mobile could tamper with the page. Pair and use the phone app on networks you trust. (A future native app removes
  this.)
* **Windows Firewall** asks once whether FBRX OS may accept connections; allow it on *private* networks only.
* Clocks must be within two minutes of each other.

## Organizations

**An organization's computers mesh by themselves.** Every computer enrolled in FBRX Command reports its mesh key,
port, addresses and server roles in its heartbeat. FBRX Command hands each computer a roster of the organization's
other computers, and because it vouches for their keys over the enrolled connection, they trust each other without
pairing codes. FBRX Mesh turns itself on at each computer (unless a profile locks `mesh.enabled` off). The roster
comes again whenever a computer joins, moves or changes roles (FBRX Command nudges every online computer), when a
computer reconnects, and every ten minutes.

What the organization's computers may do on each other is the organization's choice, not each computer's:

| | |
| --- | --- |
| See each other and message | Always (messages only while Messages is on for the organization) |
| Borrow a server's AI (Mesh Assist) | On a server with the **ai** role, for the groups the **hive** allows (every group by default) |
| Network protection | A server with the **minidome** role may warn the others about threats it sees |
| The agent, approvals, tasks, control, controller | Never through the organization; pair by hand for those |

In FBRX Command: *Profiles & groups → FBRX Mesh*: the computers mesh together (on or off), and *Who may use the
servers' AI*: every group, or the groups chosen. Changes reach online computers at once. On each computer the
organization's computers show *from your organization* on the Mesh page; they cannot be removed or given more
rights there, and leaving the organization (or the organization turning its mesh off) forgets them. Computers and
phones paired by hand stay as they are.

The mesh is otherwise per person. Administrators can switch it off for a tenant or group by locking `mesh.enabled` to
`false` in managed settings (and Mesh Assist on its own with the `mesh.assist.*` settings); device pairing, the
organization's introductions, requests and permission changes are written to the audit log (`category: mesh`).
