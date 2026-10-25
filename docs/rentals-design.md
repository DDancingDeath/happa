# Rentals module: design (#170, decision #149)

Status: design, phase 1 in progress (`feat/rentals-phase1-170`). Owner answers recorded (§6).
Merges after the happa go-live PRs (#231 → #226 → #228 → #229 → #230 → #227 → #232).

## 0. Decision (owner, 2026-10-25, #149)

- **One app, happa, with a separate section per business.** The grain shop is
  business #1, rentals is next, more may come later. No separate apps.
- **Hard requirement: "make sure it doesn't make the whole app slow."** Section 4
  turns this into rules that CI checks.
- The app moves to Firebase project `happa-bfc07` as is (#231). The shop keeps its
  current top-level collections (`purchases`, `items`, …). **Shop data is not
  restructured.** Rentals gets its own `rent_*` collections next to them.

This is the #149 option C ("businesses with modules"), started in the cheapest
way that keeps the shop untouched: the shop is the implicit business #1 on the
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
| Deposits ledger | Received / deduction / refund entries; shown as money held, **not** shop cash | 2 |
| Receipts | Plain, **non-GST** rent receipt (tenant, unit, month, amount, mode, balance): WhatsApp text and printable/thermal. No GST fields | 2 |
| Maintenance expenses | Per property: repairs, property tax, society, insurance, broker; cash/bank mode | 2 |
| Electricity | **Sub-meter** per unit: previous and current reading, rate per unit; (current − previous) × rate added to that month's charge | **1** (small: one dialog, one transaction, rules check the arithmetic) |
| Rent increase reminder | Yearly, on the lease anniversary: "Rent increase due: 5% → ₹X" on the Rent page. **Never applied automatically**; the new rent is saved by hand after agreeing with the tenant. % editable per lease (default 5) | 1 |
| Water / other utilities | Fixed or metered, like electricity | 3 |
| Reminders | Rent due / late, lease ending in 30/60 days, escalation month: rentals cards on Today and in the notifications bell (in-app, no push: Spark has no Cloud Functions) | 3 |
| Reports | Monthly expected vs collected, outstanding per tenant (aging), yearly income per property (ITR "house property"), occupancy, deposits held, CSV/Excel | 3 |
| Audit | Every create/edit/delete of lease, payment, deposit | 1 (payments), 2 (rest) |

Out of scope: online rent collection, e-stamp/agreement generation, GST invoices,
tenant self-service login, photo upload (Storage needs Blaze on new projects).

### Reuse without coupling to the shop's money math

| Building block | Reused how | Not reused |
|---|---|---|
| `utils/due-reminder.js` | `normalizePhone`, `whatsAppReminderUrl`, `cleanText`, `formatINR`, `formatDMY` (pure) | `buildReminderText` (bill wording); rentals has its own text builder |
| `utils/open-external.js` | Opens `wa.me` in Android/web | – |
| `utils/money.js` | `round2` only | `readPayment()` / bill `payment.due` shapes: rent charges have one simple shape (`amount`, `paid`) |
| `utils/aging.js` | Phase 3: the same day buckets (0–30, 31–60, …) for "outstanding per tenant" via a small adapter | Party/bill model |
| `services/printer.js` | Phase 2: a rent-receipt layout through the existing raster/image path | Bill layouts |
| `services/audit.js` | `AuditService.log('RENT_PAYMENT', …)` | – |
| Expenses (`miscellaneous.js`) | Pattern only (form + list); rentals expenses live in `rent_expenses` | The shop `expenses` collection, so shop Finance/Reports and cash drawer numbers don't move |
| Cash (`cash-management.js`) | **Not reused.** Owner confirmed (2026-10-25): rent and deposits never go into the shop's cash drawer; rentals money is kept separate | – |
| Notifications (#12) | Phase 3: rentals reminders as notification items, created only on a device that opened Rentals | – |
| i18n (`t()`), `Helpers.escapeHtml` / `escapeJsAttr`, `UIManager.showToast/showModal` | As everywhere | – |

## 2. Business switcher UX

- **Where:** a two-button switch at the top of the side menu, under the user name:
  `🌾 Shop | 🏠 Rentals`. It is shown only to people who may open more than one
  business (owner, or anyone with a rentals role). Everyone else sees exactly
  today's menu.
- **What it does:** the menu shows only the current business's pages.
  - Shop: today's links (Today, Billing, Sales, …).
  - Rentals: **Rent**, **Tenants**, **Properties** (phase 1), later Expenses,
    Deposits, Reports.
  - Shared in both: Settings (and the language toggle / notifications bell).
  Done with one body class (`biz-rentals`) and `data-biz` on menu links, so no
  shop link markup or the role code in `authentication.js` changes.
- **Always starts on Shop** (owner rule "don't make the app slow", review of #10):
  the app never opens Rentals by itself on a cold start, so start-up reads no rentals
  data for anyone. Rentals loads only when someone taps it.
- **Roles per business** (extends #228):
  - `users/{uid}.role` stays the **shop** role (owner / manager / member — `staff`
    internally). The shop **owner is the owner of every business**.
  - New `users/{uid}.rentRole`: absent = no rentals access; `manager` or `member`.
    Owner decision (2026-10-25): **anyone with a rentals role** adds properties,
    tenants and leases, records payments and meter readings and updates records.
    A manager can also correct a month's amount. Only the owner removes records
    and changes access. Only an owner can set `rentRole` (rules), from
    **Rentals → Access** (owner only), so `users.js` is not changed. Every write
    carries `updatedBy` (= the writer, checked by the rules) and payments carry
    `by`/`byName`; payments, meter readings, rent changes, move-in/out also go to
    the audit log.
  - A **rentals-only helper** = `role: 'none'`, `rentRole: 'member'`. The shop rules
    already deny any role outside owner/manager/staff, so they can read no shop data.
    Phase 1 rules support this; the client start-up path for such a user (skip the
    shop listeners, open Rentals) is phase 2.
  - #228's `settings/app.roleAccess` stays the per-page switch board for the shop.
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
fields on `rent_leases`.

**Limits (owner: up to 100 properties, 3 today).** At most 100 properties and 20
units per property (enforced when adding). Every listener has a limit sized for
that (properties 100, units/tenants/leases/this month's charges 2,000, open
charges 4,000); a listener that comes back full shows a notice instead of
silently hiding data.

**Monthly charges, multi-device safe (AGENTS.md rule 6).** On entering Rentals, for
each active lease whose `chargedThrough` is before the current month, one
transaction reads the lease, and if `chargedThrough` is still behind, creates the
missing `rent_charges/{leaseId}_{month}` docs (start month → current month) and
moves `chargedThrough` forward. Two phones racing → one transaction retries, sees
the new `chargedThrough`, and writes nothing. Deterministic ids make a duplicate
impossible even if it didn't. Cost: 1 read + (months) writes per lease **once a month**.

**Payments** run in a transaction on the charge: `paid = round2(paid + x)`,
`payments` grows by one entry, `open = paid < amount`. Never read-modify-write
outside a transaction. Overpaying is refused in phase 1 (advance carried forward is
phase 2).

**Move-out** (one transaction, review of #10): the last month can't be in the
future. Missing charges up to it are created, unpaid charges after it are deleted
(refused if any later month has a payment), and the lease ends with
`chargedThrough` = last month. So the WhatsApp reminder can never list a month
after the tenant left (it also filters by the last month).

**Rent increase** (RENT-6): 12 months after `rentSince` (else `startMonth`) the Rent
page shows "Rent increase due: p% → ₹X" with **Change rent**. Nothing changes until
someone saves; saving sets `rentSince` to this month and the new rent applies from
the next month's charge.

**Electricity** (RENT-7): **Meter reading** on this month's charge: previous
(prefilled from the unit), current, rate; a transaction sets `electricity`, makes
`amount` = rent + electricity (never below what is already paid) and stores the
reading and rate on the unit for next month.

### 3.2 Indexes

Phase 1 queries are single-field equality (`status == 'active'`, `open == true`,
`month == 'YYYY-MM'`, `archived == false`), which Firestore indexes automatically:
**no composite index**. Phase 3 reports (`propertyId == x` + `month` range) add
`rent_charges (propertyId ASC, month ASC)` to `firestore.indexes.json`.

### 3.3 Rules

A separate `match /rent_…/{id}` block per collection (+ `dev_` mirror via a
`rentCollections()` list like `businessCollections()`); `rent_*` is **not** in
`businessCollections()`, so the shop wildcard never grants it.

- `rentRoleIn(usersCol)`: profile exists, status not pending/rejected, and
  `role == 'owner'` → `owner`, else `rentRole` ∈ manager/member.
- **Read** any `rent_*`: rentals owner/manager/member. A shop member or manager
  without `rentRole` is denied (tested).
- **Properties, units, tenants, leases** create/update: any rentals role, with type
  checks (strings sized, numbers ≥ 0, `dueDay` 1–28, `increasePct` 0–100, months
  `YYYY-MM`) and `updatedBy == auth.uid`. A new lease has no charges
  (`chargedThrough == null`); `startMonth`, `unitId`, `tenantId` never change.
  **Delete:** owner only (the app archives instead).
- **`chargedThrough`** may only move to a month whose charge exists after the write
  (`existsAfter`) and that is not after this month (IST, from `request.time`); it
  moves back only when the lease ends in the same write and the old last month's
  charge is deleted.
- **Charges** create: any rentals role, id = `leaseId_month`, written in the same
  batch/transaction as the lease's `chargedThrough` (`getAfter(lease).chargedThrough
  >= month`), `amount == rent == lease.rent`, unit/tenant/property/due day = the
  lease's, `paid == 0`, `payments == []`, no electricity. Update: a payment (append
  one entry with `amount > 0` and `by == auth.uid`; `paid` = old + entry ± 0.01,
  never above `amount`), or a meter reading (units = current − previous, amount =
  units × rate, charge = rent + electricity ± 0.01, rent unchanged, not below
  `paid`). Owner/manager may also correct `amount`. Delete: owner, or move-out
  removing an unpaid month after the lease's `endMonth` in the same write.
- **Profiles:** a user can't set their own `rentRole` (added to the self-update
  deny list) and can't register with one.
- Rules tests run for prod and `dev_` (`defineSuite(prefix)`).

### 3.4 Read/write cost (who pays)

Only people who open Rentals pay anything, and nobody pays at start-up (the app
always starts on Shop). Today (3 properties) entering Rentals costs a few dozen
reads. At the limit the owner gave (100 properties, say 300 units/tenants/leases,
~400 open charges):

| Screen / action | Reads (first open of the day) | Re-open within 30 min | Writes |
|---|---|---|---|
| Enter Rentals (5 listeners: properties, units, tenants, active leases, open + this month's charges) | ≈ 100 + 300 + 300 + 300 + 400 + 300 ≈ **1,700** | only changed docs (offline persistence resumes the listen) | 0 |
| Monthly charge generation | 1 per lease once a month (≈ 300) | 0 | 1–2 per lease per month |
| Rent / Tenants / Properties pages | 0 (same listeners, switching pages re-renders from memory) | 0 | 0 |
| Record a payment | 1 (transaction) | – | 1 + 1 audit |
| WhatsApp reminder | 0 | 0 | 0 |
| Rentals → Access (owner) | users list (already cached by `FirebaseService.loadUsers`) | 0 | 1 per change |

All queries are bounded (limits above) and paid charges drop out of the
`open == true` listener. Re-entering within 30 minutes costs only changed docs, so
even at 100 properties a normal day (a few visits) stays around 2–5k of the 50k/day
Spark reads.

### 3.5 Later: a second business of the same type

When a second rentals business (or a second shop) appears, move to #149's nested
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
| Zero extra Firestore reads and zero listeners at start, **for everyone** (the app always starts on Shop) | All `rent_*` access is in `js/rentals/rent-store.js`; listeners attach in `enter()` and detach in `leave()` (switching to Shop, opening a shop page, sign-out) | Same Jest test (no `rent_` in the start-up graph) + **Jest `rentals-cold-start.test.js`**: `BusinessSwitcher.init()` for shop-only, rentals and owner users (with an old saved choice) imports nothing from `js/rentals` (the mocked module records any load) + **Playwright `rentals-startup.spec.js`** (nightly / `e2e` label): logs in as owner against the emulators, waits for the app, and asserts no `js/rentals/` request and no Firestore request whose body mentions `rent_`; then opens Rentals and asserts both appear (the probe works) and that leaving detaches |
| Shop read counts and start-up timings unchanged | The shop start-up code isn't changed apart from reading one more field from the already-loaded profile (`rentRole`) and drawing the switch after `app-shown` | Existing `realtime-listeners.test.js` / `quota-guards.test.js` stay green; the Playwright spec also compares `markStartup` timings (#183/#211): `app-shown` must exist and the rentals module must load **after** it |
| Service worker | The rentals files are in `STATIC_ASSETS` (`check:sw` requires every app file). Precache runs in the SW `install` event in the background after the page has loaded, one `cache.add` per file, so it never blocks start-up or a page | `check:sw` + `load-perf.test.js` (existing) |
| Precache size | Measured (phase 1): rentals files 51.7 KB uncompressed (14.8 KB gzip) on a 2.42 MB precache (+2.1 %), plus the 3.7 KB switcher that start-up loads. Downloaded once per app version in the background | Budget: rentals files ≤ 80 KB uncompressed; `rentals-startup.test.js` fails above it |
| i18n | Rentals strings live in `i18n/en.js` / `hi.js` (≈ 8 KB each, parsed with the rest) because the catalogue test requires every key in both files | Accepted cost: no reads, < 1 ms parse |

**Start-up time budget in CI.** The Playwright spec records the existing
`aadhat:app-shown` mark and fails if the Rentals module was imported before it.
An absolute ms budget is not enforced in CI (shared runners vary by 2–3×); the
recorded numbers are printed so a regression shows in the job log, and the
on-device numbers stay visible in Diagnostics (#183).

## 5. Phased plan

### Phase 1 — smallest useful thing (effort **M**, ≈ 1 week)

Business switcher (always starts on Shop); Rentals → **Properties** (add/edit/archive property and its
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
- **Unit (Jest):** `rent-math` (months between, charge status due/partial/paid/late, totals, payment validation), reminder text (escaping of WhatsApp marks, one language only, months up to the last month), rent increase (RENT-6), electricity (RENT-7), switcher (shown only with access, always starts on Shop, Shop wins over a slow Rentals load).
- **Oracle:** `tests/oracle/rent.test.js` recomputes RENT-1…RENT-4 (`docs/calculations.md`) with an independent loop over a generated set of leases/payments and compares with `rent-math`.
- **Rules (prod + dev_):** shop member/manager without `rentRole` can't read any `rent_*`; rentals-only helper reads rentals but no shop data; any rentals role writes records signed with its own uid; a charge is created only with its lease's `chargedThrough` and at the lease rent; `chargedThrough` can't pass this month or point to a missing charge; a 24-month backfill batch stays within the rules limits; payments can't overpay or forge `by`; meter arithmetic is checked; only owner/manager correct an amount; move-out deletes unpaid later months only when the lease ends (a paid later month blocks it); only owner deletes otherwise; nobody sets their own `rentRole`.
- **E2E:** start-up loads no rentals code or data; property → unit → tenant → move-in → part payment → meter reading → move-out.
- **Start-up guard:** `rentals-startup.test.js` and `rentals-cold-start.test.js` (Jest) + `rentals-startup.spec.js` (Playwright).

### Phase 2 — money completeness (effort **M**)

Agreements (end month, notice period, lock-in, agreement type; the yearly increase
stays a reminder, never automatic), deposits ledger (held / deductions / refund; separate from shop cash),
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
rules for each new collection, Playwright: rentals-only helper sees no shop request.

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
4. **Cash:** rent and deposits **never** go into the shop's cash drawer — confirmed;
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
