# Move to the shop's own Firebase project (#15)

This tool copies what the shop needs into a **new Firebase project** for the new app, **Happa**. The old app, the old site (`aadhat-management.web.app`) and the old project (`aadhat-management`) **stay as they are**: nothing here changes them.

It never reads the old project. Its only input is a **decrypted backup** made by `tools/backup` (see `tools/backup/README.md`). The old project's free read quota is not used.

- `plan` (offline): backup.json → `out/bundle.json` (the documents to write) and `out/report.md` (counts and totals only, no names; safe to paste into a PR).
- `apply`: writes the bundle into the new project. **Dry run by default**; writing needs `--yes`.

Needs Node 22.12+ (the tool imports the app's own `www/js/utils` so the numbers match the app).

```sh
cd tools/migrate && npm ci && cd ../..
node tools/migrate/migrate.js plan  --in backup.json
node tools/migrate/migrate.js apply --bundle tools/migrate/out/bundle.json --project happa-bfc07             # dry run
node tools/migrate/migrate.js apply --bundle tools/migrate/out/bundle.json --project happa-bfc07 --key key.json --yes
```

`tools/migrate/out/` is git-ignored. The bundle holds shop data (names, phones, users): keep it private and delete it after cutover. Never commit a service-account key.

## What is carried

| What | How | Flag (default first) |
|---|---|---|
| History | **Fresh start**: old bills are not copied; the old project and the encrypted backup are the archive | `--mode fresh` / `full` (copies every bill as is, no opening balances) |
| Items page | `items` copied as is, same ids | `--copy items,users,rateHistory,itemFrequency` |
| Users | `users` profile docs as is (roles, status), same uids; logins move with `auth:import` below | (part of `--copy`) |
| Outstanding (retail) and Wholesale → Outstanding | one **opening balance** per party, see below | always in `fresh` mode |
| Supplier payables | **checked only**: the report shows the total (should be ₹0) and warns otherwise | `--carry-payables` to carry them like receivables |
| Buying and rate patterns | `rateStats` built from **all** old bills, weekly + monthly, plus `rateStats/_meta` | `--no-rate-stats` |
| Rate history | `rateHistory` copied as is | (part of `--copy`) |
| Item order in the billing list | `itemFrequency` copied as is | (part of `--copy`) |
| Settings | `settings/*` (labour rate, heavy-packet weight, bill-check limits, …) minus project-specific fields (`minClientVersion`, `enforceClientVersion`, anything naming the old project) | `--no-settings` |
| Bill numbers | **continue**: today's counters (`counters/{P,S,W}YYYYMMDD`) are carried, so a same-day cutover goes on from the last number | `--bill-numbers continue` / `restart` |
| Opening stock | **not carried**: set it by hand in Happa (runbook step 9) | – |
| Opening cash, party list | **not carried** (fresh start) | – |
| `dev_*` collections | never | `apply --dev` writes everything into `dev_<name>` for a rehearsal |

Bill numbers are per day (`S20261025-001`), so numbers made in Happa never clash with old ones. Opening balances are numbered `OB-S-001`, `OB-W-001` (`OB-P-…` for payables).

### Opening balances

One bill-shaped document per party, in the collection the old due lived in (`retailSales`, `wholesaleSales` with `source: 'sales-tab'`, or `purchases`), id `opening-<type>-<hash of the party name>`:

```js
{
  billNumber: 'OB-S-001', customerName, customerPhone /* only if a bill had one: WhatsApp reminder */,
  date: '<oldest unpaid bill, YYYY-MM-DD>', timestamp /* IST noon of that day */, type, items: [],
  total: 0, cashPayment: 0, onlinePayment: 0,
  dueAmount: <amount>, payment: { cash: 0, online: 0, due: <amount>, total: 0 },
  openDue: true, cleared: false, clientVersion: 3,
  openingBalance: { migrated: true, kind: 'receivable', billType, amount, asOf, fromProject,
                    sourceBills: [{ id, billNumber, date, total, due }] }
}
```

- Outstanding, the party due under the name field, reminders, statements, payments and write-offs already read `payment.due` / `dueAmount`, so they work unchanged. Parties are grouped exactly as Outstanding groups them (`buildAging`); Wholesale dues use the Wholesale page's own rule (`wholesaleOutstanding`).
- `total` is 0 and there are no lines, so Finance, Reports and stock never count the old sales a second time. Money received later counts on the day it is received, as for any due.
- App change: Outstanding and Wholesale → Outstanding show `openingBalance.amount` as the bill total and a line "Opening balance from the old app (bills #…)".
- The whole amount sits at the oldest unpaid bill's date, so the age buckets show it there (the report lists the old buckets).

`plan` cross-checks: Σ opening balances = the old Outstanding / Wholesale totals, per party; monthly rate buckets = the app's own monthly aggregation (`rate-trends.js`); weekly kg = monthly kg.

### Buying and rate patterns

`rateStats/{itemId}_{YYYY}`: weekly buckets `w<Monday YYYY-MM-DD>` (IST weeks starting Monday; a week belongs to its Monday's year) and monthly buckets `m<YYYY-MM>`, each `{ purchase, retail, wholesale: {kg, amount, min, max, avg, bills}, bills }`. This is the layout of the Rate trends rework (branch `feat/rate-trends-items-rate`): **merge that PR first**. `lib/rate-stats.js` `buildRateStatsDocs()` is the one function to switch to its exported aggregation. `rateStats/_meta` gets `backfillDone: true` plus `cutoff` (backup time); the new app must only roll forward bills after `cutoff`.

### Write budget (Spark: 20,000 writes/day)

The report gives the total writes. `apply` writes in batches of 400 and stops at `--budget` (default 18,000 per run, leaving room for the shop's own writes). Run the same command the next day to continue: the cursor file (`out/bundle.json.<project>.cursor.json`) remembers where it stopped. Every write is a `set()` at a fixed id, so a rerun is harmless.

A new `plan` makes a new bundle; continue with `--restart` (idempotent). Opening balances that already have a payment or were cleared in Happa are **never overwritten**, and opening balances that are no longer due are removed.

`apply` refuses `aadhat-management` and a key that belongs to another project.

## Logins (Firebase Auth)

The app signs in with **email and password only** (`www/js/auth/authentication.js`). Move the accounts with the same uids (the `users/{uid}` docs depend on them). This reads Auth, not Firestore, so it does not touch the Firestore quota.

1. Old project console → Authentication → Users → ⋮ (top right of the table) → **Password hash parameters**. Copy `base64_signer_key`, `base64_salt_separator`, `rounds`, `mem_cost`.
2. Export and import:
   ```sh
   firebase auth:export users.json --format=json --project aadhat-management
   firebase auth:import users.json --hash-algo=SCRYPT \
     --hash-key=<base64_signer_key> --salt-separator=<base64_salt_separator> \
     --rounds=<rounds> --mem-cost=<mem_cost> --project happa-bfc07
   ```
3. Sign in to Happa with one account first. Wrong parameters mean nobody can sign in (fix: re-import with the right ones, or "Forgot password").
4. Delete `users.json` (it holds password hashes).

## Cutover runbook

Values (the ones still pending are marked):

| | Value |
|---|---|
| App name | **Happa** (Hindi: **हप्पा**) |
| Android package id | `com.happa.shop` |
| New Firebase project id | `happa-bfc07` (display name "Happa"; `.firebaserc` alias `happa`) |
| New hosting site | default site `happa-bfc07`: https://happa-bfc07.web.app |
| Web config (`apiKey`, `appId`, …) | `<pending from owner>` (Project settings → Your apps) |
| Service accounts | `<pending from owner>` |
| Cutover date | `<CUTOVER_DATE>` |

### Before cutover

1. **Project `happa-bfc07`** (created by the owner, Spark). Create the Firestore database in **asia-south1** (Mumbai), unless the old project's Firestore location (old console → Firestore → Settings) is different; `firebase.json` and `.firebaserc` do not pin one. Enable Authentication → Email/Password. Add a web app to get the new `firebaseConfig`. Authentication → Settings → Authorized domains: `happa-bfc07.web.app`, `happa-bfc07.firebaseapp.com`.
2. **Service accounts and CI.**
   - Deploy account (GitHub Actions): roles **Firebase Hosting Admin**, **Firebase Rules Admin** (`roles/firebaserules.admin`), **Cloud Datastore Index Admin** (`roles/datastore.indexAdmin`), and **Cloud Datastore Viewer** (`roles/datastore.viewer`) for the nightly backup (or a separate read-only backup account). Save its key as the secret `FIREBASE_SERVICE_ACCOUNT_HAPPA_BFC07` (and `FIREBASE_BACKUP_SERVICE_ACCOUNT`).
   - Migration account: **Cloud Datastore User** (`roles/datastore.user`) on the new project only. Key stays on the owner's computer and is deleted after cutover.
3. **Point the code at the new project** in the cutover PR (not earlier: `main` auto-deploys, so switching the workflows sooner would send the old app's site and rules to Happa): `www/firebaseConfig.js`, `.firebaserc` (`default: happa-bfc07`; the `happa` alias is already there), `projectId: happa-bfc07` in `.github/workflows/firebase-hosting-merge.yml`, `firebase-hosting-pull-request.yml`, `firestore-rules-deploy.yml`, and the new secret names, plus the "new app" checklist below.
4. **Deploy rules, indexes and hosting** to the new project: `firebase deploy --only firestore:rules,firestore:indexes,hosting --project happa-bfc07`.
5. **Rehearse**: run steps 7–8 with a recent backup and `apply --dev`, open Happa on localhost, check Items, Outstanding, Wholesale → Outstanding, Rate trends and Settings, then delete the `dev_*` collections.

### Cutover day

6. Pick a quiet time. **Close the cash session** in the old app. From now on **the shop stops billing in the old app**: with both apps running, a bill saved in the old app does not appear in Happa. (Optional: the owner sends a notice with the Happa download link from the old app's inbox.)
7. **Final backup**: Actions → *Firestore backup* → *Run workflow*. Download, check and decrypt it (`tools/backup/README.md`).
8. **Migrate**:
   ```sh
   node tools/migrate/migrate.js plan --in backup.json            # read out/report.md: totals, warnings, writes
   node tools/migrate/migrate.js apply --bundle tools/migrate/out/bundle.json --project happa-bfc07            # dry run
   node tools/migrate/migrate.js apply --bundle tools/migrate/out/bundle.json --project happa-bfc07 --key key.json --yes
   ```
   Then move the logins (above). `plan`/`apply` can be **rerun just before go-live** (add `--restart` for a new bundle) to pick up the latest items, dues, settings and patterns. Rerun only before Happa is in use: a rerun rewrites items, users, settings and rate patterns.
9. **Set opening stock** per item in Happa: Stock → Stock Adjustment → type **Set**, the counted kg, and **Rate (₹/kg)** = the average cost. The stock replay uses that rate as the cost of the stock, so cost of goods sold and profit work from the first sale.
10. **Re-enter per-phone settings** in Happa (printer, language, dark mode, Hindi names): they live on each phone, not in Firestore. There are no shop details stored in Firestore today; the printed bill does not use any.
11. **Check** in Happa: sign in as each role; Items count; Outstanding and Wholesale → Outstanding totals equal the report; Rate trends shows the history; a test bill gets the next number.
12. Keep the final backup archive (encrypted, as produced by the workflow) and the passphrase in the password manager. The old project stays as it is.

### Rollback

Nothing in the old project changed, so the shop can go back to billing in the old app. Bills made in Happa in the meantime must be re-entered there.

## New app checklist (Happa)

A new Android package installs **side by side** with the old app; `versionCode` can restart at 1. Files that pin the old app id, name or site (change them in the cutover PR, not here):

| File | What |
|---|---|
| `capacitor.config.json` | `appId` → `com.happa.shop`, `appName` → `Happa` |
| `android/app/build.gradle` | `namespace` and `applicationId` → `com.happa.shop`; `versionCode 1`, `versionName` |
| `android/app/src/main/java/com/hitesh/aadhat/MainActivity.java` | `package com.happa.shop;`, moved to `java/com/happa/shop/` |
| `android/app/src/main/res/values/strings.xml` | `app_name`, `title_activity_main`, `package_name`, `custom_url_scheme` |
| `www/manifest.webmanifest` | `name`, `short_name` |
| `www/index.html` | `<title>` |
| `www/firebaseConfig.js` | new `firebaseConfig` |
| `www/js/auth/authentication.js` | password-reset `url` (`https://happa-bfc07.web.app`) |
| `www/js/utils/release-info.js` | `DOWNLOAD_PAGE_URL`, `APK_DOWNLOAD_URL` (asset name), share text |
| `www/download.html` | title, heading, site links, QR code (`www/img/download-qr.svg`) |
| `www/changelog.json` | links to the download page (new entries) |
| `www/js/modules/app-updates.js`, `www/js/modules/reports.js` | app name in share text / report footer |
| `.github/workflows/android-release.yml` | release title, APK asset names (`AadhatManagement.apk`), `ANDROID_CERT_SHA256` check |
| `scripts/release-notes.js`, `scripts/inspect-app.js`, `scripts/save-login.js`, `playwright.prod.config.js`, `tools/tip/autobugs.js` | site URL |
| `README.md`, `AGENTS.md`, `ENVIRONMENT_SETUP.md`, `tools/backup/README.md` | live URL, project id |

Releases: the old app's update banner fetches the **latest** GitHub release asset `AadhatManagement.apk` of this repo. If Happa is released from the same repo with a new asset name, old phones' "Update" link breaks; if it keeps that name, old phones would download Happa. Decide which (or use a separate repo/tag scheme for Happa).

**Signing:** a new package does not need the old key. Create a **new keystore owned by the business**, store it and its passwords in the password manager, and set new secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` and the variable `ANDROID_CERT_SHA256` (SHA-256 of the new certificate: `keytool -list -v -keystore happa.keystore`). Archive the old keystore: it is needed only if the old app ever needs a fix.

**Hosting:** Happa's site is `happa-bfc07.web.app` in the new project (its `/download` page links the Happa APK). The old site is unchanged.
