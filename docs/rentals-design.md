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
| Deposits ledger | Received / deduction / refund entries; shown as money held, **not** Aadhat cash | 2 |
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

Phase 2 adds `rent_deposits` (`{leaseId, kind: received|deduction|refund, amount, date, note}`),
`rent_expenses` (`{propertyId, category, amount, mode, date, note}`) and agreement
fields on `rent_leases`. Rent receipts (`rent_receipts`, `rent_counters`) are built: §10.

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
up), `open = paid < amount`. Never read-modify-write outside a transaction. Overpaying is refused in phase 1 (advance carried forward is
phase 2).

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
| Precache size | Measured (phase 1 + owner answers + tenant link + unit views + Settings › Rentals + tenant with the unit + receipts): the files loaded when Rentals opens are 129.3 KB as served (LF), plus the 3.7 KB switcher that start-up loads. Receipts (§10) are split out: `rent-receipt.js` + `css/rent-receipt.css` (≈ 15 KB) load with `import()` only when a receipt or a tenant's Receipts list is opened. Downloaded once per app version in the background, never at start-up. The tenant page (≈ 15 KB) is not precached | Budget: files loaded when Rentals opens ≤ 130 KB as served (raised from 80 → 100 → 120 → 130 KB as the owner added features); the receipt module ≤ 20 KB and imported only by `rentals.js` with `import()`; `rentals-startup.test.js` fails above either |
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
- **Unit (Jest):** `rent-math` (months between, charge status due/partial/paid/late, totals, payment validation), reminder text (escaping of WhatsApp marks, one language only, months up to the last month), rent increase (RENT-6), electricity (RENT-7), switcher (shown only with access, always starts on Aadhat, Aadhat wins over a slow Rentals load).
- **Oracle:** `tests/oracle/rent.test.js` recomputes RENT-1…RENT-4 (`docs/calculations.md`) with an independent loop over a generated set of leases/payments and compares with `rent-math`.
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
  lease id, needed by the rules), `v`, display name (Settings › Rentals header, else the business name from
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
| `receiptAddress` (≤ 200) | '' | Address under the name on rent receipts (§10) |

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

## 9. Add unit with its tenant; start date; electricity (owner, 2026-10-26)

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


## 10. Rent receipts (phase 2; owner, 2026-10-30)

Owner: plain, **non-GST** receipts (no GST fields); only the shop's people use Rentals, tenants get
WhatsApp messages and the read-only link; rent never goes into the Aadhat cash drawer.

- **When:** every payment recorded with **Record payment** (full or part) gets a receipt **in the same
  transaction** (`rent-store.js recordPayment`), and the receipt opens right after the payment with
  **WhatsApp**, **Print**, **Image** and **PDF**. **Receipts** on a tenant (Tenants page, and each occupied
  unit on the Rent page) lists that tenant's receipts, newest first, to reprint any of them. Payments
  recorded before receipts existed have none.
- **Number:** `R-<year>-<seq>` (`R-2026-0001`), one sequence per business per year (IST):
  `rent_counters/receipts_<year>` `{last, rid}`. The payment transaction reads the counter, writes
  `last + 1`, the receipt and the number on the payment entry (`payments[i].rno`). The rules allow the
  counter only to move by exactly one, pointing at a receipt created in the same write with that number,
  and the receipt only with that counter move, so a number can never be used twice or skipped. Two
  people paying at the same moment: the later write is refused and the app reads again (up to 3 tries).
  If the receipt is still refused (e.g. rules not yet deployed), **the payment is saved without a
  receipt** — a receipt problem never blocks a payment.
- **Document** `rent_receipts/{chargeId}_{i}` (`dev_rent_receipts` in development; one per payment, `i` =
  the payment's index on the charge): `no, year, seq, chargeId, pi, leaseId, tenantId, unitId, propertyId,
  tenantName, place` (unit and property, without the type word) + `ut` (type id, so a reprint says
  "Flat" / "फ़्लैट" in the reader's language), `months` (`[month]`), `rent`, `elec` (the month's meter bill or
  `null`: only meter-billed leases have one), `total, paid, mode, ref, date, balance, by, byName, biz,
  bizAddr` (Settings › Rentals name and address at the time), `createdAt, void`. Field allow-list in the
  rules; every amount is checked against the charge after the payment (RENT-12).
- **Never edited or deleted.** A mistake is corrected by **Cancel receipt** (owner / Rentals manager):
  `void: true` with who, when and a reason, in the same write as the charge's `voided` list (payment
  indexes), plus an audit entry `RENT_RECEIPT_VOID`. The payment itself does not change; a correction is a
  new payment (with its own receipt) or an owner/manager correction of the month.
- **Text:** WhatsApp text, dialog, image and PDF all come from `t()` in the app language only (keys
  `ui.rcpt.*`); stored names are cleaned of WhatsApp marks and new lines and HTML-escaped on screen. The
  tenant link is added to the WhatsApp text when the lease has one.
- **Print / image / PDF:** one 384 px canvas (58 mm printer) drawn by `drawReceipt()`; Print goes through
  `PrinterService.printCanvas()` (the existing ESC/POS raster path, else the image preview); Image shares the
  PNG; PDF is a one-page PDF wrapping the JPEG (no library).
- **Tenant link:** each paid entry on `/r/<token>` shows its date, amount and receipt number
  (`months[].py[] = {d, a, r}`), written in the same transaction as the payment (and dropped when
  cancelled), so the public page still reads exactly one document.
- **Cost and speed:** start-up unchanged (no receipt code or `rent_` name in the start-up graph).
  Recording a payment reads one more document (the counter) and writes two more (receipt, counter). The
  receipt code (`js/rentals/rent-receipt.js`, `css/rent-receipt.css`) loads with `import()` only when a
  receipt is opened; the Receipts list is one bounded query (`tenantId ==`, `createdAt desc`, limit 60;
  composite index `rent_receipts (tenantId ASC, createdAt DESC)` + `dev_`).
- **Backup:** `rent_receipts` and `rent_counters` are in `BACKUP_COLLECTIONS`.
- **Tests:** rules (prod and `dev_`: number + receipt + counter in one write, no reuse or skip, a
  concurrent second claim refused, content checked against the charge, electricity, void only by
  owner/manager with the charge, never edited or deleted, read by rentals roles only, a manager payment with
  the tenant link snapshot fits the rules limits); Jest (store on an optimistic in-memory Firestore: numbers
  unique under concurrent payments, fallback without a receipt, void; text for each electricity mode and a
  part payment, one language, escaping, reprint, void; the tenant page); oracle `tests/oracle/rent-receipt.test.js`.