# Support mode

Support mode is the way an FBRX support engineer, or the person who runs an organization's FBRX Command, gets full
access to **one computer's** FBRX apps (FBRX OS and FBRX Browser) to troubleshoot — without that power being free for
anyone who learns a phrase.

Typing the support phrase alone does nothing. It asks for a **support pass**: a short-lived token, signed by FBRX's
own license key and tied to that one computer, that the apps verify offline. While a valid pass is active the computer
runs as Black Hole with every feature on, settings an organization locked can be changed, and everything done is
written to the audit log (and reported to FBRX Command on a managed computer). The resume phrase, or the pass running
out, puts the computer back exactly as it was.

## Using it

1. On the computer, type **`418teapotadmin`** into the license box (Settings → License), Spotlight, or FBRX Browser's
   address bar. It asks for a support pass.
2. Paste the support pass. The computer goes into support mode: full access, with a bar across every FBRX window
   saying so.
3. When you are done, type **`refusetobrew`** (anywhere the phrase is taken, or the “End support” button on the
   banner). The computer goes back to the edition and settings it had. It also ends on its own when the pass runs out.

A pass is for one computer only; its install id is on Settings → License. Nothing on a server changes.

## Making a support pass

**From FBRX Command** (an admin with the `licenses.manage` permission):

```
POST /v1/admin/support-passes
{ "installId": "<the computer's install id>", "hours": 4, "tier": "blackhole", "note": "Ticket 1234" }
```

It returns `{ pass, expiresAt, tier }`. Hand the pass to the computer.

**Offline, with the signing key** (`npm run keys:generate`), no FBRX Command needed:

```bash
npm run support:pass -- --install-id <id> [--hours 4] [--tier blackhole|ultra|basic] [--note "Ticket 1234"] [--by you@fbrx]
```

The build must carry the matching public key (the same one that verifies license keys), so a pass made with the
project's signing key works on the builds made from it.

## Why it is safe

- **A pass cannot be forged.** It is Ed25519-signed by the control plane's license key; a build only trusts passes
  signed by the key it carries.
- **A pass is for one computer.** It names that computer's install id; a pass for another computer is refused.
- **A pass is short-lived.** At most 12 hours (4 by default), and it ends on its own.
- **Everything is audited.** Starting and ending support, and every change made while it is on, are in the tamper-
  evident audit log; on a computer in an organization, FBRX Command is told too.
- **It reaches the apps on a computer only** — FBRX OS and FBRX Browser. FBRX Command and FBRX Server have their own
  administrator accounts; support mode does not touch them.
