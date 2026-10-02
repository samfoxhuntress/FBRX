# The FBRX OS command center

Everything a person uses every day lives in the desktop app next to the agent. The agent is called **Fabrix** by
default (rename it in **Settings → Agent**); every feature below is also available to it as a governed tool.

Windows is the primary platform for these features. Pages that depend on Windows (Security, Updates, Bug catcher,
Virtual lab, printers, adapters) say so on other systems; the rest works everywhere.

## Look and feel

**Settings → Appearance** is the theme studio:

| Option | Choices |
| --- | --- |
| Theme | Fabrics (amber, the default), Tropical (mango orange with a hibiscus-pink glow and a hint of lagoon teal), Ember, Midnight, Graphite, Ocean, Forest, Orchid, Paper, High contrast. Each has a light and a dark version; *Mode* follows Windows or is fixed. Every theme except High contrast tints the sidebar, top bar and page with its own gradient glow, and charts use gradient area fills |
| Accent color | Any color; text on buttons switches between dark and light ink automatically |
| Density | Compact, comfortable, spacious |
| Corners | Sharp, rounded, soft |
| Texture | The theme's own (weave for Fabrics, palms for Tropical, grain for Ember, dots for Midnight, carbon fiber for Graphite, waves for Ocean, linen for Forest…), or pick none, weave, linen, grain, grid, dots, carbon fiber, waves or palms; subtle, medium or bold. Drawn as sharp SVG patterns in the theme's ink on the sidebar, the top bar and the page behind the cards (never behind text in cards) |
| Text and interface size | 85–130 % |
| Motion and start-up | Reduce motion; start-up animation (the FBRX logo stitched in) and start-up sound (from the FBRX intro, on by default, with a Listen button) |
| Fun extras | Easter eggs and jokes (on by default), the Silly Goose's occasional visits (off by default) and a *Release the goose* button. An organization can lock fun extras off |

Chart series and status colors stay on the validated design-system palette in every theme, so charts remain
readable for color-blind users. Organizations can lock any appearance setting from the admin console.

### Basic and Advanced mode

**Basic** shows everyday tools. **Advanced** adds the expert ones, each marked with an **Advanced** tag wherever it
appears: the Terminal and the virtual lab (in an *Advanced* section of the sidebar), disks and partitions, Defender
settings, network adapter configuration, scanning a custom subnet, the bug catcher's event log view, and the
developer tools in the Toolbox (JSON, Base64, URL, hashes, UUIDs, timestamps, regex, JWT, subnet calculator). Switch
with the **Advanced** switch in the top bar or the *Experience* card at the top of **Settings**.

### Ask the agent about anything

Pages carry **Analyze** buttons (the sparkle icon) that hand what you are looking at to the agent in a new chat:
an alert or all of them, a process or the busiest ones, the drives and what is using space, partitions, a Defender
threat, a listening port, a startup item, a link or file check, a network device or the whole scan, a trace route,
speed results, app / Windows / driver updates, a file's contents, terminal output, the event log and FBRX's own logs,
the dashboard health check and your tasks for the day. Long content is trimmed to keep requests fast on local models.

## Everyday

| Page | What it does |
| --- | --- |
| **Dashboard** | Live processor, memory, network and battery (sampled every 2 s), today's tasks, drives, recent alerts, this computer's hardware, and service health |
| **Fabrix** | The agent. Six starter cards (check my PC, plan my day, free up space, slow internet, is this link safe, explain crashes). Each chat is **Offline** or **Online**: new chats start offline (Settings → Agent); the first internet tool in an offline chat asks you to put that chat online |
| **Tasks** | Board (drag between To do / In progress / Done) and list views, priorities, due dates, projects, quick add |
| **Notes** | Markdown notes with preview, tags, pinning, projects and autosave |
| **Projects** | Progress, overdue tasks, milestones, linked notes and snippets |
| **Snippets** | Reusable commands and text; press Enter in Spotlight to copy one |
| **Files** | Places and drives, folder search, previews (text and images), a plain-text editor |
| **Processes** | Live list by CPU or memory with end-process (core Windows processes are protected) |
| **Terminal** (advanced) | Runs commands with streaming output in **PowerShell 7** when it is installed, otherwise **Windows PowerShell 5.1**, or Command Prompt (picker in the header). A **reference panel** puts ready-made commands (network, system, disks, processes, repair, security, power, printing; admin-only ones marked), your snippets, the code in your notes, and each project's snippets and notes one click away; ▶ runs one (commands that change something ask first). Save any command you ran as a snippet. Start a line with `?` to ask Fabrix for a command. Every command is in the audit log. The **Device consoles** tab holds SSH and Telnet sessions (see Network Center) |
| **Toolbox** | Passwords, QR codes (guest Wi-Fi codes phones join by scanning, links, text), text tools, compare text, sizes and numbers (why a 1 TB drive shows 931 GB; decimal, hex, binary), decision maker, colors. Advanced: JSON, Base64, URL, hashes, UUIDs, timestamps, regex, JWT, subnet calculator, MAC vendor lookup, port reference (with risky ports flagged) and the command library. Every tool has *Try* examples, and the top row recommends common jobs — all offline |
| **Library** | 61 short how-tos (Windows basics, files, Wi-Fi, security, speed, devices, troubleshooting) with buttons that open the right Windows setting or ask Fabrix. In Advanced mode, **The Lab** adds power-user how-tos (install USBs, dual boot, a malware lab, device consoles, blue screen dumps, repairs, verifying downloads) and official download pages for Windows, Linux, security distributions and power tools, plus your computer maker's driver page. Safety goggles recommended (sold separately) |

### Spotlight

Press **Alt+Space** anywhere (change it in Settings → Spotlight), or **Ctrl+K** inside FBRX OS. One box finds
Start menu apps, files (Windows Search index), FBRX pages, notes, tasks, snippets, Windows settings and tools, and
system commands (lock, sleep, restart, shut down, sign out, empty Recycle Bin, flush DNS — the disruptive ones ask
for a second Enter). It calculates (`(1250*12)/7`), converts units (`5 km to mi`, `100 f to c`, `1 gib in mb`),
opens web addresses and searches the web. **Tab** gives a quick answer from Fabrix right in the box.

Spotlight only launches what it found itself: Start menu app ids it listed, a fixed set of Windows tools, and
`https://`, `ms-settings:` and `windowsdefender:` links.

## Alerts

Background rules watch performance (CPU, memory, temperature), storage, battery, the internet connection, new
devices on your network, Microsoft Defender (real-time protection, threats, definitions age), the firewall, app
crashes and blue screens, printers, due tasks, paired devices and pending approvals. Each rule can be switched off
and its threshold changed (**Alerts → Rules**).

**Alerts → Delivery** decides where each severity goes:

| Channel | Notes |
| --- | --- |
| Inbox | Always |
| Desktop | Windows notifications |
| Phone | Paired phones running FBRX Mobile |
| Organization | The control plane's **Alerts & events** page (enrolled devices) |
| Webhook | Slack, Microsoft Teams, Discord, ntfy or plain JSON |
| E-mail | Your SMTP server; the password lives in Credentials (`FBRX_SMTP_PASSWORD`) |

Quiet hours hold back desktop and e-mail alerts that are not critical; a cooldown stops the same alert repeating.

## PC care (Windows)

| Page | What it does |
| --- | --- |
| **Storage** | Drives with health and BitLocker state; clean temporary files; empty the Recycle Bin; "what is using space?" analyzer. Advanced: physical disks with wear and temperature, partitions, optimize / check / rename / extend |
| **Security** | Microsoft Defender status, quick/full/folder scans, definitions update, threat history and removal; firewall profiles; listening ports (exposed vs local); what starts with Windows and unsigned programs running from user folders; file check (SHA-256, signature, VirusTotal with your key); **link check** (look-alike domains, redirects without running page code, domain age, certificate, VirusTotal); Windows Sandbox for unknown links and files. Advanced: Defender settings and exclusions |
| **Updates** | App updates through winget (one or all, with live output), pending Windows updates, third-party drivers oldest first, installed updates |
| **Bug catcher** | Errors from the event log grouped by source, app crashes, blue screens, unexpected shutdowns, problem devices and stopped services — with one-click repairs (SFC, DISM, network reset, Windows Update reset, Explorer restart, icon cache, print queue, Store cache, clock resync, battery and energy reports) and "explain with Fabrix" |
| **Virtual lab** (advanced) | Turn on Hyper-V, Windows Sandbox, WSL; create Generation 2 VMs (secure boot, TPM for Windows guests) on an isolated switch, the internet switch or no network, with a starting checkpoint; start, stop, save, checkpoint, revert, isolate, delete |

Actions that need administrator rights show the Windows UAC prompt. FBRX passes the script to the elevated
PowerShell as an encoded command — it is never written to a file that another program could swap before you
approve. Read-only information never asks for elevation.

## Network Center

Overview (this PC, router, internet latency and loss, public address, plain-language verdict), ping and
**trace route with hop identification** (your router, other local routers / double NAT, your provider, the
internet, the destination; names, makers and locations), **device discovery** (ping sweep, ARP, mDNS/Bonjour,
UPnP, port fingerprints and MAC vendors identify PCs, phones, printers, TVs, cameras, smart-home devices and NAS),
saved scans with comparison and CSV export, speed test with history, Wi-Fi (signal, channel, band, congestion by
channel), Bluetooth devices with battery, printers (test page, queue, default, clear, restart spooler), DNS
comparison, port checks and device consoles. Advanced: adapter configuration (DHCP, static, secondary addresses).

Makers come from the **IEEE MAC address registry** that ships with FBRX OS (MA-L, MA-M and MA-S blocks, about 54,000
entries, the most specific block wins; randomized phone and laptop addresses are recognized as such). *Update from
the IEEE* in Toolbox → MAC vendor lookup downloads the current lists (falling back to the daily published JSON copy
when the IEEE site refuses the download).

### Device consoles (advanced)

A device with SSH (22, or 4118 for WatchGuard) or Telnet (23) open gets a **Connect** button. The console opens in
Terminal → Device consoles with a full terminal (colors, `--More--` paging, full-screen editors) and, next to it, the
**device guide** for the maker: how to log in, the commands people use most (click to type one, ▶ to run it;
commands that change or restart the device ask first), a button that turns paging off, the maker's official
documentation and a search for more commands. Guides: Ubiquiti UniFi / EdgeMAX, Sophos Firewall, Cisco IOS / IOS XE,
Cisco Meraki (no CLI: dashboard pointers), Fortinet FortiGate, Palo Alto PAN-OS, Juniper Junos, HPE Aruba, MikroTik
RouterOS, pfSense / OPNsense, TP-Link Omada / JetStream, NETGEAR, SonicWall, WatchGuard, Zyxel, Synology, QNAP,
Raspberry Pi and generic Linux. *Web admin* opens the device's admin page; *Windows Terminal* opens the same SSH
login outside FBRX.

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
1022 addresses, so a scan takes about a minute). Advanced mode lets you type a different subnet.

A new device found by a scan raises the *Unknown device joined my network* alert when that rule is on.

## Mesh and FBRX Mobile

Pair your other FBRX computers and your phone in **Mesh & phone**. See [MESH.md](MESH.md) for how it works and its
security model.

## AI coordination

**AI coordination** finds other AI apps on the computer from the Start menu, the installed-programs list, running
processes and their folders: Claude Desktop, Claude Code, Cursor, Windsurf, VS Code with GitHub Copilot, Gemini CLI,
LM Studio, Perplexity, Comet, Grok, ChatGPT, Microsoft Copilot, Msty, AnythingLLM, Codex CLI, Ollama, Jan and GPT4All.
Apps that support MCP (Claude Desktop and Code, Cursor, Windsurf, VS Code, Gemini CLI, LM Studio) connect with one
click and then see FBRX tools plus `ask_fabrix` (apps that still call it by its old name, `ask_fabric`, keep working). Apps without MCP on Windows (Perplexity, Grok, ChatGPT) can be
opened from FBRX, and their makers' APIs can be added as models for second opinions (*Add as a model*; you need an
API key from them). **Look again** re-scans and reports what it found.

The bridge (`fbrx-mcp.mjs`, started by the AI app with the FBRX executable in Node mode) talks to the Local API
with the **agent-scoped** token, read at start-up from `localapi-agent.json` in the data folder (never written into
the other app's configuration). Every call goes through the same governance as Fabrix's own: policy, guardian,
approvals in FBRX, and the audit log. The Local API must be on.

**Second opinion** asks another configured model the same question without tools.

## Agent tools added

| Tool | Risk |
| --- | --- |
| `workspace.list_tasks`, `workspace.search_notes`, `workspace.list_projects`, `workspace.search_snippets` | read |
| `workspace.add_task`, `workspace.update_task`, `workspace.create_note`, `workspace.append_note`, `workspace.save_snippet` | write (allowed by the built-in `builtin-workspace` rule: they only touch FBRX's own data) |
| `pc.live_status`, `pc.storage_report`, `alerts.recent`; Windows: `pc.security_status`, `pc.event_errors`, `pc.pending_updates` | read |
| `pc.clean_temp` | write |
| `pc.run_fix` (Windows) | execute — asks by default |
| `net.ping`, `net.traceroute`, `net.dns_lookup`, `net.port_check`, `net.scan_lan`, `net.check_link`, `net.speed_test` | network — offline chats ask to go online first |
| `device_console.sessions`, `device_console.read` | read |
| `device_console.send` | execute — asks by default, showing the exact command |

## AI models

**AI models** lists every way to run the agent:

* **Built-in local runtime** (llama.cpp). *Install runtime* downloads the newest official llama.cpp build for this
  computer: the Vulkan build when there is a graphics card with at least 2 GB of memory, otherwise the CPU build.
  *Use* on a downloaded model makes it the default.
* **Ollama models**: the models Ollama has already downloaded on this computer, read from Ollama, or from its model
  folder (`OLLAMA_MODELS` or `~/.ollama/models`) while Ollama is not running, with *Start Ollama*. *Use* makes one the
  default. With no model chosen, Fabrix picks the installed model best suited to tool calling.
* **Providers**: Ollama, Claude and other OpenAI-compatible endpoints. The *Default model* is a list of the
  provider's models (or *Other model…* to type a name).

The chat's model list shows the same installed models. If a chat asks Ollama for a model it does not have, the error
names the installed ones.


## Easter eggs

FBRX OS has a playful side, all of it under **Settings → Appearance → Fun extras** (and lockable by an organization).
For the full list (spoilers), see [EASTER_EGGS.md](EASTER_EGGS.md).
