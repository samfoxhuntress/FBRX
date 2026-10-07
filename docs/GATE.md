# FBRX Gate

**FBRX Gate** turns an FBRX Server into the router and firewall of your network: the internet on one port, your
networks on the others (VLANs on one cable, or a port each), addresses and names for your devices, a VPN for your
phone and laptop, traffic priority, and **Prefer Mesh**, a fast lane for FBRX computers whose AI helps each other.

It is the **gate** role of FBRX Server ([SERVER.md](SERVER.md)), managed from the same web console (the *Gate* pages)
or from a router-style command line on the server (`fbrx-gate`). Add **FBRX MiniDome** ([MINIDOME.md](MINIDOME.md)) to
watch the network through it.

> First stage (FBRX Gate 0.1): IPv4 routing with one internet connection. It is tested as a real router in Linux
> network namespaces in CI. IPv6 routing, several internet connections and high availability come later.

## How it works: edit, review, commit

Everything the gate does is **one configuration**. You never change the network directly:

1. **Edit** — the console's pages (or `fbrx-gate set …`) change a *candidate* copy. Nothing on the network changes yet;
   a banner across the console counts the changes waiting.
2. **Review** — *Changes* lists every difference from what runs, the problems to fix first (a DHCP range outside its
   network, two networks overlapping, a VLAN bigger than its port, a rule about a network that does not exist…) and
   things worth a look. *Preview the files* shows exactly what it becomes: the nftables table, dnsmasq's settings, the
   systemd-networkd files and the traffic-shaping commands.
3. **Commit** — checked again (`nft -c`, `dnsmasq --test`), then applied. If applying fails, the previous configuration
   is put back at once and nothing changed.

**Trial commits** (on by default, 5 minutes): the commit undoes itself unless you press **Keep it** in time. If a change
cuts you off (a wrong port, a rule that blocks the console), wait: the old configuration comes back by itself. A gate
that restarts during a trial also goes back. Every commit is kept; *Changes → History* goes back to any of them (as a
new commit, on trial too).

## Install

On FBRX Server (the ISO installs the virtual and ai roles; add the gate afterwards):

```bash
sudo /opt/fbrx-installer/install.sh --roles virtual,ai,gate --gate-wan eno1 --gate-lan eno2
# or, a dedicated gate with MiniDome:
sudo bash fbrx-server-0.1.0/install.sh --roles gate,minidome,ai --gate-wan eno1 --gate-lan eno2
```

| Option | |
| --- | --- |
| `--gate-wan <port>` | The port your modem or provider's box plugs into. |
| `--gate-lan <port>` | The port to your network. It becomes **192.168.1.1/24** and hands out 192.168.1.100–199. |
| `--gate-manage <cidr\|none>` | A private network on the internet side that may still reach the console and SSH. By default the network the internet port is on during the install (if private), so installing over it does not shut you out. |

The installer adds nftables, dnsmasq, WireGuard tools and systemd-networkd; moves the two ports from the system's own
network settings (`/etc/network/interfaces`, kept as `interfaces.fbrx-backup`) to systemd-networkd; loads the firewall
before the network comes up at every boot (`fbrx-gate-firewall.service`); points the server's own name lookups at the
gate; and, at the first start, commits the **starter configuration**: the internet by DHCP, your network on the LAN
port, nothing reachable from the internet. On a running server the takeover waits for a restart.

Then plug a computer into the LAN port: it gets an address. Open `https://192.168.1.1:9443` and sign in with the setup
code (`sudo fbrx-server setup-code`).

## The console

| Page | |
| --- | --- |
| **Gate** | The internet address, traffic now (and a chart while the page is open), devices, connections, ports, what is switched on, the last commit. |
| **Networks & VLANs** | The internet port (DHCP or fixed), networks and the ports and VLANs they are on. |
| **Firewall** | What each network may reach, rules (top to bottom, first match wins) with how often each matched, port forwards. |
| **DNS & VPN** | Upstream servers, your own domain and names, blocking lists, the question log; the VPN and its devices. |
| **Traffic & Prefer Mesh** | Fair sharing of the internet line and the priority lane. |
| **Changes** | Review, commit (with a trial), throw edits away, edit as text, preview, history and going back. |

Viewers see everything; administrators change it.

## Networks and VLANs

A **network** has a kind, an address for the gate (its size gives the range), what it may **reach**, whether its
devices may **manage the gate** (console and SSH), and DHCP with reserved addresses.

| Kind | Reaches | Manages the gate | |
| --- | --- | --- | --- |
| Your network | Everything | Yes | Your own computers. |
| Guests | The internet only | No | Visitors, kept away from your devices. |
| Mesh | Everything | Yes | FBRX computers and servers helping each other: Prefer Mesh, jumbo frames where possible. |
| Servers | Everything | Yes | |
| Smart devices | The internet only | No | Cameras, TVs, plugs. |
| Management | Everything | Yes | Switches, iDRACs, access points. |

*Reaches* means: **everything** (the internet and your other networks), **the internet only**, or **nothing outside**
(only each other, and the gate for addresses and names). Nothing reaches in from the internet unless you forward a
port; firewall rules add exceptions either way.

**VLANs** carry several networks on one cable: *New network → A VLAN on a port* picks a tag (guests 20, mesh 30, …);
set the same tag on your switch's ports. A VLAN on the internet port works but is flagged.

**Jumbo frames** (MTU 9000) suit a mesh or storage network whose switch and computers all take them. A VLAN's port must
be at least as large, and an untagged network on that port would get jumbo frames too, so the console only offers them
by default where that cannot happen and says why otherwise.

## Firewall

The **basics** come from each network's *reaches* and *manages the gate*. **Rules** go between zones: a network's name,
`wan` (the internet), `vpn`, `gate` (the gate itself) or `any`, with TCP/UDP ports, optional source and destination
addresses, and *allow*, *refuse* (the sender is told) or *block quietly*. Ready-made rules: printing, screen casting,
file sharing, keeping a network out. **Port forwards** send a port on the internet side to one device inside (optionally
only from one address on the internet). Each rule and forward shows how often it matched; the *basics* card counts
what was turned away.

The firewall is one nftables table, `inet fbrx_gate`, replaced in one step at each commit. It filters only the ports
the gate runs, so FBRX Virtual's own networks keep working next to it.

## DNS

The gate answers its networks' questions (dnsmasq), asks your **upstream** servers for the rest, knows your devices by
name (`laptop.lan`, and the names you add), and can **block** domains and blocklists (ads, trackers). The **question
log** (on by default) is what FBRX MiniDome reads; it is rotated daily and kept a week.

## VPN

Your phone or laptop reaches home from anywhere (uses WireGuard). *DNS & VPN → Add a device*: the gate makes the
device's keys and settings and shows them **once**, as a QR code for the WireGuard app and as a settings file. The
device's private key is not kept anywhere. Choose whether everything goes through home (safer on public Wi-Fi) or only
your networks. Behind another router, forward UDP 51820 to the gate.

## Traffic priority and Prefer Mesh

**Traffic priority** shares the internet line fairly: give your upload (and optionally download) speed a little under
what the line really does, and the gate shapes it with four lanes by DSCP mark (cake; HTB with three lanes on kernels
without cake): voice, video, best effort, bulk. A big upload no longer drowns out calls.

**Prefer Mesh** puts traffic between FBRX computers first, so their AI helping each other (Mesh Assist) does not wait
behind a backup or a download:

* **Marked**: FBRX Mesh traffic (TCP port 47800) through the gate, and everything from the networks you pick (a mesh
  VLAN), gets the DSCP mark you choose (AF41 by default: the video lane, below voice calls). The gate counts what it
  marked.
* **At both ends**: FBRX computers mark what they send too (*Mesh & phone → Prefer Mesh* in FBRX Endpoint; *Mesh & AI →
  Network* on a server), and reach each other through the mesh network first. See [MESH.md](MESH.md#prefer-mesh).
* **TCP, kept open**: mesh connections are TCP, kept alive and sent without delay, so help between computers starts
  without a new handshake each time.
* **Jumbo frames** on the mesh VLAN where every switch and computer takes them.
* **Your switches**: let them trust DSCP on the mesh VLAN's ports (or give that VLAN a higher queue) so the priority
  holds inside your network too.

## fbrx-gate

The same configuration from the server's command line, as root (`sudo fbrx-gate …`). Paths are words: list items by
name.

```
fbrx-gate status                         ports, the internet side, devices, problems
fbrx-gate show [running] [path…]         the configuration being edited (or what runs), or part of it
fbrx-gate set networks guest access internet
fbrx-gate set interfaces eno2.30 mtu 9000
fbrx-gate add firewall rules '{"id":"ssh-lan","name":"SSH from the LAN",…}'
fbrx-gate delete firewall forwards web
fbrx-gate edit                           the whole configuration in $EDITOR
fbrx-gate check                          problems and warnings
fbrx-gate compare                        what a commit would change
fbrx-gate commit confirmed 5 comment Guest VLAN
fbrx-gate confirm                        keep it
fbrx-gate rollback now                   undo the commit on trial
fbrx-gate rollback 12                    go back to commit 12
fbrx-gate reset                          throw the edits away
fbrx-gate history | leases | preview nftables|dnsmasq|networkd
```

It signs in with a token only root can read, accepted only from the gate itself.

## On disk

| | |
| --- | --- |
| `/var/lib/fbrx-virtual/gate.db` | The candidate, every commit with its configuration |
| `/etc/fbrx-gate/gate.nft` | The firewall, loaded at boot by `fbrx-gate-firewall.service` |
| `/etc/fbrx-gate/wg-fbrx.key` | The gate's VPN key |
| `/etc/systemd/network/10-fbrx-*` | Ports, VLANs, addresses, the VPN interface |
| `/etc/dnsmasq.d/fbrx-gate.conf` | DHCP and DNS |
| `/var/lib/fbrx-gate/` | Leases, the downloaded blocklist |
| `/var/log/fbrx-gate/dnsmasq.log` | The question log |

All of it is written by FBRX Gate from the configuration: change the configuration, not the files.

## API

Under `/v1` on the console's port (see [SERVER.md](SERVER.md#api)):

| | |
| --- | --- |
| `GET /gate`, `GET /gate/live`, `GET /gate/interfaces` | The state (running, candidate, changes, problems, trial), live status, the server's ports (viewers) |
| `PUT /gate/candidate`, `POST /gate/candidate/reset`, `GET /gate/preview` | Edit, throw away, preview (administrators) |
| `POST /gate/commit` `{ comment, confirmMinutes }`, `POST /gate/confirm`, `POST /gate/confirm/undo`, `POST /gate/rollback` `{ to, confirmMinutes }` | Commit, keep, undo the trial, go back |
| `GET /gate/history`, `GET /gate/history/:id` | Commits |
| `POST /gate/vpn/peers` `{ name, endpoint?, fullTunnel }` | A new VPN device: its settings and QR code, once |

## Development

```bash
FBRX_V_ROLES=gate,minidome FBRX_V_GATE=simulated npm run dev:virtual   # a pretend gate (nothing on this computer changes)
npx vitest run packages/gate apps/virtual/test/gate.test.ts
sudo -E env "PATH=$PATH" npx vitest run packages/gate/test/netns.integration.test.ts   # a real router in namespaces
```

The code is in `packages/gate` (the configuration, its checks, what it turns into; the engine and the Linux applier in
`src/node`), `apps/virtual/src/routes/gate.ts` and `gate-cli.ts`, and the console's `pages/gate-*.tsx`.
