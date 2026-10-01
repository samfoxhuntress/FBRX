# Mesh and FBRX Mobile

The mesh links one person's devices: this computer, their other FBRX OS computers and their phone. It is off until
you turn it on in **Mesh & phone**; then FBRX listens on port 47800 (configurable) on the local network.

## What paired devices can do

Each device gets its own permissions on *this* computer, changeable at any time and effective immediately:

| Permission | Phones (default) | Computers (default) |
| --- | :-: | :-: |
| See status (health, performance, services) | ✔ | ✔ |
| Messages and notifications | ✔ | ✔ |
| Ask this computer's agent | ✔ | |
| Approve or deny waiting actions | ✔ | |
| Tasks and notes | ✔ | |
| Receive alerts | ✔ | |
| Remote control (lock, sleep) | | |

Requests from another *computer* follow **When another computer asks this computer's agent**: ask me first (an
approval appears here), allow, or never; a device can never approve its own request. Phones you pair are yours, so
their requests skip that first question (turn off *Ask the agent* for a phone to stop them). Either way the agent runs
under this computer's policy: each risky tool call still waits for an approval.

**FBRX Mobile** is a small web app the computer serves to paired phones at `http://<computer>:47800/m/`. Add it to
the home screen. It shows status, alerts, tasks, messages and waiting approvals, lets you ask the agent, and can
make the phone ring (*Find my phone*). It refreshes while open; phones are not woken in the background.

## Pairing

1. **Mesh & phone → Pair a device** shows a QR code and a 20-character one-time code (100 bits), valid for five
   minutes.
2. A phone scans the QR code (it contains the computer's address, the code and the computer's key fingerprint);
   another computer uses **Join a computer** and types the address and code.
3. The joining device creates its own X25519 key pair and sends its public key with
   `HMAC-SHA512(code, "fbrx-pair-v1" | its key | the computer's key)`. The computer checks it, stores the device and
   answers with its own HMAC over both keys and the new device id, which the joining device checks before trusting
   the computer. Both sides have proved they know the code, so a device in the middle cannot substitute its keys.
4. The code is used once. Five wrong attempts end the pairing session (and notify you); pairing requests are also
   rate-limited per address.

Compare the fingerprints shown on both screens if you want to be certain.

## Every request

Requests between paired devices are JSON sealed with NaCl `box` (X25519 + XSalsa20-Poly1305) using the sender's
secret key and the recipient's public key, so each request is both encrypted and authenticated. Each carries a
random id and a timestamp; the receiver refuses requests older or newer than two minutes and any id it has already
seen. Replies are sealed the same way and tied to the request id. Removing a device deletes its key; its next request
is refused.

The computer's secret key lives in the credential vault (encrypted under the OS keychain). The phone's key lives in
the phone's browser storage for the FBRX Mobile page.

## Limits to know about

* **Local network only.** The mesh is meant for your home or office network. To reach your devices from elsewhere,
  use a VPN into that network rather than forwarding the port.
* **The phone app arrives over plain HTTP.** Requests are end-to-end encrypted, but the web page itself is served
  unencrypted by your computer, so someone actively attacking your local network at the moment you open FBRX
  Mobile could tamper with the page. Pair and use the phone app on networks you trust. (A future native app removes
  this.)
* **Windows Firewall** asks once whether FBRX OS may accept connections; allow it on *private* networks only.
* Clocks must be within two minutes of each other.

## Organizations

The mesh is per person. Administrators can switch it off for a tenant or group by locking `mesh.enabled` to `false`
in managed settings; device pairing, requests and permission changes are written to the audit log
(`category: mesh`).
