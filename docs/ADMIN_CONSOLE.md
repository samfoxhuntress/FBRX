# FBRX Command (admin console)

FBRX Command is the team tenant controller: the console served by the control plane at its public URL. It is the place
to watch, configure, update and support every FBRX Endpoint computer in real time, with RMM-style tooling (remote
commands, packages, credentials, updates, backups and audit). A license issued here can enroll computers by itself:
paste the key into FBRX Endpoint Basic and it joins the tenant (see [LICENSING.md](LICENSING.md#joining-fbrx-command)). Development: `npm run dev:console` (proxies the API on :8787).

To run it on a computer of your own (a family, a school, a small office), double-click **Install FBRX Command** in
the FBRX folder; it opens the first-run page when it is done. Hosted setups: [DEPLOYMENT.md](DEPLOYMENT.md#2-control-plane).

## Work, School or Home

Every tenant has a **kind**, picked before anything else, both at first-run setup and in **Tenants → New tenant**:

| Kind | For | Computers | Quick setup makes | Help goes to |
| --- | --- | --- | --- | --- |
| **Work** | A business, nonprofit or team | Staff on FBRX Endpoint Basic, IT on Endpoint Ultra | **Staff** (held to Basic) and **IT** | The IT computer you mark as a receiver |
| **School** | A school or co-op | Teachers on Basic in classroom mode, IT on Ultra, students on **FBRX OS Education** | **Teachers**, **IT** and **Students** | The IT computer you mark as a receiver |
| **Home** | A family | Parents on FBRX Endpoint, children on **FBRX OS Home** | **Parents** and **Children** | Every parent's computer, automatically |

The kind sets the wording in FBRX Command and on the computers, the groups **quick setup** makes (each with its own
enrollment token, shown once with a provisioning file to download), who a computer can be used by, and the defaults
for learner computers. One FBRX Command can run tenants of every kind side by side; the tenant switcher shows each
one's kind. Change a tenant's kind later under **Profiles & groups → Organization defaults** or **Tenants**; issuing a
license with a kind also sets it. Unattended installs can pick the first tenant's kind with `FBRX_CP_ORGANIZATION_KIND`
(`work`, `school` or `home`; see DEPLOYMENT.md). Families: see [HOME.md](HOME.md). Schools: [EDUCATION.md](EDUCATION.md).

## Pages

| Section | Page | What it is for |
| --- | --- | --- |
| Fleet | **Overview** | Online/offline/alerting devices, agent runs, tool calls, policy denials and errors over 24 h, version and platform mix, recent alerts |
| | **Devices** | Search and filter the fleet (student and child computers and help desk receivers are marked); select devices for bulk commands (sync, update, back up, restart service, notify, …); **Update everyone now** |
| | Device detail | Live health and services, metrics charts, installed plugins, versions, audit chain head; run any command and watch its result; move to a group; set update channel or pin; who uses it (staff or student; parent or child at home); whether it receives help desk tickets; per-device overrides; its backups; retire |
| | **Alerts & events** | Service failures, circuit breaks, policy denials, student and child safety alerts and other device events; acknowledge them |
| | **Help desk** | Every ticket sent from the organization's computers, its conversation and the computer's details; answer, take, change status and priority; which computers receive tickets |
| Configuration | **Profiles & groups** | Organization defaults: the kind (Work, School, Home), *New versions* (install automatically, tell people, off), the help desk on or off, default profile and channel. **Quick setup** for the tenant's kind (Set up for work, for a school, for a family) until its groups exist. Profiles hold managed settings, governance policy and *locks* (paths users cannot change). Groups attach a profile, who uses the computers (staff or student; parent or child), the edition (hold to Basic), *New versions*, an update channel and a pinned version |
| | **Deploy & enroll** | The address computers join at (and, for FBRX Command with its own certificate, the fingerprint they check); download the latest installers; create enrollment tokens (group, who uses the computers, usage limit, expiry, template snapshot); download the matching `fbrx-provision.json`, a **Mac profile** (.mobileconfig for Jamf, Mosyle, Kandji, Intune…) and a **Windows script** (Intune Win32 app) |
| | **Credentials** | Organization secrets scoped to the tenant, a group or a single device; pushed into device vaults as read-only managed secrets; rotate or delete centrally |
| | **Plugins** | Upload plugin packages (manifest and permissions shown), deploy to devices or groups |
| | **Backups** | Snapshots uploaded by devices; download, mark as an enrollment template, delete |
| Platform | **Releases** | Upload installers (or let CI do it), publish to `stable`/`beta`/`dev`, staged rollout percentage |
| | **Licenses** | Issue and revoke signed licenses per tenant: the product (Endpoint Basic or Ultra), the kind (Work, School or Home, which also sets the tenant's kind), seats and expiry, and whether computers that activate the key join the tenant automatically; copy keys for offline activation |
| | **Tenants** | (superadmin) Create tenants (pick Work, School or Home first, then run its quick setup), see each one's kind, change it, suspend them |
| Access | **Users & API keys** | Invite users with a role, reset access, create API keys for automation |
| | **Webhooks** | Signed outgoing webhooks for fleet events |
| | **Audit log** | Every admin action and device enrollment, hash-chained and verifiable |
| | Account (your name, top right) | Change your password (signs out your other sessions) and enable TOTP MFA |

### Building a profile without JSON

A profile (and a single device's overrides) is built from:

* **Ready-made** bundles, one click each and one click to take out again: **No Fun Extras** (no easter eggs, jokes,
  goose or start-up sound), **Private by default** (AI on the computer, chats start offline, no usage statistics or
  clipboard history), **Locked down** (no mesh, no Local API, no sharing AI), **Strong protection**, **Daily backups**,
  **Meeting-room safe**, **Calm and quick** and **Share AI across computers**. They combine; the profiles table shows
  which ones each profile carries.
* **The usual settings**, by area (AI, fun and look, privacy, screens and meetings, mesh, backups, protection,
  updates, everyday), each with an **(i)** saying what it does: *Not set / On / Off* for switches, a list for choices,
  and **Lock** so people cannot change it on their computer. *Find a setting* searches names and explanations.
* **Advanced: everything as text**: the same profile as JSON (any FBRX OS setting) and the locked paths, one per line,
  for settings the switches do not cover. Both views are the same profile.

**Antivirus:** device detail shows each computer's antivirus and its state (the Health column flags *Antivirus at
risk* and *Antivirus needs attention*). To choose it for a group, put `{ "protection": { "provider": "shield" } }` (or
`defender`, `product:sophos`, `auto`…) in a profile's settings and lock `protection.provider`. See [SHIELD.md](SHIELD.md).

**Calendars for everyone:** to let computers sign in to Outlook / Microsoft 365 calendars, put your Microsoft app
(client) ID in a profile's settings, `{ "calendar": { "microsoft": { "clientId": "…", "tenant": "yourdomain" } } }`, and
lock `calendar.microsoft` if people should not change it. See [CALENDAR.md](CALENDAR.md).

Changes to profiles, groups, credentials and licenses are pushed to online devices over their WebSocket within
seconds; offline devices pick them up when they reconnect. Device detail and the overview update live.

### Help desk routing

A computer sends a ticket to FBRX Command over its authenticated device connection; FBRX Command stores it, numbers it
(#1, #2, … per organization), and pushes it at once to every **receiver** computer and to open consoles. Replies and
status changes travel the same way back to the computer that asked. Receivers that are off get the queue when they
next connect. The `ticket.created` and `ticket.updated` webhooks hand tickets to another system if you have one.

### Automatic updates

*New versions* (organization or group): **Install automatically** sets each computer's update settings so it installs
new versions by itself when nobody is using it, from FBRX Command's published releases (electron-updater) or from the
GitHub repository it was installed from; **Tell people** offers them; **Off** stops the checks. **Devices → Update
everyone now** sends `update.install` to every active computer (online ones start at once).

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
| Read help desk tickets | ✔ | ✔ | ✔ | ✔ | ✔ |
| Answer help desk tickets | ✔ | ✔ | ✔ | ✔ | |
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
