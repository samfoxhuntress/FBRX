# FBRX MiniDome

**FBRX MiniDome** watches your network through FBRX Gate ([GATE.md](GATE.md)): the names devices ask for, the
connections they make, and who is on the wire. What looks wrong becomes a **finding**, by device. FBRX computers on
FBRX Mesh hear about what was seen coming from them, so **FBRX Shield** and MiniDome work hand in hand: the network sees
a laptop asking for a malware domain, the laptop gets the alert and runs a scan.

It sees and reports; changes to the network (blocking a domain, moving a device to its own network) go through the gate,
one click away and committed like any other change.

> First stage (FBRX MiniDome 0.1): it runs on the gate itself, as the **minidome** role of FBRX Server.

## Install

```bash
sudo bash fbrx-server-0.1.0/install.sh --roles gate,minidome,ai --gate-wan eno1 --gate-lan eno2
```

MiniDome needs the gate role. The installer adds `conntrack` (to follow new connections) and rotates the gate's question
log daily. The **ai** role is optional: it explains findings and tells FBRX computers about them.

## What it listens to

| Source | |
| --- | --- |
| The gate's DNS question log | Every name asked of the gate, and the answers "no such name" (followed as it is written, across rotation). |
| New connections | conntrack's event stream on the gate (or the kernel's connection table every few seconds without the tool). |
| Devices | The gate's neighbor table (who has which address on the wire) and its DHCP leases. |

*MiniDome → Settings* shows each source and whether it works.

## What it looks for

| Finding | How bad | |
| --- | --- | --- |
| **Known-bad name** | Serious (warning when the gate blocks it anyway) | A device asked for a domain on your threat lists. |
| **Made-up names** | Serious | Many random-looking names in ten minutes, or names that do not exist: how some malware hunts for its servers (domain generation). Content networks and reverse lookups are left out. |
| **Data hidden in names** | Serious | Very long names, many different long names under one domain, or many text lookups: a DNS tunnel carrying data past the firewall. |
| **DNS around the gate** | Warning | A device asks another DNS server (port 53 or 853), so the gate's blocking and MiniDome do not see its names. |
| **Scanning** | Serious | A device tries many ports on another device, or one port on many devices of your networks, within a minute. |
| **Checking in like clockwork** | Warning | New connections to the same place at regular intervals: smart devices and updaters do it, so does malware calling home. Mute what you recognize. |
| **Address fight** | Serious / warning | An address changing hands back and forth, a device answering for an address the gate gave someone else, or one device answering for many addresses (ARP spoofing; some Wi-Fi extenders do the last one innocently). |
| **New device** | Worth knowing | A device the gate has not seen before (after a ten-minute learning period on a new MiniDome). |

**Sensitivity**: *only when sure*, *balanced* or *readily* moves the thresholds. A finding speaks up at most every half
minute per device and subject, unless it got worse.

## Findings

One finding per device and subject (a domain, an address), counted, with the latest evidence and the device by name.
**Looking into it** marks it as yours; **Resolve** closes it (it opens again if it happens again); **Mute** keeps
counting it but never raises it again.

* **Explain with AI**: this server's AI (the ai role, *Mesh & AI*) explains the finding in plain words, how worried to
  be, and what to do next. The finding and its evidence go to the AI provider set up there.
* **Block on the gate**: for a domain, adds it to the gate's blocking, waiting in *Changes* for a commit.

## Threat lists

Add the lists you trust in *Settings* (hosts files or one domain per line, http or https); they are fetched twice a day
and kept between restarts. **Never report** takes domains you know are fine (their subdomains too).

To try MiniDome, ask the gate for `minidome-test.fbrx.invalid` from any device (`nslookup minidome-test.fbrx.invalid`):
it is always on the list.

## With FBRX computers: Network protection

On each FBRX computer, the **Network protection** permission for the gate's server (*Mesh & phone → the server →
Network protection*) decides whether:

* the computer gets an **alert** when MiniDome saw something coming from it (*The network gate saw a threat from this
  computer*, critical for serious findings, with the evidence and the suggestion to run a scan), and
* MiniDome's **device list** shows how it is protected (its antivirus, FBRX Shield or another, and threats found).

It is off until the computer turns it on. The message goes through the server's FBRX core (the ai role) and FBRX Mesh,
end-to-end encrypted, only to the paired computer that has that address. *Settings → Tell FBRX computers* turns it off
on the gate's side.

## Privacy

MiniDome keeps findings (with a few lines of evidence each) and the devices it has seen, in
`/var/lib/fbrx-virtual/dome.db`. It does not keep the names asked or the connections made; the gate's question log is
rotated daily and kept a week.

## API

Under `/v1` on the console's port:

| | |
| --- | --- |
| `GET /dome` | Settings, open findings by severity, what it listened to, the learning period (viewers) |
| `GET /dome/findings?status=active\|open\|acknowledged\|resolved\|muted` | Findings |
| `POST /dome/findings/:id` `{ status }` | Looking into it, resolve, mute (operators) |
| `POST /dome/findings/:id/explain` | This server's AI explains it (operators; ai role) |
| `POST /dome/findings/:id/block` | Block its domain on the gate (administrators; into the candidate) |
| `GET /dome/devices` | Devices seen, with FBRX computers' protection |
| `PUT /dome/settings` `{ settings }`, `POST /dome/feeds/refresh` | Settings and threat lists (administrators) |

## Development

```bash
FBRX_V_ROLES=gate,minidome FBRX_V_GATE=simulated npm run dev:virtual   # a pretend household with a few things to find
npx vitest run packages/dome apps/virtual/test/dome.test.ts packages/core/test/mesh-dome.test.ts
```

The code is in `packages/dome` (what it hears, the detectors, threat lists; the sensors, findings store and engine in
`src/node`), `apps/virtual/src/routes/dome.ts` and the console's `pages/dome.tsx`. The real-network check is in
`packages/gate/test/netns.integration.test.ts`.
