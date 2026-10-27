# Calendar

**Studio → Calendar** is your **FBRX calendar**, kept on this computer, with shared calendars beside it as add-ons
(Outlook / Microsoft 365, and calendar links from Google, Apple, a school or a team). See it as an agenda, a week or a
month. FBRX reminds you before events, today's events run along the top of Dash, and Fabrix can tell you what is on,
find a free hour and (with your approval) add an event. It is in every edition, including student and child computers
(a school timetable link, for example).

## The FBRX calendar

It is always there and needs no account: **New event** (or double-click an hour in Week, a day in Month) adds one.

* **Repeats:** every day, every weekday, every week, every month (a month without that day, like the 31st, is
  skipped) or every year, until a day or for good. Editing or deleting a repeating event changes all of it.
* **About:** an event can be about a **project**, a **note**, a **task** or an **automation**. *Open project* (or note,
  task, automation) in the event jumps to it.
* **Color coding:** an event takes the color of what it is about, so a project's work reads at a glance:
  1. a color you pick for the event itself;
  2. else its **project's** color (the project it is about, or the project its note or task is in);
  3. else the color of what it is: **automations** violet, **notes** amber, **tasks** teal, and what **Fabrix** added
     in honey;
  4. else the calendar's color.

  **Colors** beside the calendar says what each color on screen stands for.
* **What FBRX knows of your days** is on it too, each a calendar you can hide under *Calendars*: open **tasks** by their
  due date, active **projects** by their deadline, and when your **automations** run (every run of a daily one; the
  next run of one that repeats every few minutes or hours). These show as free time: they never block a meeting or
  bring a reminder.
* Events are kept on this computer (and in its backups); hide the whole calendar with its switch.

## Shared calendars (add-ons)

Two kinds, under *Calendars → Add a shared calendar*:

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
  overlapping meetings side by side, tentative ones striped and a line at the current time; **Month** shows six weeks
  with each day's first events (your automations' runs last), and a day's number opens its week. Double-click an empty
  hour in Week, or a day in Month, to add an event there.
* Click an event for what it is about, how it repeats, where, who organized it, which calendar, how it shows (busy,
  tentative, free, away), and **Edit** (FBRX events), **Open project** (or note, task, automation), **Join meeting**,
  **Open in Outlook**, **Delete** (FBRX events, and Outlook events you can edit) and **Prepare with Fabrix**.
* **Calendars** (beside the view): show or hide the FBRX calendar and each of its four (your events, tasks due,
  project deadlines, automations), each shared account and each Outlook calendar; rename and recolor; update now;
  remove a shared one. A calendar that cannot be updated says why; when Microsoft ended the sign-in (a new password,
  access removed) it offers **Sign in again**.
* **Calendar settings:** remind me (never, 5, 10, 15 or 30 minutes before), update every 5–60 minutes, and the
  Microsoft sign-in details.
* **Dash** shows what is left today (with *Join* when a meeting is about to start), the split-flap board
  announces the next one, and *Plan my day* fits your tasks around your meetings.

FBRX keeps the last week and the next two months on the computer. Repeating events are expanded (Outlook does it for
Microsoft accounts; FBRX does it for links, with skipped and moved dates, in the feed's own time zones, including
Outlook's Windows zone names).

## The agent

| Tool | Risk | What it does |
| --- | --- | --- |
| `calendar.agenda` | read | What is on, day by day, optionally filtered by a word |
| `calendar.free_time` | read | Open stretches during working hours (events marked free and all-day events do not block time) |
| `calendar.create_event` | write | Adds an event to the FBRX calendar (or an Outlook calendar the person names); it can repeat and be about a project, whose color it takes. Never invites anyone. Goes through approvals like any change |

What Fabrix adds is marked as Fabrix's (honey, unless it is about a project). The tools are there unless every calendar
is hidden. Sign-in tokens and links are never visible to the agent.

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
