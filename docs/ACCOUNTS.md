# FBRX accounts and payments (FBRX Command in the cloud)

From 2.0, FBRX Command can run in the cloud for everyone: people make an **FBRX account**, buy Standard or Ultra for
themselves, and sign in on any computer or phone, which then runs what the account bought. Organizations run their
own FBRX Command tenant there (see LICENSING.md, *Prices*). This page is for whoever runs that FBRX Command: what to set
up with each payment provider, and the API the apps and the website use.

Nothing here is on until it is set up: without `FBRX_CP_PUBLIC_SIGNUP=1` nobody can make an account, and each way to
pay stays off until its keys are there (`GET /v1/plans` says which are).

## How buying works

| Where | How people pay | Why |
| --- | --- | --- |
| The website and FBRX on a computer | **Stripe Checkout**: cards, and the Apple Pay and Google Pay wallets, which Checkout shows by itself where the person's browser and device have them | One hosted, PCI-compliant page; no card details ever reach FBRX |
| The iPhone and iPad app | **In-app purchase** (StoreKit 2) | The App Store's rules: an app that unlocks paid features sells them through the App Store |
| The Android app | **Google Play Billing** | The same rule on Google Play |

Every purchase, wherever it was made, becomes an **entitlement** on the account (one per subscription item or store
purchase, kept current by the provider's notifications). The account's edition is the fullest one its valid
entitlements give, so Ultra bought on a phone signs in on a Mac, a PC or Linux too. An account signs its computers up
with an ordinary FBRX license key (Ed25519, verified offline like any other): up to the edition bought, with no
organization in it, running a few days past the period paid for and never more than 35 days, so computers fetch a fresh
one as the subscription renews and a refund reaches them in time.

Black Hole is never sold to an account: it is an add-on in an FBRX Command tenant (LICENSING.md).

The phone apps themselves (building them, the products in each store, the store rules they follow) are in
[STORES.md](STORES.md).

## On a computer

**Settings → FBRX account** (or *I have an FBRX account* on the first screen) signs in, or makes a new account. The
computer brings the account's license and turns that edition on by itself ("whatever the account has"); it renews the
license every six hours while FBRX runs, and when the account's purchase ends, the computer goes back to what it had
(Essentials on its own). Signed in, **Get Standard** and **Get Ultra** open the checkout in the browser, and **Manage
billing** opens the Stripe portal; Settings → Edition offers the same on the locked editions. Signing out takes the
account's license away again. The account token is kept in the vault, like the computer's FBRX Command credential.

Which FBRX Command accounts live on is built into the app (`FBRX_ACCOUNT_SERVER` when building, or in the environment);
when none is, the sign-in asks for its address.

A license from an organization (FBRX Command, *managed*) always wins over an account's; between a key typed into
Settings → License and an account's, the fuller one counts.

### Offline accounts (local, no cloud)

A computer that runs FBRX without the cloud — a local-only environment, or the Beta before the account server is live
— can make an **offline account** instead: **Settings → Account → Make an offline account**. It is a local identity
(a name, an optional email, an optional start password) kept on the computer; it never reaches a server. It pairs
with a license key for its edition: a **Beta key**, or a key from a local FBRX Command (below). An optional start
password locks FBRX each time it starts: a lock on the screen, not encryption (to keep saved passwords encrypted
until you type a password, turn on the vault's own password at start, under Credentials). The cloud FBRX account and the offline account are separate; a computer uses
one or the other.

**Beta keys** are ordinary license keys with a tier and an expiry — for example Ultra until the Beta ends. Make them
from FBRX Command → Licenses (set the tier and an expiry date), or offline with `npm run license:issue -- --tier
ultra --expires 2026-12-31 --customer "Beta tester"`. The computer activates the key under Settings → License, as any
other.

A **local FBRX Command** — one an organization runs for itself (`deploy/control-plane`, with sign-up closed) — keeps
working as it always has: it issues license keys, enrolls computers and pushes policy, all on the organization's own
network with no dependence on FBRX's cloud. The cloud account server ([CLOUD.md](CLOUD.md)) is for the public, shared
FBRX Command; a local one needs none of it.

## Signing in, and getting back in

An account is an email and a password. FBRX emails a link to **confirm the address** when the account is made
(*Send it again* in Settings → FBRX account and on the website's account page); an account becomes an organization's
member, or starts an organization, only once its email is confirmed, so nobody can claim someone else's address.
**Forgot your password?** (in FBRX's sign-in, on the website and in the phone app) emails a link to choose a new one:
it works once, for an hour, and signs the account out everywhere. Both links open the website's account page
(`FBRX_CP_ACCOUNT_URL`), with the token after `#`, so it never reaches a server's logs.

Every sign-in says where it is: a **computer** (its name, system, FBRX version and install id), a **phone** (the
app) or the **website**. Settings → FBRX account → **Signed in on** and the website list them, and sign any of the others
out: its token stops working at once (a computer keeps the license it was given until it runs out, a few days at most).
The same install signing in again takes the place of its last sign-in, so each computer is listed once.

### Where accounts are kept

In the database of the FBRX Command that runs in the cloud for everyone (`control-plane.db` in its data folder, see
[CLOUD.md](CLOUD.md)):

| What | How it is kept |
| --- | --- |
| Email, name | As typed; the email is unique, whatever its capitals |
| Password | Never itself: a scrypt hash with its own salt, compared in constant time; ten wrong tries lock the account for a quarter of an hour |
| Sign-ins | One row each (where, when, last seen). The token the app keeps is signed by FBRX Command and names that row, so ending the row ends the token |
| Emailed links | Only a SHA-256 hash of each, used once, then expired (a week to confirm, an hour to reset) |
| Purchases | The provider's ids and states (`entitlements`): never a card number, which stays with Stripe, Apple or Google |
| License keys | Signed fresh from the account's purchases each time a computer asks; not stored |

Deleting the account deletes all of it (sign-ins, links, memberships and purchases' records go with it).

## Organizations and members

An organization's FBRX Command gives editions to people, not just computers: a **member** is an FBRX account the
organization added, with the edition it gives that person (`POST /v1/admin/members` `{ email, tier }`; Essentials
members cost nothing). A member who signs in on any computer sees the organization under **Your organizations** and
**Join this computer**: the computer enrolls with a one-time token (fifteen minutes) that carries the member's edition,
and turns it on. When the organization changes a member's edition, the computers they joined follow it; removing a
member leaves their computers in the organization on Essentials. This is how an admin signs in on any computer and gets
Black Hole there.

| | |
| --- | --- |
| `GET /v1/admin/members` | The organization's members, their editions and how many computers each joined |
| `POST /v1/admin/members` `{ email, tier }` | Adds an account (it must exist, with its email confirmed) |
| `PATCH /v1/admin/members/:accountId` `{ tier }` | Changes a member's edition, on their computers too |
| `DELETE /v1/admin/members/:accountId` | Removes a member |
| `POST /v1/accounts/memberships/:tenantId/enroll` | (The account) a one-time enrollment token for this computer |

## An organization's FBRX Command in the cloud

Anyone with an FBRX account can start an FBRX Command for their organization (Settings → FBRX account → **Start an
FBRX Command** in FBRX, or `POST /v1/accounts/tenants` `{ name, kind }`). They own it, sign in to its console with
the account's email and password, and are a member on Essentials. Nothing is charged until the owner starts the plan:

* **Billing** (owners pay; admins see it): **Start the FBRX Command plan** opens Stripe Checkout for the
  $54.99-a-month plan; **Manage billing** opens the Stripe portal. The page shows what a month comes to: the plan, and
  each computer at its edition's tenant price, counted from the editions the organization gives (Members, Devices,
  Profiles & groups): Standard $3.99 and Ultra $9.59 (20% off), Black Hole $24.99 (an add-on at full price),
  Essentials free. Student and child computers (only ever in an FBRX Command) run the learner edition and count as
  Standard, at its $3.99.
* The plan's per-computer items in Stripe follow the computers by themselves (a few seconds after a change, and every
  quarter of an hour), prorated by Stripe.
* While the plan runs, FBRX Command holds one license for the organization that allows everything; each computer runs
  what it was given, and **Essentials when nobody gave it anything**. Without the plan (not started, or ended), every
  computer runs Essentials.
* **Members** gives editions to people (above); **FBRX Server is coming** shows on Billing and the Overview: a
  one-time $100 purchase, not on sale yet, whose installer will stay on the FBRX Command or the account for good.

Organizations the operator sets up by hand (Tenants, `billing = manual`) keep working as before, with the licenses
the operator issues. The operator sees every account under **FBRX accounts**.

## Setting up

### Accounts

| Variable | |
| --- | --- |
| `FBRX_CP_PUBLIC_SIGNUP=1` | Anyone may make an FBRX account |
| `FBRX_CP_ACCOUNT_URL` | The website's account page, where Checkout and the billing portal send people back to and the emailed links open (default: `<public URL>/account`) |
| `FBRX_SMTP_URL` | Email for accounts (confirming an address, resetting a password), from any transactional email service: `smtps://user:password@smtp.example.com:465`. Without it nothing is sent, and the log says so |
| `FBRX_MAIL_FROM` | Who the email comes from (default `FBRX <no-reply@<public host>>`); use an address on a domain the email service is set up to send for |

### Stripe

1. In the Stripe Dashboard, make one product per plan with a **monthly recurring price**, and give each price the
   **lookup key** from `packages/shared/src/plans.ts`: `fbrx_standard_monthly` ($4.99), `fbrx_ultra_monthly` ($11.99),
   and for tenants `fbrx_standard_tenant_monthly` ($3.99), `fbrx_ultra_tenant_monthly` ($9.59),
   `fbrx_blackhole_tenant_monthly` ($24.99), `fbrx_command_tenant_monthly` ($54.99). FBRX finds prices by lookup key,
   so a price change in Stripe needs no new FBRX version (move the lookup key to the new price).
2. **Settings → Payment methods**: turn on cards, Apple Pay and Google Pay. For Apple Pay, verify the website's domain
   in Stripe.
3. **Settings → Billing → Customer portal**: turn it on, allow switching between the Standard and Ultra prices, and
   cancelling.
4. **Developers → Webhooks**: add `https://<FBRX Command>/v1/billing/stripe/webhook` with the events
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid` and `invoice.payment_failed`.

| Variable | |
| --- | --- |
| `FBRX_STRIPE_SECRET_KEY` | A restricted key with write access to Checkout Sessions, Customers, Customer portal and Subscriptions, and read access to Prices |
| `FBRX_STRIPE_WEBHOOK_SECRET` | The webhook's signing secret (`whsec_…`) |

A subscription that fails to renew keeps counting while Stripe retries (`past_due`), then ends.

### App Store

1. In App Store Connect, make an auto-renewable subscription group with `fbrx_standard_monthly` and
   `fbrx_ultra_monthly` as product ids.
2. **App Information → App Store Server Notifications**: Version 2, production and sandbox URL
   `https://<FBRX Command>/v1/billing/apple/notifications`.
3. Download **Apple Root CA - G3** from <https://www.apple.com/certificateauthority/> (`AppleRootCA-G3.cer`) to the
   server.

| Variable | |
| --- | --- |
| `FBRX_APPLE_BUNDLE_ID` | The app's bundle id |
| `FBRX_APPLE_ROOT_CA` | The path of `AppleRootCA-G3.cer` (DER or PEM; several, comma-separated) |
| `FBRX_APPLE_SANDBOX` | `1` turns on what TestFlight and sandbox purchases buy. They cost nothing, so only on a test FBRX Command |

The app makes each purchase with the account's **app account token** (a UUID FBRX keeps per account) and sends the
signed transaction to `POST /v1/billing/apple/transactions`. FBRX checks the certificate chain in the signature against
Apple's root, Apple's marker extensions on the signing certificates, the signature itself and the bundle id, before it
reads anything; a purchase made with another account's token, or already claimed by another account, is refused.

### Google Play

1. In the Play Console, make subscriptions `fbrx_standard_monthly` and `fbrx_ultra_monthly`, each with a monthly base
   plan.
2. In Google Cloud, make a service account, give it **View financial data** and **Manage orders and subscriptions** in
   the Play Console (Users and permissions), and download its JSON key.
3. **Monetization setup → Real-time developer notifications**: a Pub/Sub topic, with a **push** subscription to
   `https://<FBRX Command>/v1/billing/google/rtdn?token=<FBRX_GOOGLE_RTDN_TOKEN>`.

| Variable | |
| --- | --- |
| `FBRX_GOOGLE_PACKAGE_NAME` | The Android app's package name |
| `FBRX_GOOGLE_SERVICE_ACCOUNT` | The path of the service account's JSON key |
| `FBRX_GOOGLE_RTDN_TOKEN` | A long random secret for the push URL |
| `FBRX_GOOGLE_TEST_PURCHASES` | `1` turns on what license testers buy. They cost nothing, so only on a test FBRX Command |

The app buys with the account's id as the obfuscated account id and sends the purchase token to
`POST /v1/billing/google/purchases`. FBRX asks the Play Developer API what the purchase is (never the app, never the
notification), acknowledges it (Play refunds purchases nobody acknowledges within three days), and on an upgrade or a
downgrade ends the purchase it replaced.

## The API

| | |
| --- | --- |
| `GET /v1/plans` | The price list (`editions`, `command`, `server`), whether sign-up is open, and which ways to pay are set up |
| `POST /v1/accounts/signup` `{ email, name, password, device }` | Makes an account and emails the link to confirm it; answers with an account token (90 days) and the account. `device`: `{ name, kind: computer \| phone \| website, platform?, appVersion?, installId? }` (a name alone counts as a computer) |
| `POST /v1/accounts/login` `{ email, password, device }` | Signs in (ten wrong passwords lock the account for a quarter of an hour) |
| `POST /v1/accounts/logout` | Ends this sign-in |
| `GET /v1/accounts/sessions` | Where the account is signed in (`current`: this one) |
| `DELETE /v1/accounts/sessions/:id` | Signs one of them out |
| `POST /v1/accounts/verify` `{ token }` | Confirms the email (the emailed link) |
| `POST /v1/accounts/verify/resend` | Sends the link to confirm the email again |
| `POST /v1/accounts/password/forgot` `{ email }` | Emails a link to choose a new password (the same answer whether the account exists or not) |
| `POST /v1/accounts/password/reset` `{ token, password }` | Sets the new password from that link, and signs out everywhere |
| `GET /v1/accounts/me` | The account: its edition and what it bought |
| `GET /v1/accounts/license` | The license key the account signs a computer up to (`key: null` with nothing bought) |
| `POST /v1/accounts/password` `{ current, password }` | Changes the password and signs out everywhere else |
| `DELETE /v1/accounts/me` `{ password }` | Deletes the account and ends its Stripe subscriptions (store subscriptions end in the store's settings) |
| `POST /v1/billing/checkout` `{ productId }` | A Stripe Checkout page for Standard or Ultra |
| `POST /v1/billing/portal` | The Stripe customer portal: change plan or card, invoices, cancel |
| `POST /v1/billing/apple/transactions` `{ signedTransaction }` | A purchase from the iPhone or iPad app |
| `POST /v1/billing/google/purchases` `{ productId, purchaseToken }` | A purchase from the Android app |

The platform operator (superadmin) also has `GET /v1/admin/accounts?q=`, `POST /v1/admin/accounts/:id/grant`
`{ tier, days }` (an edition for support or a promotion; `days: null` for no end) and `POST /v1/admin/accounts/:id/status`.

## Before charging anyone

FBRX does the plumbing; these are yours to decide and set up: the business that sells (the Stripe account, the App
Store and Google Play developer accounts, their agreements and bank details), sales tax and VAT (Stripe Tax, or the
stores, which collect it for in-app purchases), the terms of sale and refund policy, and the privacy policy the stores
require. Test everything in Stripe's test mode, the App Store sandbox and a Play license tester first.
