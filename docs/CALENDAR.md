# Calendar

**Studio → Calendar** puts your Outlook / Microsoft 365 calendars and any calendar link side by side, as an agenda or a
week. FBRX reminds you before meetings, today's meetings run along the top of FBRX Glass, and Fabrix can tell you
what is on, find a free hour and (with your approval) add an event. It is in every edition, including student and
child computers (a school timetable link, for example).

## Two ways to add a calendar

| | Outlook / Microsoft 365 | Calendar link |
| --- | --- | --- |
| What it is | Sign in with a work, school or personal Microsoft account in your browser | An iCalendar (`.ics` / `webcal://`) address from Outlook.com, Google, Apple iCloud, a school or a team site |
| Shows | Every calendar in the account (turn each one on or off) | That one calendar |
| Add and delete events from FBRX | Yes (unless the account is read-only) | No: links are read-only |
| Online meeting links | From Outlook (*Join* buttons) | Found in the event's location, description or link |
| Needs | A Microsoft app (client) ID: built in, set by your organization, or your own (below) | Nothing |

**Where to find a calendar link**

* **Outlook on the web / Outlook.com:** Settings → Calendar → Shared calendars → *Publish a calendar* → pick the
  calendar and "Can view all details" → Publish → copy the **ICS** link.
* **Google Calendar:** Settings → your calendar → Integrate calendar → **Secret address in iCal format**.
* **Apple iCloud:** Calendar → the share button next to a calendar → **Public Calendar** → copy the link.

A link is a credential (anyone with it can read the calendar), so FBRX keeps it in the vault, not in its settings.

## Using it

* **Agenda** lists two weeks from today, grouped by day; **Week** is a time grid with all-day events on top,
  overlapping meetings side by side, tentative ones striped and a line at the current time. Double-click an empty hour
  in Week to add an event there.
* Click an event for where, who organized it, which calendar, how it shows (busy, tentative, free, away), and
  **Join meeting**, **Open in Outlook**, **Delete** (Outlook events you can edit) and **Prepare with Fabrix**.
* **Calendars** (beside the view): show or hide each account and each Outlook calendar, rename and recolor, update
  now, remove. A calendar that cannot be updated says why; when Microsoft ended the sign-in (a new password, access
  removed) it offers **Sign in again**.
* **Calendar settings:** remind me (never, 5, 10, 15 or 30 minutes before), update every 5–60 minutes, and the
  Microsoft sign-in details.
* **FBRX Glass** shows what is left today (with *Join* when a meeting is about to start), the split-flap board
  announces the next one, and *Plan my day* fits your tasks around your meetings.

FBRX keeps the last week and the next two months on the computer. Repeating events are expanded (Outlook does it for
Microsoft accounts; FBRX does it for links, with skipped and moved dates, in the feed's own time zones, including
Outlook's Windows zone names).

## The agent

| Tool | Risk | What it does |
| --- | --- | --- |
| `calendar.agenda` | read | What is on, day by day, optionally filtered by a word |
| `calendar.free_time` | read | Open stretches during working hours (events marked free and all-day events do not block time) |
| `calendar.create_event` | write | Adds an event to an Outlook calendar; never invites anyone. Goes through approvals like any change |

The tools only appear when a calendar is connected. Sign-in tokens and links are never visible to the agent.

## Plugins

A plugin that declares the `calendar` permission can read events with `ctx.calendar.events(from, to)` (at most 62
days at a time): title, start, end, all day, place, how it shows, cancelled and the calendar's name. No meeting links
and no organizers. Each read is in the audit log. See [PLUGINS.md](PLUGINS.md).

## Microsoft sign-in: the app (client) ID

Microsoft only lets an app sign people in when it has an app registration. Pick one:

1. **Built in.** Copies built with `FBRX_MS_CLIENT_ID` set (a repository variable or secret in the release workflow)
   have it already. Nothing to do.
2. **Your organization.** In FBRX Command → Profiles & groups, add to a profile's managed settings, and lock it if you
   like (`calendar.microsoft`):

   ```json
   { "calendar": { "microsoft": { "clientId": "00000000-0000-0000-0000-000000000000", "tenant": "yourschool.org" } } }
   ```

   `tenant` is `common` (work, school and personal accounts), `organizations`, `consumers`, or your tenant ID or
   domain. `"readOnly": true` asks Microsoft for read access only.
3. **Your own.** In the Microsoft Entra admin center (entra.microsoft.com) → Applications → App registrations → New
   registration:
   * Supported accounts: include *personal Microsoft accounts* if you use Outlook.com.
   * Redirect URI: **Public client/native (mobile & desktop)**, `http://localhost`.
   * API permissions → Microsoft Graph → Delegated: `Calendars.ReadWrite` (or `Calendars.Read`), `User.Read`,
     `offline_access`. An organization can grant admin consent once for everyone.
   * Paste the **Application (client) ID** into Calendar → Add calendar (or Calendar settings → Microsoft sign-in).

National clouds set `FBRX_MS_AUTHORITY` (for example `https://login.microsoftonline.us`) and `FBRX_MS_GRAPH`
(`https://graph.microsoft.us/v1.0`).

## How sign-in works (and what FBRX keeps)

* FBRX is a public desktop client: your browser opens Microsoft's own sign-in page (authorization code with PKCE),
  and Microsoft sends you back to a one-time listener on this computer (`http://localhost:<port>`, loopback only,
  closed as soon as it answers or after 10 minutes). FBRX never sees your password.
* FBRX keeps only the refresh token, as an internal vault secret (`fbrx.calendar.<id>`): never listed, never readable
  by the agent, plugins, the Local API or remote commands. Access tokens stay in memory. Microsoft rotates the refresh
  token and FBRX stores the new one.
* While the vault is locked, calendars are not updated (they say so) and new ones cannot be added.
* Calendars need internet access; a policy that blocks it stops them, with a message.
* Adding, changing, removing, signing in, deleting events and reading events through the API are reserved for the
  person at the computer; `calendar.status` (accounts and settings, no events) is open to the Local API.
* Removing a calendar deletes its events from FBRX and forgets the token or link; nothing changes in the calendar
  itself.
