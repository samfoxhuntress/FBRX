# FBRX at a school

FBRX Command with an **Education license** runs a school's computers: staff on **FBRX Endpoint** (Basic for teachers,
Ultra for IT), students on **FBRX OS Education**, a help desk from every classroom to IT, and updates that install
themselves. This guide walks through setting one up, using a K-12 co-op as the example: teachers on MacBooks, a
network on UniFi, staff accounts in Google Workspace.

## What each computer gets

| | Teachers and staff | IT | Students |
| --- | --- | --- | --- |
| Runs | FBRX Endpoint **Basic** | FBRX Endpoint **Ultra** | **FBRX OS Education** |
| Agent | Fabrix with every tool, asking before it changes anything | Fabrix with every tool, plus the network | A learning helper that only talks: no files, apps, websites or commands |
| Pages | The everyday ones (see COMMAND_CENTER.md) | Everything, including Network Center → Environments (UniFi), Task Manager, Terminal | Home, the helper, Get help, Tasks, Notes, Toolbox, Library, Settings |
| Classroom defaults | Presenter-safe mode turns on with a projector, chats start offline, no jokes | Same, changeable | Same, and the fun extras, mesh and local API locked off |
| Help desk | Sends tickets | Receives everyone's tickets | Sends tickets ("Get help") |

The defaults come first; your own profiles in FBRX Command can change them for staff. Student computers keep their
locks.

## 1. Make the tenant a school

No FBRX Command yet? On a computer at the school that stays on, double-click **`Install FBRX Command`** in the FBRX
folder (computers on the school network join it over HTTPS with its own certificate), or host it with Docker and a
domain name (DEPLOYMENT.md).

Pick **School** when FBRX Command asks what it will run: on the first-run setup page, or in **Tenants → New tenant**
for each further school. An existing tenant changes kind under **Profiles & groups → Organization defaults → Kind**.

Then **Licenses → Issue license** with *School (Education)* as the kind of license (the edition decides Ultra; groups
can hold computers to Basic). Issuing a license with a kind also sets the tenant's kind. From the command line:
`npm run license:issue -- … --vertical education`.

## 2. Groups and tokens in one click

**Profiles & groups → Set up for a school** (or the step right after **New tenant**) creates three groups, each with
an enrollment token and a provisioning file to download:

* **Teachers**: staff, held to Endpoint Basic.
* **IT**: staff, Endpoint Ultra (what the license gives).
* **Students**: student computers, FBRX OS Education.

Copy the tokens when they are shown. Any group can be edited later: *Used by* (staff or student), *Edition* (Basic or
what the license gives) and *New versions* (see below).

## 3. Put FBRX on the computers

* **Macs with a device manager** (Jamf, Mosyle, Kandji, Intune, or any manager linked to Apple School Manager):
  **Deploy & enroll → New enrollment token** (pick the group), then **Mac profile** downloads a configuration profile.
  Upload it to the device manager with the FBRX installer; FBRX reads it from `/Library/Managed Preferences` and joins
  on its next start. Google's own Mac management may not accept custom profiles in every edition; if yours does not,
  use one of the next two ways.
* **Windows with Intune**: **Windows script** downloads `Install-FBRX.ps1`. Package it with `FBRX-OS-Setup-<version>.exe`
  as a Win32 app (install command and detection rule are at the top of the script); it installs for all users and
  joins.
* **No device manager**: put `fbrx-provision.json` next to the installer, or install FBRX and paste the address and
  token on its **Organization** page. Tick **This computer is for a student or a child** on student laptops: a computer can always
  make itself a student computer when it joins, but only IT (in FBRX Command) can make a student computer a staff one.

Installers from a published release are signed and notarized (DEPLOYMENT.md → Signing); installers pushed by a device
manager also skip the browser download warnings.

## 4. Staff sign-in to FBRX Command

Staff who manage FBRX (IT, the office) sign in to FBRX Command with their Google Workspace or Microsoft 365 accounts:
**Users & API keys → Sign in with Google or Microsoft** (ADMIN_CONSOLE.md). Teachers don't need an FBRX Command account;
their computers belong to the organization.

## 5. The help desk

Mark the IT computer as a receiver: **Devices → the IT computer → Configuration → Receives help desk tickets**. Every
computer in the school then has a Help desk tab (Get help on student computers). Tickets reach the IT computer within
a second, with a short summary of the sending computer, and replies go straight back. FBRX Command's **Help desk** page
shows every ticket and lets admins answer too. Turn the help desk off under Organization defaults if you use another
ticket system (webhooks `ticket.created` and `ticket.updated` can feed it).

## 6. Updates

**Organization defaults → New versions**:

* **Install automatically**: computers install new versions by themselves when nobody is using them (never while
  someone is presenting or the agent is busy), from FBRX Command's published releases or from the GitHub repository
  they were installed from.
* **Tell people** (default): they are told and choose when.
* **Off**: no checks; IT updates with **Devices → Update everyone now**.

**Update everyone now** works whatever the setting: every online computer installs the newest version right away;
offline ones do it when they reconnect.

## 7. The network (IT, Ultra)

On the IT computer, **Network Center → Environments → Attach a UniFi console** shows every gateway, switch, access
point and client, lets you restart a device, and makes guest Wi-Fi codes for visitors and events (COMMAND_CENTER.md).

## Students and safety

* The learning helper on FBRX OS Education keeps answers short, kind and age-appropriate, teaches rather than doing
  graded work for the student, never asks for personal details, and has no tools at all: it cannot open files, apps or
  websites, and FBRX refuses any tool call it attempts.
* If a student writes that they might hurt themselves or that someone is hurting them, the helper answers with care and
  points to a teacher, the counselor or another trusted adult, 911 in an emergency, and **988** (call or text, the
  Suicide & Crisis Lifeline) or the Childhelp hotline. FBRX Command gets a **Student safety** alert naming the computer
  and the kind of concern, so a caring adult can check in. **The student's message is not sent**; it stays on that
  computer.
* Conversations stay on the student's computer. FBRX Command sees health, version and ticket information, not chats or
  files.
* Student computers start with presenter-safe mode on a projector, chats offline first, and easter eggs, the mesh and the
  local API locked off. Choose which AI model they use in a profile for the Students group (a local model keeps
  everything on the computer).

Schools have their own duties under student privacy law (FERPA and state student data privacy rules); review the
settings above with whoever is responsible for them before rolling FBRX out to students.

## Families

The same design runs a family: pick **Home** instead of School, and children's computers run **FBRX OS Home** with
the learning helper and the same protections. See [HOME.md](HOME.md).
