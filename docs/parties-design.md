# Parties design: stable customer / supplier ids for udhaar, and merging duplicate names (#139)

Status: **proposal** (docs only, no code change), 1 Nov 2026, `main` at `6a6bed3`.
Issue: #139 (old app #146). Related: #125 (wholesale dues on Outstanding, owner decision),
#126 (one canonical due field), #150 (bulk settle), #152 / PR #247 (one payment spread over a
party's bills, merged), #103 (exports of customer data), #113 (offline edits overwrite each other),
#116 (PII in telemetry), old app #68 (name required for a due: now the `party-required` bill check).

Read with: [calculations.md](calculations.md) (PARTY, BILL-DUE, OPENING, VOID, O1–O4, ST3,
I3 / I4 / I10, REM-1), [architecture.md](architecture.md) (layers, repositories, ratchet),
[role-permissions.md](role-permissions.md), [read-budget.md](read-budget.md),
`tools/migrate/README.md`, and the platform proposal `docs/platform-design.md` (PR #208, open).

**Recommendation in one paragraph.** Add a small `parties` collection (one doc per customer or
supplier) plus **one directory doc** (`partyIndex/main`) that every phone listens to for 1 read
per start. New bills carry `partyId` next to the name they already store (`customerName`, kept
as a snapshot). **Grouping goes through one pure resolver**: `partyId` (following `mergedInto`),
else the bill's normalised name looked up among that side's party names and aliases, else the
normalised name exactly as today. **Merging is owner-only and never rewrites bills**: the loser
gets `mergedInto: <winner>` (3 writes, whatever the number of bills), so it can be undone exactly,
works for voided and not-loaded bills, and keeps every total equal. Until the first party exists
the resolver gives today's grouping, so the first PRs change no figure.

---

## 1. Today (evidence on `main`)

| What | Where | Effect |
|---|---|---|
| A bill stores only the typed name: `customerName` (purchases put the **supplier** in `customerName` too; very old bills may have `supplierName`). No id, no phone on new bills | `modules/retail-sale.js` (sale object), `purchase.js`, `wholesale-sales.js`; `utils/due-payments.js` `billParty()` | Nothing ties two bills to one person except the text |
| Grouping key = `normalize('NFC').trim()`, inner spaces collapsed, lower case ("Ramesh", "ramesh " = one party; "Ramesh Ji", "R. Kumar", "रमेश" = three) | `utils/aging.js` `normalizePartyName`; a **second copy** `utils/due-payments.js` `normalizeParty` / `sameParty` | Spec PARTY. Renaming a customer (typing a new spelling) splits the balance |
| Display name = most used spelling (`pickPartyName`) on Outstanding and Insights, but the **first** spelling seen in the Statements party picker and ledger | `aging.js` `buildAging`, `business-metrics.js` `partySummary`; `utils/statements.js` `partyChoices` / `partyLedger` | The same party can be spelt differently on two pages |
| Outstanding groups the loaded open bills by that key; the reminder / statement / "Receive from party" (FIFO, #152) / "Complete all due" (#150) actions pass the key in `onclick` | `modules/outstanding.js` `renderDue`, `findParty`, `receiveFromParty`, `partyOpenBills` → `due-payments.js` `partyDues(bills, key, keyOf)`; `wholesale-sales.js` | Already takes a `keyOf` function: the resolver plugs in there |
| "Already owes ₹…" under the name field (#166) | `utils/party-due.js` `partyDue` | Same key |
| Statements party ledger ST3, Insights I3 / I4 / I10 / I12, "stopped coming", month snapshots (`monthStats.customers[].k` = normalised name) | `utils/statements.js`, `business-metrics.js` `partySummary`, `stoppedComingCheck`, `overdueParties`, `month-snapshots.js` | Snapshot keys are names: a later merge must still find them |
| Cash page "This bill is for X, not Y" | `modules/cash-management.js` (`sameParty`) | Same key |
| Name suggestions: Wholesale fills its datalist from loaded wholesale bills, the cash page from all loaded bills; the **purchase and retail datalists (`customerOptions`, `saleCustomerOptions` in `templates/billing.html`) exist but nothing fills them** | `wholesale-sales.js` `updateWholesaleCustomerOptions`, `cash-management.js` `loadCustomerOptions` | Typos create new parties every day |
| Phone: only migrated opening records have `customerPhone`; Outstanding takes the newest bill's `customerPhone` / `phone` / `mobile`; without one the reminder opens the share sheet | `aging.js` `billPhone`, `outstanding.js` `sendReminder` | WhatsApp reminders reach only migrated parties directly |
| Migration writes one opening record per old unpaid bill with `customerName` + `customerPhone`; "party list: not carried (fresh start)" | `tools/migrate/README.md`, `lib/plan.js` | Natural place to create the first parties |
| Rules: bills may carry any extra field on create; `customerName` is an **edit-logged** field (changing it needs an edit record, #121); a voided bill never changes (owner included); outside the edit window (manager / creator) only bookkeeping (payments, clearing) | `firestore.rules` `editLoggedFields`, `billUpdateAs`, `validBillCreate` | Rewriting names on old bills is costly or impossible (voided) |
| TIP telemetry already drops `customerName`, `phone`, `partyId` keys | `sanitizeProps` (TIP no-PII guard, `__tests__/tip.test.js`) | Parties stay out of telemetry |

Phones load bills from the 1st of last month **plus every bill with `openDue == true`**
(`firestore-service.js`), so all open dues are already on the phone: grouping them by party needs
no extra bill reads.

---

## 2. Data model

### 2.1 `parties/{partyId}` (and `dev_parties`)

| Field | Type | Rules / notes |
|---|---|---|
| (doc id) `partyId` | string, client-made (`Helpers.generateId()`, like bills) | Made on the phone, so a party can be created offline. Never reused |
| `name` | string, 1–60 chars, trimmed, inner spaces collapsed | Display name in English UI, as the shop writes it ("Ramesh Kumar") |
| `hindiName` | string ≤ 60, optional | Display name in Hindi UI ("रमेश कुमार"). Suggested with the offline transliterator of PR #254 (items), never required |
| `phone` | string, optional: 10 digits `^[6-9][0-9]{9}$` (stored without +91) | Personal data (section 10). Only with `phoneConsent` |
| `legacyPhone` | string, optional, same format | Set only by the migration (old-app phones, no recorded consent, section 8); owner and manager may delete it, nobody sets it in the app. Used for reminders like `phone`; flagged "ask the customer to confirm"; deleted when a consented `phone` is saved or on "Remove phone" |
| `phoneRemovedAt` | server time, optional | Set by "Remove phone" (owner/manager, section 10): no phone is taken from the party's bills any more; cleared when a consented `phone` is saved |
| `phoneConsent` | map, optional: `{ at: server time, by: uid, byName, how: 'told' \| 'written', purpose: 'bills-reminders' }` | Set in the same write as `phone`; removed with it |
| `type` | `'customer'` \| `'supplier'` \| `'both'` | Which side's bills it can resolve (section 3). A customer who also sells to the shop is `both` |
| `aliases` | list of strings, ≤ 20, each ≤ 60 | Other spellings that mean this party ("Ramesh Ji", "R. Kumar"). A rename adds the old `name` here automatically |
| `mergedInto` | partyId, optional | Set by the owner's merge (section 5). The doc is kept for ever; it resolves to the winner |
| `mergedAt`, `mergedBy`, `mergedByName`, `mergeReason` | server time, uid, string ≤ 200, string 3–300 | Written with `mergedInto`, removed by an unmerge |
| `archived` | bool, optional | Hidden from suggestions; still resolves (old bills keep their party) |
| `erasedAt` | server time, optional | DPDP erasure done (section 10) |
| `unmergedAt`, `unmergedBy`, `unmergeReason` | server time, uid, string 3–300 | Written by an unmerge, which clears only `mergedInto`: the last merge and its undo stay on the doc for good (audit rows are cleaned after 90 days) |
| `createdAt`, `createdBy`, `createdByName` | server time, uid, string | `createdAt == request.time` |
| `updatedAt`, `updatedBy` | server time, uid | Every update; edits are field-level `update()`s, so two phones editing different fields don't overwrite each other (#113) |
| `clientVersion` | int | The `CLIENT_VERSION` that understands parties (gate, as for bills) |

No money is stored on a party. A balance is always Σ BILL-DUE of the bills that resolve to it, so
nothing can drift and a merge can't change a total.

### 2.2 `partyIndex/main` (and `dev_partyIndex/main`): the directory

One doc every approved phone listens to. It holds **names only, never phones**:

```js
{
  p: {
    '<partyId>': { n: 'Ramesh Kumar', h: 'रमेश कुमार', a: ['Ramesh Ji'], t: 'c',   // c | s | b
                   c: <server time> /* createdAt: tie-break */,
                   m: '<winnerId>' /* merged */, x: true /* archived */,
                   e: <server time> /* erasedAt */, ek: ['<hash>'] /* erased name keys */ }
  },
  last: '<partyId>',        // the one entry this write changed (personalExpenseDays pattern)
  updatedAt: <server time>
}
```

- Written in the **same batch** as the party doc it mirrors, as **leaf field paths**
  (`p.<id>.n`, `p.<id>.a`, `p.<id>.x`, …), never the whole entry: two phones adding different
  parties, or renaming and archiving the same one, both land, and an offline edit of a party can't
  wipe a merge (`p.<id>.m`) written meanwhile.
- `c` and `e` are written as server-time sentinels in the same batch as the party's `createdAt` /
  `erasedAt` (a phone offline can't know the server time); the rules require them to equal
  `request.time` when set and never change them. Until the write reaches the server a phone sees
  `c` as pending and treats that party as the newest.
- Normalised keys are **not stored** (except `ek`, section 10): each phone computes them with the
  one normaliser, so a normaliser fix never needs a data rewrite.
- Size: Firestore counts every map leaf as a field (at most 20,000 per doc) and indexes each one, so
  `firestore.indexes.json` gets `fieldOverrides` entries exempting `p` from indexing in both
  `partyIndex` and `dev_partyIndex`
  (phase 2). With ~8 leaves per party a doc holds about **2,500 parties** (well under 1 MiB). Above
  ~2,000 (Diagnostics shows the count and warns), shard to `partyIndex/0`…`partyIndex/f` by the
  first hex digit of a hash of the id (16 reads per start instead of 1). Not needed for the aadhat.

### 2.3 Bills

| Field | Change |
|---|---|
| `partyId` | **New, optional.** Set when the name was picked from the suggestions or a new party was made on save. Never required: a bill without it is resolved by name (section 3) |
| `customerName` | **Unchanged and still written**: the name as printed on that bill (snapshot). Never rewritten by a rename or merge. Receipts, History rows and the WhatsApp bill text keep showing it |
| `customerPhone` | Not written on new bills (the phone lives on the party). Opening records keep theirs until erased (section 10) |

`partyId` joins `editLoggedFields()` in the rules (and `EDIT_FIELDS` in `bill-edits.js`): moving
a bill to another party moves a due, so it needs an edit record with a reason, like a name change.
Setting it on **create** costs nothing extra.

---

## 3. Resolution: which party a bill belongs to

One pure module, `www/js/utils/parties.js` (no DOM, Firestore or AppState; oracle-tested):

```js
partyNameKey(name)                          // the one normaliser (replaces both copies)
buildPartyResolver(directory, { lang })     // → resolver
resolver.keyOf(bill, side)                  // 'p:<rootId>' or 'n:<normalised name>' or ''
resolver.nameOf(key, spellings)             // display: party name (hi: hindiName || name); unlinked: pickPartyName
resolver.duplicates()                       // keys claimed by two live parties on one side
```

`side` is `'customer'` for retail and wholesale bills, `'supplier'` for purchases. A party serves a
side when its `type` is that side or `both`.

**Rule PARTY (new wording, lands in calculations.md with phase 5):**

1. **`partyId` present and known** → follow `mergedInto` to the root (at most 10 hops; a cycle or
   an unknown hop stops at the last good party) → key `p:<rootId>`.
2. **Else** (no `partyId`, or an id the directory doesn't have yet, e.g. a party write refused or
   not synced) → `partyNameKey(customerName || supplierName)` looked up among the **names, Hindi
   names and aliases** of every party serving that side, merged parties included (and, for a bill
   dated before an erasure, the erased party's `ek` hashes, section 10) → that party's root →
   `p:<rootId>`.
3. **Else** → `n:<normalised name>`: exactly today's grouping. A blank name → `''` (the existing
   "No name" row).

**Two live parties claiming the same key on one side** (e.g. two phones offline both created
"Suresh", or two real people called "Ramesh") → the older `createdAt` (directory `c`, server time;
pending counts as newest) wins, then the smaller id, so every phone resolves the same way from the
directory alone, and the owner sees
it under "Possible duplicates" (merge, or give one a distinguishing name such as "Ramesh (Kheda)").
The server does **not** enforce unique names: a refused key claim would arrive at sync time, after
the bill was printed, and could strand the party or the bill. Duplicates are exactly what the
merge tool is for.

**Properties** (tested):

- With an empty directory every key is `n:<name>` → every figure equals today's (characterisation).
- Totals never depend on the directory: resolution only regroups the same bills, so
  Σ over parties = Σ BILL-DUE of the bills (O3, O4, F9, F10 unchanged).
- Deterministic on every phone for the same directory (no "first loaded wins").
- `keyOf` is passed into the existing calc functions (`buildAging(bills, { keyOf })`,
  `partyDues`, `partyLedger`, `partyChoices`, `partySummary`, `stoppedComingCheck`,
  `overdueParties`, `partyDue`), so the maths stays in `utils/**` and the pages only pass
  `AppState.partyDirectory` in. The default `keyOf` is today's name key. Today `partyDues` calls
  `keyOf(bill.customerName)` and `partyDue(bills, name)` takes the typed name: phase 1 changes both
  to `keyOf(bill)` and a party key (callers updated in the same PR).

Normaliser: unchanged (NFC, trim, collapse spaces, lower case), so phase 1 moves no bill between
groups. Honorifics ("Ji", "जी", "Bhai", "Seth"), dots ("R.K." vs "RK"), zero-width joiners in Hindi
typing and close spellings are used **only for "Possible duplicates" suggestions**, never for
automatic grouping (open question 8).

---

## 4. Writing bills: picking a party

- The name field on Purchase, Retail sale, Wholesale and the cash page's due payment becomes a
  suggestion list from the directory (same `<input list>`; the empty `customerOptions` /
  `saleCustomerOptions` datalists get filled). It matches name, Hindi name and aliases, shows the
  existing due (#166) and, for `both` parties, which side.
- **Picked** → the bill gets `partyId` + the typed/picked spelling as `customerName`.
- **Typed a name no party has** → on save (only when the name is not blank) the phone creates the
  party in **its own batch** (party doc + directory entry) and puts its id on the bill. The bill
  save is never blocked or batched with it: if the party write fails, the bill still resolves by
  name (rule 2). Type: `customer` for sales, `supplier` for purchases.
- **Typed a name that resolves to an existing party** (e.g. "ramesh " → Ramesh Kumar's alias) →
  `partyId` of that party, no new party.
- A due still needs a name (`party-required`, old #68); a party link is never required.
- Offline: all of the above works offline (client ids, queued writes, the directory from the
  offline cache).

Who may create parties: every role that can save bills (default; open question 1). Editing a party
(name, Hindi name, aliases, phone, type, archive): owner and manager. Merge, unmerge, erase: owner.

---

## 5. The merge tool (owner only)

**Where:** Settings › Common › Parties (owner), and a "Merge with…" action on an Outstanding party
row. The list shows each party's open due per side and bill count from the loaded bills, and the
"Possible duplicates" pairs.

**Flow:** pick two parties → choose which one stays (default: the one with more bills) and its
display name → preview "Ramesh Kumar: ₹4,200 + Ramesh Ji: ₹800 = ₹5,000 after merge; total to
receive unchanged ₹1,23,400" → reason (3–300 chars, like a void) → confirm.

### 5.1 Option A (recommended): merge by `mergedInto`, no bill rewrites

One batch, **3 writes**, whatever the number of bills:

1. loser `parties/{loser}`: `mergedInto`, `mergedAt`, `mergedBy`, `mergedByName`, `mergeReason`;
2. `partyIndex/main`: the leaf `p.<loser>.m = <winner>` (and, if the owner renamed the winner or it
   now serves both sides, the winner's leaves too, with the winner doc as a 4th write);
3. an `auditLogs` row (`action: 'PARTY_MERGE'`, the rules' `^[A-Z][A-Z0-9_]{0,63}$` format; both
   ids, the reason, the before/after due of each side: the "totals equal" evidence). Audit rows are
   cleaned after 90 days, so the lasting record is the loser doc's `merged*` / `unmerged*` fields.

The loser's name, Hindi name and aliases are **not copied**: they stay on the loser doc and keep
resolving (rule 2 finds the loser, then follows `mergedInto`). The winner's party page lists them
as "Also known as". Hence:

- **Unmerge** is the same 3 writes (`PARTY_UNMERGE`; the loser's `mergedInto` and `p.<loser>.m`
  deleted, `unmergedAt` / `unmergedBy` / `unmergeReason` set) and is exact for bills (nothing was
  moved). Month snapshots store each bill's own key (section 9), so they split again too.
- Bills of any age, loaded or not, voided ones (which can never be written again), opening
  records, month snapshots keyed by a name or by the loser's id, and bills saved offline with the
  loser's id on a phone with an old directory: all land on the winner.
- Chains (A → B, then B → C) resolve A to C; the rules refuse merging into a party that is itself
  merged, and merging a party into itself.
- **A removed phone stays removed.** If the loser has `phoneRemovedAt` (section 10), the merge also
  writes the winner (the 4th write): `phoneRemovedAt` set and `legacyPhone` deleted, because the
  loser's opening records with that number now resolve to the winner. The preview says so; an
  unmerge doesn't undo it. Tested in phase 9 (when "Remove phone" ships).

### 5.2 Option B: batched backfill of `partyId` on the bills

| | Option A (`mergedInto`) | Option B (rewrite bills) |
|---|---|---|
| Writes | 3–4 per merge | per loser bill: 1 bill write + 1 edit record (`partyId` and `customerName` are edit-logged) → **2 × bills**, in batches of ≤ 250 bills (500 ops) |
| Reads | 0 (directory and loaded bills) | Every loser bill not on the phone: a query per stored spelling (`customerName in [...]`, exact strings only: Firestore can't query a normalised name, so spellings never loaded are **missed**), plus `partyId == loser`. A 2-year regular with ~700 bills ≈ 700 reads + 1,400 writes |
| Voided bills | Follow the winner | **Can't be written** (rules: a voided bill never changes) → still need resolution |
| Month snapshots, offline phones with the old id | Follow the winner | Still carry the loser → still need resolution |
| Undo | Exact, 3 writes | Another full rewrite; the edit history shows two edits per bill |
| History / receipts | Unchanged (snapshot name) | Unchanged only if `customerName` is left alone; then the rewrite only sets `partyId` |
| Partial failure | Atomic (one batch) | Many batches over quota days; a half-done merge must still group correctly → resolution again |

Option B needs the resolver anyway (voided bills, snapshots, offline phones) and costs
hundreds of times more, so it is **not built**. An optional owner "tidy" later could set `partyId`
on **open** bills only (they are loaded already, ~1 write each; owner writes of edit-logged fields
are allowed with `clientVersion ≥ 4`), but nothing needs it.

### 5.3 Invariants (Jest + oracle, phase 7)

- Σ receivable and Σ payable over all parties are equal before and after a merge and an unmerge
  (property test over generated bills and directories).
- Winner's due after = winner before + loser before, per side.
- Merge then unmerge = the original grouping, bill for bill and in month snapshots.
- Every merge and unmerge writes exactly one audit row.

---

## 6. Rules (phase 2; RULES PR: orchestrator's second review, not self-merged)

- Add `parties`, `partyIndex` to `businessCollections()` (and the `dev_` list), to
  `tools/backup` `BACKUP_COLLECTIONS` (the backup-collections test fails otherwise) and to Admin ›
  Clear Data.
- **Read:** any approved user (they bill and send reminders today; same exposure as
  `customerPhone` on bills now). Open question 9 if members should not see phones: then the phone
  moves to an owner/manager-only `partyContacts/{id}` doc.
- **Create** (`parties`): approved; keys `hasOnly` the section 2.1 fields; `name` 1–60;
  `hindiName` ≤ 60; `type` in the three values; `aliases` a list ≤ 20; `createdAt == request.time`,
  `createdBy == request.auth.uid`; no `mergedInto`, `erasedAt` or `legacyPhone` (`legacyPhone`
  only arrives through the migration, which runs with a service account); `phone` only with a
  `phoneConsent` whose `at == request.time` and `by == request.auth.uid`; `getAfter` of
  `partyIndex/main` has the matching `p.<id>` leaves (1 get).
- **Update:** owner/manager for `name`, `hindiName`, `aliases`, `phone`/`phoneConsent`, `type`,
  `archived`, `updatedAt`, `updatedBy`, `clientVersion`, `phoneRemovedAt` (`== request.time` when
  set, deleted only together with saving a consented `phone`), and **deleting** `legacyPhone` (never
  setting it) (field `hasOnly`); on an erased party (`erasedAt` set) only the owner may change
  `name`, `hindiName`, `aliases` or the phone, so a queued offline rename can't bring the real name
  back. Owner only: **merge** (`mergedInto` + `merged*` set, `mergedInto != docId`, the
  winner exists and has no `mergedInto`, 1 get, `reasonOk`), **unmerge** (`mergedInto` deleted,
  `unmerged*` set, `reasonOk`) and **erasure** (`erasedAt`). `createdAt` / `createdBy` never
  change.
- **Delete:** owner only (Clear Data). Erasure is an update, not a delete (old bills keep their
  link).
- **`partyIndex/main`:** keys `hasOnly(['p', 'last', 'updatedAt'])`. A non-owner write changes
  only leaves under `p.<last>` (`diff().affectedKeys().hasOnly([last])`, as `validPersonalDay`),
  never `m`, `e` or `ek`; `n`, `h`, `a`, `t`, `x` after the write equal the party doc after the same
  batch (`getAfter`, 1 get); `c` equals `request.time` when the entry is created and never changes.
  The owner may change several entries in one write (merge, unmerge, erasure, "Set up parties"),
  like every other owner write; the app still writes leaves only.
- **Bills:** `partyId`, when present, is a string matching `^[A-Za-z0-9_-]{1,40}$`; it is added to
  `editLoggedFields()` and `validEditCreate`'s `editFieldOk` list. Existence is **not** checked on
  bill create (offline ordering, expression budget; rule 2 covers a missing party). For erasure
  (phase 9) one narrow owner exception: deleting only `customerPhone` / `phone` / `mobile` on a
  **voided** bill (today a voided bill never changes, owner included).
- Rules tests for prod and `dev_`: create/update by each role, consent required with a phone,
  manager may delete but not set `legacyPhone`, `phoneRemovedAt` at server time, merge and unmerge owner-only, no self-merge or
  merge into a merged party, directory leaves must match and only `p.<last>` for non-owners, the
  edit record for a `partyId` change, a voided bill can't get a `partyId` but the owner can drop
  its phone.

---

## 7. Read and write costs on Spark (50k reads, 20k writes a day)

Assumptions: 300 parties (aadhat after a year), 5 phones, 40 app starts a day, 60 bills a day of
which 3 bring a new party, 20 reminders / statements a day, 2 merges a week.

| Action | Reads | Writes | Notes |
|---|---|---|---|
| App start | **+1** (directory doc) | 0 | A listener; served from the offline cache when nothing changed within the resume window |
| A party is created / renamed / archived | +1 per listening phone (directory changed) | **2** (party + directory) | ~3 a day × 5 phones = ~15 reads, 6 writes |
| A bill with `partyId` | 0 | 0 extra (a field on the same write) | |
| Reminder, statement, party page (needs the phone) | +1 (that party doc), cached for the session | 0 | ~20 a day |
| Merge / unmerge | 0 (+1 per listening phone) | **3–4** | |
| Erasure | the party's opening records, once: a document-id range `opening-` in the three bill collections (≈ the number of migrated dues, a few hundred), filtered on the phone by the resolver | 1 per party erased (the party and its merged-away parties) + 1 directory + 1 per opening record that has `customerPhone` | Rare; owner only |
| Outstanding, Statements, Insights grouping | **0** | 0 | Bills and directory already loaded |
| **A day, total** | **≈ 75–100** (0.2 % of 50k) | **≈ 10** | |

Rejected: a listener on the whole `parties` collection costs one read **per party per cold start**
(300 × 40 = 12,000 reads a day, 24 % of the quota) and grows with the shop. The directory doc keeps
it at 1 read per start up to ~2,500 parties. E2E read baselines rise by **1 at startup** per role
(recorded with `E2E_RECORD_READS=1` in phase 2, explained in that PR).

---

## 8. Migration from old data

**(a) Old app → happa (`tools/migrate`, before or at go-live).** `plan` already groups the opening
records with the app's own `buildAging`. It also proposes one party per group:

- `name` = `pickPartyName` of the group's spellings; `type` from the bill types (sales →
  customer, purchases → supplier, both → `both`); the other spellings → `aliases`;
- the newest bill's phone goes to `legacyPhone`, not `phone`: the migration can't record a
  consent the customer never gave. It works for reminders as today, the party page says "ask the
  customer to confirm", and it can be removed (open question 6);
- each opening record gets that `partyId` at creation (no edit record: it's a create);
- `report.md` gets counts only (parties, merged spellings, with phone), never names (the repo is
  public); a private `parties-review.csv` next to the bundle lists the proposals and the
  "possible duplicates" for the owner. Writes: parties + 1 directory doc (a few hundred, far under
  `apply`'s 12,000 budget). Idempotent: the id is `p-` + the first 16 hex digits of SHA-256 of a
  random salt and the normalised name (the type is not part of it, so a rerun where a name gained
  the other side keeps its id and just becomes `both`); the id can't be traced back to the name.
  The salt is made by the first `plan` and kept in the private bundle; every later `plan` (the
  usual "new plan, `--restart`" before go-live) takes `--salt-from <previous bundle>`, so the ids
  stay the same, and `apply` deletes migration parties (`p-*`) that are no longer in the bundle
  (as it already removes opening records whose bill is no longer due), so no orphaned party keeps a
  name or phone the app can't reach.

**(b) Data already in happa (if go-live comes first).** Owner action "Set up parties" (Settings ›
Parties, shown while any name on the loaded bills is not claimed by a party, with that count): builds
the same proposals from the bills already on the phone (the window + every open due: **0 extra
reads**), shows them for review (untick, rename, mark duplicates to merge), then writes the parties
+ directory (one batch per 250 parties). It ships **before** billing starts creating parties
(phase 3 before phase 4), so the owner reviews the existing names first; afterwards it stays
available for names that are still unclaimed. Bills are **not** touched: rule 2 links them by name.
Parties of older, fully paid bills appear the next time those names are billed, or when the owner
loads older history on Statements.

Either way no bill is rewritten, nothing is lost if the setup is skipped (rule 3 = today), and the
setup can be rerun (it only adds parties for unclaimed names).

---

## 9. Effects on each page

| Page / feature | Change | Spec |
|---|---|---|
| **Outstanding** (retail sales, purchases) and **Wholesale › Outstanding** | Rows grouped by `resolver.keyOf`; party name from the directory (Hindi UI: `hindiName` when set); phone by the one PHONE rule below; actions (`sendReminder`, `printStatement`, `receiveFromParty`, "Complete all due") take the resolved key (`p:<id>` / `n:<name>`) | O1–O4 definitions per PARTY (new wording); totals unchanged |
| "Already owes" under the name field (#166) | Uses the picked `partyId`, else the resolver; equals that party's Outstanding total | BILL-DUE |
| Cash page due payment | Suggestions from the directory; "bill is for X, not Y" compares resolved keys | DUE-PAY |
| **Statements › Party ledger** (ST3) | Party picker = directory parties with bills + unlinked names; header uses the party name; each bill row keeps its snapshot name; Hindi name in Hindi; a merged party's ledger opens the winner; `closing == due` check unchanged | ST3 |
| **Insights** I3 (sales by customer), I4 (by supplier), I10 (overdue parties), I12 (top share), "stopped coming" | Grouped by the resolver | I3, I4, I10, I12 |
| Month snapshots | From phase 6, `customers[].k` stores each bill's **own** key, not the resolved one: `p:<the bill's partyId>` or `n:<name>`. Old snapshots keep name keys. Both are resolved when read, so a later merge also merges last year's months and an unmerge splits them again. No rebuild, `SNAPSHOT_VERSION` unchanged | – |
| **WhatsApp reminders** (Outstanding, Today REM-1) | Name in the app language from the party; phone by the PHONE rule; without one the share sheet, as now; the message text is unchanged | REM-1 |
| History search | Also matches a party's aliases and Hindi name | – |
| Anomalies (duplicate bill check) | Compares resolved keys | – |
| Receipts, bill WhatsApp text, edit history | Unchanged: they show the bill's `customerName` | – |
| Exports / CSV (#103) | Party name + party id column; the phone only in owner exports | – |

**PHONE rule** (one function, `partyPhone()` in `utils/parties.js`, used by Outstanding, Wholesale ›
Outstanding, REM-1 and statements): the party's consented `phone`, else its `legacyPhone`, else the
newest open bill's `customerPhone` / `phone` / `mobile` (today's `billPhone`), but never from the
bills once the party has `phoneRemovedAt`, and nothing for an erased party. So migrated customers keep direct WhatsApp reminders on both migration paths (section 8),
and a phone typed with consent wins from then on.

---

## 10. DPDP (Digital Personal Data Protection Act 2023, Rules 2025)

The shop is the **Data Fiduciary** for its customers' and farmers' names and phone numbers. The
Rules were notified on 13–14 Nov 2025; most duties apply from **13 May 2027** (flagged: confirm
with a lawyer or CA). The design keeps the personal data small and removable:

- **What is personal data here:** party name (and Hindi name, aliases), phone. No address, no ID
  numbers, nothing medical. A party never stores free-text notes (they tend to collect personal
  details).
- **Purpose:** bills, dues (udhaar) and reminders about them. A name given for a credit sale is
  "voluntarily provided for a specified purpose" (s.7(a), legitimate use); the **phone** is asked
  for only to send bills and reminders, so the app records that the customer agreed:
  `phoneConsent { at, by, how, purpose }` with a one-line notice read out or shown when the phone
  is typed (en/hi, one language per string: "Ramesh agreed to get bills and reminders on
  WhatsApp"). Without the tick the phone isn't saved.
- **Withdrawal / correction:** "Remove phone" (owner/manager) deletes `phone` and `phoneConsent`
  (and `legacyPhone`) and sets `phoneRemovedAt` (server time) in one update. While it is set the
  PHONE rule (section 9) never falls back to a phone on the party's bills (migrated opening records
  carry the same number), so a withdrawal takes effect at once even while old dues are open.
  Saving a new consented `phone` clears it. Like erasure, it applies to the party **and every party
  merged into it**, so a later unmerge can't bring the number back.
- **Erasure (owner):** "Erase party" works on the party **and every party merged into it** (their
  names live on the losers, section 5.1). Once no due is open, it removes their phones
  (`phone`, `phoneConsent`, `legacyPhone`), Hindi names and aliases, replaces each display name with
  "Erased party · <n>" (a running number, not the id: migration ids are derived from names) and
  sets `erasedAt`. So that old name-only bills keep grouping under
  the erased party instead of reappearing under the real name, its directory entry keeps `e`
  (erasedAt) and `ek`: SHA-256 hashes of the erased name keys; rule 2 uses `ek` only for bills
  dated **before** `e`, so the same person coming back later becomes a new party. The browser's
  SHA-256 (`crypto.subtle`) is async, so the phone hashes each distinct name key once (memoised,
  and only while some entry has `ek`) when bills or month snapshots load, then regroups; the
  resolver itself stays synchronous. (While bills keep the plain name the hashes add no exposure;
  the archive tool below deletes `ek` when it blanks the names.) Bills keep their snapshot
  `customerName` because books of account must be kept (Income Tax and GST: about 6–8 years;
  flagged: confirm the period), and the shop may keep a name while money is owed. Opening records
  carrying `customerPhone` get it removed: the owner's phone reads the opening records once (ids
  start with `opening-`, a document-id range in each bill collection, section 7), picks those the
  resolver puts on the erased party or its merged-away parties, and removes the phone (owner
  write, not edit-logged; voided ones through the narrow rules exception in section 6). After the
  retention period the owner's archive tool (later) can blank the snapshot names too (bills and
  month snapshots' `customers[].k` / `n`), and only then deletes the `ek` hashes.
- **Minimisation:** the directory every phone reads has **no phones**; telemetry and TIP already
  drop `customerName`, `phone`, `partyId`; error reports never include party docs (#116); backups
  stay encrypted; exports with phones are owner-only and logged (#103).
- **Breach:** the backup and key handling in `tools/backup/README.md` apply; a party doc leak is a
  personal-data breach to report under the Rules (owner runbook item).
- These hooks are the `consent.record(partyId, purpose)` / `erase(partyId)` API that PR #208's
  core lists under "Privacy".

---

## 11. Carrying it into the platform core (PR #208)

Parties are **core** (dues / udhaar), not aadhat-specific:

| Piece | Core | App plug-in |
|---|---|---|
| `utils/parties.js` (normaliser, resolver, duplicate finder), `buildAging` / `partyLedger` with `keyOf` | (a) core, family "dues + ageing" (#208 phase 1b) | – |
| `firebase/repos/parties.js`, directory listener | core repository; path via `col()`: root mode `parties`, shop mode `shops/{shopId}/parties` and `shops/{shopId}/partyIndex/main` | – |
| Rules block `parties` / `partyIndex` | `10-core.rules`; the `dev_` twin generated | – |
| Party fields | name, Hindi name, phone + consent, type, aliases, merge, archive, erasure | **`party.fields`** in `app.config.json`: extra validated fields |
| Merge tool, Parties page, consent / erase | core page | wording |

- **Kirana:** customers with udhaar are the main use; the phone is often how the shopkeeper finds a
  customer, so the suggestion list also matches phone digits (core option `matchPhone`). B2B
  customers need a **GSTIN and state** for GSTR-1 B2B rows and the place of supply →
  `party.fields: [gstin, state]`. Distributors are `supplier` parties with GSTIN.
- **Pharmacy:** patients are `customer` parties with udhaar; **no medical data on the party**
  (prescriptions and the H1 register keep the patient name / address in their own append-only
  records, referencing `partyId` when there is one), because party erasure must stay possible while
  statutory registers are kept. Distributors are suppliers with GSTIN + drug licence number.
- The resolver's "unlinked name" fallback (rule 3) is only needed for happa's legacy bills; a new
  app can require `partyId` on every credit bill from day one (manifest flag `partyRequiredForDue`).

---

## 12. Phased PR plan

| # | PR | Size | Contents | Exit criterion |
|---|---|---|---|---|
| 0 | This doc | S | `docs/parties-design.md` | Owner answers the questions below |
| 1 | One normaliser + resolver, no behaviour change | M | `utils/parties.js` (`partyNameKey`, `buildPartyResolver`); `normalizeParty` / `sameParty` become re-exports; thread `keyOf(bill)` through `buildAging`, `partyDues`, `partyDue`, `partyLedger`, `partyChoices`, `partySummary`, `stoppedComingCheck`, `overdueParties` (callers updated); characterisation tests pin today's screens | Every figure and screen text identical; guard counts not up |
| 2 | **Rules + repository** (RULES: orchestrator review) | M | `parties`, `partyIndex` in rules, backup list, Clear Data, `fieldOverrides` exempting `p` in `partyIndex` and `dev_partyIndex`; `partyId` edit-logged; `firebase/repos/parties.js`; directory listener → `AppState.partyDirectory` (event, no page calls); `CLIENT_VERSION` bump; rules tests prod + `dev_`; read baselines +1 at startup | Rules tests green; E2E reads +1 only |
| 3 | "Set up parties" (owner, in-app) | M | Proposals from the loaded bills, review screen, batch write of parties + directory; i18n en + hi; cache bump | The owner can claim today's names before billing creates parties |
| 4 | Billing picks parties | M | Suggestions on Purchase / Retail / Wholesale / cash page (fills the empty datalists); `partyId` on new bills; party auto-created on save; Hindi name shown in Hindi; i18n keys en + hi; cache bump | New bills carry `partyId` (issue AC 1) |
| 5 | Dues by party (MONEY: orchestrator review) | M | Outstanding, Wholesale › Outstanding, party due, FIFO receive, complete-all, cash check, reminders use the resolver; phones by the PHONE rule (`partyPhone`); calculations.md PARTY rewritten + oracle tests (legacy bills still appear) | Issue AC 2; O3 / O4 unchanged on the fixtures |
| 6 | Statements and Insights by party | M | ST3 picker / ledger (party name, or `pickPartyName` for unlinked names instead of the first spelling), I3 / I4 / I10 / I12, stopped coming, snapshot keys (each bill's own key); oracle tests | Same totals; merged parties show as one |
| 7 | Parties page + merge tool (MONEY + RULES) | L | Settings › Parties (owner / manager), edit, archive, possible duplicates, owner merge / unmerge with reason, `PARTY_MERGE` / `PARTY_UNMERGE` audit rows; property test "totals equal before and after"; E2E merge flow | Issue AC 3 and 4 |
| 8 | Migration tool | M | `tools/migrate` proposes parties (private review CSV, counts-only report), `legacyPhone`, `partyId` on opening records, salted ids reused with `--salt-from`, stale `p-*` parties removed by `apply`, migration E2E checks | Rehearsal on the emulators: same Outstanding totals, one party per group |
| 9 | DPDP (RULES) | S | Consent tick + notice, remove phone, erase party (with its merged parties, `e` / `ek`), the voided-bill phone exception, owner-guide (en / hi) and security.md section | Rules tests: phone needs consent; erase leaves bills and totals intact |
| 10 | Core move | – | Part of #208 phase 1b (dues + ageing) and 1e (repositories) | – |

PRs 1, 3, 4, 6, 8 can be self-merged after a clean review; 2, 5, 7, 9 touch money or rules and go to
the orchestrator. 2 depends on 1; 3 and 4 on 2 (4 after 3); 5–7 on 1 and 2; 8 on 2; 9 on 7. Phase
8 must be in `main` before the real migration if go-live waits for it; otherwise the in-app setup
(phase 3) covers live data.

---

## 13. Open questions for the owner

| # | Question | Why it matters | Default if no answer |
|---|---|---|---|
| 1 | May everyone who bills create a new party by typing a new name, or only the owner / manager (others must pick from the list)? | Typos make duplicates; a closed list slows billing | Everyone may create; the owner merges duplicates |
| 2 | A person who both sells to you and buys from you (`both`): one party with two balances (to pay, to receive), or should the app show the **net**? | Netting changes what Outstanding shows | Two balances, shown side by side on the party page; no netting |
| 3 | Should the owner be able to **undo** a merge? | Option A makes it cheap | Yes, owner only, with a reason |
| 4 | Two different people with the same name: OK to ask you to give one a different display name (e.g. "Ramesh (Kheda)")? | Old bills with just "Ramesh" can only go to one of them | Yes; old "Ramesh" bills stay with the first one |
| 5 | Phone for udhaar customers: optional, or required when a due is left? | Reminders need it; DPDP needs consent | Optional |
| 6 | Phones carried from the old app: keep using them for reminders until the customer confirms, or drop them at migration? | No recorded consent for those | Keep as `legacyPhone`, owner can remove; ask at the next visit |
| 7 | How long to keep a customer's phone after their udhaar is cleared? | DPDP: keep only as long as needed | Until the owner removes it; reminder on the Parties page after 12 months with no bill |
| 8 | Should "Ramesh Ji" / "रमेश जी" / "Ramesh Bhai" be **suggested** as the same person (you confirm), or merged automatically? | Automatic merging can join two different people | Suggest only; you confirm each merge |
| 9 | Should members (not manager) see customers' phone numbers? | Today anyone who sees Outstanding sees the phone on old-app bills | Yes, as today; if no, phones move to a manager-only doc (+1 read on reminders) |
| 10 | Is a Hindi name per party wanted, or is one name (in whatever script you type) enough? | Extra field on create | Optional Hindi name, suggested automatically |
| 11 | Wholesale dues on Outstanding (#125) | Parties work either way; a merged party's wholesale and retail dues stay on their pages | Unchanged until #125 is answered |
