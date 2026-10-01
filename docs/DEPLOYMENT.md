# Deployment

This guide takes you from source to a fleet of signed, auto-updating workstations managed from your own control
plane.

```
keys:generate ─► control plane (Docker) ─► tag v1.x ─► Release workflow ─► installers + update feed
                                                                              │
                     admin console: tenant ─► license ─► enrollment token ─► fbrx-provision.json ─► workstations
```

## 1. License signing keys

```bash
npm run keys:generate
```

* `.fbrx-keys/license-signing.pem` — **private**. Give it only to the control plane (`FBRX_LICENSE_PRIVATE_KEY`)
  and keep an offline backup. It is git-ignored.
* `apps/desktop/build/license-public-key.pem` — public. Commit it (or store it as the `FBRX_LICENSE_PUBLIC_KEY`
  CI secret); `apps/desktop/scripts/build.mjs` embeds it so installs verify licenses offline.

Already running a control plane that generated its own key? Export the public half instead:

```bash
npm run keys:generate -- --from /path/to/control-plane-data/keys/license-signing.pem
```

Builds without an embedded key run as Community edition (development builds unlock everything).

## 2. Control plane

### Docker (recommended)

On a Linux host with ports 80/443 open and a DNS record (e.g. `fleet.example.com`) pointing at it:

```bash
cp deploy/control-plane/.env.example deploy/control-plane/.env    # set FBRX_DOMAIN, admin email/password, keys
docker compose -f deploy/control-plane/docker-compose.yml --env-file deploy/control-plane/.env up -d --build
```

* Caddy terminates TLS with an automatic Let's Encrypt certificate and proxies WebSockets.
* All state is in the `fbrx-data` volume: `control-plane.db`, `keys/`, uploaded releases, snapshots and packages.
* The image is also published by the Release workflow as `ghcr.io/<owner>/<repo>/control-plane:<version>`; set
  `FBRX_IMAGE` in `.env` and drop `--build` to deploy without building.
* Behind your own load balancer instead of Caddy: run only the `control-plane` service, set
  `FBRX_CP_TRUST_PROXY=1` and `FBRX_CP_PUBLIC_URL=https://…`, and allow WebSocket upgrades on `/v1/device/ws` and
  `/v1/admin/ws` with long idle timeouts.

### Without Docker

```bash
npm ci && npm run build -w @fbrx/admin-console && npm run build -w @fbrx/control-plane
cd apps/control-plane/dist && FBRX_CP_DATA_DIR=/var/lib/fbrx FBRX_CP_PUBLIC_URL=https://fleet.example.com node server.mjs
```

`dist/` is self-contained (one bundled `server.mjs` plus the console); copy it anywhere with Node 22.13+.
Run it under systemd, launchd, NSSM or a PaaS.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `FBRX_CP_PUBLIC_URL` | `http://localhost:<port>` | External URL written into provisioning files and update feeds |
| `FBRX_CP_DATA_DIR` | `.fbrx-cp-data` | Database, keys, files |
| `FBRX_CP_PORT` / `FBRX_CP_HOST` | `8787` / `0.0.0.0` | Listener |
| `FBRX_CP_TRUST_PROXY` | off | Honour `X-Forwarded-*` from a reverse proxy |
| `FBRX_CP_ADMIN_EMAIL` / `_PASSWORD` / `_NAME`, `FBRX_CP_ORGANIZATION` | — | Bootstrap the first superadmin and tenant on an empty database |
| `FBRX_CP_SETUP_TOKEN` | random, printed | Without bootstrap variables, the console's first-run screen asks for this token |
| `FBRX_CP_JWT_SECRET`, `FBRX_CP_MASTER_KEY`, `FBRX_LICENSE_PRIVATE_KEY` | generated into `keys/` | Supply from a secrets manager to keep key material out of the volume |
| `FBRX_CP_SESSION_HOURS` | 12 | Admin session lifetime |
| `FBRX_CP_HEARTBEAT_SECONDS` | 30 | Device heartbeat interval |
| `FBRX_CP_SNAPSHOT_RETENTION` | 10 | Snapshots kept per device |
| `FBRX_CP_MAX_UPLOAD_MB` | 4096 | Largest release/snapshot upload |
| `FBRX_CP_LOG_LEVEL` | info | `fatal` … `trace`, or `silent` |

First login: open the console, sign in, **enable MFA** (click your name, top right), then create tenants (one per customer or business
unit), users and API keys. Health endpoint: `GET /healthz`.

## 3. Desktop builds

### Local packaging

```bash
npm run runtime:fetch -- --platform darwin --arch arm64,x64     # optional: bundle llama.cpp
npm run package:mac                                              # → apps/desktop/release/<version>/
npm run runtime:fetch -- --platform win32 --arch x64,arm64
npm run package:win
```

macOS packages must be built on a Mac and Windows packages are most reliably built on Windows (the Release
workflow does both). Without a Developer ID certificate, Mac builds are ad-hoc signed: they run on the Mac that built
them, but other Macs will refuse them until you sign and notarise. Artifacts:

* macOS: `FBRX-OS-<v>-arm64.dmg`, `FBRX-OS-<v>-x64.dmg` (installers) and matching `.zip` files (auto-update).
* Windows: `FBRX-OS-Setup-<v>.exe` — one NSIS installer containing x64 and arm64; per-user by default, per-machine
  with elevation.

If the runtime is not bundled, users can install it from **Local AI → Install runtime**, and onboarding offers it.

### Windows installer: upgrade, repair and uninstall

`FBRX-OS-Setup-<v>.exe` knows when FBRX OS is already installed (customisations in
`apps/desktop/build/installer.nsh`). Instead of asking where to install, it opens on a maintenance page:

| Installed version vs. this Setup | Choices (default first) |
| --- | --- |
| older | **Upgrade** (keeps data, settings, license, paired devices) · Repair · Uninstall |
| same | **Repair** (reinstall the program files, clear Chromium caches; data kept) · Uninstall |
| newer | Downgrade (warns that newer data may not be readable; must be picked explicitly) · Uninstall |

*Uninstall* keeps the data folder (`%APPDATA%\FBRX OS`) unless *Also delete my data* is ticked. Uninstalling from
Windows Settings asks the same question, defaulting to keep. Upgrades and repairs reuse the existing install folder
and mode (just me / all users).

**Closing a running app.** Setup and the uninstaller find every process started from the install folder: the app,
its helpers, the local AI runtime and bridges that other AI apps start (`apps/desktop/build/fbrx-close.ps1`). The app
is asked to quit properly first (`"FBRX OS.exe" --fbrx-quit` reaches the running copy, which stops the AI runtime and
closes its database even when it is minimised to the tray); anything still running after 20 seconds is ended. If
something cannot be ended (for example it runs as administrator), Setup asks the user to quit it and retry. Without
PowerShell, it falls back to `taskkill`.

**Command line** (IT tools, scripts):

| Switch | Effect | Exit code |
| --- | --- | --- |
| `/S` | install, upgrade or reinstall without questions | 0; **3** if a newer version is installed |
| `/S /ALLOWDOWNGRADE` | also allow replacing a newer version | 0 |
| `/S /REPAIR` | reinstall and clear cached files | 0 |
| `/S /UNINSTALL` | uninstall, keep the data | 0 (also when not installed) |
| `/S /UNINSTALL --delete-app-data` | uninstall and delete the data folder | 0 |

**Licenses.** A key saved as `fbrx-license.key` next to `Setup.exe` is copied to the user's data folder and activated
when FBRX OS next starts. The setup wizard's *Make an installer to send* (`Install FBRX OS.cmd --share --for "Name"
--days 30`) builds the key into the installer instead: it re-packages only the installer with
`FBRX_SHARE_LICENSE=<key file>` set, which `installer.nsh` embeds at build time, and writes the result to `Share\`.
Without `--for` it copies the plain installer there (for updates; the recipient's license is kept).

**Unsigned installers** show *Windows protected your PC*; recipients click **More info → Run anyway**. A code-signing
certificate (see Signing) removes the warning.

### Signing

| Platform | What you need | Environment / secrets |
| --- | --- | --- |
| macOS | Apple Developer ID Application certificate (.p12), App Store Connect app-specific password | `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`; notarisation is enabled with `-c.mac.notarize=true` |
| Windows | OV/EV code-signing certificate (.pfx), or Azure Trusted Signing | `CSC_LINK`, `CSC_KEY_PASSWORD`; set `win.signtoolOptions.publisherName` in `electron-builder.yml` to the certificate subject — electron-updater refuses updates signed by a different publisher |

Unsigned builds work for testing, but macOS Gatekeeper and Windows SmartScreen will warn users.

### Release workflow

`.github/workflows/release.yml` runs on tags `v*.*.*` (pre-release tags such as `v1.3.0-beta.1` target the beta
channel) or manually:

1. Sets the app version from the tag.
2. Downloads llama.cpp for each target architecture.
3. Builds, signs and notarises macOS (arm64 + x64) and Windows (x64 + arm64) packages.
4. Builds and pushes the control-plane image to GHCR.
5. Attaches the installers to a GitHub release.
6. If `FBRX_CP_URL` and `FBRX_CP_API_KEY` (a **superadmin** API key) are set, uploads them to your control plane
   as a release on the chosen channel — as a draft unless `publish` is ticked.

Manual equivalent: `FBRX_CP_URL=… FBRX_CP_API_KEY=… npm run release:publish -- --channel stable --publish`.

## 4. Rolling out to workstations

1. **Admin console → Deploy & enroll → New enrollment token.** Optionally choose a group, a usage limit, an expiry and a
   **template snapshot** (a golden machine's backup that every new install starts from).
2. Download **`fbrx-provision.json`** (see `deploy/provisioning/fbrx-provision.example.json`).
3. Distribute the installer with the provisioning file using your tool of choice (Intune, Jamf, Kandji,
   SCCM, a shared drive …). FBRX OS looks for it, in order:
   * `--provision=<path>` on the command line,
   * `FBRX_PROVISION_FILE`,
   * next to the executable,
   * `<app resources>/provisioning/fbrx-provision.json` (bake it into a customer-specific build by placing it in
     `apps/desktop/resources/provisioning/` before packaging),
   * macOS: `/Library/Application Support/FBRX OS/fbrx-provision.json`,
   * Windows: `%ProgramData%\FBRX OS\fbrx-provision.json`,
   * the data folder root.
4. On first launch the device restores the template (if any, as a **clone** — fresh identity), enrolls, pulls its
   managed configuration, license and secrets, and shows up in **Devices**. Users can also enroll by hand in
   **Fleet** with the server URL and token.

Headless machines: `fbrx-headless enroll https://fleet.example.com fbrx_enr_… --name LAB-01`.

## 5. Operating the fleet

* **Profiles** carry managed settings, policy and locks. A device gets its tenant's default profile overlaid by its
  group's profile; secrets resolve tenant → group → device, most specific wins.
* **Credentials** created in the console are encrypted at rest, pushed over the device channel, and stored as managed,
  read-only vault entries; rotating or deleting them updates every device.
* **Updates**: publish a release, choose a channel per tenant, group or device, pin versions where needed, and
  raise the rollout percentage gradually. Enrolled devices check shortly after launch, every 4 hours, and on the `update.check` command;
  `update.install` applies immediately.
* **Commands** run in real time on online devices and queue for offline ones.
* **Webhooks** (`device.enrolled`, `device.offline`, `device.alert`, `command.failed`, `snapshot.uploaded`,
  `license.issued`, `release.published`, …) are HMAC-signed (`x-fbrx-signature: sha256=<hex>` over the raw body)
  for ITSM, SIEM, chat and billing integrations.
