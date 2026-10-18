# FBRX in the app stores

| App | Store | Built from | Kept up to date by |
| --- | --- | --- | --- |
| **FBRX** for iPhone and iPad | App Store | `store/mobile`: FBRX Mobile (`packages/core/mobile`) in a native shell, with in-app purchases | The App Store |
| **FBRX** for Android | Google Play | `store/mobile`, the same app | Google Play |
| **FBRX OS** for Windows | Microsoft Store | `apps/desktop`: `npm run package:store` (MSIX) | The Microsoft Store |
| **FBRX OS** for Mac | Not in the Mac App Store | `apps/desktop`, signed and notarized ([DEPLOYMENT.md](DEPLOYMENT.md)) | FBRX itself |

The Mac App Store only takes sandboxed apps, and the sandbox does not allow what FBRX OS does on a computer (the
terminal, other apps' settings, the local AI runtime, network scans, backups of the whole disk). FBRX OS for Mac stays
a signed, notarized download.

Nothing here publishes anything: each store gets a build only when someone with its developer account uploads one.

## FBRX 2.0 is the Beta

Each store has a way to hand a build to testers before everyone:

| Store | Beta track | Purchases there |
| --- | --- | --- |
| App Store | **TestFlight**: internal testers right away, external testers (up to 10,000) after Beta App Review | Made in the sandbox: nothing is charged |
| Google Play | **Internal testing**, then **Closed testing** | Made by license testers (Play Console → Setup → License testing): nothing is charged |
| Microsoft Store | **Private audience** (Partner Center → Availability) or **Package flights** for a group of testers | The FBRX account and checkout, like the download |

A purchase that charged nothing turns nothing on, so a test build cannot unlock a real account. A test FBRX Command
(never the real one) takes them with `FBRX_APPLE_SANDBOX=1` and `FBRX_GOOGLE_TEST_PURCHASES=1` ([ACCOUNTS.md](ACCOUNTS.md)).

## The phone app (`store/mobile`)

The same FBRX Mobile a computer serves to phones in a browser, plus what only an app can do:

- **Pairing by camera**: *Scan the code* reads the QR code under **Mesh & phone → Add a device → Show a code on this
  computer** (the computer's address, the one-time code and its key fingerprint). *Type it instead* takes the address
  and the code. Pairing is the same as from the browser ([MESH.md](MESH.md#pairing)); the app keeps the address.
- **The FBRX account**: sign in or make an account, buy Standard or Ultra through the store, **Restore purchases**,
  **Manage subscription** (the store's own page), sign out, delete the account. What is bought turns on in every
  computer signed in to the same account ([ACCOUNTS.md](ACCOUNTS.md)).
- On a computer running Essentials, *See the editions* on Home opens the account here instead of pointing at the
  computer.

`window.FBRX_NATIVE` (set by `src/native.js`) is how `app.js` knows it runs in the app; without it, nothing changes in
the browser version.

### Build it

You need Node, and Xcode on a Mac for iOS or Android Studio for Android.

```bash
cd store/mobile
npm install
FBRX_ACCOUNT_SERVER=https://command.example.com \
FBRX_TERMS_URL=https://example.com/terms FBRX_PRIVACY_URL=https://example.com/privacy \
  npm run ios        # or: npm run android
```

`npm run ios` and `npm run android` build `www/` (`scripts/build.mjs`), copy it into the native project and open it
in Xcode or Android Studio. Without `FBRX_ACCOUNT_SERVER` the account screen says FBRX accounts open soon.

| | |
| --- | --- |
| Version | `store/mobile/package.json`. The build writes it into the Xcode project and `android/app/build.gradle`, with the build number `major * 10000 + minor * 100 + patch`; set `FBRX_BUILD_NUMBER` higher to upload the same version again |
| App id | `com.fbrx.mobile`, in `capacitor.config.ts`, the Xcode project and `android/app/build.gradle`. Change it in all three, and set FBRX Command's `FBRX_APPLE_BUNDLE_ID` and `FBRX_GOOGLE_PACKAGE_NAME` to match |
| Icons and splash | `npm run assets`, from `assets/` (made by `apps/desktop/scripts/make-icons.mjs` with the other FBRX icons) |
| In-app purchases | `plugins/fbrx-purchases`: StoreKit 2 (Swift) and Play Billing 8 (Java) |
| QR codes | `@capacitor/barcode-scanner` |

The native projects (`ios/`, `android/`) are kept in the repository; their build output, local SDK paths and signing
keys are not. CI does not build the store apps: that needs Xcode, the Android SDK and the store signing keys. Build
and test them on a Mac and an Android device before each upload.

### Sell the editions

The product ids come from the price list (`packages/shared/src/plans.ts`) and are the same everywhere.

**App Store Connect**: one auto-renewable subscription group with `fbrx_standard_monthly` ($4.99) and
`fbrx_ultra_monthly` ($11.99), Ultra ranked above Standard so a change between them is an upgrade or a downgrade. Turn
on the **In-App Purchase** capability for the app id (Xcode → Signing & Capabilities). Set up the server side as in
[ACCOUNTS.md → App Store](ACCOUNTS.md#app-store).

**Play Console**: subscriptions `fbrx_standard_monthly` and `fbrx_ultra_monthly`, each with one monthly base plan at
the same prices. Server side: [ACCOUNTS.md → Google Play](ACCOUNTS.md#google-play).

Let each store convert the prices for other countries; the app shows the store's price for the phone's country.

How a purchase reaches the account:

- **iPhone and iPad**: the purchase carries the account's app account token; the app sends the signed transaction to
  FBRX Command and finishes the transaction only once FBRX Command has recorded it, so a purchase made while offline
  comes back at the next start. Renewals and refunds arrive as App Store Server Notifications.
- **Android**: the purchase carries the account's id; the app sends the purchase token, and FBRX Command asks Google
  Play about it and acknowledges it. Purchases not yet acknowledged are sent again whenever the app opens. Standard to
  Ultra replaces the subscription, and Play charges the difference.

### Store rules this follows

- In the phone apps, editions are sold only through the store: no links or buttons to pay anywhere else.
- Before buying: the edition, its price, that it renews monthly, and where to cancel it. **Restore purchases** is on
  the account screen.
- **Terms of use** and **Privacy policy** links on the account screen (`FBRX_TERMS_URL`, `FBRX_PRIVACY_URL`): the
  App Store requires both for subscriptions, so do not upload without them.
- An account made in the app can be deleted in the app.
- The camera is used only to scan the pairing code; the local network only to reach the person's FBRX computer
  (`NSCameraUsageDescription`, `NSLocalNetworkUsageDescription` say so).
- The phone talks to the computer over plain http on the local network (the computer has no certificate a phone would
  trust), so every request and reply is sealed end to end by FBRX Mobile itself ([MESH.md](MESH.md#every-request)).
  iOS allows it with `NSAllowsLocalNetworking`; Android with the network security config in
  `android/app/src/main/res/xml`. FBRX accounts are always reached over https.

For review: the app is a companion to FBRX OS on a computer. Give App Review and Google's reviewers a demo FBRX account
and a short screen recording of pairing and asking Fabrix, since they will not have an FBRX computer on their network.

**Privacy answers** (App Store *App Privacy*, Google Play *Data safety*): the app collects the FBRX account's name and
email (to sign in) and its purchases (to turn editions on). Nothing is used for tracking or advertising. Everything
between the phone and the computer stays on the local network.

### Upload

- **iOS**: Xcode → Product → Archive → Distribute App → App Store Connect. The build appears in TestFlight.
- **Android**: Android Studio → Build → Generate Signed App Bundle (with Play App Signing, keep the upload key out of
  the repository), then upload the `.aab` to the internal testing track.

## Windows: the Microsoft Store

```bash
FBRX_STORE_IDENTITY_NAME=… FBRX_STORE_PUBLISHER="CN=…" npm run package:store
```

Both values come from Partner Center → the app → **Product identity** (`Package/Identity/Name` and
`Package/Identity/Publisher`). It builds MSIX packages for x64 and arm64 into `apps/desktop/release/<version>/`
(`FBRX-OS-Store-<version>-<arch>.appx`). Run it on Windows: packaging needs the Windows SDK. The Store signs the
package, so no signing certificate is needed for it.

A Store copy differs from the download in a few ways:

- **Updates come from the Store.** FBRX's own update check stays off, **Settings → Updates** says the Store keeps
  FBRX up to date, and **Update now** from FBRX Command leaves it to the Store.
- **Its data is its own.** Windows keeps a packaged app's files apart, so a Store copy and a downloaded copy on the
  same computer do not share settings or chats.
- **Declared capabilities**: `runFullTrust` (a desktop app), `internetClient`, `internetClientServer` and
  `privateNetworkClientServer` (phones and other FBRX computers reach it on the local network, [MESH.md](MESH.md)) and
  `microphone` (voice).

The Microsoft Store lets apps other than games take payment through their own checkout, so a Store copy sells editions
the same way as the download: the FBRX account and checkout ([ACCOUNTS.md](ACCOUNTS.md)). Check the current Microsoft
Store Policies before submitting.

Tiles and the splash screen are in `apps/desktop/build/appx` (made by `apps/desktop/scripts/make-icons.mjs`).
