# Support mode

Support mode is the way an FBRX support engineer, or the person who runs an organization's FBRX Command, gets full
access to **one computer's** FBRX apps (FBRX OS and FBRX Browser) to troubleshoot, without that power being free for
the taking.

It takes a **support pass**: a short-lived token, signed by FBRX's own license key and tied to that one computer, that
the apps verify offline. While a valid pass is active the computer runs as Black Hole Edition with every feature on, settings
an organization locked can be changed, and everything done is written to the audit log (and reported to FBRX Command
on a managed computer). Ending it, or the pass running out, puts the computer back exactly as it was.

## Using it

1. Open **Settings → License → Support access** on the computer. It shows the computer's **install id**, with a copy
   button: give it to whoever is helping you.
2. They send back a support pass. Paste it into **Support pass** and choose **Start support mode**. (Pasting it into
   the license box, Spotlight or FBRX Browser's address bar works too.) The computer goes into support mode: full
   access, with a bar across every FBRX window saying so.
3. When you are done, choose **End support now** (in Support access, or **End support** on the bar). The computer goes
   back to the edition and settings it had. It also ends on its own when the pass runs out.

On a computer in an organization, its FBRX Command can also **start support mode for you**: the pass goes straight to
the computer, and a notification says support mode is on. Ending it works the same way.

A pass is for one computer only. Nothing on a server changes.

## On an organization's computers

A computer that belongs to an organization (joined to its FBRX Command) takes:

- **A pass its own organization made** (in its FBRX Command) at any time. The organization already looks after the
  computer; nothing else needs turning on.
- **A pass from anyone else**, FBRX support included, only when the organization has turned FBRX support access on:
  the managed setting `support.allowOnManaged`, off by default, set in FBRX Command's settings for its computers. Until
  then such a pass is refused, so nobody outside the organization can unlock its computers, or settings it locked,
  without its say-so. If the organization turns it off again, that support session ends at once.

A computer on its own always takes a valid pass.

## Making a support pass

**From FBRX Command** (an admin with the `licenses.manage` permission):

- **Devices → the computer → Support pass.** Pick how long (1 to 12 hours) and what it runs as, and add a note (a
  ticket number). **Start support now** sends it to the computer (this needs permission to send privileged commands):
  support mode starts as soon as the computer is online. **Make a pass to paste** shows the pass instead, once, with a
  copy button.
- **Licenses → Support pass**, for any computer: paste its install id (Settings → License → Support access on that
  computer), then **Make the pass**.

The same, by API:

```
POST /v1/admin/support-passes
{ "deviceId": "<a computer in Devices>", "hours": 4, "tier": "blackhole", "note": "Ticket 1234" }
```

`installId` can stand in for `deviceId`. It returns `{ pass, expiresAt, tier, installId }`. To start it on the
computer, send it the `support.start` command with `{ "pass": "<the pass>" }`.

## Why it is safe

- **A pass cannot be forged.** It is Ed25519-signed by the control plane's license key; a build only trusts passes
  signed by the key it carries.
- **A pass is for one computer.** It names that computer's install id; a pass for another computer is refused.
- **A pass is short-lived.** At most 12 hours (4 by default), and it ends on its own.
- **Everything is audited.** Starting and ending support, and every change made while it is on, are in the tamper-
  evident audit log; on a computer in an organization, FBRX Command is told too. FBRX Command's own lists of sent
  commands never show the pass itself.
- **An organization decides for its computers.** Only its own FBRX Command, or someone it has allowed, can start
  support mode on them, and its FBRX Command is told when a session starts and ends.
- **It reaches the apps on a computer only**: FBRX OS and FBRX Browser. FBRX Command and FBRX Server have their own
  administrator accounts; support mode does not touch them.
