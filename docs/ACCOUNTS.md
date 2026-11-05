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

**Each computer, up to those the edition covers.** An edition covers as many computers as it includes (2 for Standard,
5 for Ultra; the operator's price list, LICENSING.md) and the extra ones bought on top. Each computer signed in to the
account gets a key of its own, carrying its install id, which no other computer accepts. Computers count in the order
they first signed in, so signing in again keeps a computer's place; one past them runs Essentials and says why
(**Settings → FBRX account**), with **Add a computer** when the plan was bought on the website or in FBRX: it adds the
edition's extra-computer item (`fbrx_standard_extra_computer_monthly`, `fbrx_ultra_extra_computer_monthly`) to the
Stripe subscription, prorated. The App Store and Google Play sell no extra computers. Signing a computer out frees its
place: that computer gives its key back the next time it renews (every six hours while FBRX runs). When a plan moves to
the other edition in the Stripe portal, its extra computers move with it, at that edition's price.

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
out: its token stops working at once, and the computer gives back the license it was given the next time it renews (a
computer whose sign-in simply ended keeps it until it runs out).
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

### Inviting someone without an FBRX account (no website or email needed)

**Members → Add a member** takes an email and an edition. When that email has a confirmed FBRX account, it is added
at once. Otherwise FBRX Command makes an **invitation**: a code like `FBRX-7K3M-Q9TD-2HXP-W4NC`, shown once to the admin
(with the FBRX Command address to go with it) and emailed too when this FBRX Command sends email. The person, in FBRX
OS, opens **Settings → Account → I have an invitation**, enters the code (and the FBRX Command address if FBRX asks),
sees which organization invited them and at what edition, and either chooses a password (a new account) or enters the
password of the account that email already has. FBRX Command makes or confirms the account, adds it as a member, and
the computer signs in and joins the organization at that edition, all in one step.

* The code works once, for 14 days (the API takes `days`, 1 to 90). Inviting the same email again replaces the old
  code; **Withdraw** in the Invitations list ends one. Only the code's hash is kept.
* The invitation counts as confirming the email (the organization gave the code to that person). If someone else had
  made an account with that email and never confirmed it, the password the invited person chooses replaces theirs and
  their sign-ins end.
* Codes work while public sign-up is off, so an FBRX Command can take only the people it invites.
* A computer already in another organization still signs in; it lists the new organization with its **Join this
  computer** button.

| | |
| --- | --- |
| `GET /v1/admin/members` | The organization's members, their editions and how many computers each joined |
| `POST /v1/admin/members` `{ email, tier }` | Adds an account (it must exist, with its email confirmed) |
| `PATCH /v1/admin/members/:accountId` `{ tier }` | Changes a member's edition, on their computers too |
| `DELETE /v1/admin/members/:accountId` | Removes a member |
| `GET /v1/admin/invitations` | Invitations not used yet (pending or expired) |
| `POST /v1/admin/invitations` `{ email, tier, days? }` | Adds the member now, or invites them: `{ kind: 'added', member }` or `{ kind: 'invited', invitation, code, server, emailed }` |
| `DELETE /v1/admin/invitations/:id` | Withdraws an invitation |
| `POST /v1/accounts/invitations/preview` `{ code }` | (Anyone with the code) the organization, email and edition it is for, and whether the email has an account |
| `POST /v1/accounts/invitations/accept` `{ code, password, name?, device }` | Makes or confirms the account, adds it, and signs in: like `login`, plus `tenantId` |
| `POST /v1/accounts/memberships/:tenantId/enroll` | (The account) a one-time enrollment token for this computer |

## An organization's FBRX Command in the cloud

Anyone with an FBRX account can start an FBRX Command for their organization (Settings → FBRX account → **Start an
FBRX Command** in FBRX, or `POST /v1/accounts/tenants` `{ name, kind }`). They own it, sign in to its console with
the account's email and password, and are a member on Essentials. Nothing is charged until the owner starts the plan:

* **Billing** (owners pay; admins see it): the owner chooses **Monthly** or **Yearly** (a year at the price list's
  months, ten to start), and **Start the FBRX Command plan** opens Stripe Checkout for the organization fee at that
  interval; **Manage billing** opens the Stripe portal. Everything on the plan is paid the same way. A running plan
  moves to the other with **Pay yearly** or **Pay monthly**: every item goes to its price at the new interval in one
  update, and Stripe starts the new period that day, crediting what is left of the old one. The page shows what a month
  or a year comes to: the plan;
  each member at the edition the organization gives them, once whatever number of its computers they join, up to
  those their edition includes (2 Standard, 5 Ultra, 15 Black Hole), and each further computer of theirs at its extra
  price; and each paid computer no paying member uses (shared, lab and student computers) at its edition's price.
  The prices are the operator's price list (LICENSING.md); Essentials is free. Student and child computers (only ever
  in an FBRX Command) run the learner edition and count as Standard. **Members** shows who uses more computers than
  their edition includes.
* The plan's per-person and per-computer items in Stripe follow by themselves (a few seconds after a change, and every
  quarter of an hour), at the plan's interval, prorated by Stripe.
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

1. The prices: set them in FBRX Command → **Pricing**, then press **Update Stripe** there. It makes a **monthly
   recurring price** in Stripe for each one Stripe lacks or charges differently, under its **lookup key** from
   `packages/shared/src/plans.ts`: `fbrx_standard_monthly` and `fbrx_ultra_monthly` (on their own); for organizations
   `fbrx_standard_tenant_monthly`, `fbrx_ultra_tenant_monthly` and `fbrx_blackhole_tenant_monthly` (each computer),
   `fbrx_command_tenant_monthly` (the organization fee), `fbrx_command_large_monthly` and `fbrx_command_home_monthly`
   (only when larger or Home organizations pay another fee), `fbrx_standard_extra_computer_monthly`,
   `fbrx_ultra_extra_computer_monthly` and `fbrx_blackhole_extra_computer_monthly` (each computer past those an
   edition includes) and `fbrx_mdm_tenant_monthly` (the MDM add-on); and for organizations paying yearly, a **yearly
   price** of each organization price under the same key ending in `_yearly` (`fbrx_command_tenant_yearly`, …), on the
   monthly price's product, so the volume discount's coupon covers both. You can
   also make them by hand in the Stripe Dashboard, one product per price, with those lookup keys; the Pricing page says
   which agree. A new price takes the lookup key from the old one, so a price change needs no new FBRX version. People
   who already pay keep their price (FBRX remembers every price it saw under a key); organizations move to the new
   one at their next seat update. The volume discount is a coupon FBRX Command makes by itself
   (`fbrx_volume_<percent>_…`), on the computers' prices only.
2. **Settings → Payment methods**: turn on cards, Apple Pay and Google Pay. For Apple Pay, verify the website's domain
   in Stripe.
3. **Settings → Billing → Customer portal**: turn it on, allow switching between the Standard and Ultra prices, and
   cancelling.
4. **Developers → Webhooks**: add `https://<FBRX Command>/v1/billing/stripe/webhook` with the events
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid` and `invoice.payment_failed`.

| Variable | |
| --- | --- |
| `FBRX_STRIPE_SECRET_KEY` | A restricted key with write access to Checkout Sessions, Customers, Customer portal, Subscriptions, Prices, Products and Coupons |
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
| `GET /v1/accounts/license` | The license key the account signs this computer up to, for its install only: `key: null` with nothing bought, or when the edition's computers are taken (`note` says why). `computers`: how many are signed in, how many the edition covers (`allowed` = `included` + `extra`), an extra computer's price, and whether one can be added. A computer signed out answers 401 `SIGNED_OUT` |
| `POST /v1/accounts/password` `{ current, password }` | Changes the password and signs out everywhere else |
| `DELETE /v1/accounts/me` `{ password }` | Deletes the account and ends its Stripe subscriptions (store subscriptions end in the store's settings) |
| `GET /v1/accounts/ai` | The account's FBRX Cloud AI this month: its allowance, what it used, extra tokens, and whether it takes chats ([CLOUD_AI.md](CLOUD_AI.md)) |
| `POST /v1/accounts/promo` `{ code }` | Uses a promo code: extra FBRX Cloud AI tokens, an edition for some days, or both (once per account) |
| `POST /v1/billing/checkout` `{ productId }` | A Stripe Checkout page for Standard or Ultra |
| `POST /v1/billing/computers` `{ extra }` | Sets how many extra computers (0 to 100) the account's Stripe plan carries, prorated; answers with this computer's license |
| `POST /v1/billing/portal` | The Stripe customer portal: change plan or card, invoices, cancel |
| `POST /v1/billing/apple/transactions` `{ signedTransaction }` | A purchase from the iPhone or iPad app |
| `POST /v1/billing/google/purchases` `{ productId, purchaseToken }` | A purchase from the Android app |

The platform operator (superadmin) also has `GET /v1/admin/accounts?q=`, `POST /v1/admin/accounts/:id/grant`
`{ tier, days }` (an edition for support or a promotion; `days: null` for no end) and `POST /v1/admin/accounts/:id/status`,
and FBRX Cloud AI's allowances, per-account limits and promo codes ([CLOUD_AI.md → The API](CLOUD_AI.md#the-api)).

An organization's console has its plan: `GET /v1/admin/billing?interval=month|year` (the plan and its bill; before it
runs, the bill paying that way), `POST /v1/admin/billing/checkout` `{ interval }` (Stripe Checkout for the plan, monthly
or yearly), `POST /v1/admin/billing/interval` `{ interval }` (moves a running plan to the other), `POST
/v1/admin/billing/portal` and `POST /v1/admin/billing/sync` (brings its items up to date now).

## Before charging anyone

FBRX does the plumbing; these are yours to decide and set up: the business that sells (the Stripe account, the App
Store and Google Play developer accounts, their agreements and bank details), sales tax and VAT (Stripe Tax, or the
stores, which collect it for in-app purchases), the terms of sale and refund policy, and the privacy policy the stores
require. Test everything in Stripe's test mode, the App Store sandbox and a Play license tester first.
