# The FBRX lineup

**FBRX OS** is the platform: the shared core (policy, audit, the Fabrix agent, FBRX Shield, Mesh) that every FBRX
product is built on. It comes in two forms, and as an app for the computers you already have.

| Product | What it is | Status |
| --- | --- | --- |
| **FBRX Desktop** | FBRX OS as a whole operating system for computers, with FBRX Endpoint Ultra and FBRX Shield built in. | Planned |
| **FBRX Server** | FBRX OS for servers: Debian 13 set up the FBRX way, running FBRX Virtual. [SERVER.md](SERVER.md) | First stage |
| **FBRX Virtual** | The hypervisor FBRX Server runs: virtual machines on KVM, their screens, storage, networks, the hardware map and BIOS control. [SERVER.md](SERVER.md) | First stage |
| **FBRX Endpoint** | The FBRX toolset on top of Windows, macOS or Linux, for organizations and homes that keep their operating system. **Basic** is free; **Ultra** (a license key) unlocks everything. Both come with FBRX Shield. | Alpha 1.9 |
| **FBRX Shield** | FBRX's antivirus, in every FBRX Endpoint and FBRX Desktop, alongside the choice of Microsoft Defender or an antivirus already installed. [SHIELD.md](SHIELD.md) | Alpha |
| **FBRX Command** | The tenant controller: Work, School and Home tenants, users, licensing and permissions; turns FBRX Endpoints into lightweight device management; controls FBRX Mesh; and (next) governs FBRX Virtual servers. [ADMIN_CONSOLE.md](ADMIN_CONSOLE.md) | Alpha |
| **FBRX Mesh** | FBRX Endpoints talking to one another directly, end-to-end encrypted, with the tenant deciding who may reach whom. [MESH.md](MESH.md) | Alpha |
| **FBRX MiniDome** | A network application that lives on the local network (a small server or a virtual machine on FBRX Virtual) and watches it with AI, working hand in hand with FBRX Shield on each endpoint: a threat seen on the network is checked on the computer, and the other way round. It sees and reports; it does not route or set firewall rules. | Planned |
| **FBRX Gate** | A real firewall, as a virtual machine on FBRX Virtual or on its own computer: routing, DHCP, DNS, VLANs, VPN and firewall rules, with a clean command line and a dashboard. | Planned |

## How they fit

```
                         FBRX Command (tenants, users, licenses, policy)
                ┌──────────────┬───────────────┬────────────────┐
           FBRX Endpoint   FBRX Desktop    FBRX Server       FBRX Mesh
          (Basic / Ultra)                 └ FBRX Virtual ──── virtual machines
                └── FBRX Shield ─┘              ├ FBRX Gate (routing, firewall)
                                                └ FBRX MiniDome (network watch) ◄──► FBRX Shield
```

## Names

* Say **FBRX Desktop** or **FBRX Server**, "powered by FBRX OS". FBRX OS on its own means the platform.
* **FBRX Virtual** is the hypervisor (FBRX Server is the operating system it comes with).
* **FBRX Endpoint Basic** and **FBRX Endpoint Ultra** are the two editions of the app.
* Other companies' products are named only to say FBRX works with them (for example "works with Dell iDRAC",
  "Outlook / Microsoft 365 calendars", "Microsoft Defender").
