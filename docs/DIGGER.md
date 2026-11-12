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
* **Network environments** (the last tab): attach a network controller (UniFi) to see its sites, devices and clients.
* A router's or device's own page opens in your computer's browser.

Every tool is included: Digger has no editions of its own, and its start screen and Settings never mention them. It
is the network tools of FBRX Endpoint, on their own.

## With FBRX Endpoint

**One license.** Digger runs at the edition FBRX Endpoint has on the same computer: install FBRX Endpoint and sign in
to your FBRX account with Ultra (or get Black Hole Edition through your organization), and Digger opens. Until then
it says what it needs, and it looks again every few seconds, so a purchase or a sign-in in FBRX Endpoint opens it by
itself (or press **Check again**). With Pro or Essentials, Digger stays closed. Digger checks Endpoint's license
itself, so the edition cannot be changed by editing a file, and a license left behind by an uninstalled FBRX Endpoint
does not count.

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
