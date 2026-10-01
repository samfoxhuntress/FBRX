# Admin console

The admin console is served by the control plane at its public URL. It is the place to watch, configure, update and
support every FBRX OS workstation in real time. Development: `npm run dev:console` (proxies the API on :8787).

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
| | **Licenses** | Issue and revoke signed licenses per tenant; copy keys for offline activation |
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
| Read licenses | ✔ | ✔ | ✔ | | |
| Tenants, releases, issuing licenses | ✔ | | | | |

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
