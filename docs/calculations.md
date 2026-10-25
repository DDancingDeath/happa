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
| PERIOD | This week / month / year | Calendar period up to now: week from Monday, month from the 1st, year from 1 January (❓ open: #43, recommendation used). "Last 7 / 30 days" would be labelled so. |
| AVG-COST | Average cost of an item | Weighted average: each purchase adds its quantity at the line rate; each sale removes quantity at the average cost of that moment; adjustments add (at their rate), remove (at average cost, never below zero) or set the quantity. Lines match a catalogue item by item id, else by English or Hindi name (trimmed, any case). Retail sales reduce stock like wholesale (❓ open: #33, current rule kept). |
| COGS | Cost of goods sold | For every sale line: quantity × AVG-COST of that item at the moment of the sale. |

Labour on purchases is taken off the supplier's bill, so the stock is valued at
the line rate (before labour) while the purchase costs the shop the bill total
after labour. (❓ open: whether labour should lower the stock cost; today it
does not.)

---

## Today (`templates/day.html`, `modules/day.js`)

All for DAY = today.

| ID | On screen | Definition |
|---|---|---|
| T1 | Purchases | Σ BILL-TOTAL of today's purchases; count of bills. |
| T2 | Sales | Σ BILL-TOTAL of today's wholesale + retail sales; count of bills. |
| T3 | Labour | Σ labour on today's purchases. |
| T4 | Business expenses | Σ today's expenses of kind business (EXP-KIND). ❌ app differs: untagged expenses are left out (#219). |
| T5 | Personal expenses | Σ today's expenses tagged personal. |
| T6 | Cash received | BILL-AT-SAVE cash of today's sales + cash part of DUE-PAYs received today. |
| T7 | Online received | Same, online. |
| T8 | Cash paid | BILL-AT-SAVE cash of today's purchases + all of today's expenses + cash part of DUE-PAYs paid today. ❌ app differs: untagged expenses are left out (#219). (❓ open: #117 adds a cash/online mode for expenses; until then all expenses count as cash.) |
| T9 | Online paid | BILL-AT-SAVE online of today's purchases + online part of DUE-PAYs paid today. |
| T10 | Total in | T6 + T7. |
| T11 | Total out | T8 + T9. ❌ (#219, via T8) |
| T12 | Net inflow / outflow | T10 − T11, shown as an amount with "Net inflow" or "Net outflow". ❌ (#219, via T8) |
| T13 | Due received | DUE-PAYs received today (cash + online). |
| T14 | Due paid | DUE-PAYs paid today (cash + online). |
| T15 | Due to receive | Σ BILL-DUE of today's sales. |
| T16 | Due to pay | Σ BILL-DUE of today's purchases. |

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
| F9 | Due to receive (Assets) | Σ BILL-DUE of all loaded wholesale + retail sales. |
| F10 | Due to pay (Assets) | Σ BILL-DUE of all loaded purchases. |
| F11 | Withdrawals | Σ withdrawals in the period. |
| F12 | Net worth | ❓ open: #39 (what to include; today's formula counts dues twice). Not tested yet. |

## Reports → Overview (`templates/reports.html`, `modules/reports.js`)

For the selected PERIOD. Dues are all-time, not the period.

| ID | On screen | Definition |
|---|---|---|
| R1 | Total purchases | Σ BILL-TOTAL of purchases in the period (after labour); count. |
| R2 | Total sales | Σ BILL-TOTAL of wholesale + retail sales in the period; count. |
| R3 | Profit on goods sold | Same as F4 for the same period (one profit everywhere, #36). "—" while the cost of goods sold can't be worked out yet (as on Finance). The CSV / PDF export use the same number. The Compare tab's "sales − purchases" is labelled as that, not as profit. |
| R4 | Cash | Σ BILL-PAY cash over the period's purchases **and** sales (money moved in cash, both directions). |
| R5 | Online | Same, online. |
| R6 | Due to pay | = F10. |
| R7 | Due to receive | = F9 (retail + wholesale). |
| R8 | Labour | Σ labour on the period's purchases. |

## Analytics (`templates/analytics.html`, `modules/analytics.js`)

| ID | On screen | Definition |
|---|---|---|
| A1 | This month: revenue | Σ BILL-TOTAL of sales from the 1st of this month to now. ❌ app differs: `DD/MM/YYYY` bills are misread (#49). |
| A2 | This month: purchases | Σ BILL-TOTAL of purchases, same range. ❌ (#49) |
| A3 | This month: expenses | Σ business expenses (EXP-KIND), same range; count. |
| A4 | This month: profit | Same as F4 for the same range (#36). |
| A7 | Profit trend (per day) | F4 split by day: each day's sales − cost of goods sold − business expenses − bad debts; the days add up to F4 for the whole range. |
| A5 | Total payable | = F10; count of bills with BILL-DUE > 0. |
| A6 | Total receivable | = F9; count of bills with BILL-DUE > 0. ❌ app differs: counts cleared bills, misses `dueAmount`-only bills (#220). |

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
| S1 | Quantity | Replay of all purchases (+), sales (−) and adjustments in time order (AVG-COST rules). |
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

---

## Accounting checks (always true)

These must hold for any data. They run as property tests on generated
multi-year histories (`tests/fixtures/generator.js`) and, for the loaded data,
in Diagnostics → Number checks.

| ID | Check |
|---|---|
| AC1 | Opening stock value + purchases − cost of goods sold ± adjustments = closing stock value (any period). |
| AC2 | For every bill: cash + online + due (+ written off) = BILL-TOTAL, within ₹1. |
| AC3 | For every bill: BILL-AT-SAVE + Σ `payments[]` = cash and online on the bill. |
| AC4 | Σ over months = all time (sales, purchases) on Reports and Finance. |
| AC5 | Outstanding total = Σ BILL-DUE of open bills (Outstanding, Finance, Reports agree). |
| AC6 | Drawer expected cash = opening + cash in − cash out for the day. |
| AC7 | Same period, same number: Today, Reports, Analytics, Finance and the drawer agree on sales and cash; Finance profit, cost of goods sold and cash flow match the oracle every month. ❌ partly: #219 (untagged expenses), #49 (DD/MM dates on Analytics). |
| AC8 | No item's stock goes below zero unless a sale was saved past the oversell warning. |

---

## Worked example (`tests/fixtures/calculations/shop-month.json`)

"Now" is 21 Oct 2026, 3 pm. Two items, Rice and Wheat.

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
