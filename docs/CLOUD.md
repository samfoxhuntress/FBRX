# FBRX in the cloud

What FBRX runs online for everyone, and where. Each piece is open source in this repository; none of it is running
until someone with the accounts below sets it up.

| Piece | What it is | Runs where |
| --- | --- | --- |
| **The account server** | FBRX Command in its cloud mode (`FBRX_CP_PUBLIC_SIGNUP=1`): FBRX accounts and their sign-ins, purchases, organizations' FBRX Command tenants, and the license keys computers are signed up to ([ACCOUNTS.md](ACCOUNTS.md)) | One Linux server you rent, in Docker (`deploy/control-plane`) |
| **The website** | Home, pricing and the account page: plain files built from the price list (`apps/website`) | Any static host |
| **Email** | Confirming an account's address and resetting its password | A transactional email service, over SMTP |
| **Payments** | Cards and wallets on the website and computers; in-app purchases on phones | Stripe, the App Store and Google Play: no card number ever reaches FBRX |

## The account server

The database of FBRX accounts is the account server's own: `control-plane.db` (SQLite, in WAL mode) in its data folder,
next to its keys. What it keeps of an account, and how, is in
[ACCOUNTS.md → Where accounts are kept](ACCOUNTS.md#where-accounts-are-kept): passwords only as salted scrypt hashes,
sign-ins as rows a token names (so any can be ended), emailed links only as hashes.

**A server.** One small Linux virtual machine is plenty for the Beta (2 vCPUs, 4 GB of memory, 40 GB of disk; a few
tens of dollars a month at any cloud provider). Pick a provider with encrypted disks and scheduled snapshots, in the
region most of your customers are in. One server keeps the database simple and fast; SQLite serves many thousands
of accounts on it.

**Setting it up.**

1. Point a name at the server, such as `account.<your domain>`, and copy `deploy/control-plane/.env.example` to
   `.env` there: `FBRX_DOMAIN`, the first administrator, and the *FBRX accounts in the cloud* part (public sign-up,
   the website's account page and origin, email, and each way to pay as it is ready).
2. `docker compose -f deploy/control-plane/docker-compose.yml --env-file deploy/control-plane/.env up -d`: FBRX Command
   behind Caddy, which gets and renews the HTTPS certificate by itself.
3. Build the apps with `FBRX_ACCOUNT_SERVER=https://account.<your domain>` (the desktop app, the phone apps and the
   website), so they sign in there.

**Keep it safe.**

- The `.env` file holds the payment keys and the email password: readable by root only, never in git. The server's
  keys (`keys/` in the data volume, or `FBRX_CP_JWT_SECRET`, `FBRX_CP_MASTER_KEY` and `FBRX_LICENSE_PRIVATE_KEY` from
  a secrets manager) sign every license and sign-in: losing them signs everyone out and stops licenses renewing.
- Back up every day, off the server: the provider's disk snapshots, and a consistent copy of the database with the
  keys, as in [BACKUP_RESTORE.md → The control plane](BACKUP_RESTORE.md#the-control-plane), to storage in another
  region, encrypted.
- Only ports 80 and 443 open; sign in to the server with SSH keys only; turn on the operating system's automatic
  security updates; watch `https://account.<your domain>/healthz` with an uptime check.
- The administrator signs in to the console with two-step verification (its Account page).

## The website

`npm run build -w @fbrx/website` with `FBRX_ACCOUNT_SERVER` set writes the whole site to `apps/website/dist`: HTML,
one stylesheet and two small scripts, with a strict content security policy. Any static host serves it; one with a
global network and automatic HTTPS, building from this repository on each push to the default branch, is the least to
look after. Serve it on the bare domain (`<your domain>`), and set on the account server:

- `FBRX_CP_WEBSITE_ORIGINS=https://<your domain>` (the website may call the account API from the browser)
- `FBRX_CP_ACCOUNT_URL=https://<your domain>/account.html` (Checkout comes back to it, and the emailed links open on it)

The terms of use and privacy policy pages the app stores ask for can live on the website too (`FBRX_TERMS_URL`,
`FBRX_PRIVACY_URL` for the phone apps, [STORES.md](STORES.md)).

## Email

Any transactional email service with SMTP works. Set it up to send for your domain (its SPF, DKIM and DMARC records
in your DNS, so the email is not taken for spam), then give the account server `FBRX_SMTP_URL` and `FBRX_MAIL_FROM`
(an address on that domain). Without them, accounts still work, but no link is emailed: nobody can confirm an
address or reset a password, so set it up before opening sign-up.

## Going live, in order

1. A domain, and the business accounts: a payment processor, an Apple Developer Program membership, a Google Play
   developer account, an email service, a server.
2. The account server (above), with sign-up still closed; try it with test payments.
3. The website, with the terms of use and the privacy policy.
4. The apps built against the account server: the desktop app's next release, and the phone apps through TestFlight
   and Google Play's testing tracks ([STORES.md](STORES.md)).
5. Open sign-up (`FBRX_CP_PUBLIC_SIGNUP=1`) and turn on real payments.
