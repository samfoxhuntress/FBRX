# Releasing FBRX

Building, signing and publishing FBRX OS, FBRX Digger and FBRX Server. FBRX OS is downloaded from the FBRX website
only, never from an app store ([STORES.md](STORES.md)).

## Going to production

1. **Keys**: `npm run keys:generate`. Commit `apps/desktop/build/license-public-key.pem`; give the private key to FBRX
   Command as `FBRX_LICENSE_PRIVATE_KEY` (or let FBRX Command make one and export its public half with `--from`).
2. **FBRX Command**: `docker compose -f deploy/control-plane/docker-compose.yml up -d` on a host with a DNS name;
   Caddy gets the HTTPS certificate. Sign in, turn on MFA, make a tenant per customer ([CLOUD.md](CLOUD.md) for the
   account server everyone signs in to).
3. **Installers**: the Release workflow builds, signs, notarizes and publishes them (below; its secrets are listed in
   `.github/workflows/release.yml`).
4. **Computers**: in FBRX Command, an enrollment token and `fbrx-provision.json` shipped with the installer
   ([DEPLOYMENT.md](../docs/DEPLOYMENT.md)).

## Releasing a version

1. Set the version in `apps/desktop/package.json` and in `release.json` (with its summary and notes), and point
   `release.json`'s `download` at the tag's source zip, `https://github.com/samfoxhuntress/FBRX/archive/refs/tags/v<version>.zip`,
   and `page` at `https://github.com/samfoxhuntress/FBRX/releases/tag/v<version>`. When FBRX Server changed, raise its
   version in `apps/virtual/package.json` and set `release.json`'s `server` entry: `version`, `summary`, `notes` and
   `bundle` (`https://github.com/samfoxhuntress/FBRX/releases/download/v<version>/fbrx-server-<server version>.tar.gz`).
   Its checksum is published next to the bundle (`.sha256`), so `sha256` can stay out; servers find the update with
   `sudo fbrx-server update check` (see [SERVER.md](../docs/SERVER.md#updating-fbrx-server)).
2. Merge into `main` (the default branch: installed copies read `release.json` from it).
3. Tag that commit `v<version>` and push the tag, or run the **Release** workflow on `main` (Actions → Release →
   Run workflow) with *channel* `stable` and *Also publish a GitHub release* ticked, which creates the tag itself. It
   builds the Mac, Windows and Linux installers, the FBRX Server ISO and bundle and the FBRX Command image, and publishes them
   as a GitHub release named after the version (a version with a `-` in it, such as `2.0.0-beta.1`, or the beta or
   dev channel, is published as a pre-release).

Installed copies see the new `release.json` within six hours and offer the update; Update now downloads the tag's zip
(checked to hold that version) and runs the installer in the folder FBRX was installed from.

## Local packaging

```bash
npm run runtime:fetch -- --platform darwin --arch arm64,x64     # optional: bundle llama.cpp
npm run package:mac                                              # → apps/desktop/release/<version>/
npm run runtime:fetch -- --platform win32 --arch x64,arm64
npm run package:win
npm run runtime:fetch -- --platform linux --arch x64
npm run package:linux
```

macOS packages must be built on a Mac, Windows packages are most reliably built on Windows, and Linux packages on
Linux (the Release workflow does all three). Without a Developer ID certificate, Mac builds are ad-hoc signed: they run on the Mac that built
them, but other Macs will refuse them until you sign and notarize. Artifacts:

* macOS: `FBRX-OS-<v>-arm64.dmg`, `FBRX-OS-<v>-x64.dmg` (installers) and matching `.zip` files (auto-update).
* Windows: `FBRX-OS-Setup-<v>.exe` — one NSIS installer containing x64 and arm64; per-user by default, per-machine
  with elevation.
* Linux (x64): `FBRX-OS-<v>-x86_64.AppImage` (runs on any distribution: make it executable and open it; it updates
  itself) and `FBRX-OS-<v>-amd64.deb` (Debian and Ubuntu: `sudo apt install ./FBRX-OS-<v>-amd64.deb`). Linux
  packages are not code-signed; `latest-linux.yml` carries their checksums for updates.

If the runtime is not bundled, users can install it from **Local AI → Install runtime**, and onboarding offers it.

## Signing: becoming a verified publisher

Windows and macOS warn about apps from publishers they cannot identify. Each has its own process. Both are
wired into the Release workflow; add the secrets below and the next tagged build is signed.

### Windows: "Unknown publisher" and SmartScreen

Windows shows the publisher's name (instead of *Unknown publisher*) when the installer and app carry an
Authenticode signature from a certificate authority Microsoft trusts. Two ways to get one:

**Azure Trusted Signing (recommended; Microsoft's own signing service, newer Azure pages may call it Artifact
Signing).** No hardware token, about the price of a coffee a month on the Basic plan, and it signs straight from CI.

1. In the Azure portal, create a **Trusted Signing account** in a region near you. Note its endpoint, e.g.
   `https://eus.codesigning.azure.net/` for East US.
2. Under the account, request **Identity validation → Public**. Microsoft verifies the organization (legal name,
   address, registration or tax number) or, where offered, an individual developer. Allow a few days.
3. Once approved, create a **certificate profile** of type *Public Trust* tied to that identity.
4. In **Microsoft Entra ID → App registrations**, register an app (e.g. "FBRX signing"), create a **client secret**,
   then on the Trusted Signing account grant that app the **Trusted Signing Certificate Profile Signer** role.
5. Add GitHub secrets: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SIGNING_ENDPOINT`,
   `AZURE_SIGNING_ACCOUNT` (account name), `AZURE_CERT_PROFILE` (profile name) and `WIN_PUBLISHER_NAME`: the subject
   name exactly as it appears on the certificate (the validated legal name).

**A code-signing certificate from a CA** (DigiCert, Sectigo, SSL.com and others). Since 2023 new certificates
come on a hardware token or a cloud key vault, not a plain `.pfx`, so CI signing needs the CA's cloud signing service.
If you do have a `.pfx`, set `WIN_CSC_LINK` (base64) and `WIN_CSC_KEY_PASSWORD`, plus `WIN_PUBLISHER_NAME`.

**SmartScreen reputation.** Even a signed installer can show *Windows protected your PC* while the certificate is
new: SmartScreen trusts publishers as their downloads build a clean history, which takes a few weeks and some installs.
Installers pushed by Intune or another device manager are not downloaded through a browser, so they skip the prompt
entirely (see *Installing with a device manager* below).

**Updates and the publisher name.** A signed copy of FBRX only installs updates signed by the same publisher as
itself; an unsigned copy (built from source, or installed before you signed) accepts the first signed update. Keep the
same publisher name when you renew or change certificates.

### macOS: Gatekeeper ("cannot be opened because the developer cannot be verified")

1. Join the **Apple Developer Program** ($99 a year). An organization account needs a D-U-N-S number (free from
   Dun & Bradstreet); an individual account uses your own name as the publisher.
2. In **Certificates, Identifiers & Profiles**, create a **Developer ID Application** certificate (Keychain Access →
   Certificate Assistant → Request a Certificate from a Certificate Authority makes the CSR). Install it, export it
   with its private key as a `.p12`, and add `MAC_CSC_LINK` (`base64 -i cert.p12`) and `MAC_CSC_KEY_PASSWORD`.
3. Create an **app-specific password** for your Apple Account and add `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
   `APPLE_TEAM_ID` (Membership details). With these, the workflow notarizes the app and staples the ticket, so it
   opens offline too.
4. Check a build with `spctl -a -vvv -t install "/Applications/FBRX OS.app"`: it should say
   `source=Notarized Developer ID`.

| Platform | Secrets | What the workflow does |
| --- | --- | --- |
| macOS | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | signs with your Developer ID, hardened runtime, notarizes (`-c.mac.notarize=true`) |
| Windows (Azure) | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_CERT_PROFILE`, `WIN_PUBLISHER_NAME` | signs the app and installer with Trusted Signing (`win.azureSignOptions`) |
| Windows (.pfx) | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`, `WIN_PUBLISHER_NAME` | signs with signtool |

Without these, builds are unsigned (Mac builds are ad-hoc signed so they run on the Mac that built them). Copies
built with the *Install FBRX OS* script on the computer that runs them are not flagged, because nothing was
downloaded; it is installers you send to other people that need signing.

## Release workflow

`.github/workflows/release.yml` runs on tags `v*.*.*` (pre-release tags such as `v1.3.0-beta.1` target the beta
channel) or manually:

1. Sets the app version from the tag.
2. Downloads llama.cpp for each target architecture.
3. Builds, signs and notarizes macOS (arm64 + x64) and Windows (x64 + arm64) packages.
4. Builds and pushes the control-plane image to GHCR.
5. Attaches the installers to a GitHub release.
6. If `FBRX_CP_URL` and `FBRX_CP_API_KEY` (a **superadmin** API key) are set, uploads them to your control plane
   as a release on the chosen channel — as a draft unless `publish` is ticked.

Manual equivalent: `FBRX_CP_URL=… FBRX_CP_API_KEY=… npm run release:publish -- --channel stable --publish`.
