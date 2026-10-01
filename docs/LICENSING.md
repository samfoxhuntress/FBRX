# Selling FBRX OS: tenants, editions and licenses

FBRX OS is built to be resold. You (the vendor) run a control plane as **superadmin**; each customer is a
**tenant** with its own devices, users, configuration, credentials, plugins, backups, webhooks and audit trail.
What a customer's workstations may do is decided by a license you sign.

## Editions

| Feature | Community | Pro | Enterprise |
| --- | :-: | :-: | :-: |
| Built-in local AI agent (`agent.local`) | ✔ | ✔ | ✔ |
| REST / webhook / peer connectors (`connectors`) | ✔ | ✔ | ✔ |
| Local automation API (`localapi`) | ✔ | ✔ | ✔ |
| Cloud AI providers — Claude, OpenAI-compatible (`agent.cloud`) | | ✔ | ✔ |
| Third-party plugins (`plugins`) | | ✔ | ✔ |
| MCP connectors (`connectors.mcp`) | | ✔ | ✔ |
| Scheduled encrypted backups (`backup.scheduled`) | | ✔ | ✔ |
| Fleet management via the control plane (`fleet`) | | | ✔ |
| Model-assisted guardian review (`guardian.model`) | | | ✔ |

Editions and feature names live in `packages/shared/src/license.ts`; a license can also grant individual extra
features on top of its edition (for example Pro + `fleet`). Workstations without a license run as Community.
Development builds (`npm run dev:desktop`, `--dev`) unlock everything.

## License keys

A key is `FBRX1.<payload>.<signature>`: a JSON payload (license id, tenant, customer, edition, seats, extra
features, issue date, optional expiry, optional maximum major version) signed with Ed25519.

* **Signing** happens only on your control plane, with `FBRX_LICENSE_PRIVATE_KEY` (see
  [DEPLOYMENT.md](DEPLOYMENT.md#1-license-signing-keys)).
* **Verification** happens offline on each workstation against the public key embedded at build time — no
  phone-home needed, and nobody else can mint keys your builds accept.
* **Expiry** — after `expiresAt` the workstation falls back to Community features (data is never locked away).
* **Version cap** — `maxMajorVersion: 2` means the key works for 1.x and 2.x; 3.x needs a renewed key. Useful
  for selling major upgrades.
* **Seats** — enforced by the control plane at enrollment: when the tenant's active devices reach the seat count,
  further enrollments are refused until a device is retired or the license is upgraded. `0` = unlimited.
* **Fleet** — a tenant whose active license lacks `fleet` (Community, or Pro without the add-on) cannot enroll new
  devices; its keys are meant for offline activation. Tenants with no license at all may enroll devices, which then
  run Community features — handy for trials and internal use.

## Issuing and delivering licenses

1. **Tenants → New tenant** for the customer (name, contact, default update channel).
2. Switch to the tenant, open **Licenses → Issue license**: edition, seats, expiry, version cap, extra features.
3. Delivery:
   * **Managed (recommended)** — workstations enrolled in that tenant receive the license automatically with their
     configuration. Revoking it in the console removes it from every device on its next sync.
   * **Offline** — copy the key from the console and paste it in the desktop app under
     **Settings → License** (for customers who do not connect to a control plane). Offline keys cannot be revoked
     remotely; use expiry dates.

A managed license takes precedence over an offline one; if it is revoked, a device falls back to its offline key,
if any, and otherwise to Community. License changes take effect immediately (licensed services start or stop
without a restart).

## Ways to sell

| Model | How |
| --- | --- |
| **Hosted (SaaS-style)** | You run one control plane; each customer is a tenant; customer admins get `owner`/`admin` users and manage their own fleet. You publish releases once for everyone. |
| **Customer-hosted** | Ship the control-plane image to the customer. Issue their licenses from *your* control plane (so the key stays with you) and deliver them offline or by importing into theirs. |
| **Standalone desktop** | Sell installers plus an offline key per customer or seat pack; no control plane needed on their side. |
| **White-label builds** | Change `productName`/`appId` in `apps/desktop/electron-builder.yml` and the `build/` icons, bake a provisioning file into `resources/provisioning/`, and ship a customer-specific installer that enrolls itself into the right tenant. |

## Webhooks for billing

The control plane emits `license.issued`, `device.enrolled` and `device.retired` webhooks (HMAC-signed), so a
billing or CRM system can track seats and renewals.
