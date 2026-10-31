# AGENTS.md — Guide for AI agents working in this repo

> If you are an AI coding agent landing in this repository, **read this file
> before doing anything else**. It will save you (and the human) a lot of
> wasted turns.

---

## 1. What this repo is

`happa` (formerly `AadhatManagementApp`) — a Hindi/English wholesale-retail business app for
small-scale grain/produce traders. It runs on **Firebase Hosting + Firestore +
Auth**, is built as **vanilla ES module-style JS** (no bundler, no framework),
and is wrapped in **Capacitor** for Android distribution.

- **Owner**: `DDancingDeath` (https://github.com/DDancingDeath/happa; the old repo
  https://github.com/DDancingDeath/AadhatManagementApp is kept as is and still holds the existing issues)
- **App**: **Happa** (Android `com.happa`; displayed as lowercase "happa" in English and Hindi). Its name, Android
  package, Firebase project and site all come from `happa.config.json`
  (`npm run apply:happa-config` writes them everywhere, `npm run check:happa-config`
  is the release gate; go-live steps in `docs/happa-go-live.md`).
- **Live URL**: `https://myhappa.web.app` (hosting site `myhappa` in Firebase
  project `happa-bfc07`, from `happa.config.json`). The only site that serves the
  app. `happaapp.web.app` and `happa-bfc07.web.app` (`redirectHostingSites`) only
  301 every path to it, so there is one origin (one offline store, one service worker).
- **Old app (archived, never changed)**: Android `com.hitesh.aadhat`, Firebase
  project `aadhat-management`, site `aadhat-management.web.app`, last release
  v1.6.1. No workflow may deploy to it; the CI guard
  (`scripts/happa-config.js guard`) fails if anything resolves to it. Its
  release notes are archived in `docs/aadhat-changelog-archive.json`.
- **Bug / feature list**: GitHub issues in `DDancingDeath/happa` (labels,
  milestones and the pinned plan issue — see section 5). The open issues of
  `DDancingDeath/AadhatManagementApp` were moved here on 30 Oct 2026 (old URLs
  redirect; `imported.map` in `tools/plan/order.json` maps old → new numbers).
  In a moved issue's body a bare `#N` or `AadhatManagementApp#N` is the old
  number. The old plan issue (old #171, now #158) is retired; the plan page
  uses a new plan issue. There is no other master list.
- **The staging clone (`AadhatManagementApp-staging`) is archived** —
  read-only reference only; nothing is developed or verified there any
  more. See section 6.

---

## 2. The unbreakable rules

1. **This repo is production.** Real users in the field are using the live
   site and the Android build. Treat every change like a security patch:
   small, reviewed, reversible.
2. **Never bypass `FirebaseService` / the repositories.** All Firestore reads/writes
   go through `FirebaseService` or a repository in `www/js/firebase/repos/`
   (Rentals: `rentals/rent-store.js`, `rent-receipt-store.js`), which resolve
   names with `window.getCollection(name)` so collection prefixing stays correct:
   production uses unprefixed names (`purchases`), development (localhost) uses
   `dev_` (`dev_purchases`). Pages, `ui/`, `services/`, `auth/`, `main.js` and
   `utils/` have no Firestore call at all (the architecture guard enforces 0).
3. **Don't add a build step or framework.** No webpack, no Vite, no React.
   Inline `<script>` tags + `window.app` globals are a deliberate choice;
   files under `www/` are served exactly as written.
4. **Don't rename existing files casually.** Inline `onclick="window.app.x.y()"`
   handlers and `template-loader.js` reference paths and method names by
   exact string.
5. **Install with `npm ci`** (no `--legacy-peer-deps` needed since the unused
   `canvas` dependency was dropped).
   Run `npm test` (Jest) and, after touching `firestore.rules`,
   `npm run test:rules` (Firestore emulator; needs Java and
   `cd rules-tests && npm install` once). `npm run lint` (ESLint) must
   stay at 0 errors. `.github/workflows/ci.yml` runs lint, `check:sw`,
   `check:release`, Jest and the rules tests on every PR, and
   `.github/workflows/e2e.yml` runs the Playwright E2E suite on every PR that
   changes the app (section 5, "CI").
6. **Money-related changes get extra care.** Bills mix top-level
   `dueAmount` with nested `payment.due`. Both can drift; both must be
   read/written — use `readPayment()` / `round2()` from
   `www/js/utils/money.js`. Multi-device updates to the same document
   (payments, cash sessions, counters) must use transactions, `arrayUnion`
   or `FieldValue.increment`, never read-modify-write of the whole doc.
7. **No secrets in the repo.** API keys belong in Firebase Functions config
   (`firebase functions:config:set`), not in any source file.

---

## 3. Where to start reading

In order:

1. `README.md` — original setup / install / deploy instructions.
2. `firestore.rules` — the authoritative permission model.
3. `www/index.html` — script load order; this is the SPA shell.
4. `www/js/main.js` — wires every module onto `window.app.*`.
5. `www/firebaseConfig.js` — initializes Firebase, exposes `firebase.*`
   compat globals.
6. `www/js/firebase/firestore-service.js` and `www/js/firebase/repos/` — every
   read/write goes through here; the data layer tells pages what changed with
   events (`www/js/utils/events.js`), never by calling them.

---

## 4. Codebase orientation (the bits you'll get wrong)

### Naming surprises

| You'd guess | Actual file |
|---|---|
| `expenses.js` | `www/js/modules/miscellaneous.js` |
| `printer.js` (modules) | `www/js/services/printer.js` |
| `wholesaleSalesHistory` | `AppState.salesHistory` (just "salesHistory" means **wholesale** here) |
| `retailSalesHistory` | `AppState.retailSalesHistory` (this one's normal) |
| `chat.js` | does not exist in this repo — `templates/chat.html` exists but no chat module is wired |
| `bottom-nav.html` | doesn't exist — the "bottom" tabs are the bottom of the side nav in `navigation.html` |
| `rates.html` / `rates.js` (Rates page) | `templates/items.html` + `modules/items.js` (page id `items`, route `rates`; old `items` still works) |
| Trends / Product traffic page | Views of Insights › Seasons: `templates/rate-trends.html` (`#rate-trends`, injected inside `#insights`) + `modules/rate-trends.js` (Insights moves its `.rt-page` into the Seasons host with `RateTrendsManager.mount()`). Owner/manager via the `rate-trends` entry in `TAB_ROLES`. Routes `insights-trends`, `insights-traffic`; old `reports-trends`, `reports-traffic`, `rate-trends`, `rates-trends`, `rates-traffic` redirect there (`ui/navigation.js`) |
| `finance.html` / `reports.html` / `analytics.html` | Removed (redesign phase 5). Old ids redirect: `finance*` → `money`, `reports*` → `statements`, `analytics*` → `insights`; the stored permission ids `finance` / `reports` / `analytics` now switch Money / Statements / Insights |
| `money.html` / `money.js` (Money page) | `templates/money.html` + `modules/money.js` (route `money`, sections `money-profit|cash|spending|worth`; imported on first open; figures from `utils/business-metrics.js`; month snapshots `monthStats` via `utils/month-snapshots.js`) |
| `insights.html` / `insights.js` (Insights page) | `templates/insights.html` + `modules/insights.js` (route `insights`, sections `insights-actions|items|parties|seasons|trends|traffic`; Seasons mounts the Rate trends view with `RateTrendsManager.mount()`, one DOM, `#rate-trends` inside `#insights`) |
| `statements.html` / `statements.js` (Statements page) | `templates/statements.html` + `modules/statements.js` (route `statements`, `statements-day|month|party|item|csv`; rows from `utils/statements.js`) |

### Conventions

- **All UI updates run inline `onclick` handlers** that call
  `window.app.*`. To expose a new module method to the UI, register it in
  `main.js` — never assume `app` (without `window.`) resolves correctly
  from an inline handler. (`firebaseConfig.js` used to declare
  `let app = firebase.initializeApp(...)` at top level, which shadowed
  `window.app` for inline handlers; it is now `firebaseApp` and
  `firebase-app-shadow.test.js` guards against regressions.)
- **All Firestore access goes through `FirebaseService` or a repository**
  (`firebase/repos/*.js`: one per collection family, owning its names, queries,
  transactions and offline patterns; pages get plain data back) so collection
  names get the env prefix. A new collection or query gets a repository
  function, never a `.collection(` in a page.
- **Data changes → pages: events, not calls.** `firestore-service.js` emits
  `refresh:<view>` (`REFRESH` in `utils/events.js`, after its debounce and only
  for the open tab) and `itemFrequency:changed`; each page subscribes with
  `on(REFRESH.x, () => Manager.render())` at the end of its module (Money,
  Insights, Statements in main.js through their lazy loaders). Never call
  `window.app.*` from `firebase/` (`data-events.test.js`).
- **Templates live in `www/templates/`**. They are loaded by
  `template-loader.js` on demand and inserted into the SPA shell.
- **Date strings**: bills mix ISO-8601 and `DD/MM/YYYY`. Use
  `www/js/utils/dates.js` (`parseAnyBillDate`, `todayLocalISO`,
  `parseLocalDate`) or `Helpers.parseDate()` — never raw
  `new Date('YYYY-MM-DD')` or `toISOString().split('T')[0]` (UTC shifts the
  day in IST).
- **Escaping**: any Firestore/user text inserted via `innerHTML` must go
  through `Helpers.escapeHtml()`; values inside `onclick="fn('…')"` need
  `Helpers.escapeJsAttr()`.
- **App language (Hindi/English, #143)**: user-facing text comes from
  `t('key', params)` (`www/js/i18n/index.js`) with plain catalogues
  `i18n/en.js` + `i18n/hi.js` (`ui.*` = screen text, `msg.*` = toasts /
  alerts / confirms). Templates mark text with `data-i18n="key"` (and
  `data-i18n-placeholder|title|aria-label`); `setLang()` re-applies them and
  fires `aadhat:langchange` so open screens redraw without a reload. English is
  the default; the choice is per device (`aadhat.lang`). Add every new key to
  both catalogues — `i18n-catalogue.test.js` fails on missing keys or on
  "staff"/"स्टाफ". Escape `t()` output that goes into `innerHTML`. Show one
  language at a time, never "English / हिंदी" together:
  `single-language-guard.test.js` (scanner: `node scripts/mixed-language-scan.js`)
  fails on any literal, template or template text mixing Latin and Devanagari.
  Records that carry both languages (`{ en, hi }`, stored anomalies/flags) are shown
  with `pickLang()` from `i18n/localize.js`; old stored "English / Hindi" sentences
  fall back to `splitBilingual()`.
- **Service worker / cache bump**: every app JS/CSS/template file (and
  icon/manifest) must be listed in `STATIC_ASSETS` in `www/service-worker.js`
  (`npm run check:sw`; a test enforces it), or in `LAZY_ASSETS` for a file loaded only on use
  (outside the precache budget; install caches it best effort, the fetch handler on use). Any PR that changes a shipped
  file under `www/` bumps all three together:
  1. every `?v=<token>` in `www/index.html` (one token for the whole file),
  2. `BUILD_ID` in `www/js/main.js`,
  3. `CACHE_NAME` (`happa-vN`) in `www/service-worker.js`.

  Token format: `?v=YYYYMMDD<letter>` (e.g. `20261021j`), `BUILD_ID` =
  `'<same token>-<short-slug>'`, `CACHE_NAME` = next `happa-vN`. Parallel
  PRs collide on these three lines — whoever merges second rebases and
  picks the next value. Don't touch app version / changelog for a cache bump.
- **Versions / release notes**: `www/changelog.json` (newest first, `en` +
  `hi` notes) is the source of truth. Never hand-edit version numbers — run
  `npm run release -- <x.y.z> --code <n>` after adding the changelog entry;
  `npm run check:release` must pass. `www/download.html` (public, no
  Firebase; served at `/download`) and the in-app "What's new"/update banner
  (`js/modules/app-updates.js`, pure logic in `js/utils/release-info.js`)
  read that file. Release flow end-to-end is in section 5 ("Releasing").
- **PWA install**: `www/manifest.webmanifest` + `www/icons/` make the web app
  installable; `js/services/install-prompt.js` drives the Settings →
  "Install App" card (hidden inside the Capacitor app and when already
  installed). Manifest/icon changes must stay in `STATIC_ASSETS`.
- **Desktop layout (≥ 1024 px)**: `www/css/desktop.css` holds every desktop
  rule inside `@media (min-width: 1024px)` (plus a `1440px` tier). The phone
  layout must not change unless an issue says so — put desktop-only CSS
  there, not in the per-page sheets. Keyboard shortcuts (desktop only) live
  in `js/utils/keyboard-shortcuts.js` (`resolveShortcut()` is pure and
  unit-tested): `Alt+1…9` tabs, `Ctrl+S`/`Ctrl+P` save/print the open bill,
  `/` focus search, `?` help overlay, `Esc` close.
- **Money fields**: bills sometimes store `dueAmount` at top level *and*
  `payment.due` inside a nested object. Both can exist; both can drift.
  Read both, write both, treat the nested one as canonical when present.
- **One tap = one write (#70, #95)**: every button that saves money or stock
  runs its write through `Helpers.runExclusive(key, buttonSelector, fn)`, which
  ignores a second tap and disables the buttons (`aria-busy`) until the save
  ends. Put confirm dialogs *before* the lock (check `Helpers.isBusy(key)` first).
  A write the app retries itself keeps a client-made id (bills: `pendingBill`,
  due payments: the payment entry `id`).
- **Saved / offline (#70, #153)**: never show "Saved" for a write this phone refused.
  Failure toasts use `saveFailedText()` and localStorage writes `safeSetItem()`
  (`utils/storage-full.js`: "Save failed — storage full"); a new bill stored while
  offline says "Saved on this phone, will sync" (`FirebaseService.savedOnPhoneOnly()`) only once
  the phone confirmed storing it; unconfirmed after 10 s (`saveUnconfirmed()`) it keeps the form
  and says "Saving… check before entering again" (expenses: after 4 s).
  The header pill (`ui/sync-status.js`: Offline / N changes waiting to sync / Synced) uses
  online/offline events, `hasPendingWrites` of the existing listeners, the writes
  `saveBill` / `startSaveExpense` send and `waitForPendingWrites()`: no Firestore reads.
- **State**: a single `AppState` object lives in `state.js`. Never invent
  a parallel cache.
- **Businesses / Rentals (#149, #170)**: one app, an `Aadhat | Rentals` switch
  (`js/ui/business-switcher.js`). The first business is shown as **Aadhat** /
  **आढ़त** (formerly "Shop"); code ids, the switcher key, `users.role`,
  `settings/app` and permission ids keep `shop` — change only the `t()` text. Rentals code lives in `js/rentals/` and is
  loaded **only** with `import()` when Rentals opens (rent receipts, `rentals/rent-receipt.js` +
  `rent-receipt-store.js`, the unit picker / change of unit `rent-unit.js` and the tenant link actions
  `rent-link.js`, even later: `rentals.js` imports them only when used; they are in
  the service worker's `LAZY_ASSETS`, not `STATIC_ASSETS`); its data is in `rent_*`
  collections (all access in `rentals/rent-store.js`; receipt list / issue-later / cancel in
  `rentals/rent-receipt-store.js`), roles in
  `users/{uid}.rentRole`. Never import `js/rentals/*` statically or name a
  `rent_*` collection from start-up code: `rentals-startup.test.js` fails.
  Design: `docs/rentals-design.md`.
- **Settings sections**: Common (everyone: language, account, notifications,
  printer, install, About, and the owner's Roles & access), **Aadhat** (owner and
  managers: business name, UPI ID, labour, bill checks, bill numbers, opening
  stock; stored in `settings/app`) and **Rentals** (owner and rentals managers:
  defaults for new leases in `rent_settings/default`, loaded via
  `BusinessSwitcher.loadSettings()` only when shown). Who sees what:
  `utils/settings-sections.js`; routes `settings-shop`, `settings-rentals`,
  `settings-roles` (old `admin-configure` still works). Admin keeps Users and Data.

### Things that look wrong but aren't

- SheetJS (`XLSX`) is loaded on demand via `ensureXLSX()` in
  `www/js/utils/lazy-scripts.js`; don't add it back as a `<script>` tag.
- `firebase.json` sends security headers and a **report-only** CSP on every
  path (#89, `docs/security.md`). A new external origin (fetch, script, image)
  goes into that CSP in the same PR: `security-headers.test.js` fails on an
  `https://` origin in `www/` the CSP doesn't list, and the E2E fixture fails on
  any CSP report. Its `script-src 'unsafe-inline'` is only there for the inline
  handlers; don't add new inline `<script>` blocks.
- `firebase` global is the compat-SDK style — modular SDK is intentionally
  not used.
- Many functions are async but are called without `await` — that's a real
  bug, tracked (with an inventory) in #126. Save/delete/money paths must be
  awaited; intentional fire-and-forget writes (audit log, item-frequency,
  autosave) stay non-blocking but must end in `.catch(...)` logging. Don't
  change a call's blocking behaviour without saying so in the PR.

---

## 5. Standard workflows

### Issues: the bug and feature list

GitHub issues (in `DDancingDeath/happa`, with the code) are the single list of
bugs, features and decisions. (The staging clone's `docs/REVIEW_ISSUES.md`
is archived history — don't add to it or cite it as the master list.)

- **Title tag** — start every title with one of `[Bug]`, `[Feature]`,
  `[Refactor]`, `[Test]`, `[Security]`, `[Perf]`, `[Ops]`, `[Decision]`,
  `[Docs]` (and `[Plan]` for the pinned plan issue only).
- **Labels** — one priority `P0` (data loss / money wrong / app down) …
  `P3` (nice to have); one `type:*` matching the title tag (`type:bug`,
  `type:feature`, `type:refactor`, `type:test`, `type:security`, `type:perf`,
  `type:ops`, `type:decision`, `type:docs`); any number of `area:*`
  (`area:money`, `area:rules`, `area:stock`, `area:offline`, `area:printer`,
  `area:reports`, `area:ux`, `area:ci`). `owner-decision` = blocked on an
  answer from the owner — don't implement a guess; `owner-action` = a console
  click / secret / release only the owner can do.
- **Milestones** — `Sprint 1 - Safety`, `Sprint 2 - Trust`,
  `Sprint 3 - Speed & offline`, `Sprint 4 - Features`, `Later`. The pick
  order across all of them is the pinned plan issue (next subsection).
- **Body** — problem, evidence (file:line), impact, proposed fix, acceptance
  criteria checkboxes. Read the whole body, including any "Additional
  findings" section, before starting, and re-check the problem still exists
  on `main`.
- **Commits / PRs** reference the issue: `fix(stock): … (#29)`; the PR body
  says `Closes #N` (fully fixed) or `Part of #N`.

### Planning: what to pick next

The pinned issue **"[Plan] Roadmap: pick order (auto-updated)"** lists every
open issue in pick order. Take the first open ⬜ row that isn't blocked (⛔).
When you add an issue, place it in `tools/plan/order.json` (right phase,
right position, optional `note` / `after: [N]`). The plan issue regenerates
automatically (`.github/workflows/plan-page.yml` → `tools/plan/generate.js`);
open issues missing from `order.json` show up under 🆕 Unplaced.

### "I want to fix a bug"

1. Find the GitHub issue (search open + closed). If there is none, open one
   first (title tag + labels + milestone as above) and place it in
   `tools/plan/order.json`.
2. Make the change in `www/js/...`. Add a focused Jest test that fails
   without the fix (prefer pure functions).
3. Run `npm ci && npm test` (plus `npm run test:rules` for rules changes,
   `npm run check:sw` / `npm run check:release` when touching `www/`).
   Baseline must stay green. If a shipped `www/` file changed, do the cache
   bump (section 4).
4. Commit with a message like
   `fix(stock): refresh current-stock pane after adjustment (#25)`.
5. Open a PR (`Closes #N`). Don't merge to `main` directly — Firebase
   Hosting auto-deploys on merge to `main` (after the Firestore rules, when
   they changed; section 5, "CI: what runs on a merge to `main`").

### "I want to add a new capability"

1. There must be an issue (`[Feature]`), and any `owner-decision` it depends
   on must be answered first.
2. Update tests, update README if user-facing, ship behind a config flag if
   behaviour-changing. Prefer small PRs that can be reverted on their own.

### "The CSS / a single template needs a tweak"

Usually safe. Desktop-only rules go in `www/css/desktop.css`; check the
phone layout (≈ 390 px) is unchanged. For non-trivial visual changes run a
short Playwright probe against a local static server (`?emulator=1`, see
section 7) before pushing; don't commit one-off probe scripts.

### Releasing (Android APK + web)

1. Add the release at the top of `www/changelog.json` (`version`, `date`,
   `androidVersionCode` = previous + 1, short `notes.en` / `notes.hi`).
2. `npm run release -- <x.y.z> --code <n>` (updates `package.json`,
   `www/js/version.js`, `android/app/build.gradle`), then
   `npm run check:release`.
3. Merge to `main` after shop hours (web deploys automatically), then push a
   release-candidate tag `v<x.y.z>-rc<n>` (a prerelease, never offered by the
   update banner) and run the manual checks in `docs/release-checklist.md` with
   its APK (real printer, 5 bills offline, cash open/close, install over the
   previous APK, timings).
4. All good: push tag `v<x.y.z>` on the same commit, after shop hours.
   The tag-driven Android release workflow (#92 / PR #173) builds and signs
   the APK (Happa key, `HAPPA_*` secrets, pinned to `HAPPA_CERT_SHA256`) and
   publishes a GitHub Release with `happa.apk`.
5. Installed apps see the "Update available" banner (checks
   `releases/latest`, at most every 12 h); `/download` always links to the
   latest APK; users get a one-time "What's new" sheet.

### Code-review rules

`.github/review-rules.yml` is a regex registry of mistakes this codebase
keeps making (FirebaseService bypass, `showToast(msg, 'error')`, raw date
parsing, top-level `app` shadowing, …). `npm run check:review` checks the
lines your branch adds (vs `origin/main`) and fails on `severity: block`;
CI runs it on every PR. `node scripts/check-review-rules.js --all` reports
existing violations. When the owner accepts a review finding that a regex
could have caught, add a rule (with `learned_at`) and, ideally, an example
in `.github/review-rules-examples/`.

### CI: what runs on a pull request

- **`ci.yml`** (every PR and push to `main`): *Lint, Jest, release checks* and
  *Firestore rules tests*. Jest includes a docs link check
  (`tests/ci/docs-links.test.js`: every relative link in a `.md` file must point
  to a file that exists). Nightly it also runs the read-only production smoke
  (`npm run test:smoke`).
- **`e2e.yml`**: the Playwright E2E suite (`tests/e2e`, Firebase emulators;
  every page × role × en/hi × phone/desktop). It runs on **every PR that changes
  the app**: `www/**`, `firestore.rules`, `firestore.indexes.json`,
  `firebase.json`, `scripts/happa-config.js`, `tests/e2e/**`,
  `playwright*.config.js`, `package.json` / `package-lock.json` or `e2e.yml`
  itself. Docs-only and tools-only PRs skip it. It also runs
  nightly, on manual dispatch and on any PR labelled `e2e`. Three shards
  (`npx playwright test --shard=N/3`, each with its own emulators), 1 retry on
  CI; the job summary lists flaky tests (failed, then passed on retry) and the
  reads per page. Browsers, firebase-tools and the emulator jars are cached.
  On failure, download the `test-results-N` (traces) or `playwright-report`
  artifacts.
- **`firebase-hosting-pull-request.yml`**: a preview channel per PR (test data)
  on each hosting site, expiring after 2 days; when the PR closes its channels
  are deleted on every site (Firebase limits the channels per site).
- **Required check name: `Playwright E2E (emulators)`** (the job that collects
  the shards; it passes when E2E was not needed). Don't rename it: branch
  protection matches it by name. The shard jobs (`E2E shard N/3`) are not stable
  names to require.
- The every-page smoke (`tests/e2e/tabs-smoke.spec.js`) **fails** on page or
  console errors, NaN / undefined / raw keys, text mixing both languages, Hindi
  on an English screen, **English left on a Hindi screen**, pages stuck loading,
  and pages over their **read budget**. Each of its tests starts from a freshly
  seeded emulator (`tests/e2e/support/seed.js`), so what the specs that add data
  ran before it in the shard does not change its read counts. The English-on-Hindi allow-list is in
  `screenFindings` (brand names, units, user/test data, App health rule ids);
  fix real leftovers with `t()` keys in `en.js` + `hi.js`. Mark deliberate
  other-language text with `lang="en"` (e.g. an app name like **Files**) and
  codes with `lang="zxx" translate="no"` (device ids).
- **Read budget**: each page's first-open Firestore reads (the app's read meter,
  `www/js/firebase/firestore-meter.js`; `startup` = login until ready) are
  compared with `tests/e2e/read-baselines.json`; each step waits for the meter
  to be still (500 ms, at most 3 s) before counting, so a slow page's late reads
  are not charged to the next page. A page fails above its baseline + 25% (at
  least + `minSlack` = 1 read, for a listener update that still lands on the next
  page) or above the hard cap (300 reads). If a change makes a page
  read more on purpose, run
  `E2E_RECORD_READS=1 npx playwright test tests/e2e/tabs-smoke.spec.js` (raises
  baselines, never lowers them; delete an entry first to lower it), check the
  diff and say why in the PR.
- Run locally: Java 21 on `PATH`, `npm run test:e2e` (or one shard:
  `npx playwright test --shard=1/3`). The emulators run the demo project
  `demo-happa-e2e` on ports 9099 (auth) and 8181 (firestore). If another emulator
  holds a port, set `E2E_AUTH_PORT` / `E2E_FIRESTORE_PORT` (and `E2E_PORT` for the
  static server, default 8099): the ports are set at test time, with a gitignored
  `.e2e.firebase.json` (`--config`) for the emulators and the static server serving
  `www/firebaseConfig.js` and `www/r/rent-history.js` rewritten to that project and
  those ports (`tests/e2e/support/emulator-target.js`). Don't edit `firebase.json`
  or those `www/` files for it. The migration E2E (`npm run test:migration-e2e`)
  does the same with its own demo project `demo-happa-migration` on 9199 / 8281
  (`MIGRATION_E2E_PROJECT`, `MIGRATION_E2E_AUTH_PORT`, `MIGRATION_E2E_FIRESTORE_PORT`),
  so the two never share data. `tools/migrate --emulator` refuses any project id
  that is not `demo-*`.

### CI: what runs on a merge to `main` (deploy order)

One workflow, **`firebase-hosting-merge.yml`** ("Deploy to Firebase on merge"),
deploys every push to `main`, **rules first, then Hosting** (after #196 the new
app ran ~25 minutes on the old rules and its writes were refused; the rules are
backward-compatible by design, so they go live first):

1. **Plan** (`tools/ci/deploy-plan.js`): the rules are deployed when any of
   `firestore.rules`, `firestore.indexes.json`, `happa.config.json`,
   `firebase.json`, `firestore-rules-deploy.yml`, `tools/ci/deploy-with-retry.js`
   or `tools/ci/live-rules.js` changed since the **last confirmed deploy**: the
   newest successful run of this workflow whose Hosting job really ran its
   "Deploy to Firebase Hosting" step (so a rules change whose deploy failed is
   redeployed by the next push). **Fail safe:** if that can't be confirmed (GitHub
   API error, no such run, or its commit isn't an ancestor of this one), the
   rules are deployed first anyway.
2. **Firestore rules + indexes**: calls `firestore-rules-deploy.yml`
   (`workflow_call`; section 7): rules tests, the retried deploy, and a check
   that the live ruleset equals `firestore.rules`.
3. **Hosting**: runs only if step 2 **succeeded**, or was **not needed**. If the
   rules deploy fails, Hosting is not deployed (the live app keeps the old
   build), the run fails, and the **Deploy alert** job opens an `[Ops]` issue
   (`tools/backup/alert.js`, kind `deploy`; it never comments: a repeat failure
   updates the issue's "Last failure:" line, and the next good run closes it).
   Fix or wait out the cause, then **Re-run failed jobs on the LATEST failed
   run**: the rules, then Hosting, run again.
4. **Stale runs skip.** The rules, Hosting and alert jobs first check that
   their commit is still the head of `main` (`tools/ci/current-head.sh`); if
   not, they skip their deploy steps with a notice. So re-running an OLD run
   (or dispatching the rules workflow from another branch) can't roll the site
   or the rules back.

Runs are serialized (`concurrency: deploy-main`, never cancelled). The
`aadhat-management` guard runs before every deploy and `--force` is refused.
`firestore-rules-deploy.yml` no longer runs on push by itself; a manual
dispatch deploys only the rules and indexes.

### Numbers on screen (#216)

Every money/stock number the app shows has a plain-language definition with a
spec ID in `docs/calculations.md`. Money, insight and statement figures (M*, I*)
come from one pure module, `www/js/utils/business-metrics.js` (owner choices in
`utils/insights-config.js`), Today's (T*) from `todaySummary()` in `www/js/utils/calc/today.js`, the bill forms' (BF-*, WS-*) from `www/js/utils/calc/billing.js` (rounding: one named policy per figure, `ROUNDING`) and Stock's (S*) from `www/js/utils/calc/stock.js` (`stockValue()` is the one stock value, also Money's), the cash drawer's (C*) from `www/js/utils/calc/cash.js` (`drawerDay()` for C1–C6, the count / close / opening checks for C8); calendar steps (days, months, periods) only through `utils/dates.js`; pages only render them, and each figure has one home
page (`utils/metric-registry.js`, checked by `metric-registry.test.js`). `tests/oracle/` recomputes each one with an
independent, simple implementation and compares it with the screen;
`tests/property/` runs the accounting checks (stock value adds up, bill split,
payments, months = all time, outstanding, cash drawer, same period = same
number) on generated multi-year histories (`tests/fixtures/generator.js`,
fast-check, fixed seed; `FC_RUNS=50 npx jest tests/property` for more runs).
A number the app gets wrong today is listed in `BUGS` in
`tests/oracle/screens.test.js` (or a `test.skip` with `// BUG: see #N`); remove
the entry when you fix that issue. `npm run test:mutation` (Stryker, local or
the weekly non-blocking `mutation.yml` job) shows how many deliberate small
bugs in `money.js`, `calc/billing.js`, `stock-replay.js`, `bill-checks.js`, `dates.js` and
`release-info.js` the tests catch. Owners and managers can run the same checks
on real loaded data in Diagnostics → Number checks.

To check a whole backup offline, run `npm run audit:numbers -- <backup.json>`
(`tools/audit/`; optional `--bundle <migration bundle.json>` adds the migrated
state, `--app <checkout>` audits another branch's `www/`). It computes every
spec number for each of the last 60 days, the last 24 months and all time twice,
with the oracle and with the app's own screen code in jsdom, plus AC1–AC8,
cross-page agreement and the number checks, and writes `NUMBER-AUDIT.md` next to
the backup (it refuses to write inside the repo). It then audits the **phone
path** (`tools/audit/phone.js`): the windowed history, dues listeners, stock
checkpoint, month snapshots, rate history and cash sessions loaded by the app's
own `FirebaseService` from an in-memory Firestore, for several "today"s
(`--phone-dates`, `--no-phone`), each opened by the owner with a fresh and with
the month-end stock checkpoint and by a member; figures the app shows as unknown /
approximate (and says so on screen) are counted separately. Takes about three minutes for ~7k
bills and reads only that file, no Firestore. Real data never goes into the repo,
CI, an issue or a PR: turn each new mismatch class into an anonymised fixture in
`tests/fixtures/calculations/` with an oracle test (`tests/oracle/real-shapes.test.js`),
skipped with its issue while the bug is open, and give it a cause in
`tools/audit/causes.js`.

### Architecture rules

Target layers and the order of the refactor are in
[docs/architecture.md](docs/architecture.md): calc (pure, `www/js/utils/`) →
services → repositories → UI. Anywhere in `www/js` (`modules/`, `rentals/`,
`ui/`, `services/`, `auth/`, `main.js`, …):

- no arithmetic on money or quantity, no `Math.round(qty * rate)`, no `reduce` of
  amounts: call (or add) a function in `utils/` with a spec ID (calc: `utils/**`
  and the pure `rent-math` / `rent-views` / `rent-public` are exempt);
- no numbers read back from the screen (`Number(el.textContent)`,
  `Helpers.getElementInt`), calc included;
- no Firestore calls (`.collection(`, `db.doc(`, `runTransaction`, `batch`,
  `where`, `onSnapshot`, transaction / batch operations, `firebase.firestore.FieldValue`)
  and no way round them (`.db`, `FirebaseService.<x>Ref(` under any alias,
  `firebase` other than `.auth` / `typeof`, `window.firebase`, Firebase SDK / CDN imports)
  outside the repositories (`firebase/**`, `rentals/rent-store.js`,
  `rentals/rent-receipt-store.js`), calc included. This one is absolute: no
  baseline entry, no exception; add a repository function instead;
- no `AppState.<x> = …` or `AppState.<list>.push(…)`, calc included;
- no calendar arithmetic (`new Date(y, m, d + 1)`, `n * DAY_MS`) outside calc:
  use `utils/dates.js`.

`www/js/__tests__/architecture-guard.test.js` counts these per file against
`tests/architecture-baseline.json` and fails when a count goes up or a new file
has one. When your change lowers a count, run
`ARCH_BASELINE=lower npx jest architecture-guard` and commit the baseline. Never
raise it to get a PR green; move the logic instead. A raise against the PR base
fails unless the baseline's `exceptions` records it
(`{file, category, from, to, reason, issue}`, reviewed in the PR).

### PR checklist

- [ ] Tests, `npm run lint` (0 errors), `check:review`, `check:sw`, `check:release` pass.
- [ ] App change → the E2E check `Playwright E2E (emulators)` is green (section 5, "CI").
- [ ] Shipped `www/` file changed → cache bump (section 4).
- [ ] Added or changed a number shown on screen (or how it is calculated) →
      updated its entry in `docs/calculations.md` and its oracle test in
      `tests/oracle/` (review rule `displayed-number-spec` warns).
- [ ] Architecture ratchet green; lowered `tests/architecture-baseline.json` if a
      count went down (docs/architecture.md).
- [ ] New user-facing text in both `i18n/en.js` and `i18n/hi.js`; no "staff".

---

## 6. The staging clone (archived)

`AadhatManagementApp-staging` (private) was a read-only mirror used for
early experiments. It is now **archived on GitHub (read-only)**; a git
bundle backup of it exists with the owner. Treat it as a historical
reference only:

- Don't develop, verify or log bugs there; don't cite its
  `docs/REVIEW_ISSUES.md` / `PAGE_SPECS.md` as current. Anything still
  relevant has been (or should be) filed as a GitHub issue here.
- It talked to the same Firebase project through an ordinary approved staff
  account, `staging-readonly`; `firestore.rules` has no special rule for it.
  `tools/migrate` never carries it (or `staging-owner`) into happa; disabling it
  in the old project is an owner action (#101).
- Old commits that cite a staging SHA keep that reference; new work doesn't.

---

## 7. Firestore rules — reminder

`firestore.rules` in this repo is the source of truth for Firebase's
deployed rules. **Editing these without updating Rules Playground tests
can break every user immediately**. What each role may see and do is set by
the owner in Settings → Roles & access (`settings/app.roleAccess`); the
permission list, defaults and which parts the rules enforce are in
`docs/role-permissions.md`. Always:

1. Edit the file.
2. Add/adjust cases in `rules-tests/test.js` and run `npm run test:rules`
   (Firestore emulator). Key cases: pending user denied, approved/legacy
   (no `status`) users allowed, no self-promotion of `role`/`status`.
3. Merge to `main`. `firebase-hosting-merge.yml` calls
   `.github/workflows/firestore-rules-deploy.yml` **before Hosting** when the
   rules, indexes or config changed (section 5, "CI: what runs on a merge to
   `main`"); it also runs on manual dispatch (rules and indexes only, from
   `main`'s head). It
   reruns the rules tests and deploys `firestore.rules` +
   `firestore.indexes.json`. It needs the github-action
   service account to have "Firebase Rules Admin" and "Cloud Datastore Index
   Admin"; if those are missing the job fails and names them. Manual fallback:
   `firebase deploy --only firestore:rules,firestore:indexes`. CI never
   deletes indexes that exist only in the console (no `--force`). The deploy
   runs through `tools/ci/deploy-with-retry.js`, which retries transient
   Google API errors (503/500/502/504/429/409, ECONNRESET, deadline) up to 7
   attempts (15s/30s/60s/120s/180s/240s backoff) and fails at once on compile
   or permission errors. A 409 "Release … already exists" counts as deployed
   only if the live ruleset equals `firestore.rules`. The last step,
   `tools/ci/live-rules.js verify`, reads the live `cloud.firestore` release's
   ruleset from the Firebase Rules API (read-only, with the service account)
   and fails unless its source equals the repo's, so Hosting never deploys on
   rules that are not live.

To run the whole app against local emulators:
`npx firebase-tools emulators:start --only auth,firestore`, serve `www/`
and open `http://localhost:<port>/?emulator=1` (uses `dev_` collections;
seed a `dev_users/<uid>` profile with a role).
The move from the old app (old backup → `tools/migrate` → the app) has its
own end-to-end test on the emulators: `npm run test:migration-e2e`
(`tests/migration-e2e/`, see `tools/migrate/README.md`; it runs on every PR that
changes `www/**`, the rules or the tool).

**Bill edit window (#87, #84).** Everyone except the owner may edit or void a
bill only for the role's `editDays` (Settings → Roles & access,
`settings/app.roleAccess.<role>.editDays`, default **2**) after it was first
saved (managers: edit any bill; others: their own; void: own bill only). The
clock is the bill's `createdAt`, the server time written by `saveBill()` on
the first save; rules compare it with `request.time` and refuse any change to
it. The client-written `timestamp` is never used for this. Bills saved before
this (no `createdAt`) count as outside the window: only the owner can change
or void them. Recording payments / clearing dues is not limited. The client
mirrors this in `utils/role-access.js` (`canEditBillWith` / `canVoidBillWith`).

**Void, never delete; every edit keeps a record (#75, #121).** A bill is voided
(`voided`, `voidedAt`, `voidedBy`, `voidReason`; `FirebaseService.voidBill`), not
deleted: only the owner deletes bills (the app offers it only for a voided bill).
Whether a bill counts anywhere is one predicate, `isActiveBill()` in
`utils/money.js`: FirebaseService keeps voided bills out of AppState's bill
lists (History gets them from `FirebaseService.voidedBills()`), and every
calculation that reads bills checks it too (`activeBills()` / `activityBills()`,
`outstandingDue()`, `saleTimePayment()`, the stock replay). A void is refused
while the bill has later payments; a voided bill never changes again. Every
change to a bill's items, money or party writes `<bills>/{id}/edits/{n}`
(before/after of the changed fields, the editor, a required reason) in the same
transaction (`updateBillChecked(collKey, record, { reason })`); records are read
only from the bill details (`loadBillEdits`). Details: docs/role-permissions.md
"Void and edit records".

---

## 8. Common pitfalls

- **`firebase.firestore()` calls outside `FirebaseService` / a repository** —
  bypass the collection-prefix wrapper and fail the architecture guard. Put the
  call in `firebase/repos/` and resolve names with `window.getCollection(name)`.
- **`new Date(billDate)` where `billDate` is `DD/MM/YYYY`** — JS parses
  this as `MM/DD/YYYY` on most browsers and silently produces a wrong
  date. Use `parseAnyBillDate()` (`utils/dates.js`) or `Helpers.parseDate()`.
- **`alert(`...${userInput}...`)` and `innerHTML = ...userInput...`** —
  XSS. Use `Helpers.escapeHtml()` on every concatenated user value before
  it touches the DOM.
- **Non-batched per-recipient `for await { add() }` loops** — slow and
  partial-failure-prone. Use a `WriteBatch`.
- **Bill numbering with `count + 1`** — race condition. Use a Firestore
  transaction on a daily counter document. When that counter can't be reached
  (offline / timeout), `Helpers.generateBillNumber` issues a per-device number
  `{prefix}{YYYYMMDD}-{device}-{seq}` (3-char device code kept in
  localStorage, per-device daily sequence) — decided over pre-issued number
  blocks (#41 / Q28) because it needs no server round-trip to set up.

---

## 9. When in doubt

Stop and ask. The cost of a wrong production change is paid by the owner
in customer-facing breakage; the cost of one extra clarifying question is
zero.
