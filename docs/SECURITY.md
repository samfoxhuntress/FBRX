# Security model

FBRX OS gives an AI agent real abilities on a workstation — files, shell, network, other applications — so the
design assumes the model can be wrong or manipulated and puts every action behind controls the organisation owns.

## Trust boundaries

| Boundary | Control |
| --- | --- |
| Model → workstation | Every tool call passes the [governance pipeline](ARCHITECTURE.md#governance-pipeline): licence, schema validation, rate limit, policy (hard constraints → rules → risk defaults), guardian, human approval, redaction, audit |
| Untrusted content → model | Tool output (files, web pages, API responses) is scanned for prompt-injection language and handed to the model explicitly marked as untrusted data; any tool call whose input carries such language, or any other guardian warning, requires human approval with the finding shown |
| Plugin → workstation | Separate process, Node permission model (files, processes, addons), network and process-control modules removed, all capabilities brokered and permission-checked ([details](PLUGINS.md#sandbox)) |
| Renderer → core | Sandboxed, context-isolated renderer with a strict CSP; only the `window.fbrx` bridge, which routes through the same API and origin checks as everything else |
| Local scripts → core | Local API on 127.0.0.1 only (remote opt-in), bearer tokens (full / agent-scoped), Host-header checks against DNS rebinding |
| Device ↔ control plane | HTTPS/WSS; device bearer token issued at enrollment and stored hashed on the server and in the device vault; idempotent, expiring commands; privileged commands need an admin role |
| Admin → control plane | scrypt passwords, TOTP MFA, short revocable sessions, scoped API keys, RBAC, tenant isolation, rate-limited auth endpoints, full audit |

## Policy defaults

Out of the box (`packages/shared/src/policy.ts`):

* Reads and network requests run; writes, command execution and sensitive actions ask a human.
* Files are reachable only under the user's home folder and the FBRX workspace; SSH/GPG keys, cloud credentials,
  `*.pem`/`*.key` files and the macOS/Windows credential stores are always denied; the FBRX data folder itself is never reachable.
* Private networks (RFC 1918, link-local, loopback, metadata endpoints) are blocked, including after DNS
  resolution, so the agent cannot be used to probe the LAN or cloud metadata services.
* Destructive shell patterns (`rm -rf /`, `mkfs`, `dd of=/dev/…`, fork bombs, `format C:`, `diskpart`,
  `curl … | sh`) are blocked outright.
* Limits: 12 model steps and 40 tool calls per run, 60 tool calls per minute, approvals time out after 5 minutes.

Administrators can tighten or relax all of this per tenant, group or device from the console and lock settings
so users cannot change them. `mode: audit` lets you trial a stricter policy and see what it would block first.

## Credentials

* Vault secrets are AES-256-GCM encrypted under a data key protected by the OS keychain (macOS Keychain / Windows
  DPAPI) and optionally a recovery passphrase (scrypt). See [ARCHITECTURE.md](ARCHITECTURE.md#vault-credentials).
* The model never sees secret values. Connectors and plugins reference secrets by name; the redactor removes any
  secret value from tool output, logs and the conversation.
* Organisation credentials are created in the console, encrypted at rest with the control plane's master key,
  delivered over the authenticated device channel and stored as read-only managed secrets.
* Snapshots contain the vault key encrypted under the snapshot passphrase — protect snapshot files and passphrases
  like the credentials they contain.

## Audit and tamper evidence

Every tool decision, approval, configuration change, vault access, plugin event, backup and remote command is
written to a hash-chained audit log on the device; the chain head travels with each heartbeat, so tampering is
visible centrally. The control plane keeps its own hash-chained log of every admin action. Audit entries can be
streamed to a SIEM via webhook connectors (device) and webhooks (control plane).

## Licensing integrity

Licences are Ed25519-signed by your control plane's private key; the public key is compiled into your desktop
builds. A customer running their own control plane cannot mint licences your builds accept.

## Supply chain and updates

* Desktop builds are code-signed (and notarised on macOS) in CI; Windows updates are only applied when signed by the
  publisher named in `electron-builder.yml`.
* Update feeds are served per device by your control plane over authenticated HTTPS; files carry SHA-512 checksums
  verified by electron-updater.
* Plugin packages pushed from the console are verified against their SHA-256 before installation.
* The local runtime downloads llama.cpp from the official `ggml-org/llama.cpp` GitHub releases and models with
  SHA-256 verification where the catalog lists a checksum.

## Operational recommendations

1. Enable MFA for every console user; use API keys with the narrowest role for automation.
2. Keep `FBRX_CP_MASTER_KEY`, `FBRX_CP_JWT_SECRET` and `FBRX_LICENSE_PRIVATE_KEY` in a secrets manager and back up
   the control plane data directory.
3. Push `FBRX_BACKUP_PASSPHRASE` as a tenant credential and enable scheduled backups.
4. Set a recovery passphrase on every workstation (or rely on organisation snapshots).
5. Start new policies in `audit` mode, review **Alerts & events**, then switch to `enforce`.
6. Restrict cloud AI providers by policy where data residency requires it; the local runtime keeps everything on
   the device.

## Reporting a vulnerability

Send details to your security contact (set this before distributing builds) rather than opening a public issue.
