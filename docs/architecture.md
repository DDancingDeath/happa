# Architecture: layers, calculation map and migration plan

Status: Phase 0 (review + ratchet), 31 Oct 2026, `main` at `ca6f2ba`; phases 2a–2i (calc) and
4 (repositories: no Firestore call outside the data layer, which emits events
instead of calling pages) done since.
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
(pages)              read the DOM, apply rules, write AppState, call other pages
                     through window.app; Firestore only through FirebaseService or
                     a repository (phase 4), redraw on data events (utils/events.js)
     │        ╲
     │         utils/*.js  ── pure calculation, mostly tested by the oracle:
     │                        money, business-metrics, finance-calc, labour,
     │                        dates, stock-replay, due-payments, cash-session,
     │                        aging, statements, bill-checks, number-checks,
     │                        rate-trends, item-rate-series, product-traffic,
     │                        month-snapshots; rentals/rent-math, rent-views,
     │                        rent-public
     │
firebase/firestore-service.js ── ~4,000 lines / 180 KB: listeners, retries,
                     cache, transactions, stock checkpoint, month marks,
                     notifications; says which views' data changed by emitting
                     `refresh:<view>` / `itemFrequency:changed` (utils/events.js),
                     never calls a page (phase 4)
firebase/db.js    ── getDb, col (env prefix), CLIENT_VERSION and the write stamp
                     shared by the data layer (phase 5)
firebase/repos/*.js ── repositories (phase 4): bill-drafts (drafts, auto-save,
                     item order), bill-payments (due-payment / write-off
                     transactions), cash-sessions, counters, users, audit-logs,
                     telemetry; phase 5 moves FirebaseService methods out of
                     firestore-service.js into method objects it spreads in
                     (same FirebaseService API): items, bill-stats (rate stats,
                     month snapshots), collection-admin, tip-health, anomalies.
                     Rentals: rentals/rent-store.js and
                     rent-receipt-store.js (loaded only with Rentals)
utils/state.js    ── AppState: one global mutable object, written in 83 lines of
                     12 files (firestore-service 25, settings.js 19, stock.js 8, …)
```

What is already right: Money, Insights and Statements take every figure from
`utils/business-metrics.js` (M*, I*, ST*), with one home per figure
(`utils/metric-registry.js`) and an independent oracle (`tests/oracle/`). Rentals
maths is pure (`rent-math`, `rent-views`, `rent-public`). Today (`calc/today`,
#185) and the bill forms (purchase, retail, wholesale: `calc/billing`, #189),
Stock (`calc/stock`, #190) and the cash drawer (`calc/cash`, phase 2g) now only
render calc results. The weak part left is History, which still calculates
inside the page.

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
| UI never does arithmetic on money or quantity (no `Math.round(qty * rate)`, no `reduce` of amounts, no `a - b` of amounts); only calc (`utils/`, pure rentals files) does. | ratchet `moneyMath` (all of www/js except calc) |
| UI never reads a number back from the screen (`Number(el.textContent)`, `Helpers.getElementInt`); it recomputes from data. | ratchet `domNumber` (everywhere, calc included) |
| UI never calls Firestore (`.collection(`, `db.doc(`, `runTransaction`, `batch`, `where`, `onSnapshot`, transaction / batch operations, `firebase.firestore.FieldValue`); it calls a service or repository and gets plain data back. Only the repositories (`firebase/**`, `rentals/rent-store.js`, `rentals/rent-receipt-store.js`) talk to Firestore; each owns its collection names (env prefix), queries, transactions and offline patterns. | ratchet `firestore`: absolute 0 outside the repositories, no baseline entry allowed (phase 4); review rule FirebaseService bypass |
| The data layer never calls a page: it emits events (`utils/events.js`: `refresh:<view>`, `itemFrequency:changed`) and pages subscribe (`on(REFRESH.x, …)`; the lazy Money / Insights / Statements through their loaders in main.js). | `data-events.test.js` (no `window.app` in firebase/, every event has a subscriber, each page method) |
| UI never assigns `AppState.<x>` or mutates its arrays; services update state through a store API. | ratchet `appStateWrite` (everywhere; today's writers are baselined) |
| Calendar arithmetic only in `utils/dates.js` (or calc that imports it). | ratchet `dateMath` (all but calc) |
| Every displayed number comes from a function in `www/js/utils/calc/` or `business-metrics` / `money` / `labour` / `dates` / `rent-math`, with a spec ID in calculations.md and an oracle test. | review (`displayed-number-spec`), oracle, `metric-registry.test.js` |
| One rounding rule per quantity, applied in calc (F-R1, resolved by #129: rates keep paise; money amounts are whole rupees, half-up; stock values at saved line totals). One switch, `ROUNDING` in `utils/calc/billing.js`; calculations.md MONEY-ROUND. | oracle (`billForm`, `stockReplay`) + property tests, `rounding.test.js` |
| Pages talk to other pages through events or a service, not `window.app.x.y()`. | review (Phase 6) |

## 3. Calculation map: every spec ID and its owner

"Today" is where the number is computed on `main`; "Target" is its owner after
the migration. **Inline** = computed inside a page module.

| Spec IDs | Today | Target |
|---|---|---|
| BILL-TOTAL | `money.billTotal` (first field present, 0 counts) everywhere: Today, History, receipts, bill rows, duplicate check (#186) | same |
| BILL-PAY | `money.readPayment` (also History chips / bill details and the receipt, #186) | same |
| BILL-AT-SAVE | `due-payments.saleTimePayment` | same |
| BILL-DUE | `money.outstandingDue` everywhere, incl. Wholesale › Outstanding, `openDue`, History, receipts (#186); `wholesaleOutstanding` only in tools/migrate (old app's page rule) | same |
| DUE-PAY | `due-payments.dueEvents`, `sumDueEvents`, `entryParts`, `legParts` | same |
| EXP-KIND | `money.isPersonalExpense(e)` everywhere: Today, drawer, Money, Statements, finance-calc, Expenses lists (#186) | same |
| EXP-MODE | `money.expenseMode` / `isOnlineExpense` (#118): Today T8 / T9 (`calc/today`), drawer C3 (`calc/cash.drawerDay`), Money M13 (`business-metrics`, online total from `finance-calc`), Statements ST1; day-doc online flags `personal-expenses.dayDocTotals` / `personalOnlineFromRows`; the form's day and mode rules `expense-entry.validateExpenseEntry`, `expenseDayRange`, `expenseDateFields` | same |
| DAY | `dates.startOfLocalDay`, `endOfLocalDayExclusive`, `addLocalDays`, `localDayKeys`, `periodBounds`, `endUpToNow`, `todayLocalISO` (Money, Statements, Outstanding ages via `startOfLocalDay`); the drawer's day `calc/cash.dayBounds` (`parseLocalDate` + `endOfLocalDayExclusive`) | `dates.*` only |
| PERIOD | `business-metrics.periodRange` (+ `insights-config`); month steps `dates.monthStart`, `monthRange`, `addMonths`, `latestMonthStart` (Insights / Money ‹ ›, Statements month list, Insights calendar tap and "load older", Money last-year worth label) | same |
| AVG-COST | `stock-replay.replayEvents` / `computeStock` | same |
| COGS | `finance-calc.computeFinanceSummary` (via `replayWithValues`) | same |
| OPENING | `money.isOpeningRecord`, `activityBills` | same |
| VOID | `money.isActiveBill` / `activeBills` (in `activityBills`, `outstandingDue`, `due-payments.saleTimePayment` / `dueEvents`, `aging.buildAging`, `stock-replay.collectEvents` / `stockFingerprint`, `stock-check.firstStockTimes`, `statements.partyLedger` / `partyChoices`, rate trends, product traffic, dead stock, number checks); `FirebaseService.publishCollection` keeps voided bills out of AppState (`voidedBills()` for History); bill edit records `utils/bill-edits.js` (#75, #121) | same |
| BILL-COUNT | `business-metrics.billCount`; Today counts with `.length` (calc/today.js) | `billCount` |
| BILL-TIME | `business-metrics.billTime`, `recordTime`; copy in `anomalies.billTime` | `business-metrics.billTime` |
| CMP | `business-metrics.comparisonRanges`, `change` | same |
| PARTY | `aging.normalizePartyName`, `pickPartyName`; identical copy `due-payments.normalizeParty` | one of them, the other re-exports |
| MONEY-TEXT | `money.formatRupees` / `formatAmount`; pages also print raw `₹${x}` (cash-management.js:619-694) and `Math.round` | `money.formatRupees` |
| DATE-TEXT | `dates.formatDay`, `formatDayTime` | same |
| T1, T2, T4, T5, T6, T7, T8, T9, T10, T11, T12, T15, T16, T17 | `calc/today.todaySummary` (#185) on top of `saleTimePayment`, `outstandingDue`; day.js only renders | same |
| BF-KG, BF-LINE | `calc/billing.sumWeights`, `computeLine`, `weightsForEdit` (step 2f); purchase / retail / wholesale forms only render | same |
| BF-TOTAL | `calc/billing.computePurchaseTotals`, `computeRetailTotals`, `computeWholesaleTotals`, `draftLineSum` (moved from money.js) | same |
| BF-LAB, BF-PAYABLE | `calc/billing.autoLabour`, `computePurchaseTotals`, `payableOnScreen` | same |
| BF-PAID, BF-SPLIT, BF-FILL, BF-SAVE | `calc/billing.paidOnScreen`, `validatePaymentSplit` (was `money.checkPaymentSplit`), `prefillPayment`, `restInDue`, `paymentSplit`, `buildPaymentSplit`; one copy for the three forms (`Helpers.applyPaymentPrefill` writes the ticks) | same |
| WS-PROFIT, WS-MARGIN | `calc/billing.computeWholesaleTotals`, `wholesaleLiveProfit` (the WhatsApp draft no longer reads the profit back from the screen) | same |
| DUE-CHECK | `calc/billing.validateDuePayment` (was `due-payments.checkPaymentSplit`): Outstanding and Wholesale › Outstanding | same |
| T13, T14 | `due-payments.dueEvents` + `sumDueEvents`, inside `todaySummary` | same |
| T3, T-LAB-1, T-LAB-2, T-LAB-3 | `labour.labourSummary` | same |
| F1, F2, F3, F4, F5, F6, F7, F8, F9, F10, F11 (retired page) | `finance-calc.computeFinanceSummary` | same (engine of M*) |
| F12 | open (#39); superseded by M15 | — |
| R1, R2, R3, R4, R5, R6, R7, R8, A1, A2, A3, A4, A5, A6, A7 (retired pages) | no screen; same figures as F*/M* (`finance-calc`, `business-metrics`) | keep as aliases of M* or drop |
| O1, O2 | `aging.buildAging` over `money.readPayment` (outstanding.js:274) | same |
| O3, O4 | `business-metrics.outstandingTotals` (Money); `buildAging` totals (Outstanding) | `outstandingTotals` |
| S1, S2 | `stock-replay.computeStock` (via `FirebaseService.calculateStock`); merged onto the catalogue with the weighted rate by `calc/stock.stockRows` (rate via `stock-replay.finalizeStock`), adjustment form `calc/stock.adjustItemStock` | same |
| S3 | `calc/stock.itemValue` (Stock rows, `dead-stock.findDeadStock` rows) | same |
| S4 | `calc/stock.stockValue` (on the replay state through `stock-replay.stateValue`): `finance-calc` opening / closing / now → `moneySummary().stockNow` (M15 term, M17); registry home `stock.html` renders no total | same; tag it on its home |
| S5 | `calc/stock.adjustmentValue` (Stock › Adjustments card) | same |
| S6 | `calc/stock.deadStockValue` (= `stockValue` of the dead-stock rows) | same |
| C1, C2, C3, C4, C5, C6 | `calc/cash.drawerDay` (phase 2g; on `saleTimePayment`, `dueEvents`, `personalForDay`); `CashManagementManager.calculateTransactionsForDate` only gathers its inputs; "No bill" legs from `calc/cash.noBillLeg` | same |
| C7 | `cash-session.sessionTotals` through `calc/cash.expectedCash`; status card, sign-out summary and day details from `calc/cash.drawerStatus`, `signOutSummary`, `sessionDetail` | same |
| C8 | `calc/cash.difference` (shown), `savedDifference` (closing, late count), `countCheck` (count box: match within ₹1 + Q19 bands), `closeCheck` (confirm above ₹1, flags), `differenceBand` (colours), `openingCheck` (opening vs C9) | same |
| C9 | `cash-session.lastCountedSession` (`calc/cash` re-exports) | same |
| RT-WEEK, RT-MONTH | `rate-trends.istWeekStart` / `weekKey`, `istMonthKey` | same (or `dates`) |
| RT-LINE, RT1, RT4 | `rate-trends.lineKg`, `lineRate`, `aggregateBills`, `sectionAvg` | same |
| RT2, RT-CUT | `item-rate-series.itemRateSeries`, `dailyRates`, `cutoffMonth` / `cutoffWeek` | same |
| RT3 | `rate-trends.trendRows` | same |
| RT5 | `rate-trends.seasonalOutlookCombined` | same |
| PT1, PT2, PT3, PT4 | `product-traffic.trafficRows`, `pctChange`, `dailyTraffic`, `weeklyItemRows` | same |
| RENT-1, RENT-2, RENT-3, RENT-4 | `rent-math.rentTotals` | same |
| RENT-5 | `rent-math.leaseDues` (total from `rentTotals`), `chargeStatus` | same |
| RENT-6 | `rent-math.increaseDue` | same |
| RENT-7 | `rent-math.meterBill`, `applyMeter`; opening reading on a move-in `rent-math.moveInError` (same non-negative rule) | same |
| RENT-8 | `rent-public.publicMonth`, `buildPublicSnapshot` | same |
| RENT-9, RENT-10 | `rent-views.unitRows` (sums from `rent-math.rentTotals`), `summarize`, `propertySummaries` | same |
| RENT-11 | `rent-math.firstMonthRent` (`proRateRent`) | same |
| RENT-12 | `rent-math.receiptAmounts` (written by `rent-store.putReceipt`), `paidEarlier`; counter `rent-store.nextSeq`; `rent-receipt.js` only renders | `rent-math` (amounts) + receipt repository |
| RENT-13 | `rent-math.moveMonthRent`, `moveMonthSplit`, `oldMonth`, `changeUnitPlan` (`proRateRent`); rent-unit.js only shows and saves them | same |
| ST1, ST3, ST4, ST5 | `statements.dayBook`, `partyLedger`, `itemLedger`, `exportLines` / `toCsv` | same |
| ST2 | `business-metrics.moneySummary` for one month (modules/statements.js) | same |
| M1, M2, M3, M4, M5, M6, M7, M8, M9, M10, M12, M13, M14, M16, M17 | `business-metrics.moneySummary`; M14 per day (Money › Cash chart) `business-metrics.netMoneyByDay`; per-₹100 display rounding `roundTo` | same |
| M11 | `business-metrics.profitPerDay` + `month-snapshots.figuresFromSnapshot` | same |
| M15 | `business-metrics.netWorth`, accounts term `business-metrics.accountsTotal` | same |
| M18 | `labour.labourToPayByDay`; more / less than M7 `labour.periodLabourGap` | same |
| I1, I2 | `business-metrics.itemSummary`, split % `sharePct`; "vs last year" from snapshots `month-snapshots.snapshotItemSales` | same |
| I3, I4 | `business-metrics.partySummary`, `stoppedComingCheck` | same |
| I5 | `business-metrics.soldKgByMonth`, `seasonKgTotal`, `seasonIndex` | same |
| I6 | `business-metrics.biggestChange` | same |
| I7 | `business-metrics.lowProfitItems` | same |
| I8 | `business-metrics.belowCostSales` | same |
| I9 | `business-metrics.stockUpItems`, weekly kg `weeklyKgWindow`, `weeklyKgByItem` | same |
| I10 | `business-metrics.overdueParties` | same |
| I11 | `business-metrics.purchaseItems` | same |
| I12 | `business-metrics.topShare` (Insights › Parties takeaway) | same |
| AC1, AC8 | `number-checks.checkStock` | same |
| AC2, AC3, AC4, AC5, AC6 | `number-checks.checkBillSplit`, `checkPayments`, `checkDates`, `checkDueFields`, `checkDrawer` | same |
| AC7, AC9, AC10, AC11, AC12, AC14 | tests only (`tests/property`, `tests/oracle`); the AC10 / AC11 check line on Money and Insights uses `business-metrics.addsUp` | tests + `number-checks` |
| AC13 | `metric-registry.registryProblems` | same |

Numbers on screen with **no spec ID** today: none known. Wholesale live profit /
margin and the bill-form draft figures got theirs in step 2f (WS-PROFIT,
WS-MARGIN, BF-*); the stock adjustment value is now S5, the dead-stock total S6
and the Insights top-5 share I12.

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
| 7 | history.js:145-150 reads billTotal from DOM | ◐ | True, history.js:146 `Number(document.getElementById("billTotal").textContent)`, but `HistoryManager.saveBillToHistory` (:139) is **dead**: wired as `window.app.history.saveBillToHistory` (main.js:1060) and called by nothing. The live purchase save is `PurchaseManager._saveBill` (purchase.js:576, totals from the items). `viewRetailSale` (:532-609, with its `saleTotal ‖ amountReceivable` total at :600) is already commented out (`/* Removed … */`, history.js:531-610), so it is not live code; the comment block can go. Live `viewBill` (:759, :770, :776) uses three field orders that differ from `money.billTotal`. Action: delete `saveBillToHistory` and the commented-out block; give viewBill a view-model. |
| 8 | insights.js:232-335, 377-381, 454, 112-119, 414, 492-497 | ✅ | All present; :112-120 month step is a copy of modules/money.js:167-176. |
| 9 | money.js (module):168-175, 498-501, 594, 650 | ✅ | Step copy, day loop, accounts sum (M15 term), AC10 check sum. |
| 10 | cash-management.js:320, 627-875 (difference/shortfall, no spec ID) | ◐ | :320 manual end of day confirmed (`dates.endOfLocalDayExclusive` exists). Expected cash is already pure (`cash-session.sessionTotals`, :653, :678). The difference **has** a spec ID (C8); it is computed inline at :766 and in the status card (~:612). C1–C6 are summed inline in `calculateTransactionsForDate` :317-361. |
| 11 | rent-unit.js:28; rent-views.js:33-40 | ◐ | `moveMonthRent` (RENT-13) is already a pure exported function, but in a UI file that imports `UIManager`: move it to rent-math. rent-views.js:33-40 repeats `rent-math.monthSummary`'s sums per unit with the same rounding; they agree; rent-views is itself pure. Done in phase 2i (`rentTotals`, `moveMonthSplit`, `changeUnitPlan`). |

### Duplicated figures: can they disagree?

| Family | Verdict | Can disagree? |
|---|---|---|
| Line totals | ✅ purchase.js:199, retail-sale.js:206, wholesale-sales.js:215 (`Math.round`), money.js:232 (`round2` when a line has no total), stock-replay.js:174 (`qty × rate`, unrounded) | **Yes** (fixed by #129: the replay now adds the saved line amount). 12.4 kg × ₹33.50 = 415.40: the bill line stores ₹415, the stock replay added ₹415.40, so M16's line value and M17 / AC1's "purchases at line rate" differed by ₹0.40 per such line. |
| Bill total vs payment (Math.round vs round2) | ✅ purchase.js:419, :484-496 vs money.js:258 | **Yes** (fixed by #129: labour is saved as ₹13, payable ₹987 on screen, tick and bill). Lines ₹1,000, labour typed ₹12.50: saved `grandTotal` = ₹987.50 (`round2`), but the screen shows ₹988 and the Cash tick fills ₹988. `checkPaymentSplit` passes (−0.50 is within ₹1), so the bill is saved with cash ₹988 on a ₹987.50 total: Today T8 / M13 count ₹988 out, M16 counts ₹987.50. |
| Sale totals | ✅ retail-sale.js:371 (plain `reduce`), :725 (`sumMoney`), day.js:158-165, `money.billTotal` | Field order: a legacy purchase with `billTotal` 1,000 and `total` 970 (no `grandTotal`) is ₹1,000 in Today T1 (day.js:155) and ₹970 in Money M16 (`billTotal()` reads `total` first). |
| Outstanding due | ✅ `money.wholesaleOutstanding` vs `money.outstandingDue` | **Yes.** A legacy wholesale sale with no `payment` object, `total` 1,000, `cashPayment` 700, `dueAmount` 300: Wholesale › Outstanding shows ₹1,000, Outstanding / Money show ₹300. Also `payment.due` 0 with received < total (within the ₹1 split tolerance) shows the gap on Wholesale only. |
| EXP-KIND (new) | 4 copies, 2 rules (see map) | **Yes.** An expense with `type: 'personal'` and no `category`, or `category: 'Personal'`: Today T5 and the drawer count it personal; Money M4/M8, Statements and finance-calc count it business. |
| Profit / margin | ◐ live profit is pure (`computeWholesaleTotals`, current average rate from `AppState.stock`) | Differs from I1/M6 (AVG-COST at the moment of sale) once an earlier-dated record is saved later. No spec ID. |
| Stock value | ✅ stock.js:159-191, 257, 583 vs `stock-replay` / `moneySummary().stockNow` | Same inputs today; two code paths. |
| Rent totals | ◐ rent-views.js:33-40 vs `rent-math.monthSummary` | Agree (same rounding). One copy since phase 2i: `rent-math.rentTotals`. |
| Other copies found | `checkPaymentSplit` exists twice with different signatures (money.js:292, due-payments.js:194; since 2f `calc/billing.validatePaymentSplit` / `validateDuePayment`); `normalizeParty` = `normalizePartyName` (due-payments.js:28, aging.js:54); `istDayKey` (anomalies.js:103, rate-trends.js:52); month step (insights / money) | Identical today; one copy should go. |
| Found by the full-scope ratchet | firestore-service.js:1197-1198 repeats `wholesaleOutstanding`'s `payment.due ‖ total − received`; main.js:527-695 (`debugStockForName`) re-implements AVG-COST; services/printer.js:350-431 recomputes payable (its own field order, then `subtotal − labour`), received and due for the receipt, with `‖` so `payment.cash: 0` falls back to the top-level `cashPayment` (`readPayment` keeps the 0) | The first disagrees with BILL-DUE as above; the receipt rounds to the rupee (₹988 for the ₹987.50 bill above) and can show a stale cash figure. |

"No spec ID" list: wholesale live profit / margin ✅, stock adjustment value ✅,
Insights top-5 ✅, history legacy totals ◐ (BILL-TOTAL exists; history doesn't
call `billTotal()`), cash-session difference / shortfall ❌ (C8; the bands are
`evaluateCashCount`'s thresholds).

### Coupling

| Claim | Verdict | Evidence |
|---|---|---|
| firestore-service.js is a god data layer that calls UI | ✅ | 3,859 lines / 173 KB; `VIEWS` re-renders pages via `window.app` (:149-160). **Phase 4:** it emits events instead; the split is phase 5. |
| Direct Firestore in UI: billing.js (231 … 804), cash-management.js:50, outstanding.js:763, rent-store.js:35 | ✅ | billing.js has 11 lines (also :668); cash-management.js :50, :271, :730; outstanding.js :670, :763, :879; rent-store.js 12 (it is the rentals repository), rent-receipt-store.js :46, :67. Outside pages: `Helpers.generateBillNumber` (helpers.js:303-307), telemetry.js:438. **Phase 4:** all moved into repositories (section 5). |
| UI mutates AppState: billing.js:1154-1216, 1261-1268; cash-management 177-178, 336-350, 742-832 | ◐ | billing.js :1155, :1216, :1261 ✅. cash-management ❌: those lines only **read** AppState. Real writers: settings.js 19 lines, stock.js 8, items.js 6, billing.js 3, history.js 3, roles-access.js 2, outstanding.js 1, miscellaneous.js 1. |
| Cross-module `window.app` calls, inline handlers, templates/day.html:45 | ✅ | billing.js:1264-1268; 297 inline `onclick=`; day.html:45 inline keydown logic. |
| Rules inside UI handlers | ◐ | `validateSignOut` (cash-management.js:763) composes `evaluateCashCount` (utils/bill-checks.js:443) and computes C8 inline. rentals.js:792-794 re-checks only "not negative"; `meterBill` (rent-math.js:268-275) owns the full rule (phase 2i: both checks share one rule in rent-math, `moveInError`). Payment-split tick / "rest in Due" logic is triplicated: purchase.js:445-500, retail-sale.js:414-470, wholesale-sales.js:295-345 (one copy in `calc/billing` since 2f). |

### Design risks checked

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | Offline blind `set()` for initial bill saves; two phones overwrite each other | ◐ | `saveBill` (firestore-service.js:774-823) does a whole-doc `set()`, but on a fresh client-made id (:779), so two phones never share an id. Retries go through `retryBillSave` (transaction, keeps server money fields, :846-891) and edits through `updateBillChecked` (transaction, conflict check, :899). Remaining risk: offline item / settings / user writes (#113). |
| 7 | Rounding not enforced at storage | ✅ → fixed | Line totals whole rupees, bill totals and payments `round2`, stock values unrounded (examples above). **F-R1 resolved (#129, owner 2026-11-01):** every money amount is saved as a whole rupee (half-up) through `ROUNDING`, labour included (₹12.50 → ₹13, payable ₹987 on screen, tick and bill), and the stock replay values purchases at their saved line amount (`purchaseLineValue`, `STOCK_REPLAY_FORMAT` 5), so the ₹415 / ₹415.40 and ₹988 / ₹987.50 disagreements above are gone for new records; old paise records are summed as stored. The rules keep accepting paise (`moneyOk`, #184) for older app versions and old bills; only the electricity check widened to ±₹0.51. |
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
   The rounding decision (F-R1) is made and applied (#129: MONEY-ROUND).
5. A shipped `www/` change needs the cache bump (AGENTS.md section 4).

Order (S/M/L = size; ⚠ = conflicts with in-flight work, wait for it to merge).
In flight on 31 Oct: **#181** double-tap locks (billing, cash-management,
miscellaneous, modules/money, outstanding, stock, wholesale-sales, rentals.js,
main.js), **#182** offline sync indicator (firestore-service, billing,
miscellaneous, purchase, retail-sale, settings, wholesale-sales, main.js, new
ui/sync-status.js and utils/storage-full.js), **#180** printer timeouts (merged 31 Oct; this PR is rebased on it)
(services/printer.js, settings.js, main.js), plus security work on
firestore.rules and the save handlers. Every PR that changes `www/` also collides
on the three cache-bump lines (index.html, main.js `BUILD_ID`, service-worker.js).

| Phase | PR | Size | Conflicts |
|---|---|---|---|
| 0 | This PR: doc, ratchet, baseline | S | none (ratchet: #180 added no counted line; #181, #182 change no counts) |
| 1 | Characterisation tests: bill forms (draft totals, labour, prefill, split), Today item cards, cash drawer C1–C8, history viewBill; BUG fixtures for the 4 disagreements | M | tests only; rebase on #181, #182 |
| 2a | ✅ #185: delete the dead `HistoryManager.saveBillToHistory` and its `window.app.history.saveBillToHistory` wiring (main.js:1060), and the commented-out `viewRetailSale` block (history.js:531-610) | S | ⚠ main.js (#181, #182) |
| 2b | ✅ #185: `calc/today.todaySummary` (T1–T17) out of day.js | M | none (day.js not in flight) |
| 2c | ◐ #190: month steps, day loops and day ends of Insights, Money, Statements and Outstanding into `dates.js` (`monthStart`, `addMonths`, `monthRange`, `addLocalDays`, `localDayKeys`, `periodBounds`, `endUpToNow`, `latestMonthStart`); left: day :126 (cash :320 done in 2g) | S | ⚠ cash-management.js (#181) |
| 2d | History `viewBill` view-model on `billTotal` / `readPayment` | S | none |
| 2e | ✅ #190: Insights top-5 share (I12), per-₹100 / season / cover rounding, retail-wholesale %, weekly kg, season sums, last-year item sales and the add-up check, and Money's leftovers (accounts total, M14 per day, labour gap, add-up check) into business-metrics / labour / month-snapshots | S | none |
| 2f | ✅ #189: `calc/billing`: lines, draft totals, labour, payable, payment split / prefill / Rest → Due, split checks (one copy for purchase / retail / wholesale; both `checkPaymentSplit`s are now `validatePaymentSplit` / `validateDuePayment`), wholesale live profit / margin; rounding unchanged, one named policy per figure (`ROUNDING`, #129). Characterised first (`bill-forms-characterisation.test.js`); moneyMath 147 → 100, domNumber 3 → 2 | M | done |
| 2g | ✅ `calc/cash`: `drawerDay` (C1–C6, the day via `dates`), expected / status card / sign-out summary / day details (C7), the count, close, late-count and opening checks and colour bands (C8), "No bill" legs; behaviour unchanged, characterised first (`cash-characterisation.test.js`); cash-management moneyMath 16 → 0, dateMath 1 → 0 | M | done |
| 2h | ✅ #190: `calc/stock` (S1/S2 merge, S3 `itemValue`, S4 `stockValue` shared with finance-calc / Money, S5 adjustment value, S6 dead-stock value) out of stock.js | S | none |
| 2i | ✅ Rentals: all rent maths and rules in rent-math (`moveMonthRent` / `moveMonthSplit` / `oldMonth` / `changeUnitPlan`, `rentTotals` for rent-views and the totals, `moveInError`, receipt amounts); `moveTarget` in rent-views | S | ⚠ #181 (rentals.js) |
| 2j | Bug fixes from section 4, one PR each after the owner answers | S each | ⚠ #181, #182 (wholesale-sales, cash, expenses) |
| 2k | Receipt amounts (services/printer.js:350-431) from `readPayment` / `billTotal`; move main.js's debug stock replay (`debugStockForName`, main.js:527-695) onto `stock-replay` | S | main.js (#181, #182) |
| 3 | Services / use cases: `bills` (save/edit/void/delete), `payments` (record, write-off: the rules now inside outstanding.js's `updateBillInTransaction` callbacks), `cash` (open/close/count), `stock` (adjust), `rent`; pages stop building documents | L | every save handler |
| 4 | ✅ Repositories (`www/js/firebase/repos/`): `bill-drafts` (drafts, auto-save, item order: billing.js's 11 sites), `bill-payments` (the due-payment and write-off transactions with the legacy-id retry: outstanding.js), `cash-sessions` (auto-close / late-count transactions, close, deposits and "No bill" legs: cash-management.js), `counters` (bill numbers: helpers.js), `users` (profile read and pending profile: authentication.js, main.js), `audit-logs`, `telemetry` (services). Rentals keep their repository in `rentals/rent-store.js` + `rent-receipt-store.js` (lazy, #170); `coll()` is no longer exported, rent-unit.js uses `leaseInTx` / `chargeInTx` / `updateChargeInTx`. The sync pill gets `FirebaseService.pendingWritesWaiter` instead of the db. Calls, queries, limits, transaction shapes and payloads unchanged, pinned first (`repositories-characterisation.test.js`, `tests/fixtures/repositories-calls.json`). Also from phase 5: `VIEWS` / the item-order listener emit events (`utils/events.js`) instead of calling `window.app`. Ratchet firestore 57 → 0, now absolute | M | done |
| 5 | ◐ Split firestore-service.js (~4,370 lines): realtime coordinator, retry, cache, checkpoint, snapshots, notifications; its remaining collection code (cash sessions, users, settings…) into `firebase/repos/`. Step by step, calls pinned first (`repositories-characterisation.test.js`, the `service.*` entries of `tests/fixtures/repositories-calls.json`; #69): each moved group is a method object in `firebase/repos/` spread into `FirebaseService`, so callers, `this` and test spies are unchanged. Done: shared `firebase/db.js`; items, bill-stats, collection-admin, tip-health, anomalies | L | firestore-service |
| 6 | AppState store API (`setStock`, `upsertItem`, `setSettings`, `setUser`); settings.js and firestore-service first | M | settings.js, security |
| 7 | Inline handlers → delegated listeners (and page-to-page calls through events or services); prove the layering with one alternative UI | L | later |

## 6. The ratchet

`www/js/__tests__/architecture-guard.test.js` parses every file under `www/js`
(except `__tests__/` and `tip/`) with acorn and counts, per file, the source
lines that break a rule: `firestore`, `moneyMath`, `domNumber`, `appStateWrite`,
`dateMath` (the exact heuristics are in the test's header). Each layer is exempt
only from what it owns:

| Files | Exempt from | Still checked |
|---|---|---|
| `firebase/**` (with `firebase/repos/`), `rentals/rent-store.js`, `rentals/rent-receipt-store.js` (repositories) | firestore | moneyMath, domNumber, appStateWrite, dateMath |
| `utils/**`, `rentals/rent-math.js`, `rent-views.js`, `rent-public.js` (calc) | moneyMath, dateMath | firestore, domNumber, appStateWrite |
| everything else (`modules/`, `rentals/`, `ui/`, `services/`, `auth/`, `main.js`, …) | nothing | all five |

So moving maths from a page into `ui/` or `services/` raises that file's count
and fails; moving it into `utils/` lowers it. Since phase 4 `firestore` is
absolute: any hit outside the repositories fails, and the baseline may not hold a
firestore entry (no baseline, no exception can let it back). `tests/architecture-baseline.json`
holds the counts over all of `www/js`; at Phase 0 (`ca6f2ba`) and after 2c / 2e / 2h
(Stock, Insights, Money and dates into calc / utils):

| Category | Phase 0 | After 2c/2e/2h | After 2f/2g/2i | After 4 | Largest now |
|---|---|---|---|---|---|
| firestore | 57 | 57 | 57 | 0 (absolute) | none outside the repositories |
| moneyMath | 205 | 111 | 45 | 45 (42 after #129: the bill-edit save uses `calc/billing`) | wholesale-sales 11, history 7, printer 6, outstanding 5, billing 2 |
| domNumber | 4 | 3 | 2 | 2 | utils/helpers.js 2 (`getElementNumber` / `getElementInt`) |
| appStateWrite | 83 | 81 | 81 | 81 | firestore-service 25, settings 19, stock 8 |
| dateMath | 22 | 5 | 3 | 3 | anomalies 2, history 1 |

Phase 4's firestore 57 → 0: 43 lines moved into `firebase/repos/` (billing 11,
audit 11, telemetry 7, authentication 4, cash-management 3, outstanding 3,
helpers 3, main 1) and 14 are the Rentals repository (rent-store 12,
rent-receipt-store 2), now exempt as repositories. The detector also counts
`where(a, op, b)`, `onSnapshot`, transaction / batch operations,
`runTransaction` / `batch` on anything and `firebase.firestore.FieldValue` since
phase 4, and the ways round them: any `.db` (`FirebaseService.db`, `window.db`,
destructuring), `…Ref(` on FirebaseService through any import name or alias
(`cashSessionRef` is no longer public), the `firebase` global used for anything but
`.auth` / `typeof` (`window.firebase`, `globalThis.firebase`, `const fb = firebase`),
and any import, `import()` or re-export naming "firebase" other than our own
`firebase/` folder (the SDK, CDN URLs, firebaseConfig.js).

(Insights, Money and Statements now have no hits; stock.js keeps one moneyMath line,
the unused `StockManager.updateStock`.)

`utils/helpers.js` is in the calc folder but is not pure: `generateBillNumber`
asks the counters repository (phase 4; it was 3 Firestore lines) and it reads the
screen (2); `utils/state.js` has no hits.

- A count that goes **up**, or a new file with any count, fails the test with the
  file and category.
- A count that goes **down** passes and prints what to lower;
  `ARCH_BASELINE=lower npx jest architecture-guard` rewrites the baseline (it
  never raises a number).
- **Raising is recorded.** The test also reads the baseline on the PR base
  (`git show origin/<base>:tests/architecture-baseline.json`; on pull requests
    ci.yml fetches the base and sets `ARCH_REQUIRE_BASE=1`) and fails on any number above it unless
  `exceptions` has a matching `{file, category, from, to, reason, issue}`.
  `ARCH_BASELINE=reset` (local only; refused when `CI` is set) writes the exact
  counts and adds exception stubs with `reason: "TODO"`, which fail until filled
  in. Without git or the base ref (shallow clone, hosting workflows) that check is
  skipped with a note.
- It is a heuristic: it misses maths on names without a money word
  (rent-unit.js:28 `full × days`, now in rent-math) and writes through an alias, and it counts some
  harmless lines (`totalDocs += count`). Treat it as a floor, not proof.
