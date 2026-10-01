# The FBRX OS command center

Everything a person uses every day lives in the desktop app next to the agent. The agent is called **Fabric** by
default (rename it in **Settings → Agent**); every feature below is also available to it as a governed tool.

Windows is the primary platform for these features. Pages that depend on Windows (Security, Updates, Bug catcher,
Virtual lab, printers, adapters) say so on other systems; the rest works everywhere.

## Look and feel

**Settings → Appearance** is the theme studio:

| Option | Choices |
| --- | --- |
| Theme | Fabrics (amber, the default), Ember, Midnight, Graphite, Ocean, Forest, Orchid, Paper, High contrast. Each has a light and a dark version; *Mode* follows Windows or is fixed |
| Accent colour | Any colour; text on buttons switches between dark and light ink automatically |
| Density | Compact, comfortable, spacious |
| Corners | Sharp, rounded, soft |
| Background texture | None, weave, grain, grid (behind the content, never behind text) |
| Text and interface size | 85–130 % |
| Advanced mode | Shows expert screens: disks and partitions, the virtual lab, network adapter configuration, Defender settings |
| Motion and start-up | Reduce motion, start-up animation, start-up chime |

Chart series and status colours stay on the validated design-system palette in every theme, so charts remain
readable for colour-blind users. Organisations can lock any appearance setting from the admin console.

## Everyday

| Page | What it does |
| --- | --- |
| **Dashboard** | Live processor, memory, network and battery (sampled every 2 s), today's tasks, drives, recent alerts, this computer's hardware, and service health |
| **Fabric** | The agent. Six starter cards (check my PC, plan my day, free up space, slow internet, is this link safe, explain crashes). Each chat is **Offline** or **Online**: new chats start offline (Settings → Agent); the first internet tool in an offline chat asks you to put that chat online |
| **Tasks** | Board (drag between To do / In progress / Done) and list views, priorities, due dates, projects, quick add |
| **Notes** | Markdown notes with preview, tags, pinning, projects and autosave |
| **Projects** | Progress, overdue tasks, milestones, linked notes and snippets |
| **Snippets** | Reusable commands and text; press Enter in Spotlight to copy one |
| **Files** | Places and drives, folder search, previews (text and images), a plain-text editor |
| **Processes** | Live list by CPU or memory with end-process (core Windows processes are protected) |
| **Terminal** | Runs PowerShell commands with streaming output; every command is in the audit log |
| **Toolbox** | JSON, Base64, URL, hashes, UUIDs, passwords, timestamps, regex, text, colours, JWT, subnet calculator — all offline |
| **Library** | 61 short how-tos (Windows basics, files, Wi-Fi, security, speed, devices, troubleshooting) with buttons that open the right Windows setting or ask Fabric |

### Spotlight

Press **Alt+Space** anywhere (change it in Settings → Spotlight), or **Ctrl+K** inside FBRX OS. One box finds
Start menu apps, files (Windows Search index), FBRX pages, notes, tasks, snippets, Windows settings and tools, and
system commands (lock, sleep, restart, shut down, sign out, empty Recycle Bin, flush DNS — the disruptive ones ask
for a second Enter). It calculates (`(1250*12)/7`), converts units (`5 km to mi`, `100 f to c`, `1 gib in mb`),
opens web addresses and searches the web. **Tab** gives a quick answer from Fabric right in the box.

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
| Organisation | The control plane's **Alerts & events** page (enrolled devices) |
| Webhook | Slack, Microsoft Teams, Discord, ntfy or plain JSON |
| E-mail | Your SMTP server; the password lives in Credentials (`FBRX_SMTP_PASSWORD`) |

Quiet hours hold back desktop and e-mail alerts that are not critical; a cooldown stops the same alert repeating.

## PC care (Windows)

| Page | What it does |
| --- | --- |
| **Storage** | Drives with health and BitLocker state; clean temporary files; empty the Recycle Bin; "what is using space?" analyser. Advanced: physical disks with wear and temperature, partitions, optimise / check / rename / extend |
| **Security** | Microsoft Defender status, quick/full/folder scans, definitions update, threat history and removal; firewall profiles; listening ports (exposed vs local); what starts with Windows and unsigned programs running from user folders; file check (SHA-256, signature, VirusTotal with your key); **link check** (look-alike domains, redirects without running page code, domain age, certificate, VirusTotal); Windows Sandbox for unknown links and files. Advanced: Defender settings and exclusions |
| **Updates** | App updates through winget (one or all, with live output), pending Windows updates, third-party drivers oldest first, installed updates |
| **Bug catcher** | Errors from the event log grouped by source, app crashes, blue screens, unexpected shutdowns, problem devices and stopped services — with one-click repairs (SFC, DISM, network reset, Windows Update reset, Explorer restart, icon cache, print queue, Store cache, clock resync, battery and energy reports) and "explain with Fabric" |
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
comparison, port checks and SSH. Advanced: adapter configuration (DHCP, static, secondary addresses).

A new device found by a scan raises the *Unknown device joined my network* alert when that rule is on.

## Mesh and FBRX Mobile

Pair your other FBRX computers and your phone in **Mesh & phone**. See [MESH.md](MESH.md) for how it works and its
security model.

## AI coordination

**AI coordination** finds other AI apps on the computer (Claude Desktop, Claude Code, Cursor, Windsurf, VS Code
with GitHub Copilot, ChatGPT, Codex CLI, Gemini CLI, Ollama, LM Studio, Jan, GPT4All) and connects the ones that
support MCP with one click. They then see FBRX tools plus `ask_fabric`.

The bridge (`fbrx-mcp.mjs`, started by the AI app with the FBRX executable in Node mode) talks to the Local API
with the **agent-scoped** token, read at start-up from `localapi-agent.json` in the data folder (never written into
the other app's configuration). Every call goes through the same governance as Fabric's own: policy, guardian,
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
