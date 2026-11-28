# FBRX Command (admin console)

FBRX Command is the team tenant controller: the console served by the control plane at its public URL. It is the place
to watch, configure, update and support every FBRX Endpoint computer in real time, with RMM-style tooling (remote
commands, packages, credentials, updates, backups and audit). A license issued here can enroll computers by itself:
paste the key into FBRX Endpoint and it joins the tenant (see [LICENSING.md](LICENSING.md#joining-fbrx-command)).

To run it on a computer of your own (a family, a school, a small office), double-click **Install FBRX Command** in
the FBRX folder; it opens the first-run page when it is done. It looks for new versions of itself and shows them on
**Releases**, where **Update now** installs one in place
([DEPLOYMENT.md](DEPLOYMENT.md#fbrx-command-on-a-computer-of-your-own)). Hosted setups:
[DEPLOYMENT.md](DEPLOYMENT.md#2-control-plane).

## Work, School or Home

Every tenant has a **kind**, picked before anything else, both at first-run setup and in **Tenants → New tenant**:

| Kind | For | Computers | Quick setup makes | Help goes to |
| --- | --- | --- | --- | --- |
| **Work** | A business, nonprofit or team | Staff up to FBRX Endpoint Pro, IT up to Endpoint Ultra | **Staff** (up to Pro) and **IT** | The IT computer you mark as a receiver |
| **School** | A school or co-op | Teachers up to Pro in classroom mode, IT up to Ultra, students on **FBRX OS Education** | **Teachers**, **IT** and **Students** | The IT computer you mark as a receiver |
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
| | **Devices** | Search and filter the fleet (student and child computers and help desk receivers are marked); select devices for bulk commands (sync, update, back up, restart service, notify, …); **Update everyone now**. A device's **Configuration** tab sets who uses it, whether it receives help desk tickets, its **Edition** (*Essentials only*, *Up to Pro*, *Up to Ultra*, or its group's: Ultra only ever comes from here) and its overrides; its header shows the edition it runs |
| | Device detail | Live health and services, metrics charts, installed plugins, versions, audit chain head; run any command and watch its result; move to a group; set update channel or pin; who uses it (staff or student; parent or child at home); whether it receives help desk tickets; per-device overrides; its backups; retire |
| | **Alerts** | What is going wrong across the organization now, and recently: each problem from its alert to its all-clear, who heard it and who acknowledged it; who gets what ([below](#alerts)) |
| | **Device events** | Everything devices report as it happens: service failures, circuit breaks, policy denials, student and child safety alerts and other events; acknowledge them |
| | **Help desk** | Every ticket sent from the organization's computers, its conversation and the computer's details; answer, take, change status and priority; which computers receive tickets |
| | **Messages** | The *Everyone* conversation every computer sees in Messages: post to it, remove what does not belong ([MESSAGES.md](MESSAGES.md)) |
| Configuration | **Profiles & groups** | Organization defaults: the kind (Work, School, Home), *New versions* (install automatically, tell people, off), the help desk on or off, Messages on or off, default profile and channel. **Quick setup** for the tenant's kind (Set up for work, for a school, for a family) until its groups exist. Profiles hold managed settings, governance policy and *locks* (paths users cannot change). Groups attach a profile, who uses the computers (staff or student; parent or child), the edition (*Essentials only*, *Up to Pro* or *Up to Ultra*: computers open in Essentials and their people switch up to it), *New versions*, an update channel and a pinned version. **FBRX Mesh**: the organization's computers mesh together without pairing codes, and the **hive** (which groups may use the AI of servers with the ai role), with the servers in it ([MESH.md](MESH.md#organizations)) |
| | **Governance** | What the AI may do on the organization's computers: each profile's policy (tool rules, the folders it may use, the web, the shell, AI providers, approvals) as JSON, checked before it is saved and pushed within seconds. Computers show it read-only |
| | **Deploy & enroll** | The address computers join at (and, for FBRX Command with its own certificate, the fingerprint they check); download the latest installers (the newest stable release uploaded under Releases, or the current FBRX OS from FBRX's downloads when nothing as new was uploaded); create enrollment tokens (group, who uses the computers, usage limit, expiry, template snapshot); download the matching `fbrx-provision.json`, a **Mac profile** (.mobileconfig for Jamf, Mosyle, Kandji, Intune…) and a **Windows script** (Intune Win32 app) |
| | **Credentials** | Organization secrets scoped to the tenant, a group or a single device; pushed into device vaults as read-only managed secrets; rotate or delete centrally |
| | **Plugins** | Upload plugin packages (manifest and permissions shown), deploy to devices or groups |
| | **Backups** | Snapshots uploaded by devices; download, mark as an enrollment template, delete |
| Platform | **Releases** | FBRX Command's own version and new versions of it (**Update now**, **Skip this version**, automatic checks on or off); upload FBRX OS installers (or let CI do it), publish to `stable`/`beta`/`dev`, staged rollout percentage |
| | **Licenses** | Issue and revoke signed licenses per tenant: the most the computers may run (up to Endpoint Pro or Ultra), the kind (Work, School or Home, which also sets the tenant's kind), seats and expiry, and whether computers that activate the key join the tenant automatically; copy keys for offline activation |
| | **Tenants** | (superadmin) Create tenants (pick Work, School or Home first, then run its quick setup), see each one's kind, change it, suspend them |
| | **FBRX accounts** | (superadmin) Everyone with an FBRX account here, the edition their purchases give them and their organizations; give one an edition (support, a promotion), disable one ([ACCOUNTS.md](ACCOUNTS.md)) |
| | **Cloud AI** | (superadmin) FBRX Cloud AI: the month so far against the service's budget, each edition's tokens a month, every account's use (its own limit, extra tokens, the limit lifted for the month, turned off) and promo codes ([CLOUD_AI.md](CLOUD_AI.md)) |
| | **Pricing** | (superadmin) The price list ([LICENSING.md](LICENSING.md#prices)): Pro and Ultra on their own; the organization fee, with another for larger organizations from a size and for Home ones; each person's price in an organization (it also covers a shared computer nobody pays for), how many computers each edition includes and each further one's price; the volume discount in steps (from so many seats, so much off); what a year costs paying yearly, in months' price; example bills, a month and a year, before saving. **Stripe** shows, for every lookup key, whether Stripe charges the same, and **Update Stripe** brings it in step. The MDM add-on: on sale or not, its price per managed computer (the same whatever the computer's edition), and what it earns after card fees and the cost of a managed computer. Organizations' bills follow at once (**Billing**); organizations turn MDM on per group (**Profiles & groups → Device management**). Every change is in the audit log |
| Access | **Users & API keys** | Invite users with a role, reset access, create API keys for automation |
| | **Webhooks** | Signed outgoing webhooks for fleet events |
| | **Audit log** | Every admin action and device enrollment, hash-chained and verifiable |
| | Account (your name, top right) | Change your password (signs out your other sessions) and enable TOTP MFA |

### Building a profile without JSON

A profile (and a single device's overrides) is built from:

* **Ready-made** bundles, one click each and one click to take out again: **No Fun Extras** (no easter eggs, jokes,
  Bruce the Goose or start-up sound), **Private by default** (AI on the computer, chats start offline, no usage statistics or
  clipboard history), **Locked down** (no mesh, no Local API, no sharing AI), **No chatting** (Messages off),
  **Strong protection**, **Daily backups**,
  **Meeting-room safe**, **Calm and quick** and **Share AI across computers**. They combine; the profiles table shows
  which ones each profile carries.
* **The usual settings**, by area (AI, fun and look, privacy, screens and meetings, messages, mesh, backups, protection,
  updates, everyday), each with an **(i)** saying what it does: *Not set / On / Off* for switches, a list for choices,
  and **Lock** so people cannot change it on their computer. *Find a setting* searches names and explanations.
  **Allow the Terminal** (protection) turns off the Terminal for the people at the computers (PowerShell or the
  command prompt, FBRX/1 and device consoles), whatever their edition: lock it so nobody turns it back on. What the
  agent may run is the policy's (Governance), not this.
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

## Alerts

**Alerts** keeps every alert in the organization in one place: from its computers (FBRX OS and FBRX Digger), its FBRX
Servers (their drives, FBRX Gate, MiniDome and FBRX Time) and FBRX Command itself (a service that stopped on a
computer). Each problem is one line from its alert to its **all-clear**; the same problem said again is folded into
it (*said 3 times*), and a thing that happened once (a threat found) is a line of its own. **Going on now** lists the
problems still open, the worst first; **Recently** what is over. Operators and up can **Acknowledge** one, which says
someone is on it.

**Report** on an alert opens its **incident report**: what happened to it, in order (when it started and where, each
person and computer told and when, quiet hours that held it, the escalation, who acknowledged it and their note, the
steps the server that sent it reported, such as a takeover's, and its all-clear), with how long it lasted and how soon
someone took it. **Copy** puts it on the clipboard as text and **Download** saves it as a Markdown file, for a ticket
or a post-mortem. Every alert FBRX Command sends on (by e-mail, to FBRX OS and to your webhooks) carries the link to its
report, which opens after signing in. Reports are kept as long as their alerts (90 days after they are over).

**Who gets what** (owners and administrators) is a list of rules. Every alert shows on the Alerts page; a rule also
tells people:

| Part of a rule | What it does |
| --- | --- |
| **Takes** | Everything, warnings and critical, or critical only |
| **About computers tagged** / **From** | Only alerts about computers with these tags, and only from these apps (empty: all) |
| **E-mail** | Each alert, then its all-clear, through FBRX Command's mail server |
| **Shows in FBRX OS on computers tagged** | A notification on those computers (and, with the switch, on the help desk computers), and a line in their Alerts inbox with **Acknowledge**. A computer that is off gets the alerts still open when it is next online |
| **Quiet hours** | Between these times (in the time zone you set) nothing goes out but critical alerts; what was held goes out when the hours are over, if it is still going on |
| **Nobody acknowledged it within** | After these minutes, the next people hear it too (*Then also e-mail*, *And computers tagged*), marked *Not acknowledged* |

Acknowledging, in the console or on a computer, stops the escalation and marks it on every computer that shows it.
The all-clear reaches whoever heard the alert. **Send a test alert** sends one through the saved rules. The webhooks
(Settings) get `alert.opened`, `alert.resolved`, `alert.acknowledged` and `alert.escalated` with the FBRX Alert.

**From FBRX Servers**: *Make a secret* shows the address and a signing secret once. In each FBRX Server's console,
**Alerts → Webhook**, paste both and choose which alerts to send ([SERVER.md](SERVER.md#alerts)); FBRX Command takes
only alerts signed with that secret.

**High availability: third vote** (on the same page) makes FBRX Command the third vote of a pair of FBRX Servers
([SERVER.md](SERVER.md#high-availability)), so the two never both serve. Name the pair and **Make a third-vote key**:
the address, the certificate and the key are shown once. On the pair's active server, **High availability → Third
vote**, paste them. Each key is for one pair; the list says when each pair last asked and whether a server holds it
now, and removing a key ends it (the pair then has no third vote). A pair of gates must reach FBRX Command without
going through the gate, and a pair cannot be its own third vote: run FBRX Command on another server in your network.

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
| Read the organization's *Everyone* messages | ✔ | ✔ | ✔ | ✔ | ✔ |
| Post to *Everyone* and remove messages | ✔ | ✔ | ✔ | ✔ | |
| Remote screen, once switched on for the person in *Users* (a ticket number; the person at the computer says yes) | ✔ | ✔ | ✔ | ✔ | |
| Watch and delete remote screen recordings; turn recording on | ✔ | ✔ | ✔ | | |
| Read licenses | ✔ | ✔ | ✔ | | |
| Tenants, releases, issuing licenses | ✔ | | | | |

## Remote screen

**Remote screen** on a computer's page (online computers) sees its screen and, if the person there allows it, uses its
mouse and keyboard, for support. It needs an operator role or above **and** the switch *Remote screen* on the
administrator in **Users** (an owner or administrator turns it on, person by person). Each session asks for a
**ticket number** and a reason, which the person at the computer sees in the question: *Allow control*, *View only* or
*No* (no answer within a minute is a no). While it lasts a red bar with **Stop** stays on their screen. Only the
administrator who started a session can use it, and closing the window ends it.

FBRX Command's audit log keeps who asked, the computer, the ticket, the reason and how long it lasted; the computer's
own audit log keeps whether the mouse and keyboard were used. Pictures and keystrokes go through FBRX Command over the
computer's encrypted connection, only while the window is open. What each system needs is the same as for your own
computers ([MESH.md](MESH.md#remote-screen-seeing-and-using-your-other-computers)).

### Recordings

An organization can keep recordings of its remote screen sessions: **Profiles & groups → Remote screen recordings**
(owners and administrators; off until turned on), and **Keep recordings for** 7, 30 or 90 days or a year, after which
they are deleted. A recording is what the administrator saw, a picture a second, and the moments the mouse and
keyboard were used; what was typed is never kept. The person at the computer is told in the question, before they
answer, that the organization records the session, and the red bar says *(recorded)*. A session they said no to leaves
no recording. If FBRX Command cannot start a recording the organization keeps, the session does not start.

**Screen recordings** (under Access) lists them with the computer, the administrator, the ticket and the reason, how
long it lasted and whether the mouse and keyboard were used. **Watch** plays one: play and pause, a timeline with a
mark wherever the mouse or keyboard was used, and 1× to 8× speed. Owners and administrators watch and delete them;
operators, who run sessions, do not. Watching one and deleting one are both in the audit log. A recording stops at
512 MB or four hours (the session goes on), and the recordings are files in FBRX Command's data folder (under
`recordings`), included when you back that folder up.

### Remote desktop on Linux servers

A Linux computer reports whether its remote desktop (xrdp) is on. When it is, **Remote desktop** on its page (for
those with Remote screen switched on) downloads a connection file for your remote desktop (RDP) app, with the
computer's local address; you sign in there with an account on the computer. On a Linux server where FBRX runs as
root, **Set up remote desktop** (owners and administrators) installs and starts it without anyone at the server, the
same way Settings → Remote desktop does on the computer ([MESH.md](MESH.md#remote-desktop-on-linux-computers-and-servers)),
and *Send command → xrdp.set* turns it off again. Where FBRX does not run as root, the person at the computer sets it
up, since the system's administrator prompt would appear on their screen. The address is the computer's local one,
so connect from the same network or over a VPN to it.

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
