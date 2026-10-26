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
test in the same PR (see AGENTS.md → PR checklist).

---

## Building blocks

| ID | Name | Definition |
|---|---|---|
| BILL-TOTAL | Bill total | What the bill is worth. **Purchases:** the total after labour is taken off (`grandTotal`). **Sales:** the sale total (`total`). Older bills: the first of `grandTotal`, `amountPayable`, `total`, `billTotal`, `saleTotal` that is present. |
| BILL-PAY | Cash / online / due on a bill | Taken from `payment.cash/online/due` when present (it is kept up to date when a due is paid later); otherwise from `cashPayment` / `onlinePayment` / `dueAmount`. Very old bills only have `amountPaid` (cash): their due is total − paid. |
| BILL-AT-SAVE | Paid when the bill was saved | Cash / online on the bill minus every later due payment in `payments[]`. Later payments count on the day they were made, not on the bill's day. |
| BILL-DUE | Still owed on a bill | BILL-PAY due, never below 0, and 0 when the bill is cleared or written off. |
| DUE-PAY | Due payment | One entry in a bill's `payments[]` (cash and/or online; entries before #107 have only `amount`, which is cash), or the same payment as a leg in the cash session's `duePayments`. The same payment id is counted once. A write-off (`kind: 'writeOff'`) is never money. |
| EXP-KIND | Business or personal expense | Personal only when the expense is tagged personal. Anything else — including old expenses with no tag — is business and should be shown as "uncategorised" (owner decision #36). |
| DAY | A day | Local (IST) calendar day, midnight to midnight, using the bill's own date (❓ open: #99 asks whether "Today" should follow the open cash session instead). Dates may be ISO, `DD/MM/YYYY` or `DD/MM/YYYY, h:mm:ss am`; all mean local time. |
| PERIOD | This week / month / year | Calendar period up to now: week from Monday, month from the 1st, year from 1 January (owner decision #43, 2026-10-26: calendar month; `insights-config.js` `monthMode` / `yearStartMonth` can switch to the last 30 days or an April year). "Last 7 / 30 days" would be labelled so. |
| AVG-COST | Average cost of an item | Weighted average: each purchase adds its quantity at the line rate; each sale removes quantity at the average cost of that moment; adjustments add (at their rate), remove (at average cost, never below zero) or set the quantity. Lines match a catalogue item by item id, else by English or Hindi name (trimmed, any case). Retail sales reduce stock like wholesale and are costed the same way (owner decision #33, 2026-10-25). |
| COGS | Cost of goods sold | For every sale line: quantity × AVG-COST of that item at the moment of the sale. |
| OPENING | Opening record (old-app due) | A bill-shaped record written by the move from the old app (`tools/migrate`): it has an `openingBalance` object, no lines and a total of ₹0, and is dated with the old bill's date (which can be today). It is a **balance only**: it counts in dues — Outstanding, aging (from its original date), reminders, statements, the all-time "due to receive / pay" totals (F9, F10, R6, R7, A5, A6) — and in **no** period or activity figure: not in Today (T1–T16), Reports R1–R5 and R8, Finance F1–F8, Analytics A1–A4, bill counts, stock, rate trends, item frequency, anomaly scans or Number checks AC2 / AC4. Money paid on it later is a normal DUE-PAY on the day it is paid (cash flow, drawer, T13 / T14); writing it off is not a bad debt (its sale was never a sale here). In code: `isOpeningRecord()` / `activityBills()` in `utils/money.js`, the one filter every period figure uses (review rule `period-aggregation-without-activity-filter`). |
| BILL-COUNT | "N bills", "N sales", average bill | Number of bills whose BILL-TIME is in the period that are activity: OPENING records are never counted (`billCount()` in `utils/business-metrics.js`). Today (T1/T2), Reports (R1/R2, Purchases / Sales tabs, Compare), Finance (F1 count) and Analytics use this one rule, so they agree; History lists opening records too, marked "Old app". |
| BILL-TIME | When a bill counts | The bill's stock time: numeric `timestamp`, else its `date` read by `utils/dates.js` (ISO, `DD/MM/YYYY`, `D/M/YYYY, h:mm:ss am`; all local IST). Expenses, withdrawals and payments are read by the same parser (`recordTime`). No other date parsing is used by the calculation layer (#49). |
| CMP | Comparisons | For a period: *previous* = the same days of the previous month for a calendar month, else the same length just before ("last 30 days" always uses the same length, even when it starts on the 1st); *last year* = the same dates one year earlier. The last day is counted inclusively and clipped to the shorter month (1–30 Oct vs 1–30 Sep, 1–28 Mar vs all of Feb); a month that has reached its last day compares with the whole other month. % change = (now − then) ÷ \|then\| × 100, rounded; "—" when `then` is 0 or not loaded; "about the same" under 2 % (`insights-config.js` `sameWithinPct`). |
| PARTY | One party | Bills belong to the same party when their names match with case, extra spaces and Unicode form ignored ("test party" = "Test Party"). The name shown is the spelling used most; on a tie the one with more capitalised words. Outstanding, aging, reminders, Reports' customer filters and Analytics' customers group this way. |
| MONEY-TEXT | How ₹ is written | Indian grouping everywhere: whole rupees (₹2,50,000); rates per kg in paise (₹1,234.50). Amounts below ₹100 that are averages show paise (₹0.40, not ₹0). One formatter: `formatRupees()` in `utils/money.js` (`Helpers.formatCurrency`). |
| DATE-TEXT | How dates are written | "25 Oct 2026" for a date; "25 Oct, 8:59 pm" for a date and time (the year is added when it is not this year); Hindi month names and पूर्वाह्न / अपराह्न in Hindi. One formatter: `formatDay()` / `formatDayTime()` in `utils/dates.js`. |

Labour on purchases is taken off the supplier's bill, so the stock is valued at
the line rate (before labour) while the purchase costs the shop the bill total
after labour. (Owner decision 2026-10-26: labour is **not** part of the cost of goods sold; Money shows it
as its own line, M7. `insights-config.js` `labourInCost` keeps the choice in one place.)

---

## Today (`templates/day.html`, `modules/day.js`)

All for DAY = today.

| ID | On screen | Definition |
|---|---|---|
| T1 | Purchases | Σ BILL-TOTAL of today's purchases; count of bills. |
| T2 | Sales | Σ BILL-TOTAL of today's wholesale + retail sales; count of bills. |
| T3 | Labour › Deducted from farmers | Same number as T-LAB-1 below. |
| T4 | Business expenses | Σ today's expenses of kind business (EXP-KIND), untagged ones included. |
| T5 | Personal expenses | Σ today's expenses tagged personal. |
| T6 | Cash received | BILL-AT-SAVE cash of today's sales + cash part of DUE-PAYs received today. |
| T7 | Online received | Same, online. |
| T8 | Cash paid | BILL-AT-SAVE cash of today's purchases + all of today's expenses + cash part of DUE-PAYs paid today. (❓ open: #117 adds a cash/online mode for expenses; until then all expenses count as cash.) |
| T9 | Online paid | BILL-AT-SAVE online of today's purchases + online part of DUE-PAYs paid today. |
| T10 | Total in | T6 + T7. |
| T11 | Total out | T8 + T9. |
| T12 | Net inflow / outflow | T10 − T11, shown as an amount with "Net inflow" or "Net outflow". |
| T13 | Due received | DUE-PAYs received today (cash + online). |
| T14 | Due paid | DUE-PAYs paid today (cash + online). |
| T15 | Due to receive | Σ BILL-DUE of today's sales (new dues made today; OPENING records are not today's sales even when dated today). The all-time total is on Outstanding / Finance (F9). |
| T16 | Due to pay | Σ BILL-DUE of today's purchases (OPENING records left out, as T15). |

### Labour: deducted and to pay (`utils/labour.js`)

Two different questions, both shown on the Today Labour card (tap for each
bill), in the day report (WhatsApp / image) and, for a period, on Money ›
Spending (M7, M18): Today is their home for today, Money › Spending for periods. One implementation: `labourSummary()` in
`utils/labour.js`; oracle: `tests/oracle/labour.test.js`. Purchases only,
OPENING records left out (`activityBills()`).

| ID | On screen | Definition |
|---|---|---|
| T-LAB-1 | Deducted from farmers: ₹X (N bills) | X = Σ labour on the day's purchase bills (`laborCharges`, older bills `labour`; 0 when Labour was unticked). On a bill it is heavy packets × labour rate unless typed by hand. N = bills with labour > 0. |
| T-LAB-2 | To pay labour: ₹Y (W kg ÷ K kg = P packages × ₹R) | W = Σ kg of every line on the day's purchase bills (`qty`, older lines `quantity`), with or without Labour ticked. K = Settings › Aadhat "Package weight for labour (kg)" (`settings/app.labourPackageKg`, default 35, allowed 1–200; anything else is 35). P = ⌈W ÷ K⌉ — **rounded up**: a part package is paid as a full one (1,000 kg ÷ 35 = 28.57 → 29); 0 kg → 0. R = the shared labour rate (`laborRate`, ₹ per heavy packet, default ₹6) — it is a per-packet rate, so it is used per package as is. Y = P × R. |
| T-LAB-3 | ₹Z more / less than deducted | Z = \|Y − X\|: "more" when Y > X, "less" when Y < X, "matches" when they are within 50 paise. Not an error: they differ when Labour was unticked on a bill, packets were at or below the heavy weight, or the kg does not fill whole packages. |

On Money › Spending (M7, M18), for
a period longer than a day, T-LAB-1 is the sum over
the period; T-LAB-2 is the sum of each day's T-LAB-2 (labour is paid per day,
so each day is rounded up on its own).

## Finance (`templates/finance.html`, `modules/finance.js`, `utils/finance-calc.js`) — #215

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
| F8 | Check line | Opening stock value + purchases (at line rate) − F2 + adjustments = closing stock value, for the period. A gap means goods were sold before their purchase was recorded; show "numbers don't match" with the gap per item. |
| F9 | Due to receive (Assets) | Σ BILL-DUE of all loaded wholesale + retail sales, OPENING records included. |
| F10 | Due to pay (Assets) | Σ BILL-DUE of all loaded purchases, OPENING records included. |
| F11 | Withdrawals | Σ withdrawals in the period. |
| F12 | Net worth | ❓ open: #39 (what to include; today's formula counts dues twice). Not tested yet. |

## Reports → Overview (`templates/reports.html`, `modules/reports.js`)

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

## Analytics (`templates/analytics.html`, `modules/analytics.js`)

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

## Stock (`templates/stock.html`, `modules/stock.js`)

| ID | On screen | Definition |
|---|---|---|
| S1 | Quantity | Replay of all purchases (+), sales (−) and adjustments in time order (AVG-COST rules). Opening stock is a "set" adjustment with reason "Opening stock" and a cost per kg (required), so cost of goods sold works from the first sale. With no stock at all the page says so and offers "Set opening stock". |
| S2 | Average rate | AVG-COST after the replay (0 when quantity ≤ 0). |
| S3 | Value per item | S1 × S2 when quantity > 0. |
| S4 | Total value | Σ S3 = F6. |

## Cash drawer (`templates/cash-management.html`, `modules/cash-management.js`)

For one cash session's DAY. Only cash counts.

| ID | On screen | Definition |
|---|---|---|
| C1 | Cash sales | BILL-AT-SAVE cash of that day's wholesale + retail sales. |
| C2 | Cash purchases | BILL-AT-SAVE cash of that day's purchases. |
| C3 | Expenses | That day's expenses, business and personal (untagged = business). |
| C4 | Due received | Cash part of DUE-PAYs received that day (bill entries and session legs, each id once). |
| C5 | Due paid | Cash part of DUE-PAYs paid that day. |
| C6 | Deposits | Σ cash added to the drawer that day (❓ open: #103, what a deposit means). |
| C7 | Expected cash | Opening + C1 + C4 + C6 − C2 − C5 − C3. |
| C8 | Difference | Counted cash − C7 (shown as short / extra). |
| C9 | Counted cash | Closing balance of the last signed-out, counted session (not "not counted"); the drawer term of M15. |

## Reports › Trends and Product traffic (`templates/rate-trends.html`, `modules/rate-trends.js`) — #65

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
| RENT-5 | Per tenant | Σ due of that lease's charges, oldest month first; a month is *Late* after its due day (default the 10th, per lease), *Part paid* when 0 < paid < amount. |
| RENT-6 | Rent increase due | One year after the start DATE (lease `startDate`; older leases: the start month), or — once the rent has been changed — 12 months after the month the new rent applied from (`rentSince`): "Rent increase due: p% → ₹X", X = round(rent × (1 + p/100)), p per lease (default 5). Only a reminder; the rent changes when someone saves the new rent, from the next month's charge. |
| RENT-7 | Electricity | Per lease mode: **Meter, billed by us** (older leases) — per unit sub-meter, units = current − previous reading, amount = units × rate per unit (both rounded to paise), added to that month's charge; saving again replaces it. **Included in rent** and **Own meter (tenant pays the board directly)** — no electricity amount, no readings (the rules refuse a reading). |
| RENT-8 | Tenant link page (`/r/<token>`), per month | rent = the month's rent; electricity = RENT-7 amount (units); total = rent + electricity; paid = Σ payments; due = total − paid; status Paid / Part paid / Due / Late as RENT-5, worked out on the page when it opens (month, that month's due day, due); paid on = the payment dates. Cards: rent = the lease's current rent; total due = Σ due of the shown months (up to 36, newest first); paid = Σ paid of the shown months. Moved out → banner with the last month. |
| RENT-11 | First month's rent (move-in, Add unit with its tenant) | The first charged month is the month of the start DATE. Default: the **full** monthly rent (usual practice), even when the start date is after the due day. With "Pro-rate first month" ticked: rent × (days from the start date to the end of that month, both included) ÷ days in that month, rounded to the rupee (stored on the lease as `firstRent`, never above the rent). Later months: the full rent. Late for the first month follows its due day as RENT-5. |
| RENT-10 | Unit row (Rent → Unit wise, and each unit in a property) | For one unit and this month, over the loaded charges whose unit is this unit (also a tenant who moved out this month): rent this month = Σ amount of this month's charges; collected = Σ paid of them; pending = rent − collected (not below 0); due = Σ due (RENT-4) of its charges up to this month; Late when the tenant living there now has an open month past its due day; status Vacant (no active lease) / Late / Paid (nothing due) / Part paid (this month part paid) / Due. Type: flat, commercial, office, godown, other (no type yet = flat). |
| RENT-9 | Property summary and page totals (Property wise cards, a property's header, Unit wise totals of the shown rows) | Σ of the RENT-10 rows they cover: units, units by type, occupied / vacant, late (units marked Late), rent this month, collected, pending (= rent − collected), due. The page totals are Σ over all units, so they equal Σ of the property cards and, when every charge's unit still exists, RENT-1 / RENT-2 / RENT-4. |

---

## Calculation layer: Money (M*) and Insights (I*) (`utils/business-metrics.js`) — redesign

One pure module computes every figure of the Money, Insights and Statements
pages (docs/insights-redesign.md §7); pages only render. Owner choices are
constants in `utils/insights-config.js` (overridable in `settings/app.insights`).
Oracle: `tests/oracle/business-metrics.test.js`; accounting checks:
`tests/property/business-metrics.test.js`; real data: `npm run audit:numbers`
(page "Money (layer)", "Insights (layer)"). Each figure has one home
(`utils/metric-registry.js`).

**Money page** (`templates/money.html`, `modules/money.js`) is the home of M1–M17. Each
headline shows CMP against the previous period (from the loaded bills) and the same dates last
year (from the bills when loaded, else from the month snapshots `monthStats/{YYYY-MM}`: one doc
per month with M*, per-item and top-party totals and per-day sales and profit, built once by the
owner and rolled for the current and previous month every 6 hours, `utils/month-snapshots.js`).

**Insights page** (`templates/insights.html`, `modules/insights.js`) is the home of I1–I9: a to-do
list (overdue parties, sold below cost, low-profit items, stock up before the season, dead stock),
items, parties and seasons. Seasons hosts the Rate trends and Product traffic views (RT*, PT*): the
same module and DOM as on the Rates page, moved with `RateTrendsManager.mount()`, on the shared
period and item (`utils/insights-context.js`).

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
| M11 | Profit by month / day | M6 per calendar month (13 months, last year faint) and per day of a month; the days add up to M6. |
| M12 | Money in | BILL-AT-SAVE of the period's sales + DUE-PAYs received; split cash / online. |
| M13 | Money out | BILL-AT-SAVE of the period's purchases + DUE-PAYs paid + all expenses (cash until #117); split cash / online. |
| M14 | Net money in / out | M12 − M13. Same as F7. |
| M15 | Net worth | S4 + O4 + other accounts (owner-entered) + last counted drawer cash − O3 (owner decision #39, 2026-10-26; `netWorthTerms`). Each due counted once. |
| M16 | Purchases | Σ BILL-TOTAL (after labour) of purchases with BILL-TIME in the period; BILL-COUNT; line value before labour and M7 as its two parts. |
| M17 | Stock movement check | Opening stock value + purchases at line rate − M2 ± adjustments = closing (as F8). |
| M18 | Labour to pay | T-LAB-2 for each day of the period (purchase bills by BILL-TIME, local day), each day rounded up on its own, summed (`labourToPayByDay()`). Money › Spending shows it under M7 with T-LAB-3's more / less / matches. |
| I1 | Item sales and profit | Per catalogue item: Σ sale line totals, Σ their COGS, profit = sales − COGS, profit per ₹100 (AC10). |
| I2 | Retail / wholesale | I1 split by bill type. |
| I3 | Sales by customer | Per PARTY: Σ BILL-TOTAL, BILL-COUNT, last bill (AC11). "Stopped coming": bought in each of the same 3 calendar months last year, no bill for 60 days (`stoppedComingDays`). |
| I4 | Purchases by supplier | Per PARTY: Σ BILL-TOTAL after labour, labour, kg, last bill. Item rows share each bill's labour by line value, so they add up to M16 (#47). |
| I5 | Season index | Per item and calendar month: kg sold that month ÷ the item's average monthly kg (RT4 `rateStats` months); needs 12 months. ≥ 1.5 busy, ≤ 0.5 quiet. |
| I6 | Biggest change | The item (or category) with the largest absolute change between two periods; used in takeaway sentences only. |
| I7 | Low-profit items | Items with sales ≥ ₹5,000 in the period and profit per ₹100 under 3 (`lowMarginMinSales`, `lowMarginPer100`), or a loss. |
| I8 | Sold below cost | Sale lines (bill × item) whose value is below their cost of goods sold, per item: times, kg, ₹ lost. |
| I9 | Stock up before the season | Items whose busy month (I5) is within the next 8 weeks while the stock covers fewer weeks than it takes to get there + 4. |
| I10 | Overdue parties | Parties with an open BILL-DUE older than 30 days (`overdueDays`): count, total, oldest; customers and suppliers separately. |
| I11 | Purchases by item | Per catalogue item: line value, labour share (labour × line value ÷ the bill's line value), amount after labour, kg. Rows add up to M16 (#47). |
## Checking real data

`npm run audit:numbers -- <backup.json>` (`tools/audit/`, local only, never in CI) runs the oracle and
the app's own calculations side by side on a backup file for each of the last 60 days, the last 24
months and all time, plus the accounting checks below, cross-page agreement and the Diagnostics number
checks; `--bundle` adds a migration bundle's opening records. Shapes it finds become anonymised fixtures
(`tests/fixtures/calculations/real-shapes.json`, `tests/oracle/real-shapes.test.js`), skipped with their
issue while the app differs.

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
| AC5 | Outstanding total = Σ BILL-DUE of open bills, OPENING records included (Outstanding, Finance, Reports agree); OPENING records age from their original bill date. |
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
