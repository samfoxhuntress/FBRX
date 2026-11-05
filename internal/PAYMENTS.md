# Running FBRX accounts and payments

Setting up the FBRX account server's payments (Stripe, the App Store, Google Play), its API, and what to do before charging anyone. How accounts and buying work for people: [ACCOUNTS.md](../docs/ACCOUNTS.md).

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
   `packages/shared/src/plans.ts`: `fbrx_standard_monthly` and `fbrx_ultra_monthly` (on their own, and
   `fbrx_standard_yearly` and `fbrx_ultra_yearly` paid yearly); for organizations
   `fbrx_standard_tenant_monthly`, `fbrx_ultra_tenant_monthly` and `fbrx_blackhole_tenant_monthly` (each computer),
   `fbrx_command_tenant_monthly` (the organization fee), `fbrx_command_large_monthly` and `fbrx_command_home_monthly`
   (only when larger or Home organizations pay another fee), `fbrx_standard_extra_computer_monthly`,
   `fbrx_ultra_extra_computer_monthly` and `fbrx_blackhole_extra_computer_monthly` (each computer past those an
   edition includes) and `fbrx_mdm_tenant_monthly` (the MDM add-on); and, for paying yearly, a **yearly price** of
   each under the same key ending in `_yearly` (`fbrx_command_tenant_yearly`, …), on the monthly price's product, so
   the volume discount's coupon covers both. You can
   also make them by hand in the Stripe Dashboard, one product per price, with those lookup keys; the Pricing page says
   which agree. A new price takes the lookup key from the old one, so a price change needs no new FBRX version. People
   who already pay keep their price (FBRX remembers every price it saw under a key); organizations move to the new
   one at their next seat update. The volume discount is a coupon FBRX Command makes by itself
   (`fbrx_volume_<percent>_…`), on the computers' prices only.
2. **Settings → Payment methods**: turn on cards, Apple Pay and Google Pay. For Apple Pay, verify the website's domain
   in Stripe.
3. **Settings → Billing → Customer portal**: turn it on, allow switching between the Standard and Ultra prices,
   monthly and yearly (all four), and cancelling.
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
| `GET /v1/accounts/ai` | The account's FBRX Cloud AI this month: its allowance, what it used, extra tokens, and whether it takes chats ([CLOUD_AI.md](../docs/CLOUD_AI.md)) |
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
