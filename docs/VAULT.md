# The Vault

The Vault (Protect → **Vault**, Endpoint Standard and up) keeps your passwords and the keys FBRX uses, encrypted on
this computer. It has three parts:

* **Passwords**: your sign-ins for websites and devices, which FBRX Browser fills in for you.
* **Keys & tokens**: API keys, tokens and passwords that tools, plugins and connections refer to by name (an AI
  service's key, an email password for alerts…).
* **Security**: how the Vault is locked and unlocked, and how the password keeper behaves.

Everything in it is encrypted with AES-256-GCM under a key only this computer, or your vault password, can open. See
[SECURITY.md](SECURITY.md#credentials) for how the key is kept.

## Passwords

Each sign-in has a **website** (or several), a **username**, a **password**, an optional **2-step key** and
**notes**. All of it is encrypted, the site and username too: without the Vault, the database says nothing about
where you have accounts.

* **Search and filters**: All, Favorites, **Needs attention** (a weak password, one shared with another sign-in, or
  one not changed in over a year) and **2-step codes**.
* **Copy** the username or the password. A copied password stays out of FBRX's clipboard history and leaves the
  clipboard after 30 seconds, unless you copied something else since (Security → *Clear a copied password…*).
* **Show** the password (it hides again after 30 seconds), open the site in FBRX Browser, or **Edit**: the dice
  button makes a new strong password, and the meter shows how strong one is.
* **2-step codes**: paste the key a site shows when you turn on 2-step sign-in (or the `otpauth://` address its QR
  code holds) and the Vault shows the six-digit code beside the password, as an authenticator app does.
* **Earlier passwords**: when a password changes, the old one is kept (the last five), in case the change did not
  take on the site.
* **Import**: export your passwords as a CSV file from your browser or another password manager, then **Import** it
  here. The columns are found by name (most browsers and password managers are understood); a sign-in the Vault
  already has gets the file's password when it differs. Delete the exported file afterwards: it holds your passwords
  in plain text.

## Save to Vault, from anywhere

* **Add sign-in** on the Vault page.
* **The password generator** (Workbench → Toolbox → Passwords): each new password has **Copy** and **Save to Vault**.
* **The right-click menu**: on a filled password box, or on a password you picked in any text, **Save to Vault…**.
* **Fabrix**: ask it to keep a password and it opens the Save to Vault window, filled in with the site and username,
  for you to type the password there. Ask it to sign you up somewhere or change a password and it saves a sign-in
  with a new strong password FBRX makes (after you say yes). Ask "are any of my passwords weak?" and it checks.
* **FBRX Browser**, when you sign in to a site (below).

When a new sign-in is for a site and username the Vault already has, saving updates that one instead of keeping two.

## FBRX Browser fills them in

FBRX Browser has the Vault built in, like a password manager's browser extension:

* Click into a site's sign-in box and your sign-ins for that site show beside it: pick one and FBRX fills in the
  username and password. The key in the address bar does the same for a page with a sign-in form.
* On a sign-up or change-password form, **Use a strong password** puts a new strong password in both boxes.
* After you sign in with something the Vault does not have, FBRX offers to **Save** it (or to **Update** the
  password it has for that site and username). **Never for this site** stops asking there (Security lists those
  sites, to undo it).
* The side panel's **Saved sign-ins** (the menu) lists this site's sign-ins first, with Fill in, Copy username and
  Copy password, and **Add a sign-in**.

How it stays safe:

* The sign-in helper in each page runs in a world of its own, which the page's scripts cannot see or call, and in
  the page's main frame only (never in an embedded frame).
* A sign-in goes only to a page on one of its sites (the core checks the page's address, not the page's word), and
  one saved for a secure (`https://`) page is never offered on an insecure one. Sites on shared hosting (each name
  under `github.io`, for example) count as different sites.
* Nothing is filled in by itself: you pick the sign-in. It goes only into boxes you can see.
* Private tabs can fill in sign-ins but never offer to save one.

## Fabrix and your passwords

Fabrix never sees a password or a username. Its tools find sign-ins by name and site and report their health
(*passwords.find*), open the Save to Vault window for you to type a password (*passwords.offer_save*), and save a
sign-in with a password FBRX makes without showing it (*passwords.create*, which asks you first). Every password in
the Vault is also scrubbed from anything a tool hands back to a model, as the keys are.

## Locking

The Vault unlocks by itself on this computer, unless **Ask for it every time FBRX starts** is on (Security). **Lock
now** clears the key from memory: sign-ins cannot be listed, filled in or saved until you unlock it with the vault
password or FBRX starts again. A backup carries the Vault, protected by the backup passphrase.
