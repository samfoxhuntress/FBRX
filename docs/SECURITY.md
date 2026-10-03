# Security model

FBRX OS gives an AI agent real abilities on a workstation — files, shell, network, other applications — so the
design assumes the model can be wrong or manipulated and puts every action behind controls the organization owns.

## Trust boundaries

| Boundary | Control |
| --- | --- |
| Model → workstation | Every tool call passes the [governance pipeline](ARCHITECTURE.md#governance-pipeline): license, schema validation, rate limit, policy (hard constraints → rules → risk defaults), guardian, human approval, redaction, audit |
| Untrusted content → model | Tool output (files, web pages, API responses) is scanned for prompt-injection language and handed to the model explicitly marked as untrusted data; any tool call whose input carries such language, or any other guardian warning, requires human approval with the finding shown |
| Plugin → workstation | Separate process, Node permission model (files, processes, addons), network and process-control modules removed, all capabilities brokered and permission-checked ([details](PLUGINS.md#sandbox)) |
| Renderer → core | Sandboxed, context-isolated renderer with a strict CSP; only the `window.fbrx` bridge, which routes through the same API and origin checks as everything else |
| Local scripts → core | Local API on 127.0.0.1 only (remote opt-in), bearer tokens (full / agent-scoped), Host-header checks against DNS rebinding |
| Device ↔ control plane | HTTPS/WSS; device bearer token issued at enrollment and stored hashed on the server and in the device vault; idempotent, expiring commands; privileged commands need an admin role |
| Admin → control plane | scrypt passwords, TOTP MFA, short revocable sessions, scoped API keys, RBAC, tenant isolation, rate-limited auth endpoints, full audit |
| Paired devices → workstation | Mesh off by default; one-time pairing codes proven with HMAC over both public keys; every request sealed with NaCl box, timestamped and replay-checked; per-device permissions and instant revocation ([details](MESH.md)) |
| Other AI apps → workstation | MCP bridge over the Local API with the agent-scoped token, so calls get the same policy, guardian, approvals and audit as Fabrix; the token is read from the data folder, never copied into other apps' configuration |
| FBRX → network devices (device consoles) | Opened only by the person at the workstation; SSH host keys pinned on first use and a changed key refused until confirmed; saved passwords kept in the vault as internal secrets (not readable by plugins, the Local API or the agent); the agent can type into a console the person opened only through `device_console.send`, an execute-risk tool that asks for approval by default; connections audited |
| FBRX → Windows administrator rights | Only for actions the person starts at the workstation (never the Local API, the agent's read tools or mesh peers); scripts go to the elevated PowerShell as an encoded command, not a file, and Windows shows the UAC prompt every time |

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
* New chats start **offline**: the first network tool in a chat asks the person to put that chat online.
* Methods that change the computer (terminal, file writes, ending processes, Defender, firewall, repairs, Hyper-V,
  network adapters, mesh pairing, connecting AI apps) are reserved for the person at the workstation. Automation
  through the Local API can only read files inside the folders the policy allows.
* The link checker follows redirects itself without running page code and refuses to follow a link into a private
  network address, so a malicious link cannot use it to reach your router or other local devices.

Administrators can tighten or relax all of this per tenant, group or device from the console and lock settings
so users cannot change them. `mode: audit` lets you trial a stricter policy and see what it would block first.

## Credentials

* Vault secrets are AES-256-GCM encrypted under a data key that is protected on this computer (Windows DPAPI; the
  Linux secret service; on macOS a key file only the user can read, see below) and optionally by a recovery
  passphrase (scrypt). See [ARCHITECTURE.md](ARCHITECTURE.md#vault-credentials).
* **macOS does not use the Keychain.** Electron's safeStorage keeps its key in the login Keychain, and macOS asks for
  the Mac password whenever an updated, re-signed app opens that item, which for an app that is not notarized is
  every update. Since 1.8.1 FBRX keeps the vault key in `keychain.key` (mode 0600) in the data folder and starts
  Chromium with its mock keychain, so nothing asks for a password. A key that 1.8.0 or earlier left in the Keychain
  is read once, only when the person presses **Bring them over** (`vault.importMoved`, reserved for the person at
  the computer): FBRX asks the `security` tool for the "FBRX OS Safe Storage" item (macOS may ask for the Mac
  password then), decrypts the old wrapping itself (Chromium's OSCrypt format) and re-protects the key with the
  key file. **Start over** (`vault.reset`) deletes every credential and restarts.
* **Ask for the password at every start** (`vault.passwordOnStart`): the data key is then kept only under the
  vault passphrase and the computer-bound copy is deleted, so the vault stays locked after every start until the
  passphrase is entered (FBRX asks when it opens). Services that need credentials wait for the unlock instead of
  failing.
* The model never sees secret values. Connectors and plugins reference secrets by name; the redactor removes any
  secret value from tool output, logs and the conversation.
* Organization credentials are created in the console, encrypted at rest with the control plane's master key,
  delivered over the authenticated device channel and stored as read-only managed secrets.
* Snapshots contain the vault key encrypted under the snapshot passphrase — protect snapshot files and passphrases
  like the credentials they contain.

## Emergency stop and the FBRX/1 console

* The **emergency stop** (`ai.hardStop`) may be pressed from anywhere, including by an AI app over the Local API, so
  that anything can pull the brake. It cancels agent runs, denies pending approvals, stops the local model and is
  recorded in the audit log. While it is on, the agent, `aicoord.consult` and tool calls from any origin other than
  the person at the computer are refused. **Resuming** (`ai.resume`) is reserved for the person at the computer.
* **FBRX/1** (`cli.exec`, `cli.complete`) is reserved for the person at the computer. It calls the same core methods
  as the app (so policy, locks, validation and audit all apply) and validates configuration commits against the
  settings schema and the organization's locked paths before applying them.
* The Silly Goose's pointer grab on Windows runs a small PowerShell helper (started with the goose, ended when it
  leaves) that only moves the mouse pointer to coordinates sent by the goose's own window, for at most about three
  seconds per grab. It is never started when Fun extras are off.

## Copy & migrate

* `migrate.plan`, `migrate.start` and `migrate.cancel` are reserved for the person at the computer. Robocopy and rsync
  run from argument lists without a shell; folder paths with quotes or line breaks are refused.
* Guard rails: no mirroring onto a drive root, a system folder or a home folder; no copying a folder into itself; no
  moving a whole drive or a home folder away. Mirror and move ask for confirmation in the app, and Preview runs the
  same command in list-only mode. Every start and finish is in the audit log.

## Code lab, clipboard and side-panel AI

* **Code lab files** live in the `codelab` folder of the data directory; names are limited to simple file names with
  a known code extension (no paths), 512 KB each. Every `codelab.*` method is reserved for the person at the
  computer.
* **JavaScript** runs in a hidden, throwaway browser window on its own in-memory session: every network request is
  cancelled, WebRTC is limited to a proxy that doesn't exist, there is no Node.js, no preload bridge, no permissions,
  no downloads, no navigation and no pop-ups, and the page is `about:blank`. The window is destroyed when the program
  ends or after ten seconds (an endless loop is cut off). Output is capped.
* **PowerShell and batch** files never run on the computer itself: *Run in Sandbox* starts Windows Sandbox with
  networking off, the code folder mapped **read-only**, and the file started inside it. Closing the sandbox discards
  everything. Each run is in the audit log. Other languages are not run by FBRX at all.
* **Clipboard history** is off by default (an organization can lock `clipboard.history`). When on, the desktop app
  checks the clipboard once a second and keeps the last 50 text copies **in memory only**: never written to disk,
  never synced or backed up, cleared when FBRX quits or the switch is turned off. Copies marked by password managers
  (`ExcludeClipboardContentFromMonitorProcessing`, `CanIncludeInClipboardHistory`, `org.nspasteboard.ConcealedType`
  and similar) are skipped. The **Ctrl+Alt+Z** window shows the same in-memory list. Picking a copy puts it on the
  clipboard and, with *Paste right away* on, presses Ctrl+V once in the app that had the focus: on Windows through a
  small hidden PowerShell helper (`SendKeys`) started when the history first opens, on Linux through `xdotool` if
  installed; macOS only copies (pressing keys there would need an accessibility permission). Nothing else is typed.
* **Side-panel answers** (`ai.quick`: the code lab, Event Viewer, Task Manager and *What if?*) use the default model
  with **no tools**, so they can explain but never act. Known vault secrets are masked in the code, log lines or
  process details before they are sent, the emergency stop refuses them, and they are reserved for the person at
  the computer.

## Voice and the agent's thinking

* **Speech to text** runs on the computer with Whisper (transformers.js and ONNX Runtime in WebAssembly, in a Web
  Worker of the app window). The worker is set never to fetch models itself (`allowRemoteModels` off, no browser
  cache): it reads them from FBRX's private `fbrx-voice:` scheme, which serves only the ONNX Runtime files bundled
  with the app and the files of an installed speech model, with path traversal refused. Recordings stay in memory and
  are dropped once written down; nothing is saved or sent anywhere.
* **Speech models** are downloaded only when the person at the computer asks (`voice.install`, `voice.remove` and
  `voice.cancel` are reserved for them; `voice.models` is read-only) and only while internet access is allowed by
  policy. They come from the named Whisper repositories on Hugging Face over HTTPS into the `voice` folder of the data
  directory, are written to `.part` files first and marked complete only when every file arrived.
  `FBRX_VOICE_MODEL_BASE` points downloads at an internal mirror instead.
* **The microphone** is the only device permission the app window may get, and only for audio from FBRX's own page
  (camera, screen capture, geolocation, MIDI and the rest are refused for every page). macOS asks once, with the
  reason shown in the system prompt; the signed app carries the `audio-input` entitlement. The content security
  policy allows WebAssembly compilation (`wasm-unsafe-eval`) and the `fbrx-voice:` scheme, and nothing else new.
* **Spoken replies** use the voices installed on the operating system, or the **natural voices**: the Kokoro-82M
  model (Apache-2.0) and its voice files, downloaded on request from `onnx-community/Kokoro-82M-v1.0-ONNX` like the
  speech models and run in a second worker. Text becomes phonemes with a bundled copy of the CMU Pronouncing
  Dictionary and HeadTTS's letter-to-sound rules (MIT); no GPL phonemizer (eSpeak) is included. A system voice the
  list marks *online* belongs to a speech service that receives the text it reads. See
  [THIRD_PARTY.md](THIRD_PARTY.md).
* The speech workers use several processor threads, which needs `SharedArrayBuffer`: the app enables it with
  Chromium's `SharedArrayBuffer` feature switch. Its windows only show FBRX's own pages (the code lab's JavaScript
  runner is a separate, network-blocked window), so the cross-site timing concern behind cross-origin isolation does
  not arise.
* **Thinking** that a model shares (Claude's summarized thinking, `reasoning_content` from llama.cpp or vLLM,
  OpenRouter's `reasoning`, Ollama's `thinking`, or a leading `<think>` block) is stored with the message and shown
  to the person, but never added to the conversation as text. (Claude's own signed thinking blocks go back to Claude
  unchanged, as its API requires; they never go to another model.) Thinking can be hidden in Settings →
  Agent (`ai.showThinking`). The work budget's step limit is part of the policy (`ai.maxStepsPerRun`), so an
  organization can fix it; the answer length and context sizes are ordinary settings an organization can lock.

## Audit and tamper evidence

Every tool decision, approval, configuration change, vault access, plugin event, backup and remote command is
written to a hash-chained audit log on the device; the chain head travels with each heartbeat, so tampering is
visible centrally. The control plane keeps its own hash-chained log of every admin action. Audit entries can be
streamed to a SIEM via webhook connectors (device) and webhooks (control plane).

## Licensing integrity

Licenses are Ed25519-signed by your control plane's private key; the public key is compiled into your desktop
builds. A customer running their own control plane cannot mint licenses your builds accept.

A license that joins its FBRX Command tenant carries that tenant's address and an enrollment token inside the signed
payload, so treat such keys like enrollment tokens: the token is limited to one use per seat and expires with the
license, and revoking the token in **Deploy & enroll** stops new joins without touching computers already enrolled.
Joining happens only after the key verifies, only once per license, never while the computer already belongs to a
tenant, and a deliberate *Disconnect* is respected.

## Supply chain and updates

* Desktop builds are code-signed (and notarized on macOS) in CI; Windows updates are only applied when signed by the
  publisher named in `electron-builder.yml`.
* Update feeds are served per device by your control plane over authenticated HTTPS; files carry SHA-512 checksums
  verified by electron-updater.
* **New versions offered from the repository.** The desktop app reads `release.json` from the public FBRX repository
  (`raw.githubusercontent.com/samfoxhuntress/FBRX/HEAD/release.json`) a minute and a half after it starts and every
  six hours, only while internet access is allowed and **Check for new versions automatically** is on. A newer
  version raises one alert; nothing is installed unless the person chooses **Update now** (`release.install`,
  reserved for them). That downloads the zip named in the manifest (only from github.com or codeload.github.com),
  checks it holds that version, copies it over the folder FBRX was installed from (recorded by the setup wizard in
  `install-source.json`; `.fbrx-keys`, `.fbrx-setup`, `node_modules` and `.git` are never touched) and opens the
  setup wizard there in its own window, which builds, installs and reopens the app as a manual update would.
  `FBRX_RELEASE_MANIFEST` points the check at another manifest (an internal mirror, or tests).
* Plugin packages pushed from the console are verified against their SHA-256 before installation.
* The local runtime downloads llama.cpp from the official `ggml-org/llama.cpp` GitHub releases and models with
  SHA-256 verification where the catalog lists a checksum.

## Operational recommendations

1. Enable MFA for every console user; use API keys with the narrowest role for automation.
2. Keep `FBRX_CP_MASTER_KEY`, `FBRX_CP_JWT_SECRET` and `FBRX_LICENSE_PRIVATE_KEY` in a secrets manager and back up
   the control plane data directory.
3. Push `FBRX_BACKUP_PASSPHRASE` as a tenant credential and enable scheduled backups.
4. Set a recovery passphrase on every workstation (or rely on organization snapshots).
5. Start new policies in `audit` mode, review **Alerts & events**, then switch to `enforce`.
6. Restrict cloud AI providers by policy where data residency requires it; the local runtime keeps everything on
   the device.

## Reporting a vulnerability

Send details to your security contact (set this before distributing builds) rather than opening a public issue.
