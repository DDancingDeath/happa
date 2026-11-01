# How every number is calculated

This page defines, in plain words, every number the app shows about money and
stock. It is the reference the tests check against (#216):

- **Spec IDs** (T1, F4, AC3, …) are used by the oracle tests in
  `tests/oracle/screens.test.js` and the accounting checks in
  `tests/property/accounting.test.js`.
- The **oracle** (`tests/oracle/oracle.js`) is a second, deliberately simple
  implementation of these definitions that shares no code with the app.
- A definition the app does not follow yet is marked **❌ app differs** with
  its bug issue. Its test is skipped until the bug is fixed.
- A definition that waits for an owner answer is marked **❓ open** with the
  decision issue. Until it is answered, the recommended option is used.

If you add or change a number on screen, update its entry here and its oracle
test in the same PR (see AGENTS.md → PR checklist). Which function computes each
ID, today and after the refactor: [architecture.md](architecture.md) §3.

---

## Building blocks

| ID | Name | Definition |
|---|---|---|
| BILL-TOTAL | Bill total | What the bill is worth. **Purchases:** the total after labour is taken off (`grandTotal`). **Sales:** the sale total (`total`). Older bills: the first field present (0 counts) of `grandTotal`, `amountPayable`, `total`, `billTotal`, `saleTotal`: a present `grandTotal` of 0 is the answer (labour equal to the line value makes the payable ₹0); a missing or empty field is skipped. A legacy purchase's `billTotal` is its line value before labour, so it comes after `total`. One function, `billTotal()` in `utils/money.js`: Today (T1, T2, `utils/calc/today.js`), Money, Statements, History (list rows and the bill's "Total payable" / "Sale total"), the printed receipt and its optional bill QR (`receiptPayable()` / `billQrText()` in `utils/bill-share.js`, whole rupees as printed, #107) and the WhatsApp bill text (payable / sale total) and the duplicate-bill check all use it. |
| BILL-PAY | Cash / online / due on a bill | Taken from `payment.cash/online/due` when present (it is kept up to date when a due is paid later); otherwise from `cashPayment` / `onlinePayment` / `dueAmount` (a `payment.cash` of 0 wins over an old top-level `cashPayment`). Very old bills only have `amountPaid` (cash): their due is total − paid. One function, `readPayment()` in `utils/money.js`, also for the receipt's "Total received / paid" and the cash / online on History cards and bill details. |
| BILL-AT-SAVE | Paid when the bill was saved | Cash / online on the bill minus every later due payment in `payments[]`. Later payments count on the day they were made, not on the bill's day. Nothing for a VOID bill. |
| BILL-DUE | Still owed on a bill | BILL-PAY due, never below 0, and 0 when the bill is cleared, written off or VOID. One function, `outstandingDue()` in `utils/money.js`: Outstanding, Money, Today, Wholesale › Outstanding, the History due chip and bill details (History, Wholesale), the printed receipt and WhatsApp bill text, and the bills' `openDue` flag (what a phone loads as dues) use it. A due of 0 with cash + online a little under the total (inside the ₹1 split tolerance) is not a due. |
| DUE-PAY | Due payment | One entry in a bill's `payments[]` (cash and/or online; entries before #107 have only `amount`, which is cash), or the same payment as a leg in a cash session's `duePayments` (every session of that day: legacy days can have more than one). The same payment id is counted once. A write-off (`kind: 'writeOff'`) is never money. |
| EXP-KIND | Business or personal expense | Personal only when the expense is tagged personal: its `category` is "personal" (any case), or, on an expense with no category, its `type` is. Anything else — including old expenses with no tag, and a business expense whose type is "personal" — is business and should be shown as "uncategorised" (owner decision #36). One function, `isPersonalExpense()` in `utils/money.js`: Today (T4, T5, `utils/calc/today.js`), the Expenses page's business / personal lists, the drawer (C3), Money (M4 and its category rows, M8), Statements (ST1) and `finance-calc` use it. Personal expenses are stored in `personalExpenses` (#98; older ones may still be in `expenses`), which only the owner and roles with Roles & access › Personal expenses can read. A phone without those rows leaves them out of its period figures (Money, Statements, Insights); Today (T5) and the cash count (C3) still add the day's total from `personalExpenseDays`. |
| EXP-MODE | How an expense was paid (#118) | Cash or online, picked when the expense is entered (default cash; it can be corrected on an edit). Online only when `paymentMode` is "online"; **every expense saved before #118 has no mode and counts as cash** (that is how it was counted until then). Only cash expenses leave the drawer (C3) and count in Today's cash paid (T8) and Money's cash out (M13 cash); online ones count in online paid (T9) and M13 online. Spending totals (T4, T5, M4, M8) count both. A new expense also has a **date** (default today, never in the future; back-dated at most the role's `editDays`, the bill edit window; the owner any day): stored as `date` (that day, at the time of entry) and `day` (YYYY-MM-DD); `timestamp` stays the save time. Editing keeps the date. `expenseMode()` / `isOnlineExpense()` in `utils/money.js`; the form rules in `utils/expense-entry.js`. A phone without the personal rows gets the online part of a day's personal expenses from the `online` flags of `personalExpenseDays`. |
| DAY | A day | Local (IST) calendar day, midnight to midnight, using the bill's own date (❓ open: #99 asks whether "Today" should follow the open cash session instead). Dates may be ISO, `DD/MM/YYYY` or `DD/MM/YYYY, h:mm:ss am`; all mean local time. All calendar steps are in `utils/dates.js`: `startOfLocalDay` / `endOfLocalDayExclusive` (a day), `addLocalDays` (n days, at local midnight), `localDayKeys` / `periodBounds` (the days of a period), `endUpToNow`; pages never add days or months themselves. |
| PERIOD | This week / month / year | Calendar period up to now: week from Monday, month from the 1st, year from 1 January (owner decision #43, 2026-10-26: calendar month; `insights-config.js` `monthMode` / `yearStartMonth` can switch to the last 30 days or an April year). "Last 7 / 30 days" would be labelled so. Months step from the 1st (`dates.monthStart`, `monthRange`): one month back from 31 Mar is February, from 1 Jan is December of last year; the same date a month later is clipped to the month's end (`dates.addMonths`: 31 Jan + 1 = 28 Feb, 29 Feb in a leap year). |
| AVG-COST | Average cost of an item | Weighted average: each purchase adds its quantity at its **saved line amount** (`total`, older lines `amount`: the whole rupees on the bill, #129; a line saved without one adds kg × rate), so its cost per kg is that amount ÷ kg; each sale removes quantity at the average cost of that moment; adjustments add (at their rate), remove (at average cost, never below zero) or set the quantity. Lines match a catalogue item by item id, else by English or Hindi name (trimmed, any case). Retail sales reduce stock like wholesale and are costed the same way (owner decision #33, 2026-10-25). One function for a purchase line's value: `purchaseLineValue()` in `utils/stock-replay.js` (the replay, Money's "Bought (at line rate)" M17 and AC1 use it). |
| COGS | Cost of goods sold | For every sale line: quantity × AVG-COST of that item at the moment of the sale. |
| OPENING | Opening record (old-app due) | A bill-shaped record written by the move from the old app (`tools/migrate`): it has an `openingBalance` object, no lines and a total of ₹0, and is dated with the old bill's date (which can be today). It is a **balance only**: it counts in dues — Outstanding, aging (from its original date), reminders, statements, the all-time "due to receive / pay" totals (F9, F10, R6, R7, A5, A6) — and in **no** period or activity figure: not in Today (T1–T16), Reports R1–R5 and R8, Finance F1–F8, Analytics A1–A4, bill counts, stock, rate trends, item frequency, anomaly scans or Number checks AC2 / AC4. Money paid on it later is a normal DUE-PAY on the day it is paid (cash flow, drawer, T13 / T14); writing it off is not a bad debt (its sale was never a sale here). In code: `isOpeningRecord()` / `activityBills()` in `utils/money.js`, the one filter every period figure uses (review rule `period-aggregation-without-activity-filter`). |
| BILL-COUNT | "N bills", "N sales", average bill | Number of bills whose BILL-TIME is in the period that are activity: OPENING records are never counted (`billCount()` in `utils/business-metrics.js`). Today (T1/T2), Reports (R1/R2, Purchases / Sales tabs, Compare), Finance (F1 count) and Analytics use this one rule, so they agree; History lists opening records too, marked "Old app". |
| VOID | Voided bill (#75) | A bill marked `voided: true` (with `voidedAt` = server time, `voidedBy`, `voidedByName`, `voidReason`) instead of being deleted. It is kept for History only and counts in **no** figure, as if it had never been saved: not in stock (S*, the checkpoint and its rebuild), dues (BILL-DUE, Outstanding, aging, reminders, the bill form's "already owes", O*), Today (T*), the cash drawer (C1–C5: BILL-AT-SAVE and its DUE-PAYs are 0), labour (T-LAB), Money (M*), Insights (I*), Statements (ST*), rate trends and product traffic (RT*, PT*), month snapshots (`monthStats`, marked stale like after a delete), anomaly scans and Number checks. One rule, `isActiveBill()` in `utils/money.js` (`activeBills()`, and `activityBills()` = active and not OPENING): FirebaseService keeps voided bills out of AppState's bill lists (`publishCollection`; History asks `voidedBills()`), and every calculation that reads bills checks it too. A void is refused while the bill has later payments (`payments[]`): those are drawer money already counted on their day. |
| BILL-TIME | When a bill counts | The bill's stock time: numeric `timestamp`, else its `date` read by `utils/dates.js` (ISO, `DD/MM/YYYY`, `D/M/YYYY, h:mm:ss am`; all local IST). A new bill gets the day on its form's Date box (#147, `utils/bill-date.js`): today = the save time; an earlier day = that day at the time of day it was entered, written as both `timestamp` and `date`, so stock, Today, the cash drawer, dues, Money, month snapshots and rate stats count it on that day (writes before the stock checkpoint or this month mark them stale, as edits do). `enteredAt` keeps when it was entered; the edit window counts from the server `createdAt`. Members and managers may go back the role's `editDays` (never before the 1st of last month), the owner to the 1st of last month (the oldest day the app keeps live; the rate-stats roll-forward first loads the rest of that month's first week when a loaded bill of those days was entered, reached the server, edited or voided after that week ended, `rollForwardWeekGap` / `billChangedSince`; as for every week and month before the window, a hard delete, or a change to a bill older than the loaded history, waits for the next backfill). Cash on a bill dated before today: the owner only, after a confirm when that day's cash is already closed (its figures don't change); anyone else may use online or due only (`backdatedCash`; rules `noBackdatedCash`, which compares `timestamp` with the IST day of `enteredAt`: the drawer C1–C2 and Today T* count bills on their numeric `timestamp` too, `billDayTime()` in `utils/calc/cash.js`, the `date` text only without one). Anomaly scans and duplicate checks use when the bill was entered (`enteredAt`, else `createdAt` when on a later IST day and more than 12 hours after `timestamp`, else `timestamp`; `billTime()` in `utils/anomalies.js`), and flag anyone but the owner's bill from 1 day back (the owner's from Q20). Expenses, withdrawals and payments are read by the same parser (`recordTime`). No other date parsing is used by the calculation layer (#49). |
| CMP | Comparisons | For a period: *previous* = the same days of the previous month for a calendar month, else the same length just before ("last 30 days" always uses the same length, even when it starts on the 1st); *last year* = the same dates one year earlier. The last day is counted inclusively and clipped to the shorter month (1–30 Oct vs 1–30 Sep, 1–28 Mar vs all of Feb); a month that has reached its last day compares with the whole other month. % change = (now − then) ÷ \|then\| × 100, rounded; no % when `then` is 0; "about the same" under 2 % (`insights-config.js` `sameWithinPct`). When `then` is not known (bills not loaded and no month snapshot, or a stale one) each comparison says so, "vs Oct 2025: not known" (Money's `compareHtml`), never left out. |
| PARTY | One party | Bills belong to the same party when their names match with case, extra spaces and Unicode form ignored ("test party" = "Test Party"). The name shown is the spelling used most; on a tie the one with more capitalised words. Outstanding, aging, reminders, Reports' customer filters and Analytics' customers group this way. |
| MONEY-TEXT | How ₹ is written | Indian grouping everywhere: whole rupees (₹2,50,000); rates per kg in paise (₹1,234.50). Amounts below ₹100 that are averages show paise (₹0.40, not ₹0). One formatter: `formatRupees()` in `utils/money.js` (`Helpers.formatCurrency`). |
| MONEY-ROUND | Rounding (#129) | **Rates keep paise; money amounts are whole rupees, half-up; stock values at saved line totals.** Owner decision (2026-11-01): "rate will have paise, total will not, it will be rounded". Rates (₹ per kg, labour rate, electricity rate) and quantities (kg, units) keep their decimals. Every money amount the app saves is a whole rupee, rounded half-up on the amount in paise (`Math.round`, so ₹0.50 goes up; 0.7 kg × ₹45 = ₹31.50 → ₹32 even though floating point makes it 31.499…): line amounts (BF-LINE), bill totals and payable (BF-TOTAL, BF-PAYABLE), labour (BF-LAB: ₹12.50 typed is saved as ₹13, so ₹1,000 of lines pay ₹987 on screen, in the Cash tick and on the saved bill — rounding the deduction up takes the 50 paise off the supplier's payable, never adds them), the cash / online / due split and `payment.total` (BF-SAVE), Rest → Due, due payments (DUE-CHECK), the wholesale cost, expenses and profit (WS-PROFIT), expenses, withdrawals, cash deposits and "No bill" drawer entries, and the electricity amount (RENT-7). Rents are already whole rupees (RENT-6, RENT-11, RENT-13 round). Stock is valued at the saved line amounts (AVG-COST), so a 12.4 kg × ₹33.50 line is ₹415 on the bill, in the stock value, in cost of goods sold, in Money and in the cash drawer — not ₹415.40. Write-offs and dues are what is left on the bill, so whole rupees on new bills. Rent payments (RENT-5) are whole rupees too. **Cash counts stay in paise**: the counted drawer (C8, C9; `parseCashAmount`) is coins and notes as counted, not an amount the app works out. **A line saved with an amount of ₹0** (rate or kg 0, or a ₹0 line typed by hand) adds its kg to stock at the saved ₹0 (AVG-COST takes the saved amount whenever kg > 0), so it lowers the average cost; it is never re-priced at kg × rate. One switch: `ROUNDING` in `utils/calc/billing.js` (`entryAmount()` for expenses / withdrawals / deposits / "No bill", `meterAmount()` for electricity). **Records saved before (with paise) are never rewritten and add up exactly as stored**: every total sums the stored amounts, so an old ₹987.50 bill still counts ₹987.50; a due payment of exactly an old due **that has paise** is paid in whole-rupee legs with that paise remainder in one leg, so it can be paid off to 0 (`hasPaise`, `settleSplit`); **editing an old bill without touching its money** (lines, labour, cash / online / due) keeps every stored money field exactly and saves only the other changes (`editKeepsMoney`); an edit that changes money re-saves it by this rule, with the cash / online / due settled on the new total (`editedPaymentSplit`: each leg rounded, the remainder in Due, else the largest leg, so they add up to it exactly); its edit record keeps the old values. An edited expense is saved in whole rupees. Month snapshots (`monthStats`) were built with the old stock valuation: `SNAPSHOT_VERSION` 3 makes an owner / manager phone rebuild each older month once when it has the full history loaded (1 read + 1 write per month, about 24 for two years; `outdatedOlderMonths`); until then a comparison with such a month uses the old figure, which differs by a few rupees. Display rounding (MONEY-TEXT) is unchanged. |
| DATE-TEXT | How dates are written | "25 Oct 2026" for a date; "25 Oct, 8:59 pm" for a date and time (the year is added when it is not this year); Hindi month names and पूर्वाह्न / अपराह्न in Hindi. One formatter: `formatDay()` / `formatDayTime()` in `utils/dates.js`. |

Labour on purchases is taken off the supplier's bill, so the stock is valued at
the line amount (before labour) while the purchase costs the shop the bill total
after labour. (Owner decision 2026-10-26: labour is **not** part of the cost of goods sold; Money shows it
as its own line, M7. `insights-config.js` `labourInCost` keeps the choice in one place.)

---

## Today (`templates/day.html`, `modules/day.js`)

All for DAY = today. Due payments (T6–T9, T13, T14) come from the loaded bills and the legs of every cash session of the day, read with one query (a legacy day can have two; the drawer is still the one the Cash page picks), each payment id once, as the day book (ST1).

One pure function computes every figure: `todaySummary({ bills, expenses, sessions, settings, today })` in `www/js/utils/calc/today.js` (field → ID in `TODAY_SPEC`); `modules/day.js` only gathers its inputs and renders it. Tests: `tests/oracle/screens.test.js` (screen and function vs the oracle) and `www/js/__tests__/today-characterisation.test.js` (exact screen text pinned for `tests/fixtures/calculations/today-days.json`).

| ID | On screen | Definition | Owner (`todaySummary()` field) |
|---|---|---|---|
| T1 | Purchases | Σ BILL-TOTAL of today's purchases; count of bills. | `purchases`, `purchaseCount` |
| T2 | Sales | Σ BILL-TOTAL of today's wholesale + retail sales; count of bills. | `sales`, `saleCount` |
| T3 | Labour › Deducted from farmers | Same number as T-LAB-1 below. | `labour.deducted.amount` |
| T4 | Business expenses | Σ today's expenses of kind business (EXP-KIND), untagged ones included, cash and online (EXP-MODE). | `businessExpenses`, `businessExpenseCount` |
| T5 | Personal expenses | Σ today's expenses tagged personal, cash and online (EXP-MODE). On a phone whose role can't read them (#98): + today's total and count in `personalExpenseDays` (the `personalDay` input). | `personalExpenses`, `personalExpenseCount` |
| T6 | Cash received | BILL-AT-SAVE cash of today's sales + cash part of DUE-PAYs received today. | `cashIn` |
| T7 | Online received | Same, online. | `onlineIn` |
| T8 | Cash paid | BILL-AT-SAVE cash of today's purchases + today's cash expenses (EXP-MODE: business and personal, no mode = cash) + cash part of DUE-PAYs paid today. | `cashOut` (expenses term: `expensesCash`) |
| T9 | Online paid | BILL-AT-SAVE online of today's purchases + today's online expenses (EXP-MODE) + online part of DUE-PAYs paid today. | `onlineOut` (expenses term: `expensesOnline`) |
| T10 | Total in | T6 + T7. | `totalIn` |
| T11 | Total out | T8 + T9. | `totalOut` |
| T12 | Net inflow / outflow | T10 − T11, shown as an amount with "Net inflow" or "Net outflow". | `net` (= −`netOutflow`); label from `isOutflow`, amount `netAmount` |
| T13 | Due received | DUE-PAYs received today (cash + online). | `dueReceived` |
| T14 | Due paid | DUE-PAYs paid today (cash + online). | `duePaid` |
| T15 | Due to receive | Σ BILL-DUE of today's sales (new dues made today; OPENING records are not today's sales even when dated today). The all-time total is on Outstanding / Finance (F9). | `dueToReceive` |
| T16 | Due to pay | Σ BILL-DUE of today's purchases (OPENING records left out, as T15). | `dueToPay` |
| T17 | Item cards (Purchases / Sales by item) | The day's bill lines (purchases; wholesale + retail sales; OPENING records have none) grouped by item name (`item`, else `name`, else "Unknown"): lines, Σ kg (`qty`, else `quantity`), Σ value (`total`, else `amount`), average rate = value ÷ kg (2 decimals; ₹0 when there is no kg). Highest value first. | `purchaseItems`, `saleItems` (`itemRows()`) |
| T18 | By bill type (Retail sale / Wholesale sale / Purchase) | For each type, today's bills of that type (OPENING records and voided bills left out, as T1/T2): count, Σ BILL-TOTAL, and that total in parts that add up to it: **cash** and **online** paid at save (BILL-AT-SAVE), **paid later today** (Σ cash + online of the DUE-PAYs recorded on these bills; they are made after the bill, so today), **written off** (shown only when > 0) and the **due** still open (BILL-DUE). Cash + online + paid later + written off + due = total. Retail + wholesale at-save cash and online are the sale-time parts of T6 / T7 (purchase: of T8 / T9) and their paid-later parts are inside T13 / T14; retail + wholesale due = T15, purchase due = T16. Tapping a row (T19) opens the bill details, which show the same parts (`paymentBreakdown()`: "Cash/Online at save", "Paid later" with its cash/online split, "Written off", "Due"). Wholesale is hidden for a role that may not open the Wholesale page (#141). | `channels.retail`, `channels.wholesale`, `channels.purchase` (`channelSplit()`, per bill `paymentBreakdown()` in `utils/due-payments.js`) |
| T19 | Today's bills | The same bills as T18, newest first (bill date), each with its BILL-TOTAL; a row opens the bill's details (#141). The first 8 show, "Show all N" shows the rest. | `dayBills` (`dayBillRows()`) |

### Labour: deducted and to pay (`utils/labour.js`)

Two different questions, both shown on the Today Labour card (tap for each
bill), in the day report (WhatsApp / image) and, for a period, on Money ›
Spending (M7, M18): Today is their home for today, Money › Spending for periods. One implementation: `labourSummary()` in
`utils/labour.js`; oracle: `tests/oracle/labour.test.js`. Purchases only,
OPENING records left out (`activityBills()`). On Today they are `todaySummary().labour`: `deducted` (T-LAB-1), `toPay` (T-LAB-2), `gap` (T-LAB-3, `labourGap()`) and `packets` (the breakdown's total packets).

| ID | On screen | Definition |
|---|---|---|
| T-LAB-1 | Deducted from farmers: ₹X (N bills) | X = Σ labour on the day's purchase bills (`laborCharges`, older bills `labour`; 0 when Labour was unticked). On a bill it is heavy packets × labour rate unless typed by hand. N = bills with labour > 0. |
| T-LAB-2 | To pay labour: ₹Y (W kg ÷ K kg = P packages × ₹R) | W = Σ kg of every line on the day's purchase bills (`qty`, older lines `quantity`), with or without Labour ticked. K = Settings › Aadhat "Package weight for labour (kg)" (`settings/app.labourPackageKg`, default 35, allowed 1–200; anything else is 35). P = ⌈W ÷ K⌉ — **rounded up**: a part package is paid as a full one (1,000 kg ÷ 35 = 28.57 → 29); 0 kg → 0. R = the shared labour rate (`laborRate`, ₹ per heavy packet, default ₹6) — it is a per-packet rate, so it is used per package as is. Y = P × R. |
| T-LAB-3 | ₹Z more / less than deducted | Z = \|Y − X\|: "more" when Y > X, "less" when Y < X, "matches" when they are within 50 paise. Not an error: they differ when Labour was unticked on a bill, packets were at or below the heavy weight, or the kg does not fill whole packages. |

On Money › Spending (M7, M18), for
a period longer than a day, T-LAB-1 is the sum over
the period; T-LAB-2 is the sum of each day's T-LAB-2 (labour is paid per day,
so each day is rounded up on its own).

## Bill forms: purchase, retail sale, wholesale sale (`templates/billing.html`, `templates/wholesale-sales.html`)

While a bill is entered (before it is saved) and the money fields of the bill
the form saves. One pure module computes every figure: `www/js/utils/calc/billing.js`
(function → ID in `BILLING_SPEC`); `modules/purchase.js`, `retail-sale.js` and
`wholesale-sales.js` only read the inputs, call it and render. Tests:
`www/js/__tests__/bill-forms-characterisation.test.js` (each form driven in
jsdom: screen text, saved bill and payment split pinned),
`www/js/__tests__/billing-calc.test.js` and the oracle
`tests/oracle/billing.test.js` (forms and functions vs `billForm()`).

Rounding is one named policy per figure, `ROUNDING` in `calc/billing.js`
(MONEY-ROUND, #129 decided 2026-11-01: rates keep paise, every money amount is a
whole rupee, half-up). The screen, the Cash / Online / Due tick and the saved
bill agree: a purchase of ₹1,953 with ₹12.50 labour saves ₹13 labour and shows,
fills and saves ₹1,940 (before #129 it showed ₹1,941 and saved ₹1,940.50); a
retail form shows its lines' plain sum to the rupee and saves the same whole
rupees.

| ID | On screen | Definition | Owner (`calc/billing.js`) |
|---|---|---|---|
| BF-KG | Packet chips' kg and count; a line's kg and packets | kg = Σ the packet weights typed for the line (plain sum, shown to 0.1 kg); packets = how many. Wholesale lines are typed in kg. Editing a retail line puts its weights back: its own, else its kg split evenly over its packets, else its kg as one packet. | `sumWeights`, `computeLine`, `weightsForEdit` |
| BF-LINE | Line amount (bill table) | kg × rate, **rounded to the rupee** half-up (`ROUNDING.lineAmount`): 12.4 kg × ₹33.50 = ₹415; stock, cost of goods sold and Money value the line at the same ₹415 (AVG-COST). | `computeLine` |
| BF-TOTAL | Bill total (purchase "Bill Total", retail "Total" / "Receivable", wholesale "Total"); total packets | Σ BF-LINE in whole rupees (`ROUNDING.billTotal`), saved as `billTotal` (purchase) or `total` (sales). The retail screen and every WhatsApp draft add the lines with plain addition (the same whole rupees for lines saved since #129). Purchase packets: Σ packets; retail: Σ packets (a line without packets counts 1 on screen, 0 in the saved `totalPackets`). | `computePurchaseTotals`, `computeRetailTotals`, `computeWholesaleTotals`, `draftLineSum` |
| BF-LAB | Labour box and "6 × 2" | With Labour ticked: the shared labour rate (`laborRate`, default ₹6) × heavy packets (packets above `heavyWeightThreshold`, default 30 kg), put in the box in whole rupees (`ROUNDING.autoLabourBox`) unless typed by hand; the saved bill keeps the box in whole rupees, half-up (`ROUNDING.labour`: ₹12.50 → ₹13; `laborCharges`, = T-LAB-1) and the working (`laborCalc`) when it was not typed. The WhatsApp draft shows the same saved labour. Unticked: 0. | `autoLabour`, `computePurchaseTotals` (`heavyPackets`) |
| BF-PAYABLE | Purchase "Total Payable" | BF-TOTAL − the saved labour (BF-LAB), whole rupees: saved as `grandTotal` / `amountPayable` and shown the same. | `computePurchaseTotals` (`grandTotal`), `payableOnScreen` |
| BF-PAID | "Total Paid" / "Total Received" | Cash + online typed, shown to the rupee. | `paidOnScreen` |
| BF-SPLIT | "₹X left" / "₹X extra" / "✓ ₹0"; the save check | Cash + online + due against the bill total (BF-PAYABLE for purchases, BF-TOTAL for sales): ok within ₹1 (`SPLIT_TOLERANCE`); otherwise the difference, which the save refuses. | `validatePaymentSplit` |
| BF-FILL | Ticking Online / Cash / Due; "Rest → Due" | A tick puts the whole bill total, to the rupee (`ROUNDING.tickFill`), in that box and 0 in the others (purchase: BF-PAYABLE; retail: the screen total). Rest → Due = total − cash − online, cash and online as they will be saved, in whole rupees (`ROUNDING.restInDue`), Due ticked when > 0; refused with the BF-SPLIT message when more than the total is paid. | `prefillPayment`, `restInDue` |
| BF-SAVE | Saved `cashPayment` / `onlinePayment` / `dueAmount`, `payment` | Each typed amount in whole rupees, half-up (`ROUNDING.payment`; also the wholesale `expenses`); `payment = {online, cash, due, total: online + cash + due}`. Read back with BILL-PAY. **Bill edits:** the form opens with the labour and cash / online / due as BILL-PAY reads them; an edit that changes no money keeps every stored money field exactly (`editKeepsMoney`); otherwise, when the legs add up to the new total (within ₹1) or to the stored total, they are settled on the new total (each rounded, the remainder in Due, else the largest leg), for the split check and the save alike (`editedPaymentSplit`): a ₹987.50 bill paid 487.50 + 500 whose payable becomes ₹987 saves 488 + 499; 300.50 + 300.50 + 386.50 saves 301 + 301 + 385; a ₹0.50 old due becomes ₹0. | `paymentSplit`, `buildPaymentSplit`, `typedAmount`, `editKeepsMoney`, `editedPaymentSplit`, `settleSplit` |
| WS-COST | Cost per kg of a wholesale line (save check, WS-PROFIT) | The item's **current** average rate in stock (AVG-COST) by the line's `itemId`, else the catalogue item with that id or name / Hindi name, else the trimmed lower-case name (as the stock replay maps names); **unknown** when no stock entry has a rate > 0 (never bought, no opening stock, or an unknown item). Save check `cost-unknown`: a new wholesale bill with such a line is saved only after the user confirms the warning (a flag on the bill); the saved bill and those lines get `costUnknown: true` (while stock is still loading every line counts as unknown: no profit, a confirm). A warning, not Q58's default block: the replay drops an item's average to 0 when it sells out and a later count without a rate keeps it there, so a block would also stop members selling goods that were bought. | `wholesaleCostRate` |
| WS-PROFIT | Wholesale "Profit" (live) and the saved `profit` | BF-TOTAL − cost − expenses as saved, all whole rupees; cost = Σ kg × WS-COST, rounded to the rupee. When any line's WS-COST is unknown the profit is **not known**: shown as "—" (also WS-MARGIN), saved as `profit: null`, left out of the WhatsApp draft (#102; it used to count those lines at cost ₹0). Shown the same; the WhatsApp draft uses the shown figure and the saved expenses. Can differ from I1 / M6 (AVG-COST at the moment of the sale) once an earlier-dated record is saved later. | `computeWholesaleTotals`, `wholesaleLiveProfit` |
| WS-MARGIN | Wholesale "Profit %" and the saved `profitPercent` | WS-PROFIT ÷ BF-TOTAL × 100, one decimal (`ROUNDING.margin`); 0 when the total is 0; not known ("—", `null`) with WS-PROFIT. | `computeWholesaleTotals`, `wholesaleLiveProfit` |
| DUE-CHECK | Recording a due payment (Outstanding, Wholesale › Outstanding, a bill picked on the Cash tab; rent payments, RENT-5) | Cash and online each in whole rupees (`ROUNDING.payment`). Only when the bill's due itself has paise (saved before #129) and the payment is exactly that due (within ₹0.01): whole-rupee legs with the paise remainder in one leg (the one typed with paise, else the largest), so the due is paid off and only the old remainder carries paise; a ₹100 due paid 0.01 + 99.99 is ₹0 + ₹100. Neither negative, together > 0 and at most the bill's BILL-DUE + ₹0.01. | `validateDuePayment`, `settleSplit`, `hasPaise` |
| DUE-ALL | Wholesale › Outstanding "Complete all due" (#150, owner / manager): the confirm's bill count and total, and what is settled | The party's open wholesale bills (party name compared after trimming, collapsing spaces and ignoring case), each with its BILL-DUE (> 0), oldest first; total = Σ those dues (an old bill's due may still have paise, #129; it is settled exactly). At most the oldest 100 in one go. On saving, each bill's due is re-read on the server and settled in full (cash or online, as picked): its own `payments[]` entry (amount = that due, `at` = the same now for all, `settlesDue`, `bulk`), due 0, cleared; all bills in one transaction (all or none). Σ the entries = the total settled; a bill paid meanwhile is skipped, a part-paid one settles what is left. | `partyDues`, `settleDueUpdate`, `duePaymentUpdate` (`utils/due-payments.js`) |
| BF-RECOVER | The "Unsaved bill" banner at start (#117): lines and total | The auto-save's form (purchase or retail sale, `mode`): its number of lines and its saved total (`billTotal` / `saleTotal`, else the lines' plain sum), to the rupee. | `autoSaveSummary` |
| BF-NO | "Next bill no. (given on save)" above Save (#117) | One more than the highest `{P\|S}{YYYYMMDD}-NNN` among today's loaded bills of that type (001 when none). Only a hint: the shared counter sets the real number at save, which can be higher (voided bills, another phone); offline the bill gets a device number (#41). While editing: the bill's own number. | `nextBillNumberHint` |

## Finance (retired; `utils/finance-calc.js` stays as the engine of M*) — #215

> Retired in redesign phase 5: the page is gone and its route opens Money. Its figures are now
> the M* / I* figures below (retired-ID table in docs/insights-redesign.md §7.8); kept here as the
> definition the old app versions still show.

For the selected PERIOD (or All). Bills belong to the period by their stock
time (numeric `timestamp`, else date), so a sale and its cost are always in the
same period.

| ID | On screen | Definition |
|---|---|---|
| F1 | Sales | Σ BILL-TOTAL of wholesale + retail sales in the period; count. Optionally "of which still due": Σ BILL-DUE of those bills. |
| F2 | Cost of goods sold | Σ COGS of the period's sale lines. |
| F3 | Business expenses | Σ business expenses (EXP-KIND) in the period. |
| F4 | Profit on goods sold | F1 − F2 − F3 − bad debts. This is **the** profit: Reports (R3) and Analytics (A4, the profit trend) show the same number (owner decision #36, 2026-10-25: "general profit should be profit − business expense"). Bad debts = dues to receive written off in the period (counted on the write-off date; a legacy "mark as cleared" without a write-off entry is not counted). |
| F5 | Personal expenses | Σ personal expenses in the period, shown separately and **not** taken off F4 (owner decision #36); a separate "after personal expenses" line shows F4 − F5. |
| F6 | Stock value now | Σ over items with quantity > 0 of quantity × AVG-COST, after every record. Same number as Finance → Assets "Stock value" and the Stock page total. |
| F7 | Cash flow | Money in − money out in the period. In: BILL-AT-SAVE of the period's sales + DUE-PAYs received in the period. Out: BILL-AT-SAVE of the period's purchases + DUE-PAYs paid in the period + all expenses (business and personal). Withdrawals are not included. |
| F8 | Check line | Opening stock value + purchases (at their saved line amounts, AVG-COST) − F2 + adjustments = closing stock value, for the period. A gap means goods were sold before their purchase was recorded; show "numbers don't match" with the gap per item. |
| F9 | Due to receive (Assets) | Σ BILL-DUE of all loaded wholesale + retail sales, OPENING records included. |
| F10 | Due to pay (Assets) | Σ BILL-DUE of all loaded purchases, OPENING records included. |
| F11 | Withdrawals | Σ withdrawals in the period. |
| F12 | Net worth | ❓ open: #39 (what to include; today's formula counts dues twice). Not tested yet. |

## Reports → Overview (retired)

> Retired in redesign phase 5: the page is gone and its route opens Statements. Its figures are now
> the M* / I* figures below (retired-ID table in docs/insights-redesign.md §7.8); kept here as the
> definition the old app versions still show.

For the selected PERIOD. Dues are all-time, not the period.

| ID | On screen | Definition |
|---|---|---|
| R1 | Total purchases | Σ BILL-TOTAL of purchases in the period (after labour); count. |
| R2 | Total sales | Σ BILL-TOTAL of wholesale + retail sales in the period; count. |
| R3 | Profit on goods sold | Same as F4 for the same period (one profit everywhere, #36). "—" while the cost of goods sold can't be worked out yet (as on Finance). Its margin (R3 ÷ R2) carries the same "sold before its purchase was recorded" note as Finance when some goods had no known cost, because the margin is then too high (e.g. "100% margin"). The CSV / PDF export use the same number. The Compare tab's "sales − purchases" is labelled as that, not as profit. |
| R4 | Cash | Σ BILL-PAY cash over the period's purchases **and** sales (money moved in cash, both directions). |
| R5 | Online | Same, online. |
| R6 | Due to pay | = F10. |
| R7 | Due to receive | = F9 (retail + wholesale). |
| R8 | Labour | Σ labour on the period's purchases. |

## Analytics (retired)

> Retired in redesign phase 5: the page is gone and its route opens Insights. Its figures are now
> the M* / I* figures below (retired-ID table in docs/insights-redesign.md §7.8); kept here as the
> definition the old app versions still show.

| ID | On screen | Definition |
|---|---|---|
| A1 | This month: revenue | Σ BILL-TOTAL of sales from the 1st of this month to now (dates read by `utils/dates.js`, #49 fixed). |
| A2 | This month: purchases | Σ BILL-TOTAL of purchases, same range. |
| A3 | This month: expenses | Σ business expenses (EXP-KIND), same range; count. Expenses dated `D/M/YYYY, h:mm:ss pm` (every expense the old app saved) are read by `utils/dates.js` (#49 fixed). |
| A4 | This month: profit | Same as F4 for the same range (#36). Its margin carries the "cost not known" note, as R3. |
| A7 | Profit trend (per day) | F4 split by day: each day's sales − cost of goods sold − business expenses − bad debts; the days add up to F4 for the whole range. |
| A5 | Total payable | = F10; count of bills with BILL-DUE > 0 (`outstandingTotals`, #220 fixed). |
| A6 | Total receivable | = F9; count of bills with BILL-DUE > 0 (`outstandingTotals`, #220 fixed). |

Analytics' customers (active buyers, top customers) group bills by PARTY. The cash prediction hides its confidence when there is no same-weekday history (its ₹0 then means "no data"). Smart suggestions name items (English or Hindi name), never ids; "low stock" lists only items whose stock was set at some point (a purchase or an opening stock adjustment) and is now below 10 kg.

Projections and predictions on Analytics are estimates and are not checked
here (#144 plans to redo them). "Projected profit" and the smart-suggestion
profit lines start from A4 (the month's profit so far, scaled to the whole
month); the "in loss" suggestion only shows when the month has sales.

## Outstanding (`templates/outstanding.html`, `modules/outstanding.js`)

| ID | On screen | Definition |
|---|---|---|
| O1 | Purchase dues per party | Σ BILL-DUE of that supplier's purchases. |
| O2 | Sale dues per party | Σ BILL-DUE of that customer's **retail** sales (❓ open: #130 — wholesale dues are on the Wholesale page today). |
| O3 | Payables total (aging panel) | Σ O1. |
| O4 | Receivables total (aging panel) | Σ O2. |

**Wholesale › Outstanding** (`modules/wholesale-sales.js`; wholesale dues are listed there, see O2) lists
the Wholesale page's bills (`source: 'sales-tab'`, OPENING records included) with BILL-DUE > 0. Each
shows BILL-DUE, the BILL-TOTAL (an OPENING record: its carried amount) and the cash + online received
(BILL-PAY), the same rule as this page and Money (Σ = the wholesale part of O4 / M15's "to receive").
It used to show `payment.due`, else total − received, so an old bill with only top-level
`cashPayment` / `dueAmount` showed its whole total as due, and a bill saved a few paise short showed a
₹1 due no other page had. Oracle: `tests/oracle/cross-page.test.js`.

## Stock (`templates/stock.html`, `modules/stock.js`)

Quantities and average costs come from the stock replay (`utils/stock-replay.js`, AVG-COST). Every figure the page shows is worked out by `utils/calc/stock.js` (function → ID in `STOCK_SPEC`); `modules/stock.js` only renders. The stock value has one function, `stockValue()`: the Stock page (S4, S6), Money › Worth (M15's stock term and M17, through `finance-calc`) and the Insights dead-stock card (S3 of each row, `findDeadStock`) use it. Tests: `www/js/__tests__/calc-stock.test.js`, `tests/oracle/screens.test.js` (Stock screen == oracle) and `www/js/__tests__/pages-characterisation.test.js` (exact screen text pinned).

| ID | On screen | Definition | Owner (`utils/calc/stock.js`) |
|---|---|---|---|
| S1 | Quantity | Replay of all purchases (+), sales (−) and adjustments in time order (AVG-COST rules). Opening stock is a "set" adjustment with reason "Opening stock" and a cost per kg (required), so cost of goods sold works from the first sale. With no stock at all the page says so and offers "Set opening stock". Buckets the replay keeps under a legacy name merge onto the catalogue item whose id, or trimmed lower-case English / Hindi name, matches; a bucket with no match is its own "Unmatched" row. | `stockRows()`; adjustment form: `adjustItemStock()` |
| S2 | Average rate | AVG-COST after the replay (0 when quantity ≤ 0); merged buckets: Σ (quantity × rate) ÷ Σ quantity. The adjustment form shows it only when there is stock at a known cost. | `stockRows()`, `adjustItemStock()` |
| S3 | Value per item | S1 × S2 when quantity > 0 (rounded to the rupee on screen). | `itemValue()` |
| S4 | Total value | Σ S3 = F6. | `stockValue()` |
| S5 | Adjustment value (Stock › Adjustments history card) | Quantity × the adjustment's own rate; when it has none, × the item's average rate now (S2). Not shown when the quantity was not recorded or no rate is known; rounded to the rupee. | `adjustmentValue()` |
| S6 | Dead stock value (Stock › Dead stock summary, "N items · ≈ ₹X in stock") | Σ S3 of the dead-stock rows (items with stock and no sale in the chosen days, `utils/dead-stock.js`), rounded to the rupee. | `deadStockValue()` |

## Cash drawer (`templates/cash-management.html`, `modules/cash-management.js`)

For one cash session's DAY. Only cash counts.

One pure module computes every figure and rule of the drawer: `www/js/utils/calc/cash.js` (field → ID in `CASH_SPEC`); `modules/cash-management.js` only gathers its inputs (loaded bills, expenses, the session, whether this phone has the personal rows and else the day's `personalExpenseDays` total), calls it and renders. Rounding is as before the move: C1–C6 add the stored amounts (paise of records saved before #129 included), the saved difference in paise; deposits and "No bill" entries are saved in whole rupees (MONEY-ROUND); the status card, the check under the count box and the day details add with plain JS addition. Tests: `www/js/__tests__/cash-characterisation.test.js` (screen text, history, day details and what closing, a late count, a "No bill" entry, a deposit, auto-close and opening write, pinned for `tests/fixtures/calculations/cash-days.json`) and `tests/oracle/screens.test.js` (page and `drawerDay()` vs the oracle).

| ID | On screen | Definition | Owner (`utils/calc/cash.js`) |
|---|---|---|---|
| C1 | Cash sales | BILL-AT-SAVE cash of that day's wholesale + retail sales. | `drawerDay().cashSales` |
| C2 | Cash purchases | BILL-AT-SAVE cash of that day's purchases. | `drawerDay().cashPurchases` |
| C3 | Expenses | That day's **cash** expenses (EXP-MODE; online ones never leave the drawer; no mode = cash), business and personal (untagged = business; an expense's `amount`). Personal ones a role can't read come from that day's `personalExpenseDays` total less its online part (#98, #118). | `drawerDay().businessExpenses`, `personalExpenses` |
| C4 | Due received | Cash part of DUE-PAYs received that day (bill entries and session legs, each id once). A "No bill" entry is a cash-only leg (`noBillLeg()`). | `drawerDay().dueReceived` |
| C5 | Due paid | Cash part of DUE-PAYs paid that day. | `drawerDay().duePaid` |
| C6 | Deposits | Σ cash added to the drawer that day (❓ open: #103, what a deposit means). | `drawerDay().cashDeposits` |
| C7 | Expected cash | Opening + C1 + C4 + C6 − C2 − C5 − C3 (0 without a session). Status card: cash in = opening + C6 + C1 + C4, cash out = C2 + C5 + C3, others = C3 + C5. | `expectedCash()` (`sessionTotals()`), `drawerStatus()`, `signOutSummary()`, `sessionDetail()` |
| C8 | Difference | Counted cash − C7 (shown as short / extra). Under the count box: "matches" within ₹1, plus the Q19 bands (a big gap, a negative expected drawer); closing asks first when more than ₹1 off and saves it in paise (also a late count); colour: under ₹50 ok, under ₹500 warn, else high. Opening asks first when more than ₹1 from C9. | `countCheck()`, `closeCheck()`, `savedDifference()`, `differenceBand()`, `openingCheck()` |
| C9 | Counted cash | Closing balance of the last signed-out, counted session (not "not counted"); the drawer term of M15. | `lastCountedSession()` |

## Insights › Seasons: Trends and Product traffic (`templates/rate-trends.html`, `modules/rate-trends.js`) — #65

Owner/manager only. Pure code: `utils/rate-trends.js`, `utils/item-rate-series.js`,
`utils/product-traffic.js`. Oracle: `tests/oracle/rate-trends.test.js`.

| ID | On screen | Definition |
|---|---|---|
| RT-WEEK | A week | IST week, Monday 00:00 to Sunday 23:59, named by its Monday. A week that spans two years belongs to the year of its Monday. |
| RT-MONTH | A month | IST calendar month. |
| RT-LINE | Bill line used | A purchase / retail / wholesale bill line with kg > 0 (`qty`, wholesale `quantity`) and a rate > 0 (`rate`, else `total` ÷ kg), matched to a catalogue item by item id, else by English or Hindi name. Deleted bills are not counted. Bill time = numeric `timestamp`, else the bill date (ISO or `DD/MM/YYYY`, local time). |
| RT1 | Rate estimated from bills (dotted line) | For an item, a type and a week or month: Σ (kg × rate) ÷ Σ kg of its RT-LINEs (kg-weighted, not a simple mean). Shown up to and including the cutoff week/month. Stored per item per year in `rateStats/{itemId}_{YYYY}` (`weeks.wYYYY-MM-DD`, `months.mYYYY-MM`), built once from all bills and kept current from loaded bills (current and previous month, and the weeks they cover). |
| RT2 | Rates-page rate (solid line) | Base rate = the **first** rate in the item's list (purchase `rates`, wholesale `wholesaleRates`, retail `saleRates`). Day rate = the base rate in effect at the end of that IST day, rebuilt backwards from today's list through the Rates-page change history (row edits, edit dialog and Excel import). Each change records its list position, so a deleted first rate or a value that also appears elsewhere in the list is undone in the right place; changes saved before positions were recorded fall back to the first equal value, and a removed rate without a position goes back at the end. Week / month value = average of the day rates of its days from the cutoff day to today (days with no rate left out). If the change history can't be read, today's base rate is used for every day. |
| RT-CUT | Cutoff | When the one-time history from bills finished (`rateStats/_meta.backfillAt`). Before it, all rate lines are RT1. |
| RT3 | Margin per kg | Sale rate (RT1 over retail + wholesale together, kg-weighted) − purchase rate (RT1), from bills, every period. |
| RT4 | Bought / sold kg, bills | Σ kg of purchase RT-LINEs; Σ kg of retail + wholesale RT-LINEs; number of bills with the item (each bill once per period), from bills, every period. |
| RT5 | Next weeks estimate | From this IST month to the month the chosen 4/6/8 weeks end in, in each of the last 10 years: the % change of the monthly rate line, where both months use the same source, chained through the cutoff month when they are on different sides of it (RT1 from → cutoff × RT2 cutoff → to), so the jump between bill averages and the Rates-page rate is not counted. Average % → UP / DOWN / about the same (±2%); confidence high when ≥ 3 years and all agree, medium when ≥ ⅔ agree, else low. Needs at least 2 years. |
| PT1 | Product traffic: month overview | Per item, for the chosen month: purchase / wholesale / retail kg, bills and amount (Σ kg × rate) from RT-LINEs; kg moved = purchase + wholesale + retail kg; amount = Σ of the three. Items ranked by kg moved; items that didn't move are left out. |
| PT2 | vs last month / vs same month last year | (kg moved ÷ kg moved in that month − 1) × 100, rounded; "—" when the item didn't move then. |
| PT3 | Day by day | For one item and month, from the bills loaded on the device: kg and bills per type per IST day (same RT-LINE rules, so the days add up to PT1). Week totals within the month are days 1–7, 8–14, 15–21, 22–28, 29–end. Months older than the loaded bills show PT1 totals instead. |
| PT4 | Week by week | For one item, the last 12 / 26 / 52 / 104 RT-WEEKs: kg and bills per type, 0 when nothing moved. |

## Rentals → Rent (`templates/rentals.html`, `rentals/rentals.js`, `rentals/rent-math.js`) — #170

Rentals money is separate from the shop: none of these numbers feed Finance,
Reports or the cash drawer. A **charge** is one month's rent of one lease
(`rent_charges/{leaseId}_{YYYY-MM}`), created once per month from the lease's
start month (at most 24 months back); amount = the lease's rent + that month's
electricity (RENT-7); its due = amount − paid (never below 0). Move-out keeps
charges only up to the last month (never in the future).
Oracle: `tests/oracle/rent.test.js`.

| ID | On screen | Definition |
|---|---|---|
| RENT-1 | Rent this month | Σ amount of this month's charges. |
| RENT-2 | Collected this month | Σ paid on this month's charges (payments for older months are not counted here). |
| RENT-3 | Still due this month | RENT-1 − RENT-2. |
| RENT-4 | Total due (all months) | Σ due of every charge up to this month, including tenants who moved out. |
| RENT-5 | Per tenant | Σ due of that lease's charges, oldest month first; a month is *Late* after its due day (default the 10th, per lease), *Part paid* when 0 < paid < amount. Record payment: the amount is a whole rupee, half-up (MONEY-ROUND), except exactly a due with paise (a charge saved before #129), which is paid off as it is (DUE-CHECK's rule, `rent-math.applyPayment`). |
| RENT-6 | Rent increase due | One year after the start DATE (lease `startDate`; older leases: the start month), or — once the rent has been changed — 12 months after the month the new rent applied from (`rentSince`): "Rent increase due: p% → ₹X", X = round(rent × (1 + p/100)), p per lease (default 5). Only a reminder; the rent changes when someone saves the new rent, from the next month's charge. |
| RENT-7 | Electricity | Per lease mode: **Meter, billed by us** (older leases) — per unit sub-meter, units = current − previous reading, amount = units × rate per unit, the units to 2 decimals and the amount a whole rupee, half-up (MONEY-ROUND, #129: 123 units × ₹7.35 = ₹904.05 → ₹904; `meterAmount()`; the rules accept it within ₹0.51 of units × rate, so older app versions' paise amounts still save), added to that month's charge; saving again replaces it. **Included in rent** and **Own meter (tenant pays the board directly)** — no electricity amount, no readings (the rules refuse a reading). |
| RENT-8 | Tenant link page (`/r/<token>`), per month | rent = the month's rent; electricity = RENT-7 amount (units); total = rent + electricity; paid = Σ payments; due = total − paid; status Paid / Part paid / Due / Late as RENT-5, worked out on the page when it opens (month, that month's due day, due); paid on = the payment dates (each payment's date and amount with its receipt number, RENT-12, once the month has a receipt; none for a cancelled one). Cards: rent = the lease's current rent; total due = Σ due of the shown months (up to 36, newest first); paid = Σ paid of the shown months. Moved out → banner with the last month. |
| RENT-11 | First month's rent (move-in, Add unit with its tenant) | The first charged month is the month of the start DATE. Default: the **full** monthly rent (usual practice), even when the start date is after the due day. With "Pro-rate first month" ticked: rent × (days from the start date to the end of that month, both included) ÷ days in that month, rounded to the rupee (stored on the lease as `firstRent`, never above the rent). Later months: the full rent. Late for the first month follows its due day as RENT-5. |
| RENT-10 | Unit row (Rent → Unit wise, and each unit in a property) | For one unit and this month, over the loaded charges whose unit is this unit (also a tenant who moved out this month): rent this month = Σ amount of this month's charges; collected = Σ paid of them; pending = rent − collected (not below 0); due = Σ due (RENT-4) of its charges up to this month; Late when the tenant living there now has an open month past its due day; status Vacant (no active lease) / Late / Paid (nothing due) / Part paid (this month part paid) / Due. Type: flat, commercial, office, godown, other (no type yet = flat). |
| RENT-9 | Property summary and page totals (Property wise cards, a property's header, Unit wise totals of the shown rows) | Σ of the RENT-10 rows they cover: units, units by type, occupied / vacant, late (units marked Late), rent this month, collected, pending (= rent − collected), due. The page totals are Σ over all units, so they equal Σ of the property cards and, when every charge's unit still exists, RENT-1 / RENT-2 / RENT-4. |
| RENT-12 | Rent receipt (after Record payment; Receipts on a tenant; WhatsApp, print, image, PDF) — `rentals/rent-receipt.js` | One receipt per payment, issued in the payment's own write (or later with Issue receipt for a payment saved without one). Number `R-<year>-<seq>`: year = this year in IST by the server's clock; seq = the business's counter for that year + 1 (`rent_counters/receipts_<year>`), so numbers are unique and have no gaps. Month = the charge's month; rent = the month's rent; electricity only when the month has a meter bill (RENT-7: previous → current reading, units × rate, amount); total = the month's amount (rent + electricity); paid now = this payment; paid earlier = total − paid now − balance (shown when > 0); balance due = total − Σ payments of the month when the receipt is issued, including this one (never below 0; with the payment that is the balance after it); mode as recorded (cash, or online: UPI / bank; cheque); Ref = the payment's UPI / cheque reference, shown only when there is one. Not GST, no tax lines. Amounts with paise when there are any. A cancelled (void) receipt keeps its number and is marked *Cancelled*; the payment is not changed. Amounts: `rent-math.receiptAmounts` (written with the receipt), `paidEarlier`. Oracle: `tests/oracle/rent-receipt.test.js`. |
| RENT-13 | Change of unit: the move month (Tenants › Edit or Move in → another unit; "Pro-rate move month", ticked by default) — `rentals/rent-unit.js` | A move on day D of month M (not the 1st): the old unit's charge for M becomes rent = round(R × (D − s) ÷ (days in M − s + 1)) — the days up to the day before the move — where R = that charge's rent and s = 1 (or the old lease's start day when M was its pro-rated first month, RENT-11); amount = that rent + the month's electricity (RENT-7). When more than that is already paid, the old month closes at what is paid (rent = paid − electricity, amount = paid, nothing more due there), and a fully paid month stays as it is; this is also applied to the charge as re-read in the change transaction (a payment made meanwhile), and to an owner/manager amount below what is paid. The new unit's first month is RENT-11 pro-rated from D: round(new rent × (days in M − D + 1) ÷ days in M). Both are filled in; an owner/manager may change them (old: 0 … R, new: 0 … the new rent), members get the worked-out values (the rules accept exactly that for them, or the paid cap above, in the change write only; a member's new-lease firstRent must be the RENT-11 value). A move on the 1st: the old lease ends with the month before, so there is no old-unit charge for M and the new unit pays the full month. Unticked: both units the full rent for M. Oracle case: rent 6,000 on both, move on 16 Oct 2026 (31 days): old 6,000 × 15 ÷ 31 = 2,903, new 6,000 × 16 ÷ 31 = 3,097 (together 6,000); paid cap: rent 5,000 with 3,000 paid and a share of 2,419 closes at 3,000 (0 due), fully paid stays at 5,000; `tests/oracle/rent.test.js`. Code: `rent-math.moveMonthRent`, `moveMonthSplit`, `oldMonth`, `changeUnitPlan`. |

---

## Calculation layer: Money (M*) and Insights (I*) (`utils/business-metrics.js`) — redesign

One pure module computes every figure of the Money, Insights and Statements
pages (docs/insights-redesign.md §7); pages only render. Owner choices are
constants in `utils/insights-config.js` (overridable in `settings/app.insights`).
Oracle: `tests/oracle/business-metrics.test.js`; accounting checks:
`tests/property/business-metrics.test.js`; real data: `npm run audit:numbers`
(pages "Money (layer)", "Money screen", "Insights (layer)"). Each figure has one home
(`utils/metric-registry.js`).

**Money page** (`templates/money.html`, `modules/money.js`) is the home of M1–M17. Each
headline shows CMP against the previous period (from the loaded bills) and the same dates last
year (from the bills when loaded, else from the month snapshots `monthStats/{YYYY-MM}`: one doc
per month with M*, per-item and top-party totals and per-day sales and profit, built once by the
owner and rolled for the current and previous month every 6 hours, `utils/month-snapshots.js`).

**Stale month snapshots.** Saving, editing or deleting a bill, stock adjustment, expense or
withdrawal dated before the current month marks the snapshot of its month (old and new date)
`stale` with one merge write per month (`FirebaseService` `noteMonthWrite`; any approved user may
write only `{ month, stale: true, staleAt }`, firestore.rules). When the bill's stock changes, every
later month through the previous one is marked too, since its average cost (COGS, M2, M3, M6) moves.
Only months the app reads (two years back) are marked. A payment or write-off is not: it counts on
its own day, today. A stale snapshot gives no figures (`figuresFromSnapshot`, `partialFigures`,
`snapshotCustomers` return null), so every comparison, chart month and "vs last year" from it is
"not known" until it is rebuilt. An owner/manager device rebuilds it with no bill reads: the previous
month on the next roll; an older month once that device has all bills loaded and read after it saw
the mark (e.g. after the stock-checkpoint rebuild a stock change triggers), in a transaction that
keeps a newer mark (1 read + 1 write); or with "Build month history", which reads the bills again
if they are older than the mark and writes each month it can mark (the last two years before the
previous month, ≤ 23 reads) in such a transaction: a mark this device has not handled, e.g. one set
by another phone after the snapshots were loaded, is kept and shown "not known" until the next build.

"Loaded bills" on a phone: bills from the 1st of the previous month, older bills that still owe
(`openDue`), and older bills paid or written off since then (`paidAt` ≥ that day, stamped by every
payment and write-off; bills paid by older app versions are pinned by the stock-checkpoint rebuild),
so a due settled inside the window still counts in M5, M12–M14, the day book and the month snapshots
rolled from it (#163).

**Insights page** (`templates/insights.html`, `modules/insights.js`) is the home of I1–I9: a to-do
list (overdue parties, sold below cost, low-profit items, stock up before the season, dead stock),
items, parties and seasons. Seasons hosts the Rate trends and Product traffic views (RT*, PT*): the
same module and DOM as on the Rates page, moved with `RateTrendsManager.mount()`, on the shared
period and item (`utils/insights-context.js`).

**Statements page** (`templates/statements.html`, `modules/statements.js`, rows from
`utils/statements.js`) produces documents on request; their totals are marked `data-metric-export`
and close on the figure of the home page:

| ID | Statement | Closes on |
|---|---|---|
| ST1 | Day book: every bill, expense, withdrawal and due payment of one day, in time order. An expense row is cash or online by its mode (EXP-MODE). Due payments come from the bills and that day's cash-session legs (de-duplicated by id, as M12), so a payment on a bill that is no longer loaded is listed; until the sessions load it says payments may be missing. For today it lists them with a link to Today and no totals (Today is their home), on screen, in WhatsApp and in the CSV | Today T1, T2, T13, T14 (expenses = T4 + T5) |
| ST2 | Month statement: the Money ladder, money in / out and spending of one month (with that month's cash sessions, as Money › Cash; "payments may be missing" until they load) | M1–M17 of that month |
| ST3 | Party ledger: bills (+), paid with the bill, later payments, write-offs and "marked cleared" (−), running balance; old-app balances start at their carried amount | Σ BILL-DUE of the party's bills (Outstanding) |
| ST4 | Item ledger: purchases, sales and corrections of one item with running kg and AVG-COST; flags a sale below cost or before the stock was bought | S1, S3 |
| ST5 | CSV: one row per bill line; labour shared by line value. Dates `YYYY-MM-DD HH:mm`; text starting with = + - @ gets a leading ' (no formulas); headers in the app language or English ("CSV in English", device setting `aadhat.csvEnglish`); lines a role may not see (profit, personal expenses, stock value, purchase rates) are left out of the screen, WhatsApp, Print and CSV. | Σ amount = M1 (sales), M16 (purchases); Σ labour = M7 |

| ID | On screen | Definition |
|---|---|---|
| M1 | Sales | Σ BILL-TOTAL of wholesale + retail bills with BILL-TIME in the period (OPENING left out); BILL-COUNT; split retail / wholesale; "of which still due" Σ BILL-DUE. Same as F1. |
| M2 | Cost of goods sold | Σ COGS of the period's sale lines. Same as F2. |
| M3 | Gross profit | M1 − M2; "profit per ₹100 sold" = M3 ÷ M1 × 100. |
| M4 | Business expenses | Σ business expenses (EXP-KIND), by category (the expense `type`; untagged ones are their own row). Same as F3. |
| M5 | Bad debts | Dues to receive written off in the period, on the write-off date (as in F4). |
| M6 | Profit | M3 − M4 − M5. **The** profit (#36); same as F4. "—" with a caveat while the cost of goods sold isn't known. |
| M7 | Labour on purchases | Σ labour on the period's purchases = T-LAB-1 over the period (`labourSummary()`). Each bill's labour is read by `billLabour()` (`laborCharges`, older bills `labour`) everywhere: Spending, its breakdown, Statements, month snapshots, items and parties. **Not** subtracted from profit (owner decision 2026-10-26). Shown on Money › Spending with M18. |
| M8 | Personal expenses | Σ expenses tagged personal. Same as F5. |
| M9 | Withdrawals | Σ withdrawals dated in the period. Same as F11. |
| M10 | Kept in business | M6 − M8 − M9. |
| M11 | Profit by month / day | M6 per calendar month (13 months, last year faint) and per day of a month; the days add up to M6. A month from a stale snapshot has no bar until it is rebuilt; owners and managers see why and a "Build month history" button. |
| M12 | Money in | BILL-AT-SAVE of the period's sales + DUE-PAYs received; split cash / online. |
| M13 | Money out | BILL-AT-SAVE of the period's purchases + DUE-PAYs paid + all expenses; split cash / online, expenses by their mode (EXP-MODE; no mode = cash). |
| M14 | Net money in / out | M12 − M13. Same as F7. |
| M15 | Net worth | S4 + O4 + other accounts (owner-entered) + last counted drawer cash − O3 (owner decision #39, 2026-10-26; `netWorthTerms`). Each due counted once. |
| M16 | Purchases | Σ BILL-TOTAL (after labour) of purchases with BILL-TIME in the period; BILL-COUNT; line value before labour and M7 as its two parts. |
| M17 | Stock movement check | Opening stock value + purchases at their saved line amounts (AVG-COST; the screen says "at line rate") − M2 ± adjustments = closing (as F8). |
| M18 | Labour to pay | T-LAB-2 for each day of the period (purchase bills by BILL-TIME, local day), each day rounded up on its own, summed (`labourToPayByDay()`). Money › Spending shows it under M7 with T-LAB-3's more / less / matches. |
| I1 | Item sales and profit | Per catalogue item: Σ sale line totals, Σ their COGS, profit = sales − COGS, profit per ₹100 (AC10). |
| I2 | Retail / wholesale | I1 split by bill type. |
| I3 | Sales by customer | Per PARTY: Σ BILL-TOTAL, BILL-COUNT, last bill (AC11). "Stopped coming": bought in each of the same 3 calendar months last year, no bill for 60 days (`stoppedComingDays`). Months of last year that are not loaded use that month's snapshot customer list; when that list was cut to the top 50 customers (`m.Cc` = how many the month had; older snapshots with a full list count as cut), the snapshot is stale, or with neither, the answer is unknown and the page asks to load older bills, never "every regular came". Item "vs last year" from snapshots only when both periods are whole months, else "—". |
| I4 | Purchases by supplier | Per PARTY: Σ BILL-TOTAL after labour, labour, kg, last bill. Item rows share each bill's labour by line value, so they add up to M16 (#47). |
| I5 | Season index | Per item and calendar month: kg sold that month ÷ the item's average monthly kg (RT4 `rateStats` months); needs 12 months. ≥ 1.5 busy, ≤ 0.5 quiet. |
| I6 | Biggest change | The item (or category) with the largest absolute change between two periods; used in takeaway sentences only. |
| I7 | Low-profit items | Items with sales ≥ ₹5,000 in the period and profit per ₹100 under 3 (`lowMarginMinSales`, `lowMarginPer100`), or a loss. |
| I8 | Sold below cost | Sale lines (bill × item) whose value is below their cost of goods sold, per item: times, kg, ₹ lost. |
| I9 | Stock up before the season | Items whose busy month (I5) is within the next 8 weeks while the stock covers fewer weeks than it takes to get there + 4. Weekly kg = kg sold in the last 8 weeks ÷ the weeks of bills actually loaded (at most 8); no card under 2 loaded weeks. With fewer than 8 weeks loaded (a phone's window starts on the 1st of the previous month) the card says it is an estimate "from the last N weeks of bills loaded", N = the loaded weeks rounded to a whole number (#164). |
| I10 | Overdue parties | Parties with an open BILL-DUE older than 30 days (`overdueDays`): count, total, oldest; customers and suppliers separately. |
| I11 | Purchases by item | Per catalogue item: line value, labour share (labour × line value ÷ the bill's line value), amount after labour, kg. Rows add up to M16 (#47). |
| I12 | Top-5 share (Insights › Parties takeaway, "Top 5 customers gave X% of sales" / suppliers) | Σ of the five biggest named parties' I3 (or I4) totals ÷ Σ of all parties' totals in the period (walk-in / unnamed bills count in the total, not in the five) × 100, rounded. Not shown when the total is not above 0. |

Which function computes each of these (all pure, in `utils/`; the pages only render):

| Function | IDs |
|---|---|
| `business-metrics.moneySummary` | M1–M10, M12–M14, M16, M17 |
| `business-metrics.netMoneyByDay` | M14 per local day (Money › Cash chart; the days add up to M14) |
| `business-metrics.netWorth`, `accountsTotal` | M15 (and its "other accounts" term) |
| `labour.labourSummary`, `labourToPayByDay`, `periodLabourGap` | M7, M18, T-LAB-3 for the period |
| `business-metrics.itemSummary`, `sharePct` | I1, I2 (and the retail / wholesale % of M1) |
| `month-snapshots.snapshotItemSales` | I1 "vs last year" from month snapshots (whole months) |
| `business-metrics.partySummary`, `topShare` | I3, I4, I12 |
| `business-metrics.soldKgByMonth`, `seasonKgTotal`, `seasonIndex` | I5 |
| `business-metrics.weeklyKgWindow`, `weeklyKgByItem`, `stockUpItems` | I9 (weekly kg over the loaded weeks, at most 8) |
| `business-metrics.addsUp` | AC10, AC11 (the "add up" check line on Money and Insights) |
| `business-metrics.roundTo` | display rounding only: profit per ₹100 (M3, I1, I7) and season index / weeks of cover to 1 decimal, kg to whole numbers |

## Diagnostics › Status (owner; not money) — #119, #83

Counts about this phone, never business figures. Nothing is read from the server.

| ID | Shown | Definition |
|---|---|---|
| DIAG-IO | Reads / writes sent / writes refused or failed / reads failed / app errors | Since the app opened: reads as in "Data reads" (`firestore-meter`); each `set`, `update`, `delete`, `add` and batch commit once, a transaction once when it wrote something; a refused or failed write (for a transaction only the database's own errors, not the app's checks) or failed read/listener once (`getIoCounts`); each caught error that is not a toast or a warning (`TelemetryService.sessionErrors`) |
| DIAG-SYNC | Changes waiting to sync / last change reached the server | The header pill's pending count (`ui/sync-status.js`); the last time one of this phone's writes was acknowledged by the server (meter) or the pill confirmed "Synced" |
| DIAG-SCORE | Speed score | 100 − 25 per high − 12 per medium − 4 per low suspect from `utils/perf-probe.js analyseProbes`, never below 0. Suspects: history list ≥ 3,000 (high) / ≥ 1,500 (medium), items ≥ 800, stock entries ≥ 1,500, memory ≥ 80% (high) or ≥ 250 MB, phone memory ≤ 2 GB, offline or 2G (high), no service worker (low), app open ≥ 5 s, ≥ 8 long tasks in the last minute (high), app storage ≥ 85% |

## Settings › Usage on this phone (local only, not money) — #136

| ID | Shown | Definition |
|---|---|---|
| USE-1 | Uses per feature, Today / Last 7 days / Last 30 days | For each documented event (`utils/usage-stats.js` `USAGE_EVENTS`, and `page.<id>`) the sum of this phone's daily counts from the first day of the range to today (local days), most used first (ties by name), top 10. One `track()` call counts 1; the counts stay in IndexedDB on the phone (localStorage without it) for 90 days and are never sent |
## Admin › Users: counts and activity by person (owner) — #145

| ID | Shown | Definition |
|---|---|---|
| ADM-1 | Owner · Managers · Members · Waiting for approval · Removed | From the people list already loaded: removed or rejected (`isRemovedProfile`) → Removed; else no role or `status: pending` → Waiting; else by role (`staff` = Member) |
| ADM-2 | Bills, Bill total per person | Bills on this phone (purchases, retail, wholesale) that count (`activityBills`: not voided, not opening records) saved by that person (`userId`, wholesale `createdBy`) with their first-save time (`createdAt`, else `timestamp`, else the bill date) in the range [from, to) of local days; total = Σ BILL-TOTAL, rounded to whole rupees at the end |
| ADM-3 | Payments, Edits, Voids, Last active | That person's audit entries in the range: payments = `RECORD_PAYMENT` + `UPDATE_PAYMENT` + `CLEAR_DUE`, edits = `EDIT_BILL` + `EDIT_SALE`, voids = `VOID_BILL`; last active = their latest bill (ADM-2) or audit entry in the range. Ranges: Today, Last 7 days (today and 6 days before), This month (from the 1st), Last month. One read per tap of the range's audit entries (`timestamp` in [from, to)), at most the newest 300 (the page says so when it hits that) |

## Checking real data

`npm run audit:numbers -- <backup.json>` (`tools/audit/`, local only, never in CI) runs the oracle and
the app's own calculations side by side on a backup file for each of the last 60 days, the last 24
months and all time, plus the accounting checks below, cross-page agreement and the Diagnostics number
checks; `--bundle` adds a migration bundle's opening records. Shapes it finds become anonymised fixtures
(`tests/fixtures/calculations/real-shapes.json`, `tests/oracle/real-shapes.test.js`), skipped with their
issue while the app differs.

It also runs the **phone path** (`tools/audit/phone.js`): what a phone actually has in memory. The app's
own `FirebaseService` runs against an in-memory Firestore seeded with the backup as it stood at each of
several "today"s (the backup's moment; the 1st, 2nd and 15th of a month; 31 March; 1 January;
`--phone-dates` to choose, `--no-phone` to skip): the window from the 1st of the previous month, older
bills that still owe, the stock checkpoint the owner's device builds, month snapshots (`monthStats`)
rolled at every month end as a phone in use since the first bill would have rolled them, the rate
history (`rateStats`, backfill + roll-forward) and cash sessions from their loaders. Each day is opened
three ways: the owner with a checkpoint rebuilt that day; the owner with the checkpoint built at the
previous month end (rolled forward or rebuilt by its startup maintenance, as the app does); a member
(`staff`, with Money, Statements and Insights switched on) with that month-end checkpoint, which it may
not rebuild, and no month snapshots. Every Money (period, previous period, last year, the 13-month chart,
the stored snapshots, M15 net worth with its drawer term C9 and accounts, M17 opening / closing), Insights
(items with I2 retail / wholesale and "vs last year", I7 low profit, I8 sold below cost, I11 purchases by
item, parties, stopped coming, stock-up weekly kg, overdue, season kg), Statements (month statement, day
book with each due payment once) and Today figure is then taken from the app's modules and compared with
the oracle on the full data of that moment. Today's expected figures use the backup's session for that
day; that the app loaded every session of the day (and the drawer's legs) is checked on its own, as are the sessions Money and the day
book load for a period. A figure the app leaves out and says so ("not loaded", "—", "Nothing to compare
with yet", approximate) is counted as *shown as unknown*, never as a number; one it leaves out without
saying so on screen is a mismatch (`*_hidden`), as is a number that differs. Fixture: the hand-made
records of `tests/fixtures/calculations/phone-path.json` plus a seeded 15-month history generated at
test time (`tests/fixtures/calculations/phone-path-history.js`: whole-month snapshots for last year,
cash sessions with due-payment legs, two sessions on one day, bills from before the window paid by an
older app), `tests/oracle/phone-path.test.js`. The phone's Firestore there also holds a voided copy of
every hand-made bill (VOID); the oracle compares without them (`O.withoutVoided`), so each figure above
must leave them out, and none may reach AppState's bill lists. `tests/oracle/screens-voided.test.js`
runs every screen test of `screens.test.js` again with a voided copy of every bill in AppState.

- VOID: a voided bill is left out of everything, by the oracle (`withoutVoided`) and by the number audit
  (`tools/audit` compares the app on the backup as it is with the oracle on the backup without them).

- Opening records (`openingBalance`, written by `tools/migrate`, dated with the old bill's date) are
  left out of every period figure and count only in dues (F9, F10, R6, R7, A5, A6, O1–O4); a payment on
  one is a normal due payment on its day. The oracle follows this; ❌ the app counts them in Today
  (T1/T2 counts, T15, T16), Reports (R1/R2 counts, R4) and Finance (F1 count) until PR #18
  (`fix/opening-records-excluded`) is merged, which also adds the full OPENING definition here.
- The oracle does not model stock that goes below zero (AC8); there the app writes the uncosted units
  off (#215), so cost of goods sold, profit and stock value differ for those items.

## Accounting checks (always true)

These must hold for any data. They run as property tests on generated
multi-year histories (`tests/fixtures/generator.js`) and, for the loaded data,
in Diagnostics → Number checks.

| ID | Check |
|---|---|
| AC1 | Opening stock value + purchases − cost of goods sold ± adjustments = closing stock value (any period). |
| AC2 | For every bill (OPENING records excepted: they are a due with no total): cash + online + due (+ written off) = BILL-TOTAL, within ₹1. |
| AC3 | For every bill: BILL-AT-SAVE + Σ `payments[]` = cash and online on the bill. |
| AC4 | Σ over months = all time (sales, purchases) on Reports and Finance. |
| AC5 | Outstanding total = Σ BILL-DUE of open bills, OPENING records included (Outstanding and Money › Worth agree); OPENING records age from their original bill date. |
| AC6 | Drawer expected cash = opening + cash in − cash out for the day. |
| AC7 | Same period, same number: Today, Reports, Analytics, Finance and the drawer agree on sales and cash; Finance profit, cost of goods sold and cash flow match the oracle every month. |
| AC8 | No item's stock goes below zero unless a sale was saved past the oversell warning. |
| AC9 | Adding OPENING records changes no period or activity figure (Today, Reports, Finance, Analytics, stock, bill counts); only the dues change. Today's due to receive = Σ BILL-DUE of that day's real bills. |
| AC10 | Items add up: Σ I1 over items = M1 and Σ item cost of goods sold = M2 (a bill whose total differs from its lines adds one "bill adjustments" row). |
| AC11 | Parties add up: Σ I3 = M1; Σ I4 = M16. Purchase item rows (labour shared by line value) add up to M16 (#47). |
| AC12 | Money › Worth terms equal their homes: stock = S4, to receive = O4, to pay = O3. |
| AC13 | Single home: no figure is rendered as a value by two templates (`utils/metric-registry.js`, `metric-registry.test.js`). |
| AC14 | One bill count: BILL-COUNT is the same for the calculation layer, Reports, Finance and the oracle for any period. |

---

## Worked example (`tests/fixtures/calculations/shop-month.json`)

"Now" is 21 Oct 2026, 3 pm. Two items, Rice and Wheat. Four OPENING records (Test Party A ₹2,50,000 dated today, Test Party B ₹100 from January, a ₹5,000 payable and a ₹2,000 wholesale due) only raise the dues: F9 = R7 = A6 = ₹2,53,500, F10 = R6 = A5 = ₹5,600, O2 adds Test Party A and Test Party B, O1 adds Old Supplier; every other number is the same as without them.

**Stock replay (AVG-COST)**

| When | Record | Rice qty / value | Wheat qty / value | Cost of goods sold |
|---|---|---|---|---|
| 28 Sep | Purchase 100 kg rice @ ₹30 | 100 / 3,000 | | |
| 30 Sep | Retail 2 kg rice (cleared) | 98 / 2,940 | | 60 |
| 05 Oct | Purchase 50 kg "गेहूं" @ ₹26 | | 50 / 1,300 | |
| 10 Oct | Wholesale 60 kg rice (`quantity`) | 38 / 1,140 | | 1,800 |
| 12 Oct | Remove 2 kg wheat (spoiled) | | 48 / 1,248 | (adjustment −52) |
| 15 Oct | Retail 5 kg rice | 33 / 990 | | 150 |
| 20 Oct | Retail 10 kg "wheat " (`20/10/2026`) | | 38 / 988 | 260 |
| 21 Oct 9 am | Purchase 40 kg rice @ ₹32 | 73 / 2,270 | | |
| 21 Oct 10:30 | Retail 10 kg rice + 5 kg wheat | 63 / 1,959.04 | 33 / 858 | 310.96 + 130 |

Check line (all time): 0 + 5,580 − 2,710.96 − 52 = **2,817.04** = 1,959.04 + 858.

**Finance, all time:** sales 2,160 + 550 + 300 + 200 + 80 = **3,290**; COGS
**2,710.96**; business expenses 120 + 500 + 50 (untagged) = **670**; profit on
goods sold 3,290 − 2,710.96 − 670 = **−90.96**; personal 80 + 1,000 = **1,080**.
Cash flow: in 1,160 + 300 + 300 (+ 50 due received) = 1,810; out 2,988 + 300 +
1,274 (+ 400 due paid) + 670 + 1,080 = 6,712; **−4,902**. (Before #215 the app showed
3,290 − 5,562 − 620 − 1,130 = −4,022; fixed by #215.)

**Today (21 Oct):** purchases 1,274; sales 550; labour 6; business expenses
120 + 50 = 170; personal 80; cash in 200 + 50 (due) = 250; online in 100;
cash out 0 + 250 (expenses) + 400 (due paid) = 650; online out 1,274; total in
350, total out 1,924, net outflow 1,574; due received 50, due paid 400; due to
receive 250, due to pay 0.

**Cash drawer (21 Oct):** opening 1,500 + cash sales 200 + due received 50 +
deposit 500 − cash purchases 0 − due paid 400 − expenses 250 = **1,600**. The
two due payments appear both on their bills and as session legs; each counts
once.
