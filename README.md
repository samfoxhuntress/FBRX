<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/fbrx-logo-dark.svg">
    <img src="docs/assets/fbrx-logo-light.svg" width="96" height="96" alt="FBRX">
  </picture>
</p>

# FBRX OS — Fabrics Operating System

FBRX OS is a desktop super-tool for Windows (macOS next) with a **local-first AI agent, Fabrix,** that is governed
end to end, an everyday **command center** (dashboard, tasks, notes, Spotlight, alerts, PC care, Network Center with SSH /
Telnet device consoles and maker guides, your phone), plus a **control plane** and **admin console** for running it across a fleet of workstations — or
selling it to other companies, each in its own tenant.

```
 ┌──────────────────────────── Workstation (macOS / Windows) ────────────────────────────┐
 │  FBRX OS desktop (Electron)                                                          │
 │   ├─ Renderer UI ── preload bridge (no Node) ──┐                                     │
 │   └─ Core (@fbrx/core)  ◄──────────────────────┘                                     │
 │        Agent loop ─► Tool gate: license → schema → rate limit → policy → guardian    │
 │                          → human approval → execute → redact → hash-chained audit     │
 │        Tools: files · shell · web · memory · plugins (sandboxed) · connectors         │
 │        AI: local llama.cpp runtime · Ollama · OpenAI-compatible · Claude              │
 │        Vault (OS keychain + AES-256-GCM) · encrypted snapshots · Local API · watchdog │
 │        Fleet agent ──── WebSocket + HTTPS heartbeat ─────────────┐                    │
 └──────────────────────────────────────────────────────────────────┼────────────────────┘
                                                                    ▼
 ┌──────────────────────── Control plane (Docker / any Node 22+ host) ───────────────────┐
 │  Enrollment · managed config/policy/secrets · real-time commands · update feeds       │
 │  Snapshots · plugin packages · Ed25519 licenses · tenants/RBAC/MFA · webhooks · audit │
 │  Admin console (React) served from the same origin                                   │
 └───────────────────────────────────────────────────────────────────────────────────────┘
```

## What you get

| Need | Where it lives |
| --- | --- |
| A local AI agent that works offline | Bundled llama.cpp runtime + model catalog (Local AI page). Cloud providers (Claude, OpenAI-compatible, Ollama) are optional and can be blocked by policy. Talk to it and hear it answer (on-device Whisper speech recognition, the computer's own voices at the speed you pick), watch what it is doing and thinking while it works, and set its work budget (steps per task, answer length, context size). |
| Agents and services that govern it | Policy engine, guardian (dangerous-command and prompt-injection detection, optional model review), human approvals, rate limits, secret redaction, tamper-evident audit log, service watchdog. |
| Back up, redeploy, carry on as if nothing happened | Encrypted `.fbrxsnap` snapshots (manual, scheduled or remote) restored in **migrate** mode — same identity, same fleet enrollment, same vault. See [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md). |
| Deploy to other Macs and PCs | Signed `.dmg`/`.zip` and NSIS `.exe` installers, zero-touch provisioning files, golden template snapshots, auto-updates by channel, pin and staged rollout. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). |
| Sell it | Tenants per customer, editions (Community / Pro / Enterprise), offline-verifiable Ed25519 license keys, seats, expiry, version caps. See [docs/LICENSING.md](docs/LICENSING.md). |
| Admin console, credentials management, real-time backend | Fleet dashboard, device detail and live commands, managed settings/policy with locks, secrets pushed into device vaults, users/roles/MFA/API keys, releases, packages, snapshots, webhooks, audit. See [docs/ADMIN_CONSOLE.md](docs/ADMIN_CONSOLE.md). |
| Build in other tools and connect to other apps | Plugin SDK (sandboxed workers), REST / MCP / webhook / FBRX-peer connectors, Local API for scripts and other apps. See [docs/PLUGINS.md](docs/PLUGINS.md). |
| An everyday command center | FBRX Glass (the live dashboard), tasks / notes / projects / snippets, Spotlight (Alt+Space), files, Task Manager with an AI-assisted Event Viewer, a Clipboard processor, slash macros (`/snip`), Copy & migrate (Robocopy / rsync), terminal with a sandboxed code lab and *What if?*, the FBRX/1 management console, toolbox, library, alerts to desktop / phone / Slack / Teams / e-mail / your admin console, an AI emergency stop, and a theme studio with eleven looks. See [docs/COMMAND_CENTER.md](docs/COMMAND_CENTER.md). |
| PC care for Windows | Storage clean-up and disk health, Microsoft Defender and firewall, link and file checks, Windows Sandbox, winget / Windows Update / drivers, a bug catcher with one-click repairs, a Hyper-V lab, and a Network Center (trace route, device discovery, speed, Wi-Fi, Bluetooth, printers). |
| Your other devices and AI apps | An encrypted mesh with your other FBRX computers and the FBRX Mobile phone app (per-device permissions, one-time pairing codes); one-click MCP connection for Claude Desktop, Claude Code, Cursor, Windsurf and VS Code. See [docs/MESH.md](docs/MESH.md). |

## Repository layout

```
apps/
  desktop/          Electron app (main, preload, React renderer) + electron-builder config
  control-plane/    Fastify server: fleet, licensing, updates, admin API (bundled to one file)
  admin-console/    React admin console (served by the control plane)
packages/
  core/             The FBRX OS runtime (agent, governance, vault, plugins, connectors, backup, fleet agent,
                    workspace, alerts, Windows PC care, network diagnostics, mesh, AI coordination)
  core/mobile/      FBRX Mobile, the phone web app served over the mesh
  shared/           Types, schemas, protocol, crypto helpers shared by everything
  ui/               Design system + charts used by both UIs
  plugin-sdk/       Types and helpers for plugin authors
plugins/example-toolkit/   Reference plugin
scripts/            Release, licensing, plugin and runtime tooling; local fleet demo
deploy/             Docker compose + Caddy for the control plane, provisioning example
docs/               Architecture, deployment, backup/restore, plugins, security, licensing, admin console,
                    command center, mesh
```

## Install on your own laptop

Unzip the downloaded folder somewhere permanent and outside synced folders (for example `~/FBRX` or `C:\FBRX`),
then double-click the installer for your computer. On Windows, right-click the zip and choose **Extract All…**;
double-clicking `Install FBRX OS.cmd` inside the zip without extracting it also works: setup finds the zip in your
Downloads folder, offers to unzip it to `%USERPROFILE%\FBRX` (or a folder you type) and continues from there.

| Computer | Double-click | If the computer warns you about a downloaded file |
| --- | --- | --- |
| Mac | **`Install FBRX OS.command`** | System Settings → Privacy & Security → **Open Anyway**. Or open Terminal, type `bash ` and drag the file in, then press Enter |
| Windows | **`Install FBRX OS.cmd`** | **More info → Run anyway** |

The installer asks for your name or company (it goes on your license), then does everything else, in about
10–20 minutes the first time:

1. downloads a private copy of Node.js if this computer doesn't have a recent one (nothing is installed system-wide),
2. installs the project's dependencies,
3. creates your license signing key (in `.fbrx-keys/`, with a copy in `~/.fbrx-keys`), which you should **back up**:
   it signs every license you sell,
4. builds FBRX OS for this exact machine (Apple silicon or Intel, x64 or ARM),
5. installs it in Applications (Mac) or for your user with Start menu and desktop shortcuts (Windows),
6. issues you an Enterprise license that activates automatically, and opens the app.

To update later, download the new version into the same place and run the installer again; your data, settings and
keys are kept, and a running FBRX OS is closed for you. Options: `--yes` (no questions), `--name "Acme Ltd"`,
`--no-launch`, `--allow-downgrade`. The full log is in `.fbrx-setup/setup.log`.

### Sending FBRX OS to someone else (Windows)

Run `Install FBRX OS.cmd` and choose **2 — Make an installer to send to someone else**. Enter their name to build a
trial license into the installer (30 days by default; Enterprise features, then the free Community features), or
leave it blank to send an update to someone who is already set up. The result is one file in the `Share` folder,
for example `Share\FBRX-OS-Setup-1.6.0-for-Alex.exe`, plus a short *How to install* note to send along.

On their PC they double-click it. A new install asks the usual questions. If FBRX OS is already there, Setup opens on
a choice instead:

* **Upgrade** (when the file is newer) — installs it and keeps all their data, settings, license and paired devices,
* **Repair** — reinstalls from scratch and clears cached files, for an app that will not start or looks wrong,
* **Uninstall** — removes FBRX OS, keeping their data unless they tick *Also delete my data*.

If FBRX OS is open, Setup asks it to quit properly first (and ends anything left over, such as the local AI runtime).
An older file than the installed version offers a downgrade, with a warning. Details and the command-line switches for
IT tools: [DEPLOYMENT.md](docs/DEPLOYMENT.md#windows-installer-upgrade-repair-and-uninstall).

Prefer to do it by hand? `npm install`, then `npm run dev:desktop` to try it, or `npm run keys:generate`,
`npm run package:mac` / `npm run package:win` and `npm run license:issue -- --customer "Your Name"` to build and
license an installer yourself.

## Quick start (development)

Requirements: Node.js 22.15+ (see `.nvmrc`). No native modules, no Python, no compilers.

```bash
npm install
npm run verify                 # typecheck + test suite

# The whole system on one machine: control plane + admin console + 3 enrolled headless workstations
npm run build -w @fbrx/admin-console
npm run demo                   # http://localhost:8787  (admin@fbrx.local / FbrxDemo-Admin-2026)

# The desktop app (development mode unlocks all features)
npm run dev:desktop
```

Other entry points:

| Command | What it does |
| --- | --- |
| `npm run dev:control-plane` / `npm run dev:console` | Control plane on :8787 and the console with hot reload on :5173 |
| `npm run headless -- --dev` | Run the full core without UI (servers, kiosks, labs); also `enroll`, `backup`, `restore`, `status`, `token` |
| `npm run package:mac` / `npm run package:win` | Build installers into `apps/desktop/release/<version>/` |
| `npm run runtime:fetch -- --arch arm64,x64` | Download the official llama.cpp server to bundle into installers |
| `npm run keys:generate` | Create the license signing key pair (public key gets embedded in builds) |
| `npm run license:issue -- --customer "Name"` | Sign an offline license key with that private key (no control plane needed) |
| `npm run release:publish -- --publish` | Upload built installers to your control plane's update feed |
| `npm run plugin:create -- my-tool` / `npm run plugin:pack -- plugins/my-tool` | Scaffold and package a plugin |

## Going to production

1. **Keys** — `npm run keys:generate`. Commit `apps/desktop/build/license-public-key.pem`; store the private key as the
   control plane's `FBRX_LICENSE_PRIVATE_KEY` (or let the control plane generate one and export it with `--from`).
2. **Control plane** — `docker compose -f deploy/control-plane/docker-compose.yml up -d` on a host with a DNS name.
   Caddy provisions HTTPS. Log in, enable MFA, create a tenant per customer, issue licenses.
3. **Installers** — tag `v1.0.0` and the Release workflow builds, signs, notarizes, and pushes the installers to the
   control plane (configure the secrets listed in `.github/workflows/release.yml`).
4. **Workstations** — in the console create an enrollment token, download `fbrx-provision.json`, ship it with the
   installer (or paste the token in Settings → Fleet). Devices appear in the console, take managed configuration,
   receive updates on their channel, and back themselves up to the control plane.

## Status and limits

* The packaged app has been exercised end to end on Linux (unpacked build: onboarding, plugin install, enrollment,
  remote commands, encrypted backup upload). macOS and Windows installers are produced by the Release workflow on
  GitHub-hosted runners; signing and notarization need your Apple Developer ID and Windows code-signing certificate.
* The PC-care pages (Defender, firewall, updates, bug catcher, Hyper-V, printers, adapters) use Windows PowerShell
  and are Windows-only; CI runs their read-only checks on a Windows runner. Actions that change Windows are
  exercised by hand and always go through the UAC prompt.
* The local runtime downloads models from Hugging Face and llama.cpp from GitHub; air-gapped sites can pre-seed
  `models/` or point the catalog at an internal mirror.
* The control plane uses SQLite (`node:sqlite`) — fine for thousands of devices on one node. Put the data volume
  on durable storage and back it up (see [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md#the-control-plane)).

Licensed under your own terms (`UNLICENSED` in package.json); the plugin SDK is MIT so third parties can build on it.
