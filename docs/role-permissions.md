# Roles & access: what each role may see and do (#84)

Owner decision on #84: *"Give owners access to control this from the app itself. Role wise."*
Owner decision on #87: *non-owner users may edit or delete a bill for 2 days.*

The owner sets, per role, which pages and numbers managers and members see, how far back
History goes and for how many days bills can be changed. Screen: **Settings › Common › Roles & access**
(owner only, English and Hindi; route `settings-roles`). The same card lists **People**: each
approved user's Aadhat role (approved and changed in Admin › Users) and Rentals role (`users/{uid}.rentRole`,
changed right there; this replaced the old Rentals › Access page, whose route now opens this card).

The app has two businesses: **Aadhat** (आढ़त; stored and coded as `shop`, e.g. the switcher key, the
`role` field and `settings/app`) and **Rentals**. Only the name on screen is Aadhat; ids, collections and
permission ids keep `shop`.

## Roles

| Stored value | Shown as | Configurable | Notes |
|---|---|---|---|
| `owner` | Owner / मालिक | no | Always sees and does everything; no edit window. |
| `manager` | Manager / मैनेजर | yes | The spec's "admin". The name stays `manager`. |
| `staff` | Member / सदस्य | yes | The stored value stays `staff` (rules, profiles); the UI never says "staff". |

No new roles, no custom role names and no custom claims (custom claims need Cloud Functions,
which the Spark plan does not have). Role templates and time-limited roles stay in #167.

## Permission list

"Client" = the app hides it (nav, page, section, action). "Rules" = `firestore.rules` also
refuses it. Defaults are today's behaviour plus the #87 edit window; they apply whenever the
setting is missing or invalid.

| id | English | हिंदी | Manager default | Member default | Enforced |
|---|---|---|---|---|---|
| `finance` | Money page (the stored id kept the old Finance page's name) | हिसाब पेज | on | off | client; **rules** for withdrawals |
| `reports` | Statements page (stored id of the old Reports page) | बही-खाता पेज | on | off | client; **rules** for withdrawals |
| `analytics` | Insights page (stored id of the old Analytics page; its Seasons section hosts Rate trends and Product traffic, so it also keeps their owner/manager rule, and `reports` opens Seasons too; to-do cards with ₹ lost or ₹ per ₹100 need `profit`) | कारोबार पेज | on | off | client; **rules** for withdrawals |
| `wholesale` | Wholesale page | थोक पेज | on | off | client |
| `personalExpenses` | Personal expenses | निजी खर्च | on | on | client + **rules** (#98, see "Personal expenses") |
| `profit` | Profit and average cost | मुनाफा और औसत लागत | on | on | client |
| `stockValue` | Stock ₹ value | स्टॉक की ₹ कीमत | on | on | client |
| `oldCashSessions` | Past cash days | पिछले दिनों का कैश | on | on | client (rules: phase 2) |
| `purchaseRates` | See purchase rates | खरीद रेट देखें | on | on | client (Rates page only) |
| `shopSettings` | Change Aadhat settings (labour, bill checks, business name) | आढ़त की सेटिंग बदलें | off | – (managers only) | **client + rules** |
| `historyDays` | History: days back (0 = all) | इतिहास: कितने दिन पीछे तक (0 = सभी) | 0 | 0 | client only (see "Server-side read rules") |
| `editDays` | Edit/delete bills for (days) | बिल बदलने/हटाने के दिन | 2 | 2 | **client + rules** |

- `editDays`: whole days, 0–30; 0 = never. Managers may edit any bill and delete their own;
  members edit and delete only their own bills. Recording a payment, clearing or writing off
  a due is **not** limited (it is bookkeeping, not an edit). The owner has no limit.
  The same days limit how far back a new expense may be dated (#118): 2 = today, yesterday
  and the day before; 0 = today only (`utils/expense-entry.js`; the rules check it with 3
  more days for a phone that saved offline, `expenseDayInWindow`, on every non-owner expense
  that names its `day`, and require its `date` to be on that day).
- `historyDays`: whole days, 0–3650; 0 = all bills.
- `shopSettings`: managers only (members never see Settings › Aadhat; the client forces it off for
  them). When on, a manager may update only the Aadhat fields of `settings/app`: `laborRate`,
  `heavyWeightThreshold`, `labourPackageKg`, `checkThresholds`, `businessName`, `businessDetails` and their
  `…UpdatedAt` / `…UpdatedBy` stamps (`managerShopSettingsOk`). Never `roleAccess`,
  `minClientVersion`, `enforceClientVersion` or TIP settings, and never create or delete the doc.
- Pages that read owner/manager-only collections (Admin, Diagnostics, Anomalies, Insights › Seasons (Trends and Product traffic),
  App health) and the stock adjustment / item edit actions are not in the list: their rules are
  fixed and the setting could not open them. `TAB_ROLES` in `role-access.js` lists them (Admin:
  owner; the others: owner and manager); `canOpenTab()` refuses them for other roles, and
  `NavigationManager` shows Today with a message instead. Trends and Product traffic are views of
  Insights › Seasons with the extra permission id `rate-trends` (routes `insights-seasons`,
  `insights-trends`, `insights-traffic`; old `reports-trends`, `reports-traffic`, `rate-trends`,
  `rates-trends`, `rates-traffic` redirect there). They need the Insights switch (`analytics`) OR, for back-compat, the
  Reports switch (`reports`; they were Reports tabs before phase 5): a manager with only Reports
  on still sees Insights in the menu, with Seasons as its only section (`SECTION_ALSO_ALLOWED`,
  `canOpenPage()` / `canOpenSection()` in `role-access.js`). Members do not see them, and opening one shows Insights (or Today, if Insights is off for that
  role) instead.
- Old page ids redirect (redesign phase 5): `finance*` → Money, `reports*` → Statements,
  `analytics*` → Insights, with the same switches (`finance`, `reports`, `analytics`), so every
  role keeps what it had.
- `purchaseRates`: hides the Purchase rates column on the Rates page and the purchase-rate
  fields of the item form. Billing keeps showing purchase rates because members need them to
  make purchase bills; they also stay readable in the data.
- #154 asked for "narrow only". The owner's later decision is per-role control, so the owner can
  also turn a page *on* for members. Almost everything in the list is data members can already
  read (client-only gating). The exception is withdrawals: the rules let a role read them only
  while Money, Statements or Insights is on for it, so turning one of those on also opens
  withdrawals in the rules (see "Server-side read rules").

## Where it is stored

`settings/app.roleAccess` (and `dev_settings/app.roleAccess` for `dev_` previews):

```js
roleAccess: {
  manager: { finance: true, reports: true, analytics: true, wholesale: true,
             personalExpenses: true, profit: true, stockValue: true, oldCashSessions: true,
             purchaseRates: true, shopSettings: false, historyDays: 0, editDays: 2 },
  staff:   { finance: false, reports: false, analytics: false, wholesale: false,
             personalExpenses: true, profit: true, stockValue: true, oldCashSessions: true,
             purchaseRates: true, shopSettings: false, historyDays: 0, editDays: 2 }
},
roleAccessUpdatedAt: <ms>, roleAccessUpdatedBy: <uid>
```

Why `settings/app` and not a separate `settings/permissions` doc:

- **Owner-write only already**: `appSettingsGuard` lets only the owner write `settings/app`
  (it also holds `minClientVersion`), except the Aadhat fields a manager may update when
  `shopSettings` is on. Every approved user can read it.
- **No extra client read**: every app start already reads `settings/app` once
  (`FirebaseService.loadAppSettings`, shared with the version check, labour rate and bill-check
  limits). A separate doc would cost one more read per app start on every phone.
- **No extra rules read on bill updates**: bill writes already `get()` `settings/app` for the
  clientVersion gate (`clientGateOn`). Rules bill a document once per request however often it is
  read, so the edit window adds nothing there.

The owner's save writes the whole normalized map (`set(..., { merge: true })`) and adds a
`CHANGE_ROLE_ACCESS` audit row listing the changed values.

## How the client applies it

Code: `www/js/utils/role-access.js` (pure: defaults, `normalizeRoleAccess`, `accessFor`,
`canOpenTab`, `canEditBillWith`, `canDeleteBillWith`, `historyCutoff`,
`hiddenPermissionClasses`) and `www/js/modules/roles-access.js` (the Settings screen).

- **Nav and pages**: `AuthManager.applyRoleBasedRestrictions()` (the existing role gating,
  tested in `auth-gate.test.js`) now asks `canOpenTab()` for Money, Insights, Statements and
  Sales (wholesale). `NavigationManager.showTab()` refuses a page that is off for the role
  (direct navigation, keyboard shortcuts, links from other pages) and shows Billing with a
  message.
- **Sections and numbers**: elements carry `data-perm="profit"` (or `stockValue`,
  `personalExpenses`, …; several = space-separated). `applyRoleBasedRestrictions()` puts
  `no-perm-<id>` classes on `<body>` and `css/settings.css` hides the matching elements, which
  also covers templates and rows rendered later. Marked: Money profit / cost of goods sold /
  personal expenses, net worth terms; Insights profit cards and to-do ₹ lost; Statements profit,
  personal expenses, stock value and purchase rate lines (also left out of WhatsApp, CSV and PDF); wholesale
  profit rows; Stock page rate (average cost) and ₹ value; the Personal expenses tab.
- **Actions and lists**: Expenses refuses the Personal tab and draws no personal rows; Stock
  "Not selling" also needs `profit` and `stockValue`; Cash history without `oldCashSessions`
  lists only today and days still waiting for a count (so a late count is still possible);
  History drops bills older than `historyDays`.
- **Edit window**: `canEditBill()` (billing) and History's Edit/Delete buttons and delete
  check use `canEditBillWith` / `canDeleteBillWith`, the same conditions as the rules. A refused
  edit says the window has closed (with the number of days).

## How the rules enforce it

`firestore.rules`:

```
function billEditDays(usersCol) {   // roleAccess.<role>.editDays, int 0–30, else 2
  ...get(profilePath(usersCol))...get(settingsAppPath(usersCol))...
}
function withinBillWindow(usersCol) {
  let c = resource.data.get('createdAt', null);
  c is timestamp && request.time < c + duration.value(billEditDays(usersCol), 'd')
}
canFullyEditBill = (manager || creator) && withinBillWindow && createdAt unchanged
canDeleteBill    = owner || (creator && withinBillWindow)
```

- The clock is the bill's **server** `createdAt` (from #226 / #87): `saveBill()` writes
  `FieldValue.serverTimestamp()` on the first save, `validBillCreate` requires it to equal
  `request.time`, and nobody but the owner can change or add it later (full edits must keep it;
  payment bookkeeping may not touch it). Only the number of days comes from `roleAccess`.
- The client-written `timestamp` is never used for the window, so a future timestamp, a wrong
  phone clock or a late offline sync can neither open nor stretch it. (A bill queued offline gets
  its `createdAt` when it reaches the server.)
- Bills without a server `createdAt` (saved before #87 or by old apps) can be fully edited or
  deleted only by the owner. Backfilling a legacy `timestamp` (still allowed for ordering) does not
  unlock them, and nobody but the owner can add a `createdAt`.
- Payment bookkeeping (`bookkeepingOnly` + `paymentEditOk`) is not time-limited.
- Money on bills (#65), for everyone but the owner:
  - **Creates and full edits** (`changedMoneyOk`): payment amounts (`payment.cash|online|due|writtenOff|total`,
    `cashPayment`, `onlinePayment`, `dueAmount`) are numbers ≥ 0 in whole paise (no NaN or Infinity),
    totals are finite numbers, and cash + online + written off + due is at most the bill total + ₹1
    (the bill screen's own split check, `SPLIT_TOLERANCE`; "Cash"/"Due" fill in the total rounded to
    the rupee). The total is read as `billTotal()` reads it (`grandTotal`, `amountPayable`, `total`,
    `billTotal`, `saleTotal`). Only `tools/migrate` writes opening records (`openingBalance`); the
    legacy `amountPaid` / top-level `due` are refused.
  - **Payments and write-offs** (`paymentMoneyOk`): the write sets `payment.cash`, `online` and `due`
    (as `applyPaymentTransaction` / `applyWriteOffTransaction` do); cash, online and written off never
    go down, each goes up by what the new `payments[]` entry (amount > 0) says (`entryParts`), and the
    due goes down by the same, within 1 paisa (`PAYMENT_TOLERANCE`). No entry, no money: the due then
    drops only when a due under 1 paisa is written off to 0. So nobody pays
    more than the due, and with the split check above, never more than the bill total (+ ₹1 rounding).
    Opening records are capped by their carried amount the same way. The new entry's time (`at`, which
    puts the money on a day in the drawer and Today) must be within 10 minutes of the server's: payments
    and write-offs are transactions, so they never wait offline, and a back-dated entry would hide
    drawer cash on another day. (A phone whose clock is more than 10 minutes off can't record payments;
    the app then says the phone's time is wrong, measured from a freshly issued sign-in token,
    `utils/clock-skew.js`.)
  - **New bills** never carry `payments`, `paidAt` or `cleared` (the app doesn't send them; they come only
    with payments).
  - **Clearing** (`clearOk`): `cleared` only becomes true with the due settled (≤ 1 paisa) in the
    same write, `clearedBy` is the caller, and `openDue` goes false only when cleared or settled.
  - Limits: bills with no due field at all (very old shapes) take no member payments; the owner
    corrects them. The checks follow the app's write shape because a bill write already uses most
    of the 1,000 expressions rules may evaluate per request (the bill update reads the caller's role
    once, `billUpdateAs`); no extra document reads.
- `settings/app` writes stay owner-only (`appSettingsGuard`), apart from the Aadhat fields a
  manager with `shopSettings` may update (`managerShopSettingsOk`; reads `roleAccess` from the
  current doc, so it costs no extra read).

**Per-request limits and read cost** (Spark: rules `get()`/`exists()` are billed as reads; a
document is billed once per request; limit 10 docs per single write, 20 per batch/transaction):

| Request | Docs the rules read | Change |
|---|---|---|
| Bill create / payment / clear | profile, `settings/app` (clientVersion gate) | none |
| Non-owner full bill edit | profile, `settings/app` | none (same docs) |
| Non-owner bill delete | profile, `settings/app` | **+1 read** (delete did not read `settings/app` before) |
| Owner writes | profile | none (owner short-circuits) |
| Reads | profile (+ `settings/app` for withdrawals) | see "Server-side read rules" |

The edit-window branch is only evaluated after `isOwnerIn` fails, so the owner never pays for it.

## Server-side read rules (#57, #18)

Until this change the rules limited only writes: every approved user could read every business
collection and every user profile. Now each role reads what its screens need. Code:
`canReadRecord` / `roleSeesMoneyPages` / `canReadProfile` in `firestore.rules`; tests: the
"read matrix" in `rules-tests/test.js` (every role × collection, `get` and `list`, prod and `dev_`).

Roles below: **Owner**; **Manager**; **Member** (stored `staff`, also legacy profiles without
`status`); **Rentals-only** (`role` not owner/manager/staff, with a `rentRole`); **Pending** /
rejected / no profile / unknown role.

### What the app reads (inventory of `www/js`)

`dev_` collections are read the same way with `dev_users` / `dev_settings/app`.

| Collection | Reads in the app | Member needs it |
|---|---|---|
| `purchases`, `retailSales`, `wholesaleSales` | window listeners (`timestamp >= liveFrom`), due listeners (`openDue == true`, `timestamp < liveFrom`; pinned ids), one-shot older history, oldest-timestamp probe, re-read after a due is paid, bill-number seed (`helpers.js`), Rates trends paging (owner/manager) | **yes, all ages**: stock = checkpoint + bills since its `asOf` (up to ~3 months back for members), Outstanding needs old bills with a due, History within `historyDays`, billing checks |
| `items`, `itemFrequency/global`, `counters`, `stockCheckpoints` (`current`, `legacyScan`) | listeners / gets at start-up, billing transaction | yes |
| `expenses` | window/older-history queries (business rows; personal rows saved before #98) | yes (Expenses, Today, cash count) |
| `personalExpenses` (#98) | window/older-history queries, only when `canReadPersonalExpenses(role, roleAccess)` | only with `personalExpenses` (default on) |
| `personalExpenseDays/{YYYY-MM-DD}` (#98) | one get of a day (Today, the cash count, auto-closing a past day), only on phones that can't read `personalExpenses`; reused for a minute | yes, the day's total and count only |
| `stockAdjustments` | history queries (stock) | yes |
| `cashManagement` | Cash page (latest page, last counted day, open past days, uncounted days, by date, between dates), Today, Outstanding (cash leg), Money, Anomalies | today, the last counted day (carry-forward, any age) and uncounted days; other past days only with `oldCashSessions` |
| `withdrawals` | history queries; shown only on Money, Statements, Insights | only with `finance`, `reports` or `analytics` (default off) |
| `cashSessions` (legacy) | none (backup only) | no |
| `settings/app` | one get per app start (version gate, Roles & access, labour, bill checks, business name, TIP policy) | yes; no other `settings` doc is read |
| `notifications` | own only (`where('userId', '==', uid)`) | own |
| `drafts` | own only (`where('userId', '==', uid)`, get by id) | own |
| `autoSaves/{uid}` | own doc | own |
| `users` | own profile at start-up / login / registration; full list: Admin and Roles & access › People (owner), App health device names (owner/manager), notification fan-out on item and rate edits (owner/manager) | **own only**. Names shown on bills, payments and audit rows are stored on those records, so no name mirror is needed |
| `users/{uid}/preferences` | own | own |
| `auditLogs`, `telemetry` | append by everyone; read in Settings/Diagnostics and the anomaly scan by the owner only | no |
| `tipHealth`, `tipFailures`, `anomalies`, `rateStats`, `rateHistory`, `monthStats` | App health, Anomalies, Rates history, Insights › Seasons, Money snapshots (the app loads them for owner/manager only) | no |
| `rent_*` | Rentals (`js/rentals/rent-store.js`), loaded only when Rentals opens | rentals roles only |
| `rent_public/{token}` | tenant page, get by token | anyone with the link |

### Read matrix: before → after

G = get one document, L = list/query. ✓ allowed, ✗ refused. Pending covers rejected users,
signed-in users without a profile and unknown roles; signed-out users are refused everywhere
except `rent_public` get.

| Collection | Owner | Manager | Member | Rentals-only | Pending |
|---|---|---|---|---|---|
| bills, `items`, `expenses`, `stockAdjustments`, `cashManagement`, `itemFrequency`, `counters`, `stockCheckpoints` | ✓ → ✓ | ✓ → ✓ | ✓ → ✓ | ✗ → ✗ | ✗ → ✗ |
| `withdrawals` | ✓ → ✓ | ✓ → ✓ while Money, Statements or Insights is on for managers (default) | ✓ → ✗; ✓ while one of them is on for members | ✗ → ✗ | ✗ → ✗ |
| `personalExpenses` (#98; were in `expenses`) | ✓ | ✓ while Personal expenses is on for managers (default) | ✓ while it is on for members (default) | ✗ | ✗ |
| `personalExpenseDays` (#98) | ✓ | ✓ | ✓ | ✗ | ✗ |
| `cashSessions` (legacy) | ✓ → ✓ | ✓ → ✓ | ✓ → ✗ | ✗ → ✗ | ✗ → ✗ |
| `settings/app` (G) | ✓ → ✓ | ✓ → ✓ | ✓ → ✓ | ✗ → ✗ | ✗ → ✗ |
| other `settings` docs, `settings` (L) | ✓ → ✓ | ✓ → ✗ | ✓ → ✗ | ✗ → ✗ | ✗ → ✗ |
| `notifications`, `drafts`: own | ✓ → ✓ | ✓ → ✓ | ✓ → ✓ | ✗ → ✗ | ✗ → ✗ |
| `notifications`, `drafts`: other users' (G, unfiltered L) | ✓ → ✓ | ✓ → ✗ | ✓ → ✗ | ✗ → ✗ | ✗ → ✗ |
| `autoSaves`: own / other users' | ✓ / ✓ | ✓ / ✓ → ✗ | ✓ / ✓ → ✗ | ✗ | ✗ |
| `users`: own profile | ✓ → ✓ | ✓ → ✓ | ✓ → ✓ | ✓ → ✓ | ✓ → ✓ |
| `users`: other profiles (G, L) | ✓ → ✓ | ✓ → ✓ | ✓ → **✗** | ✗ → ✗ | ✗ → ✗ |
| `users/{uid}/preferences` | own only (unchanged) | own | own | ✗ | ✗ |
| `auditLogs`, `telemetry` | ✓ → ✓ | ✗ → ✗ | ✗ → ✗ | ✗ → ✗ | ✗ → ✗ |
| `tipHealth`, `tipFailures`, `anomalies`, `rateStats`, `rateHistory`, `monthStats` | ✓ → ✓ | ✓ → ✓ | ✗ → ✗ | ✗ → ✗ | ✗ → ✗ |
| `rent_*` (incl. `rent_settings`, `rent_receipts`, `rent_counters`) | ✓ → ✓ | ✗ without a `rentRole` | ✗ without a `rentRole` | ✓ → ✓ | ✗ → ✗ |
| `rent_public` | G ✓, L ✗ for everyone, signed out too (unchanged) | | | | |

Rentals were already scoped and are unchanged; the matrix tests now check them for every role
(a shop role alone reads no `rent_*`, a rentals role alone reads no shop data).

### How the app's queries satisfy the rules

- `notifications` and `drafts` queries already filter `where('userId', '==', uid)`; a get of a
  missing draft is allowed (nothing to leak). Auto-save reads only `autoSaves/<own uid>`.
- Withdrawals: `FirebaseService` reads them (listener, older history, refresh, oldest probe,
  legacy scan) only when `canReadWithdrawals(role, roleAccess)` (`utils/role-access.js`) says the
  rules allow it; otherwise `AppState.withdrawalsHistory` stays empty and no query is sent. It
  uses the last known Roles & access (saved on the device), so when the owner turns Money,
  Statements or Insights on for members, their withdrawals load from the next app start after the
  phone has seen the change. Tests: `realtime-listeners.test.js`.
- No other query changed: members still read bills, items, expenses, stock adjustments, cash days
  and counters exactly as before, so billing, History (within `historyDays`), Rates and
  Outstanding work as they did.
- `monthStats` writes: owners and managers write whole snapshots; any approved user may only
  mark a month stale (`{ month, stale: true, staleAt }`, a merge; a missing month gets that stub)
  when they save a record of an earlier month. Members still cannot read them.

### Read cost

Rules `get()`/`exists()` are billed once per request per document; for a listener they are
billed when it starts, on every change to its results and after a reconnect. The caller's
profile was already read for every business read; `isOwnerIn` / `isManagerIn` reuse it.

| Read | Docs the rules read before → after | Change |
|---|---|---|
| Own profile (every app start, login) | profile → none (own uid is checked first) | **−1 read** per start |
| Profile list (owner/manager) | profile → profile | none |
| Business collections, notifications, drafts, auto-save, settings | profile → profile | none |
| Withdrawals, owner | profile → profile | none |
| Withdrawals, manager or member allowed by Roles & access | profile → profile + `settings/app` | **+1 read** per listener start, per change to the withdrawals it shows and per reconnect; +1 per older-history query |
| Withdrawals, member without Money/Statements/Insights | listener + queries → not sent | **saves** the whole withdrawals window and older-history reads |
| Personal expenses (#98), owner | profile | none (new collection; the rows used to come with `expenses`) |
| Personal expenses, manager or member with the switch on | profile + `settings/app` | **+1 read** per listener start, per change and per reconnect; +1 per older-history query; an empty listener costs 1 read |
| Personal expenses, switch off | not sent; one `personalExpenseDays` get per day shown (Today, cash count), reused for a minute | **saves** the personal rows; +1 read per day total |

At most two documents are read by any read rule (profile, `settings/app`), well inside the limit
of 10. Members keep reading bills with no extra rule read, which is why `historyDays` stays
client-only (below).

### Not enforced in the rules (phase 2), and why

1. **Personal expenses**: enforced since #98, see "Personal expenses" below.
2. **History age** (`historyDays`). The bills behind stock (back to the checkpoint's `asOf`) and
   Outstanding (any age while a due is open; some are listened to by id) are older than a short
   history window, so the rules can't refuse old bills without breaking stock and dues. Checking
   it would also add a `settings/app` read to every evaluation of the busiest listeners (every
   bill change on every phone). Stays client-only; a server-side window needs stock and due
   summaries that don't depend on reading old bills.
3. **Past cash days** (`oldCashSessions`). The carry-forward reads the last counted day whatever
   its age, and the review list reads uncounted days (older days may have no `counted` field), so
   the queries can't carry a date bound the rules could check. Needs a carry-forward summary on
   today's session first.
4. **Profit, stock ₹ value, purchase rates**: client-only by design; they come from purchase
   rates and the stock checkpoint that members need for billing and stock.
5. `settings/app` stays readable by every approved user: each phone needs `minClientVersion`,
   `roleAccess`, labour, bill checks and TIP policy at start-up; a separate owner-only doc would
   cost one more read per app start for everyone.
6. Write side of per-user records (#18 follow-up), **now enforced**: `autoSaves/{uid}` is
   written and deleted only by that user (`docId == uid`, `userId` = own uid); drafts are
   created and changed only by their own user with `userId` = own uid, never changed; a
   notification is created only by an owner or manager (the only roles that edit items) for
   another user, with `changedByUserId` = own uid, server `timestamp`, `read: false`, id
   `<eventKey>_<userId>`, type `rate_change` or `item_edit` and only the fields the app
   writes; members send none. Only the recipient updates a notification, and only `read` /
   `readAt`. Drafts and notifications are deleted by their own user, auto-saves by theirs; the
   owner may delete any of them (Admin › Clear Data) but not write them. Still not checked:
   who a notification goes to (wholesale rate changes go only to owners/managers, item edits
   only to owners) — that would cost one profile read per recipient. No extra rule reads
   (the sender's profile is already read). Tests: "per-user records" in `rules-tests/test.js`.

## Personal expenses (#98)

- **Where**: new personal expenses are saved in `personalExpenses` (+ `dev_`) with the `day` they
  count on. `personalExpenseDays/{YYYY-MM-DD}` = `{ amounts: { <expense id>: amount }, last }` (no names
  or notes) gets that expense's key in the same batch (also offline): set on create and edit, removed
  on delete. The day's total is the sum of the map, so a repeated delete, a late queued write or two
  phones editing at once can't make it drift. Business expenses stay in `expenses`.
- **Rules**: `personalExpenses` is read and written only by the owner and by roles whose
  `roleAccess.<role>.personalExpenses` is on (default on; one read of `settings/app`, never for the
  owner). Creates: own `userId`, numeric amount, `category: 'personal'`; edits and deletes follow
  the expense rules (creator for 24 hours, managers any, owner anything); `day` never changes.
  `personalExpenseDays` is readable by every approved user and written only by those who may write
  personal expenses: one key per write (`last`), set to that expense's amount after the write on
  its `day`, or removed when the expense is gone. Members only touch the key of an expense written
  in the same batch; managers may also correct a key to the stored amount. Nobody but the owner can
  zero the map, add a key for an expense that doesn't exist or delete the doc.
- **Rebuild**: owner/manager phones that have the rows compare the last 7 days' docs with them once
  a session, when idle (one read per day; one write per wrong key, none when right).
- **Who sees the totals (accepted)**: a role with the switch off can't read the entries or their
  notes, but still sees personal expense *totals*: the day total in the cash drawer and on Today, and
  the month total in the shared month snapshots (`monthStats`, M8). The drawer needs them to add up,
  and the month total is the sum of the days anyway. The Roles & access screen says so next to the
  switch.
- **App**: `FirebaseService` starts the `personalExpenses` listener only when
  `canReadPersonalExpenses()` says the rules allow it (last known Roles & access, like withdrawals)
  and merges it into `AppState.expensesHistory`, so Money, Statements, Insights, Today, the cash
  count and the Expenses page read it as before. Whether a phone *has* the rows is
  `personalRowsLoaded()`: the listener started and delivered its first snapshot (not what Roles &
  access says now). Without them, Today (T5) and the cash count (C3/C7) add the day total instead,
  so the drawer still adds up; auto-closing a past day skips (retries later) a day whose total
  couldn't be loaded rather than store a guess; Money / Statements / Insights leave personal
  expenses out (their personal lines are hidden for that role anyway), and the phone never writes
  the shared month snapshots (`monthStats`).
- **Old rows**: personal expenses saved before #98 stay in `expenses` and are still read with it.
  The rules refuse *new* `expenses` rows tagged personal (`category`, trimmed, any case) and edits
  that tag one personal, so older app versions can't put personal rows where members read them
  (they get a save error). happa's data is test data that is wiped at go-live; `tools/migrate`
  (`--mode full`) writes the old app's personal expenses (`category: 'personal'`) into
  `personalExpenses` with their `day`, a numeric `timestamp` from their date and their day docs,
  built the same way as the rebuild (idempotent: same ids and values). The default fresh start
  copies no expenses.

## Caching (≤ 1 read per app start)

- Startup: `RolesAccessManager.applyShared()` runs on the existing `settings/app` read
  → **0 extra reads**.
- `AppState.settings.roleAccess` is saved with the other settings in `localStorage`
  (`settings`), so the next start (and offline use) applies the last known values before the
  read returns.
- The owner's save applies on the owner's phone at once. Other phones pick it up on their next
  app start (no listener, to keep the cost at zero). The rules always use the live value.

## Safe defaults

- No `settings/app`, no `roleAccess`, a missing role or a bad value → the defaults above
  (today's behaviour + 2-day edit window). The client normalizes; the rules fall back to 2 for a
  missing/non-integer/out-of-range `editDays`.
- An unknown role gets member access in the client (the rules already refuse unknown roles).

## Migration and old APKs

- No data migration. Nothing is written until the owner saves Roles & access.
- Deploying the rules switches on the 2-day window for everyone at once (#87). Old APKs
  (≤ v1.6.1) still show Edit/Delete on older bills; the server refuses the write and the app shows
  its usual "failed" message. Old APKs do not read `roleAccess`, so their page/section hiding
  stays today's hard-coded behaviour (members: no Finance/Reports/Analytics/Sales). Raise
  `minClientVersion` after the update has reached every phone if that matters.
- Managers lose full edits of bills without a server `createdAt` (owner only now). Bills saved
  by old APKs carry no `createdAt`, so they are owner-only for edits/deletes from the start.
- Built on PR #226 (`feat/edit-window-87`): it adds the server `createdAt` and a fixed 2-day
  window. This PR keeps its clock and takes the days from `settings/app.roleAccess` (default 2),
  replacing #226's fixed client helper and "2 days" message. Merge order: #226, then this PR.

## Phase 2 (not in the first PR)

1. **Personal expenses in rules**: done in #98 (see "Personal expenses").
2. **Profit / average cost and stock ₹ value**: client-only by design. Both come from purchase
   rates that members need for billing and stock; hiding them in rules would need owner-only copies
   of purchase rates.
3. **History age and past cash days in rules**: see "Server-side read rules" (stock, dues and the
   cash carry-forward read older records; needs summaries first).
4. History "own bills only" for members (Q31).
5. Expense/withdrawal edit window from `roleAccess` (today a fixed 24 h, #18).
6. Live update via a `settings/app` listener if the owner wants changes to apply without a restart.
7. Rules validation of the whole `roleAccess` shape on write (today: owner-only write, client
   normalization, rules fallback for `editDays`).

## Writes to shared records (#18, #64)

The owner may write any of these (repairs, backup restore). Everyone else:

| Collection | Create | Update | Delete |
|---|---|---|---|
| `expenses`, `withdrawals` | approved user, own `userId`, numeric amount | expenses: own for 24 h (some fields), managers any; withdrawals: managers | expenses: own for 24 h, managers; withdrawals: managers |
| `stockAdjustments` | **owner/manager** (#64; members never see Stock › Adjustment) | managers (anyone: legacy timestamp backfill, see below) | managers |
| `cashManagement` | approved user, own day `cash_<date>` only, with the fields sign-in sends and no entries | append entries, close, late count; a closed day stays closed | owner |
| `cashSessions` (legacy, backup only) | **owner** (#64) | **owner** (#64) | owner |
| `items` | managers | managers | owner |
| `counters` | approved user (bill numbers) | +1 per bill | owner |
| `itemFrequency` | approved user, `global` only (billing ranks items) | approved user: merges into `global.purchase` / `global.sale`, never removing an item | **owner** (#64) |
| `stockCheckpoints` | `current`: managers (anyone approved: the stale mark); `legacyScan`: managers; no other ids, owner included | same | managers |
| `settings/app` | owner | owner; managers only the Aadhat fields with `shopSettings` | owner |
| other `settings` docs (none in use) | **owner** (#64) | **owner** (#64) | **owner** (#64) |

Legacy timestamp backfill (`expenses`, `withdrawals`, `stockAdjustments`, `personalExpenses`; anyone
approved): only fills a missing numeric `timestamp` (+ `clientVersion`), with the value the app derives
(`eventTime`): never after the server's time, equal to an old Firestore Timestamp in `timestamp` or
`date`, and within a day of the record's `YYYY-MM-DD` or `DD/MM/YYYY` date. `itemFrequency` items are
not checked one by one (rules can't loop over map keys), so a member can still change an item's numbers.

## Settings sections (who sees what)

Settings shows **Common** to everyone, plus the section of the business open in the switcher, with a
small button to view the other business's section when the user may see it
(`utils/settings-sections.js`, `settingsView()`):

| Section | Sees | Edits | Stored in |
|---|---|---|---|
| Common: language, account (name, change password, sign out), notifications, printer, install, What's new / About | everyone | own device / own profile | device, `users/{uid}.name` |
| Common: Roles & access (+ People) | owner | owner | `settings/app.roleAccess`, `users/{uid}.rentRole` |
| Aadhat: business name and details, UPI ID, labour, bill checks, bill numbers, opening stock link | Aadhat owner and managers | owner; managers with `shopSettings` (UPI ID: this device) | `settings/app` (read at start-up, no extra read); UPI ID on the device |
| Rentals: defaults for new leases (due day, yearly %, electricity rate, tenant link), business name and address on rent receipts and tenant pages | Rentals owner and managers | owner and Rentals managers | `rent_settings/default` (+ `dev_`), read only when this section is shown, a tenant moves in or a payment is recorded |

Rent receipts (`rent_receipts`, numbered by `rent_counters/receipts_<year>`): issued by anyone with a
rentals role with the payment they record; a payment saved without one gets it later from its writer or
from the owner / a Rentals manager (Issue receipt); never edited or deleted; only the owner and Rentals
managers cancel one (void, with a required reason and an audit entry).

Members (Aadhat or Rentals) see only Common. Old routes keep working: `settings`, `admin-configure`
and `settings-aadhat` (→ Aadhat), `settings-shop`, `settings-rentals`, `settings-roles`; Admin's old
Configure tab opens Settings › Aadhat.
