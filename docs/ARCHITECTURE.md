# Architecture

FBRX OS has three deployable pieces that share one TypeScript codebase:

| Piece | Runs on | Built from |
| --- | --- | --- |
| **Desktop app** | Each macOS / Windows workstation | `apps/desktop` (Electron) embedding `packages/core` |
| **Control plane** | One server you operate (Docker or any Node 22.13+ host) | `apps/control-plane` (Fastify), bundled to `dist/server.mjs` |
| **Admin console** | Any browser, served by the control plane | `apps/admin-console` (React + Vite) |

`packages/core` can also run without UI (`fbrx-headless`, Node 22.15+) on servers, kiosks and lab machines.
No component uses native Node modules (SQLite comes from Node's built-in `node:sqlite`), so the same build
works on Apple silicon, Intel Macs, x64 and ARM Windows without per-platform compilation.

## The core (`packages/core`)

The `Kernel` wires everything together and is the only thing the UI, the Local API and the control plane talk to.
Every request goes through `kernel.call(method, params, { origin, actor })`; the method list and types are the
`CoreMethods` contract in `packages/shared/src/api.ts`. The origin (`user`, `agent`, `api`, `remote`, `scheduler`)
decides what is permitted and how policy treats the call — the agent cannot change policy or read vault values,
and an agent-scoped Local API token can only run the agent and invoke tools.

### Services and watchdog

Each subsystem is a service with dependencies, an optional license/settings gate and a health check:

```
storage → audit → vault → governance → tools → { plugins, connectors, runtime, agent }
                                         backup · fleet · localapi
```

`ServiceManager` starts them in dependency order, health-checks them every 15 s, restarts failed services with
exponential backoff, opens a circuit after five restarts in ten minutes (the user is notified and the control plane
sees it in the next heartbeat), and re-evaluates license-gated services the moment a license is activated, pushed or revoked.

### Data layout

Everything lives under one root (`~/Library/Application Support/FBRX OS`, `%APPDATA%\FBRX OS`, or `FBRX_HOME`):

| Path | Contents | In snapshots |
| --- | --- | --- |
| `fbrx.db` | SQLite (WAL): settings layers, policy layers, vault, audit, conversations, memory, plugins, connectors, fleet state | ✔ (via `VACUUM INTO`) |
| `plugins/`, `plugin-data/` | Installed plugins and their storage | ✔ |
| `workspace/` | The agent's default working folder | ✔ |
| `models/` | GGUF models | optional |
| `runtime/`, `logs/`, `tmp/`, `snapshots/`, `keychain.key` | Machine-local | ✘ |

### Configuration layers

Settings and policy are each stored as layers: **defaults → local → managed**. The managed layer comes from the
control plane and can *lock* individual paths (e.g. `ai.providers`, `network.allowedDomains`); locked paths are
read-only in the UI and rejected by the API. Unlocked managed values act as defaults the user may override.

### Vault (credentials)

* A random 256-bit data-encryption key (DEK) encrypts each secret with AES-256-GCM; the secret name is bound as
  additional authenticated data so ciphertexts cannot be swapped between names.
* The DEK is wrapped by the OS keychain (macOS Keychain / Windows DPAPI through Electron `safeStorage`) and,
  optionally, by a scrypt-derived **recovery passphrase** — the way back in if the keychain is lost.
* Secrets pushed by the control plane are stored as *managed* (read-only on the device, removed when revoked).
* Values never leave the core: tools and connectors reference secrets by name, and the redactor scrubs any secret
  value from tool output, logs and the agent's context.

### Governance pipeline

Every tool call — whether the agent, a user, the Local API, a plugin or a remote command asked for it — goes through
`ToolGate`:

1. **License** — the tool's feature must be licensed.
2. **Enabled** — disabled tools are invisible to the agent.
3. **Schema** — input validated (and safely coerced) against the tool's JSON Schema.
4. **Rate limit** — a per-minute ceiling on tool calls (`rateLimits.toolCallsPerMinute`).
5. **Policy engine** — hard constraints first (filesystem roots, deny globs, read-only mode, the FBRX data folder is
   never reachable; domain allow/block lists, private-network and DNS-rebinding protection; blocked shell
   patterns), then ordered rules (`tool`, `source`, `origin`, `risk`, path/domain matchers), then per-risk defaults.
   `mode: audit` logs what *would* be denied without blocking — useful for rolling out policy.
6. **Guardian** — detectors for destructive or obfuscated commands, writes into system paths, and prompt-injection
   markers in content the agent read; optionally a second model reviews high-risk calls.
7. **Approval** — `ask` decisions wait for a human (desktop notification + Approvals page, remotely visible), with
   "remember for this tool/path/domain" when policy allows.
8. **Execute** with a timeout and cancellation.
9. **Redact** secrets from the result.
10. **Audit** — every decision is appended to the hash-chained audit log.

### Audit log

Each entry stores `sha256(prev_hash ‖ canonical_json(entry))`. `audit.verify` walks the chain; pruning keeps an
anchor so verification still works. The chain head is sent with every heartbeat, so the control plane notices
history being rewritten on a device.

### Agent

`Agent` runs a provider-neutral loop: stream a model turn, collect tool calls, pass each through the gate, feed
results back, repeat until the model answers or `maxStepsPerRun` / `maxToolCallsPerRun` is hit. Conversations are
append-only (provider-specific data such as Claude thinking blocks is preserved and replayed); cancelled or failed
runs close out unanswered tool calls so histories stay valid. Tool names are mapped (`fs.read_file` ↔
`fs__read_file`) to fit every provider's naming rules.

Providers:

| Provider | Notes |
| --- | --- |
| `local` | Supervised llama.cpp `llama-server` on 127.0.0.1 with a random API key. Models from the built-in catalog (download with resume + SHA-256 verification) or any GGUF. |
| `ollama` | Existing Ollama install. |
| `openai-compatible` | LM Studio, vLLM, OpenAI, Azure OpenAI, etc. |
| `anthropic` | Claude through the official SDK; streaming, adaptive thinking, prompt caching, server-side model fallback (`fallbacks: "default"`) enabled for supported models. |

Policy can disable cloud providers entirely or restrict to an allow-list.

### Plugins and connectors

See [PLUGINS.md](PLUGINS.md). Plugins run in separate Node processes started with Node's permission model
(`--permission`, read access limited to the plugin folder, write access limited to its data folder); everything
else (storage, secrets, HTTP, notifications) is brokered by the host and checked against the manifest and policy.
Connectors (REST, MCP over stdio or HTTP, outgoing webhooks, FBRX peers) register tools in the same registry and
pass through the same gate.

### Local API

An HTTP server on `127.0.0.1:47821` (remote access opt-in) with two bearer tokens: **full** (any core method the
`localapi` origin may call) and **agent** (agent runs and tool calls only). Host-header checks block DNS rebinding.
Used by scripts, other desktop apps and FBRX-peer connectors on other workstations.

## Fleet protocol

```
device                                         control plane
  │ POST /v1/enroll {token, machine facts}  ─►  verifies token → device id + device bearer token (stored hashed)
  │ GET  /v1/device/ws  (WebSocket)        ◄─►  config pushes, commands, acks, heartbeats
  │ POST /v1/device/heartbeat  (fallback)   ─►  health, metrics, audit chain head, versions
  │ GET  /v1/device/config                 ◄─   settings + locks, policy, license, secrets, update channel/pin
  │ POST /v1/device/commands/:id/result     ─►  command outcome (idempotent by command id)
  │ POST /v1/device/snapshots               ─►  encrypted snapshot upload
  │ GET  /v1/device/packages/:id           ◄─   plugin package (SHA-256 verified on the device)
  │ GET  /v1/updates/feed/latest*.yml      ◄─   electron-updater feed chosen for this device
```

Remote commands: `ping`, `config.sync`, `update.check`, `update.install`, `backup.create`, `plugin.install`,
`plugin.setEnabled`, `plugin.uninstall`, `service.restart`, `diagnostics.collect`, `notify`, `agent.run`,
`vault.lock`, `app.restart`. Privileged ones require an admin role. Commands queue while a device is offline and
expire; each is executed at most once.

Updates: each device resolves to its pinned version (device → group), or the newest published release in its
channel (`dev` ⊃ `beta` ⊃ `stable`) whose staged-rollout bucket — a stable hash of device id and release id —
falls under the rollout percentage.

## Control plane (`apps/control-plane`)

* Fastify 5 + `@fastify/websocket`, Helmet, rate limits; SQLite via `node:sqlite`; files on disk under the data dir.
* Admin auth: scrypt passwords, TOTP MFA, revocable JWT sessions, API keys; roles `superadmin` (you, the vendor),
  then per tenant `owner`, `admin`, `operator`, `viewer`.
* Multi-tenant: every device, token, group, profile, secret, license, package, snapshot, webhook and audit entry is
  tenant-scoped. Superadmins switch tenant in the console.
* Secrets, MFA seeds and webhook secrets are sealed with the master key; licenses are signed with the Ed25519 key.
* Its own audit log is hash-chained too, and every admin action lands in it.

## Desktop shell (`apps/desktop`)

* Electron main process boots the kernel with an Electron platform adapter (keychain via `safeStorage`,
  notifications, tray, `electron-updater` pointed at the control plane feed, relaunch for restores/updates).
* The renderer is sandboxed with context isolation and a strict CSP; its only capability is the `window.fbrx`
  bridge (`call`, `on`, file dialogs, reveal in Finder/Explorer, open `http(s)` links in the browser).
* Single-instance lock, start hidden on login, minimise to tray.
