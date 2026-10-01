# FBRX OS — Fabrics Operating System

FBRX OS is a desktop super-tool for macOS and Windows with a **local-first AI agent** that is governed end to end,
plus a **control plane** and **admin console** for running it across a fleet of workstations — or selling it to
other companies, each in its own tenant.

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
| A local AI agent that works offline | Bundled llama.cpp runtime + model catalog (Local AI page). Cloud providers (Claude, OpenAI-compatible, Ollama) are optional and can be blocked by policy. |
| Agents and services that govern it | Policy engine, guardian (dangerous-command and prompt-injection detection, optional model review), human approvals, rate limits, secret redaction, tamper-evident audit log, service watchdog. |
| Back up, redeploy, carry on as if nothing happened | Encrypted `.fbrxsnap` snapshots (manual, scheduled or remote) restored in **migrate** mode — same identity, same fleet enrollment, same vault. See [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md). |
| Deploy to other Macs and PCs | Signed `.dmg`/`.zip` and NSIS `.exe` installers, zero-touch provisioning files, golden template snapshots, auto-updates by channel, pin and staged rollout. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). |
| Sell it | Tenants per customer, editions (Community / Pro / Enterprise), offline-verifiable Ed25519 license keys, seats, expiry, version caps. See [docs/LICENSING.md](docs/LICENSING.md). |
| Admin console, credentials management, real-time backend | Fleet dashboard, device detail and live commands, managed settings/policy with locks, secrets pushed into device vaults, users/roles/MFA/API keys, releases, packages, snapshots, webhooks, audit. See [docs/ADMIN_CONSOLE.md](docs/ADMIN_CONSOLE.md). |
| Build in other tools and connect to other apps | Plugin SDK (sandboxed workers), REST / MCP / webhook / FBRX-peer connectors, Local API for scripts and other apps. See [docs/PLUGINS.md](docs/PLUGINS.md). |

## Repository layout

```
apps/
  desktop/          Electron app (main, preload, React renderer) + electron-builder config
  control-plane/    Fastify server: fleet, licensing, updates, admin API (bundled to one file)
  admin-console/    React admin console (served by the control plane)
packages/
  core/             The FBRX OS runtime (agent, governance, vault, plugins, connectors, backup, fleet agent)
  shared/           Types, schemas, protocol, crypto helpers shared by everything
  ui/               Design system + charts used by both UIs
  plugin-sdk/       Types and helpers for plugin authors
plugins/example-toolkit/   Reference plugin
scripts/            Release, licensing, plugin and runtime tooling; local fleet demo
deploy/             Docker compose + Caddy for the control plane, provisioning example
docs/               Architecture, deployment, backup/restore, plugins, security, licensing, admin console
```

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
* The local runtime downloads models from Hugging Face and llama.cpp from GitHub; air-gapped sites can pre-seed
  `models/` or point the catalog at an internal mirror.
* The control plane uses SQLite (`node:sqlite`) — fine for thousands of devices on one node. Put the data volume
  on durable storage and back it up (see [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md#the-control-plane)).

Licensed under your own terms (`UNLICENSED` in package.json); the plugin SDK is MIT so third parties can build on it.
