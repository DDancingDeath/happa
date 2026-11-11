# Platform design: one core, many shop apps (happa, kirana, pharmacy)

Status: **proposal** (docs only, no code change), 1 Nov 2026, `main` at `ddf9dc0`.
Owner's goal: *"the idea is to build different apps with the core design of this"*: the existing
happa (grain aadhat + rentals), then a kirana (grocery) billing app, a medical (pharmacy) billing
app and others, all on one shared core.

Read with: [architecture.md](architecture.md) (layers, calc map, repositories, ratchet),
[calculations.md](calculations.md), [role-permissions.md](role-permissions.md),
[security.md](security.md), [rentals-design.md](rentals-design.md), `firestore.rules`, AGENTS.md.

**Recommendation in one paragraph.** Grow the core *inside* this repo, behind a guard, while happa
stays live: first a boundary manifest and an import-direction guard (phase 0), then move generic
code into `www/js/core/**` in place (phase 1), then an app registry (phase 2), then turn the repo
into an npm-workspaces monorepo whose `packages/core` is copied (byte-for-byte, checked in CI) into
each app's `www/js/core/` (phase 3), then `apps/kirana` (phase 4) and `apps/pharmacy`. For
tenancy, use **one Firebase project per shop on Spark** for the owner's own shops (≤ ~5–10 shops),
but write every new app's data under `shops/{shopId}/…` from day one, so that moving to a
**multi-tenant Blaze project** later (if shops are sold to others) is a data copy, not a rewrite.

---

## 1. Goals and non-goals

| Goals | Non-goals |
|---|---|
| One core (money, calc primitives, data layer, offline, auth/roles, i18n, printing, dues, cash, history, audit/TIP, SW, guard, E2E, backup, CI) shared by every shop app | A big-bang rewrite, or a pause in happa work. **happa stays live** through every phase; each phase is small PRs that keep CI, E2E and the read budgets green |
| A new app = a manifest + domain plug-ins + pages, not a fork | Changing happa's data model. happa keeps its root collections (`purchases`, `settings/app`, `users`, `dev_` prefix) unless a later, separate migration is decided |
| India-ready next apps: GST tax invoice / bill of supply, HSN, MRP, barcode, loose items, UPI QR, GSTR-1 export, udhaar; pharmacy batch/expiry, licence no., Schedule H/H1 register, strip/loose | GST e-invoicing (IRP, only above ₹5 cr turnover), e-way bills, filing through a GSP API (we export files; the CA files them) |
| Keep the owner's constraints: Spark plan, vanilla ES modules, no bundler, no framework, raster printing, English default + Hindi, one language at a time | A bundler, TypeScript build, React, Cloud Functions (not on Spark) |
| Each app keeps happa's quality bar: oracle per figure, characterisation before refactors, read budgets, the ratchet | Multi-shop features inside happa now (rentals-design.md §3.5 stays "later") |
| DPDP Act: consent notice, purpose, erasure, in core | Being a certified medical or GST software vendor (no accreditation exists for small billing apps, but see open questions) |

---

## 2. Core vs app boundary

### 2.1 Where today's files go

(a) **core**, (b) **happa-aadhat app**, (c) **rentals module** (a core *module*, reusable by any
app that wants rent), (d) **extension point** = the core owns the mechanism, the app supplies a
plug-in. "Split" means the file holds both, and the generic half goes to core.

| Today (`www/js/…` unless noted) | Goes to | Notes |
|---|---|---|
| `utils/money.js` | (a) split | `round2`, `toMoney`, `sumMoney`, `formatRupees`, `billTotal`, `readPayment`, `outstandingDue`, `isActiveBill` / `activeBills` / `activityBills`, opening records, expense mode → core. `DEFAULT_LABOUR_*`, `billLabour`, `normalizeLabourSettings`, `perUnitRate`, `wholesaleOutstanding` → happa. Its one `t()` (`paymentSplitMessage`) moves to the caller |
| `utils/dates.js` | (a) | IST day/month/period maths. Its `t()` default label becomes a parameter |
| `utils/calc/billing.js` | (a)+(b) split | Payment split / prefill / Rest→Due, `validatePaymentSplit`, `validateDuePayment`, `ROUNDING` → core `calc/payment.js`; weights, `computeLine`, labour, wholesale profit → happa `calc/aadhat-billing.js`. Line totals become (d) **line calculator** |
| `utils/calc/cash.js`, `utils/cash-session.js` | (a) | Cash drawer C1–C9 |
| `utils/calc/today.js` | (a)+(b) | Sales / cash in-out / dues → core; T3, T-LAB-* (labour, kg) → happa via (d) **Today cards** |
| `utils/calc/stock.js`, `stock-replay.js`, `stock-check.js`, `stock-adjust.js`, `dead-stock.js` | (a)+(d) | AVG-COST replay is core; the quantity unit and **stock strategy** are (d): happa = average cost per kg, pharmacy = per batch, first-expiry-first-out. `stock-replay` → `helpers.parseDate` → `firebase/repos/counters` is a core-to-repo cycle to cut in phase 0 |
| `utils/due-payments.js`, `aging.js`, `party-due.js`, `due-reminder.js` | (a) | Dues / udhaar ledger, ageing, WhatsApp reminder |
| `utils/bill-edits.js` | (a) | Void / edit records (#75, #121) |
| `utils/bill-checks.js`, `number-checks.js`, `anomalies.js` | (a)+(d) | Check runner in core; rule packs per app (labour, oversell in kg → happa; MRP ceiling, expired batch → kirana / pharmacy) |
| `utils/business-metrics.js`, `finance-calc.js`, `metric-registry.js`, `month-snapshots.js`, `insights-config.js`, `takeaways.js` | (a)+(d) | `moneySummary` (M*), `outstandingTotals`, comparisons, registry, snapshots → core; I5 / I9 (kg by season, weekly kg) → happa **metric pack** |
| `utils/rate-trends.js`, `item-rate-series.js`, `product-traffic.js`, `labour.js` | (b) | Grain seasons, kg trends, labour. `rate-history.js` → core (price history is useful to every app) |
| `utils/statements.js` | (a)+(d) | Day book, party ledger, CSV → core; item ledger's quantity column via the unit plug-in |
| `utils/role-access.js`, `settings-sections.js`, `record-permissions.js` | (a)+(d) | Mechanism core; the permission ids (`finance`, `wholesale`, `purchaseRates`, `shopSettings`…) and `TAB_ROLES` become an app **permission pack** |
| `utils/personal-expenses.js`, `expense-entry.js` | (a) | Expenses incl. personal (#98, #118) |
| `utils/helpers.js` | (a) split | `escapeHtml`, `runExclusive`, `parseDate` → core; `generateBillNumber` → core service over `repos/counters` (not in calc) |
| `utils/events.js`, `state.js`, `render-memo.js`, `background-tasks.js`, `rebuild-lease.js`, `storage-full.js`, `clock-skew.js`, `quota-guard.js`, `startup-timings.js`, `lazy-scripts.js`, `open-external.js`, `template-loader.js`, `validator.js`, `keyboard-shortcuts.js`, `release-info.js`, `history-*.js`, `chart-scale.js`, `data-export.js`, `notification-format.js`, `item-catalog.js`, `insights-context.js`, `bill-share.js` | (a) | Generic. `state.js` keeps `AppState`, but its bill lists become keyed by **bill kind** (registry) instead of `salesHistory` / `retailSalesHistory` names |
| `utils/constants.js` | (a)+(b) | `APP_CONFIG.COLLECTIONS` and `DEFAULT_SETTINGS` (labour) → app manifest |
| `firebase/firestore-service.js` | (a) | Becomes the core data layer once architecture phase 5 splits it; bill collection names come from the registry |
| `firebase/repos/*.js`, `firebase/firestore-meter.js` | (a) | Repository base (section 2.2) |
| `www/firebaseConfig.js`, `config/app-identity.js`, `happa.config.json` | (d) | Generated per app from its manifest (`scripts/happa-config.js` → `scripts/app-config.js`) |
| `i18n/index.js`, `localize.js` | (a) | `en.js` / `hi.js` (135 KB / 207 KB) split into a core pack + an app pack per language |
| `services/printer.js`, `printer-link.js` | (a)+(d) | Raster engine, Bluetooth link, timeouts, preview → core; `_drawWeightsBreakdown`, bill layout → happa **receipt template** |
| `services/audit.js`, `telemetry.js`, `install-prompt.js`, `user-admin.js`, `tip/**` | (a) | TIP scenarios per bill kind are (d) |
| `auth/authentication.js` | (a) | Role gating reads the registry |
| `ui/*` (ui-manager, navigation, sync-status, infinite-scroll, bill-row, bill-status, bill-highlight, party-due-line, finance-breakdown-sheet, business-switcher, scroll-cue, heading-emoji) | (a) ui-kit | `navigation.js` route table and the switcher's businesses come from the registry |
| `modules/billing.js` | (a)+(d) | Draft / auto-save / save shell → core; bill **forms** are (d) |
| `modules/purchase.js`, `retail-sale.js`, `wholesale-sales.js`, `rate-trends.js` | (b) | happa's bill kinds and the Seasons view |
| `modules/day.js`, `cash-management.js`, `outstanding.js`, `history.js`, `items.js`, `stock.js`, `miscellaneous.js`, `money.js`, `insights.js`, `statements.js` | (a)+(d) | Core pages with app slots (Today cards, item form fields, history columns, metric packs) |
| `modules/admin.js`, `users.js`, `roles-access.js`, `settings.js`, `notifications.js`, `diagnostics.js`, `health.js`, `anomalies.js`, `app-updates.js` | (a) | `settings.js` renders the app's **settings schema** |
| `rentals/*`, `templates/rentals.html`, `css/rentals.css`, `r.html`, `r/` | (c) | Already lazy and isolated (`rentals-startup.test.js`); becomes an optional core module an app enables |
| `main.js` | (b) | The app's composition root: `bootCore(manifest)` plus its own wiring of `window.app.*` |
| `service-worker.js` | (a)+(d) | Core template; the asset lists and the `happa-vN` name are per app (`scripts/check-sw-assets.js` stays the gate) |
| `templates/*.html`, `css/*` | (a)+(b) | Per page as above; `desktop.css` core |
| `firestore.rules`, `rules-tests/test.js` | (a)+(b)+(c) | Composed (section 6) |
| `tools/backup`, `tools/ci`, `tools/tip`, `tools/audit` (harness) | (a) | Collection list from the manifest; `tools/audit` oracle stays per app |
| `tools/migrate` | (b) | Old Aadhat app → happa only |
| `tools/plan`, `.github/review-rules.yml` | repo | Shared |
| `scripts/check-sw-assets.js`, `check-review-rules.js`, `mixed-language-scan.js`, `release.js`, `release-notes.js` | (a) | Run per app |
| `tests/oracle`, `tests/property`, `tests/fixtures/generator.js` | (a) harness + (b) cases | |
| `tests/e2e/support/*`, `tabs-smoke.spec.js` | (a) | Page × role × lang × size list from the registry; `read-baselines.json` per app |
| `android/`, `capacitor.config.json`, `.github/workflows/android-release.yml` | (b) | One Android project and key per app |

### 2.2 The core's public API

Everything an app may import lives under `core/` and is listed in `core/index.js` (the contract;
contract tests in section 7). Anything not exported there is internal.

| Area | Public API (names indicative; most exist today) | Rules it guarantees |
|---|---|---|
| Money and rounding | `round2`, `toPaise` / `fromPaise`, `sumMoney`, `formatRupees(v, lang)`, `allocate(total, parts)`, `ROUNDING` policy table (`line`, `billTotal`, `payment`, `stockValue`, `taxLine`, `roundOff`) | One rounding rule per figure (F-R1 / #129 decides happa's). New apps compute tax in **integer paise**; display rounds once |
| Dates | `dates.*` (`startOfLocalDay`, `periodBounds`, `monthRange`, `parseAnyBillDate`, `todayLocalISO`, `formatDay`), plus `financialYear(d)` (Apr–Mar, needed for GST series) | IST, "now" is a parameter |
| Calc primitives | `billTotal`, `readPayment`, `outstandingDue`, `isActiveBill`, payment split / prefill, `drawerDay`, `stockValue`, `moneySummary`, `buildAging`, `dayBook`, `partyLedger` | Pure; oracle-tested |
| Repository base | `defineRepo({ name, scope })`, `col(name)` → `prefix + base + name` where prefix = `''` or `dev_`, base = `''` (happa, **root mode**) or `shops/{shopId}/` (**shop mode**); `optimisticWrite(fn, { clientId })` (client-made ids, `savedOnPhoneOnly`, `saveUnconfirmed`), `inTransaction`, counters | Only repositories touch Firestore (guard); every path built by one function, so tenancy is a config switch |
| Sync / offline | `syncStatus` (`ui/sync-status.js`), `pendingWritesWaiter`, `safeSetItem`, `runExclusive` (one tap = one write) | Never "Saved" for an unconfirmed write |
| Auth, roles, sections | `registerRoles`, `registerPermissions`, `registerPages` / `registerSections`, `canOpenTab`, `can(role, perm)`, `accessFor`, edit window `canEditBillWith` / `canVoidBillWith` | Same conditions as the rules (generated from the same data) |
| i18n | `t(key, params)`, `setLang`, `registerStrings(lang, pack)`, `pickLang`, `data-i18n*` | Core pack + app pack; catalogue and single-language guards per app |
| Printing / receipts | `ReceiptLayout` engine (blocks: header, party, lines table, tax summary, totals, payment, footer, QR), `printCanvas`, preview, PDF / image | Raster only; layouts are data + small draw functions |
| Share | `billShareText`, `openExternal`, WhatsApp reminder, `upiUri({ pa, pn, am, tn })` + QR block | No network |
| Cash drawer | `calc/cash`, cash-sessions repo, pages | One session per day, transactions |
| Dues / udhaar | `due-payments`, `aging`, `party-due`, bill-payments repo, Outstanding page | Transactions, no overpay (rules) |
| Void / edit history | `bill-edits`, `voidBill`, `updateBillChecked(kind, record, { reason })` | Void never delete; edit record in the same transaction |
| Audit / telemetry / TIP | `AuditService.log`, `Telemetry`, `tip/*` (scenario registry) | Bounded reads |
| Service worker | SW template + `assets.json` per app; `check:sw`; cache-bump script (`?v=`, `BUILD_ID`, `CACHE_NAME`) | Precache budget per app |
| Architecture guard | `architecture-guard` (5 categories) + new **layer** rule: `core/**` imports only `core/**` | Ratchet per app |
| E2E harness | `seed`, `emulator-target`, `read-budget`, `tabsSmoke(registry)` | Every page × role × en/hi × phone/desktop |
| Backup / restore / migrate | `tools/backup` driven by the manifest's collection list; restore drill; `tools/migrate` framework (plan / apply / wipe, `demo-*` only on emulators) | Encrypted backups, monthly drill |
| CI | Reusable workflows (`workflow_call`): lint+jest, rules tests, E2E shards, rules-then-hosting deploy, Android release, backup | Inputs: `app`, `project`, `site` |
| Privacy (new) | `consent.record(partyId, purpose)`, `erase(partyId)` (pseudonymise name/phone, keep statutory fields), retention table per app | DPDP Act (section 9) |

---

## 3. Domain extension model

**Recommendation: config for data, a plug-in registry for code.** The rules generator, backup tool,
E2E harness and CI must read the app's shape *without running browser JS*, so the shape is JSON
(`app.config.json`). Behaviour (tax maths, line maths, receipt drawing, pages) is code in the app's
`www/js/app/manifest.js`, registered at boot with `defineApp()`.

| What | Declared in | Shape |
|---|---|---|
| Identity, Firebase, Android id, site | `app.config.json` | today's `happa.config.json` fields + `"app": "kirana"` |
| Tenancy mode | `app.config.json` | `"paths": "root"` (happa) or `"shop"` |
| Collections and bill kinds | `app.config.json` | `billKinds: [{ id, collection, prefix, direction: "in"|"out", stock: -1|0|1, party: "customer"|"supplier", taxDoc: true }]` |
| Item model | `app.config.json` (fields) + `manifest.js` (validators) | `item.fields`, `units`, `saleUnits` (conversions), `track: "avgCost"|"batch"` |
| Tax engine | `manifest.js` | `tax: "none" | "gst"`; GST mode per shop setting: regular (tax invoice) or composition (bill of supply) |
| Line calculator | `manifest.js` | `computeLine(line, item, ctx)` → `{ qty, rate, amount, taxable?, tax? }` |
| Pages, sections, nav | `manifest.js` (+ templates) | `pages: [{ id, route, template, module, perm, roles, lazy }]` |
| Roles and permissions | `app.config.json` | `roles` (core gives owner / manager / member), `permissions: [{ id, en, hi, defaults, enforced: "client"|"rules" }]` |
| Settings schema | `app.config.json` | `settings: [{ key, type, min, max, default, section, editableBy }]`; the rules generator turns it into `managerShopSettingsOk`-style field lists |
| Receipt templates | `manifest.js` | `receipts: { [billKind]: [blocks…] }` |
| Rules fragments | `apps/<app>/rules/*.rules` | section 6 |
| Checks / anomalies / metrics / Today cards / TIP scenarios | `manifest.js` | packs registered into the core runners |

Examples (abridged):

| | happa (aadhat) | kirana | pharmacy |
|---|---|---|---|
| `units` | `kg` | `piece`, `kg`, `g`, `l`, `ml`, `pack` | `strip`, `tablet`, `bottle`, `piece`, `ml` |
| Item fields | name, purchase/retail/wholesale rate per kg | name, barcode (EAN-13), HSN, GST rate, MRP, sale price, loose (y/n), pack size | name, salt/composition, manufacturer, HSN, GST rate, schedule (`OTC`/`H`/`H1`/`X`), pack (e.g. 10 tablets/strip) |
| Stock strategy | `avgCost` per item (AVG-COST) | `avgCost` per item | `batch`: per item + batch no. + expiry + MRP, FEFO on sale |
| Bill kinds | purchase (farmer, labour), retail, wholesale | sale, sale return, purchase | sale, sale return, purchase (batch inward), return to distributor (expiry) |
| Tax | `none` (unprocessed grain; plain bill) | `gst`: tax invoice (regular) or bill of supply (composition) per shop | `gst`, usually regular |
| Line calc | kg from weights × rate, whole rupees | qty × price, price ≤ MRP, tax-inclusive back-calc | qty in tablets / strips, price per strip ÷ pack, ≤ MRP of the batch |
| Extra rules | labour deduction, package weight | MRP ceiling, HSN present on a tax invoice | Rx required for H/H1/X lines, no expired batch, licence no. on the bill |
| Extra pages | Seasons, Rentals (module) | GSTR-1 export, barcode scan | H1 register, expiry alerts, batch view |
| Receipt | today's layout with weights | GSTIN, HSN, tax summary, UPI QR | + DL nos., batch / expiry per line, prescriber, pharmacist |

A sketch of the code side:

```js
// apps/kirana/www/js/app/manifest.js
import { defineApp, gstEngine, avgCostStock } from '../core/index.js';
import { kiranaLine } from './calc/line.js';
import { saleReceipt } from './receipts/sale.js';
export default defineApp({
  id: 'kirana',
  tax: gstEngine(),            // mode from settings: 'regular' | 'composition'
  stock: avgCostStock(),
  lines: { sale: kiranaLine, saleReturn: kiranaLine, purchase: kiranaLine },
  receipts: { sale: saleReceipt },
  pages: [/* core pages + { id: 'gstr1', route: 'gstr1', lazy: true, perm: 'reports' } */],
  checks: ['mrpCeiling', 'hsnOnTaxInvoice'],
});
```

**Tax engine contract** (pure, paise): `compute(lines, { mode, shopState, partyState })` →
`{ lines: [{ taxable, rate, cgst, sgst, igst, cess }], byRate, byHsn, roundOff, total, docType }`.
`docType` is `"bill"` (none), `"taxInvoice"` (regular) or `"billOfSupply"` (composition, no tax
shown, with the composition legend). Prices are tax-inclusive by default (MRP); taxable =
price × 100 / (100 + rate) per line, rounded to the paisa, CGST = SGST = half (intra-state).
**Rates are data, not code**: the GST slabs were rationalised in Sept 2025 (mostly 5% / 18% / 40%;
flagged: confirm the current schedule), so rates live on the item and in a dated table.

---

## 4. Tenancy and deployment

### 4.1 Numbers that decide it

| Limit | Value | Source / confidence |
|---|---|---|
| Firestore free quota (Spark, and the free tier of Blaze) | 1 GiB stored, **50k reads / 20k writes / 20k deletes per day**, 10 GiB egress / month, **per project**, reset midnight Pacific (12:30 / 13:30 IST) | Firebase pricing; sure |
| happa's own use | Nightly backup ≈ 132 reads; page first-opens in `tests/e2e/read-baselines.json`; Rentals ≈ 1.7k on first open at 100 properties (rentals-design.md §3.4) | Measured |
| Free quota only on the `(default)` database | Named databases (one per shop in one project) are Blaze-only and not free | Flagged: check |
| Hosting (Spark) | 10 GB stored, ~360 MB/day transfer (some docs now say 10 GB/month); **36 sites per project** | Flagged: transfer wording |
| Projects per Google account | Default Cloud project quota for an account without billing is **small, typically ~5–10**; more by request (Google's form), not guaranteed | **Flagged: varies per account** |
| Projects per billing account (Blaze) | A low default (often ~5) linked projects; raise by request | Flagged |
| Phone (SMS) sign-in | Recently Blaze-only for new SMS | Flagged; happa has none on screen |
| Cloud Storage | Needs Blaze for new default buckets (2025–26 change) | Flagged; matters for Rx images |
| Rules | 256 KB source per ruleset, 1,000 expressions, 10 `get`/`exists` per request (20 in a batch/transaction) | Sure. `firestore.rules` is **123 KB** today |
| Blaze price beyond the free tier | ~$0.06 per 100k reads, ~$0.18 per 100k writes (US); `asia-south1` slightly different | Flagged: check region price |
| Play Console | One developer account ($25 once) publishes many apps; new personal accounts must run a closed test (12+ testers, 14 days) before production | Flagged: policy changes |

### 4.2 The two options

| | **(A) One Firebase project per shop** (Spark) | **(B) One multi-tenant project** `shops/{shopId}/…` (Blaze) |
|---|---|---|
| Cost | ₹0 per shop while each stays under 50k reads/day | Shared 50k free reads/day, then per read; needs a card on file; budget **alerts do not cap** spend |
| Isolation | Strong: separate data, auth users, rules, quota; one bad listener hurts one shop | Logical: rules by membership; a rules bug can leak across shops; one shop's heavy use eats everyone's free tier |
| Rules | Today's rules, unchanged in shape (`users/{uid}` profile) | Every rule gets `shopId`: `exists(/shops/$(shopId)/members/$(uid))` (same 1 `get` as today's profile read) |
| Onboarding | Create project, enable Auth + Firestore, register web app, set authorised domains, deploy rules + indexes, seed owner profile: **~15–30 min scripted, plus console clicks** | Create `shops/{id}` + owner member: seconds, in-app |
| Project quota | Hits the per-account cap after ~5–10 shops; customers could own their projects (they add our service account) | One project |
| Updates | Rules / indexes deploy × N (matrix job; a 503 on one shop must not block the others); Hosting: one site per **app**, not per shop (4.3) | One deploy |
| Backups | Per project (N workflow runs, each ~a few hundred reads) | One export (Blaze has managed export to Cloud Storage) |
| Reporting across shops | Not possible without a server | Possible (collection group queries) |
| Auth | One login per shop project (an owner of two shops signs in twice) | One login, shop picker |
| Fit | The owner's own shops, a handful of friendly shops | Selling to many shops |

**Recommendation: (A) now, built so that (B) is a data copy.**

1. happa stays in `happa-bfc07`, root mode, forever (or until a separate decision).
2. Each new app/shop gets its own Spark project (`kirana-<shop>`, `pharma-<shop>`), provisioned by a
   new `tools/provision` script (creates nothing silently: prints the console steps it can't do,
   then deploys rules / indexes and seeds the owner).
3. New apps run in **shop mode from day one**, with a single `shopId` (e.g. `main`) and
   `shops/main/members/{uid}` for roles. Rules, repositories and the backup tool already speak
   `shops/{shopId}`, so going multi-tenant (B) later means: one Blaze project, copy each shop's
   `shops/main/**` to `shops/<newId>/**` (the existing `tools/migrate` plan/apply pattern), import its
   Auth users, point the app's config at the new project. No app code change.
4. Switch to (B) when any of: more than ~5 shops, selling to shops the owner doesn't run, or a feature
   that needs a server (SMS OTP, Rx image storage, cross-shop reports).

### 4.3 Deployment shape

- **One hosting site and one APK per app**, not per shop. Under (A) the app needs the shop's
  Firebase config: the first run asks for a **shop code** (or scans a QR) that maps to a
  `{ projectId, apiKey, appId }` entry in a small `shops.json` served by the app's site (Firebase web
  config is public by design). The owner's own shops can be baked into the build. The SW, offline
  store and `localStorage` are per origin; the Firestore offline cache is per project, so two shops on
  one phone don't mix.
- Each shop project must list the app's site in **Auth › Authorised domains** (provisioning step).
- `firebase.json` CSP already allows `*.googleapis.com`; no new origin per shop.
- Release check: `app-updates.js` reads `changelog.json` from its own site, but `release-info.js`
  uses the repo's `releases/latest`. With several apps in one repo "latest" is ambiguous: each app
  must read its own tag prefix (`kirana-v*`) or a version file on its own site.

---

## 5. Repo and build layout

| | **Monorepo, npm workspaces** (`packages/core`, `apps/happa`, `apps/kirana`, `apps/pharmacy`) | **Core as a versioned package**, separate app repos |
|---|---|---|
| Core change across apps | One PR changes core + every app; CI runs every app | Release core, then a bump PR per app repo |
| CI cost | Path filters per app; a core change runs all apps' Jest + E2E (~8–9 min each, parallel) | Each repo pays only for itself |
| Issues / plan | One issue list, one `tools/plan` | Split |
| Secrets | Per-app secret names in one repo (`HAPPA_*`, `KIRANA_*`) | Natural separation |
| Risk to happa | Repo restructure touches workflows, Capacitor, `firebase.json` | happa untouched until it consumes the package |
| Selling one app | Harder to hand one app's code to someone | Easy |

**Recommendation: monorepo, in this repo (`DDancingDeath/happa`)**, because one person maintains
everything and core changes must be tested against every app at once. Keep happa **at the repo root**
until phase 3b; moving it to `apps/happa/` is a separate, late, mechanical PR. (Never reuse the old
`happa-monorepo` repo.)

Target layout:

```
packages/core/            # source of truth: src/** (ES modules), rules/*.rules, i18n/{en,hi}.js,
                          # sw/service-worker.template.js, e2e/, tools/ (backup, ci, provision)
packages/core/VERSION     # semver, bumped on any API change (contract tests)
www/                      # happa (phase 3b: apps/happa/www/)
  js/core/  -> copy of packages/core/src + CORE_VERSION stamp
apps/kirana/   www/ (js/core copy, js/app/, templates/), app.config.json, capacitor.config.json,
               android/, firestore.rules (generated), firebase.json
apps/pharmacy/ same
.github/workflows/_app-ci.yml, _app-e2e.yml, _app-deploy.yml, _android-release.yml  (workflow_call)
```

**No bundler.** Browsers load `www/js/core/*.js` with relative imports (`../core/index.js`).
Import maps would need an inline `<script type="importmap">`, which the CSP plan (#89, phase 7)
wants to remove, so we don't use them. `scripts/sync-core.js` copies `packages/core/src` into each
app's `www/js/core/` and writes `CORE_VERSION`; the copies are **committed** so `www/` stays "served
exactly as written" (AGENTS.md rule 3) and Capacitor / Hosting deploy the folder as-is.
`npm run check:core` (CI) fails if any copy differs from the source. It's a copy, not a build:
nothing is transformed. Each app's SW lists its core files from a generated `core-assets.json`;
`check:sw` keeps working per app.

**Capacitor per app**: own `capacitor.config.json` and `android/` project, own app id
(`com.happa` today; e.g. `com.happa.kirana`, `com.happa.pharmacy`: branding question),
**own signing key** (losing one only strands that app), own secrets (`KIRANA_KEYSTORE_BASE64`…), own
tag prefix (`v*` stays happa's; `kirana-v*`, `pharmacy-v*`), own GitHub release asset. Hosting: one
site per app (`myhappa`, e.g. `happa-kirana`, `happa-pharmacy`) with its own `/download`.

---

## 6. Rules composition

Firestore rules have no `include`, so composition is textual and checked:

```
packages/core/rules/00-helpers.rules    isSignedIn, membership/role (root and shop mode), moneyOk,
                                        totalOk, reasonOk, voidOk, editCountOk, validEditCreate,
                                        counters, entryTimeOk, clientGate
packages/core/rules/10-core.rules       users/profiles, settings/app guard, cash sessions, expenses,
                                        dues/payments, drafts/auto-save, notifications, audit,
                                        telemetry, tip*, monthStats, stockCheckpoints
packages/core/rules/20-rentals.rules    (module, opt-in)
apps/<app>/rules/*.rules                bill kinds, items, app settings fields, H1 register, …
tools/rules/compose.js                  -> apps/<app>/firestore.rules (header: GENERATED)
```

- The generator takes the app's `app.config.json` (bill kinds, collections, roles, settings fields,
  `paths: root|shop`) and **emits the `dev_` twin** of each block (today hand-duplicated: e.g. the six
  `…/edits/{editId}` blocks, `firestore.rules:1888-1928`), which also shrinks the file.
- `npm run check:rules` fails if the committed file differs from the generator output (same pattern
  as `check:happa-config`). The deployed file stays a plain, reviewable `firestore.rules`, and
  `tools/ci/live-rules.js verify` keeps comparing it with the live ruleset.
- Each app's output must stay well under **256 KB**; CI warns above 200 KB.
- App fragments use an app prefix for their functions (`kir_`, `rx_`) to avoid clashes.
- **Shared rules tests**: `rules-tests/` becomes `packages/core/rules-tests/` with suites parameterised
  by the app config (pending user denied, no self-promotion, edit window, void, payment rules,
  dev_/prod split, shop isolation: a member of shop A can't read shop B); each app adds its own suite
  (kirana: MRP / HSN fields; pharmacy: H1 entry required with an H1 line, register append-only).

For happa, phase 0–2 changes nothing in the rules; the generator first reproduces today's
`firestore.rules` byte-for-byte (a test), and only then do fragments move.

---

## 7. Testing

| Layer | Shared (core) | Per app |
|---|---|---|
| Contract tests | `packages/core/__tests__/contract/*`: every name in `core/index.js` exists, its signature and behaviour on golden cases; `VERSION` must bump when an export changes | The app's `core/` copy runs the same contract suite (cheap, catches a stale copy) |
| Oracle / characterisation | Patterns + harness (`tests/oracle/oracle.js` style, `tests/fixtures/generator.js`, property checks AC*) for core figures: dues, cash drawer, money summary, payment split, rounding | happa keeps its oracle; kirana / pharmacy add one for tax (independent GST calc on generated bills, AC: Σ line tax = invoice tax ± round-off, GSTR-1 totals = Σ invoices) and pharmacy stock (Σ batches = item stock, no sale from an expired batch) |
| Architecture guard | `architecture-guard` + new layer rule (core imports only core; app code never imported by core; rentals module imports only core) | Baseline per app (`tests/architecture-baseline.json` each) |
| Rules | Shared parameterised suites (section 6) | App suite |
| E2E | `tabsSmoke(registry)`: every page × role × en/hi × phone/desktop, read budgets, CSP reports, mixed-language and NaN checks | `read-baselines.json`, one billing flow spec, one print-preview spec |
| Guards | `single-language-guard`, `i18n-catalogue`, startup-graph (lazy modules), `check:sw`, `check:review` | Run on each app's `www` |
| Mutation | Stryker on core calc | Optional per app |

---

## 8. Migration plan for happa

Every phase is a series of small PRs following architecture.md §5 (characterise first, move don't
change, lower the ratchet, cache bump). Live-app checks after each merge: deploy green, `BUILD_ID`
changed on myhappa, E2E and read budgets unchanged.

| Phase | PRs | Size | Exit criterion |
|---|---|---|---|
| **0. Boundary + guard** | (1) This doc. (2) `tools/platform/boundary.json`: today's files tagged `core`, `happa`, `rentals`, `split`. (3) Guard rule `coreImports`: a `core`-tagged file may import only `core` files (baselined; counts may only go down); first hits: `stock-replay → helpers → repos/counters`, `money.js` / `dates.js` → i18n strings, labour constants in `money.js` | S | Guard green, baseline recorded |
| **1. Move generic code into `www/js/core/**` in happa** | One family per PR, each **re-exporting from the old path** so inline handlers, Stryker, the oracle and `tools/audit` keep working: (a) money/dates/rounding, (b) dues + ageing, (c) cash, (d) void/edit, (e) repositories base + `col()`, (f) i18n infra (keys unchanged), (g) printing engine vs happa layout, (h) role/section registry mechanism, (i) ui-kit. Split `money.js` / `calc/billing.js` / `calc/today.js` as in 2.1. Precede with arch phase 5 (split `firestore-service.js`) for the data layer | M (≈10 PRs) | All `core/**` hits of the layer rule = 0; old paths are thin re-exports |
| **2. App-config registry** | `app.config.json` (generalises `happa.config.json`; `scripts/happa-config.js` → `app-config.js`, with a `happa` alias), `defineApp()` + happa manifest: bill kinds, permissions, pages / nav, settings schema, Today cards, metric pack, receipt template. Rules generator reproducing today's file byte-for-byte | M | happa boots from its manifest; rules generated = committed |
| **3a. Workspaces** | Root `package.json` workspaces; `packages/core` as source; `sync-core` + `check:core`; reusable workflows; happa still at the root | M | happa CI identical; core contract tests run |
| **3b. (optional) Move happa to `apps/happa`** | One mechanical PR: `www/`, `android/`, `firebase.json`, workflows, AGENTS.md paths | M | Only when a second app is live |
| **4. `apps/kirana` MVP** | Scaffold from core (`tools/provision`, manifest, rules fragment, E2E smoke), then the MVP list (section 9) in ~8–12 PRs | L | First real kirana bill printed and synced |
| **5. `apps/pharmacy` MVP** | Batch stock strategy in core, H1 register, Rx capture | L | Pharmacy MVP live in one shop |

Risks:

| Risk | Mitigation |
|---|---|
| Breaking happa while moving files (inline `onclick` strings, `template-loader` paths, Stryker / oracle imports by path) | Re-export from the old path; no renames of `window.app.*` methods; E2E every page; move only after characterisation |
| Collisions with in-flight work and the 3 cache-bump lines | One phase-1 PR at a time; rebase-and-rebump discipline (AGENTS.md §4) |
| Precache budgets grow (core + app) | Per-app `check:sw` budget; lazy modules as Rentals does |
| Core leaking grain words (kg, labour, farmer) | Layer guard + a `coreWords` ratchet (count `kg`, `labour`, `wholesale` in `core/**`) |
| Committed core copies drift | `check:core` byte compare in CI |
| Rules size / complexity (123 KB now; 256 KB cap) | Per-app generation; generated `dev_` twins |
| Per-shop projects multiply ops (deploys, backups, alerts) | Matrix workflows; alert issue per project (`tools/backup/alert.js`); move to (B) past ~5 shops |
| Project quota on the owner's account | Ask Google early; or customers own their project |
| GST / drug-rule mistakes have legal weight | Owner's CA / a pharmacist reviews receipts and exports before go-live; rates as data |
| Architecture phases 3, 5, 6, 7 still open | Do phase 5 (split firestore-service) before phase 1e; phases 3 / 6 / 7 can run in parallel and make the move easier |

---

## 9. Kirana and pharmacy MVPs

### 9.1 Kirana MVP

| Feature | Core work | App work |
|---|---|---|
| Item catalogue: barcode, HSN, GST rate, MRP, sale price, unit, loose | Item schema mechanism, units + conversions, rate history | Fields, validators, Excel import columns |
| Fast counter sale: scan / search, qty or weight, loose items | Bill shell, drafts, `runExclusive`, offline save, bill numbers per FY | Line calculator; barcode scan (camera via `BarcodeDetector` on Android WebView / a Capacitor plugin; USB/Bluetooth scanners type into the field) |
| MRP ceiling | Check runner | `mrpCeiling` rule (client + rules: `rate <= mrp`) |
| GST tax invoice vs bill of supply | Tax engine (paise), receipt tax-summary block | Shop setting regular / composition, GSTIN, state; invoice series ≤ 16 chars, unique per FY (offline device series fit, e.g. `K26A-000123`) |
| UPI QR on the bill and screen | `upiUri` + QR block (vendored QR encoder, no new origin) | Payee VPA in settings (today happa keeps the UPI ID per device) |
| Udhaar (credit) with WhatsApp reminders | Dues ledger, ageing, reminders, Outstanding page | Wording |
| Sale return | Bill kind mechanism, stock +1 | Credit note numbering |
| Purchase from distributor (with GST input) | Purchase bill kind, supplier dues | Fields: supplier GSTIN, invoice no. |
| GSTR-1 export (B2B, B2C small, HSN summary, docs issued) as JSON/CSV for the CA | Export framework (`data-export.js`, CSV) | GSTR-1 mapping |
| Cash drawer, expenses, Today, Money, Statements | As in happa | Today cards (sales by tax rate) |
| Roles, Hindi/English, print, share, backup, TIP | As in happa | String pack |
| DPDP: consent on customer phone capture, erase | Privacy module | Retention table (GST records: 72 months, flagged) |

### 9.2 Pharmacy MVP

| Feature | Core work | App work |
|---|---|---|
| Batch / expiry / MRP per batch, FEFO | **Batch stock strategy** (`track: "batch"`) in the stock engine; stock value per batch | Purchase entry of batches |
| Strip / loose tablets | Unit conversions (strip = N tablets), qty in base unit | Sale UI: strips + loose |
| Batch, expiry, MRP on every bill line | Receipt line columns from the template | Template |
| Drug licence numbers (and GSTIN, pharmacist) on the bill | Header block from settings schema | Settings fields |
| Schedule H / H1 / X: prescription required; H1 register (patient, prescriber, drug, qty, date) | Append-only register collection pattern (like `edits`) | `rx_` rules: an H1 line needs a register entry in the same batch; register never edited |
| Prescription capture | Camera capture, compressed image | Store a small JPEG (≤ ~150 KB) in a Firestore doc (1 MiB doc cap) on Spark; Cloud Storage needs Blaze (flagged) |
| Expiry alerts (30 / 60 / 90 days), near-expiry return | Anomaly / notification runner | Rule pack, return-to-distributor bill kind |
| GST, UPI QR, udhaar, cash, reports | As kirana | |
| DPDP: patient data is sensitive; consent + erasure vs legal retention (Rx / H1 records kept for years, flagged: confirm period) | Privacy module: pseudonymise outside the retention set | Retention table |

Rough sizing: kirana MVP ≈ L (core tax + receipt blocks ≈ M, app ≈ M); pharmacy ≈ L (batch stock is
the big core change; H1 / Rx ≈ M).

---

## 10. Open questions for the owner

| # | Question | Why it matters | Default if no answer |
|---|---|---|---|
| 1 | Your own shops only, or sell to other shops? | Picks (A) vs (B), Blaze, support, DPDP role (you become a data processor) | Own shops: (A) |
| 2 | Free or paid for others? | Blaze cost recovery, Play Store payments | Free for own shops |
| 3 | Which app first: kirana or pharmacy? | Kirana needs GST + barcode; pharmacy also needs batch stock and H1 | Kirana (smaller, its tax engine is reused by pharmacy) |
| 4 | Do you have a real kirana / pharmacy to pilot with, and its GST type (regular or composition)? | MVP scope and receipt legal text | Composition (bill of supply) first |
| 5 | Branding: one "happa" family (`com.happa.kirana`) or separate names? | App ids and signing keys can't change after release | `happa` family |
| 6 | Play Store or APK download (like happa)? | Play needs closed testing (12 testers × 14 days for new personal accounts, flagged), health-app declarations for pharmacy | APK download first |
| 7 | One login for a person who works in two shops? | Only (B) gives that | Separate logins under (A) |
| 8 | Can a CA and a pharmacist review the bill formats and the GSTR-1 export before go-live? | Legal correctness | Required before go-live |
| 9 | Rx images: OK to keep a small photo in the database (Spark), or move to Blaze for storage? | Cost vs quality | Small photo on Spark |
| 10 | Keep happa at the repo root, or move it to `apps/happa/` when kirana starts? | One noisy PR | Keep at root until a second app is live |
| 11 | Resolve happa's open F-R1 rounding (#129) before core freezes `ROUNDING`? | Core inherits it | Recommended (b) |
