# Roles & access: what each role may see and do (#84)

Owner decision on #84: *"Give owners access to control this from the app itself. Role wise."*
Owner decision on #87: *non-owner users may edit or delete a bill for 2 days.*

The owner sets, per role, which pages and numbers managers and members see, how far back
History goes and for how many days bills can be changed. Screen: **Settings → Roles & access**
(owner only, English and Hindi).

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
| `finance` | Finance page | हिसाब-किताब पेज | on | off | client |
| `reports` | Reports page | रिपोर्ट पेज | on | off | client |
| `analytics` | Analytics page | विश्लेषण पेज | on | off | client |
| `wholesale` | Sales (wholesale) page | बिक्री (थोक) पेज | on | off | client |
| `personalExpenses` | Personal expenses | निजी खर्च | on | on | client (rules: phase 2) |
| `profit` | Profit and average cost | मुनाफा और औसत लागत | on | on | client |
| `stockValue` | Stock ₹ value | स्टॉक की ₹ कीमत | on | on | client |
| `oldCashSessions` | Past cash days | पिछले दिनों का कैश | on | on | client |
| `historyDays` | History: days back (0 = all) | इतिहास: कितने दिन पीछे तक (0 = सभी) | 0 | 0 | client |
| `editDays` | Edit/delete bills for (days) | बिल बदलने/हटाने के दिन | 2 | 2 | **client + rules** |

- `editDays`: whole days, 0–30; 0 = never. Managers may edit any bill and delete their own;
  members edit and delete only their own bills. Recording a payment, clearing or writing off
  a due is **not** limited (it is bookkeeping, not an edit). The owner has no limit.
- `historyDays`: whole days, 0–3650; 0 = all bills.
- Pages that read owner/manager-only collections (Admin, Diagnostics, Anomalies, Rate trends,
  App health) and the stock adjustment / item edit actions are not in the list: their rules are
  fixed and the setting could not open them.
- #154 asked for "narrow only". The owner's later decision is per-role control, so the owner can
  also turn a page *on* for members. Everything in the list is data members can already read
  (client-only gating), so turning it on grants nothing the rules would refuse.

## Where it is stored

`settings/app.roleAccess` (and `dev_settings/app.roleAccess` for `dev_` previews):

```js
roleAccess: {
  manager: { finance: true, reports: true, analytics: true, wholesale: true,
             personalExpenses: true, profit: true, stockValue: true, oldCashSessions: true,
             historyDays: 0, editDays: 2 },
  staff:   { finance: false, reports: false, analytics: false, wholesale: false,
             personalExpenses: true, profit: true, stockValue: true, oldCashSessions: true,
             historyDays: 0, editDays: 2 }
},
roleAccessUpdatedAt: <ms>, roleAccessUpdatedBy: <uid>
```

Why `settings/app` and not a separate `settings/permissions` doc:

- **Owner-write only already**: `appSettingsGuard` lets only the owner write `settings/app`
  (it also holds `minClientVersion`). Every approved user can read it.
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
  tested in `auth-gate.test.js`) now asks `canOpenTab()` for Finance, Reports, Analytics and
  Sales (wholesale). `NavigationManager.showTab()` refuses a page that is off for the role
  (direct navigation, keyboard shortcuts, links from other pages) and shows Billing with a
  message.
- **Sections and numbers**: elements carry `data-perm="profit"` (or `stockValue`,
  `personalExpenses`, …; several = space-separated). `applyRoleBasedRestrictions()` puts
  `no-perm-<id>` classes on `<body>` and `css/settings.css` hides the matching elements, which
  also covers templates and rows rendered later. Marked: Finance profit / COGS / stock value /
  personal cards, net worth; Reports gross profit; Analytics profit cards and trend; wholesale
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
- Payment bookkeeping (`bookkeepingOnly` + `paymentEditOk`) is unchanged and not time-limited.
- `settings/app` writes stay owner-only (`appSettingsGuard`).

**Per-request limits and read cost** (Spark: rules `get()`/`exists()` are billed as reads; a
document is billed once per request; limit 10 docs per single write, 20 per batch/transaction):

| Request | Docs the rules read | Change |
|---|---|---|
| Bill create / payment / clear | profile, `settings/app` (clientVersion gate) | none |
| Non-owner full bill edit | profile, `settings/app` | none (same docs) |
| Non-owner bill delete | profile, `settings/app` | **+1 read** (delete did not read `settings/app` before) |
| Owner writes | profile | none (owner short-circuits) |
| Reads of any collection | profile | none |

The edit-window branch is only evaluated after `isOwnerIn` fails, so the owner never pays for it.

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

1. **Personal expenses in rules**: move personal rows to a `personalExpenses` (+ `dev_`) collection
   (owner-run batched migration) with `allow read` checking `roleAccess.<role>.personalExpenses`
   (one extra `get()` per query/listener start, not per document). A `scope` field cannot protect a
   shared collection because members' list queries do not filter on it.
2. **Profit / average cost and stock ₹ value**: client-only by design. Both come from purchase
   rates that members need for billing and stock; hiding them in rules would need owner-only copies
   of purchase rates.
3. **History age and past cash days in rules**: needs member queries constrained by `timestamp`
   / `date` so rules can check `resource.data` on list queries.
4. History "own bills only" for members (Q31).
5. Expense/withdrawal edit window from `roleAccess` (today a fixed 24 h, #18).
6. Live update via a `settings/app` listener if the owner wants changes to apply without a restart.
7. Rules validation of the whole `roleAccess` shape on write (today: owner-only write, client
   normalization, rules fallback for `editDays`).
