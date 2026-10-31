# Architecture: layers, calculation map and migration plan

Status: Phase 0 (review + ratchet), 31 Oct 2026, `main` at `ca6f2ba`.
Owner's goal: core logic decoupled from the UI, and every calculation in one
place where it can be reviewed. This page says where we are, where we are going,
which function owns each number in [calculations.md](calculations.md), and the
order of the refactor PRs. The ratchet test
`www/js/__tests__/architecture-guard.test.js` stops things getting worse
meanwhile (section 6).

## 1. Layers today

```
templates/*.html  ── 297 inline onclick="window.app.*" handlers
     │
main.js           ── wires every module onto window.app
     │
modules/*.js      ── 24 page modules (~19k lines) and rentals/rentals.js:
(pages)              read the DOM, apply rules, do arithmetic, call Firestore,
                     write AppState, call other pages through window.app
     │        ╲
     │         utils/*.js  ── pure calculation, mostly tested by the oracle:
     │                        money, business-metrics, finance-calc, labour,
     │                        dates, stock-replay, due-payments, cash-session,
     │                        aging, statements, bill-checks, number-checks,
     │                        rate-trends, item-rate-series, product-traffic,
     │                        month-snapshots; rentals/rent-math, rent-views,
     │                        rent-public
     │
firebase/firestore-service.js ── 3,859 lines / 173 KB: listeners, retries,
                     cache, transactions, stock checkpoint, month snapshots,
                     notifications, and it re-renders pages via window.app
                     (VIEWS table, firestore-service.js:149-160)
utils/state.js    ── AppState: one global mutable object, written by 8 page
                     modules (43 lines, mostly settings.js / stock.js / items.js)
```

What is already right: Money, Insights and Statements take every figure from
`utils/business-metrics.js` (M*, I*, ST*), with one home per figure
(`utils/metric-registry.js`) and an independent oracle (`tests/oracle/`). Rentals
maths is pure (`rent-math`, `rent-views`, `rent-public`). The weak parts are the
bill forms (purchase, retail, wholesale), Today, the cash drawer, Stock and
History, which still calculate inside the page.

## 2. Target layers

```
UI (pages, presenters)   modules/*.js, rentals/rentals.js, ui/*.js, templates
   │  reads inputs, calls a service, renders a view-model
   ▼
services (use cases)     services/bills.js, payments.js, cash.js, stock.js, rent.js
   │  saveBill, editBill, recordPayment, writeOff, openDay, closeDay,
   │  adjustStock, moveTenant, issueReceipt; update AppState through the store
   ▼                ▼
calc (domain, pure)      repositories                  infrastructure
utils/money.js           firebase/repos/<collection>   firebase client, realtime
utils/business-metrics   (only place that calls        coordinator, retry, cache,
utils/labour, dates      Firestore; env prefix,        read meter, offline queue
utils/calc/*.js (new)    transactions)
rentals/rent-math.js
```

Dependencies point down only. calc imports nothing but calc (no DOM, no
Firestore, no AppState, no `Date.now()`: "now" is a parameter).
No build step and no renames: existing util files keep their names (inline
handlers, Stryker and the oracle import them by path); new calculation files go
in `www/js/utils/calc/`.

### Dependency rules

| Rule | Checked by |
|---|---|
| UI never does arithmetic on money or quantity (no `Math.round(qty * rate)`, no `reduce` of amounts, no `a - b` of amounts). | ratchet `moneyMath` |
| UI never reads a number back from the screen (`Number(el.textContent)`, `Helpers.getElementInt`); it recomputes from data. | ratchet `domNumber` |
| UI never calls Firestore (`.collection(`, `db.doc(`, `runTransaction`, `batch`); it calls a service or repository. | ratchet `firestore`, review rule FirebaseService bypass |
| UI never assigns `AppState.<x>` or mutates its arrays; services update state. | ratchet `appStateWrite` |
| Calendar arithmetic only in `utils/dates.js` (or calc that imports it). | ratchet `dateMath` |
| Every displayed number comes from a function in `www/js/utils/calc/` or `business-metrics` / `money` / `labour` / `dates` / `rent-math`, with a spec ID in calculations.md and an oracle test. | review (`displayed-number-spec`), oracle, `metric-registry.test.js` |
| One rounding rule per quantity, applied in calc: line totals, bill totals, payments, stock values (owner decision pending, see F-R1). | oracle + property tests |
| Pages talk to other pages through events or a service, not `window.app.x.y()`. | review (Phase 6) |

## 3. Calculation map: every spec ID and its owner

"Today" is where the number is computed on `main`; "Target" is its owner after
the migration. **Inline** = computed inside a page module.

| Spec IDs | Today | Target |
|---|---|---|
| BILL-TOTAL | `money.billTotal`; re-implemented with other field orders in day.js:155-165 and history.js:759, 770, 776 | `money.billTotal` only |
| BILL-PAY | `money.readPayment` | same |
| BILL-AT-SAVE | `due-payments.saleTimePayment` | same |
| BILL-DUE | `money.outstandingDue`; second rule `money.wholesaleOutstanding` (wholesale-sales.js:718, 727) | `money.outstandingDue` only |
| DUE-PAY | `due-payments.dueEvents`, `sumDueEvents`, `entryParts`, `legParts` | same |
| EXP-KIND | inline in 5 places, two rules: day.js:169 and cash-management.js:354 (`category‖type`, any case); business-metrics.js:266, finance-calc.js:354, statements.js:52 (`category === 'personal'`) | `money.expenseKind(e)` (new) |
| DAY | `dates.startOfLocalDay`, `endOfLocalDayExclusive`, `todayLocalISO`; inline in day.js:126, cash-management.js:320, statements.js:216, 334 | `dates.*` only |
| PERIOD | `business-metrics.periodRange` (+ `insights-config`) | same |
| AVG-COST | `stock-replay.replayEvents` / `computeStock` | same |
| COGS | `finance-calc.computeFinanceSummary` (via `replayWithValues`) | same |
| OPENING | `money.isOpeningRecord`, `activityBills` | same |
| BILL-COUNT | `business-metrics.billCount`; Today counts with `.length` (day.js:248, 250) | `billCount` |
| BILL-TIME | `business-metrics.billTime`, `recordTime`; copy in `anomalies.billTime` | `business-metrics.billTime` |
| CMP | `business-metrics.comparisonRanges`, `change` | same |
| PARTY | `aging.normalizePartyName`, `pickPartyName`; identical copy `due-payments.normalizeParty` | one of them, the other re-exports |
| MONEY-TEXT | `money.formatRupees` / `formatAmount`; pages also print raw `₹${x}` (cash-management.js:619-694) and `Math.round` | `money.formatRupees` |
| DATE-TEXT | `dates.formatDay`, `formatDayTime` | same |
| T1, T2, T4, T5, T6, T7, T8, T9, T10, T11, T12, T15, T16 | inline `DayManager.loadTodayData` (day.js:122-300) on top of `saleTimePayment`, `outstandingDue` | `calc/today.todaySummary(src, day)` (new) |
| T13, T14 | `due-payments.dueEvents` + `sumDueEvents` (called from day.js:225) | inside `todaySummary` |
| T3, T-LAB-1, T-LAB-2, T-LAB-3 | `labour.labourSummary` | same |
| F1, F2, F3, F4, F5, F6, F7, F8, F9, F10, F11 (retired page) | `finance-calc.computeFinanceSummary` | same (engine of M*) |
| F12 | open (#39); superseded by M15 | — |
| R1, R2, R3, R4, R5, R6, R7, R8, A1, A2, A3, A4, A5, A6, A7 (retired pages) | no screen; same figures as F*/M* (`finance-calc`, `business-metrics`) | keep as aliases of M* or drop |
| O1, O2 | `aging.buildAging` over `money.readPayment` (outstanding.js:274) | same |
| O3, O4 | `business-metrics.outstandingTotals` (Money); `buildAging` totals (Outstanding) | `outstandingTotals` |
| S1, S2 | `stock-replay.computeStock` (via `FirebaseService.calculateStock`); stock.js:150-193 re-derives per-item rate when merging keys | `stock-replay` + `calc/stock-value` (new) |
| S3 | inline stock.js:257, 583 (`quantity × rate`) | `calc/stock-value.itemValue` |
| S4 | `business-metrics.moneySummary().stockNow` (finance-calc `stateValue`); registry home `stock.html` renders no total | same; tag it on its home |
| C1, C2, C3, C4, C5, C6 | inline `CashManagementManager.calculateTransactionsForDate` (cash-management.js:317-361) + `dueEvents` | `calc/cash.drawerDay` (new) |
| C7 | `cash-session.sessionTotals` | same (`calc/cash` re-exports) |
| C8 | inline cash-management.js:766 and the status card (~600-628) | `calc/cash.difference` |
| C9 | `cash-session.lastCountedSession` | same |
| RT-WEEK, RT-MONTH | `rate-trends.istWeekStart` / `weekKey`, `istMonthKey` | same (or `dates`) |
| RT-LINE, RT1, RT4 | `rate-trends.lineKg`, `lineRate`, `aggregateBills`, `sectionAvg` | same |
| RT2, RT-CUT | `item-rate-series.itemRateSeries`, `dailyRates`, `cutoffMonth` / `cutoffWeek` | same |
| RT3 | `rate-trends.trendRows` | same |
| RT5 | `rate-trends.seasonalOutlookCombined` | same |
| PT1, PT2, PT3, PT4 | `product-traffic.trafficRows`, `pctChange`, `dailyTraffic`, `weeklyItemRows` | same |
| RENT-1, RENT-2, RENT-3, RENT-4 | `rent-math.monthSummary` | same |
| RENT-5 | `rent-math.leaseDues`, `chargeStatus` | same |
| RENT-6 | `rent-math.increaseDue` | same |
| RENT-7 | `rent-math.meterBill`, `applyMeter`; partial re-check in rentals.js:792-794 | `rent-math` only |
| RENT-8 | `rent-public.publicMonth`, `buildPublicSnapshot` | same |
| RENT-9, RENT-10 | `rent-views.unitRows`, `summarize`, `propertySummaries` (re-sums charges, rent-views.js:33-40) | `rent-views` on `rent-math.monthSummary` |
| RENT-11 | `rent-math.firstMonthRent` | same |
| RENT-12 | `rent-receipt.js` (`paidEarlier`, …), counter `rent-store.nextSeq` | `rent-math` (amounts) + receipt repository |
| RENT-13 | `rent-unit.moveMonthRent`, `oldMonth` (pure, but in a UI file) | `rent-math` |
| ST1, ST3, ST4, ST5 | `statements.dayBook`, `partyLedger`, `itemLedger`, `exportLines` / `toCsv` | same |
| ST2 | `business-metrics.moneySummary` for one month (modules/statements.js) | same |
| M1, M2, M3, M4, M5, M6, M7, M8, M9, M10, M12, M13, M14, M16, M17 | `business-metrics.moneySummary` | same |
| M11 | `business-metrics.profitPerDay` + `month-snapshots.figuresFromSnapshot` | same |
| M15 | `business-metrics.netWorth`; accounts term summed inline (modules/money.js:594) | `netWorth` + `calc` accounts total |
| M18 | `labour.labourToPayByDay` | same |
| I1, I2 | `business-metrics.itemSummary` | same |
| I3, I4 | `business-metrics.partySummary`, `stoppedComingCheck` | same |
| I5 | `business-metrics.seasonIndex` (kg per month summed in insights.js:454) | same, sum moved in |
| I6 | `business-metrics.biggestChange` | same |
| I7 | `business-metrics.lowProfitItems` | same |
| I8 | `business-metrics.belowCostSales` | same |
| I9 | `business-metrics.stockUpItems` | same |
| I10 | `business-metrics.overdueParties` | same |
| I11 | `business-metrics.purchaseItems` | same |
| AC1, AC8 | `number-checks.checkStock` | same |
| AC2, AC3, AC4, AC5, AC6 | `number-checks.checkBillSplit`, `checkPayments`, `checkDates`, `checkDueFields`, `checkDrawer` | same |
| AC7, AC9, AC10, AC11, AC12, AC14 | tests only (`tests/property`, `tests/oracle`); AC10 also inline in modules/money.js:650 | tests + `number-checks` |
| AC13 | `metric-registry.registryProblems` | same |

Numbers on screen with **no spec ID** today (add one when they move): wholesale
live profit / margin (`money.computeWholesaleTotals`, shown at
wholesale-sales.js:286-287), stock adjustment value (stock.js:754), Insights
top-5 share (insights.js:377-381), Today item cards' average rate
(day.js:339-361), bill-form draft totals before save (purchase, retail,
wholesale).

## 4. Verified findings (review of 31 Oct 2026)

Each claim of the combined review checked against `main` `ca6f2ba`.
✅ confirmed, ◐ partly (corrected), ❌ wrong.

### Maths targets

| # | Claim | Verdict | Corrected evidence |
|---|---|---|---|
| 1 | purchase.js:113-199, 296-419, 724 | ◐ | Line total `Math.round(qty * rate)` :199 and weight sums :113, :198 confirmed. Totals already come from `money.computePurchaseTotals` (`computeTotals`, purchase.js:363-370 → money.js:248); remaining page maths: auto labour `laborRate × heavy` :386, `grandTotal = billTotal − labour` :415, `Math.round` display :296, :419, :435, payment prefill :484-496, share total :724. |
| 2 | retail-sale.js:189-206, 298-376, 445-466 | ✅ | :189, :206 line; :371 plain `reduce` total (the save path uses `sumMoney`, :725); prefill `Math.round` :454-466. |
| 3 | wholesale-sales.js:215-287, 559 | ◐ | :215 line `Math.round` and :559 share total confirmed. Total / cost / profit / margin are already pure in `money.computeWholesaleTotals` (money.js:270); the page only rounds for display (:267, :286). Missed: :561 reads the profit back from the screen (`Helpers.getElementInt('salesProfitAmount')`). |
| 4 | day.js:154-196, 231-240, 339-369 | ✅ | T1/T2 with their own field order :154-165; EXP-KIND inline :169-178; kg :186-198; in/out :231-244; item cards :339-361. |
| 5 | stock.js:480-511, 754-765 | ◐ | :480 is the dead-stock total (rows from `utils/dead-stock`), not S4. :754 adjustment value confirmed (no spec ID). Missed: stock.js:150-193 re-derives the per-item average rate when merging keys, and :257, :583 compute `quantity × rate` (S3). |
| 6 | outstanding.js:211, 892 | ✅ | :211 `new Date()` for display ages; :892 write-off accumulates `payment.writtenOff` inside the page's transaction (no `applyWriteOff` in utils yet). |
| 7 | history.js:145-150 reads billTotal from DOM | ◐ | True, history.js:146 `Number(document.getElementById("billTotal").textContent)`, but `HistoryManager.saveBillToHistory` (:139) is **dead**: wired as `window.app.history.saveBillToHistory` (main.js:1060) and called by nothing. The live purchase save is `PurchaseManager._saveBill` (purchase.js:576, totals from the items). Also dead: `viewRetailSale` (:532), which shows `saleTotal ‖ amountReceivable` (:600) that current retail bills don't store (they save `total`, retail-sale.js:545). Live `viewBill` (:759, :770, :776) uses three field orders that differ from `money.billTotal`. Action: delete the dead code; give viewBill a view-model. |
| 8 | insights.js:232-335, 377-381, 454, 112-119, 414, 492-497 | ✅ | All present; :112-120 month step is a copy of modules/money.js:167-176. |
| 9 | money.js (module):168-175, 498-501, 594, 650 | ✅ | Step copy, day loop, accounts sum (M15 term), AC10 check sum. |
| 10 | cash-management.js:320, 627-875 (difference/shortfall, no spec ID) | ◐ | :320 manual end of day confirmed (`dates.endOfLocalDayExclusive` exists). Expected cash is already pure (`cash-session.sessionTotals`, :653, :678). The difference **has** a spec ID (C8); it is computed inline at :766 and in the status card (~:612). C1–C6 are summed inline in `calculateTransactionsForDate` :317-361. |
| 11 | rent-unit.js:28; rent-views.js:33-40 | ◐ | `moveMonthRent` (RENT-13) is already a pure exported function, but in a UI file that imports `UIManager`: move it to rent-math. rent-views.js:33-40 repeats `rent-math.monthSummary`'s sums per unit with the same rounding; they agree; rent-views is itself pure. |

### Duplicated figures: can they disagree?

| Family | Verdict | Can disagree? |
|---|---|---|
| Line totals | ✅ purchase.js:199, retail-sale.js:206, wholesale-sales.js:215 (`Math.round`), money.js:232 (`round2` when a line has no total), stock-replay.js:174 (`qty × rate`, unrounded) | **Yes.** 12.4 kg × ₹33.50 = 415.40: the bill line stores ₹415, the stock replay adds ₹415.40, so M16's line value and M17 / AC1's "purchases at line rate" differ by ₹0.40 per such line. |
| Bill total vs payment (Math.round vs round2) | ✅ purchase.js:419, :484-496 vs money.js:258 | **Yes.** Lines ₹1,000, labour typed ₹12.50: saved `grandTotal` = ₹987.50 (`round2`), but the screen shows ₹988 and the Cash tick fills ₹988. `checkPaymentSplit` passes (−0.50 is within ₹1), so the bill is saved with cash ₹988 on a ₹987.50 total: Today T8 / M13 count ₹988 out, M16 counts ₹987.50. |
| Sale totals | ✅ retail-sale.js:371 (plain `reduce`), :725 (`sumMoney`), day.js:158-165, `money.billTotal` | Field order: a legacy purchase with `billTotal` 1,000 and `total` 970 (no `grandTotal`) is ₹1,000 in Today T1 (day.js:155) and ₹970 in Money M16 (`billTotal()` reads `total` first). |
| Outstanding due | ✅ `money.wholesaleOutstanding` vs `money.outstandingDue` | **Yes.** A legacy wholesale sale with no `payment` object, `total` 1,000, `cashPayment` 700, `dueAmount` 300: Wholesale › Outstanding shows ₹1,000, Outstanding / Money show ₹300. Also `payment.due` 0 with received < total (within the ₹1 split tolerance) shows the gap on Wholesale only. |
| EXP-KIND (new) | 5 copies, 2 rules (see map) | **Yes.** An expense with `type: 'personal'` and no `category`, or `category: 'Personal'`: Today T5 and the drawer count it personal; Money M4/M8, Statements and finance-calc count it business. |
| Profit / margin | ◐ live profit is pure (`computeWholesaleTotals`, current average rate from `AppState.stock`) | Differs from I1/M6 (AVG-COST at the moment of sale) once an earlier-dated record is saved later. No spec ID. |
| Stock value | ✅ stock.js:159-191, 257, 583 vs `stock-replay` / `moneySummary().stockNow` | Same inputs today; two code paths. |
| Rent totals | ◐ rent-views.js:33-40 vs `rent-math.monthSummary` | Agree (same rounding). |
| Other copies found | `checkPaymentSplit` exists twice with different signatures (money.js:292, due-payments.js:194); `normalizeParty` = `normalizePartyName` (due-payments.js:28, aging.js:54); `istDayKey` (anomalies.js:103, rate-trends.js:52); month step (insights / money) | Identical today; one copy should go. |

"No spec ID" list: wholesale live profit / margin ✅, stock adjustment value ✅,
Insights top-5 ✅, history legacy totals ◐ (BILL-TOTAL exists; history doesn't
call `billTotal()`), cash-session difference / shortfall ❌ (C8; the bands are
`evaluateCashCount`'s thresholds).

### Coupling

| Claim | Verdict | Evidence |
|---|---|---|
| firestore-service.js is a god data layer that calls UI | ✅ | 3,859 lines / 173 KB; `VIEWS` re-renders pages via `window.app` (:149-160). |
| Direct Firestore in UI: billing.js (231 … 804), cash-management.js:50, outstanding.js:763, rent-store.js:35 | ✅ | billing.js has 11 lines (also :668); cash-management.js :50, :271, :730; outstanding.js :670, :763, :879; rent-store.js 12 (it is the rentals repository), rent-receipt-store.js :46, :67. Outside pages: `Helpers.generateBillNumber` (helpers.js:303-307), telemetry.js:438. |
| UI mutates AppState: billing.js:1154-1216, 1261-1268; cash-management 177-178, 336-350, 742-832 | ◐ | billing.js :1155, :1216, :1261 ✅. cash-management ❌: those lines only **read** AppState. Real writers: settings.js 19 lines, stock.js 8, items.js 6, billing.js 3, history.js 3, roles-access.js 2, outstanding.js 1, miscellaneous.js 1. |
| Cross-module `window.app` calls, inline handlers, templates/day.html:45 | ✅ | billing.js:1264-1268; 297 inline `onclick=`; day.html:45 inline keydown logic. |
| Rules inside UI handlers | ◐ | `validateSignOut` (cash-management.js:763) composes `evaluateCashCount` (utils/bill-checks.js:443) and computes C8 inline. rentals.js:792-794 re-checks only "not negative"; `meterBill` (rent-math.js:268-275) owns the full rule. Payment-split tick / "rest in Due" logic is triplicated: purchase.js:445-500, retail-sale.js:414-470, wholesale-sales.js:295-345. |

### Design risks checked

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | Offline blind `set()` for initial bill saves; two phones overwrite each other | ◐ | `saveBill` (firestore-service.js:774-823) does a whole-doc `set()`, but on a fresh client-made id (:779), so two phones never share an id. Retries go through `retryBillSave` (transaction, keeps server money fields, :846-891) and edits through `updateBillChecked` (transaction, conflict check, :899). Remaining risk: offline item / settings / user writes (#113). |
| 7 | Rounding not enforced at storage | ✅ | Line totals whole rupees, bill totals and payments `round2`, stock values unrounded (examples above). #129. |
| 10 | Bill-number counters transactional? | ✅ | Online: `Helpers.generateBillNumber` → `_nextCounterValue`, a `runTransaction` on `counters/{P|S|W}{YYYYMMDD}` (helpers.js:293-330, 409-430), seeded once from today's bill count. Offline or after 2.5 s: a device-scoped `{prefix}{date}-{device}-{seq}` (`nextOfflineBillNumber`, :363) that cannot equal an online number. A transaction that times out on the phone but commits leaves a gap, never a duplicate; `findDuplicateBillNumbers` flags any collision. Rent receipts: `rent-store.nextSeq` inside the payment transaction (rent-store.js:418-434). |
| 14-16 | Unbounded reads (telemetry.js:438-445) | ✅ | Clearing telemetry reads the whole collection. #159. |
| 2-6, 8-9, 11-13, 17-20 | | not re-checked | Tracked by #126, #102, #64, #65, #87, #98, #103, #124, #174, #153, #161, #119, #122, #59, #66. |

Score: 31 claims checked (11 maths targets, 6 duplicate families, 5 "no spec
ID", 5 coupling, 4 design): 18 ✅, 12 ◐, 1 ❌ (the cash difference has a spec ID,
C8). Inside the ◐ rows the main corrections are: cash-management never writes
AppState; history.js's DOM read is in dead code; wholesale profit and the cash
expected figure are already pure; bill counters are transactional.

## 5. Migration plan

Rules for every refactor PR:

1. **Characterise first.** Before moving code, pin today's output: a jsdom test of
   the page (DOM text and the saved document, rounding included) or an oracle
   case. Merge it on its own if the move is large.
2. **Move, don't change.** Code moves verbatim into a calc function; the page
   calls it. The PR changes no number on screen, so the oracle
   (`tests/oracle/screens.test.js`), the property checks (`tests/property/`), the
   E2E every-page smoke and `npm run audit:numbers` on a real backup must give
   the same result before and after (compare `NUMBER-AUDIT.md`).
3. **Lower the ratchet** in the same PR (`ARCH_BASELINE=lower npx jest
   architecture-guard`).
4. **Fixes are separate PRs.** The disagreements in section 4 (EXP-KIND,
   wholesale due, BILL-TOTAL order, labour rounding) are bugs: each gets an issue,
   an oracle fixture (skipped with `// BUG: see #N` until fixed) and its own PR.
   A rounding change waits for the owner's decision (F-R1: whole-rupee lines vs
   paise, #129).
5. A shipped `www/` change needs the cache bump (AGENTS.md section 4).

Order (S/M/L = size; ⚠ = conflicts with in-flight work, wait for it to merge):

| Phase | PR | Size | Conflicts |
|---|---|---|---|
| 0 | This PR: doc, ratchet, baseline | S | none |
| 1 | Characterisation tests: bill forms (draft totals, labour, prefill, split), Today item cards, cash drawer C1–C8, history viewBill; BUG fixtures for the 4 disagreements | M | tests only; rebase on #181 |
| 2a | Delete dead `HistoryManager.saveBillToHistory` / `viewRetailSale` (+ main.js wiring) | S | main.js cache lines only |
| 2b | `calc/today.todaySummary` (T1–T16) out of day.js | M | none (day.js not in flight) |
| 2c | Periods: month step, day loops and day ends into `dates.js` (insights, money, statements, cash :320, day :126) | S | ⚠ modules/money.js, cash-management.js (#181) |
| 2d | History `viewBill` view-model on `billTotal` / `readPayment` | S | none |
| 2e | Insights top-5 share and per-₹100 into business-metrics with spec IDs | S | none |
| 2f | `calc/billing`: `lineTotal`, draft totals, labour, payment prefill / rest-in-Due (one copy for purchase / retail / wholesale) | M | ⚠ purchase / retail / wholesale save handlers, #181 |
| 2g | `calc/cash.drawerDay` (C1–C6, C8) out of cash-management | M | ⚠ #181, cash save handlers, offline cash close (#143) |
| 2h | `calc/stock-value` (S2/S3 consolidation, adjustment value) out of stock.js | S | ⚠ #181 (stock.js) |
| 2i | Rentals: `moveMonthRent` / `oldMonth` into rent-math; rent-views on `monthSummary` | S | ⚠ #181 (rentals.js) |
| 2j | Bug fixes from section 4, one PR each after the owner answers | S each | ⚠ wholesale-sales / cash / expenses work |
| 3 | Services: `bills` (save/edit/delete), `payments` (record, write-off: outstanding.js:670-900), `cash` (open/close), `stock` (adjust), `rent` | L | ⚠ every save handler, #181, offline |
| 4 | Repositories: drafts / autosave / itemFrequency (billing.js 11 sites), cash sessions, bill refs, counters, rentals (rent-store, rent-receipt-store) under `firebase/repos/` | M each | ⚠ offline, security (#64 rules) |
| 5 | Split firestore-service: realtime coordinator, retry, cache, checkpoint, snapshots, notifications; replace `VIEWS` / `window.app` with change events | L | ⚠ offline |
| 6 | AppState store API (`setStock`, `upsertItem`, `setSettings`); settings.js first | M | ⚠ printer #180 (settings.js), security |
| 7 | Inline handlers → delegated listeners; prove the layering with one alternative UI | L | later |

## 6. The ratchet

`www/js/__tests__/architecture-guard.test.js` parses `www/js/modules/**` and
`www/js/rentals/**` (not `rent-math`, `rent-views`, `rent-public`) with acorn and
counts, per file, the source lines that break a rule: `firestore`, `moneyMath`,
`domNumber`, `appStateWrite`, `dateMath` (the exact heuristics are in the test's
header). `tests/architecture-baseline.json` holds the counts on `main`:

| Category | Lines on `ca6f2ba` |
|---|---|
| firestore | 31 |
| moneyMath | 151 |
| domNumber | 2 |
| appStateWrite | 43 |
| dateMath | 20 |

- A count that goes **up**, or a new file with any count, fails the test with the
  file and category.
- A count that goes **down** passes and prints what to lower;
  `ARCH_BASELINE=lower npx jest architecture-guard` rewrites the baseline (it
  never raises a number).
- Raising a number by hand (or `ARCH_BASELINE=reset`) is for a reviewed
  exception only; say why in the PR.
- It is a heuristic: it misses maths on names without a money word
  (rent-unit.js:28 `full × days`) and writes through an alias, and it counts some
  harmless lines (`totalDocs += count`). Treat it as a floor, not proof.
