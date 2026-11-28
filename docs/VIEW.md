# FBRX View

FBRX View is FBRX's **remote desktop app**: every way into another machine in one window, in tabs. Windows computers
and servers (RDP), Macs and Linux desktops (VNC), and servers, switches, routers and firewalls (SSH and Telnet). It
runs on Windows, macOS and Linux, beside FBRX Endpoint, and comes with **Endpoint Ultra** (and Black Hole Edition).

## Connect

**Connections → New** (or a kind on the Start tab): choose the kind, then the address, and the port when it is not the
usual one (3389 for remote desktop, 5900 for screen sharing, 22 for SSH, 23 for Telnet).

* **Remote desktop (RDP)**: the user name (`name`, or `DOMAIN\name`) and its password. The desktop opens in a tab,
  drawn in View itself: no other program is needed. The other computer must allow remote desktop (on Windows:
  *Settings → System → Remote Desktop*; on Linux, XRDP).
* **Screen sharing (VNC)**: the password, if the computer asks for one (some also want a user name). If it asks while
  connecting, View asks you.
* **SSH and Telnet**: the device consoles, as in FBRX Digger, with the device guides and the device's identity checked
  the first time.

Each connection is kept in the list on the left; click one to connect again. **Find a connection** searches by name,
address, user or kind.

From FBRX Endpoint or FBRX Digger, **Open in FBRX View** on a remote desktop or screen sharing connection opens View
with that connection filled in; you connect from there.

**Import** (the arrow beside *New*) brings in connections from a Remote Desktop file (`.rdp`) or a Remote Desktop
Manager export (`.rdm`, XML): remote desktop, VNC, SSH and Telnet entries, with their names, addresses, ports and user
names (and the folder they were in, in the connection's notes). Passwords are never imported: View asks once, then keeps
them if you say so. Folders, web pages and other kinds of entries are left out, and View says how many.

## In a session

* **Ctrl+Alt+Del** and **Start key** (the Windows key) are sent to the other computer; the keyboard and mouse work as
  usual in the tab.
* **Actual size** shows the other screen pixel for pixel; **Fit** fits it to the tab.
* **Full screen** fills the screen with it; *Esc* leaves full screen.
* **Disconnect** ends it; a session that ends by itself, or cannot connect, says why, with **Reconnect**, and
  **Ask Fabrix** helps find out why when it will not connect.
* Every tab keeps its session while you look at another.
* **Quick commands** (console tabs): the commands you type often, saved once (*Edit quick commands*) and typed into the
  console with one click. They are typed without Enter, so you read them first and press Enter yourself.

## Passwords

With **Keep the password in the vault once it works** on, the password goes into the FBRX vault (encrypted on this
computer) after the first connection that works, and the connection opens without asking next time. A key on a
connection in the list means its login is saved. Passwords are never shown to Fabrix.

## How it stays safe

* View draws the remote screen itself, so it connects through a small relay inside View that listens on this computer
  only. Nothing gets through it without a one-time ticket View makes when you connect: one connection, to the computer
  you chose, used once and good for a minute.
* Remote desktop connections are encrypted (TLS), with Network Level Authentication when the computer asks for it, and
  the other computer's certificate is checked by View as a remote desktop app does. A computer that only offers old,
  unencrypted RDP security is refused.
* Every connection, refusal and end is in the audit log, with the address and the amount of data, never the
  password.

## FBRX Server

With **Black Hole Edition**, View has the **FBRX Server** page: your servers (their console and a command line, at home
or through FBRX VPN), letting Fabrix look at one, and setting up a new one. The servers saved in FBRX Endpoint come
along the first time View starts, with the certificate you trusted for each (sign in to each console again; Fabrix's
access to a server is set up again from View). FBRX Endpoint's FBRX Server page points to View, and keeps working
meanwhile. The installer ISO and bundle stay with FBRX Endpoint's installers for now.

## Fabrix in View

With FBRX Endpoint running on the same computer, View's Fabrix thinks with Endpoint's AI (nothing leaves the computer
for it). **Ask** in the top bar opens the chat; **Ask Fabrix** on a console tab shares that console with it, so it can
read what is on screen and help.

