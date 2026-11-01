# happa: owner guide

A short guide for the owner: what each page shows, how its numbers are worked
out, and what to do when something goes wrong. Plain words only; the exact
definitions are in [calculations.md](calculations.md) (the codes in brackets,
like T1 or C7, are its spec IDs). Hindi version: [owner-guide.hi.md](owner-guide.hi.md).

Any change to what a page shows or does updates this guide (and the Hindi one)
in the same pull request, as the checklist in AGENTS.md asks.

---

## 1. Words used everywhere

- **Bill total** (BILL-TOTAL): what a bill is worth. A purchase is worth its
  total **after labour** is taken off; a sale is worth its sale total.
- **Lines total**: what the lines of a bill come to before
  labour. It is the "Total" on the printed slip and in the WhatsApp text; the
  payable comes after it.
- **Paid at save** (BILL-AT-SAVE): the cash and online typed when the bill was
  saved. Money paid later is a **due payment** (DUE-PAY) and counts on the day it
  is paid, not on the bill's day.
- **Due** (BILL-DUE): what is still owed on a bill. Never below 0; 0 when the
  bill is cleared, written off or voided.
- **Voided bill** (VOID): a bill cancelled with a reason. It stays in History,
  marked Voided, and counts nowhere: not in stock, dues, cash or any report.
- **Old-app due** (OPENING): a due carried over from the old app. It counts in
  dues only, never in a day's or month's sales or purchases.
- **Business or personal expense** (EXP-KIND): an expense is personal only when
  it is tagged personal. Untagged ones are business.
- **Cash or online expense** (EXP-MODE): picked when the expense is entered. Only
  cash expenses leave the drawer. Old expenses with no mode count as cash.
- **Average cost** (AVG-COST): the cost per kg of an item, averaged over what was
  bought (weighted by kg). A sale takes stock out at the average cost of that
  moment; this is the **cost of goods sold** (COGS).
- **Rounding** (MONEY-ROUND): rates keep paise; every money amount the app saves
  is a whole rupee (₹12.50 becomes ₹13). Cash counted in the drawer keeps paise.
- **A day** (DAY) is the Indian calendar day, midnight to midnight. A **month**
  starts on the 1st, a **year** on 1 January.

---

## 2. Page by page

### Today

Today's figures, from today's bills, expenses and cash sessions.

| On screen | How it is worked out |
|---|---|
| Purchases, Sales (T1, T2) | Sum of today's bill totals, with the number of bills. |
| Business / personal expenses (T4, T5) | Today's expenses of each kind, cash and online. |
| Cash / online received (T6, T7) | Paid at save on today's sales + due payments received today. |
| Cash / online paid (T8, T9) | Paid at save on today's purchases + today's expenses + due payments paid today. |
| Total in, total out, net (T10–T12) | In = cash + online received; out = cash + online paid; net = in − out. |
| Due received / paid (T13, T14) | Due payments received / paid today. |
| Due to receive / pay (T15, T16) | What today's own sales / purchases still owe. The all-time totals are on Outstanding. |
| Items (T17) | Today's bill lines by item: kg, value, average rate (value ÷ kg). |
| By bill type, Today's bills (T18, T19) | Each type's total split into cash, online, paid later today, written off and still due; these add up to the total. |
| Labour: deducted from farmers (T-LAB-1) | Sum of the labour on today's purchase bills. |
| Labour: to pay (T-LAB-2) | Today's purchase kg ÷ the package weight (Settings › Aadhat, default 35 kg), **rounded up**, × the labour rate. |
| More / less than deducted (T-LAB-3) | The gap between the two. Not an error: it happens when labour was unticked on a bill or packets were light. |

### Billing (purchase, retail sale) and Wholesale

While a bill is being typed:

- **Line amount** (BF-LINE) = kg × rate, rounded to the rupee.
- **Bill total** (BF-TOTAL) = the sum of the lines.
- **Labour** (BF-LAB) = labour rate × heavy packets (above 30 kg by default),
  unless typed by hand. **Payable** (BF-PAYABLE) = bill total − labour.
- **Cash / Online / Due** (BF-SPLIT): must add up to the payable (purchase) or
  total (sale) within ₹1, or the bill is not saved. A tick fills the whole
  amount; "Rest → Due" puts what is left in Due.
- **Wholesale profit** (WS-PROFIT) = total − cost (kg × the item's current
  average cost) − expenses. Shown as "—" when an item's cost is not known (never
  bought, no opening stock).
- "Save draft" keeps an unfinished bill; an unsaved bill is offered back at the
  next start.
- **Voice** (VB-1; off until switched on in Settings › Voice billing): tap 🎤 and
  say the item, weight and rate. The app shows what it heard and fills the line
  only after OK; voice never adds to the bill or saves. See
  [voice-billing.md](voice-billing.md).

### History

Every saved bill, newest first, with its total, paid and due. Bill details show
the lines, labour and payable, how it was paid, later payments, write-offs and
every edit (who, when, why). A bill can be **voided** (with a reason) within the
role's edit window; only the owner deletes, and only a voided bill. A void needs no
owner approval, but one by anyone except an owner shows on the owner's Today (Day report,
medium) with who voided it and the reason, and stays in the audit log.

### Outstanding (and Wholesale › Outstanding)

| On screen | How it is worked out |
|---|---|
| Purchase dues per party (O1) | Sum of the due on that supplier's purchases. |
| Sale dues per party (O2) | Sum of the due on that customer's sales. Sales shows **All** (retail and wholesale), **Retail** or **Wholesale**; in All each bill has a Retail / Wholesale tag. Wholesale › Outstanding still lists the wholesale dues too. |
| Payables / receivables totals (O3, O4) | Sum over all parties. The All total is the same as "To receive" on Money › Worth. |

Recording a payment (DUE-CHECK): cash and online in whole rupees, never more than
the due. Names match with case and extra spaces ignored (PARTY).

### Stocks

| On screen | How it is worked out |
|---|---|
| Quantity (S1) | All purchases added, sales taken out, corrections applied, in time order. Opening stock is a correction with its cost per kg. |
| Average rate (S2) | The average cost after all of that. |
| Value per item, total value (S3, S4) | Quantity × average rate; the total is their sum. |
| Adjustment value (S5) | Quantity of a correction × its rate (or today's average rate). |
| Dead stock value (S6) | Value of items with stock and no sale in the chosen days. |

### Cash (the drawer)

Only cash counts here, for one day's cash session.

| On screen | How it is worked out |
|---|---|
| Cash sales, purchases (C1, C2) | Cash paid at save on that day's sales / purchases. |
| Expenses (C3) | That day's **cash** expenses, business and personal. |
| Due received / paid (C4, C5) | Cash part of that day's due payments. |
| Deposits (C6) | Cash added to the drawer. |
| Expected cash (C7) | Opening + cash sales + due received + deposits − cash purchases − due paid − expenses. |
| Difference (C8) | Counted cash − expected: short or extra. Within ₹1 it matches. |
| Counted cash (C9) | The last counted closing; it is the drawer part of Net worth. |

One session per day: the second phone joins it. Opening needs internet. A closed
day can't be reopened; a day closed without a count shows "Not counted" and can
be counted later.

### Expenses

Business and personal expenses, each with a date (today by default, never in the
future) and cash or online. Only the owner and roles allowed in Roles & access see
the personal **entries**; everyone who opens Today still sees the day's personal
total and count (T5), and the cash drawer counts them (C3).

### Money (Profit, Cash, Spending, Worth)

For the chosen period, compared with the previous period and the same dates last
year (CMP; "not known" when that period's figures are not available).

| On screen | How it is worked out |
|---|---|
| Sales (M1) | Sum of sale bill totals. |
| Cost of goods sold (M2) | Cost of what was sold, at average cost. |
| Gross profit (M3) | Sales − cost of goods sold. |
| Business expenses (M4), bad debts (M5) | Expenses of the period; dues written off in it. |
| **Profit (M6)** | Gross profit − business expenses − bad debts. Labour is **not** taken off (it is already off the purchase bills). |
| Labour (M7, M18) | Labour deducted on purchases; labour to pay, worked out day by day. |
| Personal expenses, withdrawals (M8, M9) | Shown apart from profit. |
| Kept in business (M10) | Profit − personal expenses − withdrawals. |
| Money in / out / net (M12–M14) | Paid at save + due payments, and expenses; cash and online. |
| Net worth (M15) | Stock value + to receive + other accounts + counted drawer cash − to pay. Other accounts (bank, savings, loans) are the same on all your phones, in whole rupees; you and managers with Money add or remove them. Members don't see bank balances: their net worth leaves them out and says so. |
| Purchases (M16) | Sum of purchase bill totals (after labour). |
| Stock movement check (M17) | Opening stock value + purchases − cost of goods sold ± corrections = closing value. |

### Insights (To do, Items, Parties, Seasons)

| On screen | How it is worked out |
|---|---|
| Item sales and profit (I1, I2) | Per item: sales, cost, profit, profit per ₹100; split retail / wholesale. |
| Sales by customer, purchases by supplier (I3, I4) | Per party: totals, bills, last bill. "Stopped coming": bought in each of the same 3 months last year, and no bill for 60 days. |
| Season index (I5) | Kg sold in a month ÷ the item's average monthly kg; 1.5 or more is busy. |
| Low-profit items (I7) | Sales of ₹5,000 or more with under ₹3 profit per ₹100, or a loss. |
| Sold below cost (I8) | Sales whose value was below their cost. |
| Stock up before the season (I9) | Busy month within 8 weeks and stock that won't last until then + 4 weeks. |
| Overdue parties (I10) | Dues older than 30 days. |
| Top-5 share (I12) | The five biggest parties' share of the period's total. |
| Trends, Product traffic (RT, PT) | Rates and kg per week or month from bills and the Rates page. |

### Statements

Documents on request, each closing on a page's figure: day book (ST1), month
statement (ST2), party ledger (ST3), item ledger (ST4) and CSV (ST5). Share by
WhatsApp, print or PDF.

### Rates

The item list with purchase, sale and wholesale rates. Every change is kept in the
rate history (also Excel imports).

### Rentals

Separate from the shop: rent money never counts in shop figures.

| On screen | How it is worked out |
|---|---|
| Rent this month, collected, still due (RENT-1 to RENT-3) | This month's charges, what was paid on them, and the difference. |
| Total due (RENT-4) | What every month up to now still owes, moved-out tenants included. |
| Per tenant (RENT-5) | A month is Late after its due day (default the 10th), Part paid when partly paid. |
| Rent increase due (RENT-6) | One year after the start (or the last change): rent × (1 + increase %). Only a reminder. |
| Electricity (RENT-7) | Meter billed by us: (current − previous reading) × rate per unit, whole rupees. |
| First month (RENT-11) | The full rent by default; with "Pro-rate first month" ticked, only the days from the start date. |
| Change of unit (RENT-13) | "Pro-rate move month" is ticked by default: the old unit is charged up to the day before the move and the new unit from the move day. A move on the 1st: the new unit pays the whole month. |
| Receipts (RENT-12) | Numbered R-year-number, one per payment; a cancelled one keeps its number. |
| Deposit held (RENT-14) | Tenants › 💰 Deposit: what the tenant gave as deposit, minus what was adjusted against unpaid rent and what was refunded. Adjusting pays that month (no receipt). Anyone with a rentals role records; only you edit or remove an entry. Not Aadhat cash. |
| Advance (RENT-16) | Paying more than a month's due first pays the unpaid months, oldest first (the app shows the split before saving). What is left after the latest month is an advance that pays next month's rent as soon as that month starts (no receipt for it; the payment's receipt shows the advance). On a change of unit it pays the new unit's first month; if the tenant moves out with an advance left, it is added to their deposit. |
| Expenses and net (RENT-17, RENT-18) | Properties › 💸 Expenses: repairs, property tax, maintenance, insurance, broker or other paid for a property (or one unit). The Rent page shows this month's expenses and the net (collected − expenses) in all and per property. Anyone with a rentals role adds one; only you change or remove one. Not Aadhat cash. |
| Deposits held (RENT-15) | Tenants › Deposits held: every deposit still held and their total. |

### Settings, Admin, App health

- **Settings › Common**: language, account (Change password), notifications,
  Bluetooth Printer (Test Print), install the app; the owner's **Roles & access** (what each role may see, edit
  window in days). **Printed bill**: the bottom line, the bill's QR code, the bill language, print darkness
  and logo are the same on every phone; the owner, or a manager allowed in Roles & access, changes them.
  The printer and paper width stay on each phone.
- **Settings › Aadhat**: business name and UPI ID, labour rate and package
  weight, bill checks, bill numbers, opening stock.
- **Admin › Users**: approve, change role, Reset Password (emails the person a
  link), Delete (removes access; Restore brings them back as a pending
  registration).
- **Anomalies**: bills that look wrong (a possible duplicate bill, a rate far off,
  a big cash gap…); tap "Mark OK" or "Mark fixed" on each.
- **Diagnostics › Number checks**: the always-true checks run on this phone's data
  (bill split, payments, dates, dues, drawer, stock).

---

## 3. Runbook: what to do when

### Every day

1. Open cash in the morning (Cash › Open cash). It needs internet.
2. Before closing, look at **Today**: the "All anomalies · N pending" line and
   the labour card.
3. Count the drawer and close the day (Cash › Close cash & end day). If it is
   more than ₹1 off, check the day's cash bills and expenses before saving.
4. The header pill should say **Synced** on every phone.

### Every week

- **Outstanding**: call parties who owe for more than 30 days (Insights › To do).
- **Anomalies**: clear the pending ones.
- **Diagnostics › Number checks**: all should pass.
- Days left "Not counted" on Cash: count them if the cash is still known.

### The printer is not printing

1. Settings › Common › **Bluetooth Printer**: is the printer turned on, paired in
   Android Bluetooth settings, "Enable Bluetooth Printer" ticked and the printer
   picked and connected? Tap **Test Print** (it shows once the printer is
   connected).
2. "May have printed": the printer did not confirm. **Check the paper before
   printing again**, so the bill is not printed twice.
3. Still nothing: turn the printer off and on, then connect it again from
   Settings › Common › Bluetooth Printer.
4. Android stops apps in the background to save battery. Open Android Settings ›
   Apps › happa › Battery and choose **Unrestricted** (or "Don't optimise"), so the
   printer link is not cut.
5. The bill is saved even when printing fails: reprint later from History.

### Changes are not syncing

- The header pill shows **Offline** or "N changes waiting to sync". Saved bills are
  kept on the phone and sent when the internet is back. Do not enter them again.
- "Saving… not confirmed on this phone yet": look in History before typing the
  bill again.
- "Save failed — storage full": free space on the phone; until then nothing new
  is saved.
- "Daily free data limit reached": the free plan's reads or writes for the day are
  used up. Bills saved now stay on the phone and sync after the limit resets (about
  12:30–13:30 IST). Tell the developer if it happens often.
- If one phone stays stuck for hours, close and reopen the app with internet on;
  the waiting changes are sent first. Don't clear the app's data while changes are
  waiting: they would be lost.

### The cash does not match

1. Cash › the day's details: compare cash sales, cash purchases, cash expenses and
   due payments with the bills.
2. Common causes: a bill saved as cash that was paid online (edit the bill with a
   reason), an expense saved as cash that was online, a due payment recorded on the
   wrong day, a "No bill — old udhaar" entry missing.
3. Close with the real count anyway: the difference is saved and shown as short or
   extra.

### A bill was entered twice

1. **Anomalies** flags a "possible duplicate bill" only when the same party, lines
   and total are saved again within 2 minutes (the window is in Settings › Aadhat ›
   bill checks).
2. Otherwise look in History: filter by the party and compare the totals and
   times.
3. Open the extra bill and **Void** it with a reason ("entered twice"). A bill
   that already has later payments can't be voided: ask the developer.

### A phone was lost, or someone left

1. Someone else: **Admin › Users › Delete** them. They can't sign in or register
   again (Restore brings them back as a pending registration). Their saved bills
   stay.
2. Your own phone: change your password at once on another phone (Settings ›
   Common › Account › **Change password**, then open the emailed link).
3. Anyone else who was signed in on that phone: Admin › Users › **Reset Password**
   emails them a link; the password changes only when they use it.

### Backups and restore

- Backups run by themselves once a day in the early afternoon (about 13:45 IST,
  sometimes hours later) and a full one every Sunday; they are kept for 60 days and
  checked automatically, and a monthly test restores one into a test database. Two failed days in a row open an alert for the developer
  ([tools/backup/README.md](../tools/backup/README.md)).
- A restore into the live app is done by the developer from the latest good
  backup. Tell them the date and time the data was last right. Whatever was entered
  after that backup is lost and has to be entered again.
- Admin › Data "Clear All Data" works only on the website. It first saves a backup
  file and deletes nothing unless that file was saved.
