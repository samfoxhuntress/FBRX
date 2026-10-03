# FBRX Command (admin console)

FBRX Command is the team tenant controller: the console served by the control plane at its public URL. It is the place
to watch, configure, update and support every FBRX Endpoint computer in real time, with RMM-style tooling (remote
commands, packages, credentials, updates, backups and audit). A license issued here can enroll computers by itself:
paste the key into FBRX Endpoint Basic and it joins the tenant (see [LICENSING.md](LICENSING.md#joining-fbrx-command)). Development: `npm run dev:console` (proxies the API on :8787).

## Pages

| Section | Page | What it is for |
| --- | --- | --- |
| Fleet | **Overview** | Online/offline/alerting devices, agent runs, tool calls, policy denials and errors over 24 h, version and platform mix, recent alerts |
| | **Devices** | Search and filter the fleet; select devices for bulk commands (sync, update, back up, restart service, notify, …) |
| | Device detail | Live health and services, metrics charts, installed plugins, versions, audit chain head; run any command and watch its result; move to a group; set update channel or pin; per-device overrides; its backups; retire |
| | **Alerts & events** | Service failures, circuit breaks, policy denials and other device events; acknowledge them |
| Configuration | **Profiles & groups** | Profiles hold managed settings, governance policy and *locks* (paths users cannot change). Groups attach a profile, an update channel and a pinned version to a set of devices; the tenant default profile applies to everyone |
| | **Deploy & enroll** | Download the latest installers; create enrollment tokens (group, usage limit, expiry, template snapshot) and the matching `fbrx-provision.json` |
| | **Credentials** | Organization secrets scoped to the tenant, a group or a single device; pushed into device vaults as read-only managed secrets; rotate or delete centrally |
| | **Plugins** | Upload plugin packages (manifest and permissions shown), deploy to devices or groups |
| | **Backups** | Snapshots uploaded by devices; download, mark as an enrollment template, delete |
| Platform | **Releases** | Upload installers (or let CI do it), publish to `stable`/`beta`/`dev`, staged rollout percentage |
| | **Licenses** | Issue and revoke signed licenses per tenant: the product (Endpoint Basic or Ultra), seats and expiry, and whether computers that activate the key join the tenant automatically; copy keys for offline activation |
| | **Tenants** | (superadmin) Create customers/business units, suspend them, set their default channel |
| Access | **Users & API keys** | Invite users with a role, reset access, create API keys for automation |
| | **Webhooks** | Signed outgoing webhooks for fleet events |
| | **Audit log** | Every admin action and device enrollment, hash-chained and verifiable |
| | Account (your name, top right) | Change your password (signs out your other sessions) and enable TOTP MFA |

Changes to profiles, groups, credentials and licenses are pushed to online devices over their WebSocket within
seconds; offline devices pick them up when they reconnect. Device detail and the overview update live.

## Roles

| Permission | superadmin | owner | admin | operator | viewer |
| --- | :-: | :-: | :-: | :-: | :-: |
| See devices, events, plugins, releases | ✔ | ✔ | ✔ | ✔ | ✔ |
| Send standard commands (ping, sync, update check, diagnostics, notify, service restart) | ✔ | ✔ | ✔ | ✔ | |
| Manage devices (groups, channel, pin, retire) | ✔ | ✔ | ✔ | ✔ | |
| Privileged commands (agent run, plugin install/uninstall, update install, back up, lock vault, restart app) | ✔ | ✔ | ✔ | | |
| Profiles, policy, credentials, enrollment, plugins, backups, webhooks, audit | ✔ | ✔ | ✔ | | |
| Users and API keys | ✔ | ✔ | ✔ | | |
| Set up sign in with Google or Microsoft | ✔ | ✔ | | | |
| Read licenses | ✔ | ✔ | ✔ | | |
| Tenants, releases, issuing licenses | ✔ | | | | |

## Sign in with Google or Microsoft

Staff can sign in to FBRX Command with their school or work account instead of a separate password. Each
organization (tenant) adds its own connection under **Users & API keys → Sign in with Google or Microsoft**; only
its owners (and the platform operator) can. The form walks through the provider side and shows the **redirect
address** to paste there: `https://<FBRX Command address>/v1/auth/sso/callback`, so `FBRX_CP_PUBLIC_URL` must be the
real https:// address people use.

**Google Workspace** (about five minutes, with a Workspace admin account)

1. Google Cloud console → pick or create a project → **APIs & Services → OAuth consent screen**: *Internal*, app
   name *FBRX Command*.
2. **Credentials → Create credentials → OAuth client ID → Web application**; add the redirect address under
   *Authorized redirect URIs*.
3. Paste the **Client ID** and **Client secret** into FBRX Command, with your Workspace domain (`school.org`).

**Microsoft 365** (about five minutes, in the Microsoft Entra admin center)

1. **App registrations → New registration**: *FBRX Command*, *Accounts in this organizational directory only*,
   Redirect URI type *Web* with the redirect address.
2. Copy the **Application (client) ID** and the **Directory (tenant) ID**.
3. **Certificates & secrets → New client secret**, copy its **Value** (note the expiry date and renew it in time).
4. Paste them into FBRX Command with your email domain. Optional: *Token configuration → Add optional claim → ID →
   email* (without it, the sign-in name is used).

Then decide:

* **Invite only** (default): add people under *Users* with their email and no password; they use the button.
  Or **let new people in on their first sign-in** with a role you choose (viewer, operator or admin).
* **Require single sign-on**: passwords stop working for everyone in the organization except owners, who keep
  password + two-step codes as the way back in if the provider has a problem.
* **Test sign-in** opens the provider in a new tab to check the setup.

On the sign-in page the **Sign in with Google / Microsoft** buttons appear once any organization has a connection.
If several organizations use the same provider, people type their email first so FBRX Command picks the right one.
A connection only ever signs people into its own organization: someone who belongs to another organization, and the
platform operator, are never signed in through it. Google and Microsoft handle passwords and two-step verification
for these sign-ins.

`superadmin` is the platform operator (you) and is not bound to a tenant — use the tenant switcher in the top bar.
Everyone else belongs to exactly one tenant and only ever sees that tenant's data. Users can only grant roles at or
below their own.

## Automation

Everything in the console is a JSON API under `/v1/admin/*`, authenticated with `Authorization: Bearer <token>`
(a session or an API key, `fbrx_ak_…`). Superadmins select a tenant with the `x-fbrx-tenant` header.

```bash
KEY=fbrx_ak_...
# All devices that are offline
curl -s https://fleet.example.com/v1/admin/devices -H "authorization: Bearer $KEY" | jq '.[] | select(.online == false) | .name'
# Ask every device in a group to back up
curl -s https://fleet.example.com/v1/admin/commands/bulk -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"type":"backup.create","payload":{"upload":true},"groupId":"grp_..."}'
```

Real-time admin events (device status, command results, audit entries) stream over `wss://…/v1/admin/ws`.
