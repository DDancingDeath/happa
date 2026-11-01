# Rentals module: design (#170, decision #149)

Status: design, phase 1 in progress (`feat/rentals-phase1-170`). Owner answers recorded (§6).
Merges after the happa go-live PRs (#231 → #226 → #228 → #229 → #230 → #227 → #232).

## 0. Decision (owner, 2026-10-25, #149)

- **One app, happa, with a separate section per business.** The grain business,
  **Aadhat** (आढ़त), is business #1, rentals is next, more may come later. No separate apps.
- **Hard requirement: "make sure it doesn't make the whole app slow."** Section 4
  turns this into rules that CI checks.
- The app moves to Firebase project `happa-bfc07` as is (#231). Aadhat keeps its
  current top-level collections (`purchases`, `items`, …). **Aadhat data is not
  restructured.** Rentals gets its own `rent_*` collections next to them.
- **Name (owner, 2026-10-26):** the first business is shown as **Aadhat** / **आढ़त**
  (it was "Shop"). Only the screen name changed: code ids, the switcher key, the
  `role` field, `settings/app` and the collections keep `shop`.

This is the #149 option C ("businesses with modules"), started in the cheapest
way that keeps Aadhat untouched: Aadhat is the implicit business #1 on the
existing paths, and rentals is born in its own collections. The full nested
`businesses/{bid}/…` shape is described in 3.5 as the way to add a second
business of the same type. It is not built now.

## 1. Scope (from #170)

| Area | What | Phase |
|---|---|---|
| Properties and units | Property (name, address, kind: house/shop/flat/plot/godown/other); units inside it (label, default monthly rent), vacant/occupied | 1 |
| Tenants | Name, WhatsApp phone, notes | 1 |
| Tenancy (lease) | Unit + tenant, monthly rent, due day (1–28, default the **10th**), start month, deposit amount (recorded only), yearly increase % (default **5**) | 1 |
| Rent due and collection | One charge per lease per month (deterministic id, so it is created once even from two phones), partial payments, mode cash/UPI/bank/cheque | 1 |
| WhatsApp reminder | One tap: a bilingual text with the open months and the total, sent to the tenant's chat | 1 |
| Agreements | End month, notice period, lock-in, escalation % and next escalation month, agreement type | 2 |
| Deposits ledger | Received / adjusted against dues / refund entries; shown as money held, **not** Aadhat cash (built: §13) | 2 |
| Receipts | Plain, **non-GST** rent receipt (tenant, unit, month, amount, mode, balance): WhatsApp text and printable/thermal. No GST fields | 2 |
| Maintenance expenses | Per property: repairs, property tax, society, insurance, broker; cash/bank mode | 2 |
| Electricity | **Sub-meter** per unit: previous and current reading, rate per unit; (current − previous) × rate added to that month's charge | **1** (small: one dialog, one transaction, rules check the arithmetic) |
| Rent increase reminder | Yearly, on the lease anniversary: "Rent increase due: 5% → ₹X" on the Rent page. **Never applied automatically**; the new rent is saved by hand after agreeing with the tenant. % editable per lease (default 5) | 1 |
| Water / other utilities | Fixed or metered, like electricity | 3 |
| Reminders | Rent due / late, lease ending in 30/60 days, escalation month: rentals cards on Today and in the notifications bell (in-app, no push: Spark has no Cloud Functions) | 3 |
| Reports | Monthly expected vs collected, outstanding per tenant (aging), yearly income per property (ITR "house property"), occupancy, deposits held, CSV/Excel | 3 |
| Audit | Every create/edit/delete of lease, payment, deposit | 1 (payments), 2 (rest) |

**Who uses Rentals (owner, 2026-10-25):** only Aadhat's own people — the owner and
helpers given a rentals role. Tenants never get accounts or logins and never use
the app; they only receive WhatsApp reminders and receipts (and, in the follow-up
PR, a read-only link to their own rent history — no login). Settings › Roles & access
› People lists only app users.

Out of scope: online rent collection, e-stamp/agreement generation, GST invoices,
tenant accounts of any kind, photo upload (Storage needs Blaze on new projects).

### Reuse without coupling to Aadhat's money math

| Building block | Reused how | Not reused |
|---|---|---|
| `utils/due-reminder.js` | `normalizePhone`, `whatsAppReminderUrl`, `cleanText`, `formatINR`, `formatDMY` (pure) | `buildReminderText` (bill wording); rentals has its own text builder |
| `utils/open-external.js` | Opens `wa.me` in Android/web | – |
| `utils/money.js` | `round2` only | `readPayment()` / bill `payment.due` shapes: rent charges have one simple shape (`amount`, `paid`) |
| `utils/aging.js` | Phase 3: the same day buckets (0–30, 31–60, …) for "outstanding per tenant" via a small adapter | Party/bill model |
| `services/printer.js` | Phase 2: a rent-receipt layout through the existing raster/image path | Bill layouts |
| `services/audit.js` | `AuditService.log('RENT_PAYMENT', …)` | – |
| Expenses (`miscellaneous.js`) | Pattern only (form + list); rentals expenses live in `rent_expenses` | Aadhat's `expenses` collection, so Aadhat Finance/Reports and cash drawer numbers don't move |
| Cash (`cash-management.js`) | **Not reused.** Owner confirmed (2026-10-25): rent and deposits never go into Aadhat's cash drawer; rentals money is kept separate | – |
| Notifications (#12) | Phase 3: rentals reminders as notification items, created only on a device that opened Rentals | – |
| i18n (`t()`), `Helpers.escapeHtml` / `escapeJsAttr`, `UIManager.showToast/showModal` | As everywhere | – |

## 2. Business switcher UX

- **Where:** a two-button switch at the top of the side menu, under the user name:
  `🌾 Aadhat | 🏠 Rentals` (`🌾 आढ़त | 🏠 किराया`). It is shown only to people who may open more than one
  business (owner, or anyone with a rentals role). Everyone else sees exactly
  today's menu.
- **What it does:** the menu shows only the current business's pages.
  - Aadhat: today's links (Today, Billing, Sales, …).
  - Rentals: **Rent**, **Tenants**, **Properties** (phase 1), later Expenses,
    Deposits, Reports.
  - Shared in both: Settings (and the language toggle / notifications bell).
  Done with one body class (`biz-rentals`) and `data-biz` on menu links, so no
  Aadhat link markup or the role code in `authentication.js` changes.
- **Always starts on Aadhat** (owner rule "don't make the app slow", review of #10):
  the app never opens Rentals by itself on a cold start, so start-up reads no rentals
  data for anyone. Rentals loads only when someone taps it.
- **Roles per business** (extends #228):
  - `users/{uid}.role` stays the **Aadhat** role (owner / manager / member — `staff`
    internally). The Aadhat **owner is the owner of every business**.
  - New `users/{uid}.rentRole`: absent = no rentals access; `manager` or `member`.
    Owner decision (2026-10-25): **anyone with a rentals role** adds properties,
    tenants and leases, records payments and meter readings and updates records.
    A manager can also correct a month's amount. Only the owner removes records
    and changes access. Only an owner can set `rentRole` (rules), from
    **Settings › Roles & access › People** (owner only; the old Rentals → Access
    page opens it), so `users.js` is not changed. Every write
    carries `updatedBy` (= the writer, checked by the rules) and payments carry
    `by`/`byName`; payments, meter readings, rent changes, move-in/out also go to
    the audit log.
  - A **rentals-only helper** = `role: 'none'`, `rentRole: 'member'`. The Aadhat rules
    already deny any role outside owner/manager/staff, so they can read no Aadhat data.
    Phase 1 rules support this; the client start-up path for such a user (skip the
    Aadhat listeners, open Rentals) is phase 2.
  - #228's `settings/app.roleAccess` stays the per-page switch board for Aadhat.
    Rentals adds `roleAccess.rent.<role>` later (phase 3: e.g. members don't see
    totals) — read from the same `settings/app` doc, so **0 extra reads**.

## 3. Data model

All names go through `window.getCollection()`: production `rent_x`, development
`dev_rent_x`. All rentals reads/writes live in `js/rentals/rent-store.js`
(the rentals equivalent of `FirebaseService`, using `FirebaseService.db`).

### 3.1 Collections (phase 1)

| Collection | Id | Fields |
|---|---|---|
| `rent_properties` | auto | `name` (≤ 80), `address` (≤ 200), `kind` ∈ house/shop/flat/plot/godown/other, `notes`, `archived` (bool), `createdAt` (ms), `createdBy` (uid), `updatedAt` |
| `rent_units` | auto | `propertyId`, `label` (≤ 60), `rent` (default monthly rent, number ≥ 0), `leaseId` (current lease or `null`), `lastReading`, `meterRate` (sub-meter, or `null`), `archived`, `createdAt`, `createdBy`, `updatedAt`, `updatedBy` |
| `rent_tenants` | auto | `name` (≤ 80), `phone` (≤ 20), `notes`, `archived`, `createdAt`, `createdBy`, `updatedAt` |
| `rent_leases` | auto | `unitId`, `propertyId`, `tenantId`, `rent` (number ≥ 0), `dueDay` (int 1–28), `startMonth` `YYYY-MM`, `endMonth` (`null` while active), `deposit` (number ≥ 0, recorded only), `status` ∈ active/ended, `chargedThrough` (`YYYY-MM` or `null`), `increasePct` (0–100, default 5), `rentSince` (`YYYY-MM` the rent was last set), `createdAt`, `createdBy`, `updatedAt`, `updatedBy` |
| `rent_charges` | `{leaseId}_{YYYY-MM}` | `leaseId`, `unitId`, `propertyId`, `tenantId`, `tenantName`, `unitLabel`, `month`, `dueDay`, `rent`, `electricity` (`{prev, curr, rate, units, amount}` or `null`), `amount` (= rent + electricity), `paid`, `open` (bool, `paid < amount`), `payments[]` (`{amount, mode, ref, date YYYY-MM-DD, at, by, byName}`), `createdAt`, `updatedAt` |

Phase 2 adds `rent_deposits` (one ledger per tenant, §13),
`rent_expenses` (`{propertyId, category, amount, mode, date, note}`) and agreement
fields on `rent_leases`. Rent receipts (`rent_receipts`, `rent_counters`) are built: §11.

**Limits (owner: up to 100 properties, 3 today).** At most 100 properties and 20
units per property (enforced when adding). Every listener has a limit sized for
that (properties 100, units/tenants/leases/this month's charges 2,000, open
charges 4,000); a listener that comes back full shows a notice instead of
silently hiding data.

**Monthly charges, multi-device safe (AGENTS.md rule 6).** On entering Rentals, for
each active lease whose `chargedThrough` is before the current month, the app runs
**one small transaction per missing month**, oldest first: it re-reads the lease,
creates `rent_charges/{leaseId}_{month}` for the month after `chargedThrough` (or
the start month) and moves `chargedThrough` to it. Two phones racing → one
transaction retries, sees the new `chargedThrough`, and writes nothing. The rules
only allow `chargedThrough` to move one month per write, so no month can be
skipped (review of #10). A lease can start at most 24 months back; at most 24
months are charged per visit. Cost: 1 read + 2 writes per lease per month.

**Payments** run in a transaction on the charge: `paid = round2(paid + x)`,
`payments` grows by one entry (at most 12 per month, so the rules can add them
up), `open = paid < amount`. Never read-modify-write outside a transaction. Overpaying the lease's latest month is an advance carried forward (§14); any other month refuses it.

**Move-out** (review of #10): the last month can't be in the future. Missing
months up to it are charged first (as above); then one transaction ends the lease
(`status` ended, `endMonth` = `chargedThrough` = last month — final, never changed
again), frees the unit, and deletes unpaid months after the last month. Ending
before the last charged month (a back-dated move-out that deletes months) is
owner/manager only, and is refused if any later month has a payment. So the
WhatsApp reminder can never list a month after the tenant left (it also filters by
the last month).

**Rent increase** (RENT-6): 12 months after `rentSince` (else `startMonth`) the Rent
page shows "Rent increase due: p% → ₹X" with **Change rent**. Nothing changes until
someone saves; saving sets `rentSince` to this month and the new rent applies from
the next month's charge.

**Electricity** (RENT-7): **Meter reading** on this month's charge: previous
(the reading already on the charge, else the unit's last reading — fixed), current,
rate (the unit's rate; owner/manager may change it); one transaction sets
`electricity`, makes `amount` = rent + electricity (never below what is already
paid) and stores the reading, rate and `meterCharge` on the unit for next month.
Replacing a saved reading is owner/manager only.

### 3.2 Indexes

Phase 1 queries are single-field equality (`status == 'active'`, `open == true`,
`month == 'YYYY-MM'`, `archived == false`), which Firestore indexes automatically:
**no composite index**. Phase 3 reports (`propertyId == x` + `month` range) add
`rent_charges (propertyId ASC, month ASC)` to `firestore.indexes.json`.

### 3.3 Rules

A separate `match /rent_…/{id}` block per collection (+ `dev_` mirror via a
`rentCollections()` list like `businessCollections()`); `rent_*` is **not** in
`businessCollections()`, so the Aadhat wildcard never grants it.

- `rentRoleIn(usersCol)`: profile exists, status not pending/rejected, and
  `role == 'owner'` → `owner`, else `rentRole` ∈ manager/member.
- **Read** any `rent_*`: rentals owner/manager/member. An Aadhat member or manager
  without `rentRole` is denied (tested).
- **Properties, units, tenants, leases** create/update: any rentals role, with type
  checks (strings sized, numbers ≥ 0, `dueDay` 1–28, `increasePct` 0–100, months
  `YYYY-MM`) and `updatedBy == auth.uid`; `createdAt`/`createdBy` never change.
  **Delete:** owner only (the app archives instead).
- **Leases** (review of #10): created active with no charges and `endMonth` null,
  together with their unit's `leaseId`. `startMonth`, `unitId`, `tenantId` never
  change. While active, `chargedThrough` moves forward **exactly one month per
  write** (start month first) to a month whose charge exists after the write and
  that is not after this month (IST). Active → ended only in the move-out write
  (`endMonth` = `chargedThrough`, start..this month, its charge exists, the unit's
  `leaseId` cleared in the same write); ending before the last charged month needs
  owner/manager and the old last month's charge deleted. **Ended is final.**
- **Units:** `leaseId` changes only with the lease (set by a new active lease for
  this unit; cleared when that lease ends in the same write). `lastReading` /
  `meterRate` change only with a meter write on a charge of this unit
  (`meterCharge`, checked with `getAfter`); owner/manager may set the rate alone.
- **Charges** create: any rentals role, id = `leaseId_month`, only in the write
  that moves the active lease's `chargedThrough` to exactly that month,
  `amount == rent == lease.rent`, unit/tenant/property/due day = the lease's,
  `paid == 0`, `payments == []`, no electricity. Updates:
  - a **payment**: one new entry with `amount > 0`, `by == auth.uid`; `paid` = old +
    entry ± 0.01, never above `amount`; at most 12 entries;
  - a **meter reading**: previous = saved/last reading, rate = unit rate (members),
    units = current − previous, amount = units × rate, charge = rent + electricity,
    not below `paid`, the unit updated in the same write; re-entry owner/manager;
  - an owner/manager **correction**: payments unchanged or one own entry added,
    `paid` = Σ entries ≤ `amount`, electricity/rent/lease/month/creation unchanged.
  Delete: owner, or owner/manager inside the move-out write (lease active before,
  ended after) for an unpaid month after `endMonth`.
- **Audit:** `auditLogs` also accepts `RENT_*` entries from users with a rentals
  role (a rentals-only helper isn't approved for Aadhat).
- **Profiles:** a user can't set their own `rentRole` (added to the self-update
  deny list) and can't register with one.
- Rules tests run for prod and `dev_` (`defineSuite(prefix)`).

### 3.4 Read/write cost (who pays)

Only people who open Rentals pay anything, and nobody pays at start-up (the app
always starts on Aadhat). Today (3 properties) entering Rentals costs a few dozen
reads. At the limit the owner gave (100 properties, say 300 units/tenants/leases,
~400 open charges):

| Screen / action | Reads (first open of the day) | Re-open within 30 min | Writes |
|---|---|---|---|
| Enter Rentals (5 listeners: properties, units, tenants, active leases, open + this month's charges) | ≈ 100 + 300 + 300 + 300 + 400 + 300 ≈ **1,700** | only changed docs (offline persistence resumes the listen) | 0 |
| Monthly charge generation | 1 per lease once a month (≈ 300) | 0 | 1–2 per lease per month |
| Rent / Tenants / Properties pages | 0 (same listeners, switching pages re-renders from memory) | 0 | 0 |
| Record a payment | 1 (transaction) | – | 1 + 1 audit |
| WhatsApp reminder | 0 | 0 | 0 |
| Settings › Roles & access › People (owner) | users list (already cached by `FirebaseService.loadUsers`) | 0 | 1 per change |

All queries are bounded (limits above) and paid charges drop out of the
`open == true` listener. Re-entering within 30 minutes costs only changed docs, so
even at 100 properties a normal day (a few visits) stays around 2–5k of the 50k/day
Spark reads.

### 3.5 Later: a second business of the same type

When a second rentals business (or a second Aadhat-type business) appears, move to #149's nested
shape: `businesses/{bid}` (name, type, receipt header) +
`businesses/{bid}/members/{uid}` (role) + `businesses/{bid}/rent_units/…`. The
switcher lists businesses instead of types, and the role moves from
`users/{uid}.rentRole` to the member doc. Because every rentals path is built by one
function (`rentCol(name)` in `rent-store.js`), the client change is one function
plus a one-off copy of a few hundred docs. Not done now.

## 4. Performance budget (the hard requirement)

| Guarantee | How it is built | How it is enforced |
|---|---|---|
| Rentals code is not in the start-up path | `index.html` has no rentals tag; `main.js` statically imports only `ui/business-switcher.js` (≈ 3 KB, no Firestore, no `rent_`), which loads `js/rentals/rentals.js` with `import()` on first use. The template (`templates/rentals.html`) and CSS (`css/rentals.css`) are fetched by the rentals module, not by `TemplateLoader.loadAllTemplates()` or `<link>` tags | **Jest `rentals-startup.test.js`** (every PR): walks the static import graph from `index.html` + `main.js` and fails if any `js/rentals/*` file is reachable, if any start-up file mentions `rent_`, if `index.html` or the template loader references rentals, or if `import('…/rentals/…')` appears anywhere other than `business-switcher.js` |
| Zero extra Firestore reads and zero listeners at start, **for everyone** (the app always starts on Aadhat) | All `rent_*` access is in `js/rentals/rent-store.js`; listeners attach in `enter()` and detach in `leave()` (switching to Aadhat, opening an Aadhat page, sign-out) | Same Jest test (no `rent_` in the start-up graph) + **Jest `rentals-cold-start.test.js`**: `BusinessSwitcher.init()` for Aadhat-only, rentals and owner users (with an old saved choice) imports nothing from `js/rentals` (the mocked module records any load) + **Playwright `rentals-startup.spec.js`** (nightly / `e2e` label): logs in as owner against the emulators, waits for the app, and asserts no `js/rentals/` request and no Firestore request whose body mentions `rent_`; then opens Rentals and asserts both appear (the probe works) and that leaving detaches |
| Aadhat read counts and start-up timings unchanged | The Aadhat start-up code isn't changed apart from reading one more field from the already-loaded profile (`rentRole`) and drawing the switch after `app-shown` | Existing `realtime-listeners.test.js` / `quota-guards.test.js` stay green; the Playwright spec also compares `markStartup` timings (#183/#211): `app-shown` must exist and the rentals module must load **after** it |
| Service worker | The rentals files are in `STATIC_ASSETS` (`check:sw` requires every app file). Precache runs in the SW `install` event in the background after the page has loaded, one `cache.add` per file, so it never blocks start-up or a page | `check:sw` + `load-perf.test.js` (existing) |
| Precache size | Measured (phase 1 + owner answers + tenant link + unit views + Settings › Rentals + tenant with the unit + receipts + unit picker): the Rentals files the service worker precaches (`STATIC_ASSETS`: `js/rentals/*` except the lazy files, `templates/rentals.html`, `css/rentals.css`) are **129.0 KiB** (132,138 bytes) as served (LF), 982 bytes under the budget, plus the 3.7 KB switcher that start-up loads. Outside this budget (`LAZY_ASSETS` in the service worker), loaded with `import()` only when used; the service worker's install also caches them, best effort (a failure never blocks the update), into the new version's cache, so they match the precached files and work offline right after a deploy: receipts (§11: `rent-receipt.js`, `rent-receipt-store.js`, `css/rent-receipt.css`, ≈ 22 KiB), the unit picker / move in / change of unit (§12: `rent-unit.js`, ≈ 11 KiB; its amounts and checks are in the precached `rent-math.js`) the tenant link actions (`rent-link.js`, ≈ 4.5 KiB; they need the network anyway) and the deposit ledger (§13: `rent-deposit.js`, `rent-deposit-store.js`, ≈ 13 KiB). The precached files are downloaded once per app version in the background, never at start-up. The tenant page (≈ 16 KB) is not precached | Budget: precached Rentals files ≤ 140 KB as served (raised from 80 → 100 → 120 → 130 KB as the owner added features; the unit picker went lazy instead of raising it again). **Recorded exception, 130 → 133 KB (#157, deposit ledger):** the ledger's screens and data access are lazy, but its maths (RENT-14/15) must live in `rent-math.js` (owner rule: all rentals maths there, with spec IDs and oracle tests), which is precached, plus the Tenants page buttons and the link's balance; ≈ 2.7 KB. **Recorded exception, 133 → 140 KB (#157, advance, §14):** the advance is part of Record payment (an overpayment pays the unpaid months oldest first, with the split confirmed), the monthly-charge and move-out transactions in `rent-store.js` and their maths in `rent-math.js`, which must stay precached (payments work offline, charges are made on entering Rentals); ≈ 6.6 KB. Lazy files: receipts ≤ 24 KB, unit picker ≤ 16 KB, link actions ≤ 6 KB, deposits ≤ 22 KB (raised from 18 KB for moving a left advance into the deposit), reached only through `rentals.js`'s `import()`; `rentals-startup.test.js` fails above any of them, and `check:sw` fails if a lazy file is precached |
| i18n | Rentals strings live in `i18n/en.js` / `hi.js` (≈ 8 KB each, parsed with the rest) because the catalogue test requires every key in both files | Accepted cost: no reads, < 1 ms parse |

**Start-up time budget in CI.** The Playwright spec records the existing
`aadhat:app-shown` mark and fails if the Rentals module was imported before it.
An absolute ms budget is not enforced in CI (shared runners vary by 2–3×); the
recorded numbers are printed so a regression shows in the job log, and the
on-device numbers stay visible in Diagnostics (#183).

## 5. Phased plan

### Phase 1 — smallest useful thing (effort **M**, ≈ 1 week)

Business switcher (always starts on Aadhat); Rentals → **Properties** (add/edit/archive property and its
units), **Tenants** (add/edit tenant, move into a unit with rent + due day + start
month, move out), **Rent** (this month: expected, collected, outstanding; per
tenant/unit: open months with due/partial/paid/late, **Record payment**,
**WhatsApp reminder**, **Meter reading** (electricity), **rent increase reminder** +
**Change rent**; move-out settles charges); **Access** (owner: rentals role per user); rules; tests;
en + hi.

Issues to create (`tools/plan/order.json`, milestone `Sprint 4 - Features`):
- `[Feature] Business switcher: Shop / Rentals sections with per-business roles (#149)` — `P2`, `type:feature`, `area:ux`, `area:rules`
- `[Feature] Rentals phase 1: properties, tenants, monthly rent due/collected, WhatsApp reminder (#170)` — `P2`, `type:feature`, `area:money`
- `[Test] Rentals stay out of the start-up path (import graph + no rent_* reads at start)` — `P2`, `type:test`, `area:ci`

Tests:
- **Unit (Jest):** `rent-math` (months between, charge status due/partial/paid/late, totals, payment validation, pro-rating incl. leap February and moves on the 1st / 31st, change-of-unit and move-in checks, receipt amounts), reminder text (escaping of WhatsApp marks, one language only, months up to the last month), rent increase (RENT-6), electricity (RENT-7), switcher (shown only with access, always starts on Aadhat, Aadhat wins over a slow Rentals load).
- **Oracle:** `tests/oracle/rent.test.js` recomputes RENT-1…RENT-4 (`docs/calculations.md`) with an independent loop over a generated set of leases/payments and compares with `rent-math`.
- **Characterisation:** `rent-characterisation.test.js` pins every figure the Rent / Tenants / Properties pages show, the receipts and the change-of-unit / move-in dialogs for one rich fixture (snapshots recorded before rent maths moved into `rent-math`).
- **Rules (prod + dev_):** Aadhat member/manager without `rentRole` can't read any `rent_*`; rentals-only helper reads rentals but no Aadhat data; any rentals role writes records signed with its own uid; a charge is created only with its lease's `chargedThrough` and at the lease rent; `chargedThrough` can't pass this month or point to a missing charge; a 24-month backfill batch stays within the rules limits; payments can't overpay or forge `by`; meter arithmetic is checked; only owner/manager correct an amount; move-out deletes unpaid later months only when the lease ends (a paid later month blocks it); only owner deletes otherwise; nobody sets their own `rentRole`.
- **E2E:** start-up loads no rentals code or data; property → unit → tenant → move-in → part payment → meter reading → move-out.
- **Start-up guard:** `rentals-startup.test.js` and `rentals-cold-start.test.js` (Jest) + `rentals-startup.spec.js` (Playwright).

### Phase 2 — money completeness (effort **M**)

Agreements (end month, notice period, lock-in, agreement type; the yearly increase
stays a reminder, never automatic), deposits ledger (held / deductions / refund; separate from Aadhat cash),
plain non-GST rent receipt (WhatsApp text + printable/thermal, no GST fields), property expenses, overpayment as
advance, rentals-only users' start-up path, audit for every lease/deposit edit.

Issues:
- `[Feature] Rentals: agreement details (end month, notice, lock-in) (#170)` — `P2`, `type:feature`, `area:money`
- `[Feature] Rentals: deposits ledger, separate from shop cash (#170)` — `P2`, `type:feature`, `area:money`
- `[Feature] Rentals: plain (non-GST) rent receipt on WhatsApp and the printer (#170)` — `P2`, `type:feature`, `area:printer`
- `[Feature] Rentals: property expenses (#170)` — `P3`, `type:feature`, `area:money`
- `[Feature] Rentals-only users: open Rentals without loading shop data (#149)` — `P2`, `type:feature`, `area:rules`

Tests: agreement-end reminders, deposits
balance property test (received − deductions − refunds ≥ 0), receipt text snapshot,
rules for each new collection, Playwright: rentals-only helper sees no Aadhat request.

### Phase 3 — reminders and reports (effort **L**)

Today cards and notification items (due / late / lease ending / escalation),
water/other utilities, reports (monthly expected vs collected, aging per
tenant, yearly income per property, occupancy, deposits held), CSV/Excel export
(owner only, #85), `roleAccess.rent.*` page switches.

Issues:
- `[Feature] Rentals: reminders on Today and in notifications (#170, #56)` — `P3`, `type:feature`, `area:ux`
- `[Feature] Rentals: water and other utilities (#170)` — `P3`, `type:feature`, `area:money`
- `[Feature] Rentals: reports and yearly income per property (#170)` — `P3`, `type:feature`, `area:reports`

Tests: report oracles (sum of months = year; occupancy), aging buckets, export
column snapshot, read-cost test (report reads bounded by month range).

## 6. Owner answers (2026-10-25)

1. **Properties:** added one by one; up to **100** properties (3 today). Enforced:
   100 properties, 20 units each, bounded listeners (§3.1, §3.4).
2. **Who collects rent:** **anyone with a rentals role** (member or manager) records
   payments and updates records; rules keep the role, amount and `chargedThrough`
   protections and record who wrote what (§2, §3.3).
3. **Receipts:** plain, **non-GST** receipts; phase 2 adds a printable / WhatsApp
   receipt. No GST fields.
4. **Cash:** rent and deposits **never** go into Aadhat's cash drawer — confirmed;
   nothing in rentals touches `cashManagement`.
5. **Rent increase:** default **5 % per year per tenant**, editable per lease. The app
   only **reminds** on the anniversary ("Rent increase due: 5% → ₹X"); the rent is
   changed by hand after agreeing with the tenant, never automatically (phase 1).
6. **Electricity:** **sub-meter readings** per unit (previous, current, rate), added to
   that month's charge — small enough, so it is in **phase 1**.
7. **Due day:** the **10th** by default, editable per lease; Late / Part paid follow it.

Text rule (owner, 2026-10-25): every screen text and the WhatsApp reminder are in
one language at a time (English or Hindi via `t()` / the chosen language), never
both in one string.

## 7. Tenant rent-history link (follow-up PR; owner, 2026-10-25)

Owner: *"provide them a link to see the history of the rents, but only for their
property."* Tenants still never log in or use the app; the link is a read-only page.

- **Share token per lease:** 144 random bits (`crypto.getRandomValues`), base64url,
  made by the owner/manager (**Make tenant link**), stored on the lease as
  `shareToken`. **New link** replaces it (old snapshot deleted, old link dead);
  **Turn off link** deletes the snapshot and clears `shareToken`. A moved-out
  tenant's link keeps working (with a "Moved out" banner) until turned off; such
  links are listed under Tenants → "Moved out, link still on".
- **Snapshot** `rent_public/{token}` (`dev_rent_public` in development): `lid` (the
  lease id, needed by the rules), `v`, `dep` (the tenant's deposit held, RENT-14, when above 0), display name (Settings › Rentals header, else the business name from
  Settings › Aadhat, `settings/app.businessName`),
  tenant display name, property · unit, current rent, due day, `ended`/`endMonth`,
  and up to 36 months `{m, rent, elec, units, total, paid, due, st, pd[]}` (RENT-8).
  No phone numbers, no other tenants, no user names, no other ids.
- **Kept current in the same write** as every charge creation, payment, meter
  reading, rent change and move-out (each of those transactions also reads the
  lease and, when it has a link, the snapshot: +1–2 reads per write only for
  leases with a link). Making a link reads the lease's **newest 36** charges once
  (`leaseId ==` + `orderBy(month desc)` + `limit(36)`; composite index
  `rent_charges (leaseId ASC, month DESC)` + `dev_`), commits, then rebuilds the
  snapshot once in a transaction (catches a payment made in between). Renaming a
  tenant, property or unit rewrites the names in that tenant's snapshot.
- **Rules:** `allow get: if true`, `allow list: if false`. Create/update only by a
  rentals role, when `getAfter(lease).shareToken == token`, with a field allow-list,
  string sizes, ≤ 36 months, and `lid` fixed. Setting/clearing `shareToken` on a
  lease is owner/manager only; deleting a snapshot needs the lease to stop pointing
  at it in the same write (or the owner). New leases start without a token.
- **Public page** `/r/<token>`: `firebase.json` rewrites `/r/**` to `www/r.html`
  (before the app's `**` rewrite) with `X-Robots-Tag: noindex` and `no-referrer`.
  `r.html` + `r/rent-history.js` + `.css` (≈ 14 KB, budget 30 KB, tested) read
  exactly **one** document over the Firestore REST API (project from
  `/__/firebase/init.json`): no Firebase SDK, no app code, no service worker, not
  in the app precache; the app's service worker skips `/r.html` and `/r/**`. English
  or Hindi by the browser, with a toggle — one language at a time. Status (Paid /
  Part paid / Due / Late) is worked out when the page opens from the month, due day
  and due, so Late appears without any new write. Mobile first, printable, read-only; unknown/turned-off links
  show "This link is not available".
- **WhatsApp:** the rent reminder ends with "See your rent history: <link>" when the
  link is on; **Send on WhatsApp** in the link dialog sends just the link. The
  phase 2 receipt will carry it the same way. Links made from the APK use the
  public site (`APP_IDENTITY.siteUrl`).
- **Performance:** zero effect on app start (the rentals guards cover `rent_public`;
  the page files are outside `js/` and never imported). The tenant page costs one
  read per open.
- **Tests:** rules (exact-token get, no list, unknown token missing, write without
  the matching lease denied, members only keep it current, turn-off/replace only
  with the lease, payment + snapshot in one write; prod and `dev_`), unit tests for
  the snapshot builders and token, a jsdom test of the page (one read, single
  language, not-found, 30 KB), and the E2E flow (make link → tenant opens it in a
  separate browser with one read → move-out banner → turn off → not available).


## 8. Settings › Rentals (defaults for new leases)

Settings shows a **Rentals** section to the Rentals owner and managers (members see only
Common; see `docs/role-permissions.md`). It is one document, `rent_settings/default`
(`dev_rent_settings/default` in development), read only when that section is shown or a
tenant moves in (once per session, `rent-store.js loadSettings()`), never at start-up:

| Field | Default | Used for |
|---|---|---|
| `dueDay` (int 1–28) | 10 | Due day filled in on Move in |
| `increasePct` (0–100) | 5 | Yearly increase reminder % filled in on Move in |
| `meterRate` (≥ 0 or null) | null | Electricity rate filled in for a unit that has no rate yet |
| `tenantLink` (bool) | false | Owner/manager moving a tenant in also makes the tenant link |
| `receiptHeader` (≤ 80) | '' | Name on rent receipts and the tenant's rent-history page (blank = the business name) |
| `receiptAddress` (≤ 200) | '' | Address under the name on rent receipts (§11) |

Defaults apply to **new** leases only: existing leases keep their own due day, % and link,
and units keep their own electricity rate. Rules: rentals roles read; owner and Rentals
managers create/update (`docId == 'default'`, field allow-list and ranges, `updatedBy` =
writer); the owner deletes. Hard limits (100 properties, 20 units each, 24 months of
back-charges) stay fixed: they size the listeners and the rules.

## 9. Unit types and property-wise / unit-wise views (owner, 2026-10-26)

Owner: *"we have multiple properties, and in each property we have flats and
commercial spaces. I should be able to see property-wise or unit-wise."*

- **Unit type** on `rent_units.type`: `flat` (Flat / फ़्लैट), `commercial` (Commercial /
  shop space / दुकान/कमर्शियल), `office` (ऑफ़िस), `godown` (गोदाम), `other` (अन्य).
  Required when a unit is created; editable; units saved earlier have no type and
  count as Flat until someone sets one. Optional `area` (sq ft, > 0, ≤ 1,000,000) and
  `floor` (≤ 20 characters). Rules check the enum and limits (tests for prod and
  `dev_`).
- **Rent page switch** "Property wise | Unit wise", remembered per device
  (`localStorage['happa.rentView']`), Property wise by default.
  - **Property wise:** page totals, then one card per property: units by type
    ("6 flats · 3 commercial"), occupied / vacant, late count, this month's rent /
    collected / pending. Tapping a card shows the property's totals and its units
    grouped by type, each with tenant, rent, status (Paid / Part paid / Due / Late /
    Vacant), amount due, open months and quick actions (record payment, WhatsApp
    reminder, meter reading).
  - **Unit wise:** every unit across properties with filters (property, type,
    status: occupied / vacant / late / due), search (unit, tenant, property) and sort
    by amount due; totals of the shown rows. Filters redraw only the list.
  - Tenants who moved out and still owe rent are listed under both views.
- **One calculation** (`js/rentals/rent-views.js`): `unitRows()` (RENT-10) and
  `summarize()` (RENT-9). Every number on the page is a `summarize()` of unit rows,
  so property cards add up to the page totals; tests (fixed cases and generated
  data) also check the totals against RENT-1 / RENT-2 / RENT-4.
- **Places read naturally:** "Flat 2B, Gupta Bhawan" / "Shop 3, Gupta Bhawan" (the
  type word is skipped when the unit name already starts with it) in lists, the
  move-in picker and the WhatsApp reminder. The tenant link stores the place without
  the type word plus `ut`, and the page adds the word in its own language.
- **Cost:** none extra — the views use the listeners Rentals already has
  (properties, units, leases, this month's and open charges). Start-up is unchanged
  (the rentals start-up guards still pass).

## 10. Add unit with its tenant; start date; electricity (owner, 2026-10-26)

Owner: *"while adding the unit, we should be adding the tenant of that unit"*, *"also
if electricity is paid separately"*.

- **Add unit** has a section "Tenant (if occupied)", shown by the toggle "Occupied —
  add tenant now" (off = a Vacant unit, as before). **Add tenant** on a vacant unit
  in the property view and **Move in** on the Tenants page open the same section.
  Fields: new or existing tenant; name; **mobile number (required, 10-digit Indian
  mobile, stored without +91; rules check it)** and an optional second number;
  monthly rent; **start date** (date picker, today); "Pro-rate first month" (off);
  due day (Rentals setting `rentDueDay`, else 10); yearly increase % (5); security
  deposit (recorded on the lease only — not cash in the Aadhat drawer);
  **Electricity**: *Included in rent* / *Meter, billed by us* / *Own meter (tenant
  pays directly)* with an optional meter/consumer number; for a new unit billed by
  meter, an opening reading and the rate (Rentals setting `rentMeterRate`).
  Default electricity: meter when a rate is known, else included.
- **One batch** (`rent-store.moveIn`): unit (new, or the vacant one), tenant (new),
  lease (`startDate`, `startMonth`, `proRate`, `firstRent`, `elecMode`, `meterNo`)
  and, when the start month has begun, the first month's charge with
  `chargedThrough` set — all or nothing. A form error saves nothing.
- **Rules:** a new unit may carry `leaseId` only for a lease created in the same
  batch (`!exists` + `getAfter`); a new lease may have `chargedThrough ==
  startMonth` only with that month's charge in the batch (`existsAfter`) and not in
  the future; the charge amount is the lease rent, or `firstRent` for the start
  month (≤ rent); `startDate` is a real date in `startMonth` and never changes;
  `elecMode` ∈ included / meter / own; meter readings only when the lease is
  `meter`; tenants need a valid mobile when created or when the number changes.
- **Shown:** "Since dd/mm/yyyy" and the electricity tag (⚡ meter / ⚡ included /
  ⚡ own meter) on tenant and unit rows; the tenant link shows "Tenant since …" and
  the electricity note; the WhatsApp reminder header has "Tenant since …".
- **Yearly increase** counts from the start date's anniversary (RENT-6). First month
  full by default, optional pro-rating (RENT-11).


## 11. Rent receipts (phase 2; owner, 2026-10-30)

Owner: plain, **non-GST** receipts (no GST fields); only the shop's people use Rentals, tenants get
WhatsApp messages and the read-only link; rent never goes into the Aadhat cash drawer.

- **When:** every payment recorded with **Record payment** (full or part) gets a receipt **in the same
  transaction** (`rent-store.js recordPayment`), and the receipt opens right after the payment with
  **WhatsApp**, **Print**, **Image** and **PDF**. **Receipts** on a tenant (Tenants page, and each occupied
  unit on the Rent page) lists that tenant's receipts, newest first, to reprint any of them.
- **Payments without a receipt:** if the receipt is refused (see below) the payment is still saved, and the
  app says so: "Payment saved, but no receipt was issued — tap Issue receipt" (a warning, not the usual
  success toast). It also reports it to Diagnostics (telemetry warning "Rent receipt not issued" with the
  error code) and opens that tenant's Receipts list. The list shows **Payments without a receipt**
  (this month, open months and the last 12 months of each current lease) with **Issue receipt**: the
  payment's writer, or an owner / Rentals manager for anyone's, issues it later
  (`rent-receipt-store.js issueReceipt`): the next number of the year, the receipt and the number on that
  payment entry in one write (`issuedBy` = who issued it; "Received by" stays the one who took the money).
  Payments recorded before receipts existed are listed the same way.
- **Number:** `R-<year>-<seq>` (`R-2026-0001`), one sequence per business per year (IST):
  `rent_counters/receipts_<year>` `{last, rid}`. The payment transaction reads the counter, writes
  `last + 1`, the receipt and the number on the payment entry (`payments[i].rno`). The rules allow the
  counter only to move by exactly one, pointing at a receipt created in the same write with that number,
  and the receipt only with that counter move, so a number can never be used twice or skipped. Two
  people paying at the same moment: the later write is refused and the app reads again (up to 3 tries).
  If the receipt is still refused (e.g. rules not yet deployed), **the payment is saved without a
  receipt** — a receipt problem never blocks a payment — and can get one later (above).
- **Year:** the rules take the year from the server's clock in IST (`request.time` + 5:30), not the
  device's. The app uses this device's clock, corrected by the server's when it knows it; when a receipt
  is refused it reads the server's clock once (the hosting response's `Date` header) and retries with that
  year.
- **Document** `rent_receipts/{chargeId}_{i}` (`dev_rent_receipts` in development; one per payment, `i` =
  the payment's index on the charge): `no, year, seq, chargeId, pi, leaseId, tenantId, unitId, propertyId,
  tenantName, place` (unit and property, without the type word) + `ut` (type id, so a reprint says
  "Flat" / "फ़्लैट" in the reader's language), `months` (`[month]`), `rent`, `elec` (the month's meter bill or
  `null`: only meter-billed leases have one), `total, paid, mode, ref, date, balance, by, byName,
  createdAt` (the server's time: the rules require `request.time`, written as `serverTimestamp()`), `void`
  (+ `issuedBy` when issued later). Field allow-list in the rules; every amount is checked
  against the charge after the write (RENT-12); `tenantName` must be the charge's and, with a payment,
  `byName` the writer's profile name (`users/{uid}.name`). The business name and address are **not
  stored**: every receipt shows the current Settings › Rentals header and address (`receiptHeader`, else
  the business name; `receiptAddress`). Checking stored copies would cost the rules one or two more
  document reads (`rent_settings/default`, and `settings/app` for the fallback name) in a write that is
  already near the rules' limits; showing them from Settings needs no check at all.
- **Never edited or deleted.** A mistake is corrected by **Cancel receipt** (owner / Rentals manager):
  `void: true` with who, when and a reason (required: the rules refuse an empty one and Save stays off
  until one is typed), in the same write as the charge's `voided` list (payment
  indexes), plus an audit entry `RENT_RECEIPT_VOID`. The payment itself does not change; a correction is a
  new payment (with its own receipt) or an owner/manager correction of the month.
- **Text:** WhatsApp text, dialog, image and PDF all come from `t()` in the app language only (keys
  `ui.rcpt.*`), with a **Ref** row when the payment has a UPI / cheque reference; stored names are cleaned of WhatsApp marks and new lines and HTML-escaped on screen. The
  tenant link is added to the WhatsApp text when the lease has one.
- **Print / image / PDF:** one 384 px canvas (58 mm printer) drawn by `drawReceipt()`; Print goes through
  `PrinterService.printCanvas()` (the existing ESC/POS raster path, else the image preview); Image shares the
  PNG; PDF is a one-page PDF wrapping the JPEG (no library).
- **Tenant link:** each paid entry on `/r/<token>` shows its date, amount and receipt number
  (`months[].py[] = {d, a, r}`), written in the same transaction as the payment (and dropped when
  cancelled), so the public page still reads exactly one document.
- **Cost and speed:** start-up unchanged (no receipt code or `rent_` name in the start-up graph).
  Recording a payment reads one more document (the counter) and writes two more (receipt, counter). The
  receipt files (`js/rentals/rent-receipt.js`, `js/rentals/rent-receipt-store.js`, `css/rent-receipt.css`)
  are not precached and load with `import()` only when a receipt is opened; the Receipts list is one
  bounded query (`tenantId ==`, `createdAt desc`, limit 60; composite index
  `rent_receipts (tenantId ASC, createdAt DESC)` + `dev_`) plus, for payments without a receipt, one query
  per current lease of the tenant (`leaseId ==`, `month desc`, limit 12; existing index).
- **Backup:** `rent_receipts` and `rent_counters` are in `BACKUP_COLLECTIONS`.
- **Tests:** rules (prod and `dev_`: number + receipt + counter in one write, no reuse or skip, a
  concurrent second claim refused, content checked against the charge (tenant name, writer's profile name,
  server's IST year and time), electricity, issued later (writer or owner/manager, once, only the `rno` added),
  a cancel reason required, void only by
  owner/manager with the charge, never edited or deleted, read by rentals roles only, a manager payment with
  the tenant link snapshot fits the rules limits); Jest (store on an optimistic in-memory Firestore: numbers
  unique under concurrent payments, fallback without a receipt and issuing it later, the server's year on a
  wrong device clock, void; the warning and Issue receipt; the Ref row; the lazy files cached on first use
  by the service worker; text for each electricity mode and a
  part payment, one language, escaping, reprint, void; the tenant page); oracle `tests/oracle/rent-receipt.test.js`.

## 12. Unit on the tenant form (owner, 2026-10-30)

Owner: *"maybe we should have unit option in tenant page"*.

- **Tenants page:** Add tenant and Edit have a **Unit** select: "No unit", then the vacant
  units grouped by property (`<optgroup>`, `rent-views.js vacantByProperty`); a tenant's
  current unit is shown selected. **Move in** and the property view's **Add tenant** use the
  same dialog (`rent-unit.js toUnit`).
- **New tenant + unit, or a tenant without a lease:** the Move in fields (start date,
  pro-rate, rent from the unit, due day from Settings › Rentals, else the 10th).
- **Change unit** (tenant with an active lease picks another unit; asks first): the old lease
  ends exactly as on move-out, pointing at the new lease (`movedTo`), and the new lease (with
  `fromLeaseId`) starts, in one transaction, keeping the old lease's due day, yearly %, deposit
  and electricity mode (the rent is the new unit's). "No unit" for a tenant with a lease opens
  Move out.
- **The move month (lead's default, 2026-10-30; RENT-13):** "Pro-rate move month" is ticked
  by default. The old unit is charged for the days up to the day before the move date, the new
  unit from the move date to the month end; both amounts are filled in (and follow the date and
  rent), the old one written to that month's charge (`rent`, `amount`) in the same write. A move
  on the 1st ends the old lease with the month before, so there is no old-unit charge that
  month (also for a member when this month was already charged: that unpaid charge is removed
  in the same write). Unticked: both units the full month. **Already paid more than the old
  share** (+ that month's electricity): the old month closes at what is paid (rent = paid −
  electricity, amount = paid, nothing more due there); fully paid, it stays as it is. The new
  unit is still pro-rated either way. The dialog says which from the loaded charge; the
  transaction applies the same rule to the charge it re-reads, so a payment made meanwhile is
  handled too, and the success message says when it happened (also for an owner/manager amount
  below what is paid).
  **Who may change the amounts:** members get the worked-out values only; the rules recompute
  the old month from the stored charge rent and the new lease's move date and accept exactly
  that (± the rounding), or, when more is paid, any rent from that share up with the amount
  equal to what is paid and the month closed, only in the write that ends the lease with
  `movedTo`. A member's pro-rated first month (move in or change) must be the RENT-11 value. Owners and
  managers may type any amount from 0 to the month's rent (rules: any lower amount, never below
  paid), as they can already correct a charge. Chosen over an owner/manager-only override
  because members do changes too, and the default must not charge them twice; and over an
  exact check for everyone because the owner wants the amounts editable.
- **Tenant link carried over:** when the old lease has a link, the new lease takes the same
  token in the same write (the old lease clears it), and the snapshot is rewritten for the new
  lease: `lid`, place, rent, due day, electricity; not Moved out; the tenant's original "since"
  kept; the old unit's months kept, tagged with that place (`pl`, `pt`), so the page shows the
  history of both units with receipt numbers. Later payments, meter readings and receipts on
  the old lease's months update that snapshot through `movedTo` (`readPublic(…, follow)`; one
  more read only for a moved lease). Rules: a new lease may start with a token only with
  `fromLeaseId`, when that lease had exactly this token before the write and has none after;
  the old lease may give it up (any rentals role) only to that new lease; the snapshot's `lid`
  may change only to a lease made from its own lease (`fromLeaseId`). A member can't take
  another lease's token or snapshot this way (tested). **New link** later makes a fresh
  snapshot of the current lease only.
- **One store function** (`rent-store.js moveIn`, with `rent-unit.js changeUnit` for a
  change): when something must be re-read (an existing unit must still have `leaseId == null`;
  an existing tenant must have no other active lease: one query `tenantId == x && status ==
  active`, limit 2, re-run on every retry; for a change, the old lease, its later months, the
  move month's charge and link snapshot) it runs as a transaction that also writes the tenant
  (move-in, also Add unit with an existing tenant) or the old lease (change), so two phones
  racing for one tenant or unit conflict and the retry is refused (Jest: transaction retries on
  the optimistic fake; offline it says a connection is needed). A new tenant (new unit, or a
  vacant one checked against the listener's copy; the rules refuse a taken unit) stays one batch
  (works offline). About 3–5
  reads per move. A change's first month is charged right after (`chargeLease`; the change write
  is at the rules' limits); if that fails, the next charge pass makes it.
- **Rules:** every new lease's property is its unit's and its tenant exists; non-owners can't
  set a start date more than 2 days back (IST; the app's default edit window, fixed because
  the Roles & access days would cost reads past the limit). With `fromLeaseId` (never
  changed): that lease was active, ends in the same write on another unit for the same
  tenant, points back with `movedTo` (set only in that write), with `endMonth` = the new start
  month, or the month before for a move on the 1st. Removing the one charged month after
  `endMonth` is allowed to members only in that write (`movedTo`, one month); otherwise it stays
  owner/manager. Unit `leaseId` rules are unchanged, so an occupied unit is never overwritten.
  To fit the change write in the rules' budget of 1,000 expressions, a lease or unit update
  that changes only its state (`status`, `endMonth`, `chargedThrough`, `movedTo`,
  `shareToken`; a unit's `leaseId`) checks only those fields, and the caller's role is read
  once per rule.
- **Size:** `rent-unit.js` (picker, move in / change dialogs, `changeUnit`; the RENT-13 amounts and checks it shows are `rent-math.moveMonthSplit` / `changeUnitPlan`) and `rent-link.js`
  (make / share / replace / turn off a tenant link; needs the network anyway) are not precached:
  `LAZY_ASSETS`, loaded with `import()` from `rentals.js` on first use and cached by the service worker's install (§4).
- **Not done:** a tenant `activeLeaseId` mirror for a rules-level "one lease per tenant"
  guarantee. It needs a migration of existing tenants, an extra checked document in move-in,
  move-out and change writes (the change is already at the limits). The transaction
  above enforces it for every app write path.

## 13. Security deposit ledger (phase 2; owner, 2026-11-01, #157)

Owner: *"record the deposit received, refunds and adjustments against dues at move-out. Show the balance."*
Rent and deposits never go into the Aadhat cash drawer.

- **One ledger per tenant**, `rent_deposits/{tenantId}` (`dev_` in development): `{tenantId, tenantName,
  held, entries[≤ 24], created*, updated*}` (a *received* entry may also come from an advance left when a
  lease ended, mode `advance`, §14). Per tenant rather than per lease because a change of unit
  keeps the deposit (§12) and ends one lease for another; every entry records the lease it was made under
  (`leaseId`). Entry: `{kind: received | adjust | refund, amount, date, mode (cash / UPI / bank / cheque;
  not for an adjustment), chargeId + month (adjustment), leaseId, note, at, by, byName}`.
- **Held (RENT-14)** = Σ received − Σ adjusted − Σ refunded, stored as `held` and checked by the rules on
  every write, never below 0. The lease's `deposit` stays the *agreed* amount (not money).
- **Adjust against dues** (at move-out, or any time): picks one open month of the tenant and pays it from
  the deposit — at most min(held, that month's due) — in **one transaction**: the ledger gains the
  `adjust` entry and the charge gains a payment entry `{mode: 'deposit'}` of the same amount (no receipt:
  no money changed hands; such payments are not listed under *Payments without a receipt*, and the
  receipt rules refuse one). So Rent,
  Total due, status and the tenant link count it like any payment. The rules check both sides: a
  `deposit` payment needs the ledger's new `adjust` entry for this charge and amount, and vice versa.
- **Who:** anyone with a rentals role adds an entry signed with their uid (create or append exactly one).
  Only the **owner** edits or removes entries (any rewrite whose `held` equals the entries' sum, ≥ 0) or
  deletes a ledger. The app lets the owner change or remove *received* / *refunded* entries, applied in a
  transaction to the entry found again in the saved ledger (so an entry another phone added meanwhile is
  kept); an adjustment paid a month and is corrected on that month instead. Audit: `RENT_DEPOSIT`, `RENT_DEPOSIT_EDIT`.
- **Screens** (`rent-deposit.js`, lazy): Tenants › **💰 Deposit** on every tenant (also one who moved out)
  opens the ledger: agreed, held, entries newest first, **Deposit received / Adjust against dues / Refund
  deposit**. After a move-out the ledger opens by itself when a deposit is held. Tenants › **Deposits
  held** lists every ledger with `held > 0` and the total (RENT-15).
- **Tenant link:** the snapshot carries `dep` (held), written in the same transaction as every entry
  (and when a link is made: one more read of the ledger); an adjustment updates its month through the
  month's own lease (after a change of unit: the tagged old-unit row on the moved link); the page shows a *Deposit held* card when it is
  above 0. Still one read per open.
- **Cost:** nothing at start-up or on entering Rentals. Opening a ledger: 1 read; an entry: a
  transaction of 1–4 reads (ledger, the month, lease + link snapshot). Deposits held: one query
  (`held > 0`, single-field index, limit 2,000).
- **Tests:** rules (prod + `dev_`: roles, signed entries, held = balance ≥ 0, append-only for non-owners,
  owner edits with the sum checked, adjustment only together with its month's `deposit` payment and never
  above held, link `dep`); Jest (math, store on the in-memory Firestore, the screens); oracle RENT-14/15 on
  generated ledgers (`tests/oracle/rent.test.js`).

## 14. Advance carried forward (phase 2; owner, 2026-11-01, #157)

Owner: *"an overpayment on a month becomes an advance applied to the next month's charge automatically."*

- **Where it lives:** on the charge of the lease's **latest charged month** (`adv`, and on the payment entry
  that made it), never on the lease. So the lease rules (at their limits for a change of unit) are not
  touched, and the monthly-charge transaction, which already moves `chargedThrough` one month at a time,
  finds it on the month before (one more read per month charged).
- **Paying more than is due (RENT-5, RENT-16; orchestrator decision 2026-11-01):** the app first pays the
  lease's unpaid months **oldest first** and shows the split to confirm (one payment and receipt per month);
  only what is left after every unpaid month is an advance, and only on the active lease's latest month (the
  rules read the lease; they are unchanged by the oldest-first split): that month is paid off (entry `amount` = the due, `paid` = its amount) and `adv` = typed − due (whole
  rupees typed); the month's `adv` grows by it. Any older month still refuses more than is due (the app
  says the advance is only for the latest month). The payment's receipt carries `adv` (rules: equal to the
  entry's) and shows "Advance for next month" and "Total received".
- **Next month (automatic):** `chargeLease` reads the month before; the new month is created paid
  min(advance, amount) by one payment `{mode: 'advance'}` (no receipt, not listed as "without a receipt"),
  the rest carried as its own `adv`, and the month before's `adv` set to 0 — in the same transaction. The
  rules require exactly that: a new month whose month before carries an advance must take it, and an
  `adv` goes to 0 only with the next month created from it (or into the deposit, below).
- **Ending before a month already paid from the advance** (a back-dated move-out, a change of unit on the
  1st): that one later month (only advance-paid, no other payment) is deleted as usual and its paid + advance
  go back to the last month's `adv` in the same write (rules check both sides; more than one such month, or
  one with a cash payment, still stops it: "a later month has a payment").
- **Change of unit with an advance:** the new lease's first month (made by `chargeLease` right after the
  change) takes the old lease's last month's advance like any next month: paid from it, the rest carried,
  the old month's `adv` set to 0 in the same transaction. The rules find that month through the new lease's
  `fromLeaseId` (the old lease's `endMonth`) and, on the old side, through the old lease's `movedTo`; such
  an advance can't go into the deposit. The change confirmation shows the amount (`rent-math.advanceLeft`).
- **Lease moved out with an advance left:** right after, the app moves it into the
  tenant's deposit ledger (§13: *received*, from advance, `chargeId`) and clears the month's `adv` in one
  transaction; rules match the two and require the lease to have ended. If that step fails (offline),
  Tenants › Deposits held lists "Advance not used (moved out)" with **Add to deposit** (one query `adv > 0`).
- **Shown:** the unit row "Advance for next month: ₹X" (this month's charge, already loaded), the toast after
  the payment, the receipt, and the tenant link (`months[].adv`; still one read).
- **Not done:** paying ahead when nothing is due (no open month to overpay), or more than the unpaid months
  when the latest month is already paid; a meter bill added after an
  advance does not take from it (the advance pays the next month).
- **Cost:** start-up unchanged. Monthly charges: +1 read per lease per month charged (the month before).
  A payment: unchanged (the lease was already read).
- **Tests:** rules (prod + `dev_`): only the latest month of an active lease, only once paid off, adv equal
  to the entry's; the next month must take the advance and clear the month before; more than a month's rent
  carries on; into the deposit only after the lease ended and only together; the receipt's `adv`; Jest (math,
  store on the optimistic fake: overpay, receipt, next months and the link, into the deposit; the dialog and
  unit row); oracle RENT-16 (one running credit, generated months and payments).
