# Selling FBRX: products, tenants, editions and licenses

FBRX is built to be resold. You (the vendor) run **FBRX Command** (the control plane and its console) as
**superadmin**; each customer is a **tenant** with its own devices, users, configuration, credentials, plugins,
backups, webhooks and audit trail. What a customer's computers may do is decided by a license you sign.

## Products: FBRX Endpoint Basic and Ultra

The desktop app is **FBRX Endpoint**, in two products:

* **FBRX Endpoint Basic** — what runs without a license key: the everyday tools and the AI agent (local models, or
  the user's own cloud AI key), with a plain light or dark look.
* **FBRX Endpoint Ultra** — what a license turns on: expert tool sets (Terminal, FBRX/1, virtual lab, disks and
  partitions, Defender settings, adapters, device consoles, developer tools, the Local API), Mesh and AI coordination,
  connections, tools and plugins, governance, the theme studio with its gradients and textures, and the easter eggs
  (which still need their secret key).

Which one a license runs is its **tier**: Community runs Basic, Pro and Enterprise run Ultra, and a license can name
its tier outright (`tier: "basic"` or `"ultra"`), so a tenant decides what its users get. The tier and the features
below are separate: features gate services in the runtime, the tier decides the product the user sees.

**School and Home licenses.** A license can also say what kind of tenant it is for: `vertical: "education"` (School)
or `"home"` (Home); without it, it is a Work license. Issued from FBRX Command (*Kind of license*) or with
`npm run license:issue -- … --vertical education` (or `home`), it also sets the tenant's kind, which you otherwise pick
when the tenant is created. A School tenant starts staff computers in classroom mode, groups can hold teachers to
Basic, and student computers run **FBRX OS Education**, whatever the tier (see [EDUCATION.md](EDUCATION.md)). A Home
tenant runs children's computers as **FBRX OS Home** (see [HOME.md](HOME.md)). A standalone computer that activates an Education key starts in classroom mode too.

**FBRX Command** is the team tenant controller (fleet management with RMM-style tooling: configuration and policy,
remote commands, credentials, packages, updates, backups, audit). A license issued there can carry the tenant's
address: when a computer running Endpoint Basic activates that key it **joins the tenant by itself** and receives the
product and settings the tenant chose for it (see *Joining FBRX Command* below).

## Editions

| Feature | Community | Pro | Enterprise |
| --- | :-: | :-: | :-: |
| Built-in local AI agent (`agent.local`) | ✔ | ✔ | ✔ |
| REST / webhook / peer connectors (`connectors`) | ✔ | ✔ | ✔ |
| Local automation API (`localapi`) | ✔ | ✔ | ✔ |
| Cloud AI providers — Claude, OpenAI-compatible, with your own key (`agent.cloud`) | ✔ | ✔ | ✔ |
| Third-party plugins (`plugins`) | | ✔ | ✔ |
| MCP connectors (`connectors.mcp`) | | ✔ | ✔ |
| Scheduled encrypted backups (`backup.scheduled`) | | ✔ | ✔ |
| Fleet management via the control plane (`fleet`) | | | ✔ |
| Model-assisted guardian review (`guardian.model`) | | | ✔ |
| **Product (tier) unless the license names one** | Basic | Ultra | Ultra |

Editions and feature names live in `packages/shared/src/license.ts`; a license can also grant individual extra
features on top of its edition (for example Pro + `fleet`). Workstations without a license run as Community
(Endpoint Basic). Development builds (`npm run dev:desktop`, `--dev`) unlock everything and run as Ultra; set
`FBRX_EDITION=basic` to try Basic in one.

## License keys

A key is `FBRX1.<payload>.<signature>`: a JSON payload (license id, tenant, customer, edition, seats, extra
features, issue date, optional expiry, optional maximum major version, optional tier, optional FBRX Command tenant)
signed with Ed25519. Older apps ignore the optional fields they do not know.

* **Signing** happens only on your control plane, with `FBRX_LICENSE_PRIVATE_KEY` (see
  [DEPLOYMENT.md](DEPLOYMENT.md#1-license-signing-keys)).
* **Verification** happens offline on each workstation against the public key embedded at build time — no
  phone-home needed, and nobody else can mint keys your builds accept.
* **Expiry** — after `expiresAt` the workstation falls back to Community features and Endpoint Basic (data is never
  locked away).
* **Version cap** — `maxMajorVersion: 2` means the key works for 1.x and 2.x; 3.x needs a renewed key. Useful
  for selling major upgrades.
* **Seats** — enforced by the control plane at enrollment: when the tenant's active devices reach the seat count,
  further enrollments are refused until a device is retired or the license is upgraded. `0` = unlimited.
* **Fleet** — a tenant whose active license lacks `fleet` (Community, or Pro without the add-on) cannot enroll new
  devices; its keys are meant for offline activation. Tenants with no license at all may enroll devices, which then
  run Community features — handy for trials and internal use.

## Issuing and delivering licenses

1. **Tenants → New tenant** for the customer (name, contact, default update channel).
2. Switch to the tenant, open **Licenses → Issue license**: the product on the computers (by edition, Endpoint Ultra
   or Endpoint Basic), whether computers that activate the key join this tenant automatically (on by default),
   edition, seats, expiry, version cap, extra features.
3. Delivery:
   * **Managed (recommended)** — workstations enrolled in that tenant receive the license automatically with their
     configuration. Revoking it in the console removes it from every device on its next sync.
   * **Offline** — copy the key from the console and paste it in the desktop app under
     **Settings → License** (for customers who do not connect to a control plane). Offline keys cannot be revoked
     remotely; use expiry dates.
   * **File drop** — save the key as `fbrx-license.key` in the app's data folder
     (`~/Library/Application Support/FBRX OS` or `%APPDATA%\FBRX OS`) with your deployment tool; FBRX OS activates
     it on its next start and deletes the file (a key that fails verification is kept as `fbrx-license.key.rejected`).
     The setup wizard licenses your own laptop this way.

Without a control plane, sign keys from the command line with the same private key:

```bash
npm run license:issue -- --customer "Acme Ltd" --edition pro --seats 10 --expires 2027-12-31 --feature connectors.mcp
# Endpoint Basic on an Enterprise license, joining a tenant on activation:
npm run license:issue -- --customer "Acme Ltd" --edition enterprise --tier basic \
  --command-url https://command.acme.example --enroll-token fbrx_enr_…
```

A managed license takes precedence over an offline one; if it is revoked, a device falls back to its offline key,
if any, and otherwise to Community. License changes take effect immediately (licensed services start or stop
without a restart).

## Joining FBRX Command

With **Computers that activate this key join this tenant automatically** ticked, FBRX Command makes an enrollment
token for the license (one use per seat, expiring with the license), signs the tenant's address and that token into
the key, and adds `fleet` to its features. On a computer:

1. Someone pastes the key into **Settings → License → Upgrade to Endpoint Ultra** (or drops it in as
   `fbrx-license.key`).
2. The key is verified offline; the product (Basic or Ultra) switches at once.
3. If the computer is not in a tenant yet, it enrolls itself with the token and from then on receives the tenant's
   license, settings, policy and credentials like any enrolled device. The License page shows the FBRX Command
   address, and the activation message says which organization it joined.

It joins once per license: if the vault is locked it waits until it is unlocked, if the server cannot be reached it
tries again at the next start, and if someone later leaves the tenant on purpose (Organization → Disconnect) the key does
not join again by itself. The tenant then decides the product per license (Basic or Ultra).

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
