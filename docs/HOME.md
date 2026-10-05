# FBRX at home

FBRX Command can run a family's computers as well as a company's or a school's. Pick **Home** as the kind of tenant
and parents get FBRX Endpoint, children get **FBRX OS Home** (a simpler, safer computer with a learning helper), and
a child's "Get help" goes straight to a parent's computer.

## What each computer gets

| | Parents | Children |
| --- | --- | --- |
| Runs | FBRX Endpoint (Ultra, or Basic if you hold the group to it) | **FBRX OS Home** |
| Agent | Fabrix with every tool, asking before it changes anything | A learning helper that only talks: no files, apps, websites or commands |
| Pages | Everything the license gives | Home, the helper, Get help, Tasks, Notes, Toolbox, Library, Settings |
| Defaults | Yours to choose (profiles in FBRX Command) | Presenter-safe mode with a projector, chats offline first; easter eggs, the mesh and the local API locked off |
| Help | Receives the children's requests for help, automatically | **Get help** asks a parent |

## 1. Set up FBRX Command as a Home

Run FBRX Command (DEPLOYMENT.md; for a family, the Docker setup on a small home server, a NAS or a cloud machine with
a domain is plenty). On the first-run page, pick **Home**, then give the family's name and the parent's account.
Already running FBRX Command for work? **Tenants → New tenant → Home** adds the family next to your other tenants.

Unattended installs: `FBRX_CP_ORGANIZATION_KIND=home` with the other `FBRX_CP_*` bootstrap settings.

## 2. Parents and Children in one click

**Profiles & groups → Set up for a family** (or the step right after **New tenant**) creates two groups, each with an
enrollment token and a provisioning file to download:

* **Parents**: FBRX Endpoint; their computers receive the children's requests for help.
* **Children**: FBRX OS Home with the learning helper.

Copy the tokens when they are shown. **Deploy & enroll** makes more at any time.

## 3. Put FBRX on the computers

Install FBRX on each computer and, on its **Organization** page (or in the first-run setup), paste the FBRX Command
address and the token for its group. Or put the downloaded `fbrx-provision.json` next to the installer before running
it. Using a Parents token on a child's computer? Tick **This computer is for a student or a child** and it becomes a
child's computer. Only FBRX Command can turn a child's computer back into a parent's.

## 4. Getting help

Every computer in the family has a Help desk tab (**Get help** on children's computers). A child's request reaches
every parent's computer within a second, with a short summary of the computer, and the parent's answer goes straight
back. A parent can also answer from FBRX Command's **Help desk** page. To stop a parent's computer receiving requests,
open it under **Devices → Configuration** and turn off *Receives the family's requests for help*.

## Children and safety

* The learning helper on FBRX OS Home keeps answers short, kind and age-appropriate, teaches rather than doing
  homework for the child, never asks for personal details, and has no tools at all: it cannot open files, apps or
  websites, and FBRX refuses any tool call it attempts.
* If a child writes that they might hurt themselves or that someone is hurting them, the helper answers with care and
  tells them to talk to a parent or another adult they trust right away, 911 in an emergency, and **988** (call or
  text, the Suicide & Crisis Lifeline). FBRX Command gets a **Child safety** alert naming the computer and the kind of
  concern, so a parent can check in. **The child's message is not sent**; it stays on that computer.
* Conversations stay on the child's computer. FBRX Command sees health, version and help requests, not chats or files.
* Choose which AI model the children's computers use in a profile for the Children group (a local model keeps
  everything on the computer).

FBRX is a helper, not a babysitter: keep talking with your children about what they do online, and use your
operating system's own family settings (screen time, app limits, content filters) alongside it.
