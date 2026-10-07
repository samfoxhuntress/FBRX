# The FBRX lineup

**FBRX OS** is the platform: the shared core (policy, audit, the Fabrix agent, FBRX Shield, Mesh) that every FBRX
product is built on. It comes in two forms, and as an app for the computers you already have.

| Product | What it is | Status |
| --- | --- | --- |
| **FBRX Desktop** | FBRX OS as a whole operating system for computers, with FBRX Endpoint Ultra and FBRX Shield built in. | Planned |
| **FBRX Server** | FBRX OS for servers: Debian 13 set up the FBRX way, with a web console and one or more **roles** (below): virtual machines, an AI agent on FBRX Mesh, the network's gate and its threat watch. [SERVER.md](SERVER.md) | First stage |
| **FBRX Virtual** | The hypervisor FBRX Server runs: virtual machines on KVM, their screens, storage, networks, the hardware map and BIOS control. [SERVER.md](SERVER.md) | First stage |
| **FBRX Endpoint** | The FBRX toolset on top of Windows, macOS or Linux, for organizations and homes that keep their operating system. **Basic** is free; **Ultra** (a license key) unlocks everything. Both come with FBRX Shield. | Alpha 1.9 |
| **FBRX Shield** | FBRX's antivirus, in every FBRX Endpoint and FBRX Desktop, alongside the choice of Microsoft Defender or an antivirus already installed. [SHIELD.md](SHIELD.md) | Alpha |
| **FBRX Command** | The tenant controller: Work, School and Home tenants, users, licensing and permissions; turns FBRX Endpoints into lightweight device management; controls FBRX Mesh; and (next) governs FBRX Virtual servers. [ADMIN_CONSOLE.md](ADMIN_CONSOLE.md) | Alpha |
| **FBRX Mesh** | FBRX Endpoints and FBRX Servers talking to one another directly, end-to-end encrypted, with the tenant deciding who may reach whom. **Mesh Assist** lets them lend each other their AI (when one runs out of steps or credits) and lets a controller hand out work. [MESH.md](MESH.md) | Alpha |
| **FBRX Gate** | A real firewall: routing, firewall rules, VLANs, DHCP and DNS, a VPN, traffic priority and Prefer Mesh (a fast lane for FBRX computers helping each other), changed by commits that undo themselves unless kept, from the console or a router-style command line. The gate role of FBRX Server; as a virtual machine on FBRX Virtual later. [GATE.md](GATE.md) | First stage |
| **FBRX MiniDome** | Watches the network through FBRX Gate (names asked, connections, devices) for threats, working hand in hand with FBRX Shield on each endpoint: a computer that allows it hears what the network saw coming from it, and the network sees how the computer is protected. AI explains findings; blocking is one click on the gate. The minidome role of FBRX Server. [MINIDOME.md](MINIDOME.md) | First stage |

## How they fit

```
                         FBRX Command (tenants, users, licenses, policy)
                ┌──────────────┬───────────────┬────────────────┐
           FBRX Endpoint   FBRX Desktop    FBRX Server       FBRX Mesh
          (Basic / Ultra)                 └ FBRX Virtual ──── virtual machines
                └── FBRX Shield ─┘              ├ FBRX Gate (routing, firewall)
                                                └ FBRX MiniDome (network watch) ◄──► FBRX Shield
```

## FBRX Server roles

One FBRX Server can do one job or several; an organization with several servers gives each its roles, and all of them
stay on FBRX Mesh, so their AI helps one another (Mesh Assist) and a controller can hand work to the server whose
roles fit.

| Role | | Status |
| --- | --- | --- |
| `virtual` | FBRX Virtual, the hypervisor (the web console comes with every role) | First stage |
| `ai` | The FBRX core: an AI agent on FBRX Mesh with Mesh Assist, set up from the console's *Mesh & AI* | First stage |
| `gate` | FBRX Gate: the network's router and firewall | First stage |
| `minidome` | FBRX MiniDome: threat detection through the gate | First stage |
| `command` | FBRX Command on the server: the organization's settings and policy, decided on the server side | Planned |
| `dns` | Name service for the network | Planned |
| `directory` | Directory and sign-in for the organization's computers (a domain controller) | Planned |
| `files` | File sharing | Planned |

Where this is going, for example:

```
   fbrx-cmd-1 (command, ai) ── decides the settings, controller for Mesh Assist
        │ FBRX Mesh (end-to-end encrypted)
        ├── fbrx-dns-1 (dns, ai)
        ├── fbrx-dc-1  (directory, ai)
        ├── fbrx-files-1 (files, virtual, ai)
        ├── fbrx-gate-1 (gate, minidome, ai) ── the network's edge, watching it
        └── FBRX Endpoints (Basic / Ultra) and FBRX Desktops
```

Each server keeps its own policy: a controller's work runs there only because that server gave it the Controller
permission, and still under that server's rules.

## Names

* Say **FBRX Desktop** or **FBRX Server**, "powered by FBRX OS". FBRX OS on its own means the platform.
* **FBRX Virtual** is the hypervisor (FBRX Server is the operating system it comes with).
* **FBRX Endpoint Basic** and **FBRX Endpoint Ultra** are the two editions of the app.
* Other companies' products are named only to say FBRX works with them (for example "works with Dell iDRAC",
  "Outlook / Microsoft 365 calendars", "Microsoft Defender").
