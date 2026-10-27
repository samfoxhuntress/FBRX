# The FBRX OS command center

Everything a person uses every day lives in the desktop app next to the agent. The agent is called **Fabrix** by
default (rename it in **Settings → Agent**); every feature below is also available to it as a governed tool.

Windows is the primary platform for these features. Pages that depend on Windows (Security, Updates, Bug catcher,
Virtual lab, printers, adapters) say so on other systems; the rest works everywhere.

## Look and feel

**Settings → Appearance** is the theme studio in FBRX Endpoint Ultra (Essentials and Standard have the plain light and dark look in FBRX's golden honey, with the sidebar icon, layout and behavior options below):

| Option | Choices |
| --- | --- |
| Look | A calm finish in the spirit of Windows 11 and macOS: the system font (Segoe UI Variable on Windows 11), rounded corners, hairline borders, soft shadows, a pill marker for the current page, and a texture that only whispers behind the menu |
| Theme | Fabrics (FBRX's golden honey, with a honey glow and a woven texture, the default; the FBRX logo stays white on black), Tropical (mango orange with a hibiscus-pink glow and a hint of lagoon teal), Neon Grid (deep night blue with cyan light lines, glowing cards and a grid floor that runs to the horizon), Ember, Midnight, Graphite, Ocean, Forest, Orchid, Paper, High contrast. Each has a light and a dark version; *Mode* follows Windows or is fixed. Every theme except High contrast tints the sidebar, top bar and page with its own gradient glow, and charts use gradient area fills |
| Accent color | Any color; text on buttons switches between dark and light ink automatically |
| Sidebar icons | **Theme color** (every section's icon in the theme's accent, for a calm one-color look: honey with Fabrics, blue with Graphite…; the default), **A color for each section**, **One color you pick** (Ultra) or **Plain**, and a **Tint behind the icons** slider from none (just the colored icon) to a rich colored tile |
| Density | Compact, comfortable, spacious |
| Corners | Sharp, rounded, soft |
| Texture | The theme's own (weave for Fabrics, palms for Tropical, a neon grid for Neon Grid, grain for Ember, dots for Midnight, carbon fiber for Graphite, waves for Ocean, linen for Forest…), or pick none, weave (a small basket weave), linen, grain, grid (glowing lines in the accent color), dots, carbon fiber, waves or palms. A **Strength** slider sets how much it shows, from 0 to 100% in steps of 5 (new installs start at a soft 50%; even 100% stays quieter than the old *bold*). Drawn as sharp SVG patterns in the theme's ink on the sidebar, the top bar and the page behind the cards (never behind text in cards) |
| Text and interface size | 85–130 % |
| Motion and start-up | Reduce motion; start-up animation (the FBRX logo stitched in) and start-up sound (from the FBRX intro, on by default, with a Listen button) |
| Effects | Auto, Full or Lite. Lite turns off frosted glass, glows and decorative animation; Auto picks Lite on computers with four or fewer processor threads or 4 GB of memory |
| Fun extras | Every edition, once unlocked (see [EASTER_EGGS.md](EASTER_EGGS.md), spoilers): easter eggs and jokes, the Silly Goose's occasional visits, a *Release the goose* button and the **Trophy case**. An organization can lock fun extras off |

**Dark mode: a cool page, color on the elements.** In dark mode every theme keeps the page itself cool and quiet
(slate neutrals, also in the warm themes: Fabrics, Tropical, Ember and Paper keep their accent and glow but not a
brown page) and puts the color on what you use: the sidebar's icons and the current page's marker (in the theme's
accent, or with *A color for each section*: Bridge blue, Studio violet, Pit Stop amber, Workbench teal, Orbit sky,
Stronghold green, Lab pink, Control slate; in Essentials, Your AI blue, Help & settings slate),
cards carry a breath of the theme's accent, and table heads, buttons, badges and tabs pick it up too. The page's glow
is softer than the sidebar's. The sidebar colors show in light mode as well; High contrast stays flat.

Chart series and status colors stay on the validated design-system palette in every theme, so charts remain
readable for color-blind users. Organizations can lock any appearance setting from the admin console.

### The sidebar

The sidebar is grouped into sections, each with an FBRX name, an icon and a line saying what is inside. Click a
section to open its pages (one at a time; the section of the page you are on opens by itself):

| Section | Pages |
| --- | --- |
| **Glass** | Dash, Fabrix, Alerts |
| **Studio** | Calendar, Tasks, Notes, Projects, Snippets |
| **Pit Stop** | Storage, Security, Updates, Bug catcher, Network Center |
| **Workbench** | Files, Task Manager, Clipboard, Copy & migrate, Toolbox, Library |
| **Orbit** | Mesh & phone, FBRX VPN, AI models, AI coordination, Connections, Tools & plugins |
| **Stronghold** | FBRX Shield (antivirus), Approvals, Credentials, Governance, Backup & restore |
| **Lab** | Terminal, Virtual lab (Endpoint Ultra), FBRX Server (Black Hole) |
| **Control** | Organization, Settings |

**Collapse** at the bottom folds the sidebar down to the section icons (remembered on this computer); click an icon
and its pages slide out beside it. Counts (unread alerts, waiting approvals) show on the section too.

### Version names

FBRX 2.0 is the Beta (1.x was the Alpha): versions read **FBRX Endpoint Ultra Beta 2.0.0** (or Essentials, Standard or
Black Hole). Each minor version also gets a codename from cloth, fiber to fabric, shown in **Settings → Logs & about**:
1.8 *Spindle*, 1.9 *Bobbin*, 2.0 *Loom* (later *Warp*, *Weft*, *Selvedge*, *Tapestry*).

### FBRX Endpoint Essentials, Standard, Ultra and Black Hole

The desktop app comes in four editions. Every new computer opens in **Essentials**, free: your own AI and nothing
else, ready on the first screen (see *The first start* below). **Settings → Edition** switches between them (nothing
saved goes away), up to what the computer may run. Prices are in US dollars, per month (see LICENSING.md, *Prices*):

| | **Essentials** | **Standard** | **Ultra** | **Black Hole** |
| --- | --- | --- | --- | --- |
| Price | Free, and free in an organization | $4.99 after a free 7-day trial, or $3.99 through FBRX Command | $11.99, or $9.59 through FBRX Command | $24.99 per computer, only through FBRX Command |
| How you get it | Where every new computer starts | Bought on your FBRX account or with a license key, or through your organization's FBRX Command | The same | Only as an add-on in an organization's FBRX Command: for the people who run it and its FBRX Servers |
| Pages | The AI on its own: Fabrix (the chat, with its memory and voice), AI models, the help desk (in an organization) and Settings. **Home** is the split-flap board and a few notes from FBRX: tips, the AI models, and what Standard and Ultra add (no dashboard) | Everything in Essentials, plus Dash, alerts, messages, notes, tasks, calendar, projects, snippets, storage, FBRX Shield, security, updates, Network Center, backup, files, clipboard (with Ctrl+Alt+Z history), Toolbox, How-tos (the Library), approvals, credentials and macros, in the branded sidebar sections | Everything in Standard | Everything in Ultra, plus the FBRX Server page |
| How much the AI does on a task | **Thinking**: Quick, Everyday or Thorough (see *Thinking* below), and whether it shows what it is doing | The same, each part on its own (steps per task, longest answer, how much the built-in and Ollama models keep in mind), and unloading the local model when idle | The same, and the temperature | The same |
| IT and expert tool sets | — | — | Task Manager and Event Viewer, bug catcher, Copy & migrate, Terminal and code lab, virtual lab, FBRX/1, disks and partitions, Defender settings, Network Center's ping and trace, device scans, tools and adapters, device consoles, the developer tools in the Toolbox, logs, update channels, the Local API | Everything in Ultra, plus **network environments** (your network controller) in Network Center and the whole Library: **The Lab** and the **FBRX command library** (FBRX/1, FBRX Server and FBRX Gate commands, also in Terminal → FBRX/1), always there |
| Connect | AI models | AI models | Mesh & phone, FBRX VPN, AI coordination, connections, tools and plugins, governance | The same |
| Look | Light, dark or follow the computer: plain | The same | The theme studio: eleven themes, accent colors, gradients and textures (with a strength slider) | The same |
| Fun | Easter eggs, the Silly Goose and the trophy case, once unlocked with the secret key (see EASTER_EGGS.md, spoilers) | The same | The same | The same |

**The walkthrough.** On a new computer, after setup, Essentials dims the window and lights up one page at a time:
Fabrix, AI models and Settings (memory, voice, and the edition for when you want more), ending with the Spotlight
shortcut. Enter or → goes on, ← back, Esc skips; *Take the tour again* is in Settings → Edition.

**Notifications in Essentials** are only the ones about the AI and the computer's safety: approvals, the AI,
the watchdog, messages from your organization and the help desk, and new FBRX versions. Standard and up show the
rest (alerts, storage, FBRX Shield and so on) as set in **Settings → Notifications**.

**What may be unlocked.** On its own, a computer runs Essentials for free. Standard and Ultra are bought: on the
person's FBRX account, or with a license key (Settings → License); a license that belongs to an organization (it
names its FBRX Command) counts only in that organization. Black Hole comes only through FBRX Command. In an
organization, the most a computer may run is what the license allows (Community up to Standard; Pro and Enterprise up
to Ultra; a license can name it, Black Hole included), held lower by its group in FBRX Command (*Profiles & groups →
Edition*) or by the computer itself (*Devices → a device → Configuration → Edition*): **Essentials only**, **Up to
Standard**, **Up to Ultra** or **Up to Black Hole**. A page from a higher edition opens a short card that says what it
does and how to get it: *Switch to Standard* in one click when it is allowed, *Turn on Ultra* (or Black Hole) when it
is allowed, and otherwise its price and *Join your organization*. Student computers run **FBRX OS Education** (see
EDUCATION.md). The edition shows beside the name in the sidebar, at the top of **Settings**, in the window title,
under **Settings → Logs & about**, and in FBRX Command next to each device's version.

**FBRX accounts.** Settings → **FBRX account** signs in to an FBRX account (or makes one): the computer turns on what
the account bought, wherever it was bought, and a member of an organization can join the computer to it at the
edition the organization gave them. Signed in, the locked editions in Settings → Edition have a **Get** button that
opens the checkout in the browser. See ACCOUNTS.md.

**Try Standard free for 7 days.** A computer on its own with nothing bought may try Standard free, once, for 7 days,
no card needed: **Try free for 7 days** in Settings → Edition, on a page that comes with Standard, or in the note on
Essentials Home. Settings → Edition says until when; then it runs Essentials unless Standard or Ultra is bought (and
turns Standard back on by itself once it is). Until 2.0, Standard was free on a computer on its own: a computer set up
before starts its trial by itself the first time it starts 2.0. Computers in an organization have no trial: FBRX
Command decides what they run. A computer set up before Essentials existed keeps the edition it had
(up to what it may run now). Developers can try the lighter editions in a development build (which otherwise runs
Black Hole) with `FBRX_EDITION=essentials`, `standard` or `ultra`.

### The first start: straight to your AI

A new computer's first experience is a conversation, not a setup form:

- **Install FBRX OS** (the from-source installer) asks nothing. While it builds the app it downloads the starter
  model, **Qwen2.5 1.5B Instruct** (about 1 GB, Apache-2.0), into the app's models folder, and builds the AI runtime
  (llama.cpp's `llama-server`) into the app. When FBRX OS opens, the model is picked up and the AI starts.
- **The ready-made installers** (the release's Setup.exe and .dmg, or a shared installer) download the same model
  when FBRX OS first opens; the chat shows the progress ("Getting your AI ready") and a *Try again* button if the
  internet drops.
- **One screen** then asks only what Fabrix should call you (optional) and opens the chat with **Start chatting**.
  Moving from another computer (*Restore its backup*) and *Join my organization* are links on the same screen. The
  rest waits until you want it: a vault recovery passphrase (Credentials), another AI (AI models), the computer's name
  (Settings).

The starter is only ever set up by itself on a new computer where nobody chose an AI: picking another model or AI is
never overruled, a removed starter is not downloaded again by itself, and a computer set up before this existed is not
sent a gigabyte unasked (*AI models* has it, one click). `Install FBRX OS --no-ai` leaves the model out entirely.

### Your name

FBRX asks what it should call you on the first screen (or once on Dash, for computers set up before it asked):
"Samuel", called "Sam" or "Sir". Dash greets you by it and Fabrix addresses you that way. Change it in
**Settings → General → You**.

### Ask the agent about anything

Pages carry **Analyze** buttons (the sparkle icon) that hand what you are looking at to the agent in a new chat:
an alert or all of them, a process or the busiest ones, the drives and what is using space, partitions, a Defender
threat, a listening port, a startup item, a link or file check, a network device or the whole scan, a trace route,
speed results, app / Windows / driver updates, a file's contents, terminal output, the event log and FBRX's own logs,
the dashboard health check and your tasks for the day. Long content is trimmed to keep requests fast on local models.

### Talk to Fabrix

Press the **microphone** next to Send and speak; when you pause (or click it again) what you said is written into the
box and sent. The **speaker** button reads replies aloud as they stream in, the **headset** starts a hands-free
conversation (listen, answer out loud, listen again, until a quiet moment), and every answer has **Read aloud**.

Speech becomes text on this computer with Whisper, so nothing you say leaves it. **Settings → Voice** picks the
speech model (downloaded once: *Fastest* 41 MB, *Recommended* 78 MB, *Most accurate* 249 MB, all English, or *Many
languages* 78 MB), the microphone (with a test that shows what it heard) and whether to send right away. Fabrix's
voice is one of the **natural voices** or one of the computer's own:

* **Natural voices** are lifelike voices made on this computer by the Kokoro model (one download of about 107 MB,
  then they work offline): British voices George (an older gentleman: *the butler*), Fable, Lewis, Daniel, Emma,
  Isabella, Alice and Lily, and American voices such as Heart, Bella, Michael and Fenrir. The presets **The butler**,
  **The assistant** and **The storyteller** pick a voice and a speed in one click; the play button on each voice lets
  you hear it. How quickly they are made depends on the processor; on a slow computer there can be a short pause
  between sentences.
* **Voices on this computer** come from Windows (Settings → Time & language → Speech; add *English (United Kingdom)*
  for George and Hazel) or macOS (System Settings → Accessibility → Spoken Content → Manage Voices; the Premium voices
  such as Jamie sound best). **Get more voices** opens that page; restart FBRX OS to see new ones.

Set the speed in words per minute (120 to 360, 210 by default, a natural speaking pace) and, for the computer's own
voices, the pitch, and press **Hear it**.

When you speak to Fabrix it says it heard you ("Got it. Let me look into that." — a butler voice says "Very good.
Allow me a moment to look into it.") and plays a soft thinking sound, a low hum with quiet data blips, until the
answer starts. Both can be turned off in Settings → Voice.

### Watch Fabrix work

While Fabrix works, the conversation shows what it is doing right now (asking the model, thinking, the tool it is
using and on what, waiting for your approval, writing the answer), the step it is on out of how many it may take,
the time so far and the tokens used, a list of the finished steps, and its thinking as it streams in, for models that
share it (recent Claude models, and local models with a reasoning mode such as DeepSeek R1, Qwen 3 or gpt-oss, through llama.cpp,
Ollama, vLLM or OpenRouter). The thinking stays folded under each answer as **How Fabrix thought about it**. It is
for you to read (it is not added to the conversation the model sees as text) and can be turned off in **Settings → Agent → Thinking**.

Fabrix keeps working when you go to another page. The chats it is working in say **Working** in the history,
**Fabrix working** in the top bar opens the chat, and coming back to Fabrix opens the chat you left, with everything it
has done so far (FBRX keeps each task's progress until it finishes, so the chat picks up exactly where it is). A chat
opened in its own window shows it too.

### Your chat history

The **⋯** next to a chat renames it, adds it to a project (or a new one), takes it out again, or deletes it. **Select**
picks several chats to add to a project or delete together, and **Clean up** deletes chats you have not touched for
a week, a month, three months, a year, or all of them; it shows how many first, and keeps chats in projects unless
you include them. The list above the chats shows all of them, those in no project, or one project's; a new chat
started while a project is shown goes into it, and **Projects → Chats** opens a project's chats. Deleting a project
never deletes its chats: they go back to the main history. Only the person at the computer can delete chats in bulk
(not the Local API or FBRX Command).

### What Fabrix remembers

Fabrix keeps a memory of you **on this computer only**, so it knows you whichever AI model you pick (a local one, a
cloud one, or a different one tomorrow). **Settings → Memory** shows all of it.

* **Short-term memory** is the last 24 hours of chats: what you asked and what it answered. It ages out by itself
  after a day and goes only to a local AI.
* **Long-term memory** is lasting facts about you (your name, where you work, the town you live in, what you prefer)
  and your past chats, which it can search when you ask "what did we say about the printer last month?". It learns
  facts from what you say ("I live in…", "my email is…"), keeps what you or Fabrix choose to remember, and a newer fact
  replaces an older one with the same meaning.

You can add a fact, change or forget any of them (right-click one), **Forget everything**, and turn each part off.
Student and child computers keep no memory at all.

Memory is not the model's own working memory: that is its **context window** (*What a local model keeps in mind*,
under Thinking), the conversation and instructions it reads before each answer, much as a computer's RAM. FBRX's memory
is a notebook it keeps for the model: before each answer, the facts that fit the question go with your message, inside
that window. It helps the model know you; it does not make it reason better. Nor is it prompt caching, which is the AI
service reusing what it already read when a request starts the same way as the last one, so it answers sooner.

**Never kept**: Social Security and other national ID numbers, driver's license and passport numbers, tax IDs, bank
account and routing numbers, full payment card numbers and their security codes, and passwords and PINs. FBRX finds
them by their shape and the words around them and takes them out before anything is saved, whoever asked.

**Private details** (addresses, the town you live in, your email and phone number, your birthday, and payment cards
by their **last four digits only**, off by default) are kept only when you allow each kind. They go to a local AI
only: a cloud AI gets the general facts with your message (or nothing, if you choose *Nothing*), never private details
and never the last 24 hours.

**Nothing personal goes onto the internet.** If Fabrix is about to put an identity or money number into a web search
or any other online tool ("why does my SSN start with 818?" as a search), FBRX refuses the call before anything is
sent. A private detail it remembers (your address, your phone number) in an online tool needs your approval first.

### Fabrix knows FBRX

Fabrix has a database of FBRX itself on the computer (`knowledge.db`): this guide and the other FBRX documents,
troubleshooting playbooks and the FBRX/1 commands. It is rebuilt when FBRX updates. Ask "why is FBRX slow?" or "why
does the AI keep stopping?" and Fabrix runs a **check-up** (services, the local model and its memory use, the
database, scans in progress, disk space, FBRX Shield) and explains what it found. Where there is a fix it offers it,
and it asks you before applying one:

| Fix | What it does |
| --- | --- |
| Restart a service | Restarts one FBRX service that has stopped or keeps failing |
| Stop the scan | Stops a FBRX Shield scan that is slowing the computer |
| Check the list again | Re-checks FBRX Shield's findings (clears ones that no longer apply) |
| Unload the model | Gives the local model's memory back to the computer |
| Smaller conversation memory | Lowers the local model's context size when it does not fit |
| Tidy the database | Compacts FBRX's database |

### Folders your AI can use

**Governance → Folders your AI can use** lists the only folders Fabrix may read or work in (your home folder and the
FBRX workspace to begin with). **Add a folder…** picks any other one with the folder picker, such as another drive or a
network share; the trash button takes one away, and **Read only** lets it look at files but never change them. System
folders (Windows, Program Files, `/System`, `/etc`…) and FBRX's own data folder can never be added.

When Fabrix needs a folder it does not have, it asks: a window shows which folder and why, and you **Allow this
folder**, **Choose another folder…** or say **Don't allow**. Nothing is opened until you answer. When FBRX Command
manages the computer, the folders come from the organization's policy and this card is read-only. The policy as JSON
is edited in FBRX Command (Governance), not on the computer.

## Everyday

| Page | What it does |
| --- | --- |
| **Dash** | The dashboard, in frosted glass: a split-flap board that rotates through status messages, a health score out of 100 with what costs points, what is left on today's calendar (with *Join* when a meeting is about to start), insight tiles (your next task, internet speed, storage, Fabrix, backups and the vault, alerts and approvals, a tip), then live processor, memory, network and battery (sampled every 2 s), today's tasks, drives, recent alerts, this computer's hardware, and service health |
| **Fabrix** | The agent. Six starter cards (check my PC, plan my day, free up space, slow internet, is this link safe, explain crashes). Each chat is **Offline** or **Online**: new chats start offline (Settings → Agent); the first internet tool in an offline chat asks you to put that chat online. Attach files and pictures, and ask for documents and pictures: see [FABRIX.md](FABRIX.md) |
| **FBRX Shield** | The antivirus: what protects this computer (FBRX Shield, Microsoft Defender or an antivirus already installed, such as Sophos), its status, scans with live progress, what was found, quarantine, and FBRX Shield's settings. See [SHIELD.md](SHIELD.md) |
| **Calendar** | The FBRX calendar on this computer: events you add (repeating, about a project, note, task or automation, in its color), with your tasks' and projects' due dates and your automations' runs on it; shared calendars as add-ons (Outlook / Microsoft 365, calendar links from Outlook.com, Google, Apple, a school). As an agenda, a week or a month, with a color legend, *Join* for online meetings, reminders before events, and *Prepare my day*. See [CALENDAR.md](CALENDAR.md) |
| **Tasks** | Board (drag between To do / In progress / Done) and list views, priorities, due dates, projects, quick add |
| **Notes** | Markdown notes with preview, tags, pinning, projects and autosave |
| **Projects** | Progress, overdue tasks, milestones, linked notes, snippets and chats |
| **Snippets** | Reusable commands and text; press Enter in Spotlight to copy one |
| **Automations** | Jobs Fabrix does by itself on a schedule, when FBRX starts or with a shortcut (watch listings, check stocks, a price drop, a morning brief), telling you every time or only when something changed. See [FABRIX.md](FABRIX.md#automations) |
| **Snapshot** | A picture of the screen (an area, a window or all of it; Ctrl+Alt+S anywhere), marked up with pen, highlighter, arrows, boxes, text, blur and crop, then copied, saved or handed to Fabrix. See [FABRIX.md](FABRIX.md#fbrx-snapshot) |
| **Files** | Places and drives, folder search, previews (text and images), a plain-text editor |
| **Task Manager** | Three tabs. **Processes**: live list by CPU or memory with search, details and End task (core Windows processes are protected); *What is this?* on any process, and *What's using my PC?* / *Anything suspicious?* in the Fabrix panel beside it. **Performance**: live processor, memory and network graphs, every core, uptime, battery and temperature. **Event Viewer**: see below |
| **Clipboard** | A copy-and-paste processor. Paste text (or type `/` for snippets), add steps — trim, remove blank or duplicate lines, sort, straighten quotes, strip HTML or terminal colors, change case (UPPER, Title, camelCase, snake_case…), find and replace (plain or regular expression), keep or drop matching lines, extract emails, web addresses, IP or MAC addresses and numbers, join or split, wrap each line, number lines, JSON format/minify, CSV or Excel cells → Markdown table, Base64 and URL encode/decode — and the result updates as you go. **Save as transform** keeps the steps; ▶ next to a saved transform runs it straight on the clipboard (copy, click, paste). Optional **History** keeps the last 50 things you copied while FBRX runs (see Security), and **Ctrl+Alt+Z** opens it anywhere (see Macros below) |
| **Copy & migrate** | Copy, back up, mirror or move folders between drives, computers and network shares with **Robocopy** (Windows), **rsync** (Mac and Linux) or FBRX's own copier. Pick the folders, the tool and what to do (copy; new and changed only; mirror; move), skip clutter, retries, files at once, files and folders to leave out; the exact command is shown before it runs. **Preview** lists what would happen without changing anything; mirror and move ask first. Live output, counts and a summary, with *Explain this result*. Recipes: back up Documents, mirror to a NAS, copy a USB stick, move a project, and **Move my user folders to a new PC** (Desktop, Documents, Pictures, Music, Videos and Downloads, one after another). Guard rails refuse mirroring onto a drive root or a system or home folder, copying a folder into itself, and moving a whole drive or home folder away |
| **Terminal** (Ultra) | **What if?** next to Run has Fabrix explain what the command in the box would do — what it reads, changes, deletes or downloads, whether it needs admin rights, and a verdict — without running it. Runs commands with streaming output in **PowerShell 7** when it is installed, otherwise **Windows PowerShell 5.1**, or Command Prompt (picker in the header). A **reference panel** puts ready-made commands (network, system, disks, processes, repair, security, power, printing; admin-only ones marked), your snippets, the code in your notes, and each project's snippets and notes one click away; ▶ runs one (commands that change something ask first). Save any command you ran as a snippet. Start a line with `?` to ask Fabrix for a command. Every command is in the audit log. The **Code** tab is the code lab (below), the **Device consoles** tab holds SSH and Telnet sessions (see Network Center), and **FBRX/1** is the management console for FBRX itself (below) |
| **Toolbox** | Passwords, QR codes (guest Wi-Fi codes phones join by scanning, links, text), text tools, compare text, sizes and numbers (why a 1 TB drive shows 931 GB; decimal, hex, binary), decision maker, colors. Ultra: JSON, Base64, URL, hashes, UUIDs, timestamps, regex, JWT, subnet calculator, MAC vendor lookup, port reference (with risky ports flagged) and the command library. Every tool has *Try* examples, and the top row recommends common jobs — all offline |
| **Library** | 61 short how-tos (Windows basics, files, Wi-Fi, security, speed, devices, troubleshooting) with buttons that open the right Windows setting or ask Fabrix. In Endpoint Black Hole, **The Lab** adds power-user how-tos (install USBs, dual boot, a malware lab, device consoles, blue screen dumps, repairs, verifying downloads) and official download pages for Windows, Linux, security distributions and power tools, plus your computer maker's driver page. Safety goggles recommended (sold separately). **FBRX commands** (Black Hole, always there) is the library of FBRX's own command lines: FBRX/1 on this computer (*Try it* opens FBRX/1 with the command typed in), FBRX Server and FBRX Gate (copy, then run in a device console), and how-tos such as copying settings to another computer or changing a gate without locking yourself out. Talking to the search like a switch (`show commands`, `enable`, `configure terminal`) opens it, and with fun extras on earns *Operator Mode* in any edition |

### Snippets and the / menu

A **snippet** is text you paste often. Type **/** in the Fabrix chat, the Terminal, FBRX/1, the Clipboard editor or any
Fabrix side panel and your quick snippets pop up; ↑ ↓ and Enter paste one. **/snip** lists the snippet library from
**Studio → Snippets** (keep typing to search: `/snip dns`), **/clip** pastes the clipboard, **/date**, **/time** and
**/now** insert the date and time, **/snippets** opens the editor and **/macros** the keyboard shortcuts. Program your
own in **Settings → Snippets**: the word you type, a description, where it works (everywhere, chat only, or Terminal
and FBRX/1 only) and the text it pastes, with placeholders `{date}`, `{time}`, `{datetime}`, `{isodate}`, `{name}`,
`{callme}`, `{host}`, `{clipboard}` and `{cursor}` (where the cursor lands). Three come built in: `/sig` (sign-off with
your name), `/stamp` (date and time) and `/flushdns` (terminal). The same page lists your clipboard transforms.

### Macros: keyboard shortcuts

A **macro** is a quick key that works anywhere, even while FBRX is in the background. **Settings → Macros** lists them;
click one and press new keys to change it, or turn it off:

| Macro | Default | What it does |
| --- | --- | --- |
| Clipboard history | **Ctrl+Alt+Z** | Opens your recent copies near the pointer, like Windows' Win+V |
| Spotlight | **Alt+Space** | Search apps, files, settings and quick answers (Ctrl+K inside FBRX) |
| Presenter-safe mode | **Ctrl+Alt+P** | On and off before you share your screen |

**Your macros** (Settings → Macros) are shortcuts you make: press one in any app and FBRX types its command or text
where you are (it puts the text on the clipboard, presses paste once you let go of the keys, and puts back what was on
the clipboard; on a Mac it stays on the clipboard for ⌘V). The quickest way to make one is **Add to macros** on a
command: the ⚡ button or the right-click menu on commands in Library → FBRX commands, the Terminal's reference panel
and the FBRX/1 library, or on any text you pick. The dialog takes a name, the text (placeholders as in snippets), the
keys, and can also offer it as a `/name` snippet in the chat, the Terminal and FBRX/1. A shortcut already used by
another macro is refused.

### The right-click menu

Right-click works everywhere in FBRX. In a text box: Undo, Cut, Copy, Paste and Select all. On text you picked: Copy,
Ask Fabrix about it, and Add to macros. On a command: Copy, Add to macros, Put it in the Terminal (Ultra), and on the
command libraries Run, Type it into an open server console, and Ask Fabrix to explain it. On a page in the sidebar:
Open, and Open in a new window. Anywhere else, **What's this?** asks Fabrix what that part of FBRX is for, in a few
plain words (handy in Endpoint Essentials), and **Open this page in a new window** puts the page beside FBRX. Shift and
right-click skips the menu.

### Pages in their own window

**Pop out** (Terminal) and the ⧉ button by Conversations (the chat) open the page in a window of its own, beside the
main window, so you can work side by side; right-click any page in the sidebar for the same. The window has **Side by
side** (FBRX on the left, this window on the right), **Keep on top**, and a way back to the main window. Links to other
pages open in the main window. In **Settings → General → Windows** the Terminal (Ultra) and the chat can always open in
their own window.

**The clipboard history** shows what you copied while FBRX was running, newest first:

| Key | Does |
| --- | --- |
| **W / S** or **↑ / ↓** | Move up and down the list |
| **Tab** / **~** | Slide right and left through ways to paste the chosen copy: *As copied*, *Clean*, *One line*, *Comma list*, *UPPERCASE*, *lowercase*, *Title Case*, *Quoted string*, then your saved clipboard transforms (formats that would not change it are skipped; a preview shows the result) |
| Type anything else | Search your copies (while searching, W and S type letters; the arrows still move) |
| **Enter** | Paste it into the app you were in (Windows; on a Mac it goes on the clipboard and you press ⌘V). Double-click works too |
| **Delete** · **Ctrl+P** | Remove it · pin it (pinned copies stay when you clear the history) |
| **Esc** | Clear the search, or close |

The history is off until you turn it on (the first Ctrl+Alt+Z offers it, or **Settings → Macros**), lives in memory
only and skips copies that password managers mark as secret. *Paste right away* can be turned off so a pick only goes
on the clipboard.

### Code lab

**Terminal → Code** is a small IDE with Fabrix beside you: a real code editor (syntax colors, line numbers, brackets,
folding, search, undo) for PowerShell, Python, JavaScript, TypeScript, C#, Java, Go, Rust, C, C++, Ruby, Bash, Lua,
PHP, Kotlin, Swift and batch files. **Quick start** opens Rock, Paper, Scissors in every one of those languages, all
playing the same game the same way so they are easy to compare.

* **Fabrix panel**: *Explain*, *Fix* (finds bugs and gives a corrected file), *Comment*, *Convert to…* another language,
  *What if?*, or ask anything (select lines first to ask about just those). Code in an answer can be inserted at the
  cursor, replace the file (Ctrl+Z undoes it) or open as a new file in its language.
* **What if?** summarizes what the file would do before you run it anywhere: step by step, what it touches (files,
  network, settings, admin rights) and a verdict: *Safe to run*, *Changes things* or *Risky*.
* **Run** (JavaScript): runs right in FBRX, completely sandboxed; answers for `prompt()` come from the Input box.
  **Run in Sandbox** (PowerShell and batch, Windows Pro/Enterprise): opens the file inside Windows Sandbox with no
  network and the code folder read-only. Other languages are never run by FBRX.
* **Run it yourself** shows, for the language in the editor, where to get the tools and the exact commands
  (`python rps.py`, `go run rps.go`, `java Rps.java`…), plus where the files are. **VS Code**, **PowerShell ISE** and
  **Editor** open the file in those apps (shown when installed). Ctrl+S saves, Ctrl+Enter runs.

### Event Viewer

**Task Manager → Event Viewer** reads the Windows event logs (Application, System, Setup, Security with admin
rights, Microsoft Defender, PowerShell, Task Scheduler, Wi-Fi), the systemd journal on Linux, or the unified log on a
Mac (errors and faults, last six hours). Filter by level (counts on each), time range (an hour to 30 days), source
and event ID, then search within the results. Click an event for the full message and details, *Explain this
event*, copy it or search the web. The Fabrix panel's *Analyze these events* groups repeats, separates what matters
from harmless noise and suggests what to fix first. **Bug catcher → Show logs → All logs** opens it too.

### FBRX/1

**Terminal → FBRX/1** manages FBRX OS from a command line in the style of a network operating system:
`show` reads, `request` acts, and `configure` edits settings as a candidate that only takes effect on `commit`.

```
root@PC> show system status
root@PC> show services | except running
root@PC> show log 200 | match error
root@PC> request ai stop
root@PC> configure
[edit]
root@PC# set appearance preset neon
root@PC# show | compare
+ set appearance preset neon
root@PC# commit check
configuration check succeeds
root@PC# commit
commit complete (1 change)
root@PC# exit
```

| Command | What it does |
| --- | --- |
| `show version`, `show license` | Product, version, build and license |
| `show system status`, `show system resources` | Services, vault, fleet, agent and emergency stop; processor, memory and disks |
| `show services`, `show alerts`, `show approvals`, `show tasks`, `show consoles`, `show trophies` | What they say |
| `show ai providers`, `show ai models <provider>` | AI providers and their models |
| `show network interfaces`, `show network devices`, `show network vendors` | Adapters, the last scan, the MAC registry in use |
| `show audit <n>`, `show log <n>` | The audit log (newest first) and FBRX's log |
| `show configuration [section]` | Settings in use, as a tree or (`| display set`) as `set` commands |
| `request service restart <name>`, `request backup now`, `request network scan`, `request alerts mark-read` | Actions |
| `request ai stop`, `request ai resume` | The emergency stop |
| `ping <host> [count n]` | Ping |
| `configure` → `set`, `delete`, `show [| compare]`, `commit [check]`, `rollback`, `run <command>`, `exit [discard]` | Edit settings safely: `commit check` validates against the schema and your organization's locks first |

Unique prefixes work (`sh sys st`), **Tab** completes, **?** lists what can come next, ↑ / ↓ walk the history, and
output can be piped: `| match <text>`, `| except <text>`, `| count`, `| last <n>`, `| display json`,
`| display set`. The **FBRX/1 library** next to the console has pre-configured commands and multi-line recipes
(health check, switch theme, offline-first agent, try-before-you-commit); ▶ runs every line in order, and the
bookmark on any command you ran saves it as an FBRX/1 snippet that appears under *My snippets*. Once the FBRX
commands are found in the Library (*Operator Mode* with fun extras on; straight away with them off), the library also
has **FBRX Server** and **FBRX Gate**: click one to copy it, or type it into an open server console (Enter stays yours).
Every FBRX/1
command, with what it does, is also in **Library → FBRX commands**, next to the FBRX Server and FBRX Gate ones. FBRX/1 is reserved
for the person at the computer: it is not available over the Local API, the mesh or remote commands, and every
change goes through the same checks and audit log as the rest of FBRX.

### Emergency stop

The red **Emergency stop** button (Settings → Agent, the slim pill at the bottom of the conversation list on the agent
page, the tray menu, or `request ai stop` in FBRX/1) halts every AI action at once: running chats are canceled, tools waiting for
approval are denied, the local model is stopped, and the agent and AI apps connected over the Local API are refused
until someone resumes. A red **AI on emergency stop** pill with **Resume** stays in the top bar meanwhile. Only the
person at the computer can resume (Resume, the tray menu or `request ai resume`); both are in the audit log. You can
still use tools directly while the AI is stopped.

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

### Notifications

**Alerts → Notifications** (1.9.8+) covers everything that pops up, not only alerts:

* **Show notifications**, on or off, and a switch for each kind: alerts, approvals, messages, FBRX Mesh, help desk,
  your organization, calendar reminders, backups, notes from your AI, macros, FBRX itself and plugins. The alerts and
  messages switches are the same ones as *Delivery → Desktop* and *Settings → Messages*.
* **Where they show.** Each notification shows in **one place**:
  * *Automatic* (the default): inside FBRX while you are using it, otherwise in Windows notifications (Notification
    Center on a Mac).
  * *Only in FBRX*: nothing pops up over your other apps.
  * *Only in Windows notifications*.
  * *Both*: how it worked before 1.9.8, when every notification showed twice.

  Clicking a Windows notification opens FBRX on the page it is about.
* **Sound:**
  * *FBRX sound* (the default): FBRX's own chime, made in the app with no sound file. Its two rising notes are
    FBRX's; a warning falls, a problem knocks twice, and good news finishes the chord. It has its own volume and a
    *Hear it* row, and the Windows notification stays silent so you hear one sound.
  * *Windows sound*.
  * *No sound*.

  Macros never make a sound.
* **Send a test notification** waits four seconds, so you can switch to another app and see where it lands.

Presenter-safe mode still holds notifications back while you present.

## PC care (Windows)

| Page | What it does |
| --- | --- |
| **Storage** | Drives with health and BitLocker state; clean temporary files; empty the Recycle Bin; "what is using space?" analyzer. Ultra: physical disks with wear and temperature, partitions, optimize / check / rename / extend |
| **Security** | Microsoft Defender status, quick/full/folder scans, definitions update, threat history and removal; firewall profiles; listening ports (exposed vs local); what starts with Windows and unsigned programs running from user folders; file check (SHA-256, signature, VirusTotal with your key); **link check** (look-alike domains, redirects without running page code, domain age, certificate, VirusTotal); Windows Sandbox for unknown links and files. Ultra: Defender settings and exclusions |
| **Updates** | App updates through winget (one or all, with live output), pending Windows updates, third-party drivers oldest first, installed updates |
| **Bug catcher** | Errors from the event log grouped by source, app crashes, blue screens, unexpected shutdowns, problem devices and stopped services — with one-click repairs (SFC, DISM, network reset, Windows Update reset, Explorer restart, icon cache, print queue, Store cache, clock resync, battery and energy reports) and "explain with Fabrix" |
| **Backup & restore → Whole computer** | **FBRX Time** (1.9.8+, every edition): an image of the whole computer, by hand or every day or week at a time you choose, to an external drive, a network folder, or an FBRX Server (paste its connection code). Set up once with one UAC prompt; after that *Back up now* and FBRX Command's *Image backup now* start it without asking, and a computer that was off at the time catches up when it is next on. Shows the last image, the next one and how many the target holds; right-click it for the same actions. Images go back with Windows' *System Image Recovery*; on an FBRX Server each one is also checked by starting it ([TIME.md](TIME.md)) |
| **Virtual lab** (advanced) | **Room for a VM**: live processor, memory and disk gauges and which VM sizes fit right now (keeping 2 GB and a core for Windows). **My VMs**: cards with state, resources, network (isolate / internet / unplug), console, shut down, save, power off, named checkpoints, revert and delete (optionally keeping the disk). **New safe VM**: templates for Kali Linux, REMnux, FLARE-VM, Parrot Security, Ubuntu, a Windows 11 evaluation machine or your own disc, each with its official download page, a fit check and a setup guide from Fabrix; Generation 2, secure boot, a TPM for Windows guests and a first checkpoint. **Windows Sandbox**: launch it with a link or a read-only shared folder, networking on or off. **Readiness**: edition, firmware virtualization, memory, processors and account, plus turning on Hyper-V, Windows Sandbox, the Virtual Machine Platform and WSL. *Plan a lab* asks Fabrix to design one for this PC |
| **FBRX Server** (Black Hole) | **Your servers**: FBRX Servers and any other server or device with a web console, saved by address and port, opened inside FBRX in a browser of its own (separate sign-ins and cookies, no access to FBRX). An FBRX Server opens as a **remote desktop**: its console with a command line (SSH) under it, full screen or in a window of its own, through FBRX VPN when you are away. A server's own certificate is trusted once, after comparing its fingerprint with the server's, and only that certificate is accepted at that address from then on. FBRX Servers paired on FBRX Mesh are offered. **Set up a server**: the installer ISO, the bundle for a Debian 13 server you already have, the firmware settings to check first, and the guides (see [SERVER.md](SERVER.md)) |

Actions that need administrator rights show the Windows UAC prompt. FBRX passes the script to the elevated
PowerShell as an encoded command — it is never written to a file that another program could swap before you
approve. Read-only information never asks for elevation.

## Network Center

Overview (this PC, router, internet latency and loss, public address, plain-language verdict), ping and
**trace route with hop identification** (your router, other local routers / double NAT, your provider, the
internet, the destination; names, makers and locations), **device discovery** (ping sweep, ARP, mDNS/Bonjour,
UPnP, port fingerprints and MAC vendors identify PCs, phones, printers, TVs, cameras, smart-home devices and NAS),
saved scans with comparison and CSV export, a **speedometer** speed test (download, upload, latency and jitter, with history), Wi-Fi (signal, channel, band, congestion by
channel), Bluetooth devices with battery, printers (test page, queue, default, clear, restart spooler), DNS
comparison, port checks and device consoles (Ultra). Ultra: adapter configuration (DHCP, static, secondary addresses).

Makers come from the **IEEE MAC address registry** that ships with FBRX OS (MA-L, MA-M and MA-S blocks, about 54,000
entries, the most specific block wins; randomized phone and laptop addresses are recognized as such). *Update from
the IEEE* in Toolbox → MAC vendor lookup downloads the current lists (falling back to the daily published JSON copy
when the IEEE site refuses the download).

### Network environments (Black Hole): your UniFi console

**Network Center → Environments** attaches the UniFi console that runs a school's or office's network (Dream Machine,
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
or makes codes. Essentials and Standard do not show environments.

### Device consoles (advanced)

A device with SSH (22, or 4118 for WatchGuard) or Telnet (23) open gets a **Connect** button. The console opens in
Terminal → Device consoles with a full terminal (colors, `--More--` paging, full-screen editors) and, next to it, the
**device guide** for the maker: how to log in, the commands people use most (click to type one, ▶ to run it;
commands that change or restart the device ask first), a button that turns paging off, the maker's official
documentation and a search for more commands. Guides: **FBRX Server** (FBRX Virtual, its roles and libvirt) and
**FBRX Gate & MiniDome** (picked by themselves when the server's name has fbrx in it), Ubiquiti UniFi / EdgeMAX, Sophos Firewall, Cisco IOS / IOS XE,
Cisco Meraki (no CLI: dashboard pointers), Fortinet FortiGate, Palo Alto PAN-OS, Juniper Junos, HPE Aruba, MikroTik
RouterOS, pfSense / OPNsense, TP-Link Omada / JetStream, NETGEAR, SonicWall, WatchGuard, Zyxel, Synology, QNAP,
Raspberry Pi and generic Linux. *Web admin* opens the device's admin page; *Windows Terminal* opens the same SSH
login outside FBRX.

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

## Presenter-safe mode

For when your screen is on a projector, a classroom TV or shared in a meeting, in every edition (**Settings →
Presenting**). While it is on:

* notifications stay quiet (an urgent one only says that something needs a look), in the app and from the system;
* the clipboard history shows dots instead of your copies (they still paste);
* chat history, alerts, credentials and help desk tickets are blurred;
* the Silly Goose stays home and approvals wait in the top bar.

Turn it on with **Ctrl+Alt+P** (a macro you can change), the tray menu, or **Turn on now**; the top bar says
**Presenting** while it is on (click it to turn it off). **Turn on by itself while a projector or second screen is
connected** does what it says (mirrored displays can look like one screen, so the shortcut is the sure way); turning it
off by hand then keeps it off until the extra screen is unplugged. Education organizations turn the automatic switch
on for staff computers.

## Help desk

Once a computer belongs to an organization (FBRX Command), a **Help desk** tab appears in the sidebar. **New ticket**
sends a problem to IT: a short subject, what it is about (this computer, Wi-Fi, printer, projector or sound, sign-in,
an app), the details, *urgent* when a class or meeting cannot go on, and (unless you untick it) a short summary of the
computer: name, system, free space, memory, network address and any failing FBRX services. **My tickets** and
**History** show where each one stands and the conversation; you are told when IT answers, and can reply, say *It's
fixed*, or open it again. The agent can write a ticket for you too (you approve it before it goes).

Computers marked as **receivers** in FBRX Command (Devices → a device → *Receives help desk tickets*) get a **Queue**
tab: every open ticket, newest and most urgent first, delivered within a second of being sent. Take a ticket, answer,
change its status and priority. Admins can answer from FBRX Command's Help desk page as well.

### Working on the computer that asked

Under a ticket, a receiver has **Work on** *that computer*:

| | What happens on the computer that asked |
| --- | --- |
| **Check it** (Run diagnostics) | A fresh snapshot comes back: processor, memory, disk, network (address, gateway, DNS), protection, problems and the busiest apps. Nothing is changed. **Explain** hands it to your own agent. |
| **Ask its AI** | Its agent answers a question about that computer, looking things up with its own tools; anything that would change the computer asks the person there. |
| **Run a command** | The command runs in its shell (PowerShell on Windows) and the output comes back, with **Explain**. |

The person at that computer is asked once per ticket (*Let … from the help desk work on this computer*, under
Approvals, with a notification); a yes lasts 2 hours. Every command asks them again, by itself, and a no comes back as
*Not run*. Each request is noted in the ticket (*Alex checked how Milo laptop is doing*), and FBRX Command's audit
log keeps it. A computer that is off gets the request when it is back (within 30 minutes).

Settings → Messages → **Help desk** on each computer (or `helpdesk.assist` in a profile, *The help desk works on the
computer*) chooses: **Ask me once per ticket** (the default), **Without asking** (commands then follow the governance
policy, like any remote request), or **Never**.

Tickets travel through FBRX Command rather than the mesh: Command keeps every ticket and its conversation (so nothing
is lost while the IT computer is off or at home), works across networks, and pushes each change instantly over the
encrypted connection every computer already keeps with it. The mesh stays for one person's own devices.

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

**Test** (next to a connected app) starts the bridge exactly the way the app will and checks that it lists the FBRX
tools, so you know the link works before you switch apps. For Claude Desktop, FBRX writes the configuration for both
the regular installer and the Microsoft Store version (which keeps its settings under
`%LOCALAPPDATA%\Packages\Claude_…\LocalCache\Roaming\Claude`); quit Claude completely from its tray icon and start it
again to load it. Then, in Claude, ask it to use FBRX ("use FBRX to check my disk space", "ask Fabrix …").

**Second opinion** asks another configured model the same question without tools. Claude Code, when installed, is
one of the choices: FBRX runs `claude -p` with the question and shows the answer, which is how to ask Claude from
FBRX without an API key (an Anthropic API key, added in AI models, works too). FBRX cannot type into the Claude
Desktop app itself.

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
| `calendar.agenda`, `calendar.free_time` (when a calendar is connected) | read |
| `calendar.create_event` | write — adds to an Outlook calendar, never invites anyone |
| `shield.status`, `shield.scan` (report only) | read |
| `shield.quarantine` | write |
| `memory.remember`, `memory.forget` | write (FBRX's own data; identity and money numbers are refused) |
| `memory.recall`, `memory.search_chats` | read |
| `fbrx.help`, `fbrx.doctor` | read: FBRX's knowledge base and the check-up |
| `fbrx.fix` | write — asks first |
| `files.request_access` | read: asks the person for a folder |

## Local AI without the stutter

A local model left to itself takes every processor core at normal priority, which makes the whole computer stutter
while it thinks. **Settings → Agent → How hard a local model may work this PC** sets it:

| Setting | Built-in runtime and Ollama |
| --- | --- |
| Light | A quarter of the processor threads, lowest priority; Ollama unloads the model after 2 minutes |
| Balanced (default) | Half the threads, below-normal priority; Ollama keeps it for 5 minutes |
| Full speed | All threads but one, normal priority; Ollama keeps it for 30 minutes |

The built-in runtime also takes one conversation at a time (so the whole context goes to it), refuses a model that
would not fit in memory, loads only when a chat needs it (or at start-up when it is the default provider), and is
unloaded after 20 idle minutes (**Unload the local model when idle**: 5 minutes to never). Answers stream into the
window in small batches rather than token by token, and the system monitor samples every 10 seconds instead of 2
while the window is hidden.

## New versions

FBRX OS looks for new versions in its online repository a minute and a half after it starts and every six hours
(**Settings → Updates → New versions**, where *Check now* and the automatic check live). When there is one, an alert
says so, an **Update to 1.x.y** pill appears in the top bar, and the dialog shows what is new. Updating is always your
choice:

* **Update now** downloads the new version into the folder FBRX was installed from and starts the installer there in
  its own window (Terminal on a Mac: press Return). FBRX closes, updates and opens again; your data, settings,
  license and signing keys stay. Installs made before 1.8.1 don't know their folder yet: **Download** gets the new
  zip; unzip it over your FBRX folder and run the installer once, and from then on Update now works.
* **Later** keeps the pill; **Skip this version** stops the reminders for that version.
* **Install new versions by itself** (or your organization's *Install automatically*) installs a new version without
  asking, waiting until nobody is using the computer, nobody is presenting and the agent is idle. FBRX Command can also
  send **Update now** to every computer at once (see ADMIN_CONSOLE.md).

Windows copies signed by a publisher only install updates signed by the same publisher (see DEPLOYMENT.md → Signing).

## Thinking

**Settings → Agent → Thinking** sets how much Fabrix does on one task, in every edition:

| Level | For | Steps per task | What a local model keeps in mind | A local model thinks first |
| --- | --- | --- | --- | --- |
| **Quick** | Small jobs and quick answers; it checks in with you sooner | 10 | 8K tokens | No |
| **Everyday** (where every computer starts) | Everyday tasks | 30 | 8K tokens (Ollama: its own setting) | No |
| **Thorough** | Big jobs and long documents | 100, the most there is | 16K tokens (about 1 GB more memory) | Yes |

Every level leaves the length of an answer to the model. A step is one round of thinking and using tools; when Fabrix
uses them all it says so, and *continue* goes on. The steps are kept in the policy (with up to three tool calls a
step), so an organization can set them; when it sets any part, the levels are locked. **Show what Fabrix is thinking
and doing** turns the live activity panel and the thinking notes on or off.

**Standard and up** also set each part on its own, starting from the level's values; changing one makes the level
**Custom** (picking a level puts it all back):

| Setting | What it does | Default |
| --- | --- | --- |
| Steps per task | 5 to 100. | 30 |
| Longest answer | The most the model may write in one reply. A cut-off answer says so. | Automatic (64K tokens for Claude, the server's own limit for other models) |
| Memory of the built-in model | The built-in runtime's context window, 4K to 128K tokens, with the memory it needs. | 8K |
| Memory of Ollama models | Ollama's context window (`num_ctx`); Ollama's own setting is often 4K. | Ollama's setting |
| A local model thinks before it answers | Lets a model that can reason first (Qwen3, DeepSeek R1 and the like) do so on this computer. Better on hard questions, much slower: it writes hundreds of words of reasoning before the answer. | Off (on for Thorough) |

### Why a model on this computer is slower than a cloud AI

FBRX is the banks of the river, not the river: every AI you pick gets the same tools, memory and governance, and
FBRX helps a small one more and gets out of a capable one's way. A cloud AI sees every tool and decides how long it
thinks; a model on this computer gets the help below.

A cloud AI runs on accelerators built for it, with many times the memory speed of a computer's processor and RAM:
writing each word means reading the whole model from memory, so a laptop writes 5 to 15 words a second where a cloud
AI writes 50 to 100, and it reads a long request in a moment where a laptop takes many seconds. FBRX gives a local
model less to read and write:

* **A short list of tools.** An AI that holds a long conversation (about 32K tokens or more: a cloud AI, a big
  model on a server) is shown every tool (about 6,500 tokens of descriptions). A smaller one gets a few it always has
  (the time, its memory, FBRX's help and check-up) and the tools for what the chat is about, briefly described: the
  files, the web, the computer, the calendar… A new subject adds its tools at the end. It may still call any tool it
  is allowed to use. *Tools it is shown* on each provider (AI models → edit) chooses for yourself.
* **The same start every time.** The instructions and tools stay the same from one request to the next (what Fabrix
  remembers goes with your message), so the AI reuses what it already read and starts writing sooner: the built-in
  runtime's prompt cache, and a cloud AI's (Claude's, for one).
* **Room for the chat.** What the model keeps in mind is shared out after the instructions and the tools, so a long
  chat is shortened from its start instead of overflowing.
* **No thinking out loud first** (above), unless the level is Thorough or you turn it on.

On a computer with 16 GB of memory, a 4B or 8B model is the quick choice; with 32 GB, a mixture-of-experts model
(Qwen3 30B-A3B, which uses about 3B of its parameters for each word) answers about as fast as a 4B one and better. A
graphics card with enough memory for the model is the biggest speed-up of all.

## AI models

**AI models** lists every way to run the agent:

* **Built-in local runtime** (llama.cpp). *Install runtime* downloads the newest official llama.cpp build for this
  computer: the Vulkan build when there is a graphics card with at least 2 GB of memory, otherwise the CPU build.
  *Use* on a downloaded model makes it the default. A model that does not all fit in the graphics card's memory (Qwen3
  14B on a laptop card, say) loads with half of its layers on the card, then none, and the page says how it runs;
  the next start goes straight to what fit. When a model will not load, the page says why and offers the fix:
  **Download again** for an incomplete or damaged file, **Update the runtime** for a model newer than the runtime,
  a smaller model when memory is short, and **Show what the runtime said** for everything else. A download that
  stops early is kept and continues where it stopped.
* **Ollama models**: the models Ollama has already downloaded on this computer, read from Ollama, or from its model
  folder (`OLLAMA_MODELS` or `~/.ollama/models`) while Ollama is not running, with *Start Ollama*. *Use* makes one the
  default. With no model chosen, Fabrix picks the installed model best suited to tool calling.
* **Your other computers' AI**: paired computers (your FBRX Server, say) that lend the AI they run themselves. *Use
  for chats* makes one the default: Fabrix keeps working here, with its tools, memory and approvals, and the model
  there does the thinking. From away, connect FBRX VPN first. See [MESH.md](MESH.md#think-with-your-fbrx-servers-ai).
* **Providers**: Ollama, Claude, other OpenAI-compatible endpoints, and other computers' AI. The *Default model* is a
  list of the provider's models (or *Other model…* to type a name).

The chat's model list shows the same installed models. If a chat asks Ollama for a model it does not have, the error
names the installed ones. Each answer in a chat shows the model that wrote it and how long it took from your question,
so two AIs are easy to compare.


## Easter eggs

FBRX OS has a playful side, all of it under **Settings → Appearance → Fun extras** (and lockable by an organization).
For the full list (spoilers), see [EASTER_EGGS.md](EASTER_EGGS.md).
