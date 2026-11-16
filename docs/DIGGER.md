# FBRX Digger

FBRX Digger is the FBRX **Network Center on its own**: a small app for anyone who looks after networks, with every
network tool FBRX has and nothing else. It runs on Windows, macOS and Linux, beside FBRX Endpoint, and comes with
**Endpoint Ultra** (and Black Hole Edition).

## What it does

* **Overview**: this computer, the router, internet latency and loss, the public address and a plain-language verdict.
  **Check every layer** finds where a network stops working, from the adapter and Wi-Fi signal through the router,
  the address, routing, names (DNS) and secure connections up to websites, with what to do first and the commands
  that show each layer by hand.
* **Devices**: scan the network (ping sweep, ARP, mDNS/Bonjour, UPnP, port fingerprints and the IEEE MAC registry
  name PCs, phones, printers, TVs, cameras, smart-home devices and NAS), save scans, **compare** two scans to see what
  joined and what left, and export them as CSV.
* **Ping and trace route** with each hop identified (your router, double NAT, your provider, the internet).
* **Speed test** with history.
* **Wi-Fi channel planner**: every network around drawn over the channels it covers, how busy each channel is, the
  best channel for your network with the reason, the channel width to set, DFS channels, how busy each channel has
  been, and every access point with its signal.
* **Tools**: DNS comparison and port checks.
* **Remote desktop and screen sharing**: a computer's desktop over RDP, or its screen over VNC, from a scan (when it
  has port 3389 or 5900 open) or *New connection*. It opens in this computer's own viewer (Remote Desktop Connection
  on Windows, Screen Sharing on a Mac, FreeRDP, Remmina or a VNC viewer on Linux), which asks for the password: Digger
  keeps none. They go in Saved connections like the consoles.
* **Names others choose**: device, Wi-Fi network, printer and Bluetooth names are whatever their owners typed, so when
  Fabrix reads them they come cleaned (no hidden characters or line breaks), cut short and in quotes.
* **Consoles**: SSH and Telnet to routers, switches, firewalls and servers, straight from a scan or the Consoles tab,
  with SSH host keys pinned on first use and the session open right there. A refused login says why in the connect
  box, ready for another try.
* **Network environments** (the last tab, Black Hole Edition): attach a network controller (UniFi) to see its sites,
  devices and clients.
* A router's or device's own page opens in your computer's browser.

Digger has every network tool of Endpoint Ultra (network environments with Black Hole Edition), and its start screen
and Settings never mention editions. From 2.5.0 these IT tools are Digger's alone: FBRX Endpoint's Network Center keeps
the everyday checks (the full network check, speed, Wi-Fi, Bluetooth and printers) and opens Digger for the rest.

## With FBRX Endpoint

**One license.** Digger runs at the edition FBRX Endpoint has on the same computer: install FBRX Endpoint and sign in
to your FBRX account with Ultra (or get Black Hole Edition through your organization), and Digger opens. Until then
it says what it needs, and it looks again every few seconds, so a purchase or a sign-in in FBRX Endpoint opens it by
itself (or press **Check again**). With Pro or Essentials, Digger stays closed. Digger checks Endpoint's license
itself, so the edition cannot be changed by editing a file, and a license left behind by an uninstalled FBRX Endpoint
does not count.

**From FBRX Endpoint.** The saved connections and network environments made in FBRX Endpoint before 2.5.0 come over
to Digger by themselves, once, the first time it starts after Endpoint 2.5.0 has started. Passwords and API keys stay
in Endpoint's vault: Digger asks for a password when you connect, and each network environment shows that its API key
needs entering again. Something you remove in Digger does not come back.

**Fabrix in FBRX Endpoint** runs the full network check, ping, trace route, name lookups, port checks and a device scan
itself. For more (logging in to a switch, a network controller, saved and compared scans) it recommends Digger, with
**Open Digger** or **Get Digger** under its answer; Digger's Fabrix carries on there.

Otherwise Digger keeps to itself. It keeps its own data folder and settings, runs none of FBRX Endpoint's background
work (no AI of its own, no backups, antivirus or organization), and leaves the keyboard alone (no global shortcuts),
so it never gets in the way of FBRX Endpoint.

**Fabrix, while FBRX Endpoint runs.** When FBRX Endpoint is running on the same computer, Digger finds its AI by
itself: **FBRX Endpoint's AI** shows at the top, with **Ask Fabrix**, *Diagnose with Fabrix* and the other ask buttons
on the network pages. Digger's Fabrix thinks with Endpoint's AI model, while its tools, chats and approvals stay in
Digger; nothing leaves the computer. Close FBRX Endpoint and they go away until it is back. Endpoint lends only an AI it
runs itself (not a cloud provider), and not while its AI is on emergency stop.

Its icon is a mole in a miner's helmet, lamp lit, drawn in honey and red on black.

Digger is FBRX OS's own Network Center, so every network tool FBRX OS gets, Digger gets too, in the same release.

FBRX Endpoint's Network Center has a **Digger** tab: **Open Digger** when it is installed, **Get Digger** when it is not.
Digger shows up in **Settings → FBRX apps** too, once it has started on the computer.

## In detail

### Network environments (Black Hole Edition): your UniFi console

The **Environments** tab attaches the UniFi console that runs a school's or office's network (Dream Machine,
Cloud Gateway, Cloud Key or UniFi OS Server with UniFi Network 9 or newer):

1. In UniFi Network, **Settings → Control Plane → Integrations → Create API key**. Copy it; UniFi shows it once.
2. In FBRX, **Attach a UniFi console**: the console's local address (for example `https://192.168.1.1`) and the key.
3. **Test connection**. UniFi consoles make their own certificate, so FBRX shows its SHA-256 fingerprint; compare it
   with your browser's certificate details for the same address and **Trust it**. From then on FBRX checks the
   fingerprint before sending anything, and refuses the connection if the certificate changes.

You then see every gateway, switch and access point (state, address, model, firmware and pending updates, clients per
device), every client (name, address, MAC, Wi-Fi or wired, which access point or switch it is on, since when), and per
device its uptime, CPU, memory and uplink traffic. **Restart** a device, and make **Guest Wi-Fi codes** (vouchers for a
hotspot guest network) for visitors, substitutes or parent night. The key is kept in the vault; the agent can read the
network (*which access points are offline? where is the Room 12 TV connected?*), and asks before it restarts anything
or makes codes. Network environments come with Black Hole Edition; with Ultra the tab is not shown.

### Remote desktop and screen sharing

*New connection* (the Consoles tab) and a scanned device with port 3389 or 5900 open offer **Remote
desktop** (RDP) and **Screen sharing** (VNC) next to SSH and Telnet. FBRX opens this computer's own viewer with the
address and user name filled in: Remote Desktop Connection on Windows, a remote desktop app or Screen Sharing on a
Mac, FreeRDP, Remmina or a VNC viewer on Linux. The viewer asks for the password; FBRX keeps none. When no viewer is
installed, FBRX says what to install. The connection is kept in Saved connections, where one click opens it again.

### Device consoles

A device with SSH (22, or 4118 for WatchGuard) or Telnet (23) open gets a **Connect** button. The console opens in
the Consoles tab with a full terminal (colors, `--More--` paging, full-screen editors) and, next to it, the
**device guide** for the maker: how to log in, the commands people use most (click to type one, ▶ to run it;
commands that change or restart the device ask first), a button that turns paging off, the maker's official
documentation and a search for more commands. Guides: **FBRX Server** (FBRX Virtual, its roles and libvirt) and
**FBRX Gate & MiniDome** (picked by themselves when the server's name has fbrx in it), Ubiquiti UniFi / EdgeMAX, Sophos Firewall, Cisco IOS / IOS XE,
Cisco Meraki (no CLI: dashboard pointers), Fortinet FortiGate, Palo Alto PAN-OS, Juniper Junos, HPE Aruba, MikroTik
RouterOS, pfSense / OPNsense, TP-Link Omada / JetStream, NETGEAR, SonicWall, WatchGuard, Zyxel, Synology, QNAP,
Raspberry Pi and generic Linux. *Web admin* opens the device's admin page; *Windows Terminal* opens the same SSH
login outside Digger.

- **Saved connections:** every device you connect to is kept on the left and in the *Saved connections* view
  (shown when no console is open): name, address, protocol, user, device guide, notes and when you last used it.
  Edit one to name it and add notes, add one by hand, or untick *Keep in Saved connections* when connecting.
  A key means its password is saved, so *Connect* logs in with one click. Removing a connection can forget its
  password too. Passwords stay encrypted in the vault (Credentials); the list itself never holds them.
- **Identity:** the device's SSH host key is saved the first time (you see its fingerprint) and a changed key is
  refused with a warning until you confirm it.
- **Logins:** user name and password (or keyboard-interactive), or your SSH keys in `~/.ssh` when the password is
  empty. *Remember the password* stores it encrypted in the FBRX vault as an internal secret that plugins, the Local
  API and the agent cannot read. Old firmware that only offers SHA-1 key exchange or CBC ciphers is retried
  automatically with those allowed.
- **Telnet** negotiates the window size and terminal type, fills in the user name and password at the first prompts,
  and warns that it is unencrypted.
- **Fabrix:** *Get help from Fabrix* and *Explain the screen* hand the console to the agent. With
  `device_console.read` it reads what is on screen and with `device_console.send` it types one command at a time —
  an *execute* tool, so each command waits for your approval with the exact text shown. It cannot open consoles or
  see saved passwords.
- Opening, typing into and reading consoles is reserved for the person at the computer (never the Local API, mesh
  peers or remote commands); connections and disconnections are in the audit log.

Device scans start from a chosen **network adapter**, and the subnet is filled in from it (limited to /22–/30, at most
1022 addresses, so a scan takes about a minute). Endpoint Ultra lets you type a different subnet.

A new device found by a scan raises the *Unknown device joined my network* alert when that rule is on.

## Install

Download it from the repository's releases: the release named **FBRX Digger** (tagged `digger-v<version>`).

| Computer | File |
| --- | --- |
| Windows | `FBRX-Digger-Setup-<version>.exe` |
| Mac with Apple silicon | `FBRX-Digger-<version>-arm64.dmg` |
| Intel Mac | `FBRX-Digger-<version>-x64.dmg` |
| Linux | `FBRX-Digger-<version>-x86_64.AppImage`, or the `.deb` for Debian and Ubuntu |

Unsigned builds show *Windows protected your PC* (More info → Run anyway) or, on a Mac, need System Settings →
Privacy & Security → **Open Anyway** the first time. `SHA256SUMS.txt` in the release lists every file's checksum.

Digger tells you when a new version is out (Settings → Updates): it reads the `digger` entry of `release.json` and
links to the new release.
