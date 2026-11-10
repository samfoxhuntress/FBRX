# Installing FBRX

FBRX OS for Windows, Mac and Linux is downloaded from the **FBRX website** (*Download*), never from an app store, and
keeps itself up to date (*Settings → Updates*). The FBRX app for iPhone, iPad and Android is the one part in the app
stores: it pairs with your computer ([MESH.md](MESH.md)).

## What to download

| Download | What it is |
| --- | --- |
| `FBRX-OS-Setup-<version>.exe` (Windows), `FBRX-OS-<version>-arm64.dmg` and `-x64.dmg` (Mac: Apple silicon and Intel), `FBRX-OS-<version>-x86_64.AppImage` and `-amd64.deb` (Linux) | **The installer.** Double-click it: there is no terminal and nothing to build, and FBRX OS opens straight into a chat with your own AI, downloading it while you watch. It starts on Endpoint Essentials (free); sign in to your FBRX account, or join your organization's FBRX Command, for more. |
| `FBRX-OS.zip` | The whole project, to build your own copy with your own license signing key (below). The link on the website always gives the newest version. |
| `fbrx-server-<version>-amd64.iso`, `fbrx-server-<version>.tar.gz` | FBRX Server: the installer ISO, and the bundle for a Debian 13 server you already have ([SERVER.md](SERVER.md)). |

## Building your own copy

Unzip `FBRX-OS.zip` somewhere permanent and outside synced folders (for example `~/FBRX` or `C:\FBRX`), then
double-click the installer for your computer. On Windows, right-click the zip and choose **Extract All…**;
double-clicking `Install FBRX OS.cmd` inside the zip without extracting it also works: setup finds the zip in your
Downloads folder, offers to unzip it to `%USERPROFILE%\FBRX` (or a folder you type) and continues from there.

| Computer | Double-click | If the computer warns you about a downloaded file |
| --- | --- | --- |
| Mac | **`Install FBRX OS.command`** | System Settings → Privacy & Security → **Open Anyway**. Or open Terminal, type `bash ` and drag the file in, then press Enter |
| Windows | **`Install FBRX OS.cmd`** | **More info → Run anyway** |

The installer does everything, in about 15–20 minutes the first time (about 2 GB of downloads), and when it is done
FBRX OS opens straight into a chat with your own AI, running on your computer:

1. downloads a private copy of Node.js if this computer doesn't have a recent one (nothing is installed system-wide),
2. downloads what FBRX OS is made of,
3. builds FBRX OS for this exact machine (Apple silicon or Intel, x64 or ARM), with the AI runtime inside, and creates
   your license signing key (in `.fbrx-keys/`, with a copy in `~/.fbrx-keys`), which you should **back up**: it signs
   every license you issue,
4. gets your AI ready: the starter model (about 1 GB) downloads meanwhile into FBRX OS's data folder (only on a
   computer that doesn't have FBRX OS yet),
5. installs it in Applications (Mac) or for your user with Start menu and desktop shortcuts (Windows), with an
   Ultra license in your name that activates by itself, and opens the app.

To update later, choose **Update now** when FBRX OS offers a new version (*Settings → Updates*), or download the new
version into the same place and run the installer again; your data, settings and keys are kept, and a running FBRX OS
is closed for you. Options: `--name "Acme Ltd"` (the name on your license), `--no-launch`, `--no-ai` (leave the model
to the app), `--allow-downgrade`, `--signing-key <file>` (below). The full log is in `.fbrx-setup/setup.log`.

**Removing it.** On a Mac or Linux, *Settings → Updates → Uninstall FBRX OS*, or run the installer with `--uninstall`
(on Linux, also right-click FBRX OS in your apps or dock → *Uninstall FBRX OS…*). It opens in a terminal window and
asks first, closes FBRX OS (asking it to quit, so it stops its AI properly), and removes the app (on Linux its entry
in your apps and the build in the FBRX folder). If FBRX OS will not close, nothing is removed and it says so. Your
data (chats, notes, settings, the vault) stays for a later install; `--uninstall --delete-data` erases it too.
Windows removes it in *Settings → Apps*, or with its Setup file.

**On Ubuntu and other Linux.** Installed from the FBRX folder, *Update now* runs the installer in a terminal window and
FBRX OS opens again on the new version. Installed from the website instead: the AppImage updates itself, and a newer
`.deb` installs over the old one with `sudo apt install ./FBRX-OS-<version>-amd64.deb`. To remove that one, use
Ubuntu's App Center, or `sudo apt remove` with the name `dpkg -l | grep -i fbrx` shows; your data in `~/.config/FBRX OS`
stays.

**With FBRX Command on another computer.** FBRX OS accepts the editions FBRX Command gives (to the organization, or to
FBRX accounts on it) only when it was built with FBRX Command's license signing key. On one computer the two installers
share it by themselves. For FBRX OS on another computer, copy `~/.fbrx-keys/license-signing.pem` from the FBRX Command
computer and run `Install FBRX OS` with `--signing-key <that file>`; the keys it replaces are kept beside it, dated.
Until then that computer runs Pro, and *Settings → Edition* says why.

## Giving FBRX OS to someone else

For someone who isn't technical, send the ready-made installer from the website. They double-click it, and FBRX OS
downloads its AI when it first opens, showing the progress in the chat.

On Windows you can also make one for them: open a Command Prompt in your FBRX folder and run
`"Install FBRX OS.cmd" --share`. Enter their name to build a trial license into the installer (30 days by default:
Ultra, then the free features), or leave it blank to send an update to someone who is already
set up (`--for "Alex" --days 30 --yes` skips the questions). The result is one file in the `Share` folder, for example
`Share\FBRX-OS-Setup-2.3.3-for-Alex.exe`, plus a short *How to install* note to send along.

On their PC they double-click it. A new install opens FBRX OS straight to the chat while its AI downloads. If FBRX OS
is already there, Setup opens on a choice instead:

* **Upgrade** (when the file is newer): installs it and keeps all their data, settings, license and paired devices,
* **Repair**: reinstalls from scratch and clears cached files, for an app that will not start or looks wrong,
* **Uninstall**: removes FBRX OS, keeping their data unless they tick *Also delete my data*.

If FBRX OS is open, Setup asks it to quit properly first (and ends anything left over, such as the local AI runtime).
An older file than the installed version offers a downgrade, with a warning. The command-line switches for IT tools:
[DEPLOYMENT.md](DEPLOYMENT.md#3-the-windows-installer-upgrade-repair-and-uninstall).

## FBRX Command on a computer of your own

Next to the FBRX OS installers in `FBRX-OS.zip` are **`Install FBRX Command.command`** (Mac) and **`Install FBRX
Command.cmd`** (Windows). Double-click it on the computer that will run FBRX Command for your company, school or family
(one that stays on, with a fixed address in your router). In about five minutes it:

1. builds FBRX Command and installs it with its own copy of Node.js,
2. gives it the same license signing key as `Install FBRX OS` on this computer, so the licenses it issues work on
   your computers (FBRX OS built elsewhere needs `--signing-key`, above),
3. starts it now and every time you log in, with an **FBRX Command** icon in the Start menu / Applications,
4. opens the first-run page (Work, School or Home) with its one-time setup token already filled in.

It asks who will connect. **Computers on this network** (the default) serves `https://<this computer>:8787` with
FBRX Command's own certificate: computers check its fingerprint once when they join (FBRX shows it; FBRX Command →
Deploy & enroll shows the same one) and then trust nothing else, so no domain name is needed. **Only this computer**
is for trying it out. Run it again to update (data kept), or with `--uninstall` to remove it (`--delete-data` to
erase everything). Options and details: [DEPLOYMENT.md](DEPLOYMENT.md#fbrx-command-on-a-computer-of-your-own).
