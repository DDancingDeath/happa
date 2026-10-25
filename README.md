# happa

Formerly AadhatManagementApp (old repo: https://github.com/DDancingDeath/AadhatManagementApp).

A comprehensive business management application for wholesale/retail operations built with ES6 modules, Firebase, and Capacitor for Android deployment.

## Features

- **Purchase & Sales Management**: Separate collections for purchases, retail sales, and wholesale sales
- **Real-time Sync**: Automatic UI updates via Firestore onSnapshot listeners
- **Stock Tracking**: Real-time stock levels with adjustment history, and a "Not selling" list (stock with no sale in 30/60/90 days, owner/manager only)
- **Item change history**: Every item rate and name change is kept (who, when, old → new); big rate jumps (> 2×) and renames ask for confirmation
- **Bill checks while typing**: Purchase, retail and wholesale bills mark problems live — red (must fix: payment split, name for Due, zero rate/qty, wholesale oversell beyond the limit) and amber (rate > 2× / < ½ the usual, below cost, small oversell, possible duplicate, odd date) with a reason under the field and a banner. Save asks once for amber; owner/manager can save past an overridable red with a reason (stored on the bill as `overrides`, accepted warnings as `flags`). Rules: `www/js/utils/bill-checks.js`; limits in Admin → Configure
- **Cash Management**: Session-based cash tracking with sign-in/sign-out
- **User Management**: Role-based access (owner, manager, staff)
- **Reports & Analytics**: Daily/weekly/monthly reports with charts
- **Bluetooth Printing**: ESC/POS thermal printer support
- **Audit Logging**: 90-day retention for critical actions
- **Outstanding Tracking**: Customer/supplier payment management, dues aging (0–30 / 31–60 / 61–90 / 90+ days, who to chase first), one-tap WhatsApp due reminder and a read-only statement image per party
- **Anomalies (owner/manager)**: Day report card on Today (today's anomalies by type/severity, top items/parties, yesterday's unreviewed, review queue; WhatsApp + image share) and an Anomalies page with filters, mark OK/fixed and pattern views (per-day trend, item × type, by user, by hour, repeat offenders). A daily scan on owner/manager devices checks already-loaded data — no Cloud Functions, no extra full-history reads
- **Rate trends (owner/manager)**: Per item, the kg-weighted average purchase / retail / wholesale rate by month, kg bought and sold, margin per kg, the same months in earlier years and a seasonal estimate for the next 4–8 weeks ("usually goes up / down / stays about the same", with confidence). Built once from all bills by an owner-triggered, resumable backfill (read budget per day, stops on a quota error), then rolled forward from bills already loaded — no Cloud Functions
- **App health / Test in Production (owner/manager, #217)**: scenario checks run inside real flows on every phone (app opening, saving a bill, recording a payment, closing cash; `www/js/tip/`). Each device keeps counters locally and writes one `tipHealth` doc per day with `FieldValue.increment` at most every 30 minutes, plus up to 20 `tipFailures` samples a day (no personal data). The App health page shows pass rate per check per day / app version, top failure reasons, p50/p90 durations and affected devices; Today shows a red banner when a check is below its target. Rollback rules (`settings/app.tipPolicies`, owner) can switch a feature to its safe behaviour on a device whose pass rate drops (report-only by default). `.github/workflows/tip-autobugs.yml` files `tip-auto` issues daily once the backup service account can read Firestore (#168). Kill switch: `settings/app.tipEnabled = false`
- **Notifications**: In-app bell + inbox for rate and item changes while the app is open (no push to closed apps on the free plan) — see [docs/notifications.md](docs/notifications.md)
- **Offline Support**: Service worker for offline functionality

## Tech Stack

- **Frontend**: Vanilla JavaScript (ES6 Modules)
- **Database**: Firebase Firestore
- **Authentication**: Firebase Auth
- **Mobile**: Capacitor 7.x (Android)
- **Hosting**: Firebase Hosting
- **Testing**: Jest + Babel

## Project Structure

```
├── www/                    # Web application
│   ├── js/
│   │   ├── __tests__/     # Unit tests
│   │   ├── auth/          # Authentication module
│   │   ├── firebase/      # Firestore service
│   │   ├── modules/       # Business logic modules
│   │   ├── services/      # Printer, audit services
│   │   ├── ui/            # UI management, navigation
│   │   ├── utils/         # Constants, state, helpers, validator
│   │   └── main.js        # App initialization
│   ├── css/               # Modular stylesheets
│   ├── templates/         # HTML templates
│   ├── service-worker.js  # Offline support
│   └── index.html         # Main entry point
├── android/               # Capacitor Android project
├── jest.config.js         # Jest test configuration
├── babel.config.js        # Babel ES6 transform config
└── firebase.json          # Firebase configuration
```

## Firebase Collections

| Collection | Purpose | State Property |
|------------|---------|----------------|
| `items` | Product catalog with rates | `AppState.items` |
| `purchases` | Purchase transactions (stock IN) | `AppState.purchaseHistory` |
| `retailSales` | Retail sales from billing tab | `AppState.retailSalesHistory` |
| `wholesaleSales` | Wholesale sales from sales tab | `AppState.salesHistory` |
| `expenses` | Business expenses | `AppState.expensesHistory` |
| `stockAdjustments` | Manual stock corrections | `AppState.stockAdjustments` |
| `withdrawals` | Cash withdrawals | `AppState.withdrawalsHistory` |
| `cashManagement` | Cash management sessions | (loaded on demand) |
| `users` | User accounts and roles | (loaded on demand) |
| `stockCheckpoints` | Stock checkpoint + legacy-scan bookkeeping (see below) | — |
| `settings` | App-wide settings (`settings/app`: client-version gates) | — |
| `rateHistory` | Append-only item rate/name changes (owner/manager create + read; never updated/deleted) | (loaded on demand in the item dialog) |
| `anomalies` | Anomaly records found by the daily scan; deterministic id `{type}~{refKind}~{refId}`, status open/ok/fixed (owner/manager read + write, owner delete) | (bounded query by IST `dayKey` range) |
| `rateStats` | Monthly rate stats per item, id `{itemId}_{YYYY-MM}` (IST month) with purchase/retail/wholesale `{kg, amount, min, max, avg, bills}`, plus `_meta` (backfill status); owner/manager read + write, owner delete | (one item's months by document-id range on the Rate trends page) |
| `tipHealth` | TIP counters, id `{deviceId}_{YYYYMMDD}`: `v.{appVersion}.{Check}.{n,r,d,ms}` (results, reason codes, duration buckets); any approved user creates/increments own device docs, owner/manager read, owner delete | (`day >=` last 14 days, limit 300) |
| `tipFailures` | TIP failure samples, id `{deviceId}_{YYYYMMDD}_{1..20}` (create-only, max 20/device/day): check, result, reason, flags/props without personal data, version | (`at` desc, limit 30) |
| `auditLogs` | Audit trail of critical actions (90-day retention) | (loaded on demand) |
| `itemFrequency`, `drafts`, `autoSaves`, `notifications`, `telemetry` | Item ordering, bill drafts/autosave, in-app notices, diagnostics | — |

Every name gets the environment prefix (`dev_` on localhost, none in
production) via `window.getCollection(name)`; see
[ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md).

### Real-time Auto-Update

The app uses Firestore `onSnapshot` listeners for automatic UI synchronization:

- **Items**: Updates item dropdowns across all tabs
- **Purchases/Sales**: Recalculates stock, updates history, finance, analytics
- **Expenses**: Updates expense history and reports
- **Stock Adjustments**: Recalculates stock levels
- **Withdrawals**: Updates withdrawal history
- **Cash Sessions**: Updates cash management view

All listeners are set up via `FirebaseService.setupRealtimeListeners()` and cleaned up on logout via `FirebaseService.cleanup()`.

### Recent-history window and stock checkpoint (free-plan reads)

Each app open reads only recent data (see the section comment above `HISTORY_COLLECTIONS` in `www/js/firebase/firestore-service.js`):

- History collections are listened to from the 1st of the previous month (`timestamp >= liveFrom`); older bills with money due come from one listener per bill collection (`openDue == true && timestamp < liveFrom`). Older history is loaded on demand (`FirebaseService.ensureHistoryFrom()` / `loadOlderHistory()`).
- Stock = `stockCheckpoints/current` (running stock before `asOf`) + replay of newer events; identical to a full replay. Only **owner/manager** devices rebuild it (full read: when missing/stale, and at least weekly) or roll it forward. Staff devices never write it; while it is stale they load full history instead (correct but costs a full read per open until an owner/manager opens the app).
- Every stock-record write sets `clientVersion: 3`, bills also `openDue`, `timestamp`. Documents written by older app versions without `timestamp` are found by an unfiltered scan and backfilled (`stockCheckpoints/legacyScan`: until complete, then by one device at most every 6 h for 14 days after an outdated app last wrote one).
- Optional: set `settings/app.minClientVersion` to make older apps show "Please update the app".

**Deployment order** (on merge to `main`, `firestore-rules-deploy.yml` deploys rules/indexes when they change, and `firebase-hosting-merge.yml` deploys hosting — both start at once, so for a release that needs new indexes/rules first, deploy them by hand or merge them in an earlier PR):

1. Deploy indexes and rules **before** the new web app goes live: `firebase deploy --only firestore:indexes,firestore:rules`. The dues listener needs the `openDue + timestamp` composite indexes, and the stock checkpoint (`stockCheckpoints`) is only writable under the new rules. Wait until the indexes show "Enabled" in the Firebase console.
2. Merge / deploy hosting, then install the new APK on every phone.
3. Once **every phone runs the new app**, the owner sets `settings/app.enforceClientVersion = true` in the Firebase console (no redeploy). From then on bill/adjustment writes without `clientVersion >= 3` are rejected — outdated apps' edits/deletes of old bills would otherwise not invalidate the stock checkpoint. Until then, owner/manager devices rebuild the checkpoint from full history at least weekly to bound any drift. Optionally also set `settings/app.minClientVersion = 3` so outdated apps show "Please update the app".

## Getting Started

### Prerequisites
- Node.js 18+
- Firebase CLI (`npm install -g firebase-tools`)
- Android Studio (for mobile builds)

### Installation
```bash
# Install dependencies (same as CI)
npm ci
```

### Development
```bash
# Run local server
npm start
# OR
npx http-server www -p 8080

# Deploy to Firebase
firebase deploy --only hosting
```

### Android Build
```bash
# Sync Capacitor
npx cap sync android

# Open in Android Studio
npx cap open android
```

**Supported Android versions:** Android 11 (API 30) and newer (`minSdkVersion = 30` in `android/variables.gradle`).

Build an APK from the command line (requires JDK 21 and the Android SDK):
```bash
npm ci
npx cap sync android
cd android
./gradlew assembleDebug     # -> app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease   # signed only if a keystore is configured (see below)
```

Release signing (Happa key): create `android/keystore-happa.properties` (git-ignored; the old app's `keystore.properties` is not read) with `storeFile`, `storePassword`, `keyAlias`, `keyPassword`,
or set `ANDROID_KEYSTORE_FILE`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.

### Releasing (Android APK + GitHub Release)

`.github/workflows/android-release.yml` builds, signs and publishes the APK when a `v<version>` tag is pushed.
Pull requests that touch `android/**`, `capacitor.config.json`, `package*.json`, `www/changelog.json`,
`www/js/version.js` or the release scripts run the tests and `check:release` and build an unsigned debug APK
(uploaded as a workflow artifact) to catch breakage — nothing is published.

The version lives in four places that must agree: `www/changelog.json` (top entry), `package.json`,
`www/js/version.js` and `android/app/build.gradle`.

1. Add the new entry at the **top** of `www/changelog.json`: `version` (x.y.z), `date` (YYYY-MM-DD),
   `androidVersionCode` (previous + 1) and short `notes.en` / `notes.hi` lists written for shop staff.
2. Bump every version in one go: `npm run release -- <ver> --code <n>` (e.g. `npm run release -- 1.3.0 --code 4`).
   It refuses to run until the changelog entry exists and the code increases; `npm run check:release` must pass.
3. Open a PR, get it reviewed, merge to `main`.
4. Owner tags the merged commit: `git tag v<ver> && git push origin v<ver>`.
5. The workflow runs the tests and `check:release`, checks the tag equals `package.json` `version`, builds the signed
   APK, verifies its signing certificate and package id, and creates the GitHub Release "happa v<ver>" (marked latest)
   with notes from `www/changelog.json` and two assets: `happa.apk` (stable name used by
   `releases/latest/download/happa.apk`, the app and the download page) and `happa-v<ver>.apk`.
   Tag builds also run `npm run check:happa-config` (no placeholders left in `happa.config.json`).
   The web app still deploys on merge to `main` as before.

Installed Android apps check `releases/latest` (at most every 12 h) and show an "Update available" banner;
https://happa-bfc07.web.app/download (site from `happa.config.json`) always links to the latest APK. After updating, each user sees a one-time
"What's new" sheet (Settings → App updates reopens it and has "Share on WhatsApp" for sending the download link).

To re-publish an existing tag (e.g. after fixing a secret), run the workflow manually (Actions → Android release →
Run workflow) with `tag` = `v<ver>`; assets are replaced (`--clobber`).

**One-time owner setup** (Settings → Secrets and variables → Actions):

- Secrets (all required; tag builds fail without them rather than publish an unsigned APK):
  - `HAPPA_KEYSTORE_BASE64` — the Happa release keystore, base64-encoded.
  - `HAPPA_KEYSTORE_PASSWORD`, `HAPPA_KEY_ALIAS`, `HAPPA_KEY_PASSWORD`
- Variable (required) `HAPPA_CERT_SHA256` — SHA-256 of the Happa signing certificate. The workflow refuses to
  publish an APK signed with any other key (phones cannot update an app signed with a different key).
  Commands for all of these: [docs/happa-go-live.md](docs/happa-go-live.md).
- The old app's secrets (`ANDROID_KEYSTORE_*`, `ANDROID_KEY_*`, `FIREBASE_SERVICE_ACCOUNT_AADHAT_MANAGEMENT`,
  `FIREBASE_BACKUP_SERVICE_ACCOUNT`) are not read by current workflows but still are by older refs and tags, so they are
  deleted at go-live (`docs/happa-go-live.md` step 7). `BACKUP_PASSPHRASE` stays.


## Testing

The project uses Jest for unit testing with Babel for ES6 module transformation.

### Running Tests

```bash
# Run all tests once
npm test

# Run tests in watch mode (re-runs on file changes)
npm run test:watch

# Run tests with coverage report
npm run test:coverage
```

### Test Structure

All Jest suites live in `www/js/__tests__/` (one `*.test.js` per area;
shared fakes in `__mocks__/`). Rough grouping:

- **Pure utilities**: `helpers`, `dates`, `money`, `validator`, `state`,
  `keyboard-shortcuts`, `release` (changelog / version consistency)
- **Stock & history maths**: `calculateStock`, `calculateStock-equivalence`,
  `stock-check`, `history-range`, `history-window`, `history-service`,
  `realtime-listeners`, `load-perf`, `infinite-scroll`
- **Bills & payments**: `bill-edit`, `wholesale-payment`
- **Safety guards**: `xss-rendering`, `firebase-app-shadow`,
  `pwa-manifest` (service-worker `STATIC_ASSETS`), `install-prompt`
- **Other**: `printer-raster`, `plan-generate`

Run `npm test` for the current count (24 suites / 312 tests on `main` as of
2026-10-21) — don't hard-code numbers elsewhere; they go stale.

### Coverage

`npm run test:coverage` prints the report. Coverage is only *collected* and
*enforced* for the three files listed in `collectCoverageFrom` /
`coverageThreshold` in `jest.config.js` (`utils/helpers.js`,
`utils/validator.js`, `utils/state.js`); the other suites exercise modules
that are excluded from collection (Firebase/DOM-heavy code), so the
percentage is not a measure of the whole app.

### Writing Tests

Tests are written using Jest syntax. Example:

```javascript
import { Validator } from '../utils/validator.js';

describe('Validator', () => {
    test('should validate required fields', () => {
        const result = Validator.required('value', 'Field Name');
        expect(result.valid).toBe(true);
    });
});
```

### Test Configuration

- **Jest Config**: `jest.config.js` - Test environment, patterns, coverage settings
- **Babel Config**: `babel.config.js` - ES6 module transformation for Node.js

### Firestore Security Rules Tests

`firestore.rules` only lets *approved* users (profile in `users`/`dev_users` with role owner/manager/staff and status not `pending`/`rejected`; a missing status counts as approved) touch business data, and stops users from changing their own `role`/`status`/`approvedAt`/`approvedBy`. Non-owners can fully edit or delete a bill only for the number of days the owner sets per role in **Settings → Roles & access** (default 2); what each role may see is set on the same screen — see [docs/role-permissions.md](docs/role-permissions.md). The rules are tested against the Firestore emulator (needs Java 11+ on `PATH`/`JAVA_HOME`):

```bash
cd rules-tests && npm install && cd ..   # one-time: separate deps for the rules tests
npm run test:rules                       # starts the emulator (demo-aadhat project, port 8181) and runs rules-tests/test.js
```

### Continuous integration

`.github/workflows/ci.yml` runs on every pull request and push to `main`:

| Job | Commands |
|-----|----------|
| Lint, Jest, release checks | `npm run lint` (ESLint, real-error rules only — `eslint.config.js`), `npm run check:sw`, `npm run check:release`, `npx jest` |
| Firestore rules tests | Java 21 + `cd rules-tests && npm ci` + `npm run test:rules` |
| Playwright E2E (nightly, manual dispatch, or PRs labelled `e2e`) | `npm run test:e2e` — phone + desktop projects against the Firebase emulators |
| Production smoke (nightly, manual dispatch) | `npm run test:smoke` — live site, no login, non-GET Firebase requests blocked |

The hosting workflows (`firebase-hosting-*.yml`) run Jest and deploy Hosting. `firestore-rules-deploy.yml` runs on pushes to `main` that change `firestore.rules` or `firestore.indexes.json` (and on manual dispatch, never on PRs): it reruns the rules tests, then runs `firebase deploy --only firestore:rules,firestore:indexes` with the `FIREBASE_SERVICE_ACCOUNT_HAPPA` service account, against the project in `happa.config.json` (every Firebase workflow refuses `aadhat-management`). That account needs the roles **Firebase Rules Admin** (`roles/firebaserules.admin`) and **Cloud Datastore Index Admin** (`roles/datastore.indexAdmin`) — Google Cloud console → IAM → the `github-action-…` service account; the job fails with a message naming the roles if they are missing. Indexes that exist only in the console are reported, not deleted. Manual fallback: `firebase deploy --only firestore:rules,firestore:indexes`.

### End-to-end tests (Playwright)

`tests/e2e/` holds Playwright specs: login gate, bill → History → due payment → cash close, edit a bill, open every page without errors. `npm run test:e2e` (needs Java 21; first time `npx playwright install chromium`) starts the auth/Firestore emulators (ports 9099/8181, as `www/firebaseConfig.js` expects with `?emulator=1`) and a static server on `E2E_PORT` (default 8099), then `tests/e2e/global-setup.js` wipes and seeds the emulator (owner/staff/pending users, items, bills). Run one spec with `npx playwright test tests/e2e/bill-flow.spec.js --project=phone`. Failure screenshots and traces land in `test-results/`.

## Validation

The app includes a comprehensive validation utility (`www/js/utils/validator.js`) for client-side form validation:

```javascript
import { Validator } from './utils/validator.js';

// Validate a bill before saving
const result = Validator.validateBill({
    sellerName: 'Supplier Name',
    items: [{ name: 'Rice', rate: 50, weight: 10 }]
});

if (!result.valid) {
    console.log(result.errors); // Array of error messages
}
```

## Service Worker (Offline Support)

The app includes a service worker (`www/service-worker.js`) that:
- Caches static assets (CSS, JS, HTML, templates)
- Uses cache-first strategy for static files
- Uses network-first strategy for Firebase API calls
- Enables basic offline functionality

## Install as an app (PWA)

`www/manifest.webmanifest` plus the icons in `www/icons/` make the web app
installable on desktop (Chrome/Edge) and Android/iOS home screens. In a
browser tab, **Settings → Install App / ऐप इंस्टॉल करें** shows an install
button when the browser offers one, or a short hint otherwise (Safari/Firefox).
The card is hidden inside the Capacitor Android app and when already running
installed. New icons/manifest changes must stay in `STATIC_ASSETS`
(`npm run check:sw`).

## Planning

The pinned issue **"[Plan] Roadmap: pick order (auto-updated)"** shows which
issues to work on, in order, with progress per phase. It is generated from
`tools/plan/order.json` by `tools/plan/generate.js` and refreshed by the
`Plan page` workflow on every issue change (and daily).

- When you add an issue, place it in `tools/plan/order.json`; the plan issue
  regenerates automatically. Unplaced open issues show up in 🆕.
- It skips (and succeeds) when the repo has no plan issue; `--create` opens one.
- Preview locally: `GH_TOKEN=... node tools/plan/generate.js --dry-run`
  (`--write-docs` also writes `docs/PLAN.md`).

## Bugs, features and the plan

[GitHub issues](https://github.com/DDancingDeath/AadhatManagementApp/issues)
(still in the old repo for now) are the only bug/feature list (labels `P0`–`P3`, `type:*`, `area:*`,
`owner-decision`; sprint milestones). The pinned plan issue
([#171](https://github.com/DDancingDeath/AadhatManagementApp/issues/171))
shows the pick order — see "Planning" below. The old staging clone and its
`docs/REVIEW_ISSUES.md` are archived and no longer maintained.

## Documentation

- **[AGENTS.md](AGENTS.md)** — conventions and workflows for anyone (human or AI) changing this repo
- **[ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md)** — `dev_` collection prefix, switching environments
- **[www/js/README.md](www/js/README.md)** — module layout
- **[scripts/README.md](scripts/README.md)** — Playwright inspection helpers
- **[docs/archive/](docs/archive/README.md)** — older docs kept for history (may be out of date)
