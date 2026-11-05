# FBRX Digger

FBRX Digger is the FBRX **Network Center on its own**: a small app for anyone who looks after networks, with every
network tool FBRX has and nothing else. It runs on Windows, macOS and Linux, next to FBRX OS or without it.

## What it does

* **Overview**: this computer, the router, internet latency and loss, the public address and a plain-language verdict.
* **Devices**: scan the network (ping sweep, ARP, mDNS/Bonjour, UPnP, port fingerprints and the IEEE MAC registry
  name PCs, phones, printers, TVs, cameras, smart-home devices and NAS), save scans, **compare** two scans to see what
  joined and what left, and export them as CSV.
* **Ping and trace route** with each hop identified (your router, double NAT, your provider, the internet).
* **Speed test** with history.
* **Wi-Fi channel planner**: every network around drawn over the channels it covers, how busy each channel is, the
  best channel for your network with the reason, the channel width to set, DFS channels, how busy each channel has
  been, and every access point with its signal.
* **Tools**: DNS comparison and port checks.
* **Device consoles**: SSH and Telnet to routers, switches, firewalls and servers, straight from a scan, with SSH host
  keys pinned on first use.
* **Network environments**: attach a network controller (UniFi) to see its sites, devices and clients.
* **FBRX Browser** for router and device pages, including addresses on your own network and devices with their own
  certificates.

Everything is included, whatever FBRX edition you have: Digger is the network tools of Endpoint Ultra and Black Hole,
on their own.

## On its own

Digger needs nothing else: no FBRX account, no edition and no FBRX OS. It keeps its own data folder and settings, runs
none of FBRX Endpoint's background work (no AI of its own, no backups, antivirus or organization), and leaves the
keyboard alone (no global shortcuts), so it never gets in the way of FBRX OS on the same computer.

**Fabrix, while FBRX Endpoint runs.** When FBRX Endpoint is running on the same computer, Digger finds its AI by
itself: **FBRX Endpoint's AI** shows at the top, with **Ask Fabrix**, *Diagnose with Fabrix* and the other ask buttons
on the network pages. Digger's Fabrix thinks with Endpoint's AI model, while its tools, chats and approvals stay in
Digger; nothing leaves the computer. Close FBRX Endpoint and they go away until it is back. Endpoint lends only an AI it
runs itself (not a cloud provider), and not while its AI is on emergency stop.

Its icon is a mole in a miner's helmet, lamp lit.

Digger is FBRX OS's own Network Center, so every network tool FBRX OS gets, Digger gets too, in the same release.

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
