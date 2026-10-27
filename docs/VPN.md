# FBRX VPN

**FBRX VPN** (Orbit → **FBRX VPN**, Endpoint Ultra and up) connects this computer to your **FBRX Gate** from anywhere,
so home is as close as when you are there: your FBRX Server and its console, its AI over FBRX Mesh (Mesh Assist and
the chats you send it, see [MESH.md](MESH.md)), and the devices on your network. It is the gate's own VPN (WireGuard),
run by FBRX on this computer.

## Set it up

1. **On the gate** (your FBRX Server's console): *Gate → DNS & VPN → Add a device*. Name it after this computer and
   choose what goes through home: **Only home** (your networks, and nothing else) or **Everything** (safer on public
   Wi-Fi). The gate makes the device's keys and shows its settings **once**: copy them, or download the settings file.
   Commit the change (the banner at the top) so the gate lets the device in.
2. **On this computer**: *FBRX VPN → Add your gate*, paste the settings (or *Pick the file…*). FBRX keeps them
   encrypted with the Vault, keys and all; delete the downloaded file afterwards.
3. **Connect.** The system asks for administrator rights each time a tunnel starts or stops.

At home, behind another router (your provider's box), forward UDP **51820** to the gate. The gate's settings name its
address on the internet; if that address changes, give the gate a name that follows it (a dynamic DNS name) and put it
after `Endpoint =` before you paste.

**Check home** pings the gate and each paired FBRX computer with an address behind the tunnel, and asks them over FBRX
Mesh: when your FBRX Server answers there, its AI can help this computer as at home, and your chats can think with it
(*AI models → Your other computers' AI*, see [MESH.md](MESH.md#think-with-your-fbrx-servers-ai)). Pair your computers with the
server at home first (*Mesh & phone*); they find each other by the addresses they had there.

## What it needs on this computer

| System | The tunnel runs with | Installing it |
| --- | --- | --- |
| Windows | WireGuard for Windows (free): FBRX installs a tunnel service for it | *Install them* on the page (through `winget`) |
| macOS | `wg-quick` from Homebrew's `wireguard-tools` | *Install them* (`brew install wireguard-tools`; needs Homebrew) |
| Linux | `wg-quick` from `wireguard-tools`, started through `pkexec` | *Install them* (`apt-get` or `dnf`), or your package manager |

On Linux the gate's name server is used only when the system has `resolvconf`; without it, names at home are not
looked up through the tunnel, but every address works.

## How it stays safe

* The settings are read strictly: only what a tunnel needs. A file that runs commands (`PreUp`, `PostUp`, `PreDown`,
  `PostDown`) or carries other settings is refused, since the tunnel starts with administrator rights; the file the
  tunnel runs from is rebuilt from what was read.
* The keys stay sealed with the vault key. The settings file the system needs exists only while a tunnel starts or
  stops (on Windows, while it runs), in FBRX's machine-local folder, readable by you alone, and never in a backup.
* Only you, at this computer, can add, connect, disconnect or remove a tunnel (not the agent, the Local API or FBRX
  Command).
* On the gate, a device reaches what its *access* allows (your networks, or the internet only); with full access it
  may also reach the gate's console, SSH and FBRX Mesh (the server's own FBRX core).

A tunnel keeps running when FBRX closes, like any VPN; *Disconnect* (or restarting the computer, on macOS and Linux)
ends it.
